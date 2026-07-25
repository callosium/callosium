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

// ── round-trip against our OWN writer ────────────────────────────────────────
// This is the case that proves real vaults already contain the breaking input:
// serializeNote quotes a comma-bearing alias, so we must be able to read it back.
for (const alias of ['Smith, John', "O'Brien", 'Al-Mannai, Hamza', 'Acme [Holdings]', 'a: b']) {
  const text = serializeNote({ frontmatter: { type: 'person', aliases: [alias] }, body: '\nbody\n' });
  eq(`round-trip through serializeNote: ${JSON.stringify(alias)}`, aliasesOf(text), [alias]);
}

// ── agreement with the real YAML parser ──────────────────────────────────────
for (const [name, text] of [
  ['block form', '---\naliases:\n  - One\n  - Two\n---\n'],
  ['flow form', '---\naliases: [One, Two]\n---\n'],
  ['CRLF block', '---\r\naliases:\r\n  - One\r\n  - Two\r\n---\r\n'],
  ['quoted comma', '---\naliases: ["One, Two"]\n---\n'],
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
