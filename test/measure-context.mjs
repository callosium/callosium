import { Vault } from '../src/core/vault.ts';
import { loadTexts, recall } from '../src/recall/engine.ts';
import { buildGraph } from '../src/graph/index.ts';
import { promises as fs } from 'node:fs';

const vault = Vault.open(process.argv[2]);
const texts = await loadTexts(vault);
const { index: graph } = await buildGraph(vault);
console.log(`edges: ${graph.edges.length}; unresolved: ${graph.edges.filter(e=>e.unresolved).length}`);

const { scenarios } = JSON.parse(await fs.readFile('test/scenarios.json', 'utf8'));
const sample = scenarios.filter(s => s.tier !== 'negative').filter((_, i) => i % 20 === 0); // 450 queries
let withContext = 0, totalCtx = 0, clarifies = 0;
for (const s of sample) {
  const a = await recall(s.question, texts, graph);
  if (a.found && a.context?.length) { withContext++; totalCtx += a.context.length; }
  if (a.clarify) clarifies++;
}
console.log(`sample=${sample.length}: answers with linked context: ${withContext} (${(withContext/sample.length*100).toFixed(0)}%), avg context size ${(totalCtx/Math.max(withContext,1)).toFixed(1)}, clarifies ${clarifies}`);
