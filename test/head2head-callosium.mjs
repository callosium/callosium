// Callosium contestant's ONLY interface for the head-to-head. Wraps the SAME
// engine functions the MCP server exposes, so "the Callosium agent" == "an AI
// armed with the Callosium MCP". No grep, no raw file walking — retrieval only.
//   node test/head2head-callosium.mjs <tool> [args...]
// Tools:
//   list [prefix] [limit]     — notes under prefix, NEWEST-FIRST by mtime, with dates
//   recall "<question>"       — deterministic recall (graph + semantic), evidence + excerpts
//   search "<query>" [limit]  — ranked lexical hits + snippets
//   read "<path>" [section]   — one note; large notes return outline+opening (add "whole" to force full)
//   overview                  — partitions + note counts + newest notes
import { promises as fs } from 'node:fs';
import { Vault } from '../src/core/vault.ts';
import { loadTexts, recall, searchNotes } from '../src/recall/engine.ts';
import { buildGraph, loadGraph } from '../src/graph/index.ts';
import { loadEmbeddings } from '../src/recall/semantic.ts';
import { noteView } from '../src/mcp/server.ts';
import { loadSchema } from '../src/core/schema.ts';
import { generateMap, generateFilingRules } from '../src/structure/map.ts';
import { noteDateMs, noteDateInfo, parsePeriod, noteTitle, bodyEventDates } from '../src/recall/temporal.ts';

const BRAIN = process.env.CALLOSIUM_BRAIN || process.env.CALLOSIUM_BRAIN;
const [tool, ...rest] = process.argv.slice(2);
const vault = Vault.open(BRAIN);
const iso = (ms) => (ms ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') : '????-??-?? ??:??');

if (tool === 'map') {
  const texts = await loadTexts(vault);
  const { schema } = await loadSchema(vault);
  console.log(generateMap(schema, texts));
} else if (tool === 'rules') {
  const { schema } = await loadSchema(vault);
  console.log(generateFilingRules(schema));
} else if (tool === 'list') {
  const prefix = rest[0] && !/^\d+$/.test(rest[0]) ? rest[0] : '';
  const limit = Number(rest.find((a) => /^\d+$/.test(a)) || 60);
  const texts = await loadTexts(vault);
  const rows = texts.files
    .filter((f) => (prefix ? f.startsWith(prefix) : true) && !f.startsWith('System/'))
    .map((f) => ({ f, m: texts.mtimes.get(f) ?? 0 }))
    .sort((a, b) => b.m - a.m)
    .slice(0, limit);
  for (const r of rows) console.log(`${iso(r.m)}  ${r.f}`);
} else if (tool === 'recall') {
  const q = rest.join(' ');
  const texts = await loadTexts(vault);
  const graph = (await loadGraph(vault)) ?? (await buildGraph(vault)).index;
  const emb = await loadEmbeddings(vault);
  const a = await recall(q, texts, graph, false, emb);
  if (!a.found) { console.log(`NOT IN THE BRAIN — ${a.notInBrainReason ?? ''}`); }
  else for (const r of a.results) {
    console.log(`\n═ ${r.path} [${r.createSafety}]`);
    console.log(r.excerpt.slice(0, 900));
  }
} else if (tool === 'search') {
  const limit = Number(rest.find((a) => /^\d+$/.test(a)) || 20);
  const q = rest.filter((a) => !/^\d+$/.test(a)).join(' ');
  const texts = await loadTexts(vault);
  for (const h of searchNotes(q, texts, limit)) console.log(`${h.path}\n   ${(h.snippet || '').slice(0, 160)}`);
} else if (tool === 'read') {
  const path = rest[0];
  const opt = rest[1];
  const raw = await vault.readFileRetry(path);
  const view = opt === 'whole' ? noteView(raw, { whole: true }) : opt ? noteView(raw, { section: opt }) : noteView(raw);
  console.log(view);
} else if (tool === 'overview') {
  const texts = await loadTexts(vault);
  const parts = {};
  for (const f of texts.files) { const p = f.split('/')[0]; parts[p] = (parts[p] || 0) + 1; }
  console.log('PARTITIONS:', JSON.stringify(parts, null, 1));
  const newest = texts.files.map((f) => ({ f, m: texts.mtimes.get(f) ?? 0 })).sort((a, b) => b.m - a.m).slice(0, 15);
  console.log('\nNEWEST:');
  for (const r of newest) console.log(`  ${iso(r.m)}  ${r.f}`);
} else if (tool === 'recent') {
  // MIRROR of the MCP `recent` tool (src/mcp/server.ts) — kept in sync so the
  // head-to-head measures the SAME retrieval the product ships. No agent scope
  // here (the DIY/grep baseline has none either); System/Raw/archived excluded.
  const q = rest.join(' ');
  const now = Date.now();
  const period = parsePeriod(q, now);
  if (!period) { console.log('No time window in the question; use recall/search.'); }
  else {
    const texts = await loadTexts(vault);
    const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
    const STOP = new Set(['what','did','does','was','were','have','has','had','the','and','for','over','last','past','previous','recent','recently','lately','day','days','week','weeks','month','months','two','yesterday','today','this','that','happen','happened','across','get','give','our','with','how','when','since','ago','you','work','working','worked','done','are','real','really','movement','moved','move','moving','active','actively','right','now','current','currently','still','actually','genuine','genuinely','going','progress','update','updates','new','latest','been','about','made','make','any','some','thing','things','stuff','there']);
    const topic = [...new Set((q.toLowerCase().match(/[a-z0-9]{3,}/g) || []).filter((w) => !STOP.has(w)))];
    const topicRes = topic.map((w) => new RegExp('\\b' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b'));
    const topicMatch = (f, text) => topicRes.length > 0 && topicRes.some((re) => re.test((f + ' ' + text.slice(0, 500)).toLowerCase()));
    const frontByDate = new Map();
    const cands = [];
    for (const f of texts.files) {
      if (f.startsWith('System/') || /\/Raw\//.test(f) || texts.archived.has(f)) continue;
      const text = texts.texts.get(f) || '';
      const di = noteDateInfo(f, text);
      const inWindow = !!di && di.ms >= period.fromMs && di.ms <= period.toMs;
      if (inWindow && di.source === 'front') { const d = isoDay(di.ms); frontByDate.set(d, (frontByDate.get(d) || 0) + 1); }
      const passTopic = topic.length === 0 ? true : topicMatch(f, text);
      if (inWindow && passTopic) cands.push({ f, text, di, inWindow: true });
      else if (!inWindow && topic.length > 0 && topicMatch(f, text)) cands.push({ f, text, di, inWindow: false });
    }
    const bulkDates = new Set([...frontByDate].filter(([, c]) => c >= 8).map(([d]) => d));
    const isBulkFront = (di, inWindow) => inWindow && !!di && di.source === 'front' && bulkDates.has(isoDay(di.ms));
    const scanSet = cands
      .filter((c) => (c.inWindow && isBulkFront(c.di, true)) || !c.inWindow)
      .sort((a, b) => (b.di?.ms ?? 0) - (a.di?.ms ?? 0))
      .slice(0, 400);
    const eventsByPath = new Map();
    for (const c of scanSet) { const ev = bodyEventDates(c.text, period.fromMs, now); if (ev.length) eventsByPath.set(c.f, ev); }
    const eventAnnot = (e) => `  ⟨in note: ${e.iso} — "${e.snippet}"⟩`;
    const rows = [];
    for (const c of cands) {
      const ev = eventsByPath.get(c.f);
      const title = noteTitle(c.f, c.text);
      if (!c.inWindow) { if (!ev) continue; rows.push({ f: c.f, title, rowMs: ev[0].ms, date: ev[0].iso, tier: 0, kind: 'event', annot: eventAnnot(ev[0]) }); continue; }
      const di = c.di;
      const bulk = isBulkFront(di, true);
      if (bulk && ev) { const rowMs = Math.max(di.ms, ev[0].ms); rows.push({ f: c.f, title, rowMs, date: isoDay(rowMs), tier: 0, kind: 'event', annot: eventAnnot(ev[0]) }); }
      else if (di.source !== 'front') rows.push({ f: c.f, title, rowMs: di.ms, date: isoDay(di.ms), tier: 0, kind: 'artifact', annot: '' });
      else if (!bulk) rows.push({ f: c.f, title, rowMs: di.ms, date: isoDay(di.ms), tier: 1, kind: 'front', annot: '' });
      else rows.push({ f: c.f, title, rowMs: di.ms, date: isoDay(di.ms), tier: 2, kind: 'bulk', annot: '  [bulk]' });
    }
    const kindRank = (k) => (k === 'artifact' ? 0 : 1);
    rows.sort((a, b) => a.tier - b.tier || b.rowMs - a.rowMs || kindRank(a.kind) - kindRank(b.kind));
    const out = rows.slice(0, 40);
    const hasEvents = out.some((r) => r.kind === 'event');
    const shownBulk = [...new Set(out.filter((r) => r.kind === 'bulk').map((r) => r.date))];
    console.log(`${out.length} notes with activity in ${period.label}${topic.length ? ' matching ' + topic.join('/') : ''}, real activity first${hasEvents ? ' (⟨in note: DATE⟩ = a dated event in the body within the window even if the file is older)' : ''}${shownBulk.length ? ' (' + shownBulk.join(', ') + ' = likely bulk edit, flagged [bulk]; READ them, a note can be bulk-edited AND worked on)' : ''}:`);
    for (const r of out) console.log(`${r.date}  ${r.f}  — ${r.title}${r.annot}`);
  }
} else if (tool === 'gather') {
  const topic = rest.join(' ');
  const texts = await loadTexts(vault);
  const hits = searchNotes(topic, texts, 12);
  const terms = topic.toLowerCase().match(/[a-z0-9]{3,}/g) || [];
  const excerpt = (text) => {
    const body = text.replace(/^---[\s\S]*?\n---\n?/, '');
    const low = body.toLowerCase();
    let at = -1;
    for (const w of terms) { const p = low.indexOf(w); if (p >= 0 && (at < 0 || p < at)) at = p; }
    const start = at < 0 ? 0 : Math.max(0, body.lastIndexOf('\n', at) + 1);
    return body.slice(start, start + 480).replace(/\s+/g, ' ').trim();
  };
  console.log(`${hits.length} most relevant notes for "${topic}" — read the ones you need in full:\n`);
  for (const h of hits) {
    const text = texts.texts.get(h.path) || '';
    const d = noteDateMs(h.path, text);
    console.log(`● ${h.path}${d ? '  (' + new Date(d).toISOString().slice(0, 10) + ')' : ''}\n  ${excerpt(text)}\n`);
  }
} else if (tool === 'skills') {
  const texts = await loadTexts(vault);
  const skills = [];
  for (const f of texts.files) {
    const seg = f.split('/');
    if (seg[seg.length - 1].toLowerCase() !== 'skill.md') continue;
    if ((seg[seg.length - 3] || '').toLowerCase() !== 'skills') continue;
    const text = texts.texts.get(f) || '';
    const fm = text.match(/^---\n([\s\S]*?)\n---/);
    const block = fm ? fm[1] : text.slice(0, 800);
    const name = (block.match(/^name:\s*["']?(.+?)["']?\s*$/im)?.[1] || f.split('/').slice(-2, -1)[0] || '').trim();
    let desc = '';
    const lines = block.split('\n');
    const di = lines.findIndex((l) => /^description:/i.test(l));
    if (di >= 0) {
      const inline = lines[di].replace(/^description:\s*/i, '').trim();
      if (inline && !/^[|>]/.test(inline)) desc = inline.replace(/^["']|["']$/g, '');
      else { const body = []; for (let j = di + 1; j < lines.length && /^\s/.test(lines[j]); j++) body.push(lines[j].trim()); desc = body.join(' '); }
    }
    skills.push({ name, path: f, description: desc.slice(0, 280) });
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  console.log(`${skills.length} skills available:`);
  for (const s of skills) console.log(`● ${s.name}\n  ${s.description}\n  → read "${s.path}"\n`);
} else {
  console.log('tools: list | recall | search | read | overview | recent | gather | skills | map');
  process.exit(2);
}
