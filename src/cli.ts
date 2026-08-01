#!/usr/bin/env node
// callosium — one brain, every AI, your files.
//
//   callosium serve [--brain p] [--port n]     open the dashboard (onboarding + cockpit)
//   callosium init [path]                      scaffold a brain (or adopt an existing vault)
//   callosium recall "question" [--brain p]    deterministic recall with evidence
//   callosium map [--brain p] [--write]        the brain's routing map (how it's organized)
//   callosium rules [--brain p]                the filing rules (where new notes go)
//   callosium check [--brain p]                audit the brain (report only)
//   callosium pair <id> <display name>         register an agent, print its token + client config
//   callosium rotate <id>                      issue a fresh token for an agent (revokes the old)
//   callosium mcp --agent <id> --token <t>     serve the brain over MCP (stdio; add --http for HTTP)
//   callosium remember "text" --title "Topic"  store a memory record (as the human owner)
//   callosium --version                        print the installed version

import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { Vault } from './core/vault.ts';

// How an MCP client should LAUNCH us. Never the bare `callosium` command: the MCP
// SDK spawns with shell:false, and measured on Windows with callosium globally
// installed and on PATH, spawn('callosium') is ENOENT and spawn('callosium.cmd')
// is EINVAL. Resolve our OWN module path — not process.argv[1], because npm
// symlinks the bin on macOS/Linux and Node does not realpath argv[1], so any
// argv[1] test is false on exactly the platforms it exists to help. Hand back the
// running interpreter plus an absolute script path. No platform branch: there is
// nothing platform-specific about it. npx installs into a temp cache that is
// deleted after the run, so a config pointing there would break — fall back to
// the bare command in that one case.
function mcpLaunch(args: string[]): { command: string; args: string[]; env?: Record<string, string> } {
  const cliPath = fileURLToPath(import.meta.url);
  if (/[\\/]_npx[\\/]/.test(cliPath)) return { command: 'callosium', args };
  const modelDir = process.env.CALLOSIUM_MODEL_DIR;
  return {
    command: process.execPath,
    args: [cliPath, ...args],
    ...(modelDir ? { env: { CALLOSIUM_MODEL_DIR: modelDir } } : {}),
  };
}

import { loadSchema, SCHEMA_IN_BRAIN } from './core/schema.ts';
import { generateMap, generateFilingRules, writeMap, MAP_REL } from './structure/map.ts';
import { serializeNote, isoDate } from './core/frontmatter.ts';
import { loadTexts, recall, relationshipHonesty } from './recall/engine.ts';
import { loadGraph, buildGraph } from './graph/index.ts';
import { loadEmbeddings } from './recall/semantic.ts';
import { brainCheck } from './check/check.ts';
import { routeNote } from './filing/engine.ts';
import { pairAgent, rotateAgentToken } from './mcp/agents.ts';
import { serve, serveHttp } from './mcp/server.ts';
import { serveDashboard, loadPersistedBrain } from './dashboard/server.ts';

const argv = process.argv.slice(2);

// The command WORD, or undefined when there isn't one. `callosium --port 4400`
// has no command — it is configuring the default action — but argv[0] is
// '--port', which would otherwise be reported as an unknown command. Anything
// leading with a dash that isn't --version/--help means "no command given".
const RAW_CMD = argv[0];
const IS_META = RAW_CMD === '--version' || RAW_CMD === '-v' || RAW_CMD === '--help' || RAW_CMD === '-h';
const cmd =
  RAW_CMD === undefined || (!IS_META && RAW_CMD.startsWith('-')) ? undefined : RAW_CMD;

// How we were invoked. `npx callosium` runs this file out of npm's _npx cache
// and installs NOTHING on PATH — that is what npx is FOR — so a help screen
// that says `callosium serve` hands the reader a command their shell rejects.
// Print the form that will actually work for them.
const VIA_NPX =
  /[\\/]_npx[\\/]/.test(process.argv[1] ?? '') || process.env.npm_command === 'exec';
const CMD = VIA_NPX ? 'npx callosium' : 'callosium';

function printHelp(): void {
  const rows: [string, string][] = [
    ['init [path]', 'scaffold or adopt a brain'],
    ['serve [--brain p] [--port n]', 'open the dashboard (the cockpit)'],
    ['recall "question" [--brain p]', 'deterministic recall with evidence'],
    ['map [--brain p] [--write]', "the brain's routing map (how it's organized)"],
    ['rules [--brain p]', 'the filing rules (where new notes go)'],
    ['check [--brain p] [--verbose]', 'audit the brain (report only)'],
    ['pair <id> <name> [--brain p]', 'register an agent + print client config'],
    ['rotate <id> [--brain p]', 'issue a fresh token for an agent (revokes the old)'],
    ['mcp --agent <id> --token <t>', 'serve over MCP (stdio; add --http for HTTP)'],
    ['remember "text" --title "Topic"', 'store a memory record'],
    ['--version', 'print the version'],
  ];
  const left = rows.map(([usage]) => `${CMD} ${usage}`);
  const width = Math.max(...left.map((s) => s.length));
  console.log(
    [
      'callosium — one brain, every AI, your files.',
      '',
      `  Just want it open? Run it with no arguments:  ${CMD}`,
      '  It opens the dashboard and walks you through setting up your brain.',
      '',
      ...rows.map(([, desc], i) => `  ${left[i].padEnd(width)}  ${desc}`),
    ].join('\n'),
  );
}

// Known flags and whether each takes a following value. Anything else that
// merely starts with "--" is ordinary free text (e.g. "we discussed --pricing
// options") and must NOT be treated as a flag — the old blanket "starts with
// --" rule silently ate such words AND the token after them.
const KNOWN_FLAGS: Record<string, boolean> = {
  brain: true,
  port: true,
  title: true,
  agent: true,
  token: true,
  verbose: false,
  json: false,
  write: false,
};

function flag(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

function positional(after: number): string[] {
  const out: string[] = [];
  for (let i = after; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const name = a.slice(2);
      // hasOwn, not `in`: `in` also matches everything on Object.prototype, so
      // "--constructor" / "--toString" / "--__proto__" looked like known flags —
      // and since their prototype values are truthy, the branch below ate the
      // NEXT word too. `callosium recall --constructor pricing` came back
      // "Usage: callosium recall "question"" with the whole question gone. Only
      // the flags we actually declare above may swallow anything.
      if (Object.hasOwn(KNOWN_FLAGS, name)) {
        if (KNOWN_FLAGS[name]) i++; // skip this flag's value too
        continue;
      }
      // unknown "--something" → keep it as free text (fall through to push)
    }
    out.push(a);
  }
  return out;
}

const brainPath = () => flag('brain') || process.env.CALLOSIUM_BRAIN || process.cwd();

async function main() {
  switch (cmd) {
    case '--version':
    case '-v': {
      // package.json sits one level up from dist/cli.js (and from src/cli.ts) and
      // is always in the npm tarball, so this resolves for both installed + dev runs.
      try {
        const pj = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
        console.log(`callosium ${pj.version}`);
      } catch {
        console.log('callosium');
      }
      break;
    }

    // No command at all opens the dashboard. This used to print the help menu,
    // which was the worst thirty seconds in the product: `npx callosium` fetches
    // the package, runs it, prints a list of `callosium <thing>` commands and
    // leaves NOTHING on PATH — because not installing is what npx is FOR — so
    // every command in that menu answers "command not found". Nothing about the
    // help was reachable advice. Opening the dashboard is: it already handles a
    // machine with no brain by falling through to onboarding, which is where the
    // "what do you have?" question belongs, and it auto-opens the browser. One
    // word is the whole install.
    case undefined:
    case 'serve':
    case 'dashboard': {
      const brainArg = flag('brain');
      // serveDashboard treats an unreachable --brain as "no --brain given" and
      // silently reconnects the LAST brain it served (its persisted config), so a
      // typo'd or not-yet-mounted path opened a DIFFERENT brain — the owner then
      // reads, edits and lets agents write into the wrong one, believing the flag
      // took. Refuse here, at the point the owner stated an intent: no dashboard
      // at all is a far cheaper failure than the wrong brain.
      let brain: string | undefined;
      if (argv.includes('--brain')) {
        if (!brainArg) throw new Error('--brain needs a path: callosium serve --brain <path>');
        brain = path.resolve(brainArg);
        const st = await fs.stat(brain).catch(() => null);
        if (!st) throw new Error(`No brain at ${brain} — check the path, or run 'callosium init ${brainArg}' to create one there.`);
        if (!st.isDirectory()) throw new Error(`--brain must point at a brain folder, but ${brain} is a file.`);
      }
      let port: number | undefined;
      if (flag('port')) {
        port = Number(flag('port'));
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('--port must be an integer between 1 and 65535');
      }
      await serveDashboard({ brain, port });
      // keep the process alive to serve the dashboard
      await new Promise(() => {});
      break;
    }

    case 'init': {
      const target = path.resolve(positional(1)[0] || process.cwd());
      await fs.mkdir(target, { recursive: true });
      const vault = new Vault(target);
      const { schema } = await loadSchema(vault);
      // Copy the schema INTO the brain so the user can see and edit their constitution.
      // Stamp it as the PACKAGED DEFAULT, not an owner-authored constitution: loadSchema
      // reads that stamp back and keeps `source` as 'default', which keeps `strict` false
      // in check.ts. Without it, merely running `callosium init` over an existing vault
      // flips every plain Obsidian note to "malformed" — measured at 3 findings per note,
      // so ~3,600 on a real 1,200-note vault, on the path the README calls adopting a
      // vault where "your files are never reformatted". The dashboard's handleInit stamps
      // the same field; this is the CLI half, which is the README's own quickstart.
      if (!vault.exists(SCHEMA_IN_BRAIN)) {
        const seeded = { ...(schema as Record<string, unknown>), derivedFrom: 'packaged-default' };
        await vault.writeFile(SCHEMA_IN_BRAIN, JSON.stringify(seeded, null, 2));
      }
      let created = 0;
      for (const p of schema.partitions.core) {
        const dir = path.join(target, p.path);
        await fs.mkdir(dir, { recursive: true });
        for (const scaffoldFile of p.scaffold ?? []) {
          const rel = `${p.path}/${scaffoldFile}`;
          if (!vault.exists(rel)) {
            const title = scaffoldFile.replace(/\.md$/, '');
            await vault.writeFile(
              rel,
              serializeNote({
                path: rel,
                frontmatter: { type: 'system', tags: ['scaffold'], status: 'active', updated: isoDate() },
                body: `\n# ${title}\n\n`,
                rawFile: false,
              }),
            );
            created++;
          }
        }
      }
      console.log(`Brain ready at ${target} (${schema.partitions.core.length} partitions, ${created} scaffold notes, schema in ${SCHEMA_IN_BRAIN}).`);
      console.log(`Existing markdown is untouched — Obsidian vaults adopt as-is.`);
      break;
    }

    case 'recall':
    case 'find': {
      const question = positional(1).join(' ');
      if (!question) throw new Error('Usage: callosium recall "question"');
      const vault = Vault.open(brainPath());
      const texts = await loadTexts(vault);
      // match the MCP server: full stack — graph (context/graph lane) + the
      // semantic lane — or `recall` here silently runs lexical-only.
      const graph = (await loadGraph(vault)) ?? (await buildGraph(vault)).index;
      const emb = await loadEmbeddings(vault);
      // M4 relationship-honesty gate, exactly as BOTH server surfaces apply it
      // (mcp/server.ts + dashboard/server.ts): the engine leaves it to the caller,
      // so without this the CLI would answer "who is my manager" with a non-person
      // note (a partner/org) as a confident person-answer — the servers refuse it.
      const a = relationshipHonesty(question, await recall(question, texts, graph, false, emb), texts);
      if (process.argv.includes('--json')) {
        console.log(JSON.stringify(a, null, 2));
        break;
      }
      if (!a.found) {
        console.log(`NOT IN THE BRAIN — ${a.notInBrainReason}`);
        break;
      }
      for (const r of a.results) {
        console.log(`\n═ ${r.path}  [create-safety: ${r.createSafety}]`);
        console.log(`  evidence: ${r.evidence.matchedTerms.map((m) => `${m.term}(${m.where.join(',')})`).join(' ')}`);
        console.log(r.excerpt);
      }
      break;
    }

    case 'map': {
      const vault = Vault.open(brainPath());
      const texts = await loadTexts(vault);
      const { schema } = await loadSchema(vault);
      if (process.argv.includes('--write')) {
        // Write directly (not the best-effort writeMap) so a failure surfaces as a
        // non-zero exit instead of a false "Wrote"; writeMap's silent catch is for
        // the re-index caller where a map-write must never break ingest.
        await vault.writeFile(MAP_REL, generateMap(schema, texts));
        console.log(`Wrote ${MAP_REL}`);
      } else {
        console.log(generateMap(schema, texts));
      }
      break;
    }

    case 'rules': {
      const vault = Vault.open(brainPath());
      const { schema } = await loadSchema(vault);
      console.log(generateFilingRules(schema));
      break;
    }

    case 'check': {
      const vault = Vault.open(brainPath());
      const r = await brainCheck(vault);
      console.log(`callosium check — ${r.notes} notes, ${r.edges} edges, schema=${r.schemaSource}, ${r.ms}ms`);
      // A check that did not RUN must never read as a check that passed — print the omissions
      // before the findings, so "No findings. Clean brain." can't be the whole story.
      for (const s of r.skipped) console.log(`  ! ${s.check} DID NOT RUN — ${s.reason}`);
      const entries = Object.entries(r.byKind).sort((a, b) => b[1] - a[1]);
      if (!entries.length) {
        console.log(r.skipped.length ? 'No findings from the checks that ran.' : 'No findings. Clean brain.');
        break;
      }
      for (const [kind, n] of entries) console.log(`  ${String(n).padStart(5)}  ${kind}`);
      const verbose = argv.includes('--verbose');
      if (verbose) {
        for (const f of r.findings) console.log(`${f.kind}: ${f.path} — ${f.detail}`);
      } else {
        console.log('Run with --verbose for the full report.');
      }
      break;
    }

    case 'pair': {
      const [id, ...nameParts] = positional(1);
      const displayName = nameParts.join(' ');
      if (!id || !displayName) throw new Error('Usage: callosium pair <id> <display name> [--brain p]');
      const vault = Vault.open(brainPath());
      const agent = await pairAgent(vault, id, displayName);
      console.log(`Paired "${agent.displayName}" (id: ${agent.id}). Default scope: everything except Private/.`);
      console.log(`\nMCP client config (Claude Desktop / Cursor / any stdio client):\n`);
      console.log(
        JSON.stringify(
          {
            mcpServers: {
              callosium: mcpLaunch(['mcp', '--brain', vault.root, '--agent', agent.id, '--token', agent.token]),
            },
          },
          null,
          2,
        ),
      );
      break;
    }

    case 'rotate': {
      // Issue a fresh token for an already-paired agent and kill the old one.
      const [id] = positional(1);
      if (!id) throw new Error('Usage: callosium rotate <id> [--brain p]');
      const vault = Vault.open(brainPath());
      const agent = await rotateAgentToken(vault, id);
      console.log(`Rotated the token for "${agent.displayName}" (id: ${agent.id}). The old token no longer works.`);
      console.log(`\nUpdate the MCP client config with the new token:\n`);
      console.log(
        JSON.stringify(
          {
            mcpServers: {
              callosium: mcpLaunch(['mcp', '--brain', vault.root, '--agent', agent.id, '--token', agent.token]),
            },
          },
          null,
          2,
        ),
      );
      break;
    }

    case 'mcp': {
      // HTTP mode: serve the brain over a URL for clients that connect by URL +
      // token (auth is per-request, so no --agent/--token at startup).
      if (argv.includes('--http')) {
        const p = flag('port') ? Number(flag('port')) : undefined;
        if (p !== undefined && (!Number.isInteger(p) || p < 1 || p > 65535)) throw new Error('--port must be an integer between 1 and 65535');
        // With no --brain, serve the brain the dashboard last connected — NOT the
        // shell's cwd. brainPath() ends in process.cwd(), so running this one
        // directory up from the brain served a folder that isn't one, and the
        // endpoint then rejected a VALID token with "bad token": the agent registry
        // it authenticates against lives inside the real brain. Measured: same
        // token, same command, one directory up -> 401; inside the brain -> 200.
        const stated = flag('brain') || process.env.CALLOSIUM_BRAIN;
        const chosen = path.resolve(stated || loadPersistedBrain() || process.cwd());
        const st = await fs.stat(chosen).catch(() => null);
        if (!st || !st.isDirectory()) {
          throw new Error(
            `No brain at ${chosen} — pass --brain <path>, or run 'callosium serve' once so the brain is remembered.`,
          );
        }
        try {
          await serveHttp({ brainPath: chosen, port: p });
        } catch (e) {
          // The bare "EADDRINUSE" stack read as a crash. In practice it almost
          // always means the endpoint is ALREADY up: the dashboard auto-starts it
          // on :4321, so an owner who has `callosium serve` open does not need
          // this command at all.
          if ((e as NodeJS.ErrnoException)?.code === 'EADDRINUSE') {
            throw new Error(
              `Port ${p ?? 4321} is already in use — the MCP endpoint is most likely already running.\n` +
                `The dashboard starts it for you, so if 'callosium serve' is open, point your client at ` +
                `http://127.0.0.1:${p ?? 4321}/mcp and you are done.\n` +
                `To run a second, separate endpoint: callosium mcp --http --port <other port>`,
            );
          }
          throw e;
        }
        await new Promise(() => {}); // keep the HTTP server alive
        break;
      }
      const agentId = flag('agent');
      const token = flag('token');
      if (!agentId || !token) throw new Error('Usage: callosium mcp --brain <path> --agent <id> --token <token>   (or: callosium mcp --http [--port n])');
      await serve({ brainPath: brainPath(), agentId, token });
      break;
    }

    case 'remember': {
      // The human owner's own CLI writes carry no agent stamp — by design.
      const ti = argv.indexOf('--title');
      const title = ti >= 0 ? argv[ti + 1] : undefined;
      // positional() already excludes --title and its value by index; don't
      // ALSO filter by value or we silently delete real words from the memory
      // that happen to equal the title ("remember Budget rose --title Budget").
      const text = positional(1).join(' ');
      if (!text || !title) throw new Error('Usage: callosium remember "text" --title "Short topic"');
      const vault = Vault.open(brainPath());
      const { schema } = await loadSchema(vault);
      const route = routeNote(schema, { type: 'memory', title, source: 'Owner' });
      if (vault.exists(route.path)) throw new Error(`Already exists: ${route.path}`);
      await vault.writeFile(
        route.path,
        serializeNote({ path: route.path, frontmatter: { ...route.frontmatter, conversation: title }, body: `\n# ${title}\n\n${text}\n`, rawFile: false }),
      );
      console.log(`Stored: ${route.path}\n(${route.reason})`);
      break;
    }

    case '--help':
    case '-h':
      printHelp();
      break;

    default:
      // An unrecognised command used to fall in here and print the help at exit
      // 0, so a typo was indistinguishable from asking for help — to a reader
      // and to any script checking the status. Name it, then help, then fail.
      console.error(`callosium: unknown command '${cmd}'\n`);
      printHelp();
      process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
