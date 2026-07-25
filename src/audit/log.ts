// Per-agent activity log — an append-only audit trail of what each connected AI (and the owner)
// DID to the brain: read / write / append / archive / move / recall / remember. It powers the
// dashboard's "recent activity" feed so the owner can see, per agent, exactly what happened.
//
// Storage mirrors the version-history store: a JSONL file OUTSIDE the vault at
// ~/.callosium/activity/<brainId>.jsonl (brainId is the same content-hash of the vault root the
// history store and MCP server use, so writers and the dashboard reader agree), plus one rotated
// generation beside it (<brainId>.jsonl.1) — see maybeTrim. Writes are best-effort and MUST NEVER
// throw or block the tool call that triggered them.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export interface ActionEntry {
  at: number; // epoch ms
  agentId: string; // stable agent id, e.g. 'chatgpt-cursor' ('owner' for dashboard edits)
  agent: string; // display name, e.g. 'ChatGPT (Cursor)'
  action: string; // 'read' | 'write' | 'append' | 'archive' | 'move' | 'recall' | 'remember'
  path?: string; // note path the action touched (destination path for a move)
  detail?: string; // extra context — the query for recall, the source path for a move
}

function activityFileFor(brainId: string): string {
  // CALLOSIUM_ACTIVITY_ROOT relocates the log (tests isolate it; owners can move it off a synced
  // drive). Defaults to ~/.callosium/activity, a sibling of the version-history store.
  const root = process.env.CALLOSIUM_ACTIVITY_ROOT || path.join(os.homedir(), '.callosium', 'activity');
  return path.join(root, `${brainId}.jsonl`);
}

const MAX_LINES = 5000; // once the live file exceeds this we rotate it, so neither file grows unbounded
// `detail` is free text handed to us by the connected AI (the recall question, a move's source
// path). MAX_LINES bounds how MANY entries we keep but says nothing about their size, so one agent
// pasting a 200KB "question" wrote a single 200KB line — 5000 of those is a gigabyte, and the
// dashboard feed reads the whole file. Cap what we store: the feed shows ~48 chars of it, and the
// audit trail only needs enough to recognise what the agent did.
const MAX_DETAIL = 500;
const LOCK_STALE_MS = 30_000; // a rotate lock older than this belonged to a process that died
let sinceTrimCheck = 0;

// Append one action. Never throws — the audit trail is a convenience, not part of the write path.
export async function logAction(brainId: string, entry: Omit<ActionEntry, 'at'> & { at?: number }): Promise<void> {
  try {
    const file = activityFileFor(brainId);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const rec: ActionEntry = {
      at: entry.at ?? Date.now(),
      agentId: entry.agentId,
      agent: entry.agent,
      action: entry.action,
      ...(entry.path ? { path: entry.path } : {}),
      ...(entry.detail ? { detail: entry.detail.length > MAX_DETAIL ? entry.detail.slice(0, MAX_DETAIL) + '…' : entry.detail } : {}),
    };
    // O_APPEND: each line is written atomically enough that concurrent agent processes interleave
    // whole lines, not bytes; readActions() skips any line that doesn't parse, so a rare torn write
    // is harmless rather than corrupting the feed.
    await fs.promises.appendFile(file, JSON.stringify(rec) + '\n', 'utf8');
    await maybeTrim(file);
  } catch {
    /* best-effort: swallow */
  }
}

// The previous generation of the log. Only one is kept: the generation before that is what the
// rotation's rename replaces, and that is what bounds the whole store.
const rotatedFile = (file: string): string => `${file}.1`;

// Amortized size check: only read/rotate occasionally (every ~200 appends per process) so logging
// stays cheap.
//
// This used to trim by rewriting: read the file, slice the last KEEP_LINES into a temp, rename the
// temp over the original. That silently DELETED every action another agent process appended between
// the read and the rename — a measured 5-10ms hole per trim on a large file, and an audit trail
// that quietly loses things that really happened is worse than one that's a bit too big. It also
// tended to fail outright on Windows, where you can't rename over a file another writer has open,
// so the log both lost entries on macOS/Linux and never got trimmed here.
//
// Rotation has no such hole: ONE atomic rename moves the whole live file aside, and nothing is ever
// rewritten or dropped. Appends that open the file after it land in a fresh live file; the rare
// straggler still holding a pre-rotation handle lands in the rotated file — which we keep, and
// readActions() reads. Two files, each capped at MAX_LINES.
async function maybeTrim(file: string): Promise<void> {
  // Check on the process's FIRST append (so a short-lived, low-volume MCP process still bounds a file
  // that a long-running fleet grew huge) and every 200 appends after. sinceTrimCheck starts at 0, so
  // 0 % 200 === 0 fires on call #1.
  if (sinceTrimCheck++ % 200 !== 0) return;
  // One rotator at a time, across processes: two rotating back-to-back would push a barely-started
  // live file over the previous one, throwing away ~5000 real entries. Exclusive-create is the
  // cheapest cross-platform mutex, and appenders never take it, so a rotation never blocks logging.
  const lockFile = `${file}.lock`;
  let lock: Awaited<ReturnType<typeof fs.promises.open>>;
  try {
    lock = await fs.promises.open(lockFile, 'wx');
  } catch {
    // Someone else is mid-rotation — or a process died holding the lock. Break a stale one, so a
    // single crash can't disable rotation (and let the log grow forever) from then on.
    try {
      const st = await fs.promises.stat(lockFile);
      if (Date.now() - st.mtimeMs > LOCK_STALE_MS) await fs.promises.unlink(lockFile);
    } catch {
      /* ignore */
    }
    return;
  }
  try {
    const raw = await fs.promises.readFile(file, 'utf8');
    let lines = 0;
    for (let i = 0; i < raw.length; i++) if (raw.charCodeAt(i) === 10) lines++;
    if (lines <= MAX_LINES) return;
    await fs.promises.rename(file, rotatedFile(file));
  } catch {
    /* ignore */
  } finally {
    await lock.close().catch(() => {});
    await fs.promises.unlink(lockFile).catch(() => {});
  }
}

// The most recent `limit` actions, newest-first.
export async function readActions(brainId: string, limit = 30): Promise<ActionEntry[]> {
  const file = activityFileFor(brainId);
  const out: ActionEntry[] = [];
  await collectNewestFirst(file, limit, out);
  // A rotation leaves the live file nearly empty, so read on into the previous generation rather
  // than showing the owner an "activity" feed that just went blank on them.
  if (out.length < limit) await collectNewestFirst(rotatedFile(file), limit, out);
  return out;
}

async function collectNewestFirst(file: string, limit: number, out: ActionEntry[]): Promise<void> {
  try {
    const raw = await fs.promises.readFile(file, 'utf8');
    const lines = raw.split('\n');
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      const ln = lines[i];
      if (!ln) continue;
      try {
        const e = JSON.parse(ln) as ActionEntry;
        if (e && typeof e.at === 'number' && typeof e.action === 'string') out.push(e);
      } catch {
        /* skip a torn/legacy line */
      }
    }
  } catch {
    /* no such generation yet */
  }
}
