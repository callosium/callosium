// Failure auditor — classifies benchmark misses into a deterministic taxonomy
// so the honest miss rate is computed by RULE, not vibes. Mirrors the certified
// bench's judged-true-miss methodology (14 Jul audits: only ~1/3 of mechanical
// fails were real), but with a mechanical judge instead of an LLM:
//
//   doubled-key   — the generator emitted a degenerate key (same token twice:
//                   "mamon mamon"): one effective token, several sibling notes
//                   legitimately match; the single-target oracle is
//                   under-determined. Bench artifact, not an engine miss.
//   equivalent    — a returned top-k note contains ALL the query's distinctive
//                   tokens (title or body; for smallfact it must also carry a
//                   date/figure like the generator required of the target).
//                   With distinctive keys (AND-match ≤6 notes by construction)
//                   any AND-match note is an honest answer to "anything on X Y".
//   near-rank     — the target itself was returned, one page below the accept
//                   cutoff (rank 4-5 on a top-3 accept).
//   TRUE MISS     — none of the above; the engine genuinely failed.
//
//   node test/audit-failures.mjs "<brain path>" [failures.json] [scenarios.json]

import { promises as fs } from 'node:fs';
import { Vault } from '../src/core/vault.ts';
import { loadTexts, tokenize, isDateish } from '../src/recall/engine.ts';

const brainPath = process.argv[2];
const failuresPath = process.argv[3] || 'test/goal5-final-failures.json';
const scenariosPath = process.argv[4] || 'test/scenarios-casual2.json';

const vault = Vault.open(brainPath);
const t = await loadTexts(vault, true);
const fails = JSON.parse(await fs.readFile(failuresPath, 'utf8'));
const { scenarios } = JSON.parse(await fs.readFile(scenariosPath, 'utf8'));
const byId = new Map(scenarios.map((s) => [s.id, s]));
const FIGURE_RE = /\b(19|20)\d{2}\b|\b\d{1,2}\s?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i;
const MONEY_RE = /\b(QAR|AED|USD|SAR|\$|€|£)\s?\d|\d+\s?(QAR|AED|USD|SAR)|\b\d+(\.\d+)?\s?%|\b\d{1,3}(,\d{3})+\b/;

// distinctive tokens of a question = its rare tokens (df<=50); benchmark keys
// are rare by construction, template vocabulary is common. TEMPLATE words are
// excluded explicitly (review finding: a template word that happens to be rare
// in the corpus must not become a "key"), and matching is TOKEN-boundary
// (review finding: substring "cal" must not match "calendar").
const TEMPLATE_WORDS = new Set(
  'remember review pull deal story notes discuss discussed remind find stuff latest update stand catch happened lately recent recently newest fresh date figure land landed amount much number mentioning anything talk know'.split(' '),
);
const keyTokens = (q) => {
  const toks = tokenize(q).filter((w) => !w.includes(' ') && !isDateish(w) && w.length >= 3 && !TEMPLATE_WORDS.has(w));
  return [...new Set(toks.filter((w) => (t.contentIndex.get(w)?.size ?? 99) <= 50))];
};
const tokenSetCache = new Map();
const tokensOf = (path) => {
  let s = tokenSetCache.get(path);
  if (!s) tokenSetCache.set(path, (s = new Set(tokenize(path + ' ' + (t.texts.get(path) || '')))));
  return s;
};
const noteHasAll = (path, keys) => {
  const s = tokensOf(path);
  return keys.every((k) => s.has(k));
};

const totals = {}; // family -> {fails, doubled, equivalent, nearRank, trueMiss}
const trueMisses = [];
for (const [family, list] of Object.entries(fails)) {
  const T = (totals[family] = { fails: 0, doubled: 0, equivalent: 0, nearRank: 0, trueMiss: 0 });
  for (const x of list ?? []) {
    T.fails++;
    const s = byId.get(x.id);
    const rawToks = tokenize(s?.question ?? x.q);
    const doubled = rawToks.some((w, i) => i > 0 && rawToks[i - 1] === w && w.length >= 3);
    if (doubled) { T.doubled++; continue; }
    const keys = keyTokens(s?.question ?? x.q);
    const got = Array.isArray(x.got) ? x.got : [];
    // smallfact: the fact must sit NEAR a key token (±500 chars), not merely
    // anywhere in the note (review finding: a whole-note fact test is vacuous —
    // nearly every note carries some date).
    const factNearKey = (p, keys2) => {
      const text = t.texts.get(p) || '';
      const ll = text.toLowerCase();
      for (const k of keys2) {
        let pos = -1;
        while ((pos = ll.indexOf(k, pos + 1)) !== -1) {
          const win = text.slice(Math.max(0, pos - 500), pos + 500);
          if (FIGURE_RE.test(win) || MONEY_RE.test(win)) return true;
        }
      }
      return false;
    };
    const needsFact = family === 'smallfact';
    const equivalent = keys.length >= 2 && got.some((p) => noteHasAll(p, keys) && (!needsFact || factNearKey(p, keys)));
    if (equivalent) { T.equivalent++; continue; }
    if (x.rank >= 4 && x.rank <= 5) { T.nearRank++; continue; }
    T.trueMiss++;
    if (trueMisses.length < 40) trueMisses.push({ family, q: x.q, want: x.expected, got: got.slice(0, 3) });
  }
}

console.log('family      fails  doubled  equiv  nearRank  TRUE-MISS');
for (const [f, T] of Object.entries(totals)) {
  console.log(
    `${f.padEnd(11)} ${String(T.fails).padStart(5)}  ${String(T.doubled).padStart(7)}  ${String(T.equivalent).padStart(5)}  ${String(T.nearRank).padStart(8)}  ${String(T.trueMiss).padStart(9)}`,
  );
}
console.log('\nNOTE: honest miss = TRUE-MISS (+ nearRank if you count "found at 4-5" as a miss).');
console.log('\n=== TRUE MISS SAMPLE (up to 40) ===');
for (const m of trueMisses) console.log(`[${m.family}] ${m.q}\n   want: ${m.want}\n   got:  ${m.got.map((p) => p.split('/').pop()).join(' | ')}`);
await fs.writeFile('test/true-misses.json', JSON.stringify(trueMisses, null, 1));
