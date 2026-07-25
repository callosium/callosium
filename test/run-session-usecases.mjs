// Session-derived use-case grader (16 Jul goal): runs the questions extrapolated
// from the owner's real session inputs against the LIVE brain and grades honestly.
// Pass = an expected note in the top-3 (negatives pass on refusal). Emits a full
// JSON report (top-5 + excerpt heads) so agent judges can audit every failure.
//   node test/run-session-usecases.mjs "<brain path>" [dataset.json] [out.json]
import { promises as fs } from 'node:fs';
import { Vault } from '../src/core/vault.ts';
import { loadTexts, recall } from '../src/recall/engine.ts';
import { buildGraph } from '../src/graph/index.ts';
import { loadEmbeddings } from '../src/recall/semantic.ts';

const brainPath = process.argv[2];
const { scenarios } = JSON.parse(await fs.readFile(process.argv[3] || 'test/gold/session-usecases-16jul.json', 'utf8'));
const outPath = process.argv[4] || 'test/gold/session-usecases-16jul-results.json';

const vault = Vault.open(brainPath);
const texts = await loadTexts(vault);
const { index: graph } = await buildGraph(vault);
const emb = await loadEmbeddings(vault);
console.error(emb ? `embeddings: ${emb.chunks.length} chunks` : 'embeddings: NONE (semantic off)');

const fam = {};
const details = [];
for (const s of scenarios) {
  const t1 = Date.now();
  const a = await recall(s.question, texts, graph, false, emb);
  const ms = Date.now() - t1;
  const paths = a.found ? a.results.map((r) => r.path) : [];
  const low = paths.map((p) => p.toLowerCase());
  let pass, rank = 0;
  if (s.negative) {
    pass = !a.found || paths.length === 0;
  } else {
    rank = low.findIndex((p) => s.expect.some((e) => p.includes(e))) + 1;
    pass = rank >= 1 && rank <= 3;
  }
  const F = (fam[s.family] ??= { total: 0, pass: 0 });
  F.total++; if (pass) F.pass++;
  details.push({
    id: s.id, family: s.family, question: s.question, pass, rank, ms,
    expect: s.expect || null, negative: !!s.negative, found: a.found, clarify: !!a.clarify,
    top5: paths.slice(0, 5),
    excerptHead: a.found && a.results[0] ? String(a.results[0].sections?.[0]?.text ?? a.results[0].excerpt ?? '').slice(0, 280) : null,
  });
  console.error(`${pass ? 'PASS' : 'FAIL'} [#${s.id} ${s.family}] rank=${rank} ${s.question.slice(0, 60)}`);
}

const total = details.length, passed = details.filter((d) => d.pass).length;
const summary = {
  total, passed, pct: +(100 * passed / total).toFixed(1),
  families: Object.fromEntries(Object.entries(fam).map(([k, v]) => [k, { ...v, pct: +(100 * v.pass / v.total).toFixed(1) }])),
  medianMs: details.map((d) => d.ms).sort((a, b) => a - b)[Math.floor(total / 2)],
};
await fs.writeFile(outPath, JSON.stringify({ summary, details }, null, 1));
console.log(JSON.stringify(summary, null, 2));
console.log('failures:', details.filter((d) => !d.pass).map((d) => `#${d.id}`).join(' ') || 'none');
