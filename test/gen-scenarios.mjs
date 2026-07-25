// Generate 10,000 recall test scenarios from a brain's own content, across
// four difficulty tiers plus a negative (not-in-brain) tier. Deterministic:
// seeded LCG, no Math.random — same brain in, same scenarios out.
//
//   node test/gen-scenarios.mjs "<brain path>" [out.json]

import { promises as fs } from 'node:fs';
import { Vault } from '../src/core/vault.ts';
import { loadTexts, tokenize } from '../src/recall/engine.ts';

const brainPath = process.argv[2];
const outPath = process.argv[3] || 'test/scenarios.json';
if (!brainPath) {
  console.error('Usage: node test/gen-scenarios.mjs "<brain path>" [out.json]');
  process.exit(1);
}

// Seeded LCG for reproducibility
let seed = 0xc0ffee;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 0x100000000);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const shuffle = (arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

const vault = Vault.open(brainPath);
const t = await loadTexts(vault);
console.error(`Loaded ${t.files.length} notes`);

// Eligible notes: real content, not scaffolding
const eligible = t.files.filter((f) => {
  if (f.startsWith('Templates/') || f.startsWith('System/') || f.includes('.excalidraw')) return false;
  const text = t.texts.get(f) || '';
  return text.length >= 300;
});
console.error(`${eligible.length} eligible notes`);

// Per-note precomputation: title tokens, headings, rare body words
const df = new Map(); // word -> doc count
const noteWords = new Map(); // file -> distinct words
for (const f of eligible) {
  const words = new Set(tokenize(t.texts.get(f) || ''));
  noteWords.set(f, words);
  for (const w of words) df.set(w, (df.get(w) || 0) + 1);
}
const rarity = (w) => 1 / Math.max(df.get(w) || 1, 1);

function titleTokens(f) {
  // single words only (no compound bigrams), deduped — for building queries
  return [...new Set(tokenize(f.split('/').pop().replace(/\.md$/, '')).filter((w) => !w.includes(' ')))];
}
function isJunkTitle(f) {
  const b = f.split('/').pop();
  return /\.(docx|pdf|xlsx|pptx|csv)|\(\d+\)|^\d+$|_/i.test(b);
}
function headings(f) {
  return [...(t.texts.get(f) || '').matchAll(/^#{2,4} (.+)$/gm)].map((m) => m[1]);
}
function bodyRareWords(f, fromFraction = 0, minRarity = 0.05) {
  const text = t.texts.get(f) || '';
  const start = Math.floor(text.length * fromFraction);
  const words = tokenize(text.slice(start));
  const uniq = [...new Set(words)];
  return uniq.filter((w) => rarity(w) >= minRarity && !/^\d+$/.test(w)).sort((a, b) => rarity(b) - rarity(a));
}

const EASY_TEMPLATES = [
  (kw) => `what do we know about ${kw}`,
  (kw) => `tell me about ${kw}`,
  (kw) => `${kw}`,
  (kw) => `find the note on ${kw}`,
  (kw) => `what is ${kw}`,
];
const MED_TEMPLATES = [
  (kw) => `what did we say about ${kw}`,
  (kw) => `notes on ${kw}`,
  (kw) => `remind me about ${kw}`,
  (kw) => `details on ${kw}`,
];
const HARD_TEMPLATES = [
  (kw) => `anything about ${kw}?`,
  (kw) => `did we ever mention ${kw}`,
  (kw) => `I vaguely remember something about ${kw}`,
  (kw) => `what was the thing with ${kw}`,
];
const VAGUE_TEMPLATES = [
  (kw) => `where did we stop with ${kw}`,
  (kw) => `latest on ${kw}`,
  (kw) => `status of ${kw}`,
  (kw) => `what happened with ${kw}`,
  (kw) => `${kw}?`,
];

const scenarios = [];
let id = 0;
const add = (tier, question, target, accept) =>
  scenarios.push({ id: ++id, tier, question, target, accept });

// ─── EASY: 2,500 — full title words, distinctive titles ────────────────
{
  const candidates = eligible.filter((f) => titleTokens(f).length >= 2 && !isJunkTitle(f));
  let n = 0;
  while (n < 2500) {
    const f = pick(candidates);
    const tt = titleTokens(f);
    add('easy', pick(EASY_TEMPLATES)(tt.join(' ')), f, 'top1');
    n++;
  }
}

// ─── MEDIUM: 2,500 — heading + partial title, or 3 rare body words ─────
{
  let n = 0;
  const withHeadings = eligible.filter((f) => headings(f).length >= 2);
  while (n < 2500) {
    if (n % 2 === 0 && withHeadings.length) {
      const f = pick(withHeadings);
      const h = tokenize(pick(headings(f))).slice(0, 3);
      const tw = pick(titleTokens(f));
      if (!h.length || !tw) continue;
      add('medium', pick(MED_TEMPLATES)([...h, tw].join(' ')), f, 'top3');
    } else {
      const f = pick(eligible);
      const rare = bodyRareWords(f, 0, 0.08).slice(0, 12);
      if (rare.length < 3) continue;
      add('medium', pick(MED_TEMPLATES)(shuffle(rare).slice(0, 3).join(' ')), f, 'top3');
    }
    n++;
  }
}

// ─── HARD: 2,500 — deep-content rare pairs, alias queries, no title words ──
{
  let n = 0;
  const withAliases = eligible.filter((f) => /^aliases:\s*\[[^\]]+\]/m.test((t.texts.get(f) || '').slice(0, 400)));
  while (n < 2500) {
    const mode = n % 3;
    if (mode === 0 && withAliases.length) {
      // query by alias, never the title
      const f = pick(withAliases);
      const m = (t.texts.get(f) || '').slice(0, 400).match(/^aliases:\s*\[([^\]]*)\]/m);
      const aliases = m[1].split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
      const alias = pick(aliases);
      if (!alias || alias.toLowerCase() === f.split('/').pop().replace(/\.md$/, '').toLowerCase()) continue;
      add('hard', pick(HARD_TEMPLATES)(alias.toLowerCase()), f, 'top3');
    } else if (mode === 1) {
      // rare words from the LAST third of a big note
      const bigs = eligible.filter((f) => (t.texts.get(f) || '').length > 6000);
      const f = pick(bigs.length ? bigs : eligible);
      const rare = bodyRareWords(f, 0.66, 0.1);
      const tSet = new Set(titleTokens(f));
      const nonTitle = rare.filter((w) => !tSet.has(w)).slice(0, 8);
      if (nonTitle.length < 2) continue;
      add('hard', pick(HARD_TEMPLATES)(shuffle(nonTitle).slice(0, 2).join(' ')), f, 'top3');
    } else {
      // two rare words only, no title tokens
      const f = pick(eligible);
      const tSet = new Set(titleTokens(f));
      const rare = bodyRareWords(f, 0.2, 0.12).filter((w) => !tSet.has(w));
      if (rare.length < 2) continue;
      add('hard', pick(HARD_TEMPLATES)(rare.slice(0, 2).join(' ')), f, 'top3');
    }
    n++;
  }
}

// ─── VERY HARD / VAGUE: 1,500 — status intent + single terms ───────────
{
  let n = 0;
  while (n < 1500) {
    const f = pick(eligible);
    if (n % 2 === 0) {
      const tt = titleTokens(f);
      if (!tt.length) continue;
      add('vague', pick(VAGUE_TEMPLATES)(pick(tt)), f, 'top5-or-folder');
    } else {
      const rare = bodyRareWords(f, 0, 0.15);
      if (!rare.length) continue;
      add('vague', pick(VAGUE_TEMPLATES)(rare[0]), f, 'top5-or-folder');
    }
    n++;
  }
}

// ─── NEGATIVE: 1,000 — invented entities, must answer not-in-brain ─────
{
  const inventedBases = [
    'zorblatt', 'quixmire', 'flembocker', 'drazzlewick', 'vompettra', 'skarnfluke',
    'plimberjack', 'wuzzleforth', 'grimpettle', 'xanthoquill', 'brellivane', 'snorkelbast',
  ];
  let n = 0;
  while (n < 1000) {
    const a = pick(inventedBases) + Math.floor(rand() * 90 + 10);
    const b = pick(inventedBases);
    // Verify genuinely absent from the corpus
    if (df.has(a) || df.has(b)) continue;
    const q = pick([
      `what did we decide about ${a} ${b}`,
      `status of the ${b} project ${a}`,
      `tell me about ${a}`,
      `notes on ${b} ${a} integration`,
    ]);
    add('negative', q, null, 'not-in-brain');
    n++;
  }
}

await fs.writeFile(outPath, JSON.stringify({ brain: brainPath, generatedAt: 'seeded-deterministic', scenarios }, null, 0));
const byTier = {};
for (const s of scenarios) byTier[s.tier] = (byTier[s.tier] || 0) + 1;
console.error(`Wrote ${scenarios.length} scenarios to ${outPath}:`, JSON.stringify(byTier));
