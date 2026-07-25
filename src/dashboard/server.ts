// Callosium dashboard — a local web cockpit served by `callosium serve`.
// This is the same UI the desktop shell (Tauri) will open; the shell just
// launches this server and points a window at it, then swaps the web folder
// picker for a native dialog. Everything here runs on localhost, on the user's
// own machine — no cloud, no telemetry, no auth beyond loopback binding.

import http from 'node:http';
import { promises as fs } from 'node:fs';
import { existsSync, readFileSync, createReadStream, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { gzip as zlibGzip, deflate as zlibDeflate } from 'node:zlib';
import { promisify } from 'node:util';

import { Vault } from '../core/vault.ts';
import { loadSchema } from '../core/schema.ts';
import { writeMap } from '../structure/map.ts';
import { loadTexts, recall, relationshipHonesty, type VaultTexts } from '../recall/engine.ts';
import { buildGraph, loadGraph, type BuildResult } from '../graph/index.ts';
import { buildEmbeddings, loadEmbeddings, onModelProgress, onEmbeddingCacheError, warmModel, ModelUnavailableError, type EmbeddingIndex } from '../recall/semantic.ts';
import { brainCheck } from '../check/check.ts';
import { captureExternal, ensureHistory, listVersions, readVersion, lineDiff, snapshotNote } from '../history/store.ts';
import { readActions, logAction } from '../audit/log.ts';
import { buildLinkerIndex, suggestLinks, applyLinks } from '../linking/suggest.ts';
import { aliasesOf } from '../core/aliases.ts';
import { pairAgent, loadAgents, updateAgents, rotateAgentToken, renameAgent } from './../mcp/agents.ts';
import { serveHttp, mcpCacheSource, type BrainSource, type ServerHandle } from './../mcp/server.ts';
import { liveBanner } from '../util/term.ts';
import type { GraphIndex } from '../core/types.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI_HTML = path.join(HERE, 'ui.html');
const ASSETS_DIR = path.join(HERE, 'assets');
// App-level config lives OUTSIDE any brain (the account precedes brain choice).
const APP_DIR = path.join(os.homedir(), '.callosium');
const ACCOUNT_FILE = path.join(APP_DIR, 'account.json');
// Which brain we're serving, remembered ACROSS restarts. Without this the server
// only knew its brain from --brain, so any restart that lacked the flag (a crash,
// a reboot, an update, or a brain chosen during onboarding) forgot the
// connection and every screen showed "couldn't reach your brain".
const CONFIG_FILE = path.join(APP_DIR, 'config.json');
// Read our own version once (for the update check).
let APP_VERSION = '0.1.0';
try {
  APP_VERSION = JSON.parse(readFileSync(path.join(HERE, '..', '..', 'package.json'), 'utf8')).version || '0.1.0';
} catch {
  /* keep default */
}

// ── in-memory session state (one brain per running server) ──
let brainPath: string | null = null;
// Did the auto-started MCP endpoint actually bind? Module-level because handleState reports it and
// serveDashboard sets it. The connect guide shows a URL + token for this endpoint, so when it never
// came up the UI has to say so rather than hand out config for a port nothing is listening on.
let mcpStatus: { live: boolean; error?: string } = { live: false, error: 'not started' };

// Persist the connected brain (best-effort, atomic temp+rename) so a restart
// reconnects automatically. A persistence failure must NEVER break serving.
function persistBrain(p: string | null): void {
  try {
    mkdirSync(APP_DIR, { recursive: true });
    const tmp = CONFIG_FILE + '.tmp-' + randomUUID();
    writeFileSync(tmp, JSON.stringify({ brainPath: p }, null, 2), 'utf8');
    renameSync(tmp, CONFIG_FILE);
  } catch {
    /* best-effort */
  }
}
function loadPersistedBrain(): string | null {
  try {
    const c = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as { brainPath?: unknown };
    return typeof c.brainPath === 'string' && c.brainPath ? c.brainPath : null;
  } catch {
    return null;
  }
}
// Monotonic brain-switch counter (P2 #1). Bumped on every setBrain so an
// in-flight loadAll() started under the OLD brain can detect the switch and
// refuse to write its (now wrong-brain) result into the shared cache. Every
// cached-brain field carries the generation it belongs to.
let brainGeneration = 0;
// Single choke point for connecting a brain: set the in-memory path AND remember
// it for next launch. Resets ALL brain-scoped cache state ATOMICALLY (same tick,
// before any await) and bumps the generation, so a concurrent request can never
// see the new brainPath paired with the old brain's cache.
function setBrain(p: string): void {
  brainPath = p;
  brainGeneration++;
  // Drop every derived cache synchronously — a separate dropCache() at the call
  // site left a window where loadAll served the old brain under the new path.
  cache = null;
  reportCache = null;
  loadInFlight = null; // an in-flight load belongs to the OLD brain — never joinable
  cacheEpoch++; // and it must never publish into the new brain's cache either
  cacheBuiltToken = '';
  cacheGen = -1;
  graphLoadedOnce = false; // the NEW brain should trust ITS persisted graph on first load
  graphBodyCache = null; // the serialized map body belongs to the OLD brain's nodes
  lastRevalidate = 0;
  lastExternalEdits = [];
  persistBrain(p);
  // Use the RESOLVED root for both the work-tree and the brainId, so this matches the id every
  // snapshot/capture site derives from vault.root (an un-resolved path would key a different repo).
  const histRoot = Vault.open(p).root;
  void ensureHistory(histRoot, Vault.contentHash(histRoot.toLowerCase())).catch(() => {}); // version-history baseline
  // Switching brains: a cache error surfaced for the OLD brain must not stick to
  // the new one (a fresh, never-indexed brain would else show a false "semantic
  // corrupt — re-index" banner). Cleared here; re-set only if the NEW brain's
  // load actually surfaces one.
  lastSemanticError = null;
}

// Folders the user has actually navigated to via the picker this session.
// /api/ingest will only accept a target from this set (or the current brain),
// so even a request that slips past the origin guard can't repoint the brain
// at an arbitrary attacker-chosen directory (e.g. C:\Windows) and spin the
// server scanning it.
const browsedPaths = new Set<string>();

// Clamp a client-supplied numeric query param to a sane [min,max] with a default
// (P3 O01): a NEGATIVE limit misbehaves in slice(0,limit) and an unbounded huge
// one invites needless work. An ABSENT (null) or EMPTY param → default, NOT min:
// Number(null) and Number('') are both 0, which would otherwise clamp to `min`
// (so a bare /api/activity would return 1 item, not the default 12).
function clampInt(raw: string | null, def: number, max: number, min = 1): number {
  if (raw === null || raw === '') return def;
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : def;
}

// Loaded-brain cache (texts + graph + embeddings), shared by the read screens
// so we don't re-scan the vault on every panel. Invalidated on reindex / pair /
// scope change. The owner runs this locally, so there's no per-agent scoping
// here — the dashboard IS the owner's cockpit.
// `build` is the graph BuildResult when this load went through buildGraph
// (every rebuild, and a first load with no persisted graph). It is handed to
// the health check so it never runs its own buildGraph pass.
// `token` is the vault freshness token THIS snapshot was read at. Anything that
// caches a body DERIVED from a load (the map's ETag + serialized body) must key on
// it rather than on the global cacheBuiltToken: loadAll can hand back a snapshot it
// deliberately did NOT publish (a brain switch or a write landed mid-load), and
// cacheBuiltToken then describes a different snapshot entirely.
interface Loaded { texts: VaultTexts; graph: GraphIndex; emb: EmbeddingIndex | null; build: BuildResult | null; token: string; }
let cache: Loaded | null = null;
// Last embedding-cache load error (corrupt/torn/oversized cache), surfaced to the
// overview payload so the owner SEES "semantic off — re-index" instead of it
// silently degrading forever. Set by the semantic module's callback; cleared the
// moment a load succeeds. This is the real subscriber the sidecar's error path
// needs (console.error alone is invisible in the app UI).
let lastSemanticError: string | null = null;
onEmbeddingCacheError((msg) => { lastSemanticError = msg; });
let cacheBuiltToken = ''; // vault freshness token when `cache` was built
let cacheGen = -1; // brainGeneration `cache` belongs to (P2 #1 — guards against a mid-load brain switch)
// Bumped by every INVALIDATION (dropCache/setBrain). brainGeneration only moves on a brain
// SWITCH, so it cannot catch a write that lands mid-load; this can. See the publish guard
// at the end of loadOnce.
let cacheEpoch = 0;
let lastRevalidate = 0; // last time we scanned the tree (throttle the disk walk)
let graphLoadedOnce = false; // after the first load, rebuilds go through buildGraph to self-heal
// The single in-flight load, so concurrent callers share ONE rather than each
// starting their own. This is a peak-RAM bound, not just a speed win: the HTTP
// MCP endpoint runs inside this process and now reads through this cache, so a
// burst of agent tool calls against a cold cache would otherwise start N full
// loads in parallel — N copies of the note bodies and N Float32 vector matrices
// alive at once, which is exactly the duplication sharing the cache removes.
// Pinned to brainGeneration so a load started for the PREVIOUS brain is never
// handed to a caller running under the new one.
// Pinned to cacheEpoch too, so a load started BEFORE the last invalidation is not
// joinable by a caller that asks after it.
let loadInFlight: { gen: number; epoch: number; p: Promise<Loaded> } | null = null;
function loadAll(): Promise<Loaded> {
  const gen = brainGeneration;
  const epoch = cacheEpoch;
  // Pin the brain HERE, synchronously, and hand it to the load. It used to read
  // brainPath itself, which was equivalent only while the load always started in
  // the same tick; now that a superseded load can be queued (below), reading it
  // later would open whatever brain is connected by then and answer a request that
  // began on the previous one — the leak the generation guard exists to prevent.
  const brain = brainPath!;
  if (loadInFlight && loadInFlight.gen === gen && loadInFlight.epoch === epoch) return loadInFlight.p;
  // A pre-invalidation load isn't joinable, but it is still RUNNING and still holds
  // a whole brain (note bodies + graph + the Float32 vector matrix). Starting ours
  // alongside it is exactly the parallel duplication this single flight exists to
  // cap: an agent's write→read→write loop invalidates on every write, so N loads,
  // N copies, would pile up. Queue behind it instead of racing it — same freshness
  // guarantee (we still start our own, post-write load), one brain resident at a
  // time. dropCache used to null the slot outright, which removed the bound.
  const prev = loadInFlight;
  const start = () => loadOnce(gen, epoch, brain);
  const p = prev ? prev.p.then(start, start) : start();
  loadInFlight = { gen, epoch, p };
  // Release the slot once it settles — resolved OR rejected — so a failed load
  // (brain folder gone, a transient cloud-sync read error) is retried on the next
  // call instead of being pinned as a permanent rejection. Guarded on identity so
  // a dropCache/setBrain that already replaced the slot isn't clobbered.
  const release = () => { if (loadInFlight?.p === p) loadInFlight = null; };
  p.then(release, release);
  return p;
}
async function loadOnce(gen: number, epoch: number, brain: string): Promise<Loaded> {
  // The brain + generation are pinned for the WHOLE load (both come from the
  // caller, in the same synchronous step it read brainGeneration). If the owner
  // switches brains while the (slow) load below is in flight, we must NOT store
  // this old-brain result under the new brain's cache — the generation check at
  // commit time catches that (P2 #1).
  const vault = Vault.open(brain);
  // Serve the cache, but revalidate against disk at most every 2s: an MCP agent
  // (a separate process) can edit notes without ever calling dropCache(), so a
  // pure in-memory cache would serve — and let saves overwrite — stale content.
  // freshnessToken (not just newestMtime) so a DELETE or RENAME — which leaves the
  // newest mtime untouched — still invalidates the cache and its dangling entries.
  // Only trust the cache if it belongs to the CURRENT brain generation.
  if (cache && cacheGen === gen) {
    const now = Date.now();
    if (now - lastRevalidate < 2000) return cache;
    lastRevalidate = now;
    const fresh = (await vault.freshnessToken()) === cacheBuiltToken;
    // Re-read `cache` AFTER the await before handing it back. A concurrent
    // dropCache() — an MCP write, a pair/scope change, a re-index — can null it
    // while the token scan is in flight, and none of those need move the freshness
    // token, so `fresh` can still be true over a cache that is now null. TypeScript's
    // narrowing from the `if (cache && …)` above does NOT survive an await, so this
    // returned null typed as Loaded and every caller's `const { texts } = await
    // loadAll()` threw "Cannot destructure property 'texts' of null" — a 500 on
    // whichever screen happened to be polling when the write landed.
    if (fresh && cache && cacheGen === gen) return cache;
    // Only invalidate if the cache STILL belongs to my generation. During the
    // freshnessToken await above a setBrain(B) + a fresh loadAll(B) could have
    // committed brain B's cache under a new generation; nulling it here (my token
    // is brain A's, so it never matches B's) would throw away a valid, freshly-
    // built cache and force a redundant reload (P2 review, finding 4).
    if (cacheGen === gen) { cache = null; reportCache = null; } // disk moved on → rebuild everything derived
  }
  // Snapshot the freshness token BEFORE reading content, not after. If an external
  // writer lands a change DURING the (slow) load below, capturing the token after
  // the load would record the post-write fingerprint against pre-write content —
  // pinning the stale cache until some unrelated change moved the token again. Taking
  // it first means such a mid-load write leaves builtToken at the pre-write value, so
  // the next revalidation sees a newer token and reloads (over-invalidate = safe).
  const builtToken = await vault.freshnessToken();
  const texts = await loadTexts(vault);
  // First build trusts the persisted graph (fast); a REBUILD (the vault moved on
  // disk since we cached) goes through buildGraph so its stillValid pass prunes
  // edges to notes that were deleted or renamed — otherwise the map, related, and
  // health would keep drawing links to notes that are gone. Either way the texts
  // we just read are handed INTO the build: loadTexts + buildGraph + brainCheck
  // used to re-read every note 3-4 times per rebuild (~7s on a 1.1k-note brain);
  // now the vault is read once and shared.
  let build: BuildResult | null = null;
  const graph = graphLoadedOnce
    ? (build = await buildGraph(vault, texts)).index
    : ((await loadGraph(vault)) ?? (build = await buildGraph(vault, texts)).index);
  graphLoadedOnce = true;
  const emb = await loadEmbeddings(vault);
  const loaded: Loaded = { texts, graph, emb, build, token: builtToken };
  // If the owner switched brains WHILE this load was in flight, `loaded` is the
  // OLD brain's data. Hand it back to our caller (whose request began under the
  // old brain) but do NOT poison the shared cache under the new generation — the
  // new brain's own load populates that (P2 #1).
  if (gen !== brainGeneration) return loaded;
  // Same argument, for WRITES rather than brain switches. dropCache() — an MCP write via
  // invalidate(), a cockpit save, a re-index — nulls the cache but does NOT bump
  // brainGeneration, so a load that started BEFORE the write still passes the check above
  // and would publish its PRE-write snapshot, stamping lastRevalidate and arming the 2s
  // throttle over stale content. The agent that just wrote a note would then be told the
  // note is not in the brain. Publish only if no invalidation landed while we were loading.
  // The caller still gets `loaded` — a coherent snapshot of the request it began under — and
  // the next read rebuilds. This is the load-then-publish recheck the MCP's own cache did
  // with `builtToken === at`; routing the MCP through this cache would otherwise lose it.
  if (epoch !== cacheEpoch) return loaded;
  if (emb) lastSemanticError = null; // a good load clears any prior cache-error banner
  cache = loaded;
  cacheBuiltToken = builtToken;
  cacheGen = gen;
  lastRevalidate = Date.now();
  void captureExternalSafe(vault); // version any on-disk change since last index (external-write safety net)
  return cache;
}

// External-write safety net (M1): on each real re-index, snapshot every note that changed on
// disk into the shadow-git version store and remember the batch for the Activity feed + the
// destructive-change Health finding. Guarded + best-effort so a slow/failed history op never
// blocks the cockpit. MCP writes self-snapshot at write time, so what surfaces here is
// overwhelmingly edits made OUTSIDE Callosium (Obsidian, an IDE agent, a sync client).
interface ExternalEdit { path: string; add: number; del: number; deleted: boolean; at: number; }
let lastExternalEdits: ExternalEdit[] = [];
let externalCaptureInFlight = false;
async function captureExternalSafe(vault: Vault): Promise<void> {
  if (externalCaptureInFlight) return;
  externalCaptureInFlight = true;
  try {
    const changes = await captureExternal(vault.root, Vault.contentHash(vault.root.toLowerCase()));
    if (changes.length) {
      const at = Date.now();
      lastExternalEdits = changes.map((c) => ({ path: c.relpath, add: c.add, del: c.del, deleted: c.deleted, at }));
    }
  } catch {
    /* history is best-effort — never break the dashboard */
  } finally {
    externalCaptureInFlight = false;
  }
}
// The health report derives from the SAME loaded state as the read screens:
// texts (and the graph build, when loadAll produced one) are handed in, so it
// no longer re-reads and re-hashes every note for its own buildGraph pass.
// Cached to the load lifecycle so the 20s overview poll doesn't re-scan the
// vault on every tick. Invalidated on any write (reindex/save/pair/scope/init)
// via dropCache, exactly like the texts/graph.
let reportCache: Awaited<ReturnType<typeof brainCheck>> | null = null;
async function cachedReport(vault: Vault): Promise<Awaited<ReturnType<typeof brainCheck>>> {
  if (reportCache) return reportCache;
  const gen = brainGeneration;
  // Epoch as well as generation. dropCache() nulls reportCache and bumps ONLY the
  // epoch, so a check that started before a write still matched the generation and
  // published its PRE-write report — which then stuck until the next invalidation.
  // The owner would fix a broken link, watch the re-check run, and see the finding
  // still listed. Same load-then-publish recheck loadOnce does for the texts/graph.
  const epoch = cacheEpoch;
  const { texts, build } = await loadAll();
  const report = await brainCheck(vault, { texts, build });
  // Don't cache a report computed for a brain we've since switched away from (P2 #1)
  // or for a vault state a write has since superseded.
  if (gen === brainGeneration && epoch === cacheEpoch) reportCache = report;
  return report;
}
// Drop the loaded brain and everything derived from it. Bumping the epoch is what
// detaches the in-flight load: a load that STARTED before this write must not be
// handed to a caller that asks after it (an MCP agent that writes then immediately
// recalls has to see its own write), and the epoch guard at the end of loadOnce also
// stops it publishing its pre-write snapshot. It used to null the slot outright,
// which additionally threw away the single-flight RAM bound — the next read then ran
// a second full load ALONGSIDE the first. The slot now survives so loadAll can queue
// behind it instead.
const dropCache = () => { cache = null; reportCache = null; cacheEpoch++; };

// ── One loaded brain per PROCESS ────────────────────────────────────────────────
// The HTTP MCP endpoint (:4321/mcp, for URL+token clients like ChatGPT and Kimi) is
// auto-started INSIDE this process. It used to own a second retrieval cache over the
// SAME brain, so the full unscoped note bodies, the graph and the Float32 vector
// matrix (~76MB on an 8k-note / ~50k-chunk brain) were ALL resident twice whenever
// the cockpit was open and an HTTP agent was active — roughly double the footprint
// of one brain, for no benefit. It now reads through the cockpit's cache, so the
// heavy structures exist once. The rank index rides along free: recall keys it on
// the VaultTexts object identity, so one texts object means one rank index, not two.
//
// The two caches could not simply be merged because their invalidation differs. This
// keeps the cockpit as the single owner and makes every direction self-heal:
//   external edits (the owner in Obsidian, a sync client, an stdio agent in another
//     process) → loadAll's own freshnessToken revalidation, the same gate the
//     cockpit's screens already rely on. The MCP surface needs no separate one.
//   MCP writes → invalidate() → dropCache(), so the very next read on EITHER surface
//     reloads. The MCP server calls it after every write, as it did for its own cache.
//   brain switch → setBrain() drops the cache and bumps brainGeneration, and the
//     per-request root check below keeps a request pinned to the old brain off the
//     new brain's data.
// Scoping is unaffected: what's shared is the OWNER-UNSCOPED brain, and the MCP
// server still filters it per request through scopedInputs, exactly as before.
function mcpBrainSource(): BrainSource {
  // A request pins its vault when it authenticates, and the owner can switch brains
  // while it is still in flight. Reading the cockpit cache then would answer that
  // agent from a brain it was never authenticated against — the leak e2e-brainswitch
  // guards, in the other direction. So share only while the request's vault IS the
  // connected brain; otherwise load privately for it. `aside` is that private
  // loader, released the moment a request comes back on the connected brain so the
  // old brain's structures can't linger and re-create the duplication.
  let aside: ReturnType<typeof mcpCacheSource> | null = null;
  // Compared by path.resolve rather than Vault.open: Vault.open IS path.resolve plus
  // an existsSync, and this runs on every tool call, so the stat would be pure cost.
  // The request's own vault.root came from Vault.open on this very string, so the
  // resolved forms match exactly whenever it is the same brain.
  // Nothing awaits between this check and loadAll's own synchronous pin of brainPath,
  // and setBrain is synchronous, so the brain cannot change in between: whichever
  // brain matches here is the one loadAll pins.
  const onConnectedBrain = (vault: Vault): boolean => {
    if (!brainPath || path.resolve(brainPath) !== vault.root) return false;
    aside = null;
    return true;
  };
  const privately = (): BrainSource => (aside ??= mcpCacheSource());
  return {
    texts: async (vault) => (onConnectedBrain(vault) ? (await loadAll()).texts : privately().texts(vault)),
    graph: async (vault) => (onConnectedBrain(vault) ? (await loadAll()).graph : privately().graph(vault)),
    emb: async (vault) => (onConnectedBrain(vault) ? (await loadAll()).emb : privately().emb(vault)),
    // invalidate() carries no vault, so we can't tell which of the two a write hit.
    // Drop both: over-invalidating costs one reload, under-invalidating serves an
    // agent a brain that no longer matches what it just wrote.
    invalidate: () => { dropCache(); aside?.invalidate(); },
  };
}

// ── Dismissed Health findings: the owner's "I looked — it's fine / false positive"
// list. Persisted OUTSIDE the vault (~/.callosium/dismissed.json, machine state,
// never synced), keyed by a STABLE per-finding identity so a dismissed item stays
// gone across re-checks. A finding that later gets fixed drops off the review list
// on its own; its key stays on disk so the same issue can't quietly resurface. ──
// Stored INSIDE the vault (System/dismissed.json) so dismissals travel with the
// brain and sync across devices — not machine-local like the graph cache. It's a
// .json, so the note engine never indexes it and freshnessToken never hashes it.
// A one-time migration lifts any earlier machine-local dismissals into the vault.
const DISMISSED_REL = 'System/dismissed.json';
const LEGACY_DISMISSED_FILE = path.join(APP_DIR, 'dismissed.json');
interface DismissedEntry { key: string; kind: string; path: string; detail: string; at: string; }
async function loadDismissed(): Promise<Record<string, DismissedEntry>> {
  if (!brainPath) return {};
  try {
    const j = JSON.parse(await Vault.open(brainPath).readFileRetry(DISMISSED_REL));
    return j && typeof j === 'object' && j.keys && typeof j.keys === 'object' ? j.keys : {};
  } catch {
    // migrate a pre-existing machine-local store into the vault, once.
    try {
      const legacy = JSON.parse(await fs.readFile(LEGACY_DISMISSED_FILE, 'utf8'));
      const keys = legacy && legacy.keys && typeof legacy.keys === 'object' ? legacy.keys : {};
      if (Object.keys(keys).length) { await saveDismissed(keys); return keys; }
    } catch { /* no legacy store */ }
    return {};
  }
}
async function saveDismissed(keys: Record<string, DismissedEntry>): Promise<void> {
  if (!brainPath) return;
  await Vault.open(brainPath).writeFile(DISMISSED_REL, JSON.stringify({ keys }, null, 2));
}
/** Stable identity for a finding — kind + the notes/target it concerns, NOT the
 *  human-readable detail (which can be reworded between versions). */
function findingKey(f: { kind: string; path: string; target?: string; paths?: string[]; detail: string }): string {
  if (f.kind === 'broken-wikilink') return `broken-wikilink|${f.path}|${f.target ?? ''}`;
  if (f.kind === 'orphan-note') return `orphan-note|${f.path}`;
  if (f.kind === 'duplicate-alias') return `duplicate-alias|${(f.paths ?? [f.path]).slice().sort().join(',')}`;
  if (f.kind === 'sync-conflict-copy') return `sync-conflict-copy|${f.path}`;
  return `${f.kind}|${f.path}|${f.detail}`; // schema-conformance findings
}
// a partition is a top-level FOLDER; a root-level file (no '/') is '(root)',
// never its own bogus "folder" (which produced "Home.md/" scope rows).
const partitionOf = (f: string) => (f.includes('/') ? f.split('/')[0] : '(root)');
// health as a %: driven by INTEGRITY problems (sync conflicts, broken links,
// duplicate aliases) — not schema-conformance nags (unknown-type, invalid-
// frontmatter/status) or orphan notes, which are normal/advisory for a
// personal vault and shouldn't tank the score.
const INTEGRITY_KINDS = new Set(['sync-conflict-copy', 'broken-wikilink', 'duplicate-alias']);
const problemWeight = (findings: { kind: string }[]) =>
  findings.reduce((s, f) => s + (INTEGRITY_KINDS.has(f.kind) ? 1 : 0.1), 0);
const healthScore = (notes: number, weighted: number) =>
  Math.max(40, Math.min(100, Math.round(100 - (weighted / Math.max(notes, 1)) * 100)));
const relTime = (ms: number, now: number) => {
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 129600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};

interface Json {
  [k: string]: unknown;
}
const send = (res: http.ServerResponse, code: number, body: Json | Json[]) => {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
  res.end(s);
};

// ── RESPONSE COMPRESSION (gzip/deflate, plain zlib, no deps) ──
// The single-page document (373KB) and the big JSON reads (/api/graph 228KB,
// /api/notes 195KB) otherwise cross the wire raw: ~250KiB wasted on the
// document alone, ~7x on the graph. Identity when the client offers no
// Accept-Encoding, so curl/tests see plain bodies.
const gzipAsync = promisify(zlibGzip);
const deflateAsync = promisify(zlibDeflate);
const COMPRESSIBLE = /^(?:text\/|application\/json)/;
// Below this the gzip framing (~20B) cancels the win; small payloads (account
// 98B, activity) go identity regardless.
const COMPRESS_MIN = 1024;
// Wrap a response so a SINGLE-SHOT body (writeHead, then one end) of a
// compressible type is compressed when worthwhile. Streaming responses (the
// ingest SSE feed and the export zip pipe) call write() and pass through
// untouched: buffering SSE would stall its per-event flush, and recompressing
// a zip is pure waste. Headers are captured at writeHead and emitted on first
// flush, so the compressed path can rewrite content-length and add
// content-encoding without every handler knowing about compression.
function wrapCompression(req: http.IncomingMessage, res: http.ServerResponse): void {
  const ae = req.headers['accept-encoding'];
  const enc = typeof ae === 'string' && /\bgzip\b/.test(ae) ? 'gzip'
    : typeof ae === 'string' && /\bdeflate\b/.test(ae) ? 'deflate' : null;
  if (!enc) return; // client offered nothing, leave the response completely alone
  const writeHead = res.writeHead.bind(res) as (code: number, headers?: http.OutgoingHttpHeaders) => http.ServerResponse;
  const write = res.write.bind(res) as (...args: unknown[]) => boolean;
  const end = res.end.bind(res) as (...args: unknown[]) => http.ServerResponse;
  let head: { code: number; headers: http.OutgoingHttpHeaders } | null = null;
  let streamed = false;
  const flushHead = () => { if (head) { writeHead(head.code, head.headers); head = null; } };
  res.writeHead = ((code: number, headers?: http.OutgoingHttpHeaders) => {
    head = { code, headers: headers ?? {} };
    return res;
  }) as unknown as typeof res.writeHead;
  res.write = ((...args: unknown[]) => { streamed = true; flushHead(); return write(...args); }) as unknown as typeof res.write;
  res.end = ((...args: unknown[]) => {
    const body = args.find((a): a is string | Buffer => typeof a === 'string' || Buffer.isBuffer(a));
    const h = head; head = null;
    if (streamed || !h || body === undefined || body.length < COMPRESS_MIN) {
      if (h) writeHead(h.code, h.headers);
      return end(...args);
    }
    const ctype = String(h.headers['content-type'] ?? '');
    if (!COMPRESSIBLE.test(ctype)) {
      writeHead(h.code, h.headers);
      return end(...args);
    }
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
    void (enc === 'gzip' ? gzipAsync : deflateAsync)(buf).then((out) => {
      writeHead(h.code, { ...h.headers, 'content-encoding': enc, vary: 'Accept-Encoding', 'content-length': out.length });
      end(out);
    }, () => {
      writeHead(h.code, h.headers); // compression itself failed: serve identity
      end(...args);
    });
    return res;
  }) as unknown as typeof res.end;
}

// Most dashboard payloads are tiny scope/pair objects, but /api/note/save posts
// the WHOLE note — and the product supports huge notes (a 150k-word ≈ 900KB doc,
// plus Raw scrape dumps). At 1MB this rejected a large note's save while the read
// path served it uncapped, stranding in-editor edits. 16MB comfortably covers any
// real note; this is a loopback, origin+token-gated, single-user server, so the
// buffered-body memory is a non-issue.
const MAX_BODY = 16 << 20; // 16 MB
const readBody = (req: http.IncomingMessage): Promise<Json> =>
  new Promise((resolve) => {
    // Collect raw Buffers and decode ONCE at the end. Concatenating each chunk as
    // a string (`b += c`) splits multibyte UTF-8 (Arabic, emoji) at chunk
    // boundaries and corrupts it — a real risk for this vault's Arabic content.
    const chunks: Buffer[] = [];
    let len = 0;
    let settled = false;
    const done = (v: Json) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    req.on('data', (c: Buffer) => {
      if (settled) return;
      chunks.push(c);
      len += c.length;
      // Cap the buffer so a buggy/malicious client can't exhaust memory before
      // we even parse — destroy the socket the moment it exceeds the limit.
      // CRITICAL: resolve NOW. req.destroy() with no error emits neither 'end'
      // nor 'error' (only 'close'), so waiting for a later event would leave
      // this promise — and the awaiting handler's closure — pinned forever.
      if (len > MAX_BODY) {
        req.destroy();
        done({});
      }
    });
    req.on('end', () => {
      try {
        const b = Buffer.concat(chunks).toString('utf8');
        done(b ? JSON.parse(b) : {});
      } catch {
        done({});
      }
    });
    req.on('error', () => done({}));
    // Backstop for any abrupt termination (destroy from elsewhere, client
    // reset) that fires only 'close' — never leave the promise hanging.
    req.on('close', () => done({}));
  });

// Largest mtime WITHOUT spreading every value as a call argument — a big vault
// (or one pointed at a huge tree) would blow the call-stack limit on
// Math.max(...values) and 500 the whole screen.
const maxMtime = (mtimes: Map<string, number>): number => {
  let m = 0;
  for (const v of mtimes.values()) if (v > m) m = v;
  return m;
};

// count markdown notes without a full engine load (cheap, for the folder picker)
async function quickCount(dir: string): Promise<number> {
  let n = 0;
  const walk = async (d: string, depth: number) => {
    if (depth > 8) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full, depth + 1);
      else if (e.name.endsWith('.md')) n++;
    }
  };
  await walk(dir, 0);
  return n;
}

// Windows seeds every user profile with hidden compatibility junctions (reparse
// points that redirect old shell-folder names). Now that we follow reparse
// points to surface real cloud folders like OneDrive, these would otherwise
// clutter the picker with "Cookies", "NetHood", "My Documents", etc.
const WIN_LEGACY_JUNCTIONS = new Set([
  'Application Data', 'Cookies', 'Local Settings', 'My Documents', 'My Music',
  'My Pictures', 'My Videos', 'NetHood', 'PrintHood', 'Recent', 'SendTo',
  'Start Menu', 'Templates', 'History', 'Temporary Internet Files',
]);

async function handleBrowse(res: http.ServerResponse, body: Json) {
  // List sub-directories of a path (the web folder picker; the desktop shell
  // replaces this with a native dialog). Defaults to the user's home.
  const dir = (body.path as string) || os.homedir();
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    // Include real directories AND reparse points that resolve to a directory.
    // Cloud folders (OneDrive, Dropbox, Google Drive) come back from readdir as
    // isDirectory()=false / isSymbolicLink()=true even though they ARE folders —
    // filtering on isDirectory() alone hid OneDrive from the picker, which is
    // exactly where most people keep their notes. Follow the link to confirm.
    const dirs: { name: string; path: string }[] = [];
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      let isDir = e.isDirectory();
      if (!isDir && e.isSymbolicLink()) {
        if (process.platform === 'win32' && WIN_LEGACY_JUNCTIONS.has(e.name)) continue; // hidden junk
        try {
          isDir = (await fs.stat(path.join(dir, e.name))).isDirectory();
        } catch {
          isDir = false; // broken link or offline cloud placeholder — skip it
        }
      }
      if (isDir) dirs.push({ name: e.name, path: path.join(dir, e.name) });
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name));
    const mdHere = entries.filter((e) => e.isFile() && e.name.endsWith('.md')).length;
    browsedPaths.add(dir);
    dirs.forEach((d) => browsedPaths.add(d.path));
    send(res, 200, { dir, parent: path.dirname(dir) === dir ? null : path.dirname(dir), dirs, mdHere });
  } catch (err) {
    send(res, 400, { error: `Can't open ${dir}: ${(err as Error).message}` });
  }
}

async function handleInspect(res: http.ServerResponse, body: Json) {
  const dir = body.path as string;
  if (!dir || !existsSync(dir)) return send(res, 400, { error: 'That folder does not exist.' });
  const stat = await fs.stat(dir);
  if (!stat.isDirectory()) return send(res, 400, { error: 'That is a file, not a folder.' });
  const notes = await quickCount(dir);
  const hasSchema = existsSync(path.join(dir, 'System', 'brain.json'));
  browsedPaths.add(dir); // the user explicitly chose this folder — ingest may target it
  send(res, 200, { path: dir, notes, hasSchema });
}

// Only one ingest may mutate brainPath/cache at a time — two concurrent runs
// for different folders would race and whichever finished last would silently
// win, leaving the served brain out of sync with what the UI last showed.
let ingesting = false;

// The ingest journey, streamed as Server-Sent Events so the UI shows live
// progress: scan → graph → embeddings → done.
async function handleIngest(req: http.IncomingMessage, res: http.ServerResponse, dir: string) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  let aborted = false;
  req.on('close', () => { aborted = true; }); // client navigated away — stop wasting work
  const emit = (event: string, data: Json) => { if (!aborted && !res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
  if (ingesting) { emit('error', { message: 'An import is already running — let it finish first.' }); return res.end(); }
  ingesting = true;
  try {
    // Only ingest a folder the user actually navigated to this session (or the
    // already-connected brain, for re-index). Refuse arbitrary paths so a forged
    // request can't repoint the brain at, and spin the server scanning, a huge
    // or system directory.
    if (dir !== brainPath && !browsedPaths.has(dir)) throw new Error('folder not permitted — pick it in the browser first');
    if (!existsSync(dir)) throw new Error('folder not found');
    const vault = Vault.open(dir);

    emit('phase', { step: 'scan', label: 'reading your notes' });
    const texts = await loadTexts(vault);
    if (aborted) return;
    emit('stat', { notes: texts.files.length });

    emit('phase', { step: 'graph', label: 'connecting the dots' });
    // Reuse the texts we just loaded — buildGraph(vault) alone re-reads and
    // re-hashes every note off disk a second time (graph/index.ts no-shared
    // branch); loadAll passes texts for exactly this reason (~7s→ on a big vault).
    const { index: graph } = await buildGraph(vault, texts);
    if (aborted) return;
    emit('stat', { notes: texts.files.length, edges: graph.edges.filter((e) => !e.unresolved).length });

    emit('phase', { step: 'embed', label: 'learning what your notes mean' });
    // First run downloads the ~120MB embedding model — stream that progress so
    // the user sees a one-time download, not a hang. If the model can't be
    // fetched (offline first run), the brain still connects fully: keyword
    // recall needs no model; semantic enables itself on the next re-index.
    onModelProgress((pct) => emit('model', { pct, label: `downloading the language model (one-time): ${pct}%` }));
    let emb: EmbeddingIndex | null = null;
    try {
      emb = await buildEmbeddings(vault, texts.files, texts.texts, (done, total) => {
        emit('embed', { done, total });
      });
    } catch (err) {
      if (!(err instanceof ModelUnavailableError)) throw err;
      emit('model', { pct: null, label: 'language model unavailable (offline?) — keyword recall works; semantic joins on the next re-index' });
      console.error('[callosium] ' + err.message);
    } finally {
      onModelProgress(null);
    }
    if (aborted) return;
    emit('stat', { notes: texts.files.length, edges: graph.edges.filter((e) => !e.unresolved).length, chunks: emb ? emb.chunks.length : 0 });

    setBrain(dir); // resets every brain-scoped cache atomically (no separate dropCache needed)
    // Generate the brain's Map (System/Map.md) so it exists from first ingest and
    // travels with the vault — the routing map any AI reads to navigate. Uses the
    // FULL texts (unscoped); best-effort inside writeMap so it never breaks ingest.
    try { const { schema: sch } = await loadSchema(vault); await writeMap(vault, sch, texts); } catch { /* non-fatal */ }
    emit('done', { path: dir, notes: texts.files.length, edges: graph.edges.filter((e) => !e.unresolved).length, chunks: emb ? emb.chunks.length : 0 });
  } catch (err) {
    emit('error', { message: (err as Error).message });
  } finally {
    ingesting = false;
    res.end();
  }
}

// Build the MCP client config a user pastes into their AI. A global npm install
// exposes the `callosium` shim on PATH; the portable bundle and desktop app do
// NOT — they run the bundled node against app/dist/cli.js. Handing those users a
// bare `callosium` command fails with "command not found", so detect the bundle
// (it sets CALLOSIUM_MODEL_DIR and runs cli.js) and emit the bundled node + the
// script path plus the model-dir env instead, which works everywhere.
function mcpClientConfig(vaultRoot: string, id: string, token: string) {
  const args = ['mcp', '--brain', vaultRoot, '--agent', id, '--token', token];
  const modelDir = process.env.CALLOSIUM_MODEL_DIR;
  const script = process.argv[1];
  if (modelDir && script && script.endsWith('cli.js')) {
    return {
      mcpServers: {
        callosium: { command: process.execPath, args: [script, ...args], env: { CALLOSIUM_MODEL_DIR: modelDir } },
      },
    };
  }
  return { mcpServers: { callosium: { command: 'callosium', args } } };
}

async function handlePair(res: http.ServerResponse, body: Json) {
  if (!brainPath) return send(res, 400, { error: 'Connect a brain first.' });
  const id = (body.id as string)?.trim();
  const displayName = (body.displayName as string)?.trim();
  if (!id || !displayName) return send(res, 400, { error: 'Need an id and a display name.' });
  const vault = Vault.open(brainPath);
  try {
    const agent = await pairAgent(vault, id, displayName);
    dropCache();
    // The exact block a user pastes into their AI client (portable/desktop get
    // the bundled node + cli.js path instead of a global `callosium` shim).
    const config = mcpClientConfig(vault.root, agent.id, agent.token);
    send(res, 200, { agent: { id: agent.id, displayName: agent.displayName }, config });
  } catch (err) {
    send(res, 400, { error: (err as Error).message });
  }
}

// Rotate a paired agent's token from the cockpit — kills the old one and returns
// the fresh config to paste. stdio + HTTP both authenticate against the live
// registry each call, so the old token stops working the instant this returns.
async function handleRotate(res: http.ServerResponse, body: Json) {
  if (!brainPath) return send(res, 400, { error: 'Connect a brain first.' });
  const id = (body.id as string)?.trim();
  if (!id) return send(res, 400, { error: 'Need an agent id.' });
  const vault = Vault.open(brainPath);
  try {
    const agent = await rotateAgentToken(vault, id);
    const config = mcpClientConfig(vault.root, agent.id, agent.token);
    send(res, 200, { agent: { id: agent.id, displayName: agent.displayName }, config });
  } catch (err) {
    send(res, 400, { error: (err as Error).message });
  }
}

// Rename a paired agent's display label (cockpit + attribution). Id and token are
// untouched, so no re-pairing and no config edit — the connection keeps working.
async function handleRename(res: http.ServerResponse, body: Json) {
  if (!brainPath) return send(res, 400, { error: 'Connect a brain first.' });
  const id = (body.id as string)?.trim();
  const displayName = (body.displayName as string)?.trim();
  if (!id || !displayName) return send(res, 400, { error: 'Need an agent id and a new name.' });
  const vault = Vault.open(brainPath);
  try {
    const agent = await renameAgent(vault, id, displayName);
    dropCache();
    send(res, 200, { agent: { id: agent.id, displayName: agent.displayName } });
  } catch (err) {
    send(res, 400, { error: (err as Error).message });
  }
}

async function handleState(res: http.ServerResponse) {
  if (!brainPath) return send(res, 200, { onboarded: false });
  const vault = Vault.open(brainPath);
  const { schema } = await loadSchema(vault);
  const reg = await loadAgents(vault).catch(() => ({ agents: [] as { id: string; displayName: string }[] }));
  // Share the loaded brain instead of running a private loadTexts: the desktop
  // shell polls this endpoint, and a full vault read per poll (~0.9s on a
  // 1.1k-note brain) made it the most expensive warm endpoint.
  const { texts } = await loadAll();
  const partitions: Record<string, number> = {};
  for (const f of texts.files) {
    const top = f.split('/')[0] || '(root)';
    partitions[top] = (partitions[top] || 0) + 1;
  }
  send(res, 200, {
    onboarded: true,
    brainName: schema.name,
    brainPath,
    notes: texts.files.length,
    partitions,
    agents: reg.agents.map((a) => ({ id: a.id, displayName: a.displayName })),
    mcp: mcpStatus,
  });
}

// ── OVERVIEW: the cockpit vitals ──
async function handleOverview(res: http.ServerResponse) {
  if (!brainPath) return send(res, 200, { onboarded: false });
  const vault = Vault.open(brainPath);
  const { schema } = await loadSchema(vault);
  const { texts, graph, emb } = await loadAll();
  const reg = await loadAgents(vault).catch(() => ({ agents: [] as { id: string; displayName: string }[] }));
  const partitions: Record<string, number> = {};
  for (const f of texts.files) partitions[partitionOf(f)] = (partitions[partitionOf(f)] || 0) + 1;
  const edges = graph.edges.filter((e) => !e.unresolved).length;
  // health: a simple, honest score — start at 100, dock for real problems.
  // cached to the load lifecycle so the 20s poll doesn't re-scan the vault.
  const report = await cachedReport(vault);
  const health = healthScore(report.notes, problemWeight(report.findings));
  send(res, 200, {
    onboarded: true,
    brainName: schema.name,
    brainPath,
    vitals: { notes: texts.files.length, connections: edges, meaningPoints: emb?.chunks.length ?? 0, agents: reg.agents.length, health },
    semantic: !!emb,
    // non-null when an EXISTING embedding cache failed to load (corrupt/torn) —
    // the UI shows a "re-index to restore semantic" banner instead of silence.
    semanticError: emb ? null : lastSemanticError,
    // when the INDEX was actually built (not the newest note edit — those are
    // different, and conflating them would hide index staleness).
    lastIndexedMs: Date.parse(graph.builtAt) || 0,
    lastEditedMs: maxMtime(texts.mtimes),
    partitions,
    agents: reg.agents.map((a) => ({ id: a.id, displayName: a.displayName })),
    // Rides on overview because that is what the UI actually polls (/api/state is the desktop
    // shell's handshake, not a screen's data source). The connect guide needs it: it prints a URL
    // and a token for this endpoint, and must not do that when nothing is listening.
    mcp: mcpStatus,
  });
}

// ── ACTIVITY: recent note edits (real mtimes; agent-level logging is a
// separate cross-process feature not yet built, so we show what changed). ──
async function handleActivity(res: http.ServerResponse, limit: number) {
  if (!brainPath) return send(res, 200, { items: [] });
  const { texts } = await loadAll();
  // Single clock reference so agent-action timestamps (wall clock at log time) and note mtimes
  // (which can run slightly ahead on a synced drive) produce consistent "x ago" labels.
  const now = Math.max(Date.now(), maxMtime(texts.mtimes) || 0);
  // The per-agent action log: exactly what each connected AI (and the owner) DID — read / write /
  // append / archive / move / recall / remember — newest first, with who did it.
  const actions = await readActions(historyBrainId(), limit * 2).catch(() => []);
  const actionItems = actions.map((a) => ({
    kind: 'action' as const,
    agent: a.agent,
    agentId: a.agentId,
    action: a.action,
    path: a.path,
    name: a.path ? a.path.split('/').pop()!.replace(/\.md$/, '') : undefined,
    partition: a.path ? partitionOf(a.path) : undefined,
    detail: a.detail,
    at: a.at,
    ago: relTime(a.at, now),
  }));
  // Notes whose latest change already shows as an agent/owner action are covered above; the rest are
  // edits made OUTSIDE Callosium (Obsidian, sync) — surface them so nothing is invisible. Suppress a
  // note's mtime entry only when the NEWEST action on it is at least as recent as the mtime (+1s for
  // fs/clock jitter): that hides the redundant "note changed" twin of a write, but an external edit
  // made AFTER an agent touched the note still shows, at its real time — not buried behind the action.
  // Only WRITE-class actions create the redundant "note changed" twin we're deduping — a read/recall
  // doesn't touch the file's mtime, so it must NOT suppress a genuine external edit (an agent reading
  // a note the owner just edited in Obsidian would otherwise hide that edit from the feed).
  const WRITE_ACTIONS = new Set(['write', 'append', 'archive', 'move', 'remember']);
  const lastActionAt = new Map<string, number>();
  for (const i of actionItems) if (i.path && WRITE_ACTIONS.has(i.action)) lastActionAt.set(i.path, Math.max(lastActionAt.get(i.path) || 0, i.at || 0));
  const noteItems = [...texts.mtimes.entries()]
    // Managed System/ files (Map.md, dismissed.json, brain.json) are rewritten on every re-index,
    // so they'd otherwise dominate "recent activity" with noise the owner never edited.
    .filter(([p, mtime]) => !p.startsWith('System/') && mtime > (lastActionAt.get(p) ?? -Infinity) + 1000)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([path, mtime]) => ({
      kind: 'note' as const,
      path,
      name: path.split('/').pop()!.replace(/\.md$/, ''),
      partition: partitionOf(path),
      at: mtime,
      ago: relTime(mtime, now),
    }));
  const items = [...actionItems, ...noteItems].sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, limit);
  send(res, 200, { items });
}

// ── BRAIN MAP: the note graph — nodes (notes) + resolved links (edges). The
// client lays them out (folder clusters) and runs the physics/interactions.
// The payload is large (228KB on a 1.1k-note brain) and was refetched on EVERY
// map entry. Now it is serialized once per vault state and served with an ETag
// keyed to the same freshness token loadAll already uses: a re-entry sends
// If-None-Match and gets a bare 304 instead of the full 228KB. ──
let graphBodyCache: { token: string; body: string } | null = null;
async function handleGraph(req: http.IncomingMessage, res: http.ServerResponse) {
  if (!brainPath) return send(res, 200, { nodes: [], edges: [] });
  const { texts, graph, token } = await loadAll();
  // Key BOTH the ETag and the body cache to the token of the snapshot we were just
  // handed, never to the global cacheBuiltToken. loadAll can return a snapshot it
  // chose not to publish (a write or a brain switch landed mid-load), and the global
  // moves on its own besides — so the pair could disagree, and the browser would then
  // cache THIS body under a token belonging to a DIFFERENT vault state. Its next
  // If-None-Match would match, and the map would sit on a stale graph indefinitely.
  const etag = `"graph-${token}"`;
  // no-cache (not no-store): the browser KEEPS the body and revalidates each
  // entry, and the revalidation is the cheap 304 path above.
  const headers = { etag, 'cache-control': 'no-cache' };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  if (!graphBodyCache || graphBodyCache.token !== token) {
    const idx = new Map<string, number>();
    // Exclude managed System/ files (Map.md is generated each re-index) — otherwise
    // Map.md renders as a phantom "Map" super-hub node wired to every MOC it links.
    // Edges to it are then dropped naturally (idx.get returns undefined below).
    const nodes = texts.files.filter((f) => !f.startsWith('System/')).map((f, i) => {
      idx.set(f, i);
      return {
        id: f,
        name: f.split('/').pop()!.replace(/\.md$/, ''),
        partition: partitionOf(f),
        links: 0,
      };
    });
    const edges: [number, number][] = [];
    for (const e of graph.edges) {
      if (e.unresolved) continue;
      const a = idx.get(e.from);
      const b = idx.get(e.to);
      if (a == null || b == null || a === b) continue;
      edges.push([a, b]);
      nodes[a].links++;
      nodes[b].links++;
    }
    graphBodyCache = { token, body: JSON.stringify({ nodes, edges }) };
  }
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(graphBodyCache.body), ...headers });
  res.end(graphBodyCache.body);
}

// ── ASK: run recall (graph + semantic), return the evidence the agent sees ──
async function handleRecall(res: http.ServerResponse, q: string) {
  if (!brainPath) return send(res, 400, { error: 'Connect a brain first.' });
  if (!q.trim()) return send(res, 400, { error: 'Ask something.' });
  const { texts, graph, emb } = await loadAll();
  const a0 = await recall(q, texts, graph, false, emb);
  const a = relationshipHonesty(q, a0, texts); // M4: person-question honesty
  send(res, 200, {
    found: a.found,
    notInBrainReason: a.notInBrainReason,
    results: (a.results ?? []).map((r) => ({ path: r.path, excerpt: r.excerpt.slice(0, 1200), createSafety: r.createSafety })),
    context: a.context ?? [],
    corrections: a.corrections ?? [],
    relaxation: a.relaxation, // disclose when the engine dropped a weak term to answer
    clarify: a.clarify,
  });
}

// ── HEALTH: the brain_check audit surfaced ──
async function handleCheck(res: http.ServerResponse) {
  if (!brainPath) return send(res, 400, { error: 'Connect a brain first.' });
  const vault = Vault.open(brainPath);
  const report = await cachedReport(vault);
  const dismissed = await loadDismissed();
  // Stamp each finding with its stable key, then drop the ones the owner dismissed.
  const withKeys = report.findings.map((f) => ({ ...f, key: findingKey(f) }));
  const active = withKeys.filter((f) => !dismissed[f.key]);
  // Recompute the counts + score from the ACTIVE set so a dismissed false positive
  // stops dragging the number down (and stops nagging in the card counts).
  const byKind: Record<string, number> = {};
  for (const f of active) byKind[f.kind] = (byKind[f.kind] || 0) + 1;
  const health = healthScore(report.notes, problemWeight(active));
  // Review list: only dismissals that STILL correspond to a live finding — a fixed
  // one is pruned from view (its key stays on disk so it can't quietly resurface).
  const presentKeys = new Set(withKeys.map((f) => f.key));
  const dismissedList = Object.values(dismissed).filter((d) => presentKeys.has(d.key));
  // send a generous slice (not 200): the Health screen lists affected notes per
  // finding kind, so each kind needs enough examples even when one kind is huge.
  // `skipped` rides along so the Health card can say a check DIDN'T RUN instead of showing a score
  // that quietly counts it as passed — a vault whose own brain.json failed to load would otherwise
  // see its format findings drop to zero and read that as an improvement.
  send(res, 200, { notes: report.notes, edges: report.edges, health, byKind, findings: active.slice(0, 4000), dismissed: dismissedList, dismissedCount: dismissedList.length, skipped: report.skipped, schemaSource: report.schemaSource });
}

// Owner dismisses / restores a single finding (persisted). No dropCache: the
// finding set on disk is unchanged — only which ones we SHOW.
async function handleDismiss(res: http.ServerResponse, body: Json) {
  const key = typeof body.key === 'string' ? body.key : '';
  if (!key) return send(res, 400, { error: 'Need a finding key.' });
  // Serialize the load→mutate→save so two concurrent dismisses can't read the
  // same store and clobber each other's addition (lost dismissal).
  await withNoteSaveLock(DISMISSED_REL, async () => {
    const keys = await loadDismissed();
    keys[key] = { key, kind: String(body.kind ?? ''), path: String(body.path ?? ''), detail: String(body.detail ?? ''), at: new Date().toISOString() };
    await saveDismissed(keys);
  });
  send(res, 200, { ok: true });
}
async function handleUndismiss(res: http.ServerResponse, body: Json) {
  const key = typeof body.key === 'string' ? body.key : '';
  if (!key) return send(res, 400, { error: 'Need a finding key.' });
  await withNoteSaveLock(DISMISSED_REL, async () => {
    const keys = await loadDismissed();
    delete keys[key];
    await saveDismissed(keys);
  });
  send(res, 200, { ok: true });
}

// ── AUTO-LINK: connect orphan notes by wikifying the FIRST unlinked mention of
// another note's title/alias in their text. Deterministic (same linker the MCP
// uses), non-destructive (only wraps existing text in [[…]] — never changes
// wording), preview-first: preview computes the plan, apply RE-DERIVES the same
// plan and writes it. This is the Health screen's "connect these" orphan fix.
// A lone one-word section header ("## Overview", "## Schema") is structure, not
// a reference — with no prior linking history it must NOT be auto-wikified into
// a link at the note that merely happens to share that name.
const GENERIC_WORDS = new Set([
  'overview', 'schema', 'home', 'index', 'readme', 'guide', 'notes', 'note', 'summary', 'about',
  'sources', 'source', 'setup', 'install', 'changelog', 'todo', 'draft', 'template', 'templates',
  'example', 'examples', 'misc', 'general', 'main', 'intro', 'introduction', 'contents', 'resources',
  'details', 'description', 'background', 'goals', 'scope', 'status', 'log', 'logs',
]);
function cleanCands(cands: ReturnType<typeof suggestLinks>): ReturnType<typeof suggestLinks> {
  return cands.filter((c) => {
    const w = c.phrase.trim();
    if (!/\s/.test(w) && c.keyphraseness === 0 && GENERIC_WORDS.has(w.toLowerCase())) return false;
    return true;
  });
}
async function computeOrphanLinkPlan(vault: Vault, texts: VaultTexts) {
  const report = await cachedReport(vault);
  const orphanSet = new Set(report.findings.filter((f) => f.kind === 'orphan-note').map((f) => f.path));
  const notes = texts.files.map((p) => ({ path: p, text: texts.texts.get(p) || '', aliases: aliasesOf(texts.texts.get(p) || '') }));
  const index = buildLinkerIndex(notes);
  const bySource = new Map<string, ReturnType<typeof suggestLinks>>();
  // Never write into verbatim source dumps: anything under a /Raw/ folder, or a
  // file whose name carries "raw" (scraped external docs like "Typesense Docs
  // Raw", "00-raw-api-docs"). Those stay byte-for-byte as scraped/exported —
  // they're dense with URLs, code and paths that must not be touched.
  const isVerbatim = (p: string) => /(^|\/)Raw\//i.test(p) || /\braw\b/i.test(p.split('/').pop() || '');

  // OUTBOUND: an orphan that names another note links to it — de-orphans itself.
  const outbound = new Set<string>();
  for (const op of orphanSet) {
    if (isVerbatim(op)) continue;
    const cands = cleanCands(suggestLinks(index, op, texts.texts.get(op) || '', 12));
    if (cands.length) { bySource.set(op, cands); outbound.add(op); }
  }
  // INBOUND: for orphans nothing links OUT from, find the first note that MENTIONS
  // the orphan and add a single link there — one inbound edge is enough to pull
  // the orphan into the graph, without spraying the same link across every note.
  const inbound = new Set<string>();
  for (const n of notes) {
    if (orphanSet.has(n.path) || isVerbatim(n.path)) continue; // skip orphans (outbound) + verbatim
    const cands = cleanCands(suggestLinks(index, n.path, n.text, 20));
    for (const c of cands) {
      if (orphanSet.has(c.target) && !outbound.has(c.target) && !inbound.has(c.target)) {
        inbound.add(c.target);
        if (!bySource.has(n.path)) bySource.set(n.path, []);
        bySource.get(n.path)!.push(c);
      }
    }
  }
  const edits = [...bySource.entries()].map(([path, cands]) => ({ path, cands }));
  return { edits, orphanTotal: orphanSet.size, orphansConnected: outbound.size + inbound.size };
}
async function handleLinkPreview(res: http.ServerResponse) {
  if (!brainPath) return send(res, 400, { error: 'Connect a brain first.' });
  const vault = Vault.open(brainPath);
  const { texts } = await loadAll();
  const { edits, orphanTotal, orphansConnected } = await computeOrphanLinkPlan(vault, texts);
  const links = edits.reduce((s, e) => s + e.cands.length, 0);
  send(res, 200, {
    orphanTotal,
    orphansConnected, // orphans this plan pulls back into the graph
    notes: edits.length, // notes that will be edited (orphans + notes that mention one)
    links, // total wikilinks to add
    sample: edits.slice(0, 40).map((e) => ({ path: e.path, adds: e.cands.map((c) => ({ phrase: c.phrase, target: c.target })) })),
  });
}
async function handleLinkApply(res: http.ServerResponse) {
  if (!brainPath) return send(res, 400, { error: 'Connect a brain first.' });
  const vault = Vault.open(brainPath);
  const { texts } = await loadAll();
  const { edits, orphansConnected } = await computeOrphanLinkPlan(vault, texts);
  // Every hygiene fix is reversible: snapshot each note's ORIGINAL text under
  // ~/.callosium/backups/autolink-<stamp>/ before writing. Adds only [[ ]] around
  // words already in the note — never removes a character — but the backup lets
  // the whole pass be undone in one move regardless.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(os.homedir(), '.callosium', 'backups', `autolink-${stamp}`);
  let changed = 0, added = 0, skipped = 0;
  try {
    for (const e of edits) {
      const cachedText = texts.texts.get(e.path) || '';
      await withNoteSaveLock(e.path, async () => {
        const v = Vault.open(brainPath!);
        // The link offsets were computed against the cached snapshot. If the note
        // changed on disk since (an MCP agent, another editor), applying those
        // stale offsets would corrupt it — verify disk still equals the snapshot
        // and SKIP if it diverged. The next re-check re-plans from fresh content.
        const disk = await v.readFileRetry(e.path).catch(() => null);
        // cachedText comes from loadTexts, which NFC-normalizes; raw disk bytes
        // of an NFD-authored note (macOS/iCloud, Arabic/accented names) would
        // never compare equal and every such note got silently "skipped".
        // Compare NFC-to-NFC for staleness, but apply links to (and back up)
        // the RAW disk text — writing applyLinks(cachedText) would rewrite an
        // NFD note's every non-ASCII byte and the backup couldn't restore the
        // true original (17 Jul re-review). On an NFD note whose target word
        // is decomposed, applyLinks simply matches nothing: a safe no-op.
        if (disk === null || disk.normalize('NFC') !== cachedText) { skipped++; return; }
        const newText = applyLinks(disk, e.cands);
        if (newText === disk) return;
        const bpath = path.join(backupDir, e.path);
        await fs.mkdir(path.dirname(bpath), { recursive: true });
        await fs.writeFile(bpath, disk, 'utf8'); // snapshot the true on-disk original
        await v.writeFile(e.path, newText);
        changed++;
        added += e.cands.length;
      });
    }
  } finally {
    dropCache(); // even on a partial/failed apply — links changed → graph + orphan set changed
  }
  send(res, 200, { ok: true, notesChanged: changed, linksAdded: added, skipped, orphansConnected, backup: changed ? backupDir : null });
}

// ── CLEANUP: delete redundant duplicate/conflict files (preview → confirm) ──
// Only ever proposes removing a file when an IDENTICAL-CONTENT copy is kept, or a
// sync-conflict copy shadows its original — never a distinct note. Reversible:
// every removed file is snapshotted to ~/.callosium/backups/cleanup-<ts>/ first.
type CleanupGroup = { name: string; kind: 'sync' | 'dup'; keep: string; remove: string[]; bytes: number };
// Prefer keeping the "real" copy: not an import/quarantine/backup dump, then the
// shallowest path, then alphabetical.
function pickCanonical(paths: string[]): string {
  const importish = (p: string) => /From Desktop|Quarantine|[/ ]backup|\bcopy\b|\(\d+\)/i.test(p) ? 1 : 0;
  return [...paths].sort((a, b) => importish(a) - importish(b) || a.split('/').length - b.split('/').length || a.localeCompare(b))[0];
}
async function statSize(rel: string): Promise<number> {
  try { return (await fs.stat(path.join(brainPath!, rel))).size; } catch { return 0; }
}
async function computeCleanupPlan(vault: Vault, kind?: string | null): Promise<{ groups: CleanupGroup[]; diverged: string[] }> {
  const report = await cachedReport(vault);
  const groups: CleanupGroup[] = [];
  const diverged: string[] = []; // conflict copies that hold edits the original doesn't — never auto-delete
  const norm = (s: string | null) => (s ?? '').replace(/\r\n/g, '\n').trim();
  for (const f of report.findings) {
    if (f.kind === 'sync-conflict-copy' && f.related) {
      // Only auto-remove a conflict copy that is byte-identical (normalised) to its original. A copy
      // that DIVERGED holds edits the original doesn't — deleting it (even to a reversible backup)
      // would hide real work, so surface it for manual review instead of offering it as a "safe
      // duplicate". (The duplicate-alias path below already applies the same identical-content rule.)
      const [copy, orig] = await Promise.all([
        vault.readFileRetry(f.path).catch(() => null),
        vault.readFileRetry(f.related!).catch(() => null),
      ]);
      if (copy != null && orig != null && norm(copy) === norm(orig)) {
        groups.push({ name: f.path.split('/').pop()!, kind: 'sync', keep: f.related, remove: [f.path], bytes: await statSize(f.path) });
      } else {
        diverged.push(f.path);
      }
    }
  }
  for (const f of report.findings) {
    if (f.kind !== 'duplicate-alias' || !f.paths || f.paths.length < 2) continue;
    // group the colliding notes by NORMALISED content; only identical files are
    // safe to treat as redundant copies (distinct notes sharing a name are a
    // human/AI call, handled by the "copy AI prompt" path in the UI).
    const byContent = new Map<string, string[]>();
    for (const p of f.paths) {
      const c = (await vault.readFileRetry(p).catch(() => '')).replace(/\r\n/g, '\n').trim();
      // Never treat empty/near-empty stubs as "the same file" — two DISTINCT notes
      // that merely happen to be blank must not be auto-merged into one deletion.
      if (c.length < 20) continue;
      if (!byContent.has(c)) byContent.set(c, []);
      byContent.get(c)!.push(p);
    }
    for (const group of byContent.values()) {
      if (group.length < 2) continue;
      const keep = pickCanonical(group);
      const remove = group.filter((p) => p !== keep);
      let bytes = 0; for (const p of remove) bytes += await statSize(p);
      groups.push({ name: keep.split('/').pop()!, kind: 'dup', keep, remove, bytes });
    }
  }
  // diverged is a SYNC-conflict concept — don't leak the "kept copies" note into the duplicate-
  // cleanup ('dup') panel, which is a separate flow.
  return { groups: kind ? groups.filter((g) => g.kind === kind) : groups, diverged: !kind || kind === 'sync' ? diverged : [] };
}
async function handleCleanupPreview(res: http.ServerResponse, kind?: string | null) {
  if (!brainPath) return send(res, 400, { error: 'Connect a brain first.' });
  const { groups, diverged } = await computeCleanupPlan(Vault.open(brainPath), kind);
  send(res, 200, {
    groups: groups.slice(0, 60),
    files: groups.reduce((s, g) => s + g.remove.length, 0),
    bytes: groups.reduce((s, g) => s + g.bytes, 0),
    // conflict copies that DIVERGED from their original — reported, never auto-deleted, so the owner
    // can merge/keep them by hand instead of losing edits.
    diverged,
  });
}
async function handleCleanupApply(res: http.ServerResponse, kind?: string | null) {
  if (!brainPath) return send(res, 400, { error: 'Connect a brain first.' });
  const { groups } = await computeCleanupPlan(Vault.open(brainPath), kind);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(os.homedir(), '.callosium', 'backups', `cleanup-${stamp}`);
  let removed = 0;
  for (const g of groups) for (const rel of g.remove) {
    try {
      const src = path.join(brainPath, rel);
      const bpath = path.join(backupDir, rel);
      await fs.mkdir(path.dirname(bpath), { recursive: true });
      await fs.copyFile(src, bpath); // snapshot BEFORE removing — fully reversible
      await fs.unlink(src);
      removed++;
    } catch { /* already gone or locked — skip */ }
  }
  dropCache();
  send(res, 200, { ok: true, removed, backup: removed ? backupDir : null });
}

// ── NOTES: browse + read ──
async function handleNotes(res: http.ServerResponse, prefix: string, limit: number) {
  if (!brainPath) return send(res, 200, { items: [] });
  const { texts } = await loadAll();
  // Wall clock, not the vault's newest mtime. Anchoring "ago" to the newest mtime
  // made that comparison self-referential: the most recently edited note always
  // reads "just now" and every other note is dated RELATIVE TO IT, so a brain last
  // touched a month ago showed "just now / 2m ago / 5m ago" instead of the truth.
  // max() with the newest mtime only to absorb a future-dated note (clock skew on a
  // synced drive), exactly as the Activity feed does.
  const now = Math.max(Date.now(), maxMtime(texts.mtimes) || 0);
  // Hide managed System/ files (Map.md, dismissed.json) from the Notes browser —
  // they aren't user notes; only surface them if the user explicitly browses System/.
  const base = texts.files.filter((f) => prefix.startsWith('System/') || !f.startsWith('System/'));
  const items = base
    .filter((f) => !prefix || f.startsWith(prefix))
    .sort((a, b) => (texts.mtimes.get(b) ?? 0) - (texts.mtimes.get(a) ?? 0))
    .slice(0, limit)
    .map((f) => ({ path: f, name: f.split('/').pop()!.replace(/\.md$/, ''), partition: partitionOf(f), ago: relTime(texts.mtimes.get(f) ?? 0, now) }));
  send(res, 200, { items, total: base.length });
}
async function handleNote(res: http.ServerResponse, notePath: string) {
  if (!brainPath) return send(res, 400, { error: 'Connect a brain first.' });
  const { texts } = await loadAll();
  const raw = texts.texts.get(notePath);
  if (raw == null) return send(res, 404, { error: 'No such note.' });
  // Return the FULL note. It used to be sliced to 60k chars, but the editor
  // saves back exactly what it loaded — so a truncated read meant a save
  // permanently destroyed everything past 60k in a long note. Correctness over
  // payload size; this is the user's own file over loopback.
  // baseHash lets the save do a compare-and-swap: the client echoes it back and
  // the save refuses if the note's content changed on disk in the meantime.
  send(res, 200, { path: notePath, content: raw, baseHash: Vault.contentHash(raw) });
}

// ── ASK: personalized starter questions built from the REAL brain (not canned) —
// most-connected entities + most-recently-touched notes, phrased by partition. ──
async function handleSuggestions(res: http.ServerResponse) {
  if (!brainPath) return send(res, 200, { suggestions: [] });
  const { texts, graph } = await loadAll();
  const nonRaw = (f: string) => !/(^|\/)Raw\//i.test(f) && !f.startsWith('Templates/') && !f.startsWith('System/') && !/\.excalidraw/.test(f);
  const files = texts.files.filter(nonRaw);
  const base = (p: string) => p.split('/').pop()!.replace(/\.md$/, '');
  // graph degree → which notes are real hubs (people/projects the user cares about)
  const deg = new Map<string, number>();
  for (const e of graph.edges) { if (e.unresolved) continue; deg.set(e.to, (deg.get(e.to) || 0) + 1); deg.set(e.from, (deg.get(e.from) || 0) + 1); }
  const isEntity = (p: string) => /^(People|Initiatives|Ventures|Knowledge|Agents and Systems|Work[^/]*)\//.test(p) && p.split('/').length <= 3;
  const entities = files.filter(isEntity).sort((a, b) => (deg.get(b) || 0) - (deg.get(a) || 0));
  const recent = [...files].sort((a, b) => (texts.mtimes.get(b) || 0) - (texts.mtimes.get(a) || 0));
  // phrase a question by the note's partition so it reads naturally
  const ask = (p: string) => {
    const b = base(p), top = p.split('/')[0];
    if (/People/i.test(top)) return `what's my history with ${b}?`;
    if (/Knowledge/i.test(top)) return `what do I know about ${b}?`;
    if (/Ventures|Initiatives|Work/i.test(top)) return `what did I decide about ${b}?`;
    if (/Logs|Memory/i.test(top)) return `what happened around ${b}?`;
    return `what's in ${b}?`;
  };
  const out: string[] = [];
  const push = (q: string | undefined) => { if (q && out.length < 4 && !out.includes(q)) out.push(q); };
  if (entities[0]) push(ask(entities[0]));
  if (recent[0]) push(`what's the latest on ${base(recent[0])}?`);
  if (entities[1]) push(ask(entities[1]));
  if (recent[1] && recent[1] !== recent[0]) push(ask(recent[1]));
  if (entities[2]) push(ask(entities[2]));
  // generic fallbacks so a brand-new/sparse brain still gets prompts
  ['what are my goals right now?', 'what did I decide this week?', 'what should I follow up on?'].forEach(push);
  send(res, 200, { suggestions: out.slice(0, 4) });
}

// Serialize note saves ACROSS requests. vault.withLock now mutexes individual
// writes cross-instance, but a save is a baseHash-read → compare-and-swap → write
// SPAN — so two concurrent saves to the same note must be serialized as a whole
// (else both read the same baseHash, both pass the CAS, and the second clobbers
// the first). A module-level chain keyed by canonical path does that; a racing
// MCP/external writer is caught by the CAS itself (baseHash mismatch → 409).
const noteSaveChains = new Map<string, Promise<unknown>>();
async function withNoteSaveLock<T>(rel: string, fn: () => Promise<T>): Promise<T> {
  const key = process.platform === 'linux' ? rel : rel.toLowerCase();
  const prev = noteSaveChains.get(key) ?? Promise.resolve();
  let result: T;
  const run = prev.catch(() => {}).then(async () => { result = await fn(); });
  noteSaveChains.set(key, run);
  try {
    await run;
  } finally {
    if (noteSaveChains.get(key) === run) noteSaveChains.delete(key);
  }
  return result!;
}

// Owner edits a note from the cockpit. Only an existing markdown note in the
// brain (the traversal guard + atomic rename live in Vault). The owner is
// unscoped here — the dashboard IS their machine — but we still refuse anything
// that isn't a real note we already indexed.
async function handleSaveNote(res: http.ServerResponse, body: Json) {
  if (!brainPath) return send(res, 400, { error: 'Connect a brain first.' });
  const notePath = typeof body.path === 'string' ? body.path : '';
  const content = typeof body.content === 'string' ? body.content : null;
  if (!notePath || content == null) return send(res, 400, { error: 'Need a note path and content.' });
  const { texts } = await loadAll();
  if (!texts.texts.has(notePath)) return send(res, 404, { error: 'No such note.' });
  // Save cap aligned with the uncapped read + the 16MB body limit, so any note
  // the cockpit can OPEN it can also SAVE (a lower cap stranded edits to large
  // notes at a 413). 12M chars stays comfortably under MAX_BODY after JSON escaping.
  if (content.length > 12_000_000) return send(res, 413, { error: 'Note too large.' });
  // Compare-and-swap: the editor sends the baseHash it loaded from. If the note's
  // content on disk no longer hashes to that — an MCP agent, Obsidian, or a sync
  // client wrote it while the owner had it open — refuse rather than silently
  // clobber their change (a lost update). The whole read→compare→write runs under
  // the per-note lock so a racing dashboard save can't slip in between. NFC-match
  // how the note was served, so a decomposed/precomposed round-trip isn't a false
  // conflict; a mtime touch (OneDrive metadata sync, no content change) isn't one
  // either. Omitted baseHash (new-note flow / old client) skips the check.
  const baseHash = typeof body.baseHash === 'string' ? body.baseHash : null;
  try {
    const result = await withNoteSaveLock(notePath, async () => {
      const v = Vault.open(brainPath!);
      if (baseHash) {
        let onDisk: string | null = null;
        try { onDisk = (await v.readFileRetry(notePath)).normalize('NFC'); } catch { onDisk = null; }
        if (onDisk === null || Vault.contentHash(onDisk) !== baseHash) return 'conflict' as const;
      }
      await v.writeFile(notePath, content);
      // Snapshot the owner's edit NOW, labelled 'owner'. Without this the next loadAll's
      // captureExternal would see on-disk bytes differ from HEAD and commit the change as
      // 'external' — mislabelling a deliberate in-cockpit edit as an outside-Callosium one.
      await snapshotNote(brainPath!, historyBrainId(), notePath, 'owner').catch(() => {});
      void logAction(historyBrainId(), { agentId: 'owner', agent: 'You', action: 'write', path: notePath }).catch(() => {});
      return 'ok' as const;
    });
    if (result === 'conflict') {
      return send(res, 409, { error: 'This note changed on disk since you opened it — reload to see the new version before saving, so you don’t overwrite it.', conflict: true });
    }
    dropCache();
    send(res, 200, { ok: true, path: notePath });
  } catch (err) {
    send(res, 400, { error: (err as Error).message });
  }
}

// ── VERSION HISTORY (M1 external-write safety net) ──────────────────────────
// Per-note timeline; a version's diff vs the current note; a restore that writes an old version
// back through the safe path (snapshotting current first so the restore is itself undoable); and
// the latest batch of edits made OUTSIDE Callosium for the Activity feed / destructive alert.
function historyBrainId(): string {
  return Vault.contentHash(Vault.open(brainPath!).root.toLowerCase());
}
async function handleHistoryList(res: http.ServerResponse, notePath: string) {
  if (!brainPath) return send(res, 400, { error: 'Connect a brain first.' });
  if (!notePath) return send(res, 400, { error: 'Need a note path.' });
  const versions = await listVersions(brainPath, historyBrainId(), notePath).catch(() => []);
  send(res, 200, { path: notePath, versions });
}
async function handleHistoryDiff(res: http.ServerResponse, notePath: string, oid: string) {
  if (!brainPath) return send(res, 400, { error: 'Connect a brain first.' });
  if (!notePath || !oid) return send(res, 400, { error: 'Need a note path and version.' });
  const v = Vault.open(brainPath);
  // Constrain to a REAL indexed note before reading, exactly as handleNote does.
  // Vault containment alone is not enough here: it permits any file inside the
  // brain, so a crafted path turned this endpoint into an arbitrary in-vault read
  // and `System/agents.json` came back with every paired agent's plaintext bearer
  // token in the diff. The index only ever contains .md notes, so membership is
  // both the right semantic check (you can only diff something that has versions)
  // and the security boundary. A note that has since been DELETED is still
  // diffable — it just falls through to the empty-`after` path below, which is the
  // intended "restore a deleted note" flow.
  const { texts } = await loadAll();
  const known = texts.texts.has(notePath);
  const before = (await readVersion(brainPath, historyBrainId(), notePath, oid).catch(() => null)) ?? '';
  if (!known && !before) return send(res, 404, { error: 'No such note.' });
  let after = '';
  try {
    if (known) after = await v.readFileRetry(notePath);
  } catch {
    /* note may be gone now — diff against empty */
  }
  send(res, 200, { path: notePath, oid, diff: lineDiff(before, after) });
}
async function handleHistoryRestore(res: http.ServerResponse, body: Json) {
  if (!brainPath) return send(res, 400, { error: 'Connect a brain first.' });
  const notePath = typeof body.path === 'string' ? body.path : '';
  const oid = typeof body.oid === 'string' ? body.oid : '';
  if (!notePath || !oid) return send(res, 400, { error: 'Need a note path and version.' });
  const brainId = historyBrainId();
  const content = await readVersion(brainPath, brainId, notePath, oid).catch(() => null);
  if (content == null) return send(res, 404, { error: 'That version is no longer available.' });
  try {
    await withNoteSaveLock(notePath, async () => {
      const v = Vault.open(brainPath!);
      await snapshotNote(brainPath!, brainId, notePath, 'owner (pre-restore)').catch(() => {}); // current state → undoable
      await v.writeFile(notePath, content);
      await snapshotNote(brainPath!, brainId, notePath, 'owner (restore)').catch(() => {});
    });
    dropCache();
    send(res, 200, { ok: true, path: notePath });
  } catch (err) {
    send(res, 400, { error: (err as Error).message });
  }
}
function handleHistoryExternal(res: http.ServerResponse) {
  send(res, 200, { edits: lastExternalEdits });
}

// ── AGENTS: full list with scopes; edit scope; revoke ──
async function handleAgents(res: http.ServerResponse) {
  if (!brainPath) return send(res, 200, { agents: [], partitions: [] });
  const vault = Vault.open(brainPath);
  const reg = await loadAgents(vault).catch(() => ({ agents: [] }));
  const { texts } = await loadAll();
  // scopable folders only — '(root)' files can't be folder-scoped
  const partitions = [...new Set(texts.files.map(partitionOf))].filter((p) => p !== '(root)').sort();
  send(res, 200, {
    agents: reg.agents.map((a) => ({ id: a.id, displayName: a.displayName, pairedAt: a.pairedAt, scopes: a.scopes })),
    partitions,
  });
}
async function handleScope(res: http.ServerResponse, body: Json) {
  if (!brainPath) return send(res, 400, { error: 'Connect a brain first.' });
  const s = body.scopes;
  if (typeof s !== 'object' || s === null) return send(res, 400, { error: 'scopes must be an object.' });
  // coerce each field to a clean string[] — never persist a malformed scope
  // (a string in .read would crash the MCP process's canRead on next call).
  const arr = (x: unknown) => (Array.isArray(x) ? x.filter((v) => typeof v === 'string') : []);
  const sc = s as Record<string, unknown>;
  const newScopes = { read: arr(sc.read), denyRead: arr(sc.denyRead), write: arr(sc.write) };
  const vault = Vault.open(brainPath);
  // Read-modify-write UNDER the registry lock so a concurrent revoke/scope on
  // another tab can't clobber this change with a stale snapshot.
  let found = false;
  await updateAgents(vault, (reg) => {
    const ag = reg.agents.find((a) => a.id === body.id);
    if (!ag) return;
    ag.scopes = newScopes;
    found = true;
  });
  if (!found) return send(res, 404, { error: 'No such agent.' });
  // no dropCache: texts/graph/emb don't depend on the agent registry.
  send(res, 200, { ok: true, scopes: newScopes });
}
async function handleRevoke(res: http.ServerResponse, body: Json) {
  if (!brainPath) return send(res, 400, { error: 'Connect a brain first.' });
  const vault = Vault.open(brainPath);
  let removed = false;
  await updateAgents(vault, (reg) => {
    const before = reg.agents.length;
    reg.agents = reg.agents.filter((a) => a.id !== body.id);
    removed = reg.agents.length !== before;
  });
  if (!removed) return send(res, 404, { error: 'No such agent.' });
  send(res, 200, { ok: true });
}

// ── ASSETS: the bundled brain art / logomark, served locally (offline-first) ──
async function handleAsset(res: http.ServerResponse, name: string) {
  // allow-list only — never resolve arbitrary paths
  const allow: Record<string, string> = {
    'brain.png': 'image/png',
    'logomark.png': 'image/png',
    // vendored Supabase auth SDK (pinned) — served locally so login needs no third-party CDN
    'vendor/supabase.js': 'text/javascript',
  };
  // self-hosted dashboard fonts: only woff2 files directly under fonts/ (no traversal)
  const ctype = allow[name] ?? (/^fonts\/[a-z0-9-]+\.woff2$/.test(name) ? 'font/woff2' : undefined)
    // cursor PNGs: the named COIN OP set only, 1x and @2x (the CSS runs on data-URIs; these are for reuse)
    ?? (/^cursors\/(?:pointer|link|ibeam|ibeam-text|busy|disabled|resize-h|resize-v)(?:@2x)?\.png$/.test(name) ? 'image/png' : undefined);
  if (!ctype) return send(res, 404, { error: 'not found' });
  try {
    const buf = await fs.readFile(path.join(ASSETS_DIR, name));
    res.writeHead(200, { 'content-type': ctype, 'cache-control': 'public, max-age=86400', 'content-length': buf.length });
    res.end(buf);
  } catch {
    send(res, 404, { error: 'not found' });
  }
}

// ── OPEN FOLDER: reveal the brain in the OS file explorer (the "open folder"
// button — a web page can't summon a native picker, but the local server can
// open the folder the user already chose). ──
async function handleOpenFolder(res: http.ServerResponse, body: Json) {
  const target = typeof body.path === 'string' && body.path ? body.path : brainPath;
  if (!target) return send(res, 400, { error: 'No folder to open.' });
  // only open the connected brain or a folder the picker surfaced this session
  if (target !== brainPath && !browsedPaths.has(target)) return send(res, 403, { error: 'That folder is not open in this session.' });
  if (!existsSync(target)) return send(res, 404, { error: 'That folder no longer exists.' });
  try {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
    const child = spawn(cmd, [target], { stdio: 'ignore', detached: true });
    // A spawn failure (ENOENT/PATH stripped) is an ASYNC 'error' event — without
    // a listener Node re-throws it uncaught next tick and kills the whole server.
    child.on('error', (e) => console.error('open-folder failed:', e.message));
    child.unref();
    send(res, 200, { ok: true });
  } catch (err) {
    send(res, 400, { error: (err as Error).message });
  }
}

// ── EXPORT: zip the whole brain and stream it as a download. The vault is the
// user's own plain files — this is a portable copy, made with the OS zipper so
// there's no dependency to bundle. ──
async function handleExport(_req: http.IncomingMessage, res: http.ServerResponse) {
  if (!brainPath) return send(res, 400, { error: 'Connect a brain first.' });
  await fs.mkdir(APP_DIR, { recursive: true });
  // Server-side unique temp name (never derived from client input) so concurrent
  // exports can't collide on the same file mid-write/read.
  const zipPath = path.join(APP_DIR, `callosium-brain-${randomUUID()}.zip`);
  const run = (cmd: string, args: string[], cwd?: string, okCodes: number[] = [0]) =>
    new Promise<void>((resolve, reject) => {
      const p = spawn(cmd, args, { stdio: 'ignore', cwd });
      p.on('error', reject);
      p.on('close', (code) => (okCodes.includes(code ?? -1) ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
    });
  // The token registry (System/agents.json) must NEVER leave in a shareable
  // export — it holds every paired agent's plaintext auth token. We zip the
  // whole vault, then delete just that one entry from the archive (cheap, keeps
  // the folder hierarchy + System/brain.json config, no full-tree copy). If the
  // delete step fails we abort rather than serve a zip that still leaks it.
  try {
    if (process.platform === 'win32') {
      const bp = brainPath.replace(/'/g, "''");
      const zp = zipPath.replace(/'/g, "''");
      // Compress-Archive walks the pipeline file-by-file and is pathologically slow
      // on a real brain (thousands of notes + attachments → minutes, which reads as
      // "stuck"). CreateFromDirectory is a single native call — seconds, not minutes.
      // includeBaseDirectory=$false → entries are vault-relative (System/agents.json,
      // Knowledge/…), which the token-scrub step below matches exactly. Fastest, not
      // Optimal: a real brain is dominated by already-compressed attachments (images,
      // PDFs) that don't shrink either way, so Optimal only burns CPU on them — the
      // small markdown portion barely differs. Prioritize a quick export.
      await run('powershell', ['-NoProfile', '-Command',
        `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory('${bp}','${zp}',[System.IO.Compression.CompressionLevel]::Fastest,$false)`]);
    } else {
      // exit 12 = "nothing to do" (an empty vault) — not a failure; let the
      // no-zip branch below return the friendly message instead of a 500.
      await run('zip', ['-r', '-q', zipPath, '.'], brainPath, [0, 12]);
    }
    // Empty brain (brand-new, no files): Compress-Archive writes nothing yet
    // exits 0, so the zip may not exist. Fail gracefully instead of a raw ENOENT.
    if (!existsSync(zipPath)) {
      return send(res, 200, { error: 'That brain has no files to export yet.' });
    }
    // ALWAYS strip the token registry from the archive — never gate on a pre-zip
    // existence check: an agent could pair in the window between that check and the
    // zip, slipping its live token in (TOCTOU). This must catch NOT ONLY
    // System/agents.json but its atomic-write sibling System/agents.json.tmp-<pid>-<seq>:
    // an interrupted pair/scope/rotate write (crash, kill, or a OneDrive/AV lock that
    // fails the rename-retry AND the cleanup rm) orphans that temp on disk holding the
    // FULL registry — same plaintext tokens — and the raw-tree zip walk would ship it.
    // So we drop agents.json, any agents.json.tmp-* sibling, and every atomic temp
    // (.tmp-<digits>, never legitimate content), then VERIFY no agents.json* entry
    // survives rather than trusting the exit code.
    if (process.platform === 'win32') {
      const zp = zipPath.replace(/'/g, "''");
      // .NET zip 'Update' mode; iterate a COPY of Entries since Delete() mutates it.
      // Match both '/' and '\' separators (PS 5.1 wrote backslashes). Count any
      // agents.json* survivor BEFORE Dispose and exit 1 if one remains.
      await run('powershell', ['-NoProfile', '-Command',
        `Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[System.IO.Compression.ZipFile]::Open('${zp}','Update'); @($z.Entries) | Where-Object { $n=($_.FullName -replace '\\\\','/'); $n -eq 'System/agents.json' -or $n -match '^System/agents\\.json\\.tmp-\\d+-\\d+$' } | ForEach-Object { $_.Delete() }; $left=@($z.Entries | Where-Object { ($_.FullName -replace '\\\\','/') -like 'System/agents.json*' }).Count; $z.Dispose(); if($left -gt 0){ exit 1 }`]);
    } else {
      // exit 0 = deleted, 12 = "nothing to do" (pattern matched nothing) — both mean
      // it's not in the zip; any other code is a real failure. Patterns are passed to
      // zip literally (spawn without a shell), so zip does the glob matching itself.
      await run('zip', ['-d', zipPath, 'System/agents.json', 'System/agents.json.tmp-*'], undefined, [0, 12]);
    }
    // Stream the zip rather than buffering it — a large attachment-heavy vault
    // can produce a multi-hundred-MB archive that would OOM a readFile.
    const stat = await fs.stat(zipPath);
    res.writeHead(200, {
      'content-type': 'application/zip',
      'content-disposition': 'attachment; filename="callosium-brain.zip"',
      'content-length': stat.size,
    });
    const stream = createReadStream(zipPath);
    const cleanup = () => { fs.rm(zipPath, { force: true }).catch(() => {}); };
    stream.on('error', () => { res.destroy(); cleanup(); });
    stream.on('close', cleanup);
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  } catch (err) {
    await fs.rm(zipPath, { force: true }).catch(() => {});
    send(res, 500, { error: `Export failed: ${(err as Error).message}. You can also use "open folder" and copy it yourself.` });
  }
}

// ── UPDATE CHECK: compare our version against main on GitHub (raw package.json).
// The shipped desktop app will do this via the Tauri updater; here it's an
// honest version compare so Settings can surface "update available". ──
const REPO_RAW = 'https://raw.githubusercontent.com/callosium/callosium/main/package.json';
function semverGt(a: string, b: string): boolean {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}
async function handleUpdateCheck(res: http.ServerResponse) {
  try {
    const r = await fetch(REPO_RAW, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) throw new Error(`GitHub returned ${r.status}`);
    const remote = JSON.parse(await r.text());
    const latest = String(remote.version || '');
    send(res, 200, { current: APP_VERSION, latest, updateAvailable: !!latest && semverGt(latest, APP_VERSION), channel: 'main' });
  } catch (err) {
    // offline or unreachable — honest, not a hard failure
    send(res, 200, { current: APP_VERSION, latest: null, updateAvailable: false, offline: true, note: (err as Error).message });
  }
}

// ── ACCOUNT: a LOCAL sign-in record (dummy social sign-up until the real
// auth/subscription backend exists). No password, no email round-trip — just a
// stored identity + plan so the app can gate free vs paid later. ──
interface Account { provider: string; name: string; email?: string; plan: 'free' | 'paid'; createdAt: string; }
async function readAccount(): Promise<Account | null> {
  try {
    return JSON.parse(await fs.readFile(ACCOUNT_FILE, 'utf8')) as Account;
  } catch {
    return null;
  }
}
async function handleAccount(res: http.ServerResponse) {
  send(res, 200, { account: await readAccount() });
}
async function handleSignup(res: http.ServerResponse, body: Json) {
  const provider = typeof body.provider === 'string' ? body.provider : 'guest';
  const name = (typeof body.name === 'string' && body.name.trim()) || 'You';
  const email = typeof body.email === 'string' ? body.email : undefined;
  if (!['google', 'apple', 'github', 'email', 'guest'].includes(provider)) return send(res, 400, { error: 'Unknown provider.' });
  const account: Account = { provider, name: name.slice(0, 80), email, plan: 'free', createdAt: new Date().toISOString() };
  try {
    await fs.mkdir(APP_DIR, { recursive: true });
    // atomic: temp + rename so a crash mid-write can't leave a truncated file
    // that readAccount() would silently discard.
    const tmp = ACCOUNT_FILE + '.tmp-' + randomUUID();
    await fs.writeFile(tmp, JSON.stringify(account, null, 2), 'utf8');
    await fs.rename(tmp, ACCOUNT_FILE);
    send(res, 200, { account });
  } catch (err) {
    send(res, 500, { error: (err as Error).message });
  }
}
async function handleSignout(res: http.ServerResponse) {
  // Never claim a sign-out we didn't perform. The old `.catch(() => {})` + a
  // hard-coded {ok:true} meant an EPERM/EBUSY on the delete (an AV scanner or
  // the search indexer holding account.json — an ordinary Windows condition)
  // still answered "signed out". The client deliberately only reloads on a
  // CONFIRMED success (render-settings.js st_signOut), so that lie sent the user
  // straight back into the signed-in dashboard, same name, no error anywhere.
  // The existsSync re-check covers the other half: a `rm` that resolves while
  // the record survives (a delete-pending handle) is still a failed sign-out.
  // force:true keeps "already signed out" a success — ENOENT never rejects.
  try {
    await fs.rm(ACCOUNT_FILE, { force: true });
    if (existsSync(ACCOUNT_FILE)) throw new Error('the account record is still on disk');
  } catch {
    return send(res, 500, { error: 'Could not remove the local account record — a file lock may be holding it. Try again.' });
  }
  send(res, 200, { ok: true });
}

// ── INIT: turn a chosen folder into a Callosium brain (the "create a brain"
// onboarding path). Writes the default schema + the core partition folders so
// the connected AI has a structure to file into, then connects it as the brain.
async function handleInit(res: http.ServerResponse, body: Json) {
  const dir = typeof body.path === 'string' ? body.path : '';
  if (!dir) return send(res, 400, { error: 'Pick a folder first.' });
  if (!browsedPaths.has(dir)) return send(res, 403, { error: 'Choose the folder in the picker first.' });
  try {
    await fs.mkdir(dir, { recursive: true });
    const vault = Vault.open(dir);
    // schema: copy the packaged default unless the folder already has one
    if (!vault.exists('System/brain.json')) {
      const def = await fs.readFile(path.join(HERE, '..', '..', 'schema', 'default-brain.json'), 'utf8');
      await vault.writeFile('System/brain.json', def);
    }
    // scaffold the core partition folders — collect (don't swallow) failures so
    // the onboarding UI can warn instead of silently claiming all were created.
    const { schema } = await loadSchema(vault);
    const failed: string[] = [];
    for (const p of schema.partitions.core) {
      try {
        await fs.mkdir(path.join(dir, p.path), { recursive: true });
      } catch {
        failed.push(p.path);
      }
    }
    setBrain(dir); // resets every brain-scoped cache atomically (no separate dropCache needed)
    send(res, 200, { ok: true, path: dir, partitions: schema.partitions.core.map((p) => p.path), failed });
  } catch (err) {
    send(res, 400, { error: (err as Error).message });
  }
}

export async function serveDashboard(opts: { port?: number; brain?: string; mcpPort?: number } = {}): Promise<ServerHandle> {
  const port = opts.port ?? 4319;
  const mcpPort = opts.mcpPort ?? 4321; // serveHttp's default; overridable for tests / a second instance
  mcpStatus = { live: false, error: 'starting' };

  // Connect the brain: an explicit --brain wins and is remembered for next time;
  // otherwise reconnect the last brain we served (persisted config), so a plain
  // restart never lands on a disconnected "couldn't reach your brain" screen. A
  // remembered brain that no longer exists on disk falls through to onboarding.
  if (opts.brain && existsSync(opts.brain)) {
    setBrain(opts.brain);
  } else {
    const remembered = loadPersistedBrain();
    if (remembered && existsSync(remembered)) brainPath = remembered;
  }

  // Auto-start the MCP endpoint over loopback HTTP (:4321/mcp) alongside the
  // dashboard, so URL+token clients — ChatGPT (via a tunnel), Kimi, and any
  // "Streamable HTTP" connector — work the MOMENT Callosium is open, with no
  // separate `callosium mcp --http` terminal. Loopback-only + bearer auth, same
  // as the manual command. Best-effort and fire-and-forget: a bind failure (e.g.
  // the user already ran `mcp --http`, or the port is taken) is logged and MUST
  // NOT stop the dashboard from coming up. Started UNCONDITIONALLY with a live
  // getter so it (a) follows a mid-session brain switch, and (b) is already up
  // during fresh onboarding (it answers 503 until a brain is connected, then
  // serves it) — no relaunch needed. It reads the brain through OUR cache
  // (mcpBrainSource) rather than loading a second copy of it into this process.
  // Keep the handle so closing the dashboard also closes the endpoint it started.
  // Leaving it listening after the cockpit is gone would hold the port (the next
  // start would log a bind failure and silently run without an MCP endpoint) and
  // keep the event loop alive.
  let mcpHandle: { close(): Promise<void> } | null = null;
  serveHttp({ getBrain: () => brainPath, brain: mcpBrainSource(), port: mcpPort })
    .then((h) => {
      mcpHandle = h;
      mcpStatus = { live: true };
      console.error(`callosium: MCP endpoint live at http://127.0.0.1:${mcpPort}/mcp (bearer-token auth) — for a public HTTPS URL, front it with a tunnel`);
    })
    .catch((e) => {
      // console.error is not a way to tell anyone anything here: the desktop app runs as a
      // windows_subsystem="windows" process with no console, and over MCP stdio this stream is the
      // protocol. So the failure was invisible while the Agents screen went on printing this exact
      // URL and a token for it — the user copies a config for an endpoint that was never listening.
      // The usual cause is a previous Callosium that outlived its window and still holds the port,
      // which is worse than it sounds: the agents then talk to THAT instance's brain, not this one.
      mcpStatus = { live: false, error: (e as Error).message };
      console.error(`callosium: MCP HTTP endpoint not auto-started (${(e as Error).message}); run 'callosium mcp --http' if you need URL+token clients`);
    });

  // Reject any request that a browser marks as (or reveals via Origin/Referer to
  // be) cross-origin. The dashboard has no auth beyond loopback binding, so
  // without this ANY web page the user visits while it runs could forge calls to
  // it (DNS-rebinding / CSRF) — mutating scopes, revoking agents, or triggering
  // the ingest DoS. Same-origin fetches from our own UI send Sec-Fetch-Site:
  // same-origin (or a matching Origin/Referer); a direct address-bar navigation
  // sends Sec-Fetch-Site: none and no Origin — both pass.
  const allowedOrigins = new Set([`http://localhost:${port}`, `http://127.0.0.1:${port}`]);
  const allowedHosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]);
  const originOk = (req: http.IncomingMessage): boolean => {
    // DNS-rebinding defense: the Host header must be a loopback name we serve.
    // After a rebind, evil.com:PORT is "same-origin" so Sec-Fetch/Origin/Referer
    // all pass — only a Host allow-list stops the attacker page reading responses.
    const host = req.headers.host;
    if (typeof host !== 'string' || !allowedHosts.has(host)) return false;
    const site = req.headers['sec-fetch-site'];
    if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return false;
    const origin = req.headers.origin;
    if (typeof origin === 'string' && origin && !allowedOrigins.has(origin)) return false;
    const referer = req.headers.referer;
    if (typeof referer === 'string' && referer) {
      try {
        const u = new URL(referer);
        if (!((u.hostname === 'localhost' || u.hostname === '127.0.0.1') && u.port === String(port))) return false;
      } catch {
        return false;
      }
    }
    return true;
  };
  // State-changing routes must be POST — closes the cross-site <img>/<script> GET
  // forgery vector (those can't be POSTs). /api/ingest is a GET (EventSource/SSE)
  // and is protected by the origin guard plus the browsedPaths allow-list above.
  // /api/export is here too: it triggers a whole-vault zip (resource-intensive),
  // so a bare cross-site <img src>/GET must not be able to fire it. The UI issues
  // it as a hidden form POST, which still streams to disk (unlike fetch+blob,
  // which would buffer the whole archive in browser memory).
  const postOnly = new Set(['/api/scope', '/api/revoke', '/api/pair', '/api/rotate', '/api/rename', '/api/browse', '/api/inspect', '/api/note/save', '/api/open-folder', '/api/signup', '/api/signout', '/api/init', '/api/export', '/api/link/preview', '/api/link/apply', '/api/cleanup/preview', '/api/cleanup/apply', '/api/health/dismiss', '/api/health/undismiss', '/api/history/restore']);

  // Per-launch caller token (P2 #13): defense-in-depth on top of the origin guard.
  // Minted fresh each launch, embedded in the served HTML (a <meta>), and echoed
  // back by our UI on every /api/ call. It gates all /api/ routes; the HTML itself,
  // /assets, and the desktop /__health handshake are exempt (they must work before
  // any token exists). Constant-time compared.
  //   What it ADDS: a browser page on another origin that somehow reaches /api/
  //   (a future origin-guard gap, a rebind) still cannot forge a valid call —
  //   the same-origin policy stops it from READING the token out of our `/` HTML,
  //   so it can't supply x-callosium-token. That is the real value.
  //   What it does NOT do: stop a NON-browser local process. Such a process can
  //   simply GET `/` (exempt, unauthenticated), scrape the <meta> token, and
  //   replay it — the token is not a secret from anything that can read our HTTP
  //   responses. That threat is out of scope here (a local process already has
  //   filesystem read of the plaintext vault); the origin guard, not this token,
  //   is the browser-CSRF control. Don't over-trust it.
  const callerToken = randomBytes(32).toString('hex');
  const callerTokenBuf = Buffer.from(callerToken);
  const tokenOk = (req: http.IncomingMessage, url: URL): boolean => {
    const h = req.headers['x-callosium-token'];
    // EventSource (SSE, /api/ingest) cannot set headers, so it carries the token
    // as a query param; it is a per-launch loopback secret, never a durable
    // credential, and never leaves the machine.
    const provided = (typeof h === 'string' ? h : '') || url.searchParams.get('token') || '';
    const buf = Buffer.from(provided);
    return buf.length === callerTokenBuf.length && timingSafeEqual(buf, callerTokenBuf);
  };

  const server = http.createServer(async (req, res) => {
    wrapCompression(req, res);
    const url = new URL(req.url || '/', `http://localhost:${port}`);
    try {
      // Desktop shell handshake: the native Tauri app passes a per-launch token via env and probes
      // this endpoint to confirm THIS process — not some other listener that grabbed the (now
      // OS-assigned) port — is its server before it navigates the window to it. No side effects,
      // loopback-only, so it runs before the origin guard; echoes the token only when one is set.
      if (req.method === 'GET' && url.pathname === '/__health') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        return res.end(JSON.stringify({ ok: true, token: process.env.CALLOSIUM_DESKTOP_TOKEN || '' }));
      }
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        const rawHtml = await fs.readFile(UI_HTML, 'utf8');
        // Embed the per-launch caller token so our own JS (and only code that
        // loaded THIS page) can echo it on every /api/ call. Injected at serve
        // time — never written into the source ui.html — right after <head>.
        const html = rawHtml.replace(/<head(\s[^>]*)?>/i, (m) => `${m}<meta name="cct" content="${callerToken}">`);
        // The app HTML is rebuilt in place during development and updated on every
        // release, so it must NEVER be served from the browser cache — otherwise a
        // reload shows the stale page ("nothing changed"). Always revalidate.
        // Content-Security-Policy — enforce "offline except login" at the browser level.
        // default-src 'self' means NOTHING loads from a third party. script-src stays 'self'
        // (the Supabase SDK is vendored under /assets/vendor, no CDN) plus 'unsafe-inline'
        // because the app is a single vanilla-JS SPA built on inline <script> blocks and inline
        // on* handler attributes (which nonces/hashes can't cover); external scripts are still
        // blocked, which is the point. connect-src is the egress control: 'self' (the local API)
        // + the Supabase auth host ONLY — that is the single permitted network call, and it only
        // fires on an actual sign-in. The update check runs server-side (the browser only hits
        // /api/update/check = 'self'), so no external connect is needed for it. data:/blob: cover
        // the inline cursor/image URIs and the export blob download. frame-ancestors 'none' +
        // X-Frame-Options keep the clickjacking protection.
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store, must-revalidate',
          'x-frame-options': 'DENY',
          'content-security-policy':
            "default-src 'self'; " +
            "script-src 'self' 'unsafe-inline'; " +
            "style-src 'self' 'unsafe-inline'; " +
            "img-src 'self' data: blob:; " +
            "font-src 'self' data:; " +
            "connect-src 'self' https://*.supabase.co; " +
            "base-uri 'self'; " +
            "form-action 'self'; " +
            "frame-ancestors 'none'",
        });
        return res.end(html);
      }
      if (req.method === 'GET' && url.pathname.startsWith('/assets/')) {
        return await handleAsset(res, url.pathname.slice('/assets/'.length));
      }
      if (url.pathname.startsWith('/api/')) {
        if (!originOk(req)) {
          res.writeHead(403, { 'content-type': 'application/json' });
          return res.end('{"error":"cross-origin request refused"}');
        }
        if (!tokenOk(req, url)) {
          res.writeHead(403, { 'content-type': 'application/json' });
          return res.end('{"error":"caller token missing or invalid"}');
        }
        if (postOnly.has(url.pathname) && req.method !== 'POST') {
          res.writeHead(405, { 'content-type': 'application/json' });
          return res.end('{"error":"method not allowed"}');
        }
      }
      if (url.pathname === '/api/state') return await handleState(res);
      if (url.pathname === '/api/overview') return await handleOverview(res);
      if (url.pathname === '/api/activity') return await handleActivity(res, clampInt(url.searchParams.get('limit'), 12, 200));
      if (url.pathname === '/api/recall') return await handleRecall(res, url.searchParams.get('q') || '');
      if (url.pathname === '/api/check') return await handleCheck(res);
      if (url.pathname === '/api/health/dismiss') return await handleDismiss(res, await readBody(req));
      if (url.pathname === '/api/health/undismiss') return await handleUndismiss(res, await readBody(req));
      if (url.pathname === '/api/link/preview') return await handleLinkPreview(res);
      if (url.pathname === '/api/link/apply') return await handleLinkApply(res);
      if (url.pathname === '/api/cleanup/preview') return await handleCleanupPreview(res, url.searchParams.get('kind'));
      if (url.pathname === '/api/cleanup/apply') return await handleCleanupApply(res, url.searchParams.get('kind'));
      if (url.pathname === '/api/notes') return await handleNotes(res, url.searchParams.get('prefix') || '', clampInt(url.searchParams.get('limit'), 60, 100000));
      if (url.pathname === '/api/note') return await handleNote(res, url.searchParams.get('path') || '');
      if (url.pathname === '/api/suggestions') return await handleSuggestions(res);
      if (url.pathname === '/api/note/save') return await handleSaveNote(res, await readBody(req));
      if (url.pathname === '/api/history') return await handleHistoryList(res, url.searchParams.get('path') || '');
      if (url.pathname === '/api/history/diff') return await handleHistoryDiff(res, url.searchParams.get('path') || '', url.searchParams.get('oid') || '');
      if (url.pathname === '/api/history/external') return handleHistoryExternal(res);
      if (url.pathname === '/api/history/restore') return await handleHistoryRestore(res, await readBody(req));
      if (url.pathname === '/api/graph') return await handleGraph(req, res);
      if (url.pathname === '/api/agents') return await handleAgents(res);
      if (url.pathname === '/api/scope') return await handleScope(res, await readBody(req));
      if (url.pathname === '/api/revoke') return await handleRevoke(res, await readBody(req));
      if (url.pathname === '/api/browse') return await handleBrowse(res, await readBody(req));
      if (url.pathname === '/api/inspect') return await handleInspect(res, await readBody(req));
      // /api/ingest doubles as re-index: with no ?path it re-ingests the current brain.
      if (url.pathname === '/api/ingest') return await handleIngest(req, res, url.searchParams.get('path') || brainPath || '');
      if (url.pathname === '/api/pair') return await handlePair(res, await readBody(req));
      if (url.pathname === '/api/rotate') return await handleRotate(res, await readBody(req));
      if (url.pathname === '/api/rename') return await handleRename(res, await readBody(req));
      if (url.pathname === '/api/open-folder') return await handleOpenFolder(res, await readBody(req));
      if (url.pathname === '/api/export') return await handleExport(req, res);
      if (url.pathname === '/api/update/check') return await handleUpdateCheck(res);
      if (url.pathname === '/api/account') return await handleAccount(res);
      if (url.pathname === '/api/signup') return await handleSignup(res, await readBody(req));
      if (url.pathname === '/api/signout') return await handleSignout(res);
      if (url.pathname === '/api/init') return await handleInit(res, await readBody(req));
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":"not found"}');
    } catch (err) {
      send(res, 500, { error: (err as Error).message });
    }
  });

  // listen() only fires its callback on success; a bind failure (EADDRINUSE)
  // emits an 'error' event instead — unhandled, Node would crash with a stack
  // trace. Catch it and fail with a friendly message.
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  }).catch((err: NodeJS.ErrnoException) => {
    const why = err.code === 'EADDRINUSE' ? `port ${port} is already in use — is Callosium already running?` : err.message;
    console.error(`\n  callosium: couldn't start — ${why}\n`);
    process.exit(1);
  });
  // Use the literal IPv4 the server binds to. `localhost` can resolve to IPv6
  // (::1) first on Windows while we listen only on 127.0.0.1, which shows up as
  // a browser that "can't reach the link" even though the server is up.
  const url = `http://127.0.0.1:${port}`;
  liveBanner(url);
  // Warm the embedding model in the background so the first Ask doesn't pay the
  // ~4s cold pipeline load. Gated on an EXISTING embedding cache for this brain:
  // without one the semantic lane never runs, so downloading ~120MB would be
  // waste (a fresh brain gets its model during ingest instead). A failure
  // (offline, blocked network) is swallowed, recall keeps working keyword-only.
  if (brainPath) {
    void loadEmbeddings(Vault.open(brainPath))
      .then((emb) => (emb ? warmModel() : null))
      .catch(() => { /* semantic is an upgrade lane, never a gate */ });
  }
  // best-effort auto-open — UNLESS embedded in the desktop shell, which shows the
  // dashboard in its own window and would otherwise get a duplicate browser tab.
  if (!process.env.CALLOSIUM_DESKTOP) {
    try {
      const child =
        process.platform === 'win32'
          ? // `start "" "<url>"` — the empty first arg is the window TITLE; omit it
            // and `start` treats the quoted URL as a title and opens nothing.
            spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true })
          : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], {
              stdio: 'ignore',
              detached: true,
            });
      child.on('error', () => {}); // no browser to open — the URL is printed in the banner above
      child.unref();
    } catch {
      /* no browser to open — the URL is printed in the banner above */
    }
  }
  // Shut down BOTH listeners this call started. Same reason serveHttp returns one:
  // exiting with a listener still open aborts inside libuv on Windows instead of
  // raising something catchable. Best-effort on the MCP side — it is auto-started
  // fire-and-forget, so it may legitimately never have bound (port already taken).
  return {
    async close(): Promise<void> {
      await mcpHandle?.close().catch(() => {});
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
