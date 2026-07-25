// CallosiumBench v4 FINAL generator — 15,000 fresh scenarios, bilingual.
// New seed, new template variants, and three oracle fixes over v2/v3:
//   1. temporal accepts ANY recent note matching the key (accept-group) —
//      "latest on X" has no single right answer when several recent notes
//      match X; the old oracle keyed multiple targets on one query string.
//   2. device-fork/conflict-copy files can't be TARGETS (still corpus) —
//      the engine returning the canonical over a stale fork is correct.
//   3. temporal keys use 3 tokens where available (2 was degenerate).
//   node test/gen-scenarios-v4.mjs "<brain path>" [out.json]

import { promises as fs } from 'node:fs';
import { Vault } from '../src/core/vault.ts';
import { loadTexts, tokenize, isDateish } from '../src/recall/engine.ts';
import { buildGraph } from '../src/graph/index.ts';

const brainPath = process.argv[2];
const outPath = process.argv[3] || 'test/scenarios-v4-final.json';
let seed = 0xfeed15; // fresh seed — nothing shared with v2/v3 sampling
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 0x100000000);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

const vault = Vault.open(brainPath);
const t = await loadTexts(vault);
const isFork = (f) => /'s (macbook|imac|pc|laptop|desktop)/i.test(f.split('/').pop());
const eligible = t.files.filter((f) => {
  if (f.startsWith('Templates/') || f.startsWith('System/') || f.includes('.excalidraw')) return false;
  return (t.texts.get(f) || '').length >= 300;
});
console.error(`${eligible.length} eligible notes`);

const df = new Map();
for (const f of eligible) for (const w of new Set(tokenize(t.texts.get(f) || ''))) df.set(w, (df.get(w) || 0) + 1);
const titleTokens = (f) => [...new Set(tokenize(f.split('/').pop().replace(/\.md$/, '')).filter((w) => !w.includes(' ')))];
const contentTokens = (f) => titleTokens(f).filter((w) => !isDateish(w));
const isJunk = (f) => /\.(docx|pdf|xlsx|pptx|csv)|\(\d+\)|_/i.test(f.split('/').pop());
const dateKey = (f) =>
  f.split('/').pop().replace(/\.md$/, '').toLowerCase()
    .replace(/\b(\d{1,2}|\d{4}|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/g, '').replace(/\s+/g, ' ').trim();

// fresh template variants (superset of v2 style, new phrasings included)
const CONV_AR = [
  (kw) => `تتذكر ${kw}؟`,
  (kw) => `ايش كان الوضع بخصوص ${kw}؟`,
  (kw) => `ورجعلي ملف ${kw}`,
  (kw) => `ابغى اراجع ${kw}`,
  (kw) => `شو صار مع ${kw}؟`,
  (kw) => `وش سالفة ${kw}؟`,
  (kw) => `في شي مسجل عن ${kw}؟`,
];
const CONV = [
  (kw) => `do you remember the ${kw}?`,
  (kw) => `what do we know about ${kw} again?`,
  (kw) => `can you pull up ${kw} for me`,
  (kw) => `I need to review ${kw}`,
  (kw) => `what was the deal with ${kw}?`,
  (kw) => `what's the story with ${kw}?`,
  (kw) => `did we ever discuss ${kw}?`,
  (kw) => `any notes on ${kw}?`,
];
const TEMPORAL_AR = [
  (kw) => `وين وقفنا مع ${kw}؟`,
  (kw) => `اخر شي عن ${kw}؟`,
  (kw) => `ايش سوينا امس في ${kw}؟`,
  (kw) => `ايش صار مؤخرا مع ${kw}؟`,
];
const TEMPORAL_T = [
  (kw) => `what did we do recently with ${kw}?`,
  (kw) => `latest on ${kw}?`,
  (kw) => `do you remember what we did yesterday with ${kw}?`,
  (kw) => `where did we leave ${kw} this week?`,
  (kw) => `catch me up on ${kw}`,
];
const CONTENT_AR = [
  (kw) => `ذكرني ايش قلنا عن ${kw}`,
  (kw) => `كان في شي عن ${kw}، ايش هو؟`,
  (kw) => `في شي مكتوب عن ${kw}؟`,
];
const CONTENT_T = [
  (kw) => `remind me what we said about ${kw}`,
  (kw) => `there was something about ${kw}, what was it?`,
  (kw) => `what were the details on ${kw}?`,
];
const RICH_T = [
  (kw) => `based on what we know about ${kw}, build me a poc for a new client`,
  (kw) => `using everything we know about ${kw}, draft a proposal`,
  (kw) => `build me a demo based on what we know about ${kw}`,
  (kw) => `prepare an integration plan based on what we know about ${kw}`,
];
const RICH_AR = [
  (kw) => `بناء على اللي نعرفه عن ${kw} ابنيلي poc لعميل جديد`,
  (kw) => `جهزلي عرض بناء على اللي نعرفه عن ${kw}`,
  (kw) => `سويلي demo مبني على كل اللي عندنا عن ${kw}`,
];

function perturb(word) {
  if (word.length < 4) return word;
  const mode = Math.floor(rand() * 4);
  const i = 1 + Math.floor(rand() * (word.length - 2));
  if (mode === 0) return word.slice(0, i) + word.slice(i + 1);
  if (mode === 1) return word.slice(0, i) + word[i + 1] + word[i] + word.slice(i + 2);
  if (mode === 2) return word.slice(0, i) + word[i] + word.slice(i);
  return word.slice(0, Math.max(3, word.length - 2));
}

const scenarios = [];
let id = 0;
const add = (family, question, target, accept, extra = {}) =>
  scenarios.push({ id: ++id, family, question, target, accept, lang: /[؀-ۿ]/.test(question) ? 'ar' : 'en', ...extra });
const addL = (family, enT, arT, kw, target, accept, extra = {}) => {
  const ar = id % 2 === 0;
  scenarios.push({ id: ++id, family, question: ar ? pick(arT)(kw) : pick(enT)(kw), target, accept, lang: ar ? 'ar' : 'en', ...extra });
};

const good = eligible.filter((f) => contentTokens(f).length >= 2 && !isJunk(f) && !isFork(f));

// known (2,850)
const knownPairs = [];
for (let n = 0; n < 2850; n++) {
  const f = pick(good);
  const kw = contentTokens(f).join(' ');
  addL('known', CONV, CONV_AR, kw, f, 'top3');
  knownPairs.push({ f, kw });
}
// typo (2,150)
for (let n = 0; n < 2150; n++) {
  const { f } = knownPairs[Math.floor(rand() * knownPairs.length)];
  const toks = contentTokens(f).sort((a, b) => (df.get(a) ?? 0) - (df.get(b) ?? 0));
  const rare = toks[0];
  const mangled = perturb(rare);
  if (mangled === rare) { n--; continue; }
  const kw = toks.map((w) => (w === rare ? mangled : w)).join(' ');
  addL('typo', CONV, CONV_AR, kw, f, 'top3', { perturbed: { from: rare, to: mangled } });
}
// temporal (2,150): 3-token keys; accept-group = every recent note matching
// the key (any of them is an honest "latest on X" answer)
const recent = [...good].sort((a, b) => (t.mtimes.get(b) ?? 0) - (t.mtimes.get(a) ?? 0)).slice(0, 60);
const matchesKw = (f, toks) => {
  // tokenized membership, not raw substring — "ai" must match the standalone
  // token, not "email"/"detail"/"domain", or the recent-group oracle balloons
  // with coincidental substring hits and inflates the temporal pass rate.
  const bag = new Set(tokenize(t.texts.get(f) || ''));
  const baseBag = new Set(tokenize(f.split('/').pop().replace(/\.md$/, '')));
  return toks.every((w) => bag.has(w) || baseBag.has(w));
};
for (let n = 0; n < 2150; n++) {
  const f = pick(recent);
  const toks = contentTokens(f).slice(0, 3);
  if (toks.length < 2) { n--; continue; }
  const kw = toks.join(' ');
  const group = recent.filter((r) => matchesKw(r, toks)).slice(0, 10);
  addL('temporal', TEMPORAL_T, TEMPORAL_AR, kw, f, 'recent-group', { group });
}
// content (2,150): 3 rare body words
for (let n = 0; n < 2150; n++) {
  const f = pick(good);
  const words = [...new Set(tokenize(t.texts.get(f) || ''))].filter((w) => !w.includes(' ') && (df.get(w) ?? 9) <= 8 && !/^\d+$/.test(w));
  if (words.length < 3) { n--; continue; }
  // fresh sampling: take 3 from a random offset, not always the first 3
  const off = Math.floor(rand() * Math.max(1, words.length - 3));
  addL('content', CONTENT_T, CONTENT_AR, words.slice(off, off + 3).join(' '), f, 'top3');
}
// compare (1,400)
const entities = good.filter((f) => /^(People|Knowledge|Ventures|Initiatives|Agents and Systems|Work[^/]*)\//.test(f) && f.split('/').length <= 3);
for (let n = 0; n < 1400; n++) {
  const a = pick(entities);
  const b = pick(entities);
  if (a === b || a.split('/')[0] !== b.split('/')[0]) { n--; continue; }
  const ka = contentTokens(a).slice(0, 2).join(' ');
  const kb = contentTokens(b).slice(0, 2).join(' ');
  if (!ka || !kb) { n--; continue; }
  const arC = id % 2 === 0;
  scenarios.push({ id: ++id, family: 'compare', question: arC ? `قارن لي بين ${ka} و ${kb}` : `how does ${ka} compare to ${kb}?`, target: a, accept: 'both-top5', lang: arC ? 'ar' : 'en', target2: b });
}
// ambiguous (1,050): dated-sibling groups — clarify SHOULD fire
const groups = new Map();
for (const f of good) {
  const k = dateKey(f);
  if (k.split(' ').length < 2) continue;
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(f);
}
const sibGroups = [...groups.entries()].filter(([, v]) => v.length >= 3);
for (let n = 0; n < 1050 && sibGroups.length; n++) {
  const [k, files] = pick(sibGroups);
  const arA = id % 2 === 0;
  scenarios.push({ id: ++id, family: 'ambiguous', question: arA ? `ايش نعرف عن ${k}؟` : `what do we know about ${k}?`, target: files[0], accept: 'clarify-or-multi', lang: arA ? 'ar' : 'en', group: files.slice(0, 6) });
}
// clean (1,050): unique exact titles — clarify must NOT fire
const uniq = good.filter((f) => (groups.get(dateKey(f)) ?? []).length === 1 && contentTokens(f).length >= 3);
for (let n = 0; n < 1050; n++) {
  const f = pick(uniq);
  add('clean', contentTokens(f).join(' '), f, 'top1-noclarify');
}
// negative (1,450), bilingual
// The negative family asserts these entities are ABSENT from the corpus, so an
// entity that leaked into the brain — a research note quoting one verbatim is the
// usual way — silently turns a refusal scenario into an answerable one and the
// family collapses with no code change. Measured once at 106 scenarios (−0.7pt
// overall). The per-pick `df.has()` below catches the exact token, but `a` is
// base+digits, so a bare mention of the BASE would contaminate every numbered
// variant of it while each variant still looked clean. Drop contaminated bases up
// front, and say so loudly rather than quietly generating a weaker benchmark.
const invAll = ['zorblatt','quixmire','flembocker','drazzlewick','vompettra','skarnfluke','plimberjack','wuzzleforth','grimpettle','xanthoquill'];
const inv = invAll.filter((w) => !df.has(w));
if (inv.length !== invAll.length) {
  console.error(`[gen] WARNING: ${invAll.length - inv.length} invented entit(ies) now EXIST in this brain and were dropped from the negative family.`);
  console.error('[gen] Something wrote a bench token into the vault. Scrub it, or the negative family measures a corpus that contains its own traps.');
}
if (inv.length < 3) throw new Error('too few uncontaminated invented entities left — add new tokens to invAll and scrub the vault');
for (let n = 0; n < 1450; n++) {
  const a = pick(inv) + Math.floor(rand() * 90 + 10);
  const b = pick(inv);
  if (df.has(a) || df.has(b)) { n--; continue; }
  const arN = id % 2 === 0;
  const q = arN
    ? pick([`ايش قررنا بخصوص ${a} ${b}؟`, `تتذكر ${a}؟`, `اخر شي عن ${b} ${a}؟`])
    : pick([`what did we decide about ${a} ${b}`, `do you remember ${a}?`, `latest on the ${b} ${a} thing?`]);
  scenarios.push({ id: ++id, family: 'negative', question: q, target: null, accept: 'not-in-brain', lang: arN ? 'ar' : 'en' });
}
// richness (750): build-intent on well-connected anchors, cluster coverage
const { index: graphIdx } = await buildGraph(vault);
const neighborsOf = new Map();
for (const e of graphIdx.edges) {
  if (e.unresolved) continue;
  if (!neighborsOf.has(e.from)) neighborsOf.set(e.from, new Set());
  if (!neighborsOf.has(e.to)) neighborsOf.set(e.to, new Set());
  neighborsOf.get(e.from).add(e.to);
  neighborsOf.get(e.to).add(e.from);
}
const connected = good.filter((f) => (neighborsOf.get(f)?.size ?? 0) >= 3);
console.error(`${connected.length} richness anchors`);
for (let n = 0; n < 750 && connected.length; n++) {
  const f = pick(connected);
  const kw = contentTokens(f).join(' ');
  if (!kw) { n--; continue; }
  const cluster = [...neighborsOf.get(f)].slice(0, 6);
  addL('richness', RICH_T, RICH_AR, kw, f, 'cluster', { cluster });
}

await fs.writeFile(outPath, JSON.stringify({ brain: brainPath, scenarios }, null, 0));
const by = {};
for (const s of scenarios) by[`${s.family}:${s.lang}`] = (by[`${s.family}:${s.lang}`] || 0) + 1;
console.error(`wrote ${scenarios.length}:`, JSON.stringify(by));
