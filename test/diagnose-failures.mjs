// Forensics: for every failing scenario, find WHERE the target lost —
// stage-2 candidate rank vs final evidence rank — and classify the failure.
//   node test/diagnose-failures.mjs "<brain path>" [scenarios.json]

import { promises as fs } from 'node:fs';
import { Vault } from '../src/core/vault.ts';
import { loadTexts, brainFind, recall } from '../src/recall/engine.ts';
import { loadGraph, buildGraph } from '../src/graph/index.ts';

const brainPath = process.argv[2];
const { scenarios } = JSON.parse(await fs.readFile(process.argv[3] || 'test/scenarios.json', 'utf8'));
const vault = Vault.open(brainPath);
const texts = await loadTexts(vault);
const graph = (await loadGraph(vault)) ?? (await buildGraph(vault)).index;

// adjacency for graph diagnostics
const neighbors = new Map();
for (const e of graph.edges) {
  if (e.unresolved) continue;
  if (!neighbors.has(e.from)) neighbors.set(e.from, new Set());
  if (!neighbors.has(e.to)) neighbors.set(e.to, new Set());
  neighbors.get(e.from).add(e.to);
  neighbors.get(e.to).add(e.from);
}

const classes = {};
const bump = (k) => (classes[k] = (classes[k] || 0) + 1);
let checked = 0;

for (const s of scenarios) {
  if (s.tier === 'negative' || !s.target) continue;
  const a = await recall(s.question, texts, graph);
  const k = s.accept === 'top1' ? 1 : s.accept === 'top3' ? 3 : 5;
  const paths = a.found ? a.results.map((r) => r.path) : [];
  if (paths.slice(0, k).includes(s.target)) continue; // pass — skip
  checked++;

  const r = await brainFind(s.question, texts);
  if ('error' in r) { bump('no-keywords'); continue; }
  const candRank = r.candidates.findIndex((c) => c.file === s.target);
  const winner = paths[0];

  if (!a.found) bump('wrongly-not-in-brain');
  else if (candRank === 0) bump('won-stage2-lost-evidence');           // fusion/coverage problem
  else if (candRank > 0 && candRank < 5) bump('stage2-rank-2-5');       // ordering problem near the top
  else if (candRank === -1 && paths.includes(s.target)) bump('content-fallback-found-it');
  else if (candRank === -1) {
    // never even a stage-2 candidate: filename/path words absent
    const linked = winner && neighbors.get(winner)?.has(s.target);
    bump(linked ? 'missed-but-LINKED-to-winner' : 'missed-entirely');
  }
  if (winner && s.target && winner.split('/').slice(0, -1).join('/') === s.target.split('/').slice(0, -1).join('/'))
    bump('(winner-is-same-folder-sibling)');
  if (winner && neighbors.get(winner)?.has(s.target)) bump('(target-linked-to-winner)');
}

console.log(`diagnosed ${checked} failures`);
for (const [k, v] of Object.entries(classes).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(v).padStart(5)}  ${k}`);
}
