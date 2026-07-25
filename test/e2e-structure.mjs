// End-to-end structure-propagation test: creating notes/subfolders via MCP keeps
// the vault map live (get_map regenerates + persists System/Map.md), surfaces
// subfolders on the map, nudges the AI to wire a note into its topic hub, and
// flags an unwired note in brain_check.  node test/e2e-structure.mjs <fixture-dir>

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repo, 'src', 'cli.ts');
const fixture = path.resolve(process.argv[2] || path.join(repo, 'test', '.fixture-structure'));

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
};
const text = (r) => r.content[0].text;
const mapFile = path.join(fixture, 'System', 'Map.md');
const readMap = () => fs.readFile(mapFile, 'utf8').catch(() => '');

// ─── setup ────────────────────────────────────────────────────────────
await fs.rm(fixture, { recursive: true, force: true });
execFileSync('node', [cli, 'init', fixture], { stdio: 'pipe' });
execFileSync('node', [cli, 'pair', 'test-claude', 'Claude (Test)', '--brain', fixture], { stdio: 'pipe' });
const reg = JSON.parse(await fs.readFile(path.join(fixture, 'System', 'agents.json'), 'utf8'));
const token = reg.agents[0].token;

const transport = new StdioClientTransport({
  command: 'node',
  args: [cli, 'mcp', '--brain', fixture, '--agent', 'test-claude', '--token', token],
});
const client = new Client({ name: 'e2e-structure', version: '0.0.0' });
await client.connect(transport);
const getMap = async () => text(await client.callTool({ name: 'get_map', arguments: {} }));

// ─── A: a new note in a new subfolder → folder created; get_map persists the map ──
const w1 = await client.callTool({
  name: 'write_note',
  arguments: { path: 'Ventures/Callosium/Note One.md', content: 'First note about the Callosium venture. Early access ships in August.' },
});
ok('write_note creates a note at a nested subfolder path', /Created: Ventures\/Callosium\/Note One\.md/.test(text(w1)), text(w1));
ok('the new subfolder actually exists on disk', await fs.stat(path.join(fixture, 'Ventures', 'Callosium')).then((s) => s.isDirectory()).catch(() => false));

// The map file is refreshed when the map is CONSULTED (get_map) — the canonical
// "read the map" call the structuring flow makes after filing — not per write.
const gm1 = await getMap();
ok('get_map (live) reflects the new Ventures/ folder', /###\s+Ventures\//.test(gm1), gm1.slice(0, 300));
ok('get_map persisted System/Map.md to disk', /###\s+Ventures\//.test(await readMap()));

// ─── C: a hub, then a note in the same topic → hub nudge fires ────────────
const wMoc = await client.callTool({
  name: 'write_note',
  arguments: { path: 'Ventures/Callosium/Callosium MOC.md', type: 'moc', content: '# Callosium — map of content\n\nThe hub for everything Callosium.' },
});
ok('creating the MOC itself gets NO hub nudge (no pre-existing hub to link into)', !/MAP UPDATE REQUIRED/.test(text(wMoc)), text(wMoc));

const w2 = await client.callTool({
  name: 'write_note',
  // links [[Note One]] so both notes are CONNECTED (not orphans) — a moc-gap is
  // specifically a note that's in the graph yet missing from its topic's hub.
  arguments: { path: 'Ventures/Callosium/Roadmap.md', content: 'Callosium roadmap, see [[Note One]]: engine done, dashboard done, packaging next.' },
});
ok('a new note in a hubbed topic is told to wire into its MOC', /MAP UPDATE REQUIRED[\s\S]*\[\[Callosium MOC\]\]/.test(text(w2)), text(w2));
ok('the hub nudge names the note to link', /\[\[Roadmap\]\]/.test(text(w2)), text(w2));

// Non-vacuous negative: a note in a folder with NO hub gets no MAP UPDATE nudge.
const w3 = await client.callTool({
  name: 'write_note',
  arguments: { path: 'Knowledge/Espresso.md', type: 'knowledge', content: 'Espresso ratio 1:2 pulls sweeter than 1:1.5.' },
});
ok('a note in a hub-less folder gets NO hub nudge', !/MAP UPDATE REQUIRED/.test(text(w3)), text(w3));

// ─── B: the subfolder now has a hub → shows as its own node on the map ────
const gm2 = await getMap();
ok('get_map surfaces the Callosium/ subfolder as its own node', /↳\s+Callosium\//.test(gm2), gm2);
ok('the subfolder node names its hub', /↳\s+Callosium\/[\s\S]*hub:\s*\[\[Callosium MOC\]\]/.test(gm2), gm2);
ok('the persisted map file matches (Callosium/ subfolder present)', /↳\s+Callosium\//.test(await readMap()));

// ─── C: brain_check flags the note the MOC does not link ───────────────────
const bc = await client.callTool({ name: 'brain_check', arguments: {} });
ok('brain_check reports a moc-gap for the unwired note', /moc-gap/.test(text(bc)), text(bc));

// ─── wiring it in clears the gap ───────────────────────────────────────────
await client.callTool({
  name: 'append_note',
  arguments: { path: 'Ventures/Callosium/Callosium MOC.md', content: '- [[Roadmap]]\n- [[Note One]]' },
});
const bc2 = await client.callTool({ name: 'brain_check', arguments: {} });
ok('after wiring the notes into the MOC, Roadmap is no longer a moc-gap', !/Roadmap\.md/.test(text(bc2).split('moc-gap').slice(1).join('')), text(bc2));

// ─── C2: the single-note-links-out-but-not-back case (the Cogfy ERP blind spot) ─
// A LONE note in a fresh subfolder with NO MOC beside it, that links OUT to a hub
// living in a DIFFERENT folder, and is not linked back FROM any hub. It's not an
// orphan (it has an outgoing edge) and count is 1, so the old moc-gap (needs a
// same-folder hub) and hub-gap (needs >=3 notes) both miss it. The one-way-to-the-
// map detector must still flag it at count 1.
await client.callTool({
  name: 'write_note',
  arguments: { path: 'Ventures/Callosium/Deep/Widget.md', content: 'A deep note that reaches UP to the hub: [[Callosium MOC]] — but nothing links back to it yet.' },
});
const bc3 = await client.callTool({ name: 'brain_check', arguments: {} });
const gaps3 = text(bc3).split('moc-gap').slice(1).join('');
ok('a lone note that links to a distant hub but is not linked back is a moc-gap', /Widget\.md/.test(gaps3), text(bc3));
ok('the finding says the map does not link back (the one-way detector, not the beside-a-MOC one)', /doesn.t link back/.test(text(bc3)), text(bc3));

// wiring it into the hub (inbound link FROM the hub) clears the gap
await client.callTool({
  name: 'append_note',
  arguments: { path: 'Ventures/Callosium/Callosium MOC.md', content: '- [[Widget]]' },
});
const bc4 = await client.callTool({ name: 'brain_check', arguments: {} });
ok('after the hub links back, Widget is no longer a moc-gap', !/Widget\.md/.test(text(bc4).split('moc-gap').slice(1).join('')), text(bc4));

await client.close();
await transport.close?.();

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
