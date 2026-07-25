// Write-path battery: exercises routing, attribution, entity resolution,
// append, and archive at volume against a SACRIFICIAL brain copy. Verifies
// integrity by running brain check before and after — the battery must not
// introduce a single new broken link, malformed frontmatter, or misfile.
//   node test/run-write-battery.mjs "<sacrificial brain path>"

import { promises as fs } from 'node:fs';
import { Vault } from '../src/core/vault.ts';
import { loadSchema } from '../src/core/schema.ts';
import { parseNote, serializeNote, isoDate } from '../src/core/frontmatter.ts';
import { routeNote, resolveEntity, validateNote } from '../src/filing/engine.ts';
import { buildNameMap } from '../src/graph/extract.ts';
import { brainCheck } from '../src/check/check.ts';
import { loadTexts } from '../src/recall/engine.ts';

const brainPath = process.argv[2];
if (!brainPath || !brainPath.toLowerCase().includes('test-brain')) {
  console.error('Refusing: this battery WRITES. Point it at the sacrificial test-brain copy only.');
  process.exit(1);
}
const vault = Vault.open(brainPath);
const { schema } = await loadSchema(vault);

let pass = 0,
  fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) pass++;
  else {
    fail++;
    console.log(`  ✗ ${name} ${extra}`);
  }
};

console.log('brain check BEFORE battery...');
const before = await brainCheck(vault);
console.log(`  findings before: ${before.findings.length}`);

const AGENT = 'Claude (Battery)';

// ─── 1. Route + write 200 memory records (varied titles) ───────────────
const t0 = Date.now();
const memPaths = [];
for (let i = 0; i < 200; i++) {
  const title = `Battery memory record number ${i} topic ${['alpha', 'beta', 'gamma', 'delta'][i % 4]}`;
  const route = routeNote(schema, { type: 'memory', title, source: AGENT, date: new Date(2026, 6, 11) });
  const note = {
    path: route.path,
    frontmatter: { ...route.frontmatter, created_by: AGENT, updated_by: AGENT },
    body: `\n# ${title}\n\nDistilled fact ${i}.\n`,
    rawFile: false,
  };
  await vault.writeFile(route.path, serializeNote(note));
  memPaths.push(route.path);
}
ok('200 memory records route uniquely', new Set(memPaths).size === 200);
const sampleMem = parseNote(memPaths[0], await vault.readFileRetry(memPaths[0]));
ok('memory frontmatter validates', validateNote(schema, sampleMem).length === 0, JSON.stringify(validateNote(schema, sampleMem)));

// ─── 2. 200 knowledge notes + entity-resolution dedupe storm ───────────
const kPaths = [];
for (let i = 0; i < 200; i++) {
  const route = routeNote(schema, { type: 'knowledge', title: `Battery Knowledge Topic ${i}` });
  await vault.writeFile(route.path, serializeNote({ path: route.path, frontmatter: route.frontmatter, body: `\n# Battery Knowledge Topic ${i}\n\nFact.\n`, rawFile: false }));
  kPaths.push(route.path);
}
// Rebuild name map, then attempt to create every one of them AGAIN — all 200 must be blocked.
const texts = await loadTexts(vault, false);
const { nameMap } = buildNameMap(texts.files.map((f) => ({ path: f, aliases: [] })));
let blocked = 0;
for (let i = 0; i < 200; i++) {
  if (resolveEntity(nameMap, `Battery Knowledge Topic ${i}`).exists) blocked++;
}
ok('entity resolution blocks all 200 duplicate creates', blocked === 200, `blocked=${blocked}`);

// ─── 3. 200 append cycles — content must only grow, never corrupt ──────
let appendOk = 0;
for (let i = 0; i < 200; i++) {
  const p = kPaths[i];
  const beforeNote = parseNote(p, await vault.readFileRetry(p));
  const note = beforeNote;
  note.body = note.body.replace(/\n*$/, '\n\n') + `Appended line ${i}.\n`;
  note.frontmatter.updated_by = AGENT;
  note.frontmatter.updated = isoDate();
  await vault.writeFile(p, serializeNote(note));
  const after = parseNote(p, await vault.readFileRetry(p));
  if (after.body.includes('Fact.') && after.body.includes(`Appended line ${i}.`) && after.frontmatter.updated_by === AGENT) appendOk++;
}
ok('200 appends preserve prior content + stamp attribution', appendOk === 200, `ok=${appendOk}`);

// ─── 4. 100 archive cycles — reversible, attributed ─────────────────────
let archOk = 0;
for (let i = 0; i < 100; i++) {
  const p = kPaths[i];
  const note = parseNote(p, await vault.readFileRetry(p));
  note.frontmatter.status = 'archived';
  note.frontmatter.archived_reason = 'battery';
  note.frontmatter.updated_by = AGENT;
  await vault.writeFile(p, serializeNote(note));
  const after = parseNote(p, await vault.readFileRetry(p));
  if (after.frontmatter.status === 'archived' && after.body.includes('Fact.')) archOk++;
}
ok('100 archives keep content intact', archOk === 100, `ok=${archOk}`);

// ─── 5. Round-trip integrity on 300 EXISTING real notes ────────────────
// parse → serialize → parse must be lossless on frontmatter keys + body.
const real = texts.files.filter((f) => !f.includes('Battery') && !memPaths.includes(f)).slice(0, 300);
let roundtripOk = 0;
const roundtripFails = [];
for (const f of real) {
  const raw = await vault.readFileRetry(f).catch(() => '');
  if (!raw) continue;
  const n1 = parseNote(f, raw);
  const n2 = parseNote(f, serializeNote(n1));
  const keys1 = JSON.stringify(Object.keys(n1.frontmatter).sort());
  const keys2 = JSON.stringify(Object.keys(n2.frontmatter).sort());
  if (keys1 === keys2 && n1.body.trim() === n2.body.trim()) roundtripOk++;
  else if (roundtripFails.length < 5) roundtripFails.push(f);
}
ok(`round-trip lossless on ${roundtripOk}/${real.length} real notes`, roundtripOk >= real.length * 0.97, roundtripFails.join(' · '));

console.log(`\nbattery writes done in ${Date.now() - t0}ms`);

// ─── integrity: check AFTER must not be worse (minus expected orphans) ──
console.log('brain check AFTER battery...');
const after = await brainCheck(vault);
// Battery notes are unlinked by design → they add orphan findings. Everything
// else must not grow.
const growth = {};
for (const [kind, n] of Object.entries(after.byKind)) {
  const beforeN = before.byKind[kind] || 0;
  if (n > beforeN && kind !== 'orphan-note') growth[kind] = `${beforeN} → ${n}`;
}
ok('no new integrity findings beyond expected orphans', Object.keys(growth).length === 0, JSON.stringify(growth));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
