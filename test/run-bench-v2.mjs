// CallosiumBench v2 grader — multi-factor report card.
//   node test/run-bench-v2.mjs "<brain path>" [scenarios-v2.json]

import { promises as fs } from 'node:fs';
import { Vault } from '../src/core/vault.ts';
import { loadTexts, recall } from '../src/recall/engine.ts';
import { buildGraph } from '../src/graph/index.ts';
import { loadEmbeddings } from '../src/recall/semantic.ts';

// WP_DETAILS=<path> dumps per-scenario {id,family,lang,pass,top5} so two runs can
// be diffed scenario-by-scenario for regressions.
const wpDetails = [];

const brainPath = process.argv[2];
const { scenarios } = JSON.parse(await fs.readFile(process.argv[3] || 'test/scenarios-v2.json', 'utf8'));
const vault = Vault.open(brainPath);
const texts = await loadTexts(vault);
const { index: graph } = await buildGraph(vault);
const emb = await loadEmbeddings(vault);
console.error(emb ? `embeddings: ${emb.chunks.length} chunks loaded` : 'embeddings: NONE (semantic lane off)');
// true neighbors for context-usefulness
const nb = new Map();
for (const e of graph.edges) {
  if (e.unresolved) continue;
  if (!nb.has(e.from)) nb.set(e.from, new Set());
  if (!nb.has(e.to)) nb.set(e.to, new Set());
  nb.get(e.from).add(e.to);
  nb.get(e.to).add(e.from);
}
console.error(`running ${scenarios.length} scenarios...`);

const fam = {};
const latencies = [];
let ctxProbes = 0,
  ctxUseful = 0;
let richTotal = 0,
  richFired = 0;
const richCov = [];
let done = 0;
for (const s of scenarios) {
  const t1 = Date.now();
  const a = await recall(s.question, texts, graph, false, emb);
  latencies.push(Date.now() - t1);
  const key = s.lang ? `${s.family}:${s.lang}` : s.family;
  const F = (fam[key] ??= { total: 0, pass: 0, clarifyFired: 0, corrected: 0 });
  fam[s.family] ??= { total: 0, pass: 0, clarifyFired: 0, corrected: 0, fails: [] };
  if (key !== s.family) { fam[s.family].total++; }
  F.total++;
  if (a.clarify) { F.clarifyFired++; if (key !== s.family) fam[s.family].clarifyFired = (fam[s.family].clarifyFired || 0) + 1; }
  if (a.corrections?.length) { F.corrected++; if (key !== s.family) fam[s.family].corrected = (fam[s.family].corrected || 0) + 1; }
  const paths = a.found ? a.results.map((r) => r.path) : [];

  let pass = false;
  if (s.accept === 'not-in-brain') pass = !a.found;
  else if (s.accept === 'top1-noclarify') pass = paths[0] === s.target && !a.clarify;
  else if (s.accept === 'both-top5') pass = paths.slice(0, 5).includes(s.target) && paths.slice(0, 5).includes(s.target2);
  else if (s.accept === 'clarify-or-multi') {
    const grpHits = (s.group ?? []).filter((g) => paths.slice(0, 5).includes(g)).length;
    pass = !!a.clarify || grpHits >= 2;
  } else if (s.accept === 'recent-group') {
    // temporal: ANY recent note matching the key is an honest "latest on X"
    // answer — the old single-target oracle keyed several answers on one
    // query string, which a deterministic engine can never satisfy.
    pass = paths.slice(0, 5).some((p) => (s.group ?? [s.target]).includes(p));
  } else if (s.accept === 'cluster') {
    // context richness: anchor must rank top-3 AND ≥60% of its expected
    // cluster must be on the table (results ∪ context pointers) — a build
    // task equipped with less than that is "snippets", a fail by principle.
    const surface = new Set([...paths, ...(a.context ?? []).map((c) => c.path)]);
    const cov = (s.cluster ?? []).filter((p) => surface.has(p)).length / Math.max((s.cluster ?? []).length, 1);
    // require richness to have FIRED — else baseline single-seed context could
    // pass the family and mask a build-intent-detection regression
    pass = !!a.richness && paths.slice(0, 3).includes(s.target) && cov >= 0.6;
    richCov.push(cov);
    if (a.richness) richFired++;
    richTotal++;
  } else if (s.accept === 'paraphrase') {
    // The mirror of the negative family: the brain HAS this, asked in words it
    // never used. Passing means answering with the note the literal wording
    // returns. An honest-sounding refusal is the failure mode being measured, so
    // it is counted on its own — a family that "fails" by ranking a sibling note
    // is a different (much smaller) problem than one that refuses outright.
    pass = a.found && paths.slice(0, 5).includes(s.target);
    if (!a.found) {
      F.refused = (F.refused ?? 0) + 1;
      if (key !== s.family) fam[s.family].refused = (fam[s.family].refused ?? 0) + 1;
    }
  } else if (s.accept === 'top1' || s.accept === 'top3' || s.accept === 'top5') {
    const k = s.accept === 'top1' ? 1 : s.accept === 'top3' ? 3 : 5;
    pass = paths.slice(0, k).includes(s.target);
  } else {
    throw new Error(`unknown accept rule: ${JSON.stringify(s.accept)} (scenario ${s.id})`);
  }
  if (pass) { F.pass++; if (s.lang && `${s.family}:${s.lang}` !== s.family) fam[s.family].pass++; }
  else {
    (F.fails ??= []);
    if (F.fails.length < 150) F.fails.push({ id: s.id, family: s.family, q: s.question, expected: s.target, got: a.found ? a.results.slice(0, 3).map((r) => r.path) : 'NOT-IN-BRAIN' });
  }

  if (process.env.WP_DETAILS) wpDetails.push({ id: s.id, family: s.family, lang: s.lang, accept: s.accept, pass, top5: paths.slice(0, 5) });

  // context-usefulness: when target found top-1, does context carry a true neighbor?
  if ((s.family === 'known' || s.family === 'content') && paths[0] === s.target && a.context?.length) {
    ctxProbes++;
    const truth = nb.get(s.target);
    if (truth && a.context.some((c) => truth.has(c.path))) ctxUseful++;
  }
  if (++done % 1000 === 0) console.error(`  ${done}...`);
}

latencies.sort((a, b) => a - b);
const pct = (p) => latencies[Math.floor((latencies.length * p) / 100)];
const rate = (f) => ((f.pass / f.total) * 100).toFixed(1);

console.log('\n════════ CALLOSIUMBENCH v2 REPORT CARD ════════');
console.log(`Brain: ${brainPath} · ${scenarios.length} scenarios`);
console.log(`\n— DIMENSIONS —`);
// Every line is guarded: a partial scenario set (one family alone, e.g. the
// paraphrase file during a threshold calibration) must still print a report
// instead of crashing on a family it doesn't contain.
if (fam.known) console.log(`Recall (known-item conversational):      ${rate(fam.known)}%   (top-3)`);
if (fam.content) console.log(`Deep recall (rare body words):           ${rate(fam.content)}%   (top-3)`);
if (fam.typo && fam.known) console.log(`Typo tolerance (1 mangled entity token): ${rate(fam.typo)}%   → retention ${((fam.typo.pass / fam.typo.total) / (fam.known.pass / fam.known.total) * 100).toFixed(0)}% of clean performance (corrections applied on ${fam.typo.corrected})`);
if (fam.temporal) console.log(`Temporal tolerance (recency phrasing):   ${rate(fam.temporal)}%   (top-5, recent-note targets)`);
if (fam.compare) console.log(`Multi-target (comparisons, BOTH found):  ${rate(fam.compare)}%   (both in top-5)`);
if (fam.ambiguous && fam.clean) console.log(`Clarify precision:                       fires on ${((fam.ambiguous.clarifyFired / fam.ambiguous.total) * 100).toFixed(0)}% of ambiguous (want high) vs ${((fam.clean.clarifyFired / fam.clean.total) * 100).toFixed(0)}% of clean (want ~0)`);
if (fam.ambiguous) console.log(`Ambiguity handling (clarify or ≥2 sibs): ${rate(fam.ambiguous)}%`);
if (fam.clean) console.log(`Exact-title precision (no clarify):       ${rate(fam.clean)}%   (top-1)`);
if (fam.negative) console.log(`Honesty (invented entities refused):     ${rate(fam.negative)}%`);
// The honesty gate's other half: refusing a nonsense entity is only a virtue if
// the same gate still ANSWERS a real note asked in words the vault never used.
// Read this line together with the one above — one moving without the other is
// the trade being made, and the pair is the whole point of the family.
if (fam.paraphrase) console.log(`Paraphrase recall (absent synonym):       ${rate(fam.paraphrase)}%   (top-5) · falsely refused ${((fam.paraphrase.refused ?? 0) / fam.paraphrase.total * 100).toFixed(1)}%`);
console.log(`Context usefulness (true neighbor rides along): ${ctxProbes ? ((ctxUseful / ctxProbes) * 100).toFixed(0) : '—'}% of ${ctxProbes} probes`);
if (richTotal) {
  const avgCov = richCov.reduce((a, b) => a + b, 0) / richCov.length;
  console.log(`Context richness: avg cluster coverage ${(avgCov * 100).toFixed(1)}%, rich-intent detected on ${((richFired / richTotal) * 100).toFixed(0)}% of ${richTotal} build queries`);
}
console.log(`Latency: p50=${pct(50)}ms p90=${pct(90)}ms p99=${pct(99)}ms`);
await fs.writeFile('test/v2-failures.json', JSON.stringify(Object.values(fam).flatMap((f) => f.fails ?? []), null, 1));
console.log('\n— PER LANGUAGE —');
for (const [k, f] of Object.entries(fam).filter(([k]) => k.includes(':'))) {
  console.log(`${k.padEnd(16)} ${((f.pass / f.total) * 100).toFixed(1)}%  (${f.pass}/${f.total})`);
}
const totPass = Object.entries(fam).filter(([k]) => k.includes(':')).reduce((a, [, f]) => a + f.pass, 0) || Object.values(fam).reduce((a, f) => a + f.pass, 0);
console.log(`\nOVERALL: ${totPass}/${scenarios.length} = ${((totPass / scenarios.length) * 100).toFixed(1)}%`);
if (process.env.WP_DETAILS) { await fs.writeFile(process.env.WP_DETAILS, JSON.stringify(wpDetails)); console.error(`wrote ${wpDetails.length} per-scenario details to ${process.env.WP_DETAILS}`); }
