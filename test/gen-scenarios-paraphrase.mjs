// CallosiumBench "paraphrase" family — the honesty gate's blind spot.
//   node test/gen-scenarios-paraphrase.mjs "<brain>" [out.json] [max]
//
// WHY THIS FAMILY EXISTS
// The negative family proves the engine refuses questions about things the brain
// never recorded. Its mirror image is untested: a question about something the
// brain DOES hold, asked in words the brain never used. That is the whole reason
// the semantic lane can vote to rescue a lexically-weak answer (TRUST FIX 1), and
// nothing was measuring whether the vote still fires.
//
// SHAPE (matches the measured regression, engine.ts "PARAPHRASE ESCAPE")
// A short query of exactly two content words: one SYNONYM that appears nowhere in
// the vault (df=0 in every body AND in every filename — so no lexical lane can
// help) plus one COMMON word taken from the target note's own title. That puts
// ~60-85% of the query's idf mass on an absent term, which is arithmetically
// indistinguishable from a nonsense entity — the discrimination has to come from
// somewhere other than absent-mass.
//
// ORACLE — same question, different words, same answer.
// The target is not hand-picked: for each pair we ask the engine the LITERAL
// wording ("cost proposal") and take the note it answers with; the scenario then
// asks the paraphrase ("outlay proposal") and expects that same note. A pair the
// engine cannot answer even literally is dropped, so every scenario is one the
// brain provably contains. The literal wording carries no absent mass, so its
// answer is independent of the gate behavior under test.
//
// The synonym lexicon is generic English, deliberately free of anything vault- or
// owner-specific; every pair is re-verified against the brain at generation time
// and silently skipped when it doesn't hold, so this runs on any brain (it simply
// yields fewer scenarios on one whose vocabulary the lexicon doesn't touch).

import { promises as fs } from 'node:fs';
import { Vault } from '../src/core/vault.ts';
import { loadTexts, recall, tokenize, isDateish } from '../src/recall/engine.ts';
import { buildGraph } from '../src/graph/index.ts';
import { loadEmbeddings } from '../src/recall/semantic.ts';

const brainPath = process.argv[2];
const outPath = process.argv[3] || 'test/scenarios-paraphrase.json';
const MAX = Number(process.argv[4] || 300);

let seed = 0x9a11c3; // fresh seed, shared with no other family
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 0x100000000);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

// [absent synonym, vault term it paraphrases]. Plain dictionary English — no
// invented tokens (that's the negative family's job) and nothing personal.
const SYNONYMS = [
  ['remuneration', 'salary'], ['stipend', 'salary'], ['precis', 'summary'],
  ['confab', 'meeting'], ['powwow', 'meeting'], ['prospectus', 'proposal'],
  ['compendium', 'index'], ['affiliation', 'partnership'], ['stratagem', 'strategy'],
  ['patron', 'client'], ['purveyor', 'vendor'], ['outlay', 'cost'],
  ['expenditure', 'cost'], ['unveiling', 'launch'], ['debut', 'launch'],
  ['malfunction', 'bug'], ['tutelage', 'training'], ['dwelling', 'apartment'],
  ['abode', 'apartment'], ['ailment', 'illness'], ['stenograph', 'transcript'],
  ['predicament', 'problem'], ['adversary', 'competitor'], ['seminar', 'workshop'],
  ['furlough', 'vacation'], ['nuptials', 'wedding'], ['slumber', 'sleep'],
  ['apprehension', 'anxiety'], ['pharmaceutical', 'medication'], ['induction', 'onboarding'],
  ['peril', 'risk'], ['rebate', 'discount'], ['errand', 'task'],
  ['excursion', 'trip'], ['voyage', 'trip'], ['lodging', 'hotel'],
  ['eatery', 'restaurant'], ['pedagogy', 'teaching'], ['locomotion', 'walking'],
  ['prognosis', 'diagnosis'], ['therapeutics', 'therapy'], ['sabbatical', 'leave'],
];

// Frames whose every word is a tokenizer stop-word, so the query the engine sees
// is exactly the two content words — the shape under test, not a frame test.
const FRAMES = [(kw) => kw, (kw) => `what about ${kw}?`, (kw) => `anything on ${kw}?`, (kw) => `${kw}?`];

/** A companion word must be COMMON (low idf) — that is what pushes the query's
 *  idf mass onto the absent synonym and trips the guard. Rare companions would
 *  let the lexical lanes answer on their own and the family would test nothing. */
const COMPANION_DF_MIN = 20;

const vault = Vault.open(brainPath);
const t = await loadTexts(vault);
const { index: graph } = await buildGraph(vault);
const emb = await loadEmbeddings(vault);
console.error(emb ? `embeddings: ${emb.chunks.length} chunks` : 'embeddings: NONE — paraphrase family is meaningless without them');

const df = (w) => t.contentIndex?.get(w)?.size ?? 0;
const lowerNames = t.files.map((f) => f.toLowerCase());
const inAnyFilename = (w) => lowerNames.some((f) => f.includes(w));
const titleTokens = (f) => [...new Set(tokenize(f.split('/').pop().replace(/\.md$/, '')))];

const scenarios = [];
const seenQ = new Set();
let id = 0;
let skippedPair = 0, skippedNoCompanion = 0, skippedUnanswerable = 0;

for (const [syn, term] of SYNONYMS) {
  // The synonym has to be genuinely unreachable by every lexical lane: absent
  // from bodies (df=0 → it lands in absentTerms) AND from filenames (or the
  // title lane would find it anyway and the query wouldn't be a paraphrase test).
  if (df(syn) !== 0 || inAnyFilename(syn)) { skippedPair++; continue; }
  const holders = t.contentIndex?.get(term);
  if (!holders || holders.size < 3) { skippedPair++; continue; }

  // Candidate targets = what the engine itself answers when asked about the term
  // alone. Raw occurrence count was the obvious pick and the wrong one: it
  // surfaces notes where the word merely appears often (a term buried in a long
  // RFP), producing queries no one would ask. The engine's own ranking picks
  // notes the term is ABOUT, so "<term> <companion>" reads like a real question.
  const about = await recall(term, t, graph, false, emb);
  const notes = (about.results ?? [])
    .map((x) => x.path)
    .filter((f) => holders.has(f) && !f.startsWith('System/') && !f.startsWith('Templates/'))
    .slice(0, 8);

  for (const note of notes) {
    if (scenarios.length >= MAX) break;
    const companion = titleTokens(note).find(
      (w) => w !== term && !w.includes(' ') && !isDateish(w) && w.length >= 3 && df(w) >= COMPANION_DF_MIN,
    );
    if (!companion) { skippedNoCompanion++; continue; }
    const literal = `${term} ${companion}`;
    const paraphrase = `${syn} ${companion}`;
    if (seenQ.has(paraphrase)) continue;
    seenQ.add(paraphrase);
    // Oracle: whatever the engine answers for the LITERAL wording is the right
    // answer for the paraphrase too. No answer literally → the brain can't be
    // expected to answer the paraphrase either; drop the pair.
    const lit = await recall(literal, t, graph, false, emb);
    if (!lit.found || !lit.results?.length) { skippedUnanswerable++; continue; }
    scenarios.push({
      id: ++id,
      family: 'paraphrase',
      question: pick(FRAMES)(paraphrase),
      target: lit.results[0].path,
      accept: 'paraphrase',
      lang: 'en',
      // provenance, so a failure can be read without re-deriving it
      paraphraseOf: literal,
      synonym: syn,
      vaultTerm: term,
    });
  }
  if (scenarios.length >= MAX) break;
}

await fs.writeFile(outPath, JSON.stringify({ brain: brainPath, scenarios }, null, 0));
console.error(
  `wrote ${scenarios.length} paraphrase scenarios → ${outPath} ` +
    `(skipped: ${skippedPair} pairs not absent/present in this brain, ${skippedNoCompanion} notes with no common companion, ${skippedUnanswerable} unanswerable literally)`,
);
