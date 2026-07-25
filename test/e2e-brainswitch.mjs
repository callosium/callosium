// Brain-switch isolation regression (pass-3 review, medium — found independently
// by two reviewers). serveHttp reuses ONE shared retrieval cache across its
// per-request servers and resolves the LIVE brain per request (getBrain). A
// mid-session cockpit brain switch must never serve the PREVIOUS brain's notes
// to a request authenticated for the NEW brain. The bug: syncFreshness's 1.5s
// throttle short-circuited before the (brain-scoped) freshness token was ever
// recomputed, so a warm request loop kept serving the old brain's texts for up
// to the throttle window. Fix: reset the shared cache when vault.root changes,
// before the throttle. This test drives the real serveHttp endpoint and switches
// brains back-to-back (well inside the throttle) to prove no cross-brain leak.
//   node test/e2e-brainswitch.mjs

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { serveHttp } from '../src/mcp/server.ts';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repo, 'src', 'cli.ts');
const brainA = path.join(repo, 'test', '.fixture-brainA');
const brainB = path.join(repo, 'test', '.fixture-brainB');
const PORT = 4399;

let pass = 0,
  fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
};

// A brain with ONE knowledge note whose body carries a sentinel that appears
// nowhere else — not in any title, query, or refusal message — so its presence
// in a response is unambiguous proof that THIS brain's texts were served.
async function setup(dir, title, sentinel, agentId) {
  await fs.rm(dir, { recursive: true, force: true });
  execFileSync('node', [cli, 'init', dir], { stdio: 'pipe' });
  await fs.writeFile(
    path.join(dir, 'Knowledge', `${title}.md`),
    `---\ntype: knowledge\ntags: [test]\nstatus: active\nupdated: 2026-07-11\n---\n\n# ${title}\n\nThe calibration sentinel for this note is ${sentinel}.\n`,
  );
  execFileSync('node', [cli, 'pair', agentId, `Agent ${agentId}`, '--brain', dir], { stdio: 'pipe' });
  const reg = JSON.parse(await fs.readFile(path.join(dir, 'System', 'agents.json'), 'utf8'));
  return reg.agents[0].token;
}

const tokenA = await setup(brainA, 'Espresso Ratios', 'qwertyalpha', 'agent-a');
const tokenB = await setup(brainB, 'Green Tea Steeping', 'qwertybravo', 'agent-b');

let current = brainA; // the "cockpit's live brain" — mutated by the switch below
await serveHttp({ getBrain: () => current, port: PORT, host: '127.0.0.1' });

const mkClient = async (token) => {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'brainswitch-test', version: '0.0.0' });
  await client.connect(transport);
  return client;
};
const recall = async (client, question) =>
  (await client.callTool({ name: 'recall', arguments: { question } })).content[0].text;

// 1) Brain A is live: an A-authenticated agent sees A's own note. This WARMS the
//    shared cache with A's texts and stamps lastFreshCheck (arming the throttle).
const cA = await mkClient(tokenA);
const aOwn = await recall(cA, 'espresso ratios');
ok('brain A serves its own note before the switch', /qwertyalpha/i.test(aOwn), aOwn.slice(0, 160));
await cA.close();

// 2) Switch the live brain to B WITHOUT waiting out the 1.5s freshness throttle,
//    then have a B-authenticated agent ask for A's note title. Pre-fix, the shared
//    cache still holds A's texts, so A's note (with its qwertyalpha sentinel) is
//    returned to the B agent — a cross-brain leak. Post-fix, the cache re-baselines
//    to B, which has no espresso note, so A's sentinel can NEVER appear.
current = brainB;
const cB = await mkClient(tokenB);
const bLeakProbe = await recall(cB, 'espresso ratios');
ok("after switch, brain A's note is NOT leaked to a brain-B agent", !/qwertyalpha/i.test(bLeakProbe), bLeakProbe.slice(0, 160));

// 3) And the cache genuinely rebuilt for B: B's own note is now served.
const bOwn = await recall(cB, 'green tea steeping');
ok('after switch, brain B serves its own note', /qwertybravo/i.test(bOwn), bOwn.slice(0, 160));
await cB.close();

console.log(`\n  ${pass} passed, ${fail} failed`);
await fs.rm(brainA, { recursive: true, force: true });
await fs.rm(brainB, { recursive: true, force: true });
if (fail === 0) console.log('  ALL PASS');
process.exit(fail ? 1 : 0);
