#!/usr/bin/env node
// Builds a standalone portable bundle of Callosium: an official Node runtime
// + the built app + production node_modules + a launcher, zipped so a consumer
// WITHOUT Node installed can unzip and run `callosium.cmd` (or ./callosium).
//
//   node scripts/build-portable.mjs [--node-version 24.16.0] [--platform win-x64]
//                                   [--workdir <dir>] [--out <archivePath>]
//                                   [--skip-app-build]
//
// Platforms: win-x64, win-arm64, darwin-arm64, darwin-x64, linux-x64, linux-arm64.
// Windows targets ship as .zip; unix targets as .tar.gz (exec bits survive).
// Cross-target STAGING is not supported: `npm ci` installs the HOST's native
// binaries (sharp), so build each target on a matching host (CI matrix).
//
// What lands in the archive (callosium-<platform>-portable/):
//   runtime/            node.exe (win) or bin/node (unix) + Node's LICENSE
//   app/                dist/ schema/ docs/ + production node_modules
//   callosium.cmd|callosium   launcher that runs the BUNDLED node
//   README.txt
//
// Design notes:
// - The Node runtime is downloaded fresh from nodejs.org and verified against
//   SHASUMS256.txt — the machine's global node is never reused.
// - onnxruntime-node ships binaries for every OS/arch (~211MB); everything but
//   the target platform is pruned (win-x64 keeps ~60MB).
// - The semantic model (~120MB) is NOT bundled. First recall/ingest downloads
//   it into %LOCALAPPDATA%\Callosium\models (unix: ~/.callosium/models) — the
//   launcher sets CALLOSIUM_MODEL_DIR so the cache is short-pathed, writable,
//   and survives bundle updates. Until it arrives, the engine degrades to
//   lexical-only recall (ModelUnavailableError is retryable by design).

import { promises as fs, createWriteStream } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------- args ----------
const argv = process.argv.slice(2);
function arg(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
}
const NODE_VERSION = arg('node-version', '24.16.0');
const PLATFORM = arg('platform', 'win-x64'); // nodejs.org naming
const SKIP_APP_BUILD = argv.includes('--skip-app-build');
const WORKDIR = path.resolve(arg('workdir', path.join(os.tmpdir(), 'callosium-portable')));

const PLATFORMS = {
  'win-x64': { nodeOs: 'win32', nodeArch: 'x64', archiveExt: '.zip', nodeDistExt: '.zip' },
  'win-arm64': { nodeOs: 'win32', nodeArch: 'arm64', archiveExt: '.zip', nodeDistExt: '.zip' },
  'darwin-arm64': { nodeOs: 'darwin', nodeArch: 'arm64', archiveExt: '.tar.gz', nodeDistExt: '.tar.gz' },
  'darwin-x64': { nodeOs: 'darwin', nodeArch: 'x64', archiveExt: '.tar.gz', nodeDistExt: '.tar.gz' },
  'linux-x64': { nodeOs: 'linux', nodeArch: 'x64', archiveExt: '.tar.gz', nodeDistExt: '.tar.gz' },
  'linux-arm64': { nodeOs: 'linux', nodeArch: 'arm64', archiveExt: '.tar.gz', nodeDistExt: '.tar.gz' },
};
const plat = PLATFORMS[PLATFORM];
if (!plat) throw new Error(`Unknown --platform "${PLATFORM}". One of: ${Object.keys(PLATFORMS).join(', ')}`);
const isWinTarget = plat.nodeOs === 'win32';
const hostMatches = process.platform === plat.nodeOs;
if (!hostMatches) {
  throw new Error(
    `Cross-target staging is not supported: npm ci installs the HOST's native binaries. ` +
      `Build ${PLATFORM} on a ${plat.nodeOs} host (CI matrix).`,
  );
}

const bundleName = `callosium-${PLATFORM}-portable`;
const OUT = path.resolve(arg('out', path.join(WORKDIR, 'out', `${bundleName}${plat.archiveExt}`)));

// ---------- helpers ----------
function log(msg) {
  console.log(`[build-portable] ${msg}`);
}

function run(cmd, args, opts = {}) {
  // On Windows, npm is npm.cmd and needs a shell; quote args defensively.
  const useShell = process.platform === 'win32' && /npm/.test(cmd);
  const printable = `${cmd} ${args.join(' ')}`;
  log(`$ ${printable}${opts.cwd ? `  (cwd: ${opts.cwd})` : ''}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: useShell, ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`Command failed (${r.status}): ${printable}`);
}

/** Windows System32 tar.exe is bsdtar (reads AND writes .zip). Git Bash's GNU
 *  tar can't write zip, so resolve the absolute path instead of trusting PATH. */
function tarBin() {
  if (process.platform === 'win32') {
    return path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  }
  return 'tar';
}

async function download(url, dest, { noCache = false } = {}) {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  if (noCache) await rmrf(dest);
  try {
    const st = await fs.stat(dest);
    if (st.size > 0) {
      log(`cached: ${path.basename(dest)} (${(st.size / 1e6).toFixed(1)} MB)`);
      return;
    }
  } catch {
    /* not cached */
  }
  log(`downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  // Write to a temp name and rename: an interrupted download must never
  // satisfy the size>0 cache check on the next run (16 Jul review).
  const tmp = dest + '.part';
  await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
  await fs.rename(tmp, dest);
}

async function sha256(file) {
  const hash = createHash('sha256');
  hash.update(await fs.readFile(file));
  return hash.digest('hex');
}

async function rmrf(p) {
  await fs.rm(p, { recursive: true, force: true });
}

// ---------- 1. build the app ----------
if (!SKIP_APP_BUILD) {
  run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], { cwd: repoRoot });
} else {
  log('skipping app build (--skip-app-build)');
}

// ---------- 2. fetch + verify the official Node runtime ----------
const nodeDirName = `node-v${NODE_VERSION}-${PLATFORM}`;
const nodeArchiveName = `${nodeDirName}${plat.nodeDistExt}`;
const downloads = path.join(WORKDIR, 'downloads');
const nodeArchive = path.join(downloads, nodeArchiveName);
const shasumsFile = path.join(downloads, `SHASUMS256-v${NODE_VERSION}.txt`);

await download(`https://nodejs.org/dist/v${NODE_VERSION}/${nodeArchiveName}`, nodeArchive);
// The checksum manifest is tiny and is the trust anchor — never trust a cache.
await download(`https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt`, shasumsFile, { noCache: true });

const shasums = await fs.readFile(shasumsFile, 'utf8');
const expected = shasums
  .split('\n')
  .map((l) => l.trim().split(/\s+/))
  .find(([, name]) => name === nodeArchiveName)?.[0];
if (!expected) throw new Error(`${nodeArchiveName} not listed in SHASUMS256.txt for v${NODE_VERSION}`);
const actual = await sha256(nodeArchive);
if (actual !== expected) {
  await rmrf(nodeArchive);
  throw new Error(`SHA256 mismatch for ${nodeArchiveName}: expected ${expected}, got ${actual}. Cached file deleted — rerun.`);
}
log(`runtime verified: ${nodeArchiveName} sha256 OK`);

const nodeExtract = path.join(WORKDIR, 'node-extract');
await rmrf(nodeExtract);
await fs.mkdir(nodeExtract, { recursive: true });
run(tarBin(), ['-xf', nodeArchive, '-C', nodeExtract]);
const nodeRoot = path.join(nodeExtract, nodeDirName);

// ---------- 3. stage the app + production node_modules ----------
const stage = path.join(WORKDIR, 'stage', 'app');
await rmrf(stage);
await fs.mkdir(stage, { recursive: true });

// Mirror package.json "files" + the lockfile (required by npm ci).
const APP_FILES = ['package.json', 'package-lock.json', 'dist', 'schema', 'docs', 'index.js', 'README.md', 'LICENSE'];
for (const f of APP_FILES) {
  await fs.cp(path.join(repoRoot, f), path.join(stage, f), { recursive: true });
}
// --ignore-scripts: the natives we need (onnxruntime-node, sharp) ship their
// binaries IN the tarballs — verified working under the bundled runtime. The
// postinstall scripts only fetch EXTRAS, and on linux onnxruntime's would pull
// multi-GB CUDA/TensorRT provider blobs into the bundle (16 Jul review).
run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts'], { cwd: stage });

// Prune onnxruntime-node's other-platform binaries (~211MB all-platform).
const ortBin = path.join(stage, 'node_modules', 'onnxruntime-node', 'bin', 'napi-v6');
let pruned = 0;
try {
  for (const osDir of await fs.readdir(ortBin)) {
    if (osDir !== plat.nodeOs) {
      await rmrf(path.join(ortBin, osDir));
      pruned++;
      continue;
    }
    for (const archDir of await fs.readdir(path.join(ortBin, osDir))) {
      if (archDir !== plat.nodeArch) {
        await rmrf(path.join(ortBin, osDir, archDir));
        pruned++;
      }
    }
  }
  log(`pruned ${pruned} non-${PLATFORM} onnxruntime binary dirs`);
  // Belt-and-braces: if GPU provider blobs slipped in anyway (postinstall ran
  // under a different npm policy), strip them — CPU inference needs none of
  // CUDA/TensorRT/DML-extras, and the CUDA pair alone is multi-GB on linux.
  const keptDir = path.join(ortBin, plat.nodeOs, plat.nodeArch);
  for (const f of await fs.readdir(keptDir).catch(() => [])) {
    if (/cuda|tensorrt/i.test(f)) {
      await rmrf(path.join(keptDir, f));
      log(`stripped GPU provider blob: ${f}`);
    }
  }
} catch (e) {
  log(`WARNING: onnxruntime prune skipped (${e.message}) — bundle will be larger but still correct`);
}

// The binding MUST exist for the target — a bundle without it ships with
// semantic recall permanently dead (the darwin-x64 trap: newer onnxruntime
// releases dropped Intel-mac prebuilds). Fail the build loudly instead.
// Deliberately OUTSIDE the prune try/catch: this is a correctness gate, not
// a size optimization.
{
  const keptDir = path.join(ortBin, plat.nodeOs, plat.nodeArch);
  const bindingFiles = await fs.readdir(keptDir).catch(() => []);
  if (!bindingFiles.some((f) => f.endsWith('.node'))) {
    throw new Error(
      `onnxruntime has NO native binding for ${plat.nodeOs}/${plat.nodeArch} — ` +
      `this bundle would ship with semantic search dead. Pin an onnxruntime-node ` +
      `version that publishes ${PLATFORM} prebuilds, or drop this target.`,
    );
  }
}

// ---------- 4. assemble the bundle ----------
const bundleParent = path.join(WORKDIR, 'bundle');
const bundle = path.join(bundleParent, bundleName);
await rmrf(bundle);
await fs.mkdir(path.join(bundle, 'runtime'), { recursive: true });

if (isWinTarget) {
  await fs.copyFile(path.join(nodeRoot, 'node.exe'), path.join(bundle, 'runtime', 'node.exe'));
} else {
  await fs.mkdir(path.join(bundle, 'runtime', 'bin'), { recursive: true });
  await fs.copyFile(path.join(nodeRoot, 'bin', 'node'), path.join(bundle, 'runtime', 'bin', 'node'));
  await fs.chmod(path.join(bundle, 'runtime', 'bin', 'node'), 0o755);
}
await fs.copyFile(path.join(nodeRoot, 'LICENSE'), path.join(bundle, 'runtime', 'LICENSE'));
await fs.cp(stage, path.join(bundle, 'app'), { recursive: true });

if (isWinTarget) {
  // CRLF on purpose — cmd.exe misparses bare-LF batch files in edge cases.
  const cmdLauncher =
    [
      '@echo off',
      'rem Callosium portable launcher — runs the BUNDLED Node runtime.',
      'setlocal',
      'rem Keep the semantic model cache at a SHORT, writable, install-independent',
      'rem path. Inside the bundle it can exceed Windows MAX_PATH (onnxruntime\'s',
      'rem native file-open fails on >260-char paths) or land on a read-only dir.',
      'if not defined CALLOSIUM_MODEL_DIR set "CALLOSIUM_MODEL_DIR=%LOCALAPPDATA%\\Callosium\\models"',
      '"%~dp0runtime\\node.exe" "%~dp0app\\dist\\cli.js" %*',
      'endlocal',
    ].join('\r\n') + '\r\n';
  await fs.writeFile(path.join(bundle, 'callosium.cmd'), cmdLauncher);
} else {
  const shLauncher =
    [
      '#!/bin/sh',
      '# Callosium portable launcher — runs the BUNDLED Node runtime.',
      'DIR="$(cd "$(dirname "$0")" && pwd)"',
      '# Model cache outside the bundle: short path, writable, survives updates.',
      ': "${CALLOSIUM_MODEL_DIR:=${XDG_CACHE_HOME:-$HOME/.cache}/callosium/models}"',
      'export CALLOSIUM_MODEL_DIR',
      'exec "$DIR/runtime/bin/node" "$DIR/app/dist/cli.js" "$@"',
    ].join('\n') + '\n';
  await fs.writeFile(path.join(bundle, 'callosium'), shLauncher);
  await fs.chmod(path.join(bundle, 'callosium'), 0o755);
}

const launcher = isWinTarget ? 'callosium.cmd' : './callosium';
await fs.writeFile(
  path.join(bundle, 'README.txt'),
  [
    'Callosium portable — one brain, every AI, your files.',
    '',
    'No install needed. Unzip this folder anywhere you can write to',
    '(Documents, Desktop, a USB stick) and run:',
    '',
    `  ${launcher} init MyBrain          create your brain`,
    `  ${launcher} serve --brain MyBrain open the dashboard`,
    `  ${launcher} recall "question" --brain MyBrain`,
    '',
    'Everything runs on your machine. The first search may download a small',
    'language model (~120MB, one time) to enable meaning-based search;',
    'keyword search works fully even without it.',
    '',
    `Bundled runtime: Node.js v${NODE_VERSION} (license in runtime/LICENSE).`,
    'Callosium license: app/LICENSE (Apache-2.0).',
  ].join('\r\n') + '\r\n',
);

// ---------- 5. archive ----------
await fs.mkdir(path.dirname(OUT), { recursive: true });
await rmrf(OUT);
if (plat.archiveExt === '.zip') {
  // bsdtar auto-detects zip from the extension with -a (Windows/macOS; on
  // Linux install libarchive-tools or swap for `zip -r`).
  run(tarBin(), ['-a', '-cf', OUT, '-C', bundleParent, bundleName]);
} else {
  run(tarBin(), ['-czf', OUT, '-C', bundleParent, bundleName]);
}
const st = await fs.stat(OUT);
log(`DONE: ${OUT} (${(st.size / 1e6).toFixed(1)} MB)`);
log(`unzipped bundle for local testing: ${bundle}`);
