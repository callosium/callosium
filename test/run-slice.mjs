// Minimal family-agnostic grader for A/B slices (the v2 report card assumes
// all families present). Prints per-family pass rates only.
//   node test/run-slice.mjs "<brain path>" <scenarios.json>
import { promises as fs } from 'node:fs';
import { Vault } from '../src/core/vault.ts';
import { loadTexts, recall } from '../src/recall/engine.ts';
import { buildGraph } from '../src/graph/index.ts';
import { loadEmbeddings } from '../src/recall/semantic.ts';

const brainPath = process.argv[2];
const { scenarios } = JSON.parse(await fs.readFile(process.argv[3], 'utf8'));
const vault = Vault.open(brainPath);
const texts = await loadTexts(vault);
const { index: graph } = await buildGraph(vault);
const emb = await loadEmbeddings(vault);
const fam = {};
for (const s of scenarios) {
  const a = await recall(s.question, texts, graph, false, emb);
  const F = (fam[`${s.family}:${s.lang ?? '?'}`] ??= { total: 0, pass: 0 });
  F.total++;
  const paths = a.found ? a.results.map((r) => r.path) : [];
  let pass = false;
  if (s.accept === 'not-in-brain') pass = !a.found;
  else if (s.accept === 'top1-noclarify') pass = paths[0] === s.target && !a.clarify;
  else if (s.accept === 'both-top5') pass = paths.slice(0, 5).includes(s.target) && paths.slice(0, 5).includes(s.target2);
  else if (s.accept === 'clarify-or-multi') pass = !!a.clarify || (s.group ?? []).filter((g) => paths.slice(0, 5).includes(g)).length >= 2;
  else if (s.accept === 'recent-group') pass = paths.slice(0, 5).some((p) => (s.group ?? [s.target]).includes(p));
  else if (s.accept === 'cluster') { const surface = new Set([...paths, ...(a.context ?? []).map((c) => c.path)]); pass = !!a.richness && paths.slice(0, 3).includes(s.target) && (s.cluster ?? []).filter((p) => surface.has(p)).length / Math.max((s.cluster ?? []).length, 1) >= 0.6; }
  else { const k = s.accept === 'top1' ? 1 : s.accept === 'top3' ? 3 : 5; pass = paths.slice(0, k).includes(s.target); }
  if (pass) F.pass++;
}
for (const [k, F] of Object.entries(fam).sort()) console.log(`${k.padEnd(14)} ${((F.pass / F.total) * 100).toFixed(1)}%  (${F.pass}/${F.total})`);
