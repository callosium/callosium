// End-to-end test for the version-history store (M1 external-write safety net).
// Isolates the shadow-git store to a temp dir so it never touches ~/.callosium.
//   node test/e2e-history.mjs

import { promises as fs } from 'node:fs';
import nodefs from 'node:fs'; // same singleton the store uses — lets us fault-inject readdir
import git from 'isomorphic-git'; // same singleton the store uses — lets us fault-inject git.status
import path from 'node:path';
import os from 'node:os';
import { ensureHistory, snapshotNote, captureExternal, listVersions, readVersion, lineDiff, diffStat } from '../src/history/store.ts';

const histRoot = path.join(os.tmpdir(), `callosium-hist-store-${process.pid}`);
process.env.CALLOSIUM_HISTORY_ROOT = histRoot; // store reads this lazily in gitdirFor

let pass = 0,
  fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name} ${extra}`);
  }
};

const brain = path.join(os.tmpdir(), `callosium-hist-brain-${process.pid}`);
const brainId = 'test-brain';
const rel = 'Knowledge/Coffee.md';
const note = path.join(brain, rel);
await fs.rm(brain, { recursive: true, force: true });
await fs.rm(histRoot, { recursive: true, force: true });
await fs.mkdir(path.dirname(note), { recursive: true });
await fs.writeFile(note, 'v1 line a\nv1 line b\n');

// ── baseline ──
await ensureHistory(brain, brainId);
let v = await listVersions(brain, brainId, rel);
ok('baseline captured on init', v.length === 1 && v[0].source === 'baseline', JSON.stringify(v.map((x) => x.source)));

// ── external edit → captureExternal detects, versions, and stats it ──
await fs.writeFile(note, 'v1 line a\nv2 CHANGED\nv2 added\n');
const ext = await captureExternal(brain, brainId);
ok('external change detected', ext.length === 1 && ext[0].relpath === rel, JSON.stringify(ext));
ok('external stat counts +/- lines', ext[0].add >= 1 && ext[0].del >= 1, JSON.stringify(ext[0]));
v = await listVersions(brain, brainId, rel);
ok('external version added, attributed external', v.length === 2 && v[0].source === 'external', JSON.stringify(v.map((x) => x.source)));

// captureExternal is idempotent (nothing new to capture)
const ext2 = await captureExternal(brain, brainId);
ok('re-capture with no change is a no-op', ext2.length === 0, JSON.stringify(ext2));

// ── MCP-style snapshot with agent attribution ──
await fs.writeFile(note, 'v3 by agent\n');
const oid = await snapshotNote(brain, brainId, rel, 'ChatGPT (Cursor)');
ok('agent snapshot committed', typeof oid === 'string' && oid.length === 40, String(oid));
v = await listVersions(brain, brainId, rel);
ok('agent version attributed to the agent', v[0].source === 'ChatGPT (Cursor)', JSON.stringify(v.map((x) => x.source)));
ok('three versions total', v.length === 3, String(v.length));

// unchanged snapshot is a no-op
ok('unchanged snapshot returns null', (await snapshotNote(brain, brainId, rel, 'noop')) === null);

// ── read an old version + restore round-trip ──
const baselineOid = v[v.length - 1].oid;
const old = await readVersion(brain, brainId, rel, baselineOid);
ok('readVersion returns the exact old bytes', old === 'v1 line a\nv1 line b\n', JSON.stringify(old));

await fs.writeFile(note, old); // restore = write old content back through the (here, direct) path
const roid = await snapshotNote(brain, brainId, rel, 'restore');
ok('restore produced a new version', typeof roid === 'string' && roid.length === 40);
ok('restore round-trips content on disk', (await fs.readFile(note, 'utf8')) === 'v1 line a\nv1 line b\n');

// ── diff utils ──
const d = lineDiff('a\nb\nc\n', 'a\nX\nc\n');
ok(
  'lineDiff marks the changed line',
  d.some((l) => l.t === '-' && l.text === 'b') && d.some((l) => l.t === '+' && l.text === 'X'),
  JSON.stringify(d),
);
const st = diffStat('a\nb\n', 'a\nb\nc\nd\n');
ok('diffStat counts additions', st.add === 2 && st.del === 0, JSON.stringify(st));

// ── REGRESSION (review R4 high): a transient readdir failure in the on-disk walk must NOT fabricate
//    phantom deletions for notes that still exist. Before the fix, listNotePaths swallowed the
//    readdir error, the note vanished from onDiskSet, and the deletion loop git.remove'd + committed
//    it as an external deletion. The fix fs.stat's each candidate and only treats ENOENT as a real
//    delete. We seed a second note (so ≥2 notes are tracked at HEAD), then fault-inject an EBUSY on
//    every readdir UNDER the vault (git ops read the shadow gitdir elsewhere, so they're untouched).
const rel2 = 'Knowledge/Tea.md';
const note2 = path.join(brain, rel2);
await fs.writeFile(note2, 'tea line\n');
await snapshotNote(brain, brainId, rel2, 'seed'); // both notes now tracked at HEAD
const versionsBefore = (await listVersions(brain, brainId, rel)).length;
const realReaddir = nodefs.promises.readdir;
nodefs.promises.readdir = async (p, opts) => {
  if (typeof p === 'string' && p.startsWith(brain)) {
    const e = new Error('EBUSY: resource busy or locked');
    e.code = 'EBUSY';
    throw e;
  }
  return realReaddir(p, opts);
};
let phantom;
try {
  phantom = await captureExternal(brain, brainId);
} finally {
  nodefs.promises.readdir = realReaddir; // always restore, even on throw
}
ok('transient readdir failure fabricates NO phantom deletion', phantom.every((c) => !c.deleted), JSON.stringify(phantom));
ok(
  'both notes still on disk after the transient failure',
  (await fs.stat(note).then(() => true).catch(() => false)) && (await fs.stat(note2).then(() => true).catch(() => false)),
);
ok('no phantom deletion version appended', (await listVersions(brain, brainId, rel)).length === versionsBefore, `${(await listVersions(brain, brainId, rel)).length} vs ${versionsBefore}`);

// ── REGRESSION (review R5): a git.status read-failure inside snapshotNote must NOT leak the already
//    -staged change into the NEXT unrelated commit under the wrong attribution. The fix resets the
//    index and bails; a later captureExternal re-detects the change honestly.
const relA = 'Knowledge/LeakA.md';
const relB = 'Knowledge/LeakB.md';
await fs.writeFile(path.join(brain, relA), 'A original\n');
await fs.writeFile(path.join(brain, relB), 'B original\n');
await snapshotNote(brain, brainId, relA, 'seedA');
await snapshotNote(brain, brainId, relB, 'seedB');
await fs.writeFile(path.join(brain, relA), 'A MODIFIED — must not leak\n'); // stages a real change to A
const realStatus = git.status;
git.status = async () => {
  throw new Error('EBUSY: workdir read failed'); // transient status read failure
};
let leakRet;
try {
  leakRet = await snapshotNote(brain, brainId, relA, 'agentA'); // status throws → reset index + null
} finally {
  git.status = realStatus; // always restore
}
ok('snapshotNote returns null on a status-read failure', leakRet === null, String(leakRet));
await fs.writeFile(path.join(brain, relB), 'B MODIFIED by agentB\n');
await snapshotNote(brain, brainId, relB, 'agentB'); // commits B only — must NOT absorb A's staged change
const vA = await listVersions(brain, brainId, relA);
ok("A's staged change did NOT leak into the agentB commit", vA[0].source !== 'agentB', JSON.stringify(vA.map((x) => x.source)));
ok('A HEAD content is still the pre-leak version', (await readVersion(brain, brainId, relA, vA[0].oid)) === 'A original\n');
// ...and the change is NOT lost: captureExternal re-detects the reset A honestly (as 'external').
const reA = await captureExternal(brain, brainId);
ok('reset change re-detected honestly (no data loss)', reA.some((c) => c.relpath === relA && !c.deleted), JSON.stringify(reA));

// ── deletion is versioned too (a REAL delete: the file is genuinely gone → ENOENT) ──
await fs.rm(note, { force: true });
const del = await captureExternal(brain, brainId);
ok('deletion captured as an external change', del.length === 1 && del[0].deleted === true, JSON.stringify(del));

// ── REGRESSION (review R6 high): a BOM-prefixed note byte-identical to HEAD must NOT be perpetually
//    re-flagged as external. readHeadBlob decodes via TextDecoder (drops the BOM) while the disk read
//    keeps it, so without a BOM-insensitive compare every re-index pass accrues a phantom commit.
const relBom = 'Knowledge/Bom.md';
await fs.writeFile(path.join(brain, relBom), '﻿---\ntype: knowledge\n---\nbom body\n'); // leading BOM
await snapshotNote(brain, brainId, relBom, 'seedBom'); // committed to HEAD, BOM and all
const bomCap1 = await captureExternal(brain, brainId);
ok('unedited BOM note is NOT reported as external', !bomCap1.some((c) => c.relpath === relBom), JSON.stringify(bomCap1));
const bomVers = (await listVersions(brain, brainId, relBom)).length;
await captureExternal(brain, brainId); // second pass — must stay idempotent (no phantom commit)
ok('no phantom version accrues for the BOM note across passes', (await listVersions(brain, brainId, relBom)).length === bomVers);
await fs.writeFile(path.join(brain, relBom), '﻿---\ntype: knowledge\n---\nbom body EDITED\n'); // a REAL edit
const bomCap3 = await captureExternal(brain, brainId);
ok('a real edit to a BOM note is still detected', bomCap3.some((c) => c.relpath === relBom && !c.deleted), JSON.stringify(bomCap3));

// cleanup
await fs.rm(brain, { recursive: true, force: true });
await fs.rm(histRoot, { recursive: true, force: true });

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
console.log('  ALL PASS');
