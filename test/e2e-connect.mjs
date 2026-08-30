// End-to-end: does POST /api/connect actually pair an agent AND write a usable
// entry into a client's config file?
//
// HOME / USERPROFILE / APPDATA are redirected into a throwaway directory for the
// whole run. That is not tidiness — clientTargets() resolves Claude Desktop from
// %APPDATA% and Claude Code from os.homedir(), and serveDashboard persists the
// connected brain under ~/.callosium. Without the redirect this test would rewrite
// the developer's real Claude config and repoint their real brain.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cal-connect-'));
const home = path.join(tmp, 'home');
const brain = path.join(tmp, 'brain');
fs.mkdirSync(home, { recursive: true });
const PORT = 45700 + (process.pid % 90);

const norm = (p) => p.split(path.sep).join(String.fromCharCode(47));
let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (extra ? ' — ' + extra : '')); } };
const ENV = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming'), CALLOSIUM_DESKTOP: '1' };

const run = (args, extraEnv = {}) => new Promise((res) => {
  const c = spawn(process.execPath, [path.join(ROOT, 'dist', 'cli.js'), ...args], { env: { ...ENV, ...extraEnv }, cwd: ROOT });
  let out = ''; c.stdout.on('data', d => out += d); c.stderr.on('data', d => out += d);
  c.on('exit', (code) => res({ code, out }));
});

console.log('\n  init a throwaway brain');
const init = await run(['init', brain]);
ok('init succeeded', init.code === 0, init.out.slice(0, 200));

console.log('\n  start the dashboard on an isolated HOME');
const srv = spawn(process.execPath, [path.join(ROOT, 'dist', 'cli.js'), 'serve', '--brain', brain, '--port', String(PORT)], { env: ENV, cwd: ROOT });
let slog = ''; srv.stdout.on('data', d => slog += d); srv.stderr.on('data', d => slog += d);

const live = await new Promise((res) => {
  const t0 = Date.now();
  const poll = setInterval(async () => {
    if (/cockpit is live/.test(slog)) { clearInterval(poll); res(true); }
    else if (Date.now() - t0 > 60000) { clearInterval(poll); res(false); }
  }, 200);
});
ok('dashboard came up', live, slog.slice(0, 300));

if (live) {
  const html = await fetch(`http://127.0.0.1:${PORT}/`).then(r => r.text());
  const CCT = (html.match(/name="cct" content="([0-9a-f]{64})"/) || [])[1] || '';
  ok('got a caller token', CCT.length === 64);
  const api = (p, body) => fetch(`http://127.0.0.1:${PORT}${p}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'x-callosium-token': CCT, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }).then(r => r.json());

  console.log('\n  GET /api/clients');
  const cl = await api('/api/clients');
  ok('returns a client list', Array.isArray(cl.clients) && cl.clients.length >= 3);
  const cd = (cl.clients || []).find(c => c.id === 'claude-desktop');
  ok('claude-desktop is installable', !!cd && cd.installable === true);
  ok('its path is INSIDE the isolated home', !!cd && norm(cd.file).startsWith(norm(home)), cd && cd.file);
  ok('reports the file does not exist yet', !!cd && cd.alreadyHasFile === false);

  console.log('\n  POST /api/connect');
  const r1 = await api('/api/connect', { id: 'claude-desktop', displayName: 'Claude Desktop', client: 'claude-desktop' });
  ok('connect succeeded', !r1.error && !r1.writeFailed, JSON.stringify(r1).slice(0, 220));
  ok('reports the file it wrote', !!r1.file);
  ok('reports it created the file', r1.created === true);
  ok('hands back a restart instruction', typeof r1.restart === 'string' && r1.restart.length > 10);

  if (r1.file && fs.existsSync(r1.file)) {
    const doc = JSON.parse(fs.readFileSync(r1.file, 'utf8'));
    const e = doc.mcpServers?.callosium;
    ok('config file has our entry', !!e);
    ok('entry is spawnable (absolute interpreter)', !!e && path.isAbsolute(e.command), e && e.command);
    ok('entry points at cli.js', !!e && e.args.some(a => String(a).endsWith('cli.js')));
    ok('entry carries the brain path', !!e && e.args.includes(brain));
    ok('entry carries an agent id', !!e && e.args.includes('claude-desktop'));
    const ti = e ? e.args.indexOf('--token') : -1;
    ok('entry carries a real token the user never typed', ti > 0 && String(e.args[ti + 1]).length >= 16);
  } else ok('config file exists on disk', false, r1.file);

  console.log('\n  idempotency: press it again');
  const r2 = await api('/api/connect', { id: 'claude-desktop', displayName: 'Claude Desktop', client: 'claude-desktop' });
  ok('second connect also succeeds (agent already paired)', !r2.error && !r2.writeFailed, JSON.stringify(r2).slice(0, 200));
  ok('reports it replaced our own entry', r2.replacedExisting === true);
  ok('backed up before the second write', !!r2.backup && fs.existsSync(r2.backup));
  const doc2 = JSON.parse(fs.readFileSync(r1.file, 'utf8'));
  ok('still exactly one callosium entry', Object.keys(doc2.mcpServers).length === 1);

  console.log('\n  a second client writes a DIFFERENT file');
  const r3 = await api('/api/connect', { id: 'claude-code', displayName: 'Claude Code', client: 'claude-code' });
  ok('claude-code connect succeeded', !r3.error && !r3.writeFailed, JSON.stringify(r3).slice(0, 200));
  ok('wrote a different path', !!r3.file && r3.file !== r1.file, r3.file);
  ok('claude-desktop config untouched by it', JSON.parse(fs.readFileSync(r1.file, 'utf8')).mcpServers.callosium.args.includes('claude-desktop'));

  console.log('\n  rejects an unknown client');
  const r4 = await api('/api/connect', { id: 'x', displayName: 'X', client: 'not-a-client' });
  ok('unknown client refused', !!r4.error);

  console.log('\n  the real user config was NEVER touched');
  const realCfg = path.join(process.env.APPDATA || '', 'Claude', 'claude_desktop_config.json');
  const realDoc = fs.existsSync(realCfg) ? JSON.parse(fs.readFileSync(realCfg, 'utf8')) : null;
  ok("the real Claude Desktop config has no test entry",
    !realDoc || !JSON.stringify(realDoc.mcpServers?.callosium || {}).includes(brain));
}

srv.kill('SIGKILL');
await new Promise(r => setTimeout(r, 400));
fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
console.log(fail === 0 ? '  ALL PASS\n' : '  FAILED\n');
process.exit(fail === 0 ? 0 : 1);
