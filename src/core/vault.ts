// Brain folder access: walking, reading, writing. Cloud-sync aware — OneDrive
// and iCloud can hand back a synced file as cloud-only on first touch in a
// fresh process, so reads throw transiently. Every read retries (this exact
// failure hit the recall CLI on a cold session start, 10 Jul 2026).

import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseNote } from './frontmatter.ts';
import type { Note, NotePath } from './types.ts';

const SKIP_DIRS = new Set(['.git', '.obsidian', '.trash', 'node_modules', '.callosium-cache']);

let writeSeq = 0; // disambiguates concurrent temp-file names within a process

// Per-file write lock, keyed by the CANONICAL ABSOLUTE path — MODULE-LEVEL, not
// per-instance, on purpose: serveHttp opens a fresh Vault per request, so an
// instance-private lock map would let two concurrent HTTP writes to the SAME
// note run their read-modify-write in parallel and clobber each other (lost
// update — append_note could drop an appended block). A module-level map shared
// by every Vault instance for the same file closes that. The key already carries
// the vault root (it's an absolute path), so there is no cross-brain collision,
// and the withLock cleanup deletes each key when it has no successor, so this
// never grows unbounded. stdio (one Vault per process) is unaffected.
const vaultLocks = new Map<string, Promise<void>>();

/** Canonical write-lock key for an absolute path. Mirrors the canonicalization the
 *  SCOPE layer already does (mcp/agents.ts normalizeRel + foldCase), because the
 *  disk resolves all of these to ONE file while plain case-folding left them as
 *  DIFFERENT strings — and two writers holding different lock keys for the same
 *  note interleave their read-modify-write and lose an update, the exact failure
 *  this lock exists to prevent:
 *    • Unicode form — macOS/iCloud hand back decomposed (NFD) names, so an agent's
 *      composed "Café.md" and a directory-walk's NFD "Café.md" never matched.
 *    • win32/darwin trailing dots and spaces — "Log.md." and "Log.md " both open
 *      Log.md, so an agent that pipelines two appends with a stray trailing space
 *      ran both unlocked against each other.
 *  Over-canonicalizing a LOCK key is harmless (at worst two genuinely distinct
 *  files serialize needlessly); under-canonicalizing silently drops writes — so
 *  we fold the same way the scope check does. normalizeRel can't just be called
 *  here: it hard-denies ABSOLUTE paths, and this key must carry the vault root so
 *  two brains never collide in the module-level map. Linux is left byte-exact —
 *  there NFC/NFD and "Log.md " really are different files.
 *  This is the ONLY place the fold is written. Callers outside this file reach it
 *  through Vault#lockKeyFor — see the note there for why a private copy is a bug. */
function lockKey(canonAbs: string): string {
  if (process.platform === 'linux') return canonAbs;
  return canonAbs
    .normalize('NFC')
    .split(/[\\/]/)
    .map((seg) => seg.replace(/[. ]+$/, ''))
    .join('/')
    .toLowerCase();
}

export class Vault {
  readonly root: string;
  #realRoot: string | null = null;

  constructor(root: string) {
    this.root = root;
  }

  static open(root: string): Vault {
    if (!existsSync(root)) throw new Error(`Brain folder not found: ${root}`);
    return new Vault(path.resolve(root));
  }

  abs(rel: NotePath): string {
    const full = path.resolve(this.root, rel);
    // Path-traversal guard: a scoped agent must never escape the brain root.
    if (!full.startsWith(this.root + path.sep) && full !== this.root) {
      throw new Error(`Path escapes the brain: ${rel}`);
    }
    return full;
  }

  /** Real (symlink-resolved) brain root, cached. */
  async #realBrainRoot(): Promise<string> {
    return (this.#realRoot ??= await fs.realpath(this.root));
  }

  /** Defeat symlink/junction escapes that the purely-lexical abs() can't see: a
   *  reparse point inside the vault (e.g. a `mklink /J` junction to
   *  C:\Windows\System32, which needs no admin rights) resolves to a string
   *  under the root yet the real I/O follows it OUTSIDE. Resolve the real path of
   *  the target (or its nearest existing ancestor, for not-yet-created writes)
   *  and require it to stay within the real root. */
  async #assertInside(full: string): Promise<void> {
    const root = await this.#realBrainRoot();
    // A note must be a REAL file, never a symlink. A symlinked .md can redirect a scope-ALLOWED
    // lexical path (e.g. Public/x.md) to a scoped target (System/agents.json tokens, or a Private/
    // note) — the upstream canRead/canWrite check validated the LEXICAL path, not the link's target,
    // so following it would leak. Refuse. A regular note is never a symlink (no false positives); a
    // not-yet-created path lstats ENOENT and is fine. (A planted symlinked ANCESTOR directory is a
    // far lower-precondition residual, still bounded by the realpath containment check below.)
    let lst: import('node:fs').Stats | null = null;
    try {
      lst = await fs.lstat(full);
    } catch {
      /* ENOENT (new path) or transient — the realpath containment guard below still applies */
    }
    if (lst?.isSymbolicLink()) {
      throw new Error(`Path is a symlink (refused — a note must be a real file): ${path.relative(this.root, full)}`);
    }
    let probe = full;
    while (!existsSync(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe);
    let real: string;
    try {
      real = await fs.realpath(probe);
    } catch {
      return; // nothing on disk to resolve yet — the lexical abs() guard stands
    }
    if (real !== root && !real.startsWith(root + path.sep)) {
      throw new Error(`Path escapes the brain (symlink/junction): ${path.relative(this.root, full)}`);
    }
  }

  /** The exact string withLock() mutexes on for `rel` — the answer to "are these two
   *  spellings the same note as far as the write lock is concerned?".
   *
   *  Exposed because other layers MUST agree with the write lock about that, and a
   *  private copy of the derivation silently drifts the moment the fold changes.
   *  It did: when lockKey() gained NFC + trailing dot/space folding, mcp/server.ts
   *  still carried two hand-copied `linux ? k : k.toLowerCase()` clones — one in
   *  move_note's same-file guard, one in the version-snapshot barrier's key. The
   *  guard then passed for a from/to pair that vault.ts folds to ONE key, so
   *  move_note locked lo then hi on the identical key and self-deadlocked, poisoning
   *  that note's lock for the life of the process; the barrier missed exactly the
   *  aliases the lock serializes. Anything that needs this key calls THIS. */
  lockKeyFor(rel: NotePath): string {
    // Key on the canonical absolute path, not the raw caller string — otherwise
    // 'Knowledge/x.md' and 'Knowledge\\x.md' (same file on win32) get different
    // lock keys and both writers run in parallel, clobbering each other.
    let canon: string;
    try {
      canon = this.abs(rel);
    } catch {
      canon = rel; // escapes the root: the I/O will refuse it, but still lock on something stable
    }
    return lockKey(canon);
  }

  /** Serialize read-modify-write sequences on the SAME note path within this
   *  process, so two in-process writers (an agent pipelining two append_note
   *  calls, or a dashboard reindex racing an agent write) can't both read the
   *  same content and clobber each other's change. Cross-process writers remain
   *  best-effort — the atomic rename in writeFile keeps each individual write
   *  from tearing.
   *  NOT re-entrant: nesting two withLocks that resolve to ONE key deadlocks
   *  forever. A caller that locks two paths must first prove they are distinct
   *  with lockKeyFor(). */
  async withLock<T>(rel: NotePath, fn: () => Promise<T>): Promise<T> {
    const key = this.lockKeyFor(rel);
    const prev = vaultLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const chained = prev.then(() => new Promise<void>((r) => (release = r)));
    vaultLocks.set(key, chained);
    await prev.catch(() => {}); // wait our turn; a predecessor's failure isn't ours
    try {
      return await fn();
    } finally {
      release();
      if (vaultLocks.get(key) === chained) vaultLocks.delete(key); // no successor → drop
    }
  }

  async readFileRetry(rel: NotePath, tries = 4): Promise<string> {
    const full = this.abs(rel);
    await this.#assertInside(full);
    let lastErr: unknown;
    for (let i = 0; i < tries; i++) {
      try {
        return await fs.readFile(full, 'utf8');
      } catch (err) {
        lastErr = err;
        // A file that genuinely doesn't exist won't appear by retrying — the
        // retry loop exists only for cloud-sync placeholders that fail
        // transiently on first touch. Fail fast on ENOENT.
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') throw err;
        await new Promise((r) => setTimeout(r, 150 * (i + 1)));
      }
    }
    throw lastErr;
  }

  /** Byte size of a note without reading its content — same containment guards as
   *  readFileRetry, so a caller can decide to skip/defer a huge file before ever
   *  pulling it into memory. Returns null if the file is missing. */
  async statSize(rel: NotePath): Promise<number | null> {
    const full = this.abs(rel);
    await this.#assertInside(full);
    try {
      return (await fs.stat(full)).size;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
      throw err;
    }
  }

  async readNote(rel: NotePath): Promise<Note> {
    return parseNote(rel, await this.readFileRetry(rel));
  }

  async writeFile(rel: NotePath, content: string): Promise<void> {
    const full = this.abs(rel);
    await this.#assertInside(full);
    await fs.mkdir(path.dirname(full), { recursive: true });
    // Atomic: write a temp sibling then rename over the target, so a crash or
    // concurrent read mid-write never sees a truncated note.
    const tmp = `${full}.tmp-${process.pid}-${writeSeq++}`;
    try {
      await fs.writeFile(tmp, content, 'utf8');
      // The rename can transiently fail under OneDrive/antivirus locks
      // (EPERM/EACCES/EBUSY) — retry with the same backoff readFileRetry uses,
      // rather than losing the write on a momentary lock.
      for (let i = 0; ; i++) {
        try { await fs.rename(tmp, full); break; }
        catch (err) {
          const code = (err as NodeJS.ErrnoException)?.code;
          if (i >= 4 || !(code === 'EPERM' || code === 'EACCES' || code === 'EBUSY')) throw err;
          await new Promise((r) => setTimeout(r, 150 * (i + 1)));
        }
      }
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  }

  exists(rel: NotePath): boolean {
    return existsSync(this.abs(rel));
  }

  /** Remove a note file (used by move_note — version history snapshots it first, so the
   *  deletion is recoverable). Same containment guard as writeFile: never deletes outside
   *  the brain. */
  async deleteFile(rel: NotePath): Promise<void> {
    const full = this.abs(rel);
    await this.#assertInside(full);
    // Retry a transient OneDrive/antivirus lock like writeFile's rename does, so move_note
    // doesn't leave BOTH from and to on disk after a momentary EPERM/EACCES/EBUSY.
    for (let i = 0; ; i++) {
      try {
        await fs.rm(full, { force: true });
        return;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (i >= 4 || !(code === 'EPERM' || code === 'EACCES' || code === 'EBUSY')) throw err;
        await new Promise((r) => setTimeout(r, 150 * (i + 1)));
      }
    }
  }

  /** All markdown paths, relative, forward slashes. */
  async listNotes(): Promise<NotePath[]> {
    const out: NotePath[] = [];
    const realRoot = await this.#realBrainRoot();
    const walk = async (dir: string) => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (SKIP_DIRS.has(e.name)) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          // Don't descend into a reparse point (symlink/junction) that escapes
          // the vault — it would pull external files in as bogus "notes".
          try {
            const real = await fs.realpath(full);
            if (real !== realRoot && !real.startsWith(realRoot + path.sep)) continue;
          } catch {
            continue;
          }
          await walk(full);
        } else if (e.name.endsWith('.md') && !e.isSymbolicLink()) {
          out.push(path.relative(this.root, full).split(path.sep).join('/'));
        }
      }
    };
    await walk(this.root);
    return out;
  }

  /** All file basenames (lowercased), any extension — notes AND attachments
   *  (.pdf/.html/.docx/…). Lets the checker tell a link to a real attachment from
   *  a truly broken note link. Returns both the full name and the name without its
   *  extension, so "[[File.pdf]]" and "[[File]]" both match a real "File.pdf". */
  async listAttachmentNames(): Promise<Set<string>> {
    const out = new Set<string>();
    const realRoot = await this.#realBrainRoot();
    const walk = async (dir: string) => {
      let entries;
      try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (SKIP_DIRS.has(e.name)) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          try { const real = await fs.realpath(full); if (real !== realRoot && !real.startsWith(realRoot + path.sep)) continue; } catch { continue; }
          await walk(full);
        } else if (!e.name.endsWith('.md') && !e.isSymbolicLink() && !/\.tmp-\d+/.test(e.name)) {
          // skip crash-orphaned atomic-write temps (.tmp-<pid>-<seq>) — they're not
          // real attachments and would falsely satisfy a broken-link check.
          // NFC-normalize like the checker's link side does: macOS/iCloud hand
          // back NFD filenames, and an un-normalized "café.pdf" would read as a
          // broken link to a file that exists (16 Jul review).
          const base = e.name.normalize('NFC').toLowerCase();
          out.add(base);
          const dot = base.lastIndexOf('.');
          if (dot > 0) out.add(base.slice(0, dot));
        }
      }
    };
    await walk(this.root);
    return out;
  }

  /** Newest note mtime (ms) in the vault, or 0 if none. Lets a cache detect that
   *  an external writer (an MCP agent, another process) touched the vault since it
   *  was built, so stale content isn't served or written over. */
  async newestMtime(): Promise<number> {
    let newest = 0;
    const realRoot = await this.#realBrainRoot();
    const walk = async (dir: string) => {
      let entries;
      try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (SKIP_DIRS.has(e.name)) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          try { const real = await fs.realpath(full); if (real !== realRoot && !real.startsWith(realRoot + path.sep)) continue; } catch { continue; }
          await walk(full);
        } else if (e.name.endsWith('.md') && !e.isSymbolicLink()) {
          try { const m = (await fs.stat(full)).mtimeMs; if (m > newest) newest = m; } catch { /* transient */ }
        }
      }
    };
    await walk(this.root);
    return newest;
  }

  /** A cheap fingerprint of the whole note tree that changes on ANY structural
   *  or content change: an EDIT bumps a file mtime, an ADD or DELETE changes the
   *  file count, and a RENAME changes the path set. A long-running cache (an MCP
   *  session, the dashboard) records this once and re-checks it on a throttle;
   *  a different token means an external writer — Obsidian, a sync client, another
   *  agent — touched the vault, so the cache must reload before it serves or
   *  writes over stale content. One walk (a stat per note, like newestMtime), so
   *  it is safe to call on read behind a short throttle.
   *
   *  Why this and not fs.watch: recursive fs.watch is unavailable on Linux, and
   *  every OS coalesces/drops events under load and reports editor atomic-saves
   *  (write-temp-then-rename) inconsistently. A token compared at read time can
   *  never MISS a change — the worst case is one throttle-interval of staleness,
   *  which for a request/response MCP server (it only reads when asked) is exactly
   *  the right trade. */
  async freshnessToken(): Promise<string> {
    const paths: string[] = [];
    let newest = 0;
    const realRoot = await this.#realBrainRoot();
    const walk = async (dir: string) => {
      let entries;
      try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (SKIP_DIRS.has(e.name)) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          try { const real = await fs.realpath(full); if (real !== realRoot && !real.startsWith(realRoot + path.sep)) continue; } catch { continue; }
          await walk(full);
        } else if (e.name.endsWith('.md') && !e.isSymbolicLink()) {
          const rel = path.relative(this.root, full).split(path.sep).join('/');
          // System/Map.md is a Callosium-GENERATED file (regenerated after our own
          // writes to keep the vault map live). It is excluded from recall and the
          // graph, so its mtime must NOT feed the freshness token — otherwise every
          // map refresh would invalidate the read caches it just wrote from, an
          // avoidable reload per structural write.
          if (rel === 'System/Map.md') continue;
          // Hash (path, mtime) PAIRS, not just paths: with paths-only, one note
          // carrying a FUTURE mtime (clock skew, a restored backup) pins the
          // `newest` component forever and every later real edit goes unseen —
          // the cache would never invalidate again (16 Jul review). Any edit
          // now perturbs the hash regardless of the maximum.
          try {
            const st = await fs.stat(full);
            const m = st.mtimeMs;
            if (m > newest) newest = m;
            // Include SIZE alongside mtime: an edit that lands in the SAME
            // millisecond as the last index (fast successive saves, or a
            // coarse-mtime filesystem) leaves mtime unchanged, so mtime alone
            // would miss it. A content change almost always changes the byte
            // length, so size closes that same-ms window cheaply (no content read).
            paths.push(`${rel} ${Math.round(m)} ${st.size}`);
          } catch {
            paths.push(rel); // transient stat failure still counts the file
          }
        }
      }
    };
    await walk(this.root);
    paths.sort();
    return `${paths.length}:${Math.round(newest)}:${Vault.contentHash(paths.join('\n'))}`;
  }

  static contentHash(content: string): string {
    return createHash('sha1').update(content).digest('hex').slice(0, 16);
  }
}
