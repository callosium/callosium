// Smoke test: recall against a real brain, READ-ONLY.
//   node test/smoke-recall.mjs "<brain path>" ["question"]

import { Vault } from '../src/core/vault.ts';
import { loadTexts, recall } from '../src/recall/engine.ts';

const brainPath = process.argv[2];
if (!brainPath) {
  console.error('Usage: node test/smoke-recall.mjs "<brain path>" ["question"]');
  process.exit(1);
}

const vault = Vault.open(brainPath);
const t0 = Date.now();
const texts = await loadTexts(vault);
console.log(`Loaded ${texts.files.length} notes in ${Date.now() - t0}ms`);

const questions = process.argv[3]
  ? [process.argv[3]]
  : [
      'which merchant of record did we choose for Callosium and why',
      'what is the gbrain weakness we exploit',
      'what did we decide about quantum blockchain telepathy',
    ];

for (const q of questions) {
  const t1 = Date.now();
  const a = await recall(q, texts);
  console.log(`\nQ: ${q}  (${Date.now() - t1}ms)`);
  if (!a.found) {
    console.log(`  NOT IN BRAIN: ${a.notInBrainReason}`);
    continue;
  }
  for (const r of a.results.slice(0, 2)) {
    console.log(`  ${r.path}  [create-safety: ${r.createSafety}]`);
    console.log(`  matched: ${r.evidence.matchedTerms.map((m) => `${m.term}(${m.where.join(',')})`).join(' ')}`);
    console.log(`  excerpt: ${r.excerpt.slice(0, 150).replace(/\n/g, ' ')}...`);
  }
}
