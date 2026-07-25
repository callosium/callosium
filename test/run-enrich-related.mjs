// Relatedness enrichment: append a "## Related" section of content↔content
// links (Jaccard/Adamic-Adar + TF-IDF lanes, fused) to notes on the
// SACRIFICIAL copy. These are the edges entity-mention linking cannot give.
//   node test/run-enrich-related.mjs "<test-brain path>" [--apply]

import { Vault } from '../src/core/vault.ts';
import { loadTexts, ensureRankIndex } from '../src/recall/engine.ts';
import { buildGraph } from '../src/graph/index.ts';
import { parseNote } from '../src/core/frontmatter.ts';
import { buildRelatedness } from '../src/linking/related.ts';

const brainPath = process.argv[2];
const apply = process.argv.includes('--apply');
if (!brainPath || !brainPath.toLowerCase().includes('test-brain')) {
  console.error('Refusing: writes notes. Sacrificial test-brain only.');
  process.exit(1);
}
const vault = Vault.open(brainPath);
const texts = await loadTexts(vault);
const { index: graph } = await buildGraph(vault);
const rankIndex = ensureRankIndex(texts, graph);

const t0 = Date.now();
const rel = buildRelatedness(rankIndex, 8);
console.error(`relatedness built in ${Date.now() - t0}ms for ${rel.size} notes`);

let touched = 0,
  edges = 0;
const samples = [];
for (const [path, related] of rel) {
  if (/^(System|Templates|Inbox)\//.test(path) || path.includes('.excalidraw') || /\/Raw\//i.test(path)) continue;
  const text = texts.texts.get(path) || '';
  if (/^## Related/m.test(text)) continue; // human already curated one
  const note = parseNote(path, text);
  if (note.rawFile) continue;
  // strong relations only: seen by both lanes, or very high fused score
  const strong = related.filter((r) => r.via === 'both' || r.score > 0.02).slice(0, 4);
  if (strong.length < 2) continue;
  touched++;
  edges += strong.length;
  if (samples.length < 6) samples.push({ path, rel: strong.map((s) => `${s.path.split('/').pop().replace('.md', '')} (${s.via})`) });
  if (apply) {
    const names = strong.map((s) => `[[${s.path.split('/').pop().replace(/\.md$/, '')}]]`);
    const newText = text.replace(/\n*$/, '\n\n') + `## Related\n${names.map((n) => `- ${n}`).join('\n')}\n`;
    await vault.writeFile(path, newText);
  }
}
console.log(`${apply ? 'APPLIED' : 'DRY RUN'}: ${edges} related-edges across ${touched} notes`);
for (const s of samples) {
  console.log(`  ${s.path}`);
  for (const r of s.rel) console.log(`     ~ ${r}`);
}
