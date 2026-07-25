// End-to-end MCP test: init a fixture brain, pair an agent, connect a real
// MCP client over stdio, exercise every tool, verify scoping + attribution.
//   node test/e2e-mcp.mjs <fixture-dir>

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repo, 'src', 'cli.ts');
const fixture = path.resolve(process.argv[2] || path.join(repo, 'test', '.fixture-brain'));

let pass = 0,
  fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name} ${extra}`);
  }
};

// ─── setup ────────────────────────────────────────────────────────────
await fs.rm(fixture, { recursive: true, force: true });
execFileSync('node', [cli, 'init', fixture], { stdio: 'pipe' });
ok('init scaffolds partitions', (await fs.stat(path.join(fixture, 'Profile'))).isDirectory());
ok('init writes schema into brain', (await fs.stat(path.join(fixture, 'System', 'brain.json'))).isFile());

// A private note the agent must never see
await fs.mkdir(path.join(fixture, 'Private'), { recursive: true });
await fs.writeFile(
  path.join(fixture, 'Private', 'Secret.md'),
  '---\ntype: knowledge\ntags: [secret]\nstatus: active\nupdated: 2026-07-11\n---\n\n# Secret\n\nThe secret passphrase is zanzibar.\n',
);
// A normal knowledge note for recall
await fs.writeFile(
  path.join(fixture, 'Knowledge', 'Espresso Ratios.md'),
  '---\ntype: knowledge\ntags: [coffee]\nstatus: active\nupdated: 2026-07-11\n---\n\n# Espresso ratios\n\nThe house espresso ratio is 1:2, eighteen grams in, thirty-six out, in 28 seconds.\n',
);

execFileSync('node', [cli, 'pair', 'test-claude', 'Claude (Test)', '--brain', fixture], { stdio: 'pipe' });
const reg = JSON.parse(await fs.readFile(path.join(fixture, 'System', 'agents.json'), 'utf8'));
const token = reg.agents[0].token;
ok('pair registers agent with token', !!token && reg.agents[0].displayName === 'Claude (Test)');

// ─── connect a real MCP client ────────────────────────────────────────
const transport = new StdioClientTransport({
  command: 'node',
  args: [cli, 'mcp', '--brain', fixture, '--agent', 'test-claude', '--token', token],
});
const client = new Client({ name: 'e2e-test', version: '0.0.0' });
await client.connect(transport);

const tools = await client.listTools();
ok(
  'server exposes all 20 tools',
  [
    'recall',
    'search',
    'read_note',
    'fetch_document',
    'get_map',
    'get_filing_rules',
    'list_notes',
    'recent',
    'gather',
    'skills',
    'glossary',
    'related',
    'resolve',
    'write_note',
    'append_note',
    'archive_note',
    'remember',
    'overview',
    'brain_check',
    'get_instructions',
  ].every((t) => tools.tools.some((x) => x.name === t)),
  tools.tools.map((t) => t.name).join(','),
);

// `recent` (date-range retrieval): a dated note out of the window is excluded
// — time-aware, not topic-ranked.
await client.callTool({
  name: 'write_note',
  arguments: { path: 'Logs/Session 5 January 2020.md', content: '# Session 5 January 2020\n\nAncient work on the widget.' },
});
const recentOut = (await client.callTool({ name: 'recent', arguments: { question: 'what did I do lately', days: 3 } })).content[0].text;
ok('recent excludes an out-of-window (2020) note', !/Session 5 January 2020/.test(recentOut), recentOut.slice(0, 200));
const recentNone = (await client.callTool({ name: 'recent', arguments: { question: 'tell me about espresso' } })).content[0].text;
ok('recent with no time window returns a graceful hint', /no time window/i.test(recentNone), recentNone.slice(0, 120));

// EVENT-TIME rescue: a note whose FILE date is out of the window (filename dated
// 1 May, overriding write_note's today stamp) but whose BODY records a dated
// event IN the window is surfaced as real movement, annotated with the event
// date — the stale-date "filled 7 Jul" case. Its topic word ("acme") matches its path.
await client.callTool({
  name: 'write_note',
  arguments: { path: 'Knowledge/Acme Deal 1 May 2026.md', content: '# Acme Deal\n\nAcme proposal filled 10 Jul 2026, pending sign-off.' },
});
// control: same topic, out-of-window file date, and ONLY out-of-window body dates → must stay excluded
await client.callTool({
  name: 'write_note',
  arguments: { path: 'Knowledge/Acme Legacy 2 May 2026.md', content: '# Acme Legacy\n\nAcme initial scoping 1 Feb 2026 and 3 Mar 2026, nothing since.' },
});
const rescueOut = (await client.callTool({ name: 'recent', arguments: { question: 'what moved on acme', days: 20 } })).content[0].text;
ok('recent RESCUES an out-of-window note with an in-window body event', /Acme Deal 1 May 2026\.md/.test(rescueOut), rescueOut.slice(0, 300));
ok('recent dates the rescued note by its body event (10 Jul), annotated', /⟨in note: 2026-07-10/.test(rescueOut), rescueOut.slice(0, 300));
ok('recent does NOT surface a topical note whose body dates are all out of window', !/Acme Legacy 2 May 2026\.md/.test(rescueOut), rescueOut.slice(0, 300));

// `skills`: a SKILL.md filed in the brain is discoverable (cross-AI portability).
await client.callTool({
  name: 'write_note',
  arguments: { path: 'Reference/Skills/widget-builder/SKILL.md', content: '---\nname: widget-builder\ndescription: Build a widget end to end for any client.\n---\n\n# Widget builder\n\nSteps to build a widget.' },
});
const skillsOut = (await client.callTool({ name: 'skills', arguments: {} })).content[0].text;
ok('skills lists a filed SKILL.md so any AI can find it', /widget-builder/.test(skillsOut), skillsOut.slice(0, 200));

const text = (r) => r.content[0].text;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// get_instructions
const instr = await client.callTool({ name: 'get_instructions', arguments: {} });
ok('instructions name the agent', text(instr).includes('Claude (Test)'));
ok('instructions point to get_map first', text(instr).includes('get_map'));

// get_map — the routing map, generated from the brain's real structure
const mapT = text(await client.callTool({ name: 'get_map', arguments: {} }));
ok('get_map returns a Brain Map with the structure', mapT.includes('Brain Map') && mapT.includes('Knowledge/') && /where everything lives/i.test(mapT));
ok('get_map never leaks Private/ or System internals', !mapT.includes('Private/Secret') && !/^### System\//m.test(mapT));

// get_filing_rules — the schema-derived rules the structuring LLM follows
const rulesT = text(await client.callTool({ name: 'get_filing_rules', arguments: {} }));
ok('get_filing_rules lists partitions + routing + frontmatter', /Filing rules/i.test(rulesT) && rulesT.includes('Knowledge/') && /frontmatter/i.test(rulesT));
// scope: the default agent has denyRead Private/ — filing rules must NOT disclose
// that a gated Private partition exists (matches get_map's scope invariant).
ok('get_filing_rules hides denied Private/ partition', !/\bPrivate\//.test(rulesT) && !/gated sensitive/i.test(rulesT));

// remember → attribution stamped
const rem = await client.callTool({ name: 'remember', arguments: { text: 'Fixture brains taste like coffee.', title: 'Fixture test memory' } });
ok('remember files under Memory/<Source>/', text(rem).includes('Memory/Claude (Test)/'));
const memPathRel = text(rem).match(/Stored: (.+\.md)/)?.[1];
const memRaw = await fs.readFile(path.join(fixture, memPathRel), 'utf8');
ok('memory is attribution-stamped', memRaw.includes('created_by: Claude (Test)') && memRaw.includes('updated_by: Claude (Test)'));

// recall finds it; private note excluded
const rec = JSON.parse(text(await client.callTool({ name: 'recall', arguments: { question: 'what is the house espresso ratio' } })));
ok('recall finds the knowledge note', rec.found && rec.results.some((r) => r.path.includes('Espresso')));
const recSecret = JSON.parse(text(await client.callTool({ name: 'recall', arguments: { question: 'what is the secret passphrase zanzibar' } })));
ok('recall never leaks Private/ content', !recSecret.found || recSecret.results.every((r) => !r.path.startsWith('Private/')));
// SCOPE-BEFORE-RANK (P2 #4): "zanzibar" lives ONLY in the denied Private/ note, so
// for this scoped agent it must be a UNIFORM miss — recall never saw the out-of-
// scope note, so found is false and the reason must NOT disclose that a match
// exists elsewhere (the old post-rank path leaked "matches exist outside your scope").
ok('scoped recall returns a uniform miss for out-of-scope-only content', recSecret.found === false);
ok('scoped-miss reason never discloses out-of-scope existence',
  !/scope|access|outside/i.test(String(recSecret.notInBrainReason || '')));

// read_note scope denial
let denied = false;
try {
  await client.callTool({ name: 'read_note', arguments: { path: 'Private/Secret.md' } });
} catch {
  denied = true;
}
const deniedResult = denied || text(await client.callTool({ name: 'read_note', arguments: { path: 'Private/Secret.md' } }).catch(() => ({ content: [{ type: 'text', text: 'DENIED' }] })));
ok('read_note denies Private/', denied || String(deniedResult).includes('DENIED') || String(deniedResult).includes('Scope denied'));

// agents.json is server-only even though it's in System/
let regDenied = false;
try {
  const r = await client.callTool({ name: 'read_note', arguments: { path: 'System/agents.json' } });
  regDenied = text(r).includes('Scope denied') || (r.isError ?? false);
} catch {
  regDenied = true;
}
ok('agent registry unreadable by agents', regDenied);

// path-traversal must not defeat scope (canRead/canWrite normalize first)
async function readDenied(p) {
  try {
    const r = await client.callTool({ name: 'read_note', arguments: { path: p } });
    return text(r).includes('Scope denied') || (r.isError ?? false);
  } catch {
    return true;
  }
}
ok('traversal into registry denied', await readDenied('Knowledge/../System/agents.json'));
ok('traversal into Private denied', await readDenied('Knowledge/../Private/Secret.md'));
ok('deep traversal into registry denied', await readDenied('a/b/../../System/agents.json'));
// case-insensitive filesystem bypass (Windows/macOS resolve these to the same file)
ok('lowercase registry path denied', await readDenied('system/agents.json'));
ok('mixedcase registry path denied', await readDenied('System/AGENTS.json'));
ok('lowercase Private denied', await readDenied('private/Secret.md'));
ok('empty path denied', await readDenied(''));
// write traversal into a denied path must be rejected
let wtDenied = false;
try {
  const r = await client.callTool({ name: 'write_note', arguments: { path: 'Knowledge/../System/agents.json', content: '# x\n\npwned' } });
  wtDenied = text(r).includes('Scope denied') || (r.isError ?? false);
} catch {
  wtDenied = true;
}
ok('write traversal into registry denied', wtDenied);
const regStillRaw = await fs.readFile(path.join(fixture, 'System', 'agents.json'), 'utf8');
ok('registry untouched by traversal write', regStillRaw.includes('"token"'));

// attribution forgery: malformed-YAML frontmatter must be rejected, not
// written verbatim (which would skip server stamping)
let forgeRejected = false;
try {
  const r = await client.callTool({
    name: 'write_note',
    arguments: { path: 'Knowledge/Forged.md', content: '---\ntags: [a: b: c]\ncreated_by: The Human\n---\n\nbody' },
  });
  forgeRejected = text(r).includes('did not parse') || (r.isError ?? false);
} catch {
  forgeRejected = true;
}
ok('malformed-frontmatter write rejected (no forged attribution)', forgeRejected);
const forgedExists = await fs.stat(path.join(fixture, 'Knowledge', 'Forged.md')).then(() => true).catch(() => false);
ok('forged note not written', !forgedExists);

// write_note entity resolution: same title again → refuses duplicate
await client.callTool({ name: 'write_note', arguments: { type: 'knowledge', title: 'Grinder Settings', content: 'Start at 12 clicks.' } });
const dup = await client.callTool({ name: 'write_note', arguments: { type: 'knowledge', title: 'Grinder Settings', content: 'Different text.' } });
ok('entity resolution blocks duplicate create', text(dup).includes('already exists'));

// write_note REFUSES to silently overwrite an existing note (the data-loss guard).
const noOv = await client.callTool({ name: 'write_note', arguments: { path: 'Knowledge/Espresso Ratios.md', content: 'this should be refused' } });
ok('write_note refuses overwrite without flag', text(noOv).includes('NOT written') && text(noOv).includes('overwrite'));

// A DELIBERATE update (overwrite:true) stamps updated_by but keeps created_by.
const upd = await client.callTool({ name: 'write_note', arguments: { path: 'Knowledge/Espresso Ratios.md', content: '# Espresso ratios\n\nUpdated: 1:2.2 now.', overwrite: true } });
const updRaw = await fs.readFile(path.join(fixture, 'Knowledge', 'Espresso Ratios.md'), 'utf8');
ok('update stamps updated_by', updRaw.includes('updated_by: Claude (Test)'));
ok('update does not forge created_by', !updRaw.includes('created_by: Claude (Test)'));

// brain_check runs — output is SCOPED to the agent (no whole-vault stat leak):
// it reports notesInYourScope + scope-limited findings, not raw report.notes.
const chk = JSON.parse(text(await client.callTool({ name: 'brain_check', arguments: {} })));
ok('brain_check reports', typeof chk.notesInYourScope === 'number' && chk.notesInYourScope > 0 && Array.isArray(chk.findings));

// ─── v1.1 tools ───────────────────────────────────────────────────────
// search returns ranked hits with snippets
const srch = JSON.parse(text(await client.callTool({ name: 'search', arguments: { query: 'espresso ratio' } })));
ok('search returns ranked hits', Array.isArray(srch) && srch.some((h) => h.path.includes('Espresso')) && srch[0].snippet.length > 0);

// list_notes browses a prefix
const lst = JSON.parse(text(await client.callTool({ name: 'list_notes', arguments: { prefix: 'Knowledge/' } })));
ok('list_notes browses prefix', lst.every((f) => f.startsWith('Knowledge/')) && lst.length >= 2);

// resolve finds the canonical entity
const res = JSON.parse(text(await client.callTool({ name: 'resolve', arguments: { name: 'Grinder Settings' } })));
ok('resolve finds canonical note', res.exists && res.canonical === 'Knowledge/Grinder Settings.md');
const resNo = JSON.parse(text(await client.callTool({ name: 'resolve', arguments: { name: 'Nonexistent Entity XYZ' } })));
ok('resolve says safe-to-create honestly', !resNo.exists);

// append_note adds without destroying
await client.callTool({ name: 'append_note', arguments: { path: 'Knowledge/Grinder Settings.md', content: 'Update: 11 clicks in summer humidity.' } });
const grinderRaw = await fs.readFile(path.join(fixture, 'Knowledge', 'Grinder Settings.md'), 'utf8');
ok('append_note keeps old content', grinderRaw.includes('Start at 12 clicks') && grinderRaw.includes('11 clicks in summer'));

// archive_note retires from recall but file survives
await client.callTool({ name: 'archive_note', arguments: { path: 'Knowledge/Grinder Settings.md', reason: 'superseded by test' } });
const archRaw = await fs.readFile(path.join(fixture, 'Knowledge', 'Grinder Settings.md'), 'utf8');
ok('archive_note marks status + reason', archRaw.includes('status: archived') && archRaw.includes('superseded by test'));
// Archived = demoted, NOT excluded: still findable (episodic memory must
// survive archiving), but an active note on the same topic outranks it.
await client.callTool({ name: 'write_note', arguments: { type: 'knowledge', title: 'Grinder Care', content: 'Clean the grinder burrs; clicks drift in humidity.' } });
const srch2 = JSON.parse(text(await client.callTool({ name: 'search', arguments: { query: 'grinder clicks' } })));
ok('archived note still findable', srch2.some((h) => h.path.includes('Grinder Settings')));
const posActive = srch2.findIndex((h) => h.path.includes('Grinder Care'));
const posArchived = srch2.findIndex((h) => h.path.includes('Grinder Settings'));
ok('active note outranks archived', posActive !== -1 && posActive < posArchived);

// overview orients the agent
const ov = JSON.parse(text(await client.callTool({ name: 'overview', arguments: {} })));
ok('overview shows partitions + scope', ov.partitions && ov.yourScope && ov.notes > 0);
ok('overview hides Private/ from counts', !Object.keys(ov.partitions).includes('Private'));

// ─── Phase G: whole-document + folder fetch ─────────────────────────────
// read_note { whole:true } returns a LARGE note in FULL (the rewrite-the-whole-
// proposal job), bypassing the outline-only large-note guard.
const bigBody = '# Big Proposal\n\n' + Array.from({ length: 400 }, (_, i) => `Section ${i}: the marker token bananaphone${i} appears here with enough prose to push this note well past the twelve-thousand character large-note threshold so the guard engages.`).join('\n\n');
await fs.writeFile(path.join(fixture, 'Knowledge', 'Big Proposal.md'), `---\ntype: knowledge\ntags: [big]\nstatus: active\nupdated: 2026-07-16\n---\n\n${bigBody}\n`);
await sleep(1700);
const guarded = text(await client.callTool({ name: 'read_note', arguments: { path: 'Knowledge/Big Proposal.md' } }));
ok('large note is guarded by default (outline, not full)', guarded.includes('LARGE NOTE') && !guarded.includes('bananaphone399'));
const whole = text(await client.callTool({ name: 'read_note', arguments: { path: 'Knowledge/Big Proposal.md', whole: true } }));
ok('read_note whole:true returns the ENTIRE note', whole.includes('bananaphone0') && whole.includes('bananaphone399'));

// fetch_document on a single note → full text
const fdNote = text(await client.callTool({ name: 'fetch_document', arguments: { path: 'Knowledge/Big Proposal.md' } }));
ok('fetch_document returns a whole note in full', fdNote.includes('bananaphone0') && fdNote.includes('bananaphone399'));
// fetch_document must enforce scope on the same input read_note does: traversal
// and absolute-path tricks into Private/Secret.md are denied (canRead sees the
// raw path, not a pre-stripped one).
async function fdDenied(pp) {
  try { const r = await client.callTool({ name: 'fetch_document', arguments: { path: pp } }); return text(r).includes('Scope denied') || (r.isError ?? false); }
  catch { return true; }
}
ok('fetch_document denies traversal into Private/', await fdDenied('Knowledge/../Private/Secret.md'));
ok('fetch_document denies absolute path into Private/', await fdDenied('/Private/Secret.md'));
// fetch_document on a FOLDER → every readable note under it, path-headed.
// Big budget so both notes INLINE (default budget would defer the ~56KB
// Big Proposal's neighbours — that path is covered by the overflow test below).
const fdFolder = text(await client.callTool({ name: 'fetch_document', arguments: { path: 'Knowledge', maxChars: 300000 } }));
ok('fetch_document folder concatenates member notes', fdFolder.includes('=== Knowledge/Big Proposal.md') && fdFolder.includes('=== Knowledge/Espresso Ratios.md'));
ok('fetch_document folder never leaks Private/', !fdFolder.includes('Private/Secret.md') && !fdFolder.includes('zanzibar'));
// budget overflow lists (never silently drops) the deferred notes
const fdBudget = text(await client.callTool({ name: 'fetch_document', arguments: { path: 'Knowledge', maxChars: 1000 } }));
ok('fetch_document surfaces budget overflow (no silent truncation)', fdBudget.includes('deferred'));

// ─── live re-index: an EXTERNAL edit (user in Obsidian, sync client) is picked
// up by the freshness-on-read check without restarting the session. ───
// (a) external ADD → becomes searchable
await fs.writeFile(
  path.join(fixture, 'Knowledge', 'Live Edit.md'),
  '---\ntype: knowledge\ntags: [live]\nstatus: active\nupdated: 2026-07-15\n---\n\n# Live edit\n\nThe passphrase xylophonemarmalade proves live re-index works.\n',
);
await sleep(1700); // past the freshness throttle so the next read re-checks the tree
const liveSrch = JSON.parse(text(await client.callTool({ name: 'search', arguments: { query: 'xylophonemarmalade' } })));
ok('external ADD picked up live (no restart)', Array.isArray(liveSrch) && liveSrch.some((h) => h.path.includes('Live Edit')));
// (b) external DELETE → drops out of results
await fs.rm(path.join(fixture, 'Knowledge', 'Live Edit.md'));
await sleep(1700);
const goneSrch = JSON.parse(text(await client.callTool({ name: 'search', arguments: { query: 'xylophonemarmalade' } })));
ok('external DELETE picked up live', Array.isArray(goneSrch) && !goneSrch.some((h) => h.path.includes('Live Edit')));

// ─── graph self-heal: deleting a note prunes the edges that pointed AT it, and
// `related` (which reads only the graph) still sees the change via the shared
// freshness gate — no dangling link to a note that's gone. ───
await fs.writeFile(
  path.join(fixture, 'Knowledge', 'Beta.md'),
  '---\ntype: knowledge\ntags: [g]\nstatus: active\nupdated: 2026-07-15\n---\n\n# Beta\n\nA target note.\n',
);
await fs.writeFile(
  path.join(fixture, 'Knowledge', 'Alpha.md'),
  '---\ntype: knowledge\ntags: [g]\nstatus: active\nupdated: 2026-07-15\n---\n\n# Alpha\n\nAlpha links to [[Beta]] here.\n',
);
await sleep(1700);
const relBefore = JSON.parse(text(await client.callTool({ name: 'related', arguments: { path: 'Knowledge/Alpha.md' } })));
ok('graph edge resolves after external add', Array.isArray(relBefore) && relBefore.some((r) => r.other === 'Knowledge/Beta.md'));
await fs.rm(path.join(fixture, 'Knowledge', 'Beta.md'));
await sleep(1700);
const relAfter = JSON.parse(text(await client.callTool({ name: 'related', arguments: { path: 'Knowledge/Alpha.md' } })));
ok('graph self-heals: edge to deleted note pruned', Array.isArray(relAfter) && !relAfter.some((r) => r.other === 'Knowledge/Beta.md'));

// bad token rejected
let badRejected = false;
try {
  const badTransport = new StdioClientTransport({
    command: 'node',
    args: [cli, 'mcp', '--brain', fixture, '--agent', 'test-claude', '--token', 'wrong-token'],
  });
  const badClient = new Client({ name: 'e2e-bad', version: '0.0.0' });
  await badClient.connect(badTransport);
  await badClient.close();
} catch {
  badRejected = true;
}
ok('bad token cannot connect', badRejected);

// ─── Private is owner-grantable per-agent; System is NEVER grantable ───────
// Pair a second agent, then have the OWNER grant it Private by clearing its
// denyRead (the exact effect of switching Private on in the Agents screen).
// The granted agent must now READ Private — but System must STILL be denied,
// because System is the one structurally reserved folder no scope can open.
execFileSync('node', [cli, 'pair', 'test-granted', 'Trusted AI', '--brain', fixture], { stdio: 'pipe' });
const reg2 = JSON.parse(await fs.readFile(path.join(fixture, 'System', 'agents.json'), 'utf8'));
const granted = reg2.agents.find((a) => a.id === 'test-granted');
granted.scopes.denyRead = []; // owner grants Private (and everything but System)
const grantedToken = granted.token;
await fs.writeFile(path.join(fixture, 'System', 'agents.json'), JSON.stringify(reg2, null, 2));

const grantTransport = new StdioClientTransport({
  command: 'node',
  args: [cli, 'mcp', '--brain', fixture, '--agent', 'test-granted', '--token', grantedToken],
});
const grantClient = new Client({ name: 'e2e-grant', version: '0.0.0' });
await grantClient.connect(grantTransport);
const priv = await grantClient.callTool({ name: 'read_note', arguments: { path: 'Private/Secret.md' } }).catch(() => ({ content: [{ type: 'text', text: 'ERR' }] }));
ok('granted agent CAN read Private/', text(priv).includes('zanzibar'));
// System stays locked even with denyRead cleared — RESERVED, not scope-driven
let sysStillDenied = false;
try {
  const r = await grantClient.callTool({ name: 'read_note', arguments: { path: 'System/agents.json' } });
  sysStillDenied = text(r).includes('Scope denied') || (r.isError ?? false);
} catch { sysStillDenied = true; }
ok('granted agent STILL denied System/ (never grantable)', sysStillDenied);
await grantClient.close();

// ─── fresh-process stale-graph: a NEW MCP process reads the persisted graph.json
// (loadGraph, unpruned) — an edge to a note deleted while it was down must NOT be
// returned as a live neighbor (existence filter at the consumer, not just self-heal). ───
await fs.writeFile(
  path.join(fixture, 'Knowledge', 'Delta.md'),
  '---\ntype: knowledge\ntags: [g]\nstatus: active\nupdated: 2026-07-15\n---\n\n# Delta\n\nTarget.\n',
);
await fs.writeFile(
  path.join(fixture, 'Knowledge', 'Gamma.md'),
  '---\ntype: knowledge\ntags: [g]\nstatus: active\nupdated: 2026-07-15\n---\n\n# Gamma\n\nGamma links to [[Delta]].\n',
);
await sleep(1700);
// build + PERSIST the graph (X->Y) via the current client
const relBuilt = JSON.parse(text(await client.callTool({ name: 'related', arguments: { path: 'Knowledge/Gamma.md' } })));
ok('edge built + persisted (Gamma->Delta)', Array.isArray(relBuilt) && relBuilt.some((r) => r.other === 'Knowledge/Delta.md'));
// now delete Delta and connect a BRAND-NEW process (fresh caches, loadGraph reads the stale graph.json)
await fs.rm(path.join(fixture, 'Knowledge', 'Delta.md'));
const freshT = new StdioClientTransport({ command: 'node', args: [cli, 'mcp', '--brain', fixture, '--agent', 'test-claude', '--token', token] });
const freshC = new Client({ name: 'e2e-freshgraph', version: '0.0.0' });
await freshC.connect(freshT);
const relFresh = JSON.parse(text(await freshC.callTool({ name: 'related', arguments: { path: 'Knowledge/Gamma.md' } })));
ok('fresh process never returns a deleted neighbor', Array.isArray(relFresh) && !relFresh.some((r) => r.other === 'Knowledge/Delta.md'));
await freshC.close();
await fs.rm(path.join(fixture, 'Knowledge', 'Gamma.md')).catch(() => {});

// ─── token rotation: `callosium rotate` kills the old token, mints a new one ───
execFileSync('node', [cli, 'pair', 'test-rot', 'Rotatable', '--brain', fixture], { stdio: 'pipe' });
const oldTok = JSON.parse(await fs.readFile(path.join(fixture, 'System', 'agents.json'), 'utf8')).agents.find((a) => a.id === 'test-rot').token;
execFileSync('node', [cli, 'rotate', 'test-rot', '--brain', fixture], { stdio: 'pipe' });
const newTok = JSON.parse(await fs.readFile(path.join(fixture, 'System', 'agents.json'), 'utf8')).agents.find((a) => a.id === 'test-rot').token;
ok('rotate mints a different token', newTok && newTok !== oldTok);
// old token must no longer connect
let oldTokRejected = false;
try {
  const t = new StdioClientTransport({ command: 'node', args: [cli, 'mcp', '--brain', fixture, '--agent', 'test-rot', '--token', oldTok] });
  const c = new Client({ name: 'e2e-rot-old', version: '0.0.0' }); await c.connect(t); await c.close();
} catch { oldTokRejected = true; }
ok('rotated-away token cannot connect', oldTokRejected);
// new token works
const rotT = new StdioClientTransport({ command: 'node', args: [cli, 'mcp', '--brain', fixture, '--agent', 'test-rot', '--token', newTok] });
const rotC = new Client({ name: 'e2e-rot-new', version: '0.0.0' });
let newTokWorks = false;
try { await rotC.connect(rotT); newTokWorks = (await rotC.listTools()).tools.length > 0; await rotC.close(); } catch { newTokWorks = false; }
ok('new token connects after rotation', newTokWorks);

// ─── token expiry: a past expiresAt refuses the connection (both flows) ───
execFileSync('node', [cli, 'pair', 'test-exp', 'Expiring', '--brain', fixture], { stdio: 'pipe' });
const regE = JSON.parse(await fs.readFile(path.join(fixture, 'System', 'agents.json'), 'utf8'));
const expAgent = regE.agents.find((a) => a.id === 'test-exp');
expAgent.expiresAt = '2020-01-01T00:00:00.000Z'; // in the past
const expTok = expAgent.token;
await fs.writeFile(path.join(fixture, 'System', 'agents.json'), JSON.stringify(regE, null, 2));
let expiredRejected = false;
try {
  const t = new StdioClientTransport({ command: 'node', args: [cli, 'mcp', '--brain', fixture, '--agent', 'test-exp', '--token', expTok] });
  const c = new Client({ name: 'e2e-exp', version: '0.0.0' }); await c.connect(t); await c.close();
} catch { expiredRejected = true; }
ok('expired token cannot connect', expiredRejected);

await client.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
