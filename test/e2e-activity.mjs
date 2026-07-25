// Unit test for the per-agent activity log (P0). Isolates storage to a temp dir.
//   node test/e2e-activity.mjs
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const root = path.join(os.tmpdir(), `callosium-activity-${process.pid}`);
process.env.CALLOSIUM_ACTIVITY_ROOT = root; // log.ts reads this lazily
await fs.rm(root, { recursive: true, force: true });

const { logAction, readActions } = await import('../src/audit/log.ts');

let pass = 0,
  fail = 0;
const ok = (n, c, extra = '') => {
  if (c) {
    pass++;
    console.log('  ✓ ' + n);
  } else {
    fail++;
    console.log('  ✗ ' + n + ' ' + extra);
  }
};

const brainId = 'test-brain';

// ── append + read newest-first ──
await logAction(brainId, { agentId: 'claude', agent: 'Claude (Code)', action: 'read', path: 'Knowledge/Coffee.md' });
await logAction(brainId, { agentId: 'chatgpt', agent: 'ChatGPT (Cursor)', action: 'write', path: 'Inbox/New.md' });
await logAction(brainId, { agentId: 'claude', agent: 'Claude (Code)', action: 'recall', detail: 'espresso ratio' });

let items = await readActions(brainId, 30);
ok('three actions logged', items.length === 3, JSON.stringify(items.map((i) => i.action)));
ok('newest first', items[0].action === 'recall' && items[2].action === 'read', JSON.stringify(items.map((i) => i.action)));
ok('fields captured (agent/action/path)', items[1].agent === 'ChatGPT (Cursor)' && items[1].action === 'write' && items[1].path === 'Inbox/New.md', JSON.stringify(items[1]));
ok('recall keeps its query detail, no path', items[0].detail === 'espresso ratio' && items[0].path === undefined, JSON.stringify(items[0]));
ok('every entry has a numeric timestamp', items.every((i) => typeof i.at === 'number' && i.at > 0));

// ── per-agent filtering is possible from the returned data ──
const claudeOnly = items.filter((i) => i.agentId === 'claude');
ok('two agents distinguishable by agentId', claudeOnly.length === 2 && items.filter((i) => i.agentId === 'chatgpt').length === 1);

// ── limit caps the result ──
ok('limit caps results', (await readActions(brainId, 2)).length === 2);

// ── a torn/garbage line is skipped, not fatal ──
const file = path.join(root, `${brainId}.jsonl`);
await fs.appendFile(file, '{ this is not valid json\n', 'utf8');
await logAction(brainId, { agentId: 'claude', agent: 'Claude (Code)', action: 'append', path: 'Log.md' });
items = await readActions(brainId, 30);
ok('garbage line skipped; valid entries survive', items.length === 4 && items[0].action === 'append', String(items.length));

// ── unknown brain returns empty, never throws ──
ok('unknown brain → empty', (await readActions('nope', 10)).length === 0);

// cleanup
await fs.rm(root, { recursive: true, force: true });

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
console.log('  ALL PASS');
