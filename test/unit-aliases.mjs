// Regression test for src/core/aliases.ts — the module had NO coverage, which is
// exactly why two HIGH bugs shipped in it.
//
// Aliases decide which note a [[wikilink]] resolves to, feed entity dedup and the
// glossary, and drive auto-link WRITES. So a dropped alias is a link that silently
// stops resolving, and a phantom alias is a link that resolves to the WRONG note —
// and then gets written into the user's files.
//
// The two shipped bugs:
//   1. block form required a bare LF after `aliases:`, so EVERY Windows-authored
//      (CRLF) note lost its aliases entirely;
//   2. flow form split on every comma with no quote awareness, so `["Smith, John"]`
//      — the exact form OUR OWN serializer emits — became "Smith" + "John".
//
// The invariant worth holding on to: aliasesOf must agree with what gray-matter
// (the real YAML parser used everywhere else) sees. Where they disagree, the brain
// disagrees with itself.
//   node test/unit-aliases.mjs
import { aliasesOf } from '../src/core/aliases.ts';
import { parseNote, serializeNote } from '../src/core/frontmatter.ts';

let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (extra ? '  ' + extra : '')); } };
const eq = (n, got, want) => ok(n, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

// ── the CRLF regression ──────────────────────────────────────────────────────
const crlf = '---\r\ntype: person\r\naliases:\r\n  - Bobby\r\n  - Bob S\r\nstatus: active\r\n---\r\n\r\nbody\r\n';
eq('block aliases survive CRLF line endings', aliasesOf(crlf), ['Bobby', 'Bob S']);
const lf = crlf.replace(/\r\n/g, '\n');
eq('block aliases still work with LF', aliasesOf(lf), ['Bobby', 'Bob S']);
ok('CRLF and LF agree', JSON.stringify(aliasesOf(crlf)) === JSON.stringify(aliasesOf(lf)));

// ── the quoted-comma regression ──────────────────────────────────────────────
eq('a double-quoted alias containing a comma stays one alias',
  aliasesOf('---\naliases: ["Smith, John"]\n---\n'), ['Smith, John']);
eq('single-quoted too, alongside a bare one',
  aliasesOf("---\naliases: ['Smith, John', Bobby]\n---\n"), ['Smith, John', 'Bobby']);
eq('brackets inside a quoted alias do not end the list',
  aliasesOf('---\naliases: ["Smith [Jr]", Bobby]\n---\n'), ['Smith [Jr]', 'Bobby']);

// ── the apostrophe regression ────────────────────────────────────────────────
// Fixing the comma split introduced its own: a quote ANYWHERE in an item was
// read as opening a YAML scalar. YAML only lets a quote quote at the START of a
// flow node; elsewhere it is literal text — and apostrophes are ordinary People/
// content. An odd count ran off the end of the list and dropped EVERY alias; an
// even count fused two items into one phantom alias, which is the worse half
// (a phantom alias gets WRITTEN into the owner's file by the auto-linker).
eq("an apostrophe mid-item does not open a quote (odd count)",
  aliasesOf("---\naliases: [O'Brien, Doc]\n---\n"), ["O'Brien", 'Doc']);
eq("a lone apostrophe-bearing alias survives",
  aliasesOf("---\naliases: [O'Brien]\n---\n"), ["O'Brien"]);
eq("an even count does not fuse two items into one phantom alias",
  aliasesOf("---\naliases: [Dad's Clinic, Mum's Clinic]\n---\n"), ["Dad's Clinic", "Mum's Clinic"]);
eq("a year apostrophe is literal too",
  aliasesOf("---\naliases: [Q1'26, Bobby]\n---\n"), ["Q1'26", 'Bobby']);
eq('the same holds for a mid-item double quote',
  aliasesOf('---\naliases: [5" pipe, Bobby]\n---\n'), ['5" pipe', 'Bobby']);
// …while a quote that IS at the start still quotes, including next to a literal one.
eq('a literal apostrophe and a real quoted scalar coexist',
  aliasesOf("---\naliases: [Dad's, 'x, y']\n---\n"), ["Dad's", 'x, y']);
eq("YAML's '' escape inside a properly quoted scalar still unescapes",
  aliasesOf("---\naliases: ['O''Brien', Bobby]\n---\n"), ["O'Brien", 'Bobby']);
// …and the escape must survive the start-of-item rule that fixed the apostrophe case. It did not:
// the escape's FIRST quote closed the scalar (the second could no longer re-open it, since `cur`
// was non-empty), so everything after was scanned unquoted and a comma or ']' inside the alias
// split the list. The case above hid it because its comma falls AFTER the closing quote.
eq("the '' escape with a comma INSIDE the same scalar",
  aliasesOf("---\naliases: ['O''Brien, Ltd', Bobby]\n---\n"), ["O'Brien, Ltd", 'Bobby']);
eq("the '' escape with a bracket inside the scalar",
  aliasesOf("---\naliases: ['Acme [Q1''26]']\n---\n"), ["Acme [Q1'26]"]);

// ── flow list on the line BELOW the key ──────────────────────────────────────
// Valid YAML that gray-matter reads fine; a too-tight open regex matched neither
// the flow nor the block pattern and returned no aliases at all.
eq('flow list on the next line', aliasesOf('---\naliases:\n  [Bobby, Bob S]\n---\nbody\n'), ['Bobby', 'Bob S']);
eq('flow list on the next line, CRLF',
  aliasesOf('---\r\naliases:\r\n  [Bobby, Bob S]\r\n---\r\nbody\r\n'), ['Bobby', 'Bob S']);
// The indent is what makes that safe: an UNindented `[` belongs to the next key.
eq('a following key\'s flow list is not stolen', aliasesOf('---\naliases:\ntags: [a, b]\n---\n'), []);
eq('a nested aliases key does not match', aliasesOf('---\nmeta:\n  aliases: [X]\n---\n'), []);
eq('an empty key above a block list still reads the block',
  aliasesOf('---\naliases:\n  - One\n  - Two\ntags:\n  [a, b]\n---\n'), ['One', 'Two']);

// ── round-trip against our OWN writer ────────────────────────────────────────
// This is the case that proves real vaults already contain the breaking input:
// serializeNote quotes a comma-bearing alias, so we must be able to read it back.
for (const alias of ['Smith, John', "O'Brien", 'Al-Rashid, Omar', 'Acme [Holdings]', 'a: b']) {
  const text = serializeNote({ frontmatter: { type: 'person', aliases: [alias] }, body: '\nbody\n' });
  eq(`round-trip through serializeNote: ${JSON.stringify(alias)}`, aliasesOf(text), [alias]);
}

// ── agreement with the real YAML parser ──────────────────────────────────────
for (const [name, text] of [
  ['block form', '---\naliases:\n  - One\n  - Two\n---\n'],
  ['flow form', '---\naliases: [One, Two]\n---\n'],
  ['CRLF block', '---\r\naliases:\r\n  - One\r\n  - Two\r\n---\r\n'],
  ['quoted comma', '---\naliases: ["One, Two"]\n---\n'],
  ["apostrophe in a plain scalar", "---\naliases: [O'Brien, Doc]\n---\n"],
  ["two apostrophes", "---\naliases: [Dad's Clinic, Mum's Clinic]\n---\n"],
  ["apostrophe beside a quoted item", "---\naliases: [Q1'26, 'One, Two']\n---\n"],
  ['double quote in a plain scalar', '---\naliases: [5" pipe, Bobby]\n---\n'],
  ['flow list on the next line', '---\naliases:\n  [One, Two]\n---\n'],
  ['flow list on the next line, CRLF', '---\r\naliases:\r\n  [One, Two]\r\n---\r\n'],
  ['flow list spanning lines', '---\naliases: [One,\n  Two]\n---\n'],
]) {
  const viaYaml = parseNote('x.md', text).frontmatter.aliases ?? [];
  eq(`agrees with gray-matter (${name})`, aliasesOf(text), viaYaml);
}

// ── degenerate input must not throw or invent ────────────────────────────────
eq('no aliases key', aliasesOf('---\ntype: person\n---\n'), []);
eq('empty flow list', aliasesOf('---\naliases: []\n---\n'), []);
eq('no frontmatter at all', aliasesOf('just a body\n'), []);
ok('unterminated flow list does not throw', Array.isArray(aliasesOf('---\naliases: [One, Two\n---\n')));

console.log(`\naliases: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
