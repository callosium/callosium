// CallosiumBench CASUAL grader — English casual/temporal/recall report card,
// with a RANK distribution (the "how much does it weigh" angle: not just pass,
// but WHERE the right note lands) and a temporal-freshness check.
//   node test/run-bench-casual.mjs "<brain path>" [scenarios-casual.json]

import { promises as fs } from 'node:fs';
import { Vault } from '../src/core/vault.ts';
import { loadTexts, recall } from '../src/recall/engine.ts';
import { buildGraph } from '../src/graph/index.ts';
import { loadEmbeddings } from '../src/recall/semantic.ts';

const brainPath = process.argv[2];
const { scenarios } = JSON.parse(await fs.readFile(process.argv[3] || 'test/scenarios-casual.json', 'utf8'));
const vault = Vault.open(brainPath);
const texts = await loadTexts(vault);
const { index: graph } = await buildGraph(vault);
const emb = await loadEmbeddings(vault);
console.error(emb ? `embeddings: ${emb.chunks.length} chunks` : 'embeddings: NONE (semantic off)');
console.error(`running ${scenarios.length} scenarios...`);

const fam = {};
const latencies = [];
let done = 0;
// temporal-weight: did the freshest matching note actually rank #1?
let tempTotal = 0, tempFreshestTop1 = 0, tempAnyTop5 = 0;
// excerpt size stats (the richness "weight" question) by family
const excerptLens = {};

for (const s of scenarios) {
  const t1 = Date.now();
  const a = await recall(s.question, texts, graph, false, emb);
  latencies.push(Date.now() - t1);
  const F = (fam[s.family] ??= { total: 0, pass: 0, rankHist: [0, 0, 0, 0, 0, 0], notFound: 0, fails: [] });
  F.total++;
  const paths = a.found ? a.results.map((r) => r.path) : [];

  // rank of the (primary) target
  let rank = 0;
  if (s.target) { const i = paths.indexOf(s.target); rank = i >= 0 ? i + 1 : 0; }

  let pass = false;
  if (s.accept === 'not-in-brain') pass = !a.found;
  else if (s.accept === 'top1-noclarify') pass = paths[0] === s.target && !a.clarify;
  else if (s.accept === 'recent-group') {
    pass = paths.slice(0, 5).some((p) => (s.group ?? [s.target]).includes(p));
    tempTotal++;
    if (pass) tempAnyTop5++;
    // freshness weight: is the freshest matching note (s.target) ranked #1?
    if (paths[0] === s.target) tempFreshestTop1++;
    // record rank of the freshest note specifically
    const fi = paths.indexOf(s.target); rank = fi >= 0 ? fi + 1 : 0;
  } else if (s.accept === 'top3') pass = paths.slice(0, 3).includes(s.target);
  else if (s.accept === 'top5') pass = paths.slice(0, 5).includes(s.target);
  else if (s.accept === 'top1') pass = paths[0] === s.target;
  else throw new Error(`unknown accept ${s.accept} (scenario ${s.id})`);

  if (pass) F.pass++;
  // rank histogram buckets: [top1, top2-3, top4-5, top6-20, notInResults(found), notFound]
  if (s.accept !== 'not-in-brain') {
    if (rank === 1) F.rankHist[0]++;
    else if (rank <= 3 && rank) F.rankHist[1]++;
    else if (rank <= 5 && rank) F.rankHist[2]++;
    else if (rank && rank <= 20) F.rankHist[3]++;
    else if (a.found) F.rankHist[4]++;
    else { F.rankHist[5]++; F.notFound++; }
  }

  // excerpt length (the "weight" / richness signal)
  if (a.found && a.results[0]) {
    (excerptLens[s.family] ??= []).push(a.results[0].excerpt.length + (a.results[0].moreChunks ?? []).reduce((x, m) => x + m.excerpt.length, 0));
  }

  if (!pass && F.fails.length < 120) {
    F.fails.push({ id: s.id, q: s.question, expected: s.target, rank, got: a.found ? a.results.slice(0, 3).map((r) => r.path) : 'NOT-IN-BRAIN' });
  }
  if (++done % 1000 === 0) console.error(`  ${done}/${scenarios.length}`);
}

latencies.sort((a, b) => a - b);
const pct = (p) => latencies[Math.floor((latencies.length * p) / 100)];
const rate = (f) => f ? ((f.pass / f.total) * 100).toFixed(1) : '—';
const avg = (arr) => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0;
const median = (arr) => { if (!arr.length) return 0; const s = arr.slice().sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

console.log('\n════════ CALLOSIUMBENCH CASUAL — REPORT CARD ════════');
console.log(`Brain: ${brainPath} · ${scenarios.length} scenarios (English, casual/temporal/recall-weighted)\n`);
console.log('Family            pass%    │ rank1  t2-3  t4-5  t6-20  miss  notFound');
for (const [k, f] of Object.entries(fam)) {
  const h = f.rankHist;
  const p = (n) => String(Math.round((n / f.total) * 100)).padStart(4);
  if (k === 'negative') { console.log(`${k.padEnd(16)} ${rate(f).padStart(6)}%  │ (honesty: refused ${f.pass}/${f.total})`); continue; }
  console.log(`${k.padEnd(16)} ${rate(f).padStart(6)}%  │ ${p(h[0])}% ${p(h[1])}% ${p(h[2])}% ${p(h[3])}%  ${p(h[4])}% ${p(h[5])}%`);
}
console.log(`\n— TEMPORAL WEIGHT —`);
console.log(`  freshest matching note ranked #1: ${tempTotal ? ((tempFreshestTop1 / tempTotal) * 100).toFixed(1) : '—'}%  (${tempFreshestTop1}/${tempTotal})`);
console.log(`  any matching recent note in top-5: ${tempTotal ? ((tempAnyTop5 / tempTotal) * 100).toFixed(1) : '—'}%`);
console.log(`\n— EXCERPT WEIGHT (chars returned for top result) —`);
for (const [k, arr] of Object.entries(excerptLens)) console.log(`  ${k.padEnd(12)} median ${String(median(arr)).padStart(5)}  avg ${String(avg(arr)).padStart(5)}  max ${Math.max(...arr)}`);
console.log(`\nLatency: p50=${pct(50)}ms p90=${pct(90)}ms p99=${pct(99)}ms`);

const overall = Object.entries(fam).filter(([k]) => k !== 'negative').reduce((a, [, f]) => ({ pass: a.pass + f.pass, total: a.total + f.total }), { pass: 0, total: 0 });
console.log(`\nOVERALL (excl. honesty): ${((overall.pass / overall.total) * 100).toFixed(1)}%  (${overall.pass}/${overall.total})`);
await fs.writeFile('test/casual-failures.json', JSON.stringify(Object.fromEntries(Object.entries(fam).map(([k, f]) => [k, f.fails])), null, 1));
console.error('failures → test/casual-failures.json');
