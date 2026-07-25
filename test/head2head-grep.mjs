// The BASELINE contestant for the head-to-head: an AI with ONLY grep / ls / cat
// over the raw vault — no Callosium engine, no graph, no semantic recall. Same
// verb surface as head2head-callosium.mjs so the comparison isolates RETRIEVAL
// QUALITY, not tool ergonomics. Private/ and System/ are excluded (a scoped
// agent can't read them under Callosium either).
//   node test/head2head-grep.mjs <tool> [args...]
//   list [prefix] [limit]        — files under prefix (like ls -R), newest first
//   search "<query>" [limit]     — naive keyword grep, files ranked by match
//   read "<path>" [whole]        — cat the file (first 4000 chars unless "whole")
//   overview                     — folder note-counts (like ls -R | wc)

import { promises as fs } from 'node:fs';
import path from 'node:path';

const BRAIN = process.env.CALLOSIUM_BRAIN || process.env.CALLOSIUM_BRAIN;
const SKIP = new Set(['.git', '.obsidian', '.trash', 'node_modules', '.callosium-cache', 'System', 'Private']);
const [tool, ...rest] = process.argv.slice(2);
const iso = (ms) => (ms ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') : '????-??-?? ??:??');

async function walk(dir, out = []) {
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(full, out);
    else if (e.name.endsWith('.md')) out.push(full);
  }
  return out;
}
const rel = (f) => path.relative(BRAIN, f).split(path.sep).join('/');
const tokens = (s) => (s.toLowerCase().match(/[a-z0-9]{3,}/g) || []).filter((w, i, a) => a.indexOf(w) === i);
const STOP = new Set(['the', 'and', 'for', 'what', 'when', 'where', 'who', 'did', 'was', 'were', 'you', 'your', 'our', 'with', 'from', 'that', 'this', 'how', 'have', 'has', 'are', 'about', 'remember', 'their', 'they', 'them']);

const files = await walk(BRAIN);

if (tool === 'list') {
  const prefix = rest[0] && !/^\d+$/.test(rest[0]) ? rest[0] : '';
  const limit = Number(rest.find((a) => /^\d+$/.test(a)) || 60);
  const rows = [];
  for (const f of files) {
    const r = rel(f);
    if (prefix && !r.startsWith(prefix)) continue;
    let m = 0; try { m = (await fs.stat(f)).mtimeMs; } catch {}
    rows.push({ r, m });
  }
  rows.sort((a, b) => b.m - a.m);
  for (const x of rows.slice(0, limit)) console.log(`${iso(x.m)}  ${x.r}`);
} else if (tool === 'search') {
  const limit = Number(rest.find((a) => /^\d+$/.test(a)) || 15);
  const q = rest.filter((a) => !/^\d+$/.test(a)).join(' ');
  const kws = tokens(q).filter((w) => !STOP.has(w));
  const scored = [];
  for (const f of files) {
    let text = ''; try { text = await fs.readFile(f, 'utf8'); } catch { continue; }
    const low = text.toLowerCase();
    let distinct = 0, total = 0, firstAt = -1;
    for (const k of kws) {
      let n = 0, idx = low.indexOf(k);
      if (idx >= 0 && (firstAt < 0 || idx < firstAt)) firstAt = idx;
      while (idx >= 0) { n++; idx = low.indexOf(k, idx + k.length); }
      if (n > 0) distinct++;
      total += n;
    }
    if (distinct > 0) scored.push({ r: rel(f), distinct, total, snippet: text.slice(Math.max(0, firstAt - 40), firstAt + 140).replace(/\s+/g, ' ') });
  }
  scored.sort((a, b) => b.distinct - a.distinct || b.total - a.total);
  if (!scored.length) console.log('(no grep matches)');
  for (const h of scored.slice(0, limit)) console.log(`${h.r}  [${h.distinct}/${kws.length} terms]\n   ${h.snippet}`);
} else if (tool === 'read') {
  const p = rest[0];
  const whole = rest[1] === 'whole';
  let text = ''; try { text = await fs.readFile(path.join(BRAIN, p), 'utf8'); } catch (e) { console.log('cannot read: ' + p); process.exit(0); }
  console.log(whole ? text : text.slice(0, 4000) + (text.length > 4000 ? `\n… [truncated ${text.length - 4000} chars; pass "whole" to see all]` : ''));
} else if (tool === 'overview') {
  const parts = {};
  for (const f of files) { const p = rel(f).split('/')[0]; parts[p] = (parts[p] || 0) + 1; }
  console.log('FOLDERS (Private/ + System/ excluded):', JSON.stringify(parts, null, 1));
} else {
  console.log('tools: list | search | read | overview');
  process.exit(2);
}
