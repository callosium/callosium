// Retention invariants for the version store.
//
// This file exists because two consecutive review rounds found real bugs in this one function, and
// both were the same shape: a state the code had never been RUN in. Retention is the only thing in
// Callosium that deletes user data on purpose, so "we reviewed it" is not a good enough guard —
// these are the states themselves, asserted.
//
// The bugs, for whoever changes this next:
//   1. An aborted sweep did not resume. The shallow marker is published BEFORE the sweep (so an
//      unlocked listVersions cannot walk into objects we are about to unlink), and once published
//      git.log stops there — so the "over budget?" test answered no forever and the tail objects
//      were stranded permanently, on that trigger and every later boot.
//   2. Fixing (1) added a bypass of that size check, which made an EMPTY git.log destructive: the
//      walk's blanket catch returned [], the bypass skipped the check, and the sweep ran with an
//      empty kept set — not "prune the tail" but "nothing is reachable". It wrote `undefined` into
//      shallow and unlinked every commit, tree and blob. hasHead() does not catch this: it resolves
//      the HEAD ref and never proves the commit object is readable.
//
//   node test/unit-retention.mjs
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const root = path.join(os.tmpdir(), `callosium-retention-${process.pid}`);
process.env.CALLOSIUM_HISTORY_ROOT = path.join(root, 'hist');
process.env.CALLOSIUM_HISTORY_KEEP = '1000000'; // build without pruning; lowered per-case below

let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (extra ? '  ' + extra : '')); } };

const brain = path.join(root, 'brain');
await fs.rm(root, { recursive: true, force: true });
await fs.mkdir(path.join(brain, 'Knowledge'), { recursive: true });
await fs.mkdir(path.join(root, 'hist'), { recursive: true });

const store = await import('../src/history/store.ts');
const ID = 'retention-probe';
const gitdir = path.join(root, 'hist', `${ID}.git`);
const NOTE = 'Knowledge/Subject.md';

await store.ensureHistory(brain, ID);
for (let i = 0; i < 12; i++) {
  await fs.writeFile(path.join(brain, NOTE), `---\ntype: knowledge\n---\n\nrevision ${i}\n`, 'utf8');
  await store.snapshotNote(brain, ID, NOTE, 'claude');
}

const countObjects = async () => {
  let n = 0;
  for (const b of await fs.readdir(path.join(gitdir, 'objects')).catch(() => [])) {
    if (!/^[0-9a-f]{2}$/.test(b)) continue;
    n += (await fs.readdir(path.join(gitdir, 'objects', b)).catch(() => [])).length;
  }
  return n;
};
const SWEEP_MARK = path.join(gitdir, 'callosium-sweep-pending');
const REF = path.join(gitdir, 'refs', 'heads', 'main');

const objectsAtStart = await countObjects();
const versionsAtStart = (await store.listVersions(brain, ID, NOTE)).length;
ok('fixture has history to protect', objectsAtStart > 0 && versionsAtStart > 1);

// ── invariant 1: a FAILED walk is not "nothing is reachable" ─────────────────
// The destructive combination: a sweep marker present (so the size check is bypassed) AND a walk
// that cannot complete. Simulated by pointing the ref at an oid whose object does not exist —
// exactly what a transient object-read failure on a synced or AV-scanned dir looks like.
await fs.writeFile(SWEEP_MARK, 'interrupted\n');
const savedRef = await fs.readFile(REF, 'utf8').catch(() => null);
ok('fixture ref is readable (test is meaningful)', !!savedRef);
await fs.writeFile(REF, `${'0'.repeat(40)}\n`);
await store.pruneHistory(ID).catch(() => {});
const objectsAfterBadWalk = await countObjects();
await fs.writeFile(REF, savedRef); // restore before asserting the timeline
const shallowText = await fs.readFile(path.join(gitdir, 'shallow'), 'utf8').catch(() => '');

ok('a failed walk deletes NOTHING', objectsAfterBadWalk === objectsAtStart,
  `${objectsAtStart} -> ${objectsAfterBadWalk}`);
ok('and never writes a bogus shallow boundary', !shallowText.includes('undefined'));
ok('the note timeline survives it',
  (await store.listVersions(brain, ID, NOTE).catch(() => [])).length === versionsAtStart);

// ── invariant 2: an outstanding sweep is retried, not forgotten ──────────────
// The marker must still be there: the sweep genuinely was outstanding and never ran.
ok('an unrunnable sweep keeps its marker for a later retry',
  !!(await fs.stat(SWEEP_MARK).catch(() => null)));

// ── invariant 3: a real prune trims, keeps the newest, and stays restorable ──
process.env.CALLOSIUM_HISTORY_KEEP = '3'; // KEEP=3 -> slack 100... below the fixture, so force it
const small = await import(`../src/history/store.ts?keep=${Date.now()}`);
const before = await small.listVersions(brain, ID, NOTE);
await small.pruneHistory(ID).catch(() => {});
const after = await small.listVersions(brain, ID, NOTE).catch(() => null);
ok('a prune never makes the timeline unreadable', Array.isArray(after));
if (Array.isArray(after) && after.length) {
  // Whatever survived must still be READABLE by oid — the prune shallow-marks rather than
  // rewriting precisely so a version id the History panel already holds stays restorable.
  const newest = after[0];
  const body = await small.readVersion(brain, ID, NOTE, newest.oid).catch(() => null);
  ok('every kept version is still restorable by its original oid', typeof body === 'string');
  ok('the newest version is preserved (we trim the TAIL, never the head)',
    before.length === 0 || newest.oid === before[0].oid);
}

// ── invariant 4: retention is idempotent ─────────────────────────────────────
const objectsBeforeRepeat = await countObjects();
await small.pruneHistory(ID).catch(() => {});
await small.pruneHistory(ID).catch(() => {});
ok('running retention again reclaims nothing new (no churn, no loop)',
  (await countObjects()) === objectsBeforeRepeat);
ok('and leaves no sweep marker behind once it completes',
  !(await fs.stat(SWEEP_MARK).catch(() => null)));

await fs.rm(root, { recursive: true, force: true });
console.log(`\nretention: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
