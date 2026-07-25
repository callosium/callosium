// Universal version history — the external-write safety net (M1).
//
// A Callosium-owned git history of the vault kept in ~/.callosium/history/<brainId>.git,
// with the git-dir OUTSIDE the vault (work-tree = the vault, no visible .git inside it) so it
// never collides with any git the owner keeps on their vault. Every note change — whether it
// came through Callosium's MCP or from a direct external edit — is committed here, so every
// version is restorable with a diff. "Your AI can't lose your memory."
//
// Why git (isomorphic-git): pure-JS, so no git binary to bundle in the portable; real diffs,
// one-command restore, and delta compression for free.
//
// Invariants:
//  - Best-effort: a history failure must NEVER block a real write or a re-index. The public
//    functions throw on hard git errors; callers wrap them in try/catch and swallow.
//  - Serialized: isomorphic-git mutates a shared index, so all ops on one shadow repo run
//    under a per-brain lock.

import git from 'isomorphic-git';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

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

function gitdirFor(brainId: string): string {
  // CALLOSIUM_HISTORY_ROOT relocates the version store (tests isolate it; owners can move it
  // off a synced drive). Defaults to ~/.callosium/history.
  const root = process.env.CALLOSIUM_HISTORY_ROOT || path.join(os.homedir(), '.callosium', 'history');
  return path.join(root, `${brainId}.git`);
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

// Cross-PROCESS lock: the dashboard and each MCP agent are separate processes that can all
// commit to the same shadow repo; isomorphic-git shares one on-disk index/refs, so concurrent
// commits from two processes could corrupt it. An O_EXCL lockfile serializes them. Best-effort:
// if we can't acquire within the window, the caller skips this snapshot — the change stays on
// disk and gets captured on the next re-index (git.status makes re-capture idempotent).
async function acquireProcessLock(brainId: string): Promise<(() => Promise<void>) | null> {
  const lockPath = `${gitdirFor(brainId)}.lock`;
  await fs.promises.mkdir(path.dirname(lockPath), { recursive: true }).catch(() => {});
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    try {
      const fh = await fs.promises.open(lockPath, 'wx'); // exclusive create
      await fh.write(`${process.pid}\n${os.hostname()}`); // owner pid + host so a waiter can judge liveness
      await fh.close();
      return () => fs.promises.rm(lockPath, { force: true }).catch(() => {});
    } catch {
      // Decide whether to steal a contended lock. On the SAME machine the owner pid is authoritative:
      // steal only if that process is DEAD, NEVER on wall-clock age — a legit baseline import can hold
      // the lock for >10 min on a large vault, and stealing a live local holder would let two
      // processes commit to the shared git index/refs concurrently and corrupt them. The age-based
      // steal is a last-resort ONLY for a lock left by a process on ANOTHER machine (a OneDrive/iCloud
      // synced git-dir), where the recorded pid is meaningless against our local process table.
      try {
        const raw = await fs.promises.readFile(lockPath, 'utf8').catch(() => '');
        const st = await fs.promises.stat(lockPath);
        const [pidStr, hostStr = ''] = raw.split('\n');
        const pid = parseInt(pidStr, 10);
        const sameMachine = hostStr.trim() === os.hostname();
        let steal = false;
        if (sameMachine) {
          // Local owner: trust the pid. Dead → steal; alive → leave it (ignore age entirely).
          if (Number.isFinite(pid) && pid > 0 && pid !== process.pid) {
            try {
              process.kill(pid, 0); // throws ESRCH if that process no longer exists
            } catch {
              steal = true; // owner is gone
            }
          }
        } else {
          // Different (or unknown/legacy-format) machine: pid can't be verified here, so fall back to
          // the wall-clock age heuristic for an abandoned cross-machine lock.
          steal = Date.now() - st.mtimeMs > 600_000;
        }
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

function commit(gitdir: string, vaultRoot: string, source: string, message: string): Promise<string> {
  return git.commit({
    fs,
    dir: vaultRoot,
    gitdir,
    message,
    author: { name: source, email: AUTHOR_EMAIL, timestamp: Math.floor(Date.now() / 1000), timezoneOffset: 0 },
  });
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
  await withWriteLock(brainId, () => initIfNeeded(vaultRoot, gitdir));
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
  return withWriteLock(brainId, async () => {
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
  });
}

// Public: the version timeline for one note, newest first.
export async function listVersions(vaultRoot: string, brainId: string, relpath: string): Promise<Version[]> {
  const gitdir = gitdirFor(brainId);
  return withRepoLock(brainId, async () => {
    if (!(await hasHead(gitdir))) return [];
    const log = await git.log({ fs, dir: vaultRoot, gitdir, filepath: relpath, force: true }).catch(() => []);
    return log.map((c) => ({
      oid: c.oid,
      ts: (c.commit.author.timestamp || 0) * 1000,
      source: c.commit.author.name || 'unknown',
      message: (c.commit.message || '').split('\n')[0],
    }));
  });
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
  return withWriteLock(brainId, async () => {
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
  });
}
