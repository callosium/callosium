import { Vault } from '../src/core/vault.ts';
import { loadTexts, recall } from '../src/recall/engine.ts';
import { buildGraph } from '../src/graph/index.ts';
const vault = Vault.open(process.argv[2]);
const texts = await loadTexts(vault);
const { index: graph } = await buildGraph(vault);
const q = process.argv[3];
const a = await recall(q, texts, graph);
console.log(`Q: ${q}\nfound=${a.found}`);
if (a.clarify) { console.log(`CLARIFY: ${a.clarify.reason}`); for (const o of a.clarify.options) console.log(`  ? ${o.path}`); }
for (const r of (a.results||[]).slice(0,4)) console.log(`  ${r.path} [${r.createSafety}]`);
if (a.context) { console.log('CONTEXT (linked):'); for (const c of a.context.slice(0,8)) console.log(`  ${c.hops}-hop ${c.direction==='out'?'→':'←'} [${c.relation}] ${c.path}`); }
