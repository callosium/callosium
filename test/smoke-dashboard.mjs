// Dashboard boot smoke (P3 test-coverage): spawn `callosium serve`, wait for it
// to listen, and assert (a) it boots and serves the SPA HTML, (b) the per-launch
// caller token (#13) gates /api/ — a tokenless call is 403, the HTML-embedded
// token unlocks it, and (c) the exempt routes (/, /__health) need no token.
//   node test/smoke-dashboard.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'src', 'cli.ts');
const PORT = 4399; // high port, away from the default 4319
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + ' ' + extra); } };

const child = spawn('node', [CLI, 'serve', '--port', String(PORT)], { stdio: 'ignore' });
let done = false;
const cleanup = () => { if (!done) { done = true; try { child.kill(); } catch {} } };
process.on('exit', cleanup);
child.on('error', (e) => { console.error('failed to spawn dashboard:', e.message); process.exit(1); });

// Poll /__health (served before any guard) until the server is listening.
async function waitReady(ms = 20000) {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      const r = await fetch(`${BASE}/__health`);
      if (r.ok) return true;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) return false;
    await new Promise((res) => setTimeout(res, 250));
  }
}

try {
  const ready = await waitReady();
  ok('dashboard boots and answers /__health', ready);
  if (!ready) throw new Error('server never became ready');

  ok('/__health is exempt (200 with no token)', (await fetch(`${BASE}/__health`)).status === 200);

  const htmlRes = await fetch(`${BASE}/`);
  const html = await htmlRes.text();
  ok('/ serves the SPA HTML (200, no token needed)', htmlRes.status === 200 && /CALLOSIUM|callosium/i.test(html));

  const m = html.match(/<meta name="cct" content="([^"]+)"/);
  const token = m ? m[1] : '';
  ok('served HTML embeds a per-launch caller token', !!token && token.length >= 32);

  ok('/api/state WITHOUT the token is refused (403)', (await fetch(`${BASE}/api/state`)).status === 403);
  ok('/api/state WITH the token succeeds (200)',
    (await fetch(`${BASE}/api/state`, { headers: { 'x-callosium-token': token } })).status === 200);
  ok('/api/state with a WRONG token is refused (403)',
    (await fetch(`${BASE}/api/state`, { headers: { 'x-callosium-token': 'x'.repeat(token.length) } })).status === 403);

  // Background-embed status route (non-blocking semantic): a GET, token-gated like
  // every /api/ route, and 'idle' with no brain connected (never a stale build's numbers).
  ok('/api/embed/status WITHOUT the token is refused (403)', (await fetch(`${BASE}/api/embed/status`)).status === 403);
  const embRes = await fetch(`${BASE}/api/embed/status`, { headers: { 'x-callosium-token': token } });
  const emb = await embRes.json().catch(() => ({}));
  ok('/api/embed/status WITH the token returns idle for no brain',
    embRes.status === 200 && emb.status === 'idle' && emb.done === 0 && emb.total === 0,
    JSON.stringify(emb));

  // Native folder picker: token-gated + POST-only. We do NOT call it with a valid
  // token here — that would pop a real OS dialog and block. The 403/405 checks both
  // short-circuit BEFORE the handler runs, so no dialog appears.
  ok('/api/pick-folder WITHOUT the token is refused (403)', (await fetch(`${BASE}/api/pick-folder`, { method: 'POST' })).status === 403);
  ok('/api/pick-folder is POST-only (GET → 405)',
    (await fetch(`${BASE}/api/pick-folder`, { headers: { 'x-callosium-token': token } })).status === 405);

  // Self-update (npm/npx path): token-gated + POST-only. We do NOT call it with a valid
  // token here — that would run `npm i -g callosium@latest`. Both checks short-circuit
  // BEFORE the handler runs, so no install happens.
  ok('/api/self-update WITHOUT the token is refused (403)', (await fetch(`${BASE}/api/self-update`, { method: 'POST' })).status === 403);
  ok('/api/self-update is POST-only (GET → 405)',
    (await fetch(`${BASE}/api/self-update`, { headers: { 'x-callosium-token': token } })).status === 405);
} finally {
  cleanup();
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
console.log('  ALL PASS');
