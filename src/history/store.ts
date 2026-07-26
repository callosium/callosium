// Universal version history — the external-write safety net (M1).
//
// A Callosium-owned git history of the vault kept in ~/.callosium/history/<brainId>.git,
// with the git-dir OUTSIDE the vault (work-tree = the vault, no visible .git inside it) so it
// never collides with any git the owner keeps on their vault. Every note change — whether it
// came through Callosium's MCP or from a direct external edit — is committed here, so every
// version is restorable with a diff. "Your AI can't lose your memory."
//
// Why git (isomorphic-git): pure-JS, so no git binary to bundle in the portable; real diffs and
// one-command restore. Note it is NOT full git: it writes loose, individually-compressed objects
// and never packs, so there is no delta compression and no gc — hence the retention pass below.
//
// Invariants:
//  - Best-effort: a history failure must NEVER block a real write or a re-index. The public
//    functions throw on hard git errors; callers wrap them in try/catch and swallow.
//  - Serialized: isomorphic-git mutates a shared index, so all WRITES to one shadow repo run
//    under a per-brain lock. Pure reads (listVersions) deliberately stay off that lock so a
//    history walk can never stall the owner's own save.
//  - Bounded: isomorphic-git writes LOOSE objects and never packs or gc's, so nothing reclaims a
//    version once it exists. Retention (KEEP_VERSIONS) trims the tail on the write path.
//  - Erasable: the store keeps copies of notes the vault no longer has — that's the whole point of
//    a safety net, and the wrong answer when the owner wants something GONE. purgeNote/purgeBrain
//    are the erase paths (see the PURGE section at the bottom).

import git from 'isomorphic-git';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomBytes } from 'node:crypto';

export interface Version {
  oid: string; // commit id
  ts: number; // author timestamp (ms since epoch)
  source: string; // agent display name, 'external', or 'baseline'
  message: string;
}

export type DiffLine = { t: ' ' | '+' | '-'; text: string };

export interface ExternalChange {
  relpath: string;
  add: number;
  del: number;
  deleted: boolean;
}

const AUTHOR_EMAIL = 'history@callosium.local';
const SKIP_DIRS = new Set(['.git', '.obsidian', '.trash', 'node_modules', '.callosium-cache']);

// Retention. isomorphic-git only ever writes loose objects — it never packs and has no gc — so
// every version is a full zlib copy of the note and NOTHING on any path ever reclaimed one: an
// always-on brain grew its shadow store for the life of the install. We keep the newest
// KEEP_VERSIONS commits and drop the tail (see pruneIfNeeded). CALLOSIUM_HISTORY_KEEP lets an owner
// trade disk for depth, mirroring CALLOSIUM_HISTORY_ROOT.
//
// Both constants below are set from measurement, because the obvious settings are wrong in opposite
// directions (measured 26 Jul 2026, Windows 11 / Node 24, 2KB notes):
//
//   cost of one version on disk .............. 918 bytes
//   cost of one retention pass ............... 4.9s at KEEP=2000, and it scales LINEARLY with KEEP
//                                              (the reachability sweep reads every object kept)
//
// So retention is cheap in disk and expensive in time — the reverse of the usual intuition. A small
// KEEP saves nothing worth having (2,000 versions is 1.8MB) while throwing away history the product
// exists to keep; and running the pass often makes it the dominant cost of writing a note (at one
// pass per 100 commits it was ~75% of write throughput). Hence: keep a lot, prune rarely.
const KEEP_VERSIONS = Math.max(50, Number(process.env.CALLOSIUM_HISTORY_KEEP) || 20_000);
// Retention is triggered at boot and, as a backstop for a session that never restarts, every
// PRUNE_EVERY_COMMITS commits. Neither trigger is allowed to sit in a note save's latency: both run
// DETACHED and the pass aborts the moment a real write queues (see scheduleRetention / trackWrite).
//
// That took two goes to get right, which is worth recording. The first attempt moved the pass off
// the write path and asserted "a note save must never wait on this" — but the pass still entered the
// same per-brain lock queue that snapshotNote uses, so a save issued during it simply queued behind.
// Measured on a 1,500-version store pruning to 1,000: a save taken 50ms after boot cost 1,930ms,
// linear in KEEP_VERSIONS. Off the write path is NOT the same as out of the way.
const PRUNE_EVERY_COMMITS = 20_000;
// Don't re-sweep for a handful of commits. The trigger used to be "over the cap at all", so a store
// one commit over paid the whole O(KEEP) sweep again on every boot; this amortises it over a tenth
// of the budget. Proportional rather than a flat number so an owner who sets CALLOSIUM_HISTORY_KEEP
// small still gets pruned promptly — a flat 2,000 would mean a KEEP of 500 never trimmed until the
// store was five times its budget.
const PRUNE_SLACK = Math.max(100, Math.floor(KEEP_VERSIONS / 10));
// Cap on what one timeline request walks/returns. A History panel past a few hundred entries is
// unusable anyway, and the cap keeps the response bounded no matter how hot the note is.
const MAX_VERSIONS_LISTED = 500;

function historyRoot(): string {
  // CALLOSIUM_HISTORY_ROOT relocates the version store (tests isolate it; owners can move it
  // off a synced drive). Defaults to ~/.callosium/history.
  return process.env.CALLOSIUM_HISTORY_ROOT || path.join(os.homedir(), '.callosium', 'history');
}

function gitdirFor(brainId: string): string {
  return path.join(historyRoot(), `${brainId}.git`);
}

// serialize every op per shadow repo (isomorphic-git shares one on-disk index)
const locks = new Map<string, Promise<unknown>>();
function withRepoLock<T>(brainId: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(brainId) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  locks.set(
    brainId,
    next.catch(() => {}),
  );
  return next;
}

// How many real WRITES are queued or running for a brain. Retention watches this: it is the only
// op here that is both slow and entirely deferrable, so it must never be the thing a note save is
// stuck behind. Moving the prune off the write path was not enough on its own — it still enters the
// same per-brain queue, so a save issued while a prune holds the lock waits for the whole pass.
// Measured: a 1,500-version store pruning to 1,000 made a save taken 50ms later cost 1,930ms, and
// the cost is linear in KEEP_VERSIONS.
const pendingWrites = new Map<string, number>();
function trackWrite<T>(brainId: string, fn: () => Promise<T>): Promise<T> {
  pendingWrites.set(brainId, (pendingWrites.get(brainId) ?? 0) + 1);
  return withWriteLock(brainId, fn).finally(() => {
    const n = (pendingWrites.get(brainId) ?? 1) - 1;
    if (n > 0) pendingWrites.set(brainId, n);
    else pendingWrites.delete(brainId);
  });
}
/** True when a real write is waiting — retention checks this and gets out of the way. */
const writersWaiting = (brainId: string): boolean => (pendingWrites.get(brainId) ?? 0) > 0;

// Cross-PROCESS lock: the dashboard and each MCP agent are separate processes that can all
// commit to the same shadow repo; isomorphic-git shares one on-disk index/refs, so concurrent
// commits from two processes could corrupt it. An O_EXCL lockfile serializes them. Best-effort:
// if we can't acquire within the window, the caller skips this snapshot — the change stays on
// disk and gets captured on the next re-index (git.status makes re-capture idempotent).
//
// A holder HEARTBEATS its lockfile (touches the mtime) for as long as it holds it, so a waiter can
// ask "is the owner still working?" instead of only "does that pid exist?" — see the steal rules.
const LOCK_HEARTBEAT_MS = 5_000;
const LOCK_STALE_MS = 60_000; // 12 missed beats: a working holder is never at risk, even mid-import
const LOCK_ABANDONED_MS = 600_000; // wall-clock fallback where no heartbeat can be read
const LOCK_FORMAT = 'hb2'; // 4th line carries a beat COUNTER — see why mtime was not enough below

// What we last saw in a lockfile we could not take, and when we saw it (our own clock).
// The staleness test needs two observations, so it cannot live inside one acquire attempt.
const lockObservations = new Map<string, { beat: string; firstSeenAt: number }>();

async function acquireProcessLock(brainId: string): Promise<(() => Promise<void>) | null> {
  const lockPath = `${gitdirFor(brainId)}.lock`;
  await fs.promises.mkdir(path.dirname(lockPath), { recursive: true }).catch(() => {});
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    try {
      const fh = await fs.promises.open(lockPath, 'wx'); // exclusive create
      // A per-acquisition nonce so release() can tell OUR lock from one that replaced it.
      const nonce = randomBytes(8).toString('hex');
      let beats = 0;
      const stamp = () => `${process.pid}\n${os.hostname()}\n${LOCK_FORMAT}\n${nonce}:${beats}`;
      await fh.write(stamp());
      await fh.close();
      // Heartbeat by REWRITING the beat counter, not by touching the mtime.
      //
      // mtime is wall-clock; setInterval is monotonic. Close a laptop lid for ten minutes and the
      // lockfile's mtime ages by ten minutes while the holder's timer does not fire at all — so on
      // resume a waiter read "idle for 600s" about a process that was mid-commit, stole the lock,
      // and two processes wrote the shared git index at once. That is the corruption this lock
      // exists to prevent, reintroduced by the staleness test itself. A counter the holder writes
      // can only advance when the holder actually runs, so suspend is invisible to it.
      const beat = setInterval(() => {
        beats++;
        void fs.promises.writeFile(lockPath, stamp()).catch(() => {});
      }, LOCK_HEARTBEAT_MS);
      beat.unref();
      lockObservations.delete(lockPath);
      return async () => {
        clearInterval(beat);
        // Only remove the lock if it is still OURS. If we were robbed (a long suspend, a clock
        // jump), the file now belongs to another holder and deleting it would let a third process
        // in while that holder is mid-write.
        const cur = await fs.promises.readFile(lockPath, 'utf8').catch(() => '');
        if (cur === '' || cur.split('\n')[3]?.startsWith(`${nonce}:`)) {
          await fs.promises.rm(lockPath, { force: true }).catch(() => {});
        }
      };
    } catch {
      // Decide whether to steal a contended lock. Leaving one alone needs BOTH: the owner still
      // exists, and it is still working. The pid answers the first; only the heartbeat answers the
      // second. Trusting the pid alone (what we did before) made a lock left by a crashed Callosium
      // immortal as soon as its pid was RECYCLED by any unrelated long-lived process — pids get
      // reused, and the same-machine branch never aged out — so version history for that brain
      // stayed silently off with no way back short of deleting the file by hand. Rules now:
      // dead pid → steal; alive but the heartbeat stopped → steal; alive and beating → leave it
      // (a legit baseline import holds the lock for >10 min on a large vault and keeps beating the
      // whole time, so it is still never stolen — stealing a live holder would let two processes
      // commit to the shared git index/refs at once and corrupt them).
      try {
        const raw = await fs.promises.readFile(lockPath, 'utf8').catch(() => '');
        const st = await fs.promises.stat(lockPath);
        const [pidStr, hostStr = '', fmt = '', beatField = ''] = raw.split('\n');
        const pid = parseInt(pidStr, 10);
        const sameMachine = hostStr.trim() === os.hostname();
        const beats = fmt.trim() === LOCK_FORMAT;

        // "Has the holder made progress since we last looked?" — measured in OUR clock, against a
        // counter only the holder can advance. Two observations, not one, and never mtime: see the
        // heartbeat comment above for why wall-clock age reads a suspended machine as a dead holder.
        let stalledMs = 0;
        if (beats) {
          const prev = lockObservations.get(lockPath);
          if (!prev || prev.beat !== beatField) {
            lockObservations.set(lockPath, { beat: beatField, firstSeenAt: Date.now() });
          } else {
            stalledMs = Date.now() - prev.firstSeenAt;
          }
        }
        const idleMs = Date.now() - st.mtimeMs; // legacy locks only — no counter to read

        let steal: boolean;
        if (sameMachine && Number.isFinite(pid) && pid > 0) {
          let alive = true;
          try {
            process.kill(pid, 0); // signal 0 = existence probe, delivers nothing
          } catch (e) {
            // ESRCH is the ONLY code that means "gone". EPERM means the process EXISTS but belongs
            // to another user (a second desktop session on the same box) — reading that as gone
            // stole the lock from a LIVE holder, which is exactly the corruption we lock against.
            alive = (e as NodeJS.ErrnoException)?.code === 'EPERM';
          }
          // No format marker → written by an older build that never beat; age it out on wall-clock
          // instead, so a legacy lock can still be recovered rather than pinning history forever.
          steal = !alive || (beats ? stalledMs > LOCK_STALE_MS : idleMs > LOCK_ABANDONED_MS);
        } else {
          // Different (or unreadable/legacy-format) machine — a OneDrive/iCloud synced git-dir. The
          // pid is meaningless against our local process table. A beating lock still tells us
          // something (the counter advances wherever it runs); a legacy one leaves only wall-clock.
          steal = beats ? stalledMs > LOCK_ABANDONED_MS : idleMs > LOCK_ABANDONED_MS;
        }
        if (steal) lockObservations.delete(lockPath);
        if (steal) await fs.promises.rm(lockPath, { force: true });
      } catch {
        /* lock vanished — retry */
      }
      await new Promise((r) => setTimeout(r, 80));
    }
  }
  return null;
}

// in-process serialize + cross-process lock, for any op that WRITES the shadow repo.
function withWriteLock<T>(brainId: string, fn: () => Promise<T>): Promise<T> {
  return withRepoLock(brainId, async () => {
    const release = await acquireProcessLock(brainId);
    if (!release) throw new Error('history: could not acquire cross-process lock (busy)');
    try {
      return await fn();
    } finally {
      await release();
    }
  });
}

// Strip a leading UTF-8 BOM. readHeadBlob decodes via TextDecoder (which drops the BOM) while the
// disk read below keeps it, so a byte-identical BOM-prefixed note would otherwise never compare
// equal to HEAD — perpetually re-flagged as an 'external' change with a phantom commit each pass.
const stripBom = (s: string): string => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

async function readHeadBlob(vaultRoot: string, gitdir: string, relpath: string): Promise<string | null> {
  try {
    const oid = await git.resolveRef({ fs, gitdir, ref: 'HEAD' });
    const { blob } = await git.readBlob({ fs, dir: vaultRoot, gitdir, oid, filepath: relpath });
    return new TextDecoder().decode(blob);
  } catch {
    return null;
  }
}

async function hasHead(gitdir: string): Promise<boolean> {
  try {
    await fs.promises.access(path.join(gitdir, 'HEAD'));
    // a bare init writes HEAD before the first commit; treat "no commit yet" as not-ready too
    return await git
      .resolveRef({ fs, gitdir, ref: 'HEAD' })
      .then(() => true)
      .catch(() => false);
  } catch {
    return false;
  }
}

// markdown note paths relative to the vault (the store tracks notes, not attachments/caches)
async function listNotePaths(vaultRoot: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, rel: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(abs, r);
      else if (e.name.endsWith('.md') && !e.isSymbolicLink()) out.push(r);
    }
  }
  await walk(vaultRoot, '');
  return out;
}

// commits this process has added to each shadow repo since it last checked retention
const commitsSincePrune = new Map<string, number>();
// Shadow repos that crossed PRUNE_EVERY_COMMITS and are waiting for a backstop pass.
const retentionDue = new Set<string>();

/** Run the backstop retention pass, if this brain is due, WITHOUT making the caller wait for it.
 *
 *  Must be called after the caller's write lock is released: pruneHistory takes the same lock, so
 *  calling it from inside would deadlock in-process, and awaiting it would just move the stall back
 *  into the note save we are trying to keep fast. Detached and unref'd, so a short-lived CLI exits
 *  immediately rather than sitting on a sweep it doesn't need — the boot pass will catch that store
 *  next time. Being cut off mid-sweep is safe by construction: sweepUnreachable points the refs at
 *  the kept set BEFORE it unlinks anything, so an interrupted pass leaves reclaimable garbage, never
 *  a ref naming a deleted object. */
function scheduleRetention(brainId: string): void {
  const gitdir = gitdirFor(brainId);
  if (!retentionDue.delete(gitdir)) return;
  setTimeout(() => {
    // If writes are queued right now, don't even take the lock — put it back and wait for a later
    // trigger. A brain being actively written to is precisely when retention must stay out of the
    // way, and there is no deadline: the store is bounded across restarts by the boot pass.
    if (writersWaiting(brainId)) {
      retentionDue.add(gitdir);
      return;
    }
    void withWriteLock(brainId, async () => {
      if (!(await hasHead(gitdir))) return 0;
      // Aborts mid-pass the moment a save queues. Partial passes are safe and simply resume next
      // trigger, so a busy brain trades a slightly larger store for never blocking a write.
      const reclaimed = await pruneIfNeeded(gitdir, () => writersWaiting(brainId));
      if (reclaimed === PRUNE_ABORTED) retentionDue.add(gitdir); // yielded — try after this write
      return reclaimed;
    }).catch(() => {});
  }, 0).unref();
}

async function commit(gitdir: string, vaultRoot: string, source: string, message: string): Promise<string> {
  const oid = await git.commit({
    fs,
    dir: vaultRoot,
    gitdir,
    message,
    author: { name: source, email: AUTHOR_EMAIL, timestamp: Math.floor(Date.now() / 1000), timezoneOffset: 0 },
  });
  // Retention is NOT run here. It used to be, inside this lock — and since the pass costs seconds
  // and scales with KEEP_VERSIONS, that put a multi-second stall directly in the latency of one
  // unlucky note save, and blocked every other writer behind it. Boot does the real work; all this
  // does is flag a session that has run long enough to need a backstop pass, which the caller fires
  // after it has released the lock.
  const n = (commitsSincePrune.get(gitdir) ?? 0) + 1;
  if (n >= PRUNE_EVERY_COMMITS) {
    commitsSincePrune.set(gitdir, 0);
    retentionDue.add(gitdir);
  } else commitsSincePrune.set(gitdir, n);
  return oid;
}

// Every tree/blob oid reachable from one tree. `seen` doubles as the visited set, which is what
// makes this affordable across thousands of commits: consecutive versions share all but one subtree.
async function collectReachable(gitdir: string, treeOid: string, seen: Set<string>): Promise<void> {
  if (seen.has(treeOid)) return;
  seen.add(treeOid);
  const { tree } = await git.readTree({ fs, gitdir, oid: treeOid });
  for (const e of tree) {
    if (e.type === 'tree') await collectReachable(gitdir, e.oid, seen);
    else seen.add(e.oid);
  }
}

// Delete every loose object not reachable from `keptCommits` — our own gc, since isomorphic-git has
// none. Caller must hold the write lock AND must already have pointed the refs/shallow marker at
// the kept set: we delete objects LAST so a crash mid-sweep can never leave a ref naming an object
// we removed. (Concurrent readers in another process are unlocked by design; the worst case is one
// timeline read that throws and is caught, not a damaged repo.)
async function sweepUnreachable(
  gitdir: string,
  keptCommits: string[],
  shouldAbort?: () => boolean,
): Promise<number> {
  const keep = new Set<string>(keptCommits);
  let i = 0;
  for (const oid of keptCommits) {
    // Bail out to a waiting writer. Safe at any point: the refs and the shallow marker already name
    // the kept set, so stopping early only leaves reclaimable garbage for the next pass — never a
    // ref pointing at something we deleted.
    //
    // Every 8 commits, not 64: the check is a Map lookup, but each iteration reads a commit and
    // walks its tree, so 64 iterations was ~300-550ms of granularity — measured as exactly that much
    // added to a save that arrived mid-pass. The check is free; the work between checks is not.
    if ((i++ & 7) === 0 && shouldAbort?.()) return PRUNE_ABORTED;
    const { commit } = await git.readCommit({ fs, gitdir, oid });
    await collectReachable(gitdir, commit.tree, keep);
  }
  // The on-disk index can name blobs no commit does — a crash between git.add and the commit leaves
  // one staged. The next commit would write a tree pointing at it, so the index is a root too.
  await git
    .walk({
      fs,
      gitdir,
      trees: [git.STAGE()],
      map: async (_filepath, entries) => {
        const oid = await entries?.[0]?.oid();
        if (oid) keep.add(oid);
        return undefined; // NOT null — walk() reads null as "prune this subtree" and would stop at the root
      },
    })
    .catch(() => {});
  let removed = 0;
  const objRoot = path.join(gitdir, 'objects');
  for (const bucket of await fs.promises.readdir(objRoot).catch(() => [] as string[])) {
    if (!/^[0-9a-f]{2}$/.test(bucket)) continue; // 2-hex buckets only — never info/ or pack/
    if (shouldAbort?.()) return PRUNE_ABORTED; // yield between buckets too — see the check above
    const dir = path.join(objRoot, bucket);
    for (const name of await fs.promises.readdir(dir).catch(() => [] as string[])) {
      if (!/^[0-9a-f]{38}$/.test(name) || keep.has(bucket + name)) continue;
      await fs.promises.rm(path.join(dir, name), { force: true }).catch(() => {});
      removed++;
    }
  }
  return removed;
}

// Retention: keep the newest KEEP_VERSIONS commits, drop the tail. Returns loose objects reclaimed.
// Caller must hold the write lock.
//
// We mark the oldest kept commit SHALLOW rather than rewriting the chain: git.log honours `shallow`
// and simply stops there instead of following a parent we deleted, and — the reason it's worth
// doing this way — every kept commit keeps its exact oid, so a version id the History panel is
// already holding is still restorable after a prune. A rewrite would silently invalidate all of them.
// Returns objects reclaimed, or PRUNE_ABORTED if it yielded to a writer part-way. The caller MUST
// distinguish those: re-arming on "nothing to do" makes every subsequent write trigger another full
// git.log walk, which is O(commits) per write — quadratic over a session, and it hung a 4,000-version
// test outright. Only an abort deserves a retry.
const PRUNE_ABORTED = -1;
async function pruneIfNeeded(gitdir: string, shouldAbort?: () => boolean): Promise<number> {
  // Hysteresis. The old test was `> KEEP_VERSIONS`, so once a store was over the cap it re-ran the
  // FULL O(KEEP) sweep on every trigger — to reclaim as little as one commit. Waiting for real slack
  // amortises that sweep over PRUNE_SLACK commits instead of paying it again and again.
  // Check BEFORE the walk as well as after. The git.log below is the one part of this pass that
  // cannot be interrupted — it is a single library call — so on a store near the cap it holds the
  // lock for a few hundred ms no matter what the abort checks do. That is the residual cost of
  // retention on a save that lands in exactly that window (measured ~400ms at 1,600 commits, and it
  // grows with KEEP_VERSIONS). Not zero, and not worth pretending otherwise; it happens at most once
  // per boot and every later save in the same pass sees ~10-25ms because the sweep DOES yield.
  if (shouldAbort?.()) return PRUNE_ABORTED;
  // An aborted sweep MUST still be resumable, and the shallow marker hides it from the check below:
  // once shallow is published, git.log stops at the new boundary and reports "nothing to do" — so a
  // sweep that yielded after marking but before unlinking would leave its objects stranded forever,
  // on this trigger and on every future boot. The marker file records that a sweep is outstanding so
  // we come back and finish it. (Moving the shallow write to AFTER the sweep is not the answer: it
  // is written first precisely so the now-unlocked listVersions cannot walk into deleted objects.)
  const sweepMark = path.join(gitdir, 'callosium-sweep-pending');
  const outstanding = fs.existsSync(sweepMark);
  const log = await git.log({ fs, gitdir, depth: KEEP_VERSIONS + PRUNE_SLACK + 1 }).catch(() => []);
  if (!outstanding && log.length <= KEEP_VERSIONS + PRUNE_SLACK) return 0;
  if (shouldAbort?.()) return PRUNE_ABORTED;
  const kept = log.slice(0, KEEP_VERSIONS).map((c) => c.oid);
  // Shallow FIRST, before anything is unlinked. listVersions runs unlocked now, so a timeline read
  // can be walking this chain right now; publishing the new boundary before the sweep means such a
  // walk stops at a commit that still exists instead of following a parent into the region we are
  // about to delete (which it would surface as "this note has no history").
  await fs.promises.writeFile(path.join(gitdir, 'shallow'), `${kept[kept.length - 1]}\n`);
  // Mark before sweeping, clear only on completion — so a crash or an abort between the two leaves
  // the work visible to the next pass rather than hidden behind the shallow boundary. Kept as a
  // FILE, not process state, because the abort case we care about most is "the app was closed".
  await fs.promises.writeFile(sweepMark, `${kept[kept.length - 1]}\n`).catch(() => {});
  const reclaimed = await sweepUnreachable(gitdir, kept, shouldAbort);
  if (reclaimed !== PRUNE_ABORTED) await fs.promises.rm(sweepMark, { force: true }).catch(() => {});
  return reclaimed;
}

// Public: apply retention now. The write path already does this every PRUNE_EVERY_COMMITS commits;
// this is for a caller that wants to reclaim disk on demand (Settings) or to test it.
export async function pruneHistory(brainId: string): Promise<number> {
  const gitdir = gitdirFor(brainId);
  return withWriteLock(brainId, async () => ((await hasHead(gitdir)) ? pruneIfNeeded(gitdir) : 0));
}

// create the shadow repo + baseline commit (whole vault) if absent. Caller must hold the lock.
async function initIfNeeded(vaultRoot: string, gitdir: string): Promise<void> {
  if (await hasHead(gitdir)) return;
  await fs.promises.mkdir(gitdir, { recursive: true });
  await git.init({ fs, dir: vaultRoot, gitdir, defaultBranch: 'main' });
  const notes = await listNotePaths(vaultRoot);
  for (const rel of notes) {
    try {
      // force so a note matched by a .gitignore the owner keeps in their vault (Obsidian's Git
      // plugin auto-creates one) is STILL versioned — the shadow store must protect every note.
      await git.add({ fs, dir: vaultRoot, gitdir, filepath: rel, force: true });
    } catch {
      /* unreadable note — skip it from the baseline */
    }
  }
  await commit(gitdir, vaultRoot, 'baseline', 'baseline import');
}

// Public: ensure the shadow repo exists with a baseline so the first change to any note has a
// "before" to diff against. Idempotent; safe to call on every boot.
export async function ensureHistory(vaultRoot: string, brainId: string): Promise<void> {
  const gitdir = gitdirFor(brainId);
  await withWriteLock(brainId, async () => {
    await initIfNeeded(vaultRoot, gitdir);
  });
  // Retention is NOT awaited inside that lock. It used to be, on the theory that boot is free
  // because nothing is saving yet — but ensureHistory and snapshotNote share one per-brain queue, so
  // a note saved seconds after launch simply queued behind the whole pass. Detached, and it yields
  // to any real write, so the worst a save can wait is one abort check.
  retentionDue.add(gitdir);
  scheduleRetention(brainId);
}

// Public: snapshot the CURRENT on-disk content of one note as a new version, attributed to
// `source` (an agent display name for MCP writes, 'external' for unstamped direct edits).
// Returns the new commit oid, or null if the content was identical to the last version (git
// had nothing to commit) or the note is gone and was never tracked.
export async function snapshotNote(
  vaultRoot: string,
  brainId: string,
  relpath: string,
  source: string,
  message?: string,
): Promise<string | null> {
  const gitdir = gitdirFor(brainId);
  return trackWrite(brainId, async () => {
    await initIfNeeded(vaultRoot, gitdir);
    const abs = path.join(vaultRoot, relpath);
    let onDisk = true;
    try {
      await fs.promises.access(abs);
    } catch {
      onDisk = false;
    }
    if (onDisk) {
      // force so a .gitignore in the vault can't silently exclude this note from history
      await git.add({ fs, dir: vaultRoot, gitdir, filepath: relpath, force: true });
    } else {
      // note deleted on disk — record the deletion as a version, if it was tracked
      try {
        await git.remove({ fs, dir: vaultRoot, gitdir, filepath: relpath });
      } catch {
        return null;
      }
    }
    let status: string;
    try {
      status = await git.status({ fs, dir: vaultRoot, gitdir, filepath: relpath });
    } catch {
      // Couldn't read status (e.g. a transient OneDrive/iCloud unavailability on the workdir read).
      // We ALREADY staged this note via git.add/git.remove. If we just returned null, that staged
      // change would leak into the NEXT unrelated commit — commit() snapshots the whole index — and
      // be silently mis-attributed to that commit's source/message. Unstage it and bail; a later
      // captureExternal re-detects on-disk != HEAD and versions it honestly.
      await git.resetIndex({ fs, dir: vaultRoot, gitdir, filepath: relpath }).catch(() => {});
      return null;
    }
    // 'unmodified' = identical to HEAD; 'absent' = gone from disk AND never tracked — either way
    // there is nothing new to version, so don't create a spurious empty commit / false-success oid.
    if (status === 'unmodified' || status === 'absent') return null;
    return commit(gitdir, vaultRoot, source, message ?? `${source}: ${relpath}`);
  }).finally(() => scheduleRetention(brainId)); // outside the lock — never in a save's latency
}

// Public: the version timeline for one note, newest first, capped at `limit` entries.
//
// Two deliberate departures from how this used to work, both about cost. It no longer runs under
// withRepoLock: git.log is a pure read (it never touches the shared index that lock exists for),
// and queueing it there meant opening the History panel on a long-lived brain stalled the owner's
// own note saves behind a walk of the entire repo history. And the walk is bounded now — `depth`
// caps what we build and ship, and retention caps how far back there is to walk at all.
export async function listVersions(
  vaultRoot: string,
  brainId: string,
  relpath: string,
  limit: number = MAX_VERSIONS_LISTED,
): Promise<Version[]> {
  const gitdir = gitdirFor(brainId);
  if (!(await hasHead(gitdir))) return [];
  // depth is "commits collected before stopping" and can overshoot by one with a filepath, so ask
  // for one more than we want and slice.
  const log = await git
    .log({ fs, dir: vaultRoot, gitdir, filepath: relpath, force: true, depth: limit + 1 })
    .catch(() => []);
  return log.slice(0, limit).map((c) => ({
    oid: c.oid,
    ts: (c.commit.author.timestamp || 0) * 1000,
    source: c.commit.author.name || 'unknown',
    message: (c.commit.message || '').split('\n')[0],
  }));
}

// Public: the content of one note as of a given version (commit oid), or null if absent there.
export async function readVersion(
  vaultRoot: string,
  brainId: string,
  relpath: string,
  oid: string,
): Promise<string | null> {
  const gitdir = gitdirFor(brainId);
  return withRepoLock(brainId, async () => {
    if (!(await hasHead(gitdir))) return null;
    try {
      const { blob } = await git.readBlob({ fs, dir: vaultRoot, gitdir, oid, filepath: relpath });
      return new TextDecoder().decode(blob);
    } catch {
      return null; // file did not exist at that commit
    }
  });
}

// A compact line diff (LCS) between two texts — enough for the History panel's before/after.
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.length ? before.split('\n') : [];
  const b = after.length ? after.split('\n') : [];
  const n = a.length,
    m = b.length;
  // LCS length table (O(n*m) — fine for single notes; guard pathological sizes)
  if (n * m > 4_000_000) {
    // too large to diff cheaply: fall back to "all removed then all added"
    return [...a.map((t) => ({ t: '-' as const, text: t })), ...b.map((t) => ({ t: '+' as const, text: t }))];
  }
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0,
    j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ t: ' ', text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ t: '-', text: a[i++] });
    } else {
      out.push({ t: '+', text: b[j++] });
    }
  }
  while (i < n) out.push({ t: '-', text: a[i++] });
  while (j < m) out.push({ t: '+', text: b[j++] });
  return out;
}

// Added/removed line counts between two texts (for the timeline chips).
export function diffStat(before: string, after: string): { add: number; del: number } {
  let add = 0,
    del = 0;
  for (const d of lineDiff(before, after)) {
    if (d.t === '+') add++;
    else if (d.t === '-') del++;
  }
  return { add, del };
}

// HEAD's tracked .md paths (what we've already versioned) — used to detect deletions independently
// of any vault .gitignore.
async function listHeadNotePaths(vaultRoot: string, gitdir: string): Promise<string[]> {
  try {
    const files = await git.listFiles({ fs, dir: vaultRoot, gitdir, ref: 'HEAD' });
    return files.filter((f) => f.endsWith('.md'));
  } catch {
    return [];
  }
}

// Public: capture every note that changed on disk WITHOUT going through an MCP snapshot as an
// 'external' version, and return what changed (for the Activity feed + the destructive-change
// Health finding). MCP writes snapshot themselves immediately, so a note whose bytes still differ
// from its committed HEAD blob here is a direct external edit. Idempotent.
//
// We walk the vault ourselves and compare bytes rather than using git.statusMatrix: statusMatrix
// honors a .gitignore the owner may keep in their vault (Obsidian's Git plugin auto-creates one)
// and would silently skip those notes — leaving them unprotected. listNotePaths uses SKIP_DIRS only
// (never a .gitignore), so every real note is checked, and it also prunes the .obsidian/node_modules
// traversal statusMatrix would otherwise stat-walk on every capture.
export async function captureExternal(vaultRoot: string, brainId: string): Promise<ExternalChange[]> {
  const gitdir = gitdirFor(brainId);
  return trackWrite(brainId, async () => {
    await initIfNeeded(vaultRoot, gitdir);
    const onDisk = await listNotePaths(vaultRoot);
    const onDiskSet = new Set(onDisk);
    const headPaths = await listHeadNotePaths(vaultRoot, gitdir);
    const out: ExternalChange[] = [];
    // changed or newly-added: on-disk bytes differ from the committed HEAD blob
    for (const rel of onDisk) {
      let after: string;
      try {
        after = await fs.promises.readFile(path.join(vaultRoot, rel), 'utf8');
      } catch {
        continue; // transient unreadable — leave it for the next pass
      }
      const before = stripBom((await readHeadBlob(vaultRoot, gitdir, rel)) ?? '');
      const a = stripBom(after);
      if (before === a) continue; // unchanged (BOM-insensitive), or an MCP write already committed → skip
      const { add, del } = diffStat(before, a);
      await git.add({ fs, dir: vaultRoot, gitdir, filepath: rel, force: true }).catch(() => {});
      out.push({ relpath: rel, add, del, deleted: false });
    }
    // deletions: tracked at HEAD but gone from disk. A note's absence from onDiskSet is NOT proof
    // it was deleted — listNotePaths' walk swallows a transient readdir failure (`catch { return }`)
    // with no retry, so a single directory that fails to enumerate (OneDrive/iCloud can hand back a
    // synced dir as unavailable on first touch — the same class readFileRetry defends against) would
    // otherwise make every note under it look deleted and get git.remove'd + committed as a phantom
    // deletion. Confirm the SPECIFIC file is genuinely gone (ENOENT) before recording it; any other
    // stat error, or a file that still exists, is treated as "present, skip".
    for (const rel of headPaths) {
      if (onDiskSet.has(rel)) continue;
      let reallyGone = false;
      try {
        await fs.promises.stat(path.join(vaultRoot, rel));
      } catch (e) {
        if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') reallyGone = true;
      }
      if (!reallyGone) continue; // still present, or a transient/other error — never fabricate a delete
      const before = (await readHeadBlob(vaultRoot, gitdir, rel)) ?? '';
      await git.remove({ fs, dir: vaultRoot, gitdir, filepath: rel }).catch(() => {});
      out.push({ relpath: rel, add: 0, del: before ? before.split('\n').length : 0, deleted: true });
    }
    if (out.length) await commit(gitdir, vaultRoot, 'external', `external: ${out.length} note(s) changed outside Callosium`);
    return out;
  }).finally(() => scheduleRetention(brainId)); // outside the lock — see scheduleRetention
}

// ── PURGE (privacy) ─────────────────────────────────────────────────────────────────────────────
// Deleting a note from the vault does NOT delete Callosium's copies of it, and never did: the
// shadow store keeps every version of every note forever, deliberately, because that's what makes
// an accidental delete recoverable. The flip side is that until now there was no way anywhere in
// the product to actually get rid of something — an owner who deleted a note (or the whole brain)
// still had our copies of it on their disk, indefinitely, with no UI and no command that touched
// them. These are that path. They are erase, not restore: what they remove is unrecoverable.
//
// DELIBERATELY not wired to the ordinary delete flow, and it should stay that way. Deleting a note
// is the single most common thing a version history exists to undo — "I deleted it, get it back" is
// the feature. Purging on delete would quietly convert the safety net into a shredder and make the
// most-wanted restore the one that cannot work. These belong behind an explicit, differently-worded
// owner action ("erase permanently", "forget this brain"), shown as irreversible, and nowhere else.
// The bar is the owner asking for erasure, not the owner deleting a file.
//
// Whoever wires them: purgeNote must run AFTER the note is gone from the vault, or the next
// captureExternal simply re-adds it; and purgeBrain must also clear the caller's `ensuredBrains`
// entry in src/mcp/server.ts, or the next write assumes a baseline that no longer exists.

// Rebuild `treeOid` without the entry at `segments`, returning the new tree oid — or null if that
// path isn't in this tree, which is the common case and lets the caller reuse the tree as-is.
async function treeWithout(gitdir: string, treeOid: string, segments: string[]): Promise<string | null> {
  const { tree } = await git.readTree({ fs, gitdir, oid: treeOid });
  const idx = tree.findIndex((e) => e.path === segments[0]);
  if (idx < 0) return null;
  let next = tree;
  if (segments.length === 1) {
    next = tree.filter((_, i) => i !== idx);
  } else {
    if (tree[idx].type !== 'tree') return null;
    const sub = await treeWithout(gitdir, tree[idx].oid, segments.slice(1));
    if (sub === null) return null;
    const { tree: subEntries } = await git.readTree({ fs, gitdir, oid: sub });
    // a folder that held nothing but the purged note goes with it
    next = subEntries.length ? tree.map((e, i) => (i === idx ? { ...e, oid: sub } : e)) : tree.filter((_, i) => i !== idx);
  }
  return git.writeTree({ fs, gitdir, tree: next });
}

// Public: erase one note from the version store — every version, in every commit — and reclaim the
// objects. Returns how many versions were removed (0 if we never had it). Call it AFTER the note is
// gone from the vault.
//
// This is a filter-branch: every commit is rewritten without that path, so every commit oid in the
// repo changes. That's the cost of a real erase (leaving the old commits reachable would leave the
// content on disk), and it's why this is an explicit owner action rather than something automatic.
// An open History panel just needs a reload — the notes themselves are untouched.
export async function purgeNote(vaultRoot: string, brainId: string, relpath: string): Promise<number> {
  const gitdir = gitdirFor(brainId);
  const filepath = relpath.replace(/\\/g, '/'); // git paths are always '/'-separated
  return trackWrite(brainId, async () => {
    if (!(await hasHead(gitdir))) return 0;
    const versions = await git.log({ fs, dir: vaultRoot, gitdir, filepath, force: true }).catch(() => []);
    if (!versions.length) return 0; // never versioned here — nothing to erase, nothing to rewrite
    const segments = filepath.split('/').filter(Boolean);
    const log = await git.log({ fs, gitdir }); // full chain (stops at any shallow boundary)
    const rewritten: string[] = [];
    let parent: string[] = [];
    for (const entry of log.slice().reverse()) {
      // oldest first: a parent must exist before the child that names it
      const tree = (await treeWithout(gitdir, entry.commit.tree, segments)) ?? entry.commit.tree;
      const oid = await git.writeCommit({ fs, gitdir, commit: { ...entry.commit, tree, parent } });
      rewritten.push(oid);
      parent = [oid];
    }
    const branch = (await git.currentBranch({ fs, gitdir, fullname: true })) || 'refs/heads/main';
    await git.writeRef({ fs, gitdir, ref: branch, value: rewritten[rewritten.length - 1], force: true });
    // The rewritten chain starts at a real root, so a shallow marker left by an earlier prune now
    // names an oid that doesn't exist — drop it, or git.log would try to walk past the new root.
    await fs.promises.rm(path.join(gitdir, 'shallow'), { force: true }).catch(() => {});
    // Drop the index entry too: it still names the purged blob, and the next commit would write a
    // tree pointing at an object we're about to delete.
    await git.remove({ fs, dir: vaultRoot, gitdir, filepath }).catch(() => {});
    await sweepUnreachable(gitdir, rewritten);
    return versions.length;
  });
}

// Public: erase the ENTIRE shadow store for a brain — every version of every note. For "forget this
// brain" and for an owner who deletes their vault: without this, Callosium's copy of a brain that
// no longer exists outlives it under ~/.callosium/history forever.
export async function purgeBrain(brainId: string): Promise<void> {
  const gitdir = path.resolve(gitdirFor(brainId));
  // Belt and braces before a recursive delete: only ever remove the '<brainId>.git' directory we
  // built ourselves directly under the history root, never wherever a malformed brainId resolves to.
  if (!gitdir.endsWith('.git') || path.dirname(gitdir) !== path.resolve(historyRoot())) {
    throw new Error('history: refusing to purge outside the history root');
  }
  await withWriteLock(brainId, () => fs.promises.rm(gitdir, { recursive: true, force: true }));
  commitsSincePrune.delete(gitdirFor(brainId));
}
