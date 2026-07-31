// Regression test for the un-spawnable MCP command (BL-1).
//
// The config the dashboard hands a user to paste into their AI client must be
// something the MCP SDK can actually spawn. The SDK spawns with shell:false, and
// measured on Windows with callosium globally installed and ON PATH:
//   spawn('callosium')      -> ENOENT
//   spawn('callosium.cmd')  -> EINVAL
// So a bare `callosium` command is broken for every npm install method there.
// The earlier guard (`process.argv[1].endsWith('cli.js')`) was worse than useless:
// it is FALSE on macOS/Linux, because npm symlinks the bin and Node does not
// realpath argv[1] — so it silently no-opped on the platforms it existed to save.
//
// This is a UNIT test on mcpClientConfig rather than a live POST to /api/pair on
// purpose: /api/pair needs a connected brain, and standing up one would either
// pair a throwaway agent into the developer's REAL brain or require
// `serve --brain`, which persists and repoints their default brain. Neither is
// acceptable as a side effect of running the test suite. It runs on all three
// OSes in the existing CI matrix, which is what the check is for.
//   node test/unit-pairconfig.mjs
import { mcpClientConfig } from '../src/dashboard/server.ts';
import path from 'node:path';

let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + ' ' + extra); } };

const cfg = mcpClientConfig(path.join('C:', 'tmp', 'brain'), 'claude', 'tok_abc123');
const entry = cfg?.mcpServers?.callosium;

ok('emits an mcpServers.callosium entry', !!entry, JSON.stringify(cfg));

// THE invariant. Everything else here is supporting detail.
ok('command is NOT the bare "callosium"', entry.command !== 'callosium', `got ${JSON.stringify(entry.command)}`);

ok('command is the running interpreter (absolute, spawnable with shell:false)',
  entry.command === process.execPath,
  `got ${JSON.stringify(entry.command)} want ${JSON.stringify(process.execPath)}`);

ok('first arg is an ABSOLUTE path to cli.js',
  typeof entry.args?.[0] === 'string' && path.isAbsolute(entry.args[0]) && /cli\.js$/.test(entry.args[0]),
  `got ${JSON.stringify(entry.args?.[0])}`);

// The brain/agent/token still have to survive into the args, or the config is
// spawnable but useless.
ok('args carry mcp + --brain + --agent + --token',
  ['mcp', '--brain', '--agent', '--token'].every((f) => entry.args.includes(f)),
  JSON.stringify(entry.args));
ok('args carry the agent id and token verbatim',
  entry.args.includes('claude') && entry.args.includes('tok_abc123'),
  JSON.stringify(entry.args));

// No platform branch: the same shape must come out on Windows, macOS and Linux.
// If someone reintroduces an `if (process.platform === ...)` this stays green only
// on whichever platform the author tested, and CI's other two legs go red.
ok('no .cmd / .exe shim in the command',
  !/\.(cmd|bat|ps1)$/i.test(entry.command),
  `got ${JSON.stringify(entry.command)}`);

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
console.log('  ALL PASS');
