// CLI dispatch: what `callosium` with no command actually does.
//
// This exists because the no-argument case used to print a help menu listing
// `callosium <thing>` commands — which is the worst possible answer for someone
// who arrived via `npx callosium`, since npx deliberately installs NOTHING on
// PATH and every line of that menu then answers "command not found". The
// dashboard already handles a machine with no brain by falling through to
// onboarding, so no arguments must OPEN it, not describe it.
//
// Deliberately does NOT spawn the server: binding a port is slow, needs a free
// port, and is covered by smoke-dashboard.mjs. What is fragile here is the
// ROUTING, and routing is observable from the non-serving cases alone.
import { spawnSync } from 'node:child_process';

const CLI = 'dist/cli.js';
let failed = 0;
const ok = (label, cond, detail = '') => {
  console.log(`  ${cond ? '✓' : '✗'} ${label}${cond || !detail ? '' : ` — ${detail}`}`);
  if (!cond) failed++;
};
const run = (args, env = {}) =>
  spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });

console.log('\ncli dispatch\n');

const v = run(['--version']);
ok('--version exits 0 and prints a version', v.status === 0 && /callosium \d+\.\d+\.\d+/.test(v.stdout), v.stdout.trim());

const h = run(['--help']);
ok('--help exits 0', h.status === 0, `status ${h.status}`);
ok('--help points at the no-argument route', /no arguments/i.test(h.stdout));
ok('--help still lists the real commands', /serve \[--brain/.test(h.stdout) && /recall "question"/.test(h.stdout));

// The help must name the invocation the reader can actually type. Under npx the
// bare `callosium` form does not exist on their PATH.
const npxish = run(['--help'], { npm_command: 'exec' });
ok('help says "npx callosium" when run via npx', /npx callosium serve/.test(npxish.stdout));
ok('help says plain "callosium" otherwise', !/npx callosium/.test(h.stdout) && /callosium serve \[--brain/.test(h.stdout));

// A typo used to be indistinguishable from asking for help: same output, exit 0.
const bad = run(['srve']);
ok('unknown command exits non-zero', bad.status === 1, `status ${bad.status}`);
ok('unknown command names itself on stderr', /unknown command 'srve'/.test(bad.stderr));
ok('unknown command still shows the help', /serve \[--brain/.test(bad.stdout));

// A flags-only run has NO command word. argv[0] is '--port', which must NOT be
// reported as an unknown command — it means "open the dashboard, thus configured".
// Caught in review: the first version of this fix rejected `callosium --port 4400`.
const flagsOnly = run(['--port', 'not-a-number']);
ok(
  'flags-only run is treated as serve, not an unknown command',
  !/unknown command/.test(flagsOnly.stderr),
  flagsOnly.stderr.trim().split('\n')[0] || '(no stderr)',
);
ok(
  'flags-only run reaches serve\'s own validation',
  /--port must be an integer/.test(flagsOnly.stderr),
  flagsOnly.stderr.trim().split('\n')[0] || '(no stderr)',
);

console.log(`\n  ${failed === 0 ? 'ALL PASS' : `${failed} FAILED`}\n`);
process.exit(failed === 0 ? 0 : 1);
