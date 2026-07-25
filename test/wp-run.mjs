// White-paper Phase 2 runner: run Callosium recall over the FRESH human-style set
// and capture everything the paper needs — retrieval rank, honest string-delivery,
// the returned context (for the Sonnet judge pass), latency, and the char sizes
// (for the token-savings arm). OUTPUT contains real PII → writes to gitignored
// test/gold/. Run:  node test/wp-run.mjs "<brain>"
import { promises as fs } from 'node:fs';
import { Vault } from '../src/core/vault.ts';
import { loadTexts, recall, relationshipHonesty } from '../src/recall/engine.ts';
import { buildGraph } from '../src/graph/index.ts';
import { loadEmbeddings } from '../src/recall/semantic.ts';

const brain = process.argv[2] || process.env.CALLOSIUM_BRAIN;
const { questions } = JSON.parse(await fs.readFile('test/gold/wp-fresh-set.json', 'utf8'));

const vault = Vault.open(brain);
const texts = await loadTexts(vault);
const { index: graph } = await buildGraph(vault);
const emb = await loadEmbeddings(vault);
console.error(`vault: ${texts.files.length} notes · embeddings: ${emb ? emb.chunks.length + ' chunks' : 'NONE'}`);

const norm = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const returnedText = (a) => !a.found ? '' : a.results.map((r) =>
  (r.excerpt || '') + ' ' + (r.moreChunks || []).map((m) => m.excerpt).join(' ')).join(' \n ');

const fam = {};
const details = [];
for (const q of questions) {
  const isNeg = q.category === 'negative';
  const t1 = Date.now();
  // Apply the honesty gates exactly as the MCP server does (M4 role + M8 attribute).
  const a = relationshipHonesty(q.q, await recall(q.q, texts, graph, false, emb), texts);
  const ms = Date.now() - t1;
  const paths = a.found ? a.results.map((r) => r.path) : [];
  const gold = q.goldNotePaths || [];
  const noteRank = gold.length ? Math.min(...gold.map((g) => { const i = paths.indexOf(g); return i < 0 ? 999 : i + 1; })) : 999;
  const ctx = returnedText(a);
  const stringDelivered = !isNeg && norm(ctx).includes(norm(q.expectedAnswer));
  const pass = isNeg ? !a.found : stringDelivered;
  const F = (fam[q.category] ??= { total: 0, strDeliv: 0, noteTop3: 0, refused: 0 });
  F.total++;
  if (isNeg) { if (!a.found) F.refused++; }
  else { if (stringDelivered) F.strDeliv++; if (noteRank <= 3) F.noteTop3++; }
  details.push({
    q: q.q, category: q.category, difficulty: q.difficulty, gold, expectedAnswer: q.expectedAnswer,
    found: a.found, refused: isNeg ? !a.found : null, noteRank: noteRank === 999 ? 0 : noteRank,
    stringDelivered, pass, ms,
    returnedChars: ctx.length, returnedText: ctx.slice(0, 20000), // full context for the judge (~5k tokens covers p90)
    top5: paths.slice(0, 5), notInBrainReason: a.notInBrainReason || null,
  });
}

const pos = details.filter((d) => d.category !== 'negative');
const neg = details.filter((d) => d.category === 'negative');
const summary = {
  total: details.length, positives: pos.length, negatives: neg.length,
  stringDeliveryPct: pos.length ? +(100 * pos.filter((d) => d.stringDelivered).length / pos.length).toFixed(1) : 0,
  noteInTop3Pct: pos.length ? +(100 * pos.filter((d) => d.noteRank >= 1 && d.noteRank <= 3).length / pos.length).toFixed(1) : 0,
  negativesRefusedPct: neg.length ? +(100 * neg.filter((d) => d.refused).length / neg.length).toFixed(1) : 0,
  medianMs: [...details.map((d) => d.ms)].sort((a, b) => a - b)[Math.floor(details.length / 2)],
  byCategory: Object.fromEntries(Object.entries(fam).map(([k, v]) => [k, {
    total: v.total,
    ...(k === 'negative' ? { refusedPct: +(100 * v.refused / v.total).toFixed(1) } : { stringDeliveryPct: +(100 * v.strDeliv / v.total).toFixed(1), noteTop3Pct: +(100 * v.noteTop3 / v.total).toFixed(1) }),
  }])),
};
await fs.writeFile('test/gold/wp-results.json', JSON.stringify({ summary, details }, null, 1));
console.log(JSON.stringify(summary, null, 2));
