// Per-agent activity log — an append-only audit trail of what each connected AI (and the owner)
// DID to the brain: read / write / append / archive / move / recall / remember. It powers the
// dashboard's "recent activity" feed so the owner can see, per agent, exactly what happened.
//
// Storage mirrors the version-history store: a JSONL file OUTSIDE the vault at
// ~/.callosium/activity/<brainId>.jsonl (brainId is the same content-hash of the vault root the
// history store and MCP server use, so writers and the dashboard reader agree). Writes are
// best-effort and MUST NEVER throw or block the tool call that triggered them.
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

const MAX_LINES = 5000; // soft cap; once exceeded we trim down to KEEP_LINES so the file can't grow unbounded
const KEEP_LINES = 3000;
let sinceTrimCheck = 0;
let trimSeq = 0;

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
      ...(entry.detail ? { detail: entry.detail } : {}),
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

// Amortized trim: only stat/rewrite occasionally (every ~200 appends per process) so logging stays
// cheap. The rewrite is temp-file-then-rename (atomic) with a pid-unique temp name so two processes
// trimming at once can't clobber each other.
async function maybeTrim(file: string): Promise<void> {
  // Trim on the process's FIRST append (so a short-lived, low-volume MCP process still bounds a file
  // that a long-running fleet grew huge) and every 200 appends after. sinceTrimCheck starts at 0, so
  // 0 % 200 === 0 fires on call #1.
  if (sinceTrimCheck++ % 200 !== 0) return;
  try {
    const raw = await fs.promises.readFile(file, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    if (lines.length <= MAX_LINES) return;
    // Unique temp per trim (pid + seq) so two trims in one process can't interleave into a shared
    // temp; rename is atomic so a concurrent reader never sees a half-file.
    const tmp = `${file}.tmp-${process.pid}-${trimSeq++}`;
    await fs.promises.writeFile(tmp, lines.slice(-KEEP_LINES).join('\n') + '\n', 'utf8');
    await fs.promises.rename(tmp, file);
  } catch {
    /* ignore */
  }
}

// The most recent `limit` actions, newest-first.
export async function readActions(brainId: string, limit = 30): Promise<ActionEntry[]> {
  try {
    const raw = await fs.promises.readFile(activityFileFor(brainId), 'utf8');
    const lines = raw.split('\n');
    const out: ActionEntry[] = [];
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
    return out;
  } catch {
    return [];
  }
}
