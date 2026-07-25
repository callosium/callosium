// Regression test for the cross-instance write lock (final full-check HIGH):
// serveHttp opens a fresh Vault per request, so an instance-private lock map let
// two concurrent read-modify-write ops on the SAME note clobber each other (lost
// update — append_note could drop a block). The lock is now MODULE-LEVEL, so
// SEPARATE Vault instances pointing at the same file still serialize.
//   node test/unit-vaultlock.mjs
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Vault } from '../src/core/vault.ts';

let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + ' ' + extra); } };

const root = path.join(os.tmpdir(), `callosium-vaultlock-${process.pid}`);
await fs.rm(root, { recursive: true, force: true });
await fs.mkdir(path.join(root, 'Knowledge'), { recursive: true });
const rel = 'Knowledge/Log.md';
await fs.writeFile(path.join(root, rel), 'start\n', 'utf8');

// Simulate the HTTP path: EACH concurrent op gets its OWN Vault instance (as
// serveHttp does with Vault.open per request). A read-modify-write that appends
// a unique line. Without a shared lock, interleaved reads → lost appends.
const N = 40;
const appendOnce = async (i) => {
  const v = Vault.open(root); // fresh instance per op, like a fresh HTTP request
  await v.withLock(rel, async () => {
    const cur = await v.readFileRetry(rel);
    // Yield the event loop between read and write to WIDEN the interleave window
    // (this is exactly where an unlocked concurrent writer would read stale bytes).
    await new Promise((r) => setTimeout(r, 1));
    await v.writeFile(rel, cur + `line-${i}\n`);
  });
};

await Promise.all(Array.from({ length: N }, (_, i) => appendOnce(i)));

const final = await fs.readFile(path.join(root, rel), 'utf8');
const lines = final.split('\n').filter((l) => l.startsWith('line-'));
ok(`all ${N} concurrent appends survived across separate Vault instances (no lost update)`, lines.length === N, `\n    got ${lines.length} of ${N}`);
const uniq = new Set(lines);
ok('every appended line is present exactly once', uniq.size === N, `\n    ${uniq.size} unique of ${N}`);
ok('the original content is preserved', final.startsWith('start\n'));

// Different files must NOT contend (the lock is per-path, not global).
const relB = 'Knowledge/Other.md';
await fs.writeFile(path.join(root, relB), '', 'utf8');
let overlap = false, aInFlight = false;
await Promise.all([
  Vault.open(root).withLock(rel, async () => { aInFlight = true; await new Promise((r) => setTimeout(r, 30)); aInFlight = false; }),
  Vault.open(root).withLock(relB, async () => { if (aInFlight) overlap = true; }),
]);
ok('locks on DIFFERENT files run concurrently (per-path, not a global mutex)', overlap);

await fs.rm(root, { recursive: true, force: true });
console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
console.log('  ALL PASS');
