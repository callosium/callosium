// Run the generated scenarios against the recall engine and report per-tier
// accuracy + latency. Read-only on the brain.
//   node test/run-stress.mjs "<brain path>" [scenarios.json]

import { promises as fs } from 'node:fs';
import { Vault } from '../src/core/vault.ts';
import { loadTexts, recall } from '../src/recall/engine.ts';
import { buildGraph } from '../src/graph/index.ts';

const brainPath = process.argv[2];
const scenariosPath = process.argv[3] || 'test/scenarios.json';

const { scenarios } = JSON.parse(await fs.readFile(scenariosPath, 'utf8'));
const vault = Vault.open(brainPath);
const t0 = Date.now();
const texts = await loadTexts(vault);
const { index: graph } = await buildGraph(vault);
console.error(`Loaded ${texts.files.length} notes in ${Date.now() - t0}ms; running ${scenarios.length} scenarios...`);

const tiers = {};
const latencies = [];
const failures = [];

let done = 0;
for (const s of scenarios) {
  const t1 = Date.now();
  const a = await recall(s.question, texts, graph);
  latencies.push(Date.now() - t1);

  const tier = (tiers[s.tier] ??= { total: 0, pass: 0, top1: 0, anyHit: 0 });
  tier.total++;

  let pass = false;
  if (s.accept === 'not-in-brain') {
    pass = !a.found;
  } else if (a.found) {
    const paths = a.results.map((r) => r.path);
    const top1 = paths[0] === s.target;
    const top3 = paths.slice(0, 3).includes(s.target);
    const top5 = paths.slice(0, 5).includes(s.target);
    const folder = s.target.includes('/') ? s.target.slice(0, s.target.lastIndexOf('/') + 1) : '';
    const folderHit = folder && paths.slice(0, 5).some((p) => p.startsWith(folder));
    if (top1) tier.top1++;
    if (paths.includes(s.target)) tier.anyHit++;
    pass =
      s.accept === 'top1' ? top1 :
      s.accept === 'top3' ? top3 :
      s.accept === 'top5-or-folder' ? top5 || folderHit :
      false;
  }
  tier.failCount = (tier.failCount || 0) + (pass ? 0 : 1);
  if (pass) tier.pass++;
  else if (tier.failCount <= 100) {
    failures.push({
      tier: s.tier,
      q: s.question,
      expected: s.target,
      got: a.found ? a.results.slice(0, 3).map((r) => r.path) : `NOT-IN-BRAIN: ${a.notInBrainReason?.slice(0, 80)}`,
    });
  }
  if (++done % 1000 === 0) console.error(`  ${done}/${scenarios.length}...`);
}

latencies.sort((a, b) => a - b);
const pct = (p) => latencies[Math.floor((latencies.length * p) / 100)];

console.log('\n════════ STRESS TEST REPORT ════════');
console.log(`Brain: ${brainPath}`);
console.log(`Scenarios: ${scenarios.length} · total wall time ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`Latency: p50=${pct(50)}ms p90=${pct(90)}ms p99=${pct(99)}ms max=${latencies.at(-1)}ms`);
console.log('\nTier            pass      rate   (top1 rate / any-hit rate)');
for (const [name, s] of Object.entries(tiers)) {
  const rate = ((s.pass / s.total) * 100).toFixed(1);
  const t1r = ((s.top1 / s.total) * 100).toFixed(1);
  const ahr = ((s.anyHit / s.total) * 100).toFixed(1);
  console.log(`${name.padEnd(12)} ${String(s.pass).padStart(6)}/${s.total}   ${rate.padStart(5)}%   (${t1r}% / ${ahr}%)`);
}
const totalPass = Object.values(tiers).reduce((a, s) => a + s.pass, 0);
console.log(`\nOVERALL: ${totalPass}/${scenarios.length} = ${((totalPass / scenarios.length) * 100).toFixed(1)}%`);

await fs.writeFile('test/stress-failures.json', JSON.stringify(failures, null, 2));
console.log(`\nFirst ${failures.length} failures saved to test/stress-failures.json`);
