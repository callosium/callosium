#!/usr/bin/env node
// Build the Callosium desktop app (Tauri).
//   node build-desktop.mjs [--platform win-x64]
// Steps:
//   1. build the app (dist)
//   2. generate app icons from the brand logomark (once)
//   3. stage the Node server payload (runtime + app + prod node_modules) into
//      src-tauri/payload — reuses scripts/build-portable.mjs so the bundled
//      server is byte-identical to the portable CLI bundle
//   4. `tauri build` → the Windows NSIS installer under
//      src-tauri/target/release/bundle/nsis/
import { promises as fs } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url)); // .../callosium/desktop
const repo = path.resolve(here, '..'); // .../callosium
const srcTauri = path.join(here, 'src-tauri');
const payloadDir = path.join(srcTauri, 'payload');
const iconSrc = path.join(srcTauri, 'icon-source.png'); // self-contained in-repo (RGBA)

const argv = process.argv.slice(2);
const platform = argv.includes('--platform') ? argv[argv.indexOf('--platform') + 1] : 'win-x64';

function run(cmd, args, opts = {}) {
  // npm/npx are .cmd shims on Windows and need a shell; a shell then requires we
  // quote any arg containing spaces (the repo path may contain spaces).
  // Real executables (node) run WITHOUT a shell, so their space-containing args
  // pass through untouched — routing `node <script-with-spaces>` through a shell
  // is what split the path and broke the first build.
  const base = path.basename(cmd).toLowerCase();
  const isCmd = process.platform === 'win32' && /^(npm|npx|tauri)(\.cmd)?$/.test(base);
  const finalArgs = isCmd ? args.map((a) => (/\s/.test(a) ? `"${a}"` : a)) : args;
  console.log(`\n$ ${base} ${args.join(' ')}${opts.cwd ? `  (cwd: ${path.relative(repo, opts.cwd) || '.'})` : ''}`);
  const r = spawnSync(cmd, finalArgs, { stdio: 'inherit', shell: isCmd, ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`command failed: ${cmd} ${args.join(' ')}`);
}
const exists = (p) => fs.stat(p).then(() => true).catch(() => false);

// 1) build the app
run('npm', ['run', 'build'], { cwd: repo });

// 2) icons (once) — Tauri generates the full set (ico/png/icns) from one PNG
if (!(await exists(path.join(srcTauri, 'icons', 'icon.ico')))) {
  run('npx', ['tauri', 'icon', iconSrc], { cwd: here });
}

// 3) stage the portable payload (runtime + app), reusing build-portable
const workdir = path.join(os.tmpdir(), 'callosium-desktop-payload');
run(process.execPath, [path.join(repo, 'scripts', 'build-portable.mjs'), '--platform', platform, '--skip-app-build', '--workdir', workdir], { cwd: repo });
const bundle = path.join(workdir, 'bundle', `callosium-${platform}-portable`);
await fs.rm(payloadDir, { recursive: true, force: true });
await fs.mkdir(payloadDir, { recursive: true });
await fs.cp(path.join(bundle, 'runtime'), path.join(payloadDir, 'runtime'), { recursive: true });
await fs.cp(path.join(bundle, 'app'), path.join(payloadDir, 'app'), { recursive: true });
console.log(`payload staged → ${path.relative(repo, payloadDir)}`);

// 4) build the installer (skipped with --stage-only, e.g. in CI where tauri-action
//    runs the signed build after this staging step)
if (!argv.includes('--stage-only')) {
  run('npx', ['tauri', 'build'], { cwd: here });
  console.log('\nDONE — installer under desktop/src-tauri/target/release/bundle/nsis/');
} else {
  console.log('\nDONE — payload staged; tauri build deferred to tauri-action.');
}
