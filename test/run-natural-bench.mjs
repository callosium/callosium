// Natural-question benchmark grader. The HONEST metric: a positive passes only
// if the answer STRING is actually delivered in recall()'s returned excerpts —
// not merely that the target note ranked. Negatives pass on refusal.
//   node test/run-natural-bench.mjs "<brain>" [dataset.json] [out.json]
import { promises as fs } from 'node:fs';
import { Vault } from '../src/core/vault.ts';
import { loadTexts, recall } from '../src/recall/engine.ts';
import { buildGraph } from '../src/graph/index.ts';
import { loadEmbeddings } from '../src/recall/semantic.ts';

const brain = process.argv[2];
const dsPath = process.argv[3] || 'test/gold/natural-bench.json';
const outPath = process.argv[4] || 'test/gold/natural-bench-results.json';
const { questions } = JSON.parse(await fs.readFile(dsPath, 'utf8'));

const vault = Vault.open(brain);
const texts = await loadTexts(vault);
const { index: graph } = await buildGraph(vault);
const emb = await loadEmbeddings(vault);
console.error(emb ? `embeddings: ${emb.chunks.length} chunks` : 'embeddings: NONE');

const norm = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
// returned bytes = every excerpt + moreChunks the answer surfaced
const returnedText = (a) => !a.found ? '' : a.results.map((r) =>
  (r.excerpt || '') + ' ' + (r.moreChunks || []).map((m) => m.excerpt).join(' ')).join(' \n ');

const fam = {};
const details = [];
for (const q of questions) {
  const t1 = Date.now();
  const a = await recall(q.question, texts, graph, false, emb);
  const ms = Date.now() - t1;
  let pass, noteRank = 0, factDelivered = false;
  if (q.negative) {
    pass = !a.found;
  } else {
    const paths = a.found ? a.results.map((r) => r.path) : [];
    noteRank = paths.indexOf(q.targetNote) + 1;
    factDelivered = norm(returnedText(a)).includes(norm(q.answerSubstring));
    pass = factDelivered; // the metric that matters: was the answer actually delivered
  }
  const F = (fam[q.family || (q.negative ? 'negative' : '?')] ??= { total: 0, pass: 0, noteTop3: 0 });
  F.total++; if (pass) F.pass++; if (!q.negative && noteRank >= 1 && noteRank <= 3) F.noteTop3++;
  details.push({ question: q.question, family: q.family, negative: !!q.negative, targetNote: q.targetNote,
    answerSubstring: q.answerSubstring, pass, noteRank, factDelivered, found: a.found, clarify: !!a.clarify, ms,
    top3: a.found ? a.results.slice(0, 3).map((r) => r.path) : [] });
}

const pos = details.filter((d) => !d.negative), neg = details.filter((d) => d.negative);
const summary = {
  total: details.length,
  factDelivery: pos.length ? +(100 * pos.filter((d) => d.pass).length / pos.length).toFixed(1) : 0,
  noteInTop3: pos.length ? +(100 * pos.filter((d) => d.noteRank >= 1 && d.noteRank <= 3).length / pos.length).toFixed(1) : 0,
  negativesRefused: neg.length ? +(100 * neg.filter((d) => d.pass).length / neg.length).toFixed(1) : 0,
  families: Object.fromEntries(Object.entries(fam).map(([k, v]) => [k, { ...v, pct: +(100 * v.pass / v.total).toFixed(1) }])),
  medianMs: details.map((d) => d.ms).sort((a, b) => a - b)[Math.floor(details.length / 2)],
  positives: pos.length, negatives: neg.length,
};
await fs.writeFile(outPath, JSON.stringify({ summary, details }, null, 1));
console.log(JSON.stringify(summary, null, 2));
