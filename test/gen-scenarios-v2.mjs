// CallosiumBench v2 generator — scenario families modeled on the OWNER'S REAL
// question style (conversational, temporal, voice-mangled, comparative), each
// family probing ONE measurable dimension. Deterministic (seeded LCG).
//   node test/gen-scenarios-v2.mjs "<brain path>" [out.json]
//
// Families (10,000 total):
//   known      2,000  conversational known-item            → recall quality
//   typo       1,500  same, ONE entity token perturbed     → typo-tolerance
//   temporal   1,500  recency-anchored phrasing            → temporal-tolerance
//   content    1,500  rare-body-word conversational        → deep recall
//   compare    1,000  two-entity comparison                → multi-target
//   ambiguous    750  dated-sibling collisions             → clarify SHOULD fire
//   clean        750  unique exact titles                  → clarify must NOT fire
//   negative   1,000  invented entities                    → honesty

import { promises as fs } from 'node:fs';
import { Vault } from '../src/core/vault.ts';
import { loadTexts, tokenize, isDateish } from '../src/recall/engine.ts';
import { buildGraph } from '../src/graph/index.ts';

const brainPath = process.argv[2];
const outPath = process.argv[3] || 'test/scenarios-v2.json';
let seed = 0xbead5;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 0x100000000);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

const vault = Vault.open(brainPath);
const t = await loadTexts(vault);
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

const CONV_AR = [
  (kw) => `تتذكر ${kw}؟`,
  (kw) => `ايش كان الوضع بخصوص ${kw}؟`,
  (kw) => `ورجعلي ملف ${kw}`,
  (kw) => `ابغى اراجع ${kw}`,
  (kw) => `شو صار مع ${kw}؟`,
];
const TEMPORAL_AR = [
  (kw) => `وين وقفنا مع ${kw}؟`,
  (kw) => `اخر شي عن ${kw}؟`,
  (kw) => `ايش سوينا امس في ${kw}؟`,
];
const CONTENT_AR = [
  (kw) => `ذكرني ايش قلنا عن ${kw}`,
  (kw) => `كان في شي عن ${kw}، ايش هو؟`,
];
const CONV = [
  (kw) => `do you remember the ${kw}?`,
  (kw) => `what do we know about ${kw} again?`,
  (kw) => `can you pull up ${kw} for me`,
  (kw) => `I need to review ${kw}`,
  (kw) => `what was the deal with ${kw}?`,
];
const TEMPORAL_T = [
  (kw) => `what did we do recently with ${kw}?`,
  (kw) => `latest on ${kw}?`,
  (kw) => `do you remember what we did yesterday with ${kw}?`,
  (kw) => `where did we leave ${kw} this week?`,
];
const CONTENT_T = [
  (kw) => `remind me what we said about ${kw}`,
  (kw) => `there was something about ${kw}, what was it?`,
  (kw) => `what were the details on ${kw}?`,
];

// deterministic voice/typo perturbations (seeded per call)
function perturb(word) {
  if (word.length < 4) return word;
  const mode = Math.floor(rand() * 4);
  const i = 1 + Math.floor(rand() * (word.length - 2));
  if (mode === 0) return word.slice(0, i) + word.slice(i + 1); // drop char
  if (mode === 1) return word.slice(0, i) + word[i + 1] + word[i] + word.slice(i + 2); // swap
  if (mode === 2) return word.slice(0, i) + word[i] + word.slice(i); // dupe
  return word.slice(0, Math.max(3, word.length - 2)); // voice truncation
}

const scenarios = [];
let id = 0;
// half the scenarios ask in Arabic (code-switched: Arabic phrasing around
// corpus keywords — how Arabic tech users actually talk)
const add = (family, question, target, accept, extra = {}) =>
  scenarios.push({ id: ++id, family, question, target, accept, lang: 'en', ...extra });
const addL = (family, enT, arT, kw, target, accept, extra = {}) => {
  const ar = id % 2 === 0;
  scenarios.push({ id: ++id, family, question: ar ? pick(arT)(kw) : pick(enT)(kw), target, accept, lang: ar ? 'ar' : 'en', ...extra });
};

const good = eligible.filter((f) => contentTokens(f).length >= 2 && !isJunk(f));

// known (2,000) — paired with typo family for a clean tolerance ratio
const knownPairs = [];
for (let n = 0; n < 2000; n++) {
  const f = pick(good);
  const kw = contentTokens(f).join(' ');
  addL('known', CONV, CONV_AR, kw, f, 'top3');
  knownPairs.push({ f, kw });
}
// typo (1,500): perturb the RAREST content token of a known-style query
for (let n = 0; n < 1500; n++) {
  const { f } = knownPairs[Math.floor(rand() * knownPairs.length)];
  const toks = contentTokens(f).sort((a, b) => (df.get(a) ?? 0) - (df.get(b) ?? 0));
  const rare = toks[0];
  const mangled = perturb(rare);
  if (mangled === rare) { n--; continue; }
  const kw = toks.map((w) => (w === rare ? mangled : w)).join(' ');
  addL('typo', CONV, CONV_AR, kw, f, 'top3', { perturbed: { from: rare, to: mangled } });
}
// temporal (1,500): targets from the 60 most recently modified notes
const recent = [...good].sort((a, b) => (t.mtimes.get(b) ?? 0) - (t.mtimes.get(a) ?? 0)).slice(0, 60);
for (let n = 0; n < 1500; n++) {
  const f = pick(recent);
  const toks = contentTokens(f);
  addL('temporal', TEMPORAL_T, TEMPORAL_AR, toks.slice(0, 2).join(' '), f, 'top5');
}
// content (1,500): 3 rare body words
for (let n = 0; n < 1500; n++) {
  const f = pick(good);
  const words = [...new Set(tokenize(t.texts.get(f) || ''))].filter((w) => !w.includes(' ') && (df.get(w) ?? 9) <= 8 && !/^\d+$/.test(w));
  if (words.length < 3) { n--; continue; }
  addL('content', CONTENT_T, CONTENT_AR, words.slice(0, 3).join(' '), f, 'top3');
}
// compare (1,000): two entity notes from the same partition
const entities = good.filter((f) => /^(People|Knowledge|Ventures|Initiatives|Agents and Systems|Work[^/]*)\//.test(f) && f.split('/').length <= 3);
for (let n = 0; n < 1000; n++) {
  const a = pick(entities);
  const b = pick(entities);
  if (a === b || a.split('/')[0] !== b.split('/')[0]) { n--; continue; }
  const ka = contentTokens(a).slice(0, 2).join(' ');
  const kb = contentTokens(b).slice(0, 2).join(' ');
  if (!ka || !kb) { n--; continue; }
  const arC = id % 2 === 0;
  scenarios.push({ id: ++id, family: 'compare', question: arC ? `قارن لي بين ${ka} و ${kb}` : `how does ${ka} compare to ${kb}?`, target: a, accept: 'both-top5', lang: arC ? 'ar' : 'en', target2: b });
}
// ambiguous (750): dated-sibling groups (≥3 same dateKey) — clarify SHOULD fire
const groups = new Map();
for (const f of good) {
  const k = dateKey(f);
  if (k.split(' ').length < 2) continue;
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(f);
}
const sibGroups = [...groups.entries()].filter(([, v]) => v.length >= 3);
for (let n = 0; n < 750 && sibGroups.length; n++) {
  const [k, files] = pick(sibGroups);
  add('ambiguous', `what do we know about ${k}?`, files[0], 'clarify-or-multi', { group: files.slice(0, 6) });
}
// clean (750): unique basenames, full title — clarify must NOT fire
const uniq = good.filter((f) => (groups.get(dateKey(f)) ?? []).length === 1 && contentTokens(f).length >= 3);
for (let n = 0; n < 750; n++) {
  const f = pick(uniq);
  add('clean', contentTokens(f).join(' '), f, 'top1-noclarify');
}
// negative (1,000)
const inv = ['zorblatt','quixmire','flembocker','drazzlewick','vompettra','skarnfluke','plimberjack','wuzzleforth','grimpettle','xanthoquill'];
for (let n = 0; n < 1000; n++) {
  const a = pick(inv) + Math.floor(rand() * 90 + 10);
  const b = pick(inv);
  if (df.has(a) || df.has(b)) { n--; continue; }
  add('negative', pick([`what did we decide about ${a} ${b}`, `do you remember ${a}?`, `latest on the ${b} ${a} thing?`]), null, 'not-in-brain');
}

// richness (500): build-intent queries against well-connected entities.
// Grades CONTEXT RICHNESS — a "based on X, build me Y" answer must surface
// the anchor's whole cluster (docs, prior PoCs, related notes), not one
// snippet. Expected cluster = the anchor's 1-hop resolved graph neighbors.
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
console.error(`${connected.length} well-connected richness anchors`);
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
for (let n = 0; n < 500 && connected.length; n++) {
  const f = pick(connected);
  const kw = contentTokens(f).join(' ');
  if (!kw) { n--; continue; }
  const cluster = [...neighborsOf.get(f)].slice(0, 6);
  addL('richness', RICH_T, RICH_AR, kw, f, 'cluster', { cluster });
}

await fs.writeFile(outPath, JSON.stringify({ brain: brainPath, scenarios }, null, 0));
const by = {};
for (const s of scenarios) by[s.family] = (by[s.family] || 0) + 1;
console.error(`wrote ${scenarios.length}:`, JSON.stringify(by));
