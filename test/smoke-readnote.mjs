// Unit test for read_note's noteView presentation logic.
//   node test/smoke-readnote.mjs
import { noteView, LARGE_NOTE_CHARS } from '../src/mcp/server.ts';

let fail = 0;
const ok = (cond, msg) => { console.log(`${cond ? '✓' : '✗ FAIL'}  ${msg}`); if (!cond) fail++; };

// small note → whole, unchanged
const small = '---\ntype: note\n---\n\n# Hi\n\nshort body.';
ok(noteView(small) === small, 'small note returned whole, byte-identical');

// large note → outline + opening, not the whole thing
const big = '# Top\n\n' + 'A'.repeat(5000) + '\n\n## Pricing\n\n' + 'B'.repeat(5000) + '\n\n### Enterprise\n\n' + 'C'.repeat(5000) + '\n\n## Support\n\n' + 'D'.repeat(5000);
const view = noteView(big);
ok(big.length > LARGE_NOTE_CHARS, `test note is large (${big.length} chars)`);
ok(view.length < big.length, 'large note view is shorter than the whole file');
ok(view.includes('LARGE NOTE'), 'large note view announces itself');
ok(view.includes('Pricing') && view.includes('Enterprise') && view.includes('Support'), 'outline lists all headings');
ok(!view.includes('C'.repeat(200)), 'deep section body NOT dumped in the outline view');

// section extraction → just that section, to the next same/higher heading
const pricing = noteView(big, { section: 'Pricing' });
ok(pricing.startsWith('## Pricing'), 'section view starts at the heading');
ok(pricing.includes('B'.repeat(200)), 'section view contains its own body');
ok(pricing.includes('### Enterprise'), 'section view includes deeper subsection (### under ##)');
ok(!pricing.includes('## Support'), 'section view stops at the next same-level heading');

// substring section match
ok(noteView(big, { section: 'enterp' }).startsWith('### Enterprise'), 'section matches by substring');

// missing section → outline fallback
ok(noteView(big, { section: 'nope' }).includes('not found'), 'missing section falls back to outline');

// offset/limit → exact window with continuation hint
const win = noteView(big, { offset: 0, limit: 100 });
ok(win.includes('[chars 0–100 of'), 'ranged read labels the window');
ok(win.includes('more chars'), 'ranged read hints how to continue');

console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' FAILURES'}`);
process.exit(fail ? 1 : 0);
