// Link-enrichment experiment: wikify a SACRIFICIAL brain copy using the
// deterministic suggestion pipeline, then report what changed. The graph
// gets rebuilt by the next bench run.
//   node test/run-enrich.mjs "<sacrificial brain path>" [--apply]

import { promises as fs } from 'node:fs';
import { Vault } from '../src/core/vault.ts';
import { loadTexts } from '../src/recall/engine.ts';
import { parseNote } from '../src/core/frontmatter.ts';
import { buildLinkerIndex, suggestLinks, applyLinks } from '../src/linking/suggest.ts';

const brainPath = process.argv[2];
const apply = process.argv.includes('--apply');
if (!brainPath || !brainPath.toLowerCase().includes('test-brain')) {
  console.error('Refusing: enrichment writes notes. Point it at the sacrificial test-brain copy only.');
  process.exit(1);
}
const vault = Vault.open(brainPath);
const t = await loadTexts(vault, false);

const ALIAS_RE = /^aliases:\s*\[([^\]]*)\]/m;
const notes = t.files.map((f) => {
  const text = t.texts.get(f) || '';
  const m = text.slice(0, 500).match(ALIAS_RE);
  return {
    path: f,
    text,
    aliases: m ? m[1].split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean) : [],
  };
});

console.error('building linker index...');
const t0 = Date.now();
const index = buildLinkerIndex(notes);
console.error(`index built in ${Date.now() - t0}ms (${index.byFirstToken.size} first-token buckets, ${index.phraseStats.size} phrases with link history)`);

let notesTouched = 0,
  linksAdded = 0;
const samples = [];
for (const n of notes) {
  // never enrich structural/system files
  if (n.path.startsWith('System/') || n.path.startsWith('Templates/')) continue;
  const note = parseNote(n.path, n.text);
  if (note.rawFile) continue; // verbatim reference files stay untouched
  const suggestions = suggestLinks(index, n.path, note.body, 15);
  if (!suggestions.length) continue;
  notesTouched++;
  linksAdded += suggestions.length;
  if (samples.length < 8) samples.push({ note: n.path, links: suggestions.map((s) => `${s.phrase}→${s.target.split('/').pop()}`) });
  if (apply) {
    const fullText = n.text;
    const bodyStart = fullText.indexOf(note.body);
    const newBody = applyLinks(note.body, suggestions);
    const newText = bodyStart >= 0 ? fullText.slice(0, bodyStart) + newBody : newBody;
    await vault.writeFile(n.path, newText);
  }
}

console.log(`${apply ? 'APPLIED' : 'DRY RUN'}: ${linksAdded} links across ${notesTouched} notes (of ${notes.length})`);
for (const s of samples) {
  console.log(`  ${s.note}`);
  for (const l of s.links.slice(0, 4)) console.log(`     + ${l}`);
}
