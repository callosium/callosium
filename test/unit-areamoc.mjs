// Unit test for area-MOC detection: isAreaMoc naming, and hubForNote preferring a
// folder's own area map over an arbitrary sibling sub-map (the fix for a new venture
// getting parented under an unrelated topic).  node test/unit-areamoc.mjs

import { isAreaMoc, hubForNote } from '../src/structure/map.ts';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n); } };

// ── isAreaMoc: a hub named after its folder governs the area ──
ok('area map: "Initiatives MOC" governs Initiatives/', isAreaMoc('Initiatives MOC', 'Initiatives'));
ok('area map: "Initiatives Home" governs Initiatives/', isAreaMoc('Initiatives Home', 'Initiatives'));
ok('area map: "Knowledge MOC" governs Knowledge/', isAreaMoc('Knowledge MOC', 'Knowledge'));
ok('area map: "Memory Hub" governs Memory/', isAreaMoc('Memory Hub', 'Memory'));
ok('area map: "Log Index" governs Logs/ (plural tolerance)', isAreaMoc('Log Index', 'Logs'));
ok('NOT an area map: a sub-topic MOC in the same folder', !isAreaMoc('LinkedIn Brand MOC', 'Initiatives'));
ok('NOT an area map: "Overview" does not name-match Work', !isAreaMoc('Overview', 'Work'));
ok('NOT an area map: empty hub name', !isAreaMoc('', 'Initiatives'));

// ── hubForNote: prefer the area map over a sibling sub-map ──
const texts = new Map([
  ['Initiatives/LinkedIn Brand MOC.md', '---\ntype: moc\n---\n# LinkedIn brand'],
  ['Initiatives/Initiatives MOC.md', '---\ntype: moc\n---\n# Initiatives MOC'],
  ['Initiatives/Arabic Voice Dictation/Arabic Voice Dictation Home.md', '---\ntype: moc\n---\n# AVD Home'],
  ['Initiatives/Arabic Voice Dictation/Roadmap.md', '# roadmap'],
]);
const vt = { files: [...texts.keys()], texts };

// A fresh note directly in Initiatives/ must be nudged toward the AREA map, NOT the
// LinkedIn sub-MOC that happens to sort first — the exact bug this change fixes.
ok('hubForNote picks the area map, not the sibling sub-MOC',
  hubForNote('Initiatives/Bootstrapped SaaS.md', vt) === 'Initiatives MOC');

// A note deeper in a subfolder still resolves to its nearest area map when its own
// folder has no other hub (walks up to Initiatives/, prefers the area map).
ok('hubForNote from a subfolder note prefers the area map at the partition root',
  hubForNote('Initiatives/Arabic Voice Dictation/Roadmap.md', vt) === 'Arabic Voice Dictation Home');

// Without the area map present, it falls back to the sole sub-hub — no regression for
// brains that don't have area maps yet.
const files2 = vt.files.filter((f) => !/Initiatives MOC/.test(f));
const texts2 = new Map([...texts].filter(([k]) => !/Initiatives MOC/.test(k)));
ok('hubForNote falls back to the first hub when no area map exists (no regression)',
  hubForNote('Initiatives/Bootstrapped SaaS.md', { files: files2, texts: texts2 }) === 'LinkedIn Brand MOC');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
