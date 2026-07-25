// Smoke test: graph build against a real brain, READ-ONLY on the brain
// (index writes go to ~/.callosium/cache/).
//   node test/smoke-graph.mjs "<brain path>" ["note path"]

import { Vault } from '../src/core/vault.ts';
import { buildGraph, related } from '../src/graph/index.ts';

const vault = Vault.open(process.argv[2]);
const t0 = Date.now();
const { index, collisions, extracted, reused } = await buildGraph(vault);
console.log(
  `Graph: ${index.edges.length} edges from ${Object.keys(index.noteHashes).length} notes in ${Date.now() - t0}ms (${extracted} extracted, ${reused} reused)`,
);
const unresolved = index.edges.filter((e) => e.unresolved);
console.log(`Unresolved links: ${unresolved.length}; alias collisions: ${collisions.length}`);

const byType = new Map();
for (const e of index.edges) byType.set(e.type, (byType.get(e.type) || 0) + 1);
console.log('Edge types:', [...byType.entries()].map(([t, n]) => `${t}=${n}`).join(' '));

const probe = process.argv[3] ?? 'Ventures/Brain MCP Product.md';
const rel = related(index, probe);
console.log(`\nRelated to ${probe}: ${rel.length} edges`);
for (const r of rel.slice(0, 12)) console.log(`  ${r.direction === 'out' ? '→' : '←'} [${r.type}] ${r.other}`);
