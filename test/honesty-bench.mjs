// Honesty benchmark: the three-way precision/recall guard for the not-in-brain
// gate. A fix must improve HARD_NEGATIVE refusals WITHOUT regressing either the
// certified fully-absent refusals or the real-question answers.
//   node test/honesty-bench.mjs "<brain>"
import { Vault } from '../src/core/vault.ts';
import { loadTexts, recall } from '../src/recall/engine.ts';
import { buildGraph } from '../src/graph/index.ts';
import { loadEmbeddings } from '../src/recall/semantic.ts';

// SHOULD REFUSE — personal/out-of-domain questions whose tokens scatter across
// the real vault (each word exists somewhere; none of it actually answers).
const HARD_NEG = [
  'what is my aws account id',
  'what is my gym membership number',
  'what is my blood type',
  'what medications do i take',
  'what is my passport number',
  'what is my car license plate',
  'what is my wifi password at home',
  'what did the doctor say about my knee',
  'what is my credit card limit',
  'what time is my dentist appointment',
  'how tall is my brother',
  'what is my landlord phone number',
];
// SHOULD REFUSE — fully alien (every token absent). Must stay 100%.
const CERT_NEG = [
  'what did we decide about quantum blockchain telepathy',
  'summarize my research on martian agriculture subsidies',
  'what is the recipe for zorblatt stew',
  'notes on my underwater basket weaving championship',
];
// SHOULD ANSWER — real questions that must NOT regress into refusals.
const POS = [
  'what is the waitlist endpoint url',
  'which dns records did we set for callosium.com',
  'what is the google analytics measurement id',
  'how will callosium make money',
  'what is my edge over the nearest competitors',
  'does the semantic model support arabic',
  'what should i do today on callosium',
  'how big is the standalone windows bundle',
  'which supabase project does callosium use',
  'what happened with the acme duplicate notes',
  'why did the brain on the website look like an egg',
  'what is left to build in the product',
  'how do i redeploy the website',
  'what are the copy hygiene rules',
  'which vercel account hosts the site',
];

const brain = process.argv[2];
const vault = Vault.open(brain);
const texts = await loadTexts(vault);
const { index: graph } = await buildGraph(vault);
const emb = await loadEmbeddings(vault);

async function verdict(q) {
  const a = await recall(q, texts, graph, false, emb);
  // "refused" = not found. A clarify is NOT a refusal (it still surfaces notes).
  return { refused: !a.found, clarify: !!a.clarify, top: a.found ? a.results[0].path : null };
}

async function runSet(name, qs, wantRefuse) {
  let ok = 0;
  const bad = [];
  for (const q of qs) {
    const v = await verdict(q);
    const correct = wantRefuse ? v.refused : !v.refused;
    if (correct) ok++;
    else bad.push(`${q}${wantRefuse ? ` -> answered (${v.clarify ? 'clarify' : 'confident'}: ${v.top?.slice(0, 45)})` : ' -> REFUSED (should answer)'}`);
  }
  console.log(`\n${name}: ${ok}/${qs.length} correct`);
  for (const b of bad) console.log('  ✗', b);
  return { ok, total: qs.length };
}

const hn = await runSet('HARD_NEGATIVES (want REFUSE)', HARD_NEG, true);
const cn = await runSet('CERTIFIED_NEGATIVES (want REFUSE, must stay 100%)', CERT_NEG, true);
const po = await runSet('POSITIVES (want ANSWER, no regression)', POS, false);
console.log(`\n=== SCORE hard-neg ${hn.ok}/${hn.total} | cert-neg ${cn.ok}/${cn.total} | positives ${po.ok}/${po.total} ===`);
