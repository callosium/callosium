// Gold eval: the owner's real questions against the engine. A question passes when
// any accepted path (or prefix, for agentic questions) appears in the top-5
// results OR the linked context. Prints everything — small set, human-readable.
//   node test/run-gold.mjs "<brain path>"

import { promises as fs } from 'node:fs';
import { Vault } from '../src/core/vault.ts';
import { loadTexts, recall } from '../src/recall/engine.ts';
import { buildGraph } from '../src/graph/index.ts';

const vault = Vault.open(process.argv[2]);
const texts = await loadTexts(vault);
const { index: graph } = await buildGraph(vault);
const { questions } = JSON.parse(await fs.readFile('test/gold/questions.json', 'utf8'));

let pass = 0;
for (const g of questions) {
  const a = await recall(g.q, texts, graph);
  const resultPaths = a.found ? a.results.map((r) => r.path) : [];
  const ctxPaths = (a.context ?? []).map((c) => c.path);
  const hitIn = (paths) => g.accept.some((acc) => paths.some((p) => p === acc || p.startsWith(acc + '/')));
  const inResults = hitIn(resultPaths);
  const inContext = hitIn(ctxPaths);
  const ok = inResults || inContext;
  if (ok) pass++;
  console.log(`\nQ${g.id} [${g.kind}] ${ok ? (inResults ? 'PASS' : 'PASS(ctx)') : 'FAIL'} — ${g.q.slice(0, 80)}`);
  if (g.quirk) console.log(`   quirk: ${g.quirk}`);
  if (!a.found) console.log(`   NOT-IN-BRAIN: ${a.notInBrainReason?.slice(0, 90)}`);
  for (const p of resultPaths.slice(0, 3)) console.log(`   ${g.accept.some((x) => p === x || p.startsWith(x + '/')) ? '✓' : ' '} ${p}`);
  if (a.clarify) console.log(`   clarify: ${a.clarify.options.length} options`);
}
console.log(`\nGOLD: ${pass}/${questions.length} pass`);
