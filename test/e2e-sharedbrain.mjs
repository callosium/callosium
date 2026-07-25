// One loaded brain per PROCESS (pass-3 review, low severity — a bounding fix, not
// a crash bug). The dashboard auto-starts the HTTP MCP endpoint INSIDE its own
// process. That endpoint used to build a SECOND retrieval cache over the SAME
// brain, so the full unscoped note bodies, the graph and the Float32 vector matrix
// were ALL resident twice whenever the cockpit was open and an HTTP agent
// (ChatGPT/Kimi over URL+token) was active — on an 8k-note / ~50k-chunk brain that
// is ~450MB in one process instead of ~226MB. It now reads the cockpit's already-
// loaded brain through the BrainSource seam (src/mcp/server.ts).
//
// The two caches have DIFFERENT invalidation (the cockpit's cacheGen/dropCache vs
// the MCP cache's builtToken/freshnessToken), which is why they could not just be
// merged — so this test pins the invalidation as hard as the RAM.
//
//   1) RAM. Two CHILD processes do byte-identical work — boot the dashboard on the
//      same brain, load the cockpit, run one MCP recall — and differ in exactly one
//      thing: which endpoint serves that recall. `shared` uses the dashboard's own
//      auto-started endpoint (the cockpit's brain); `private` uses a standalone
//      serveHttp over the same brain, which owns its own cache and is therefore the
//      pre-fix shape. The private child must end up about one vector matrix heavier.
//      Measuring one number per process (not deltas across phases inside one) keeps
//      this off GC timing, which made an in-process delta swing ±100MB.
//   2) An MCP write is visible to BOTH surfaces immediately (invalidate → dropCache).
//   3) A cockpit brain switch re-baselines BOTH views: no note from the old brain
//      reaches an agent on the new one, and the cockpit itself moves too.
//
//   node --expose-gc test/e2e-sharedbrain.mjs

process.env.CALLOSIUM_RERANK = '0'; // reranker is irrelevant here; keep it light

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const SELF = fileURLToPath(import.meta.url);
const HERE = path.dirname(SELF);
const repo = path.resolve(HERE, '..');
const cli = path.join(repo, 'src', 'cli.ts');

const brainA = path.join(HERE, '.fixture-sharedA');
const brainB = path.join(HERE, '.fixture-sharedB');
// Keep the shadow-git version store out of ~/.callosium so this test never touches
// the real one. Read per call, and inherited by the children, so setting it here is
// in time for both.
process.env.CALLOSIUM_HISTORY_ROOT ||= path.join(HERE, '.fixture-sharedhist');

const DASH_PORT = 4391; // away from smoke-dashboard / e2e-brainswitch (4399)
const MCP_PORT = 4392; // the dashboard's auto-started endpoint (shared source)
const CTRL_PORT = 4393; // a standalone serveHttp over the same brain (private cache)

const FILLER = 120;
const DIMS = 384; // multilingual-e5-small's real width
const CHUNKS = 20000; // ×384×4 ≈ 29MB of Float32 — the payload the children weigh
const MATRIX_BYTES = CHUNKS * DIMS * 4;
const MB = (b) => `${(b / 1024 / 1024).toFixed(1)}MB`;

const { serveDashboard } = await import('../src/dashboard/server.ts');
const { serveHttp } = await import('../src/mcp/server.ts');
const { Vault } = await import('../src/core/vault.ts');
const { EMBEDDER_VERSION } = await import('../src/recall/semantic.ts');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');

const cacheDirOf = (dir) =>
  path.join(os.homedir(), '.callosium', 'cache', Vault.contentHash(path.resolve(dir).toLowerCase()));
const tokenOf = async (dir, id) =>
  JSON.parse(await fs.readFile(path.join(dir, 'System', 'agents.json'), 'utf8')).agents.find((a) => a.id === id).token;

const mkClient = async (port, token) => {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'sharedbrain-test', version: '0.0.0' });
  await client.connect(transport);
  return client;
};
const callTool = async (client, name, args) => (await client.callTool({ name, arguments: args })).content[0].text;

// ── child: weigh one process ────────────────────────────────────────────────────
// Both modes run the SAME work. `shared` drives the dashboard's own endpoint (which
// reads the cockpit's brain); `private` drives a standalone serveHttp over the same
// brain (its own cache — the pre-fix shape). Prints one number for the parent.
const MODE = process.env.SHAREDBRAIN_MODE;
if (MODE) {
  const token = await tokenOf(brainA, 'agent-a');
  await serveDashboard({ port: DASH_PORT, brain: brainA, mcpPort: MCP_PORT });
  const html = await fetch(`http://127.0.0.1:${DASH_PORT}/`).then((r) => r.text());
  const cct = (html.match(/<meta name="cct" content="([^"]+)"/) || [, ''])[1];
  // /api/state goes through loadAll → texts + graph + embeddings. This is the ONE
  // loaded brain the shared mode must reuse.
  await fetch(`http://127.0.0.1:${DASH_PORT}/api/state`, { headers: { 'x-callosium-token': cct } }).then((r) => r.json());
  let port = MCP_PORT;
  if (MODE === 'private') {
    await serveHttp({ brainPath: brainA, port: CTRL_PORT, host: '127.0.0.1' });
    port = CTRL_PORT;
  }
  const c = await mkClient(port, token);
  const answer = await callTool(c, 'recall', { question: 'espresso ratios' });
  await c.close();
  // arrayBuffers (NOT heapUsed) is where a Float32Array's backing store is
  // accounted, so it tracks the vector matrix directly. One collect + yield trims
  // the obvious garbage; exact GC timing does not matter here because both children
  // are measured identically and only the endpoint under test differs.
  global.gc?.();
  await new Promise((r) => setTimeout(r, 250));
  global.gc?.();
  console.log(`SHAREDBRAIN_RESULT ${process.memoryUsage().arrayBuffers} ${/qwertyalpha/i.test(answer) ? 'served' : 'MISSING'}`);
  process.exit(0);
}

// ── parent ─────────────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
};

// What loadTexts will count, derived from disk instead of hardcoded — `init`
// scaffolds notes of its own (Logs, Profile), and asserting a magic number would
// break the moment the default schema changes.
async function countNotes(dir) {
  let n = 0;
  const walk = async (d) => {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      if (e.isDirectory()) await walk(path.join(d, e.name));
      else if (e.name.endsWith('.md')) n++;
    }
  };
  await walk(dir);
  return n;
}

async function note(dir, rel, title, body) {
  const abs = path.join(dir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, `---\ntype: knowledge\ntags: [test]\nstatus: active\nupdated: 2026-07-25\n---\n\n# ${title}\n\n${body}\n`);
}

async function setupBrain(dir, title, sentinel, agentId, filler) {
  await fs.rm(dir, { recursive: true, force: true });
  execFileSync('node', [cli, 'init', dir], { stdio: 'pipe' });
  // The sentinel appears in no title, query or refusal message, so seeing it in a
  // response is unambiguous proof THIS brain's texts were served.
  await note(dir, `Knowledge/${title}.md`, title, `The calibration sentinel for this note is ${sentinel}.`);
  for (let i = 0; i < filler; i++) {
    await note(dir, `Knowledge/Filler ${i}.md`, `Filler ${i}`, `Padding note ${i} so the loaded brain is not trivially small.`);
  }
  execFileSync('node', [cli, 'pair', agentId, `Agent ${agentId}`, '--brain', dir], { stdio: 'pipe' });
  return tokenOf(dir, agentId);
}

// A synthetic embedding cache, so the semantic lane's big Float32 matrix is loaded
// WITHOUT needing the ONNX model (CI has none; recall fails open to lexical if the
// query can't be embedded — the matrix is still allocated at load, which is what we
// weigh). Every vector holds the SAME non-zero value, so if the model IS present
// every chunk ties and the lane falls back to chunk order — and `sentinelPath`'s
// chunks come first, so semantic AGREES with lexical instead of injecting noise.
async function fakeEmbeddings(dir, sentinelPath) {
  const dest = cacheDirOf(dir);
  await fs.mkdir(dest, { recursive: true });
  const names = (await fs.readdir(path.join(dir, 'Knowledge'))).filter((f) => f.endsWith('.md')).map((f) => `Knowledge/${f}`);
  const ordered = [sentinelPath, ...names.filter((n) => n !== sentinelPath)];
  const chunks = [];
  for (let i = 0; i < CHUNKS; i++) chunks.push({ path: ordered[i % ordered.length], heading: null });
  const noteHashes = {};
  for (const n of names) noteHashes[n] = '0'.repeat(16);
  const buildId = 'sharedbraintest0'; // exactly 16 ascii — the sidecar/metadata pairing check
  await fs.writeFile(path.join(dest, 'embeddings.json'), JSON.stringify({ version: EMBEDDER_VERSION, dims: DIMS, chunks, noteHashes, buildId }));
  const vectors = new Float32Array(CHUNKS * DIMS).fill(0.05);
  const sidecar = Buffer.alloc(16 + MATRIX_BYTES);
  sidecar.write(buildId, 0, 'ascii');
  Buffer.from(vectors.buffer).copy(sidecar, 16);
  await fs.writeFile(path.join(dest, 'embeddings.f32'), sidecar);
}

// serveDashboard's setBrain PERSISTS the connected brain to ~/.callosium/config.json.
// Left alone, this test (and its children) would point the owner's real Callosium at
// a deleted fixture.
const CONFIG = path.join(os.homedir(), '.callosium', 'config.json');
let savedConfig = null;
try { savedConfig = await fs.readFile(CONFIG); } catch { /* none yet */ }

function weigh(mode) {
  const r = spawnSync(process.execPath, ['--expose-gc', SELF], {
    env: { ...process.env, SHAREDBRAIN_MODE: mode },
    encoding: 'utf8',
  });
  const m = (r.stdout || '').match(/SHAREDBRAIN_RESULT (\d+) (\w+)/);
  if (!m) throw new Error(`child (${mode}) produced no measurement:\n${r.stdout}\n${r.stderr}`);
  return { bytes: Number(m[1]), served: m[2] === 'served' };
}

let cct = '';
const api = async (route, body) =>
  fetch(`http://127.0.0.1:${DASH_PORT}${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-callosium-token': cct, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then((r) => r.json());

try {
  const tokenA = await setupBrain(brainA, 'Espresso Ratios', 'qwertyalpha', 'agent-a', FILLER);
  await fakeEmbeddings(brainA, 'Knowledge/Espresso Ratios.md');

  // ── 1) RAM: one brain per process vs two ─────────────────────────────────────
  const shared = weigh('shared');
  const priv = weigh('private');
  ok('shared-source endpoint serves the brain', shared.served);
  ok('private-cache endpoint serves the brain', priv.served);
  console.log(`\n  one vector matrix        ${MB(MATRIX_BYTES)}`);
  console.log(`  shared source (fixed)    ${MB(shared.bytes)} of ArrayBuffers`);
  console.log(`  private cache (pre-fix)  ${MB(priv.bytes)} of ArrayBuffers`);
  console.log(`  saved                    ${MB(priv.bytes - shared.bytes)}\n`);
  // The floor is deliberately NOT "half a matrix" any more. loadEmbeddings is now
  // memoized on the identity of the metadata + vector sidecar, so two caches over
  // the SAME brain in one process already receive the SAME EmbeddingIndex object —
  // the vector matrix stopped double-counting even on the private-cache control.
  // What this test still measures, and what BrainSource still saves, is the rest of
  // the duplication: the note bodies, the graph, and the rank index keyed on the
  // texts object identity. That is ~6.5MB on this fixture. A 3MB floor keeps the
  // guard sharp — remove the sharing and the delta collapses toward zero — without
  // asserting a matrix that a different fix already deduplicated.
  const FLOOR = 3 * 1024 * 1024;
  ok(`sharing saves the non-matrix structures (>${MB(FLOOR)})`,
    priv.bytes - shared.bytes > FLOOR, MB(priv.bytes - shared.bytes));

  // ── 2) an MCP write is visible on BOTH surfaces at once ─────────────────────
  await serveDashboard({ port: DASH_PORT, brain: brainA, mcpPort: MCP_PORT });
  const html = await fetch(`http://127.0.0.1:${DASH_PORT}/`).then((r) => r.text());
  cct = (html.match(/<meta name="cct" content="([^"]+)"/) || [, ''])[1];
  ok('dashboard boots and hands out a caller token', !!cct);
  const state = await api('/api/state');
  ok('cockpit loads the brain', state.onboarded === true && state.notes === (await countNotes(brainA)), JSON.stringify(state).slice(0, 160));

  // The cockpit cache IS the MCP endpoint's cache now, so the write path's
  // invalidate() has to drop it (dropCache) or an agent would not see its own write.
  // Queried by a BODY term: recall indexes note bodies, so a fresh corpus is exactly
  // what makes this hit (a filename-only query misses regardless of caching — same
  // on the private-cache path).
  const cA = await mkClient(MCP_PORT, tokenA);
  await callTool(cA, 'write_note', {
    path: 'Knowledge/Cold Brew Steeping.md',
    content: 'Steeped cold for sixteen hours, then cut with nitrogen infusion.',
  });
  const reread = await callTool(cA, 'recall', { question: 'nitrogen infusion' });
  ok('MCP sees its own write immediately (shared cache invalidated)', /Cold Brew Steeping/.test(reread), reread.slice(0, 200));
  const afterWrite = await api('/api/state');
  ok('cockpit sees the MCP write too', afterWrite.notes === state.notes + 1, `${afterWrite.notes} vs ${state.notes}+1`);
  await cA.close();

  // ── 3) a brain switch re-baselines BOTH views ───────────────────────────────
  await setupBrain(brainB, 'Green Tea Steeping', 'qwertybravo', 'agent-b', 4);
  const tokenB = await tokenOf(brainB, 'agent-b');
  await api('/api/inspect', { path: brainB }); // the picker step /api/init requires
  const init = await api('/api/init', { path: brainB });
  ok('cockpit switches to brain B', init.ok === true && path.resolve(init.path) === path.resolve(brainB), JSON.stringify(init).slice(0, 160));

  const cB = await mkClient(MCP_PORT, tokenB);
  const leak = await callTool(cB, 'recall', { question: 'espresso ratios' });
  ok("after the switch, brain A's note is NOT leaked to a brain-B agent", !/qwertyalpha/i.test(leak), leak.slice(0, 200));
  const bOwn = await callTool(cB, 'recall', { question: 'green tea steeping' });
  ok('after the switch, brain B serves its own note', /qwertybravo/i.test(bOwn), bOwn.slice(0, 200));
  const stateB = await api('/api/state');
  ok('cockpit re-baselined to brain B as well',
    path.resolve(stateB.brainPath) === path.resolve(brainB) && stateB.notes === (await countNotes(brainB)),
    JSON.stringify({ notes: stateB.notes, brainPath: stateB.brainPath }));
  await cB.close();
} finally {
  if (savedConfig) await fs.writeFile(CONFIG, savedConfig).catch(() => {});
  else await fs.rm(CONFIG, { force: true }).catch(() => {});
  for (const d of [brainA, brainB]) {
    await fs.rm(cacheDirOf(d), { recursive: true, force: true }).catch(() => {});
    await fs.rm(d, { recursive: true, force: true }).catch(() => {});
  }
  await fs.rm(process.env.CALLOSIUM_HISTORY_ROOT, { recursive: true, force: true }).catch(() => {});
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail === 0) console.log('  ALL PASS');
process.exit(fail ? 1 : 0);
