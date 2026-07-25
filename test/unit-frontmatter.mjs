// Round-trip tests for the frontmatter serializer (P1: nested YAML must survive an agent rewrite,
// not collapse to a quoted JSON string). parse(serialize(note)).frontmatter must deep-equal the
// original for every JSON-representable shape.
//   node test/unit-frontmatter.mjs
import { parseNote, serializeNote } from '../src/core/frontmatter.ts';

let pass = 0,
  fail = 0;
const ok = (n, c, extra = '') => {
  if (c) {
    pass++;
    console.log('  ✓ ' + n);
  } else {
    fail++;
    console.log('  ✗ ' + n + ' ' + extra);
  }
};

// Round-trip: build a note, serialize, re-parse, compare frontmatter deep-equal.
const roundtrip = (name, fm) => {
  const out = serializeNote({ path: 'T.md', frontmatter: fm, body: 'body\n', rawFile: false });
  const back = parseNote('T.md', out);
  const same = JSON.stringify(back.frontmatter) === JSON.stringify(fm);
  ok(name, same && !back.rawFile, same ? '' : `\n    got: ${out.replace(/\n/g, '\\n')}\n    parsed: ${JSON.stringify(back.frontmatter)}`);
  return out;
};

roundtrip('flat scalars', { type: 'note', pinned: true, count: 3 });
roundtrip('array of scalars (flow)', { tags: ['a', 'b', 'c'], aliases: ['Smith, John'] });
roundtrip('nested map', { meta: { author: 'X', source: 'web' }, type: 'ref' });
roundtrip('map with an inner array', { meta: { author: 'X', tags: ['a', 'b'] } });
roundtrip('array of objects (block)', { links: [{ to: 'A', kind: 'ref' }, { to: 'B', kind: 'moc' }] });
roundtrip('deeply nested', { a: { b: { c: 1, d: ['x', 'y'] }, e: 'f' }, g: 2 });
roundtrip('array of objects with nested map', { items: [{ name: 'X', meta: { a: 1 }, z: 2 }, { name: 'Y' }] });
roundtrip('array of arrays of scalars', { grid: [[1, 2], [3, 4]] });
roundtrip('array of arrays of objects (nested sequence — P1 review high)', { matrix: [[{ x: 1, y: 2 }]] });
roundtrip('deeply nested sequences + maps', { a: [[{ b: [{ c: 1 }] }]], d: 2 });
roundtrip('null field preserved', { type: 'note', due: null });
roundtrip('empty map + empty array', { meta: {}, tags: [] });
roundtrip('special chars in values', { title: 'a: b, c #d', note: 'ends with space ', num_str: '007' });
roundtrip('date-shaped string stays a string', { updated: '2026-07-24', date: '2026-01-02' });
roundtrip('numeric/date-shaped KEYS stay strings (not renamed)', { codes: { '007': 'James', '1.0': 'first', '2026-01-02': 'newyear' }, type: 'ref' });
// leading YAML-indicator keys ("- y", "? x") must be quoted or the whole block collapses on rewrite
roundtrip('leading-indicator KEYS stay strings (no block collapse)', { '- y': 2, '? x': 1, ': z': 3, normal: 'ok' });

// The headline case: an agent stamps updated_by/updated on a note that has nested human frontmatter.
// The nested structure MUST be preserved (this is exactly what the old serializer broke).
const human = { type: 'reference', meta: { author: 'Sam', tags: ['ai', 'notes'] }, links: [{ to: 'MOC', kind: 'moc' }] };
const stamped = { ...structuredClone(human), updated_by: 'ChatGPT (Cursor)', updated: '2026-07-24' };
const out = roundtrip('agent stamp keeps nested frontmatter intact', stamped);
ok('nested map NOT flattened to a JSON string', !/meta:\s*"\{/.test(out) && /meta:\n\s+author: Sam/.test(out), out.replace(/\n/g, '\\n'));
ok('array of objects NOT flattened to a JSON string', !/links:\s*"\[/.test(out) && /links:\n\s+- to: MOC/.test(out), out.replace(/\n/g, '\\n'));

// REGRESSION (P2-A review high): gray-matter memoizes by content string, and a malformed `---` note
// THREW only on its first parse — a warm-cache re-parse would return {data:{}} without throwing and
// flip rawFile:true→false, bypassing the write tools' malformed-refusal / forgery guard. It must now
// classify rawFile (and NOT adoptable) on EVERY parse.
const malformed = '---\ntags: [a: b: c]\ncreated_by: The Human\n---\n\nbody';
let allRaw = true, noneAdoptable = true;
for (let i = 0; i < 4; i++) { const p = parseNote('M.md', malformed); if (!p.rawFile) allRaw = false; if (p.noFrontmatter) noneAdoptable = false; }
ok('malformed frontmatter stays rawFile across repeated parses (no memoization flip)', allRaw);
ok('malformed frontmatter is never flagged adoptable', noneAdoptable);
// a genuine no-frontmatter note stays adoptable across repeated parses too
let allNF = true;
for (let i = 0; i < 3; i++) if (!parseNote('P.md', 'plain legacy note\n').noFrontmatter) allNF = false;
ok('no-frontmatter note stays adoptable across parses', allNF);

// Body is preserved verbatim.
const withBody = serializeNote({ path: 'T.md', frontmatter: { a: 1 }, body: '# Heading\n\nSome text.\n', rawFile: false });
ok('body preserved verbatim', withBody.endsWith('# Heading\n\nSome text.\n'), JSON.stringify(withBody));

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
console.log('  ALL PASS');
