// Build the served dashboard: splice the per-screen render modules (screens/*.js)
// into the shell template (ui.html.base) at the `/* __SCREENS__ */` marker,
// producing ui.html. Run: `node src/dashboard/build-ui.mjs` from the repo root.
//
// IMPORTANT: the marker is replaced with a FUNCTION replacer, not a string —
// a string replacement would interpret `$$`/`$&` in the screen code and corrupt
// the `$$` helper calls into `$`.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ORDER = ['agents', 'notes', 'health', 'ask', 'settings', 'map', 'onboard', 'coach'];

const errs = [];
let bundle = '';
for (const k of ORDER) {
  const p = path.join(HERE, 'screens', `render-${k}.js`);
  if (!existsSync(p)) { errs.push(`${k}: MISSING (${p})`); continue; }
  let code = readFileSync(p, 'utf8');
  code = code.replace(/^﻿/, '').replace(/^```[a-z]*\s*\n?/i, '').replace(/\n?```\s*$/, '').replace(/<\/?script[^>]*>/gi, '');
  if (code.includes('\x00')) { errs.push(`${k}: contains NUL bytes`); continue; }
  try { new Function(code); } catch (e) { errs.push(`${k}: SYNTAX — ${e.message}`); }
  bundle += `\n// ===================== ${k} =====================\n${code.trim()}\n`;
}
if (errs.length) { console.error('BUILD ABORTED:\n' + errs.join('\n')); process.exit(1); }

const base = readFileSync(path.join(HERE, 'ui.html.base'), 'utf8');
if (!base.includes('/* __SCREENS__ */')) { console.error('marker /* __SCREENS__ */ missing in ui.html.base'); process.exit(1); }
const out = base.replace('/* __SCREENS__ */', () => bundle);
writeFileSync(path.join(HERE, 'ui.html'), out);
console.log(`built ui.html (${out.length} bytes) from ${ORDER.length} screen modules`);
