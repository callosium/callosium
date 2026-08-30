// installClientConfig writes into a file Callosium does not own — the AI client's
// own MCP config. On a real machine Claude Desktop's config also holds
// coworkUserFilesPath and preferences, and Claude Code's ~/.claude.json is tens of
// KB of unrelated state. Writing our object over either would take out every other
// connector that user has, to add one of ours.
//
// So the contract under test is narrow and absolute: merge exactly one key, keep
// everything else byte-for-byte, back up first, and REFUSE anything we cannot parse
// rather than "repairing" it.
//   node test/unit-clientconfig.mjs
import { installClientConfig, clientTargets, findClient } from '../src/dashboard/clients.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (extra ? ' — ' + extra : '')); } };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cal-clientcfg-'));
const ENTRY = { command: 'node', args: ['/abs/cli.js', 'mcp', '--agent', 'claude', '--token', 'tok_secret'] };
const target = (file) => ({ id: 't', label: 'Test Client', file, key: 'mcpServers', restart: 'restart it' });

// ── 1. creates the file, and any missing parent directory ──
{
  const f = path.join(tmp, 'nested', 'deep', 'mcp.json');
  const r = await installClientConfig(target(f), 'callosium', ENTRY);
  const doc = JSON.parse(fs.readFileSync(f, 'utf8'));
  ok('creates the file when absent', r.created === true && fs.existsSync(f));
  ok('creates missing parent directories', fs.existsSync(path.dirname(f)));
  ok('writes our entry under mcpServers', doc.mcpServers.callosium.command === 'node');
  ok('no backup when there was nothing to lose', r.backup === null);
}

// ── 2. THE important one: merging must not destroy the file ──
{
  const f = path.join(tmp, 'merge.json');
  fs.writeFileSync(f, JSON.stringify({
    mcpServers: { chatcut_desktop: { command: 'chatcut.cmd', args: [] } },
    coworkUserFilesPath: 'C:/somewhere',
    preferences: { theme: 'dark', nested: { deep: true } },
  }, null, 2));

  const r = await installClientConfig(target(f), 'callosium', ENTRY);
  const doc = JSON.parse(fs.readFileSync(f, 'utf8'));

  ok('another MCP server survives', doc.mcpServers.chatcut_desktop?.command === 'chatcut.cmd');
  ok('reports how many other servers it kept', r.otherServersKept === 1, 'got ' + r.otherServersKept);
  ok('unrelated top-level keys survive', doc.coworkUserFilesPath === 'C:/somewhere');
  ok('nested unrelated values survive', doc.preferences?.nested?.deep === true);
  ok('our entry landed alongside, not instead', doc.mcpServers.callosium.args.includes('--token'));
  ok('backed the file up first', !!r.backup && fs.existsSync(r.backup));
  const backup = JSON.parse(fs.readFileSync(r.backup, 'utf8'));
  ok('the backup is the PRE-write content', !backup.mcpServers.callosium && !!backup.mcpServers.chatcut_desktop);
}

// ── 3. idempotent: running twice replaces our entry, never duplicates or multiplies ──
{
  const f = path.join(tmp, 'twice.json');
  await installClientConfig(target(f), 'callosium', ENTRY);
  const r2 = await installClientConfig(target(f), 'callosium', { ...ENTRY, args: ['changed'] });
  const doc = JSON.parse(fs.readFileSync(f, 'utf8'));
  ok('second write reports it replaced ours', r2.replacedExisting === true);
  ok('exactly one callosium entry remains', Object.keys(doc.mcpServers).filter((k) => k === 'callosium').length === 1);
  ok('the entry is the NEW one', doc.mcpServers.callosium.args[0] === 'changed');
}

// ── 4. REFUSE what we cannot parse, and leave it exactly as found ──
{
  const f = path.join(tmp, 'corrupt.json');
  const before = '{ "mcpServers": { "other": {} }, oops not json';
  fs.writeFileSync(f, before);
  let threw = null;
  try { await installClientConfig(target(f), 'callosium', ENTRY); } catch (e) { threw = e; }
  ok('refuses a config that is not valid JSON', !!threw);
  ok('names the file so the owner can fix it', !!threw && threw.message.includes('corrupt.json'));
  ok('leaves the unparseable file BYTE-IDENTICAL', fs.readFileSync(f, 'utf8') === before);
}

// ── 5. refuse a JSON array — valid JSON, wrong shape ──
{
  const f = path.join(tmp, 'array.json');
  fs.writeFileSync(f, '[1,2,3]');
  let threw = null;
  try { await installClientConfig(target(f), 'callosium', ENTRY); } catch (e) { threw = e; }
  ok('refuses a config that is not a JSON object', !!threw);
  ok('leaves that file untouched too', fs.readFileSync(f, 'utf8') === '[1,2,3]');
}

// ── 6. an empty file is a fresh start, not a parse error ──
{
  const f = path.join(tmp, 'empty.json');
  fs.writeFileSync(f, '   \n');
  const r = await installClientConfig(target(f), 'callosium', ENTRY);
  ok('treats a blank file as empty config', !!JSON.parse(fs.readFileSync(f, 'utf8')).mcpServers.callosium);
  ok('still backs up the blank file', !!r.backup);
}

// ── 7. no temp files left behind anywhere ──
{
  const strays = fs.readdirSync(tmp).filter((n) => n.includes('callosium-tmp'));
  ok('leaves no temp files behind', strays.length === 0, strays.join(', '));
}

// ── 8. the client table itself ──
{
  const all = clientTargets();
  ok('ships a client table', all.length >= 3);
  ok('every client declares a restart instruction', all.every((c) => !!c.restart));
  ok('every client merges under mcpServers', all.every((c) => c.key === 'mcpServers'));
  ok('claude-desktop resolves a path on this platform', !!findClient('claude-desktop')?.file);
  ok('claude-code points at ~/.claude.json', (findClient('claude-code')?.file || '').endsWith('.claude.json'));
  ok('unknown client is not found', findClient('nope') === undefined);
  const files = all.map((c) => c.file).filter(Boolean);
  ok('no two clients share a config file', new Set(files).size === files.length);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
console.log(fail === 0 ? '  ALL PASS\n' : '  FAILED\n');
process.exit(fail === 0 ? 0 : 1);
