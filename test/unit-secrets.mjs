// Regression test: the two files that hold secrets must not be world-readable.
//
// System/agents.json holds every agent's bearer token in the clear, and the HTTP
// transport authenticates by token alone — so a 0644 keyring hands any other
// local account a way around the server-side scoping entirely. license.json is
// the same class of file, one directory up from the brain.
//
// Both were being written with node's default mode. On POSIX that lands at 0644
// after a typical umask; this asserts 0600. On Windows chmod can only toggle the
// read-only bit, so restrictToOwner is a deliberate no-op there and the test
// asserts only that the write path still works.
//   node test/unit-secrets.mjs
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Vault } from '../src/core/vault.ts';
import { saveAgents, AGENTS_REL } from '../src/mcp/agents.ts';
import { saveLicense } from '../src/entitlement/index.ts';

let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + ' ' + extra); } };

const POSIX = process.platform !== 'win32';
const root = path.join(os.tmpdir(), `callosium-secrets-${process.pid}`);
await fs.rm(root, { recursive: true, force: true });
await fs.mkdir(path.join(root, 'System'), { recursive: true });

// --- the agent keyring -----------------------------------------------------
const vault = Vault.open(root);
await saveAgents(vault, {
  agents: [{ id: 'claude', name: 'Claude', token: 'not-a-real-token', scopes: { read: [], write: [] } }],
});
const agentsFile = path.join(root, AGENTS_REL);
const agentsStat = await fs.stat(agentsFile);
const agentsMode = agentsStat.mode & 0o777;

ok('agents.json was written', (await fs.readFile(agentsFile, 'utf8')).includes('claude'));
if (POSIX) {
  ok(`agents.json is owner-only (got 0${agentsMode.toString(8)})`, agentsMode === 0o600, `expected 0600`);
  ok('agents.json is not group- or world-readable', (agentsMode & 0o077) === 0);
} else {
  console.log('  – mode bits not asserted on win32 (chmod cannot express them)');
}

// A REWRITE must stay locked down — vault.writeFile is temp+rename, so the mode
// belongs to a brand-new inode every time and re-tightening is not optional.
await saveAgents(vault, {
  agents: [{ id: 'claude', name: 'Claude', token: 'rotated', scopes: { read: [], write: [] } }],
});
const rewriteMode = (await fs.stat(agentsFile)).mode & 0o777;
if (POSIX) ok(`agents.json still owner-only after rewrite (got 0${rewriteMode.toString(8)})`, rewriteMode === 0o600);

// --- the license -----------------------------------------------------------
const licenseFile = path.join(root, 'home', '.callosium', 'license.json');
await saveLicense({ payload: { tier: 'pro' }, signature: 'x' }, licenseFile);
const licMode = (await fs.stat(licenseFile)).mode & 0o777;
const dirMode = (await fs.stat(path.dirname(licenseFile))).mode & 0o777;

ok('license.json was written', (await fs.readFile(licenseFile, 'utf8')).includes('pro'));
if (POSIX) {
  ok(`license.json is owner-only (got 0${licMode.toString(8)})`, licMode === 0o600);
  ok(`~/.callosium is owner-only (got 0${dirMode.toString(8)})`, dirMode === 0o700);
  // The tighten happens on the TEMP file, before the rename, so there is never a
  // moment where the final path exists world-readable.
  const leftovers = (await fs.readdir(path.dirname(licenseFile))).filter((f) => f.includes('.tmp-'));
  ok('no temp license left behind', leftovers.length === 0, leftovers.join(','));
}

await fs.rm(root, { recursive: true, force: true });
console.log(`\nsecrets: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
