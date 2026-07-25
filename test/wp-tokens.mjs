// White-paper token-savings measurement (real o200k tokenizer). Compares, per
// question, what an AI actually pulls into context to answer:
//   Callosium  = recall()'s returned excerpts (the context the AI reads).
//   Grep-agent = a REALISTIC baseline: an agent with only keyword-grep + read
//                opens candidate files IN RANK ORDER until it hits an answer note.
//   Oracle     = full text of the gold note (best case for the naive approach —
//                the agent magically already knows the right file).
// Savings are reported ONLY over questions BOTH arms actually answered, and the
// accuracy of each arm is reported alongside — never savings without accuracy.
// Output has PII → gitignored test/gold/. Run: node test/wp-tokens.mjs "<brain>"
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Vault } from '../src/core/vault.ts';
import { loadTexts, recall } from '../src/recall/engine.ts';
import { buildGraph } from '../src/graph/index.ts';
import { loadEmbeddings } from '../src/recall/semantic.ts';
import { encode } from 'gpt-tokenizer';

const brain = process.argv[2] || process.env.CALLOSIUM_BRAIN;
const tok = (s) => (s ? encode(s).length : 0);
const { questions } = JSON.parse(await fs.readFile('test/gold/wp-fresh-set.json', 'utf8'));

const vault = Vault.open(brain);
const texts = await loadTexts(vault);
const { index: graph } = await buildGraph(vault);
const emb = await loadEmbeddings(vault);

// ── grep baseline corpus (excl. Private/System, like a scoped agent) ──
const STOP = new Set('the a an of to in on at for and or is are was were be been do does did i we you my our this that with from what which who how when where why has have had will would can could about'.split(' '));
const gtok = (s) => (s.toLowerCase().match(/[a-z0-9]+/g) || []);
const files = texts.files.filter((f) => !/^(System|Private)\//i.test(f));
const grepRank = (q) => {
  const kws = [...new Set(gtok(q).filter((w) => w.length >= 3 && !STOP.has(w)))];
  const scored = files.map((f) => {
    const t = (texts.texts.get(f) || '').toLowerCase();
    let s = 0; for (const k of kws) if (t.includes(k)) s++;
    return { f, s };
  }).filter((x) => x.s > 0).sort((a, b) => b.s - a.s || a.f.localeCompare(b.f));
  return scored.map((x) => x.f);
};

const returnedText = (a) => !a.found ? '' : a.results.map((r) =>
  (r.excerpt || '') + ' ' + (r.moreChunks || []).map((m) => m.excerpt).join(' ')).join('\n');

const rows = [];
for (const q of questions) {
  if (q.category === 'negative') continue; // savings is about answering
  const gold = q.goldNotePaths || [];
  // Callosium arm
  const a = await recall(q.q, texts, graph, false, emb);
  const calTokens = tok(returnedText(a));
  const calPaths = a.found ? a.results.map((r) => r.path) : [];
  const calAnswered = a.found && (gold.some((g) => calPaths.slice(0, 5).includes(g)) || (a.found && new RegExp(q.expectedAnswer.slice(0, 24).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(returnedText(a))));
  const ranked = grepRank(q.q);
  const goldReachable = gold.some((g) => ranked.includes(g));
  // (a) REALISTIC grep-agent: reads ~4000-char SNIPPETS of ranked candidates (how
  // an agent actually reads — head2head-grep's read cap), stopping when it hits a
  // gold note, else giving up after 5 reads.
  let grepSnipTokens = 0, grepAnswered = false, reads = 0;
  for (const f of ranked) {
    grepSnipTokens += tok((texts.texts.get(f) || '').slice(0, 4000)); reads++;
    if (gold.includes(f)) { grepAnswered = true; break; }
    if (reads >= 5) break;
  }
  // (b) FULL-CONTEXT / naive-RAG baseline: dump the top-5 keyword-matching notes
  // IN FULL into context (the "just give the model the relevant files" pattern).
  const fullDumpTokens = ranked.slice(0, 5).reduce((s, f) => s + tok(texts.texts.get(f) || ''), 0);
  // (c) ORACLE: the single gold note in full (agent already knows the file).
  const oracleTokens = gold.reduce((s, g) => s + tok(texts.texts.get(g) || ''), 0);
  rows.push({ cat: q.category, calTokens, grepSnipTokens, fullDumpTokens, oracleTokens, calAnswered, grepAnswered, goldReachable, reads });
}

const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const mean = (xs) => xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0;
const p90 = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length * 0.9)] : 0; };
const pct = (xs) => ({ median: +(100 * med(xs)).toFixed(1) + '%', mean: +(100 * (xs.reduce((a, b) => a + b, 0) / Math.max(xs.length, 1))).toFixed(1) + '%', n: xs.length });
const answered = rows.filter((r) => r.calAnswered);
const summary = {
  positives: rows.length,
  // ACCURACY reported alongside savings, never savings alone (the headline).
  accuracy: { callosiumAnswered: answered.length, grepSnippetAnswered: rows.filter((r) => r.grepAnswered).length, goldGrepReachable: rows.filter((r) => r.goldReachable).length },
  callosiumTokens: { median: med(rows.map((r) => r.calTokens)), mean: mean(rows.map((r) => r.calTokens)), p90: p90(rows.map((r) => r.calTokens)) },
  baselines_median_tokens: {
    realistic_grep_snippets: med(rows.map((r) => r.grepSnipTokens)),
    full_dump_top5_notes: med(rows.map((r) => r.fullDumpTokens)),
    oracle_single_gold_note: med(rows.map((r) => r.oracleTokens)),
  },
  // Savings computed ONLY over questions Callosium answered (fair), per baseline:
  tokenSavings_vs_realistic_grep_snippets: pct(answered.map((r) => 1 - r.calTokens / Math.max(r.grepSnipTokens, 1))),
  tokenSavings_vs_full_dump_top5: pct(answered.map((r) => 1 - r.calTokens / Math.max(r.fullDumpTokens, 1))),
  tokenSavings_vs_oracle_single_note: pct(answered.filter((r) => r.oracleTokens > 0).map((r) => 1 - r.calTokens / Math.max(r.oracleTokens, 1))),
};
await fs.writeFile('test/gold/wp-tokens.json', JSON.stringify({ summary, rows }, null, 1));
console.log(JSON.stringify(summary, null, 2));
