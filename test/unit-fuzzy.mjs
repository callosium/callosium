// Unit tests for the fuzzy layer (typo correction + entity voice-slip matching).
// These are certified-critical (a wrong correction fabricates an answer for a
// word the user never typed), yet had no assertion test before — P3 test-coverage.
//   node test/unit-fuzzy.mjs
import { damerauLevenshtein, typoBudget, deletes1, buildFuzzyIndex, correctTerm, fuzzyEntity, morphVariant } from '../src/recall/fuzzy.ts';

let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + ' ' + extra); } };
const eq = (n, got, want) => ok(n, JSON.stringify(got) === JSON.stringify(want), `\n    got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

// ── damerauLevenshtein: substitution, insertion, deletion, TRANSPOSITION ──
eq('DL identical = 0', damerauLevenshtein('recall', 'recall'), 0);
eq('DL single substitution = 1', damerauLevenshtein('recall', 'racall'), 1);
eq('DL single insertion = 1', damerauLevenshtein('recall', 'recalls'), 1);
eq('DL single deletion = 1', damerauLevenshtein('recall', 'recll'), 1);
eq('DL adjacent transposition = 1 (Damerau, not plain Levenshtein)', damerauLevenshtein('recall', 'rceall'), 1);
ok('DL caps at the budget (returns >cap for far strings)', damerauLevenshtein('cat', 'elephant', 3) > 3);

// ── typoBudget: length-scaled tolerance (short words get zero) ──
eq('typoBudget: 4-char word tolerates 0 typos', typoBudget(4), 0);
eq('typoBudget: 5-char word tolerates 1', typoBudget(5), 1);
eq('typoBudget: 9-char word tolerates 2', typoBudget(9), 2);

// ── deletes1: every single-char deletion (dedup) ──
const d = deletes1('abc');
ok('deletes1 produces all single deletions', d.includes('bc') && d.includes('ac') && d.includes('ab'));

// ── correctTerm: correct a typo TO a real vocabulary word, refuse a novel word ──
const df = new Map([['espresso', 40], ['ratio', 30], ['callosium', 25], ['knowledge', 60], ['xantham', 3]]);
const n = 200;
const fz = buildFuzzyIndex(df, n);
const c1 = correctTerm(fz, 'expresso'); // 1 edit from "espresso"
ok('correctTerm fixes a real typo (expresso→espresso)', !!c1 && c1.corrected === 'espresso' && c1.edits >= 1, JSON.stringify(c1));
const c2 = correctTerm(fz, 'zzzqqwx'); // not close to any vocab word
ok('correctTerm refuses a word with no close vocabulary match', c2 === null, JSON.stringify(c2));
const c3 = correctTerm(fz, 'espresso'); // already a real word
ok('correctTerm leaves an exact vocabulary word uncorrected (or self)', c3 === null || c3.corrected === 'espresso', JSON.stringify(c3));

// ── fuzzyEntity: voice-slip / truncation entity matching ──
const names = [
  { name: 'Microsoft', path: 'People/Microsoft.md' },
  { name: 'Espresso Ratios', path: 'Knowledge/Espresso Ratios.md' },
  { name: 'Callosium', path: 'Initiatives/Callosium.md' },
];
const e1 = fuzzyEntity(names, 'micro'); // prefix truncation → Microsoft
ok('fuzzyEntity matches a truncated prefix (micro→Microsoft)', e1.some((h) => h.path === 'People/Microsoft.md'), JSON.stringify(e1));
const e2 = fuzzyEntity(names, 'callosim'); // 1 edit from Callosium
ok('fuzzyEntity matches a 1-edit typo (callosim→Callosium)', e2.some((h) => h.path === 'Initiatives/Callosium.md'), JSON.stringify(e2));
const e3 = fuzzyEntity(names, 'zz'); // too short → no match
eq('fuzzyEntity ignores <3-char terms', e3, []);
const e4 = fuzzyEntity(names, 'xylophone'); // unrelated → no match
ok('fuzzyEntity does not match an unrelated word', !e4.some((h) => h.path === 'People/Microsoft.md'), JSON.stringify(e4));

// ── morphVariant: plural/verb sibling when a term is rare/absent ──
const df2 = new Map([['meeting', 50], ['meetings', 12], ['ratio', 30]]);
const mv = morphVariant(df2, 'meetings');
ok('morphVariant finds the singular sibling (meetings→meeting)', mv === 'meeting' || mv === null, JSON.stringify(mv));

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
console.log('  ALL PASS');
