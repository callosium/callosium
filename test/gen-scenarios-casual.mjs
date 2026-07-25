// CallosiumBench CASUAL — 10,000 fresh ENGLISH scenarios weighted to how the owner
// actually queries: casual conversational recall, temporal "what's the latest",
// and small-fact recall (a date/figure), plus deep-body recall, clean exact
// titles, and honesty negatives. New seed (nothing shared with v2/v3/v4).
// Grades with test/run-bench-casual.mjs.
//   node test/gen-scenarios-casual.mjs "<brain path>" [out.json]
//
// Oracle discipline (why these are honest, not the ~2/3-false mechanical fails
// the v2 judge audit found): every query is keyed on a note's DISTINCTIVE title
// content-tokens (or, for small-fact, a note that genuinely contains a
// date/figure), so the keyed note really is the best answer. Temporal uses an
// accept-GROUP (any recent note matching the key) — "latest on X" has no single
// right answer when several recent notes match X.

import { promises as fs } from 'node:fs';
import { Vault } from '../src/core/vault.ts';
import { loadTexts, tokenize, isDateish } from '../src/recall/engine.ts';

const brainPath = process.argv[2];
const outPath = process.argv[3] || 'test/scenarios-casual.json';
if (!brainPath) { console.error('Usage: node test/gen-scenarios-casual.mjs "<brain path>" [out.json]'); process.exit(1); }

let seed = 0xca50a1; // fresh seed
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 0x100000000);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

const vault = Vault.open(brainPath);
const t = await loadTexts(vault);
const isFork = (f) => /'s (macbook|imac|pc|laptop|desktop)/i.test(f.split('/').pop());
const eligible = t.files.filter((f) => {
  if (f.startsWith('Templates/') || f.startsWith('System/') || f.includes('.excalidraw')) return false;
  if (isFork(f)) return false;
  return (t.texts.get(f) || '').length >= 300;
});
console.error(`${eligible.length} eligible notes`);

const df = new Map();
for (const f of eligible) for (const w of new Set(tokenize(t.texts.get(f) || ''))) df.set(w, (df.get(w) || 0) + 1);
const titleTokens = (f) => [...new Set(tokenize(f.split('/').pop().replace(/\.md$/, '')).filter((w) => !w.includes(' ')))];
const contentTokens = (f) => titleTokens(f).filter((w) => !isDateish(w) && w.length >= 3);

// Inverted index over TITLE + body content tokens → the notes that contain them.
// Used to pick DISTINCTIVE keys: a realistic second-brain query identifies a
// note among a few, not among hundreds. "chatgpt"/"claude" are near-stopwords
// here (the Memory prefixes every note with them), so a key like "chatgpt
// daily" has no determinate answer — grading it pass/fail just measures noise.
const inv = new Map();
for (const f of eligible) {
  const toks = new Set([...titleTokens(f), ...tokenize(t.texts.get(f) || '').filter((w) => !w.includes(' '))].filter((w) => w.length >= 3 && !isDateish(w)));
  for (const w of toks) { let s = inv.get(w); if (!s) inv.set(w, (s = new Set())); s.add(f); }
}
const andCount = (toks) => {
  if (!toks.length) return Infinity;
  let acc = inv.get(toks[0]) ?? new Set();
  for (let i = 1; i < toks.length; i++) { const s = inv.get(toks[i]) ?? new Set(); acc = new Set([...acc].filter((x) => s.has(x))); }
  return acc.size;
};
/** A distinctive key for note f: its 2 (then 3) RAREST title content-tokens,
 *  requiring the AND-match to land in [1,6] so the target is identifiable.
 *  Returns null when the title has no distinctive combination (skip the note). */
const distinctiveKey = (f) => {
  const toks = contentTokens(f).sort((a, b) => (df.get(a) ?? 0) - (df.get(b) ?? 0));
  if (toks.length < 2) return null;
  for (const k of [toks.slice(0, 2), toks.slice(0, 3)]) {
    const c = andCount(k);
    if (c >= 1 && c <= 6) return k.join(' ');
  }
  return null;
};
const isJunk = (f) => /\.(docx|pdf|xlsx|pptx|csv)|\(\d+\)/i.test(f.split('/').pop());
const dateKey = (f) =>
  f.split('/').pop().replace(/\.md$/, '').toLowerCase()
    .replace(/\b(\d{1,2}|\d{4}|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december)\b/g, '')
    .replace(/\s+/g, ' ').trim();
// distinctive: at least 2 content tokens, not a junk/binary export
const good = eligible.filter((f) => !isJunk(f) && contentTokens(f).length >= 2);
// notes that genuinely carry a date or a figure (for small-fact honesty)
const FIGURE_RE = /\b(19|20)\d{2}\b|\b\d{1,2}\s?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i;
const MONEY_RE = /\b(QAR|AED|USD|SAR|\$|€|£)\s?\d|\d+\s?(QAR|AED|USD|SAR)|\b\d+(\.\d+)?\s?%|\b\d{1,3}(,\d{3})+\b/;
const factNotes = good.filter((f) => { const x = t.texts.get(f) || ''; return FIGURE_RE.test(x) || MONEY_RE.test(x); });
console.error(`${good.length} distinctive notes, ${factNotes.length} carry a date/figure`);

// mtimes for temporal grouping
const mtime = (f) => t.mtimes.get(f) ?? 0;

const CASUAL = [
  (kw) => `do you remember the ${kw}?`,
  (kw) => `what do we know about ${kw} again?`,
  (kw) => `can you pull up ${kw} for me`,
  (kw) => `I need to review ${kw}`,
  (kw) => `what was the deal with ${kw}?`,
  (kw) => `any notes on ${kw}?`,
  (kw) => `did we ever discuss ${kw}?`,
  (kw) => `remind me about ${kw}`,
  (kw) => `what's the story with ${kw}?`,
  (kw) => `pull up my notes on ${kw}`,
  (kw) => `where's the ${kw} stuff`,
  (kw) => `find me the ${kw}`,
];
const TEMPORAL = [
  (kw) => `what's the latest on ${kw}?`,
  (kw) => `where did we leave off on ${kw}?`,
  (kw) => `what did I do recently with ${kw}?`,
  (kw) => `what's new with ${kw}?`,
  (kw) => `latest update on ${kw}?`,
  (kw) => `where does ${kw} stand now?`,
  (kw) => `catch me up on ${kw}`,
  (kw) => `what happened lately with ${kw}?`,
  (kw) => `most recent ${kw}?`,
  (kw) => `where are we on ${kw}?`,
];
const SMALLFACT = [
  (kw) => `when did we do ${kw}?`,
  (kw) => `what date was ${kw}?`,
  (kw) => `what's the figure for ${kw}?`,
  (kw) => `how much was ${kw}?`,
  (kw) => `what number did we land on for ${kw}?`,
  (kw) => `when is ${kw}?`,
  (kw) => `what's the ${kw} amount?`,
];
const CONTENT = [
  (kw) => `what did we say about ${kw}?`,
  (kw) => `anything on ${kw}?`,
  (kw) => `notes mentioning ${kw}`,
  (kw) => `where do we talk about ${kw}?`,
];

const scenarios = [];
let id = 0;
const add = (family, tmpls, kw, target, accept, extra = {}) => {
  if (!kw) return false;
  scenarios.push({ id: ++id, family, question: pick(tmpls)(kw), target, accept, lang: 'en', ...extra });
  return true;
};

const keyTokensOf = (kw) => kw.split(' ');
const groupFor = (kw) => { // notes containing ALL key tokens (title or body) = honest "about this topic" set
  const toks = keyTokensOf(kw);
  let acc = inv.get(toks[0]) ?? new Set();
  for (let i = 1; i < toks.length; i++) { const s = inv.get(toks[i]) ?? new Set(); acc = new Set([...acc].filter((x) => s.has(x))); }
  return [...acc];
};

// ── casual conversational recall (3000) → target in top-5, DISTINCTIVE key ──
let tries = 0;
for (let n = 0; n < 3000 && tries < 200000; ) {
  tries++;
  const f = pick(good);
  const kw = distinctiveKey(f);
  if (kw && add('casual', CASUAL, kw, f, 'top5')) n++;
}

// ── temporal recency (2500) → recent-group (any recent note matching key top-5) ──
// group = notes containing all key tokens; "latest on X" is satisfied by any of
// X's recent notes surfacing. Distinctive key so the topic is real, not a stopword.
let temporalMade = 0; tries = 0;
for (let n = 0; n < 2500 && tries < 200000; ) {
  tries++;
  const f = pick(good);
  const kw = distinctiveKey(f);
  if (!kw) continue;
  const group = groupFor(kw);
  if (!group.length) continue;
  const freshest = group.slice().sort((a, b) => mtime(b) - mtime(a))[0];
  scenarios.push({ id: ++id, family: 'temporal', question: pick(TEMPORAL)(kw), target: freshest, accept: 'recent-group', lang: 'en', group: group.slice(0, 12) });
  n++; temporalMade++;
}

// ── small-fact recall (1500) → target in top-3 (note that holds the fact) ──
tries = 0;
for (let n = 0; n < 1500 && factNotes.length && tries < 200000; ) {
  tries++;
  const f = pick(factNotes);
  const kw = distinctiveKey(f);
  if (kw && add('smallfact', SMALLFACT, kw, f, 'top3')) n++;
}

// ── deep-body content recall (1500) → rare body word(s), top-3 ──
for (let n = 0; n < 1500; ) {
  const f = pick(good);
  const body = tokenize(t.texts.get(f) || '').filter((w) => !w.includes(' ') && w.length >= 5 && (df.get(w) ?? 99) <= 4);
  if (body.length < 2) { continue; }
  const off = Math.floor(rand() * Math.max(1, body.length - 2));
  const kw = body.slice(off, off + 2).join(' ');
  if (add('content', CONTENT, kw, f, 'top3')) n++;
}

// ── clean exact-title (800) → top-1, clarify must NOT fire ──
const groups = new Map();
for (const f of good) { const k = dateKey(f); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(f); }
const uniq = good.filter((f) => (groups.get(dateKey(f)) ?? []).length === 1 && contentTokens(f).length >= 3);
for (let n = 0; n < 800 && uniq.length; ) {
  const f = pick(uniq);
  const kw = contentTokens(f).join(' ');
  if (add('clean', [(k) => k], kw, f, 'top1-noclarify')) n++;
}

// ── honesty negatives (700) → not-in-brain ──
const invWords = ['zorblatt', 'quixmire', 'flembocker', 'drazzlewick', 'vompettra', 'skarnfluke', 'plimberjack', 'wuzzleforth', 'grimpettle', 'xanthoquill', 'brizzle', 'clonktop'];
for (let n = 0; n < 700; ) {
  const a = pick(invWords) + Math.floor(rand() * 90 + 10);
  const b = pick(invWords);
  if (df.has(a) || df.has(b)) continue;
  const q = pick([`what did we decide about ${a} ${b}?`, `do you remember ${a}?`, `latest on the ${b} ${a} thing?`, `any notes on ${a}?`, `where did we leave off on ${b} ${a}?`]);
  scenarios.push({ id: ++id, family: 'negative', question: q, target: null, accept: 'not-in-brain', lang: 'en' });
  n++;
}

await fs.writeFile(outPath, JSON.stringify({ brain: brainPath, scenarios }, null, 0));
const by = {};
for (const s of scenarios) by[s.family] = (by[s.family] || 0) + 1;
console.error(`wrote ${scenarios.length} to ${outPath}:`, JSON.stringify(by));
