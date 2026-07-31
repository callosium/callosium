// The Callosium MCP server (stdio transport, v1). Every tool call runs as an
// authenticated agent; scoping is enforced on every path and attribution is
// stamped on every write. This is the file that replaces per-tool CLAUDE.md
// redirects: install any MCP client, pair it, plug and play.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import http from 'node:http';
import { z } from 'zod';
import { Vault } from '../core/vault.ts';
import { loadSchema } from '../core/schema.ts';
import { parseNote, serializeNote, isoDate } from '../core/frontmatter.ts';
import { ensureHistory, snapshotNote } from '../history/store.ts';
import { logAction } from '../audit/log.ts';
import { aliasesOf } from '../core/aliases.ts';
import { loadTexts, recall, relationshipHonesty, searchNotes, ensureRankIndex, tokenize, type VaultTexts } from '../recall/engine.ts';
import { loadEmbeddings, type EmbeddingIndex } from '../recall/semantic.ts';
import { fuzzyEntity } from '../recall/fuzzy.ts';
import { noteDateMs, noteDateInfo, parsePeriod, noteTitle, bodyEventDates, type DateSource, type BodyEvent } from '../recall/temporal.ts';
import { buildGraph, loadGraph, related } from '../graph/index.ts';
import { routeNote, resolveEntity } from '../filing/engine.ts';
import { generateMap, generateFilingRules, writeMap, hubForNote } from '../structure/map.ts';
import { brainCheck } from '../check/check.ts';
import { buildNameMap } from '../graph/extract.ts';
import { loadAgents, authenticate, authenticateByToken, canRead, canWrite, scopeFilter, isReservedPath, AGENTS_REL } from './agents.ts';
import type { AgentIdentity, AgentsRegistry, BrainSchema, GraphIndex } from '../core/types.ts';
import path from 'node:path';
import { statSync, readFileSync } from 'node:fs';

// ── read_note presentation ────────────────────────────────────────────────
// A note big enough to matter (a 150k-word reference doc is ~250k tokens) must
// never be dumped whole into an agent's context. read_note therefore offers
// three views, all deterministic:
//   • { section }        → just that heading's block (to the next same/higher heading)
//   • { offset, limit }  → an explicit character window (page through anything)
//   • neither + large    → an OUTLINE (headings + char offsets) + the opening,
//                          so the agent picks what to actually read
// Small notes are returned whole — the overwhelmingly common case is unchanged.
// Server-stamped attribution is meant to be UNFORGEABLE. But the dashboard
// renders any `<!-- ✍ written by <name> on <date> -->` comment in a note body as
// a genuine authorship badge — so an agent that smuggles that exact marker into
// its write/append content could stamp a block as authored by the owner (or
// another agent). Defang the marker in all agent-supplied content before it is
// persisted: keep the text, break the pattern so it can never render as a badge.
export function defangAttribution(text: string): string {
  return text.replace(/<!--\s*✍\s*written by[\s\S]*?-->/gi, '<!-- (agent-embedded attribution stripped) -->');
}

export const LARGE_NOTE_CHARS = 12000;
export interface NoteViewOpts { section?: string; offset?: number; limit?: number; whole?: boolean }

function noteHeadings(raw: string): { level: number; title: string; start: number; bodyStart: number }[] {
  const out: { level: number; title: string; start: number; bodyStart: number }[] = [];
  // Track fenced code blocks so a '#' comment line inside ``` or ~~~ (a bash/py
  // snippet, a markdown example) is NOT mistaken for a heading — that would split
  // a section early and hand back a truncated read. Offsets accumulate by line
  // length (+1 per newline) so `start` stays a real char offset into `raw`.
  let offset = 0;
  let inFence = false;
  let fenceMark = '';
  for (const line of raw.split('\n')) {
    const fence = line.match(/^\s*(```+|~~~+)/);
    if (fence) {
      if (!inFence) { inFence = true; fenceMark = fence[1][0]; }
      else if (fence[1][0] === fenceMark) { inFence = false; fenceMark = ''; }
    } else if (!inFence) {
      const m = line.match(/^(#{1,6})[ \t]+(.+?)[ \t\r]*$/);
      if (m) out.push({ level: m[1].length, title: m[2].trim(), start: offset, bodyStart: offset + line.length + 1 });
    }
    offset += line.length + 1; // +1 for the '\n' consumed by split
  }
  return out;
}

function noteOutline(raw: string): string {
  const heads = noteHeadings(raw);
  if (!heads.length) return '(no headings — use { offset, limit } to page through.)';
  // A mega-doc (the 150k-word dev-docs case) can have hundreds of headings — a
  // full outline would itself flood the window. Collapse to the shallowest levels
  // that fit a cap, so the map stays a light, navigable top-level index; the AI
  // reads a section to see its subheadings.
  const CAP = 120;
  let shown = heads;
  let note = '';
  if (heads.length > CAP) {
    for (let maxLevel = 1; maxLevel <= 6; maxLevel++) {
      const kept = heads.filter((h) => h.level <= maxLevel);
      if (kept.length <= CAP || maxLevel === 6) { shown = kept.slice(0, CAP); break; }
    }
    note = `\n… (${heads.length} headings total; showing the top ${shown.length}. Read a section to see its subheadings, or use { offset, limit } to page.)`;
  }
  return shown.map((h) => `${'  '.repeat(h.level - 1)}- ${h.title}  [offset ${h.start}]`).join('\n') + note;
}

function extractSection(raw: string, wanted: string): string | null {
  const want = wanted.trim().toLowerCase();
  const heads = noteHeadings(raw);
  let idx = heads.findIndex((h) => h.title.toLowerCase() === want);
  if (idx < 0) idx = heads.findIndex((h) => h.title.toLowerCase().includes(want));
  if (idx < 0) return null;
  const h = heads[idx];
  let end = raw.length;
  for (let j = idx + 1; j < heads.length; j++) if (heads[j].level <= h.level) { end = heads[j].start; break; }
  return raw.slice(h.start, end).trim();
}

/** Deterministically render a note for read_note given the requested view. */
export function noteView(raw: string, opts: NoteViewOpts = {}): string {
  const { section, offset, limit, whole } = opts;
  // whole:true is the deliberate "give me the ENTIRE document to edit it" ask —
  // the proposal-rewrite job. It bypasses the large-note guard and returns the
  // full text verbatim, prefixed with an honest cost note so the caller knows
  // what it pulled into context. Section/offset still take precedence if set.
  if (whole && !section && typeof offset !== 'number' && typeof limit !== 'number') {
    if (raw.length <= LARGE_NOTE_CHARS) return raw;
    return `[WHOLE NOTE — ${raw.length} chars (~${Math.round(raw.length / 4)} tokens), returned in full at your request.]\n\n${raw}`;
  }
  if (typeof offset === 'number' || typeof limit === 'number') {
    const start = Math.min(Math.max(0, Math.floor(offset ?? 0)), raw.length);
    const len = Math.max(1, Math.floor(limit ?? LARGE_NOTE_CHARS));
    const endAt = Math.min(start + len, raw.length);
    const tail = endAt < raw.length ? `\n\n[… ${raw.length - endAt} more chars. read_note { offset: ${endAt} } to continue.]` : '';
    return `[chars ${start}–${endAt} of ${raw.length}]\n${raw.slice(start, endAt)}${tail}`;
  }
  if (section) {
    const sec = extractSection(raw, section);
    if (sec) return sec;
    return `[section "${section}" not found — pick an exact heading below.]\n\n=== OUTLINE ===\n${noteOutline(raw)}`;
  }
  if (raw.length <= LARGE_NOTE_CHARS) return raw;
  return `[LARGE NOTE — ${raw.length} chars (~${Math.round(raw.length / 4)} tokens). Reading it whole would flood your context, so here is its map + opening. Call read_note again with { section: "<heading>" } to read one part, or { offset, limit } to page through. The full text IS available — this only protects your window.]\n\n=== OUTLINE ===\n${noteOutline(raw)}\n\n=== OPENING (first 4000 chars) ===\n${raw.slice(0, 4000)}`;
}

export interface ServeOptions {
  brainPath: string;
  agentId: string;
  token: string;
}

export async function serve(opts: ServeOptions): Promise<void> {
  const vault = Vault.open(opts.brainPath);
  const reg = await loadAgents(vault);
  const agent: AgentIdentity = authenticate(reg, opts.agentId, opts.token);
  const { schema } = await loadSchema(vault);

  // Authorization is re-derived from disk, not frozen at connect time. If the
  // owner revokes this agent or narrows its scope from the dashboard mid-session,
  // it must take effect WITHOUT restarting this long-lived stdio process. We
  // mutate the SAME `agent` object every scope check (canRead/canWrite/
  // scopeFilter) already closes over, so no per-handler wiring can be missed;
  // an mtime guard makes it a no-op when the registry hasn't changed. A revoked
  // or token-rotated agent fails closed (a scope that matches no path).
  const agentsFile = path.join(vault.root, AGENTS_REL);
  const denyAll = (): AgentIdentity['scopes'] => ({ read: ['\0REVOKED'], denyRead: [], write: [] });
  let agentsMtime = -1;
  // Expiry is a function of TIME, not of the registry file. The mtime guard below
  // is what makes this poll cheap, but it also meant a time-boxed connection was
  // only ever re-checked when someone happened to EDIT agents.json — so an agent
  // whose expiresAt passed mid-session kept full read/write for the life of the
  // stdio session, which is exactly what the expiry was meant to prevent. Track the
  // deadline separately and evaluate it on every tick, ahead of the short-circuit.
  // Kept in sync with mcp/agents.ts isExpired(), including its fail-CLOSED reading
  // of an unparseable date: an owner who time-boxed a connection must never have a
  // corrupted field silently mean "forever".
  let agentExpiresAt: string | undefined = agent.expiresAt;
  const expiredNow = (): boolean => {
    if (!agentExpiresAt) return false; // absent = never expires (the default)
    const t = Date.parse(agentExpiresAt);
    return !Number.isFinite(t) || t <= Date.now();
  };
  const syncAgentScopes = () => {
    if (expiredNow()) {
      agent.scopes = denyAll(); // deadline passed → fail closed, no file read needed
      return;
    }
    let m: number;
    try {
      m = statSync(agentsFile).mtimeMs;
    } catch {
      agent.scopes = denyAll(); // registry gone → deny everything
      return;
    }
    if (m === agentsMtime) return; // unchanged since last check
    try {
      const fresh = JSON.parse(readFileSync(agentsFile, 'utf8')) as AgentsRegistry;
      const re = authenticate(fresh, opts.agentId, opts.token); // throws if revoked/rotated/expired
      agent.scopes = re.scopes;
      agent.displayName = re.displayName;
      agentExpiresAt = re.expiresAt; // the owner may have set, extended or cleared the deadline
      // Advance the mtime ONLY after a successful read+parse+auth. If the read
      // failed transiently (OneDrive/iCloud cold-touch), leaving the mtime
      // un-advanced means the next 2s poll RETRIES instead of latching the agent
      // into denyAll until the registry file happens to change again.
      agentsMtime = m;
    } catch {
      agent.scopes = denyAll(); // no longer present / bad token → fail closed
    }
  };
  syncAgentScopes(); // prime the mtime against the just-authenticated state
  // Poll for revocation/scope edits; unref so it never keeps the process alive.
  const scopeTimer = setInterval(syncAgentScopes, 2000);
  scopeTimer.unref?.();

  const server = await buildServer(vault, agent, schema);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`callosium mcp: serving "${vault.root}" to agent "${agent.id}" (${agent.displayName})`);
}

// ── version-history snapshot barrier (per note path) ──────────────────────
// snapshotNote() commits whatever bytes are ON DISK when it finally runs, so a
// fire-and-forget snapshot is only correct while the note still holds the version it
// was fired for. Two writes to the SAME note in quick succession broke that: write #2
// landed before snapshot #1 reached git.add, so #1 committed #2's content under #1's
// author and #2 then found the note 'unmodified' and recorded nothing. Measured on a
// two-agent HTTP session (A appends, B appends): History showed ONE version, authored
// "Agent A", containing agent B's text — the intermediate version was unrecoverable
// and the surviving one named the wrong agent.
// The snapshot deliberately stays OFF the write's critical path, so the fix is a
// barrier rather than an await: register each snapshot per note path, and make the
// next writer of THAT path wait for it — for a BOUNDED time, see SETTLE_MAX_WAIT_MS —
// before changing the bytes underneath it.
// Module-level like vault.ts's vaultLocks — serveHttp builds a server per REQUEST, so
// a per-server map would never see the second agent, which is exactly the case that
// mis-attributes.
const pendingVersions = new Map<string, Promise<unknown>>();
/** The write-lock key, ASKED OF THE VAULT rather than re-derived here. A barrier that
 *  keys notes differently from the lock that serializes them is not a barrier: it
 *  misses precisely the aliased spellings (NFC vs NFD, a stray trailing space) that
 *  the lock folds into one file, which is the mis-attribution described above. That
 *  is exactly what a hand-copied derivation here did once vault.ts's fold changed
 *  underneath it — so there is now ONE fold, in vault.ts, reached through this. */
function versionKey(vault: Vault, rel: string): string {
  return vault.lockKeyFor(rel);
}
/** How long a writer will hold its note's lock waiting for that note's in-flight
 *  snapshot. snapshotNote runs under the shadow repo's per-BRAIN write lock, so a
 *  pending snapshot can be queued behind the connect-time baseline import or a
 *  retention prune — measured at 30.8s for the second write to a note on a
 *  4,000-note brain, every second of it spent holding the vault lock and blocking
 *  every other writer of that note. History is best-effort by design and the
 *  dashboard's captureExternal re-index is its stated backstop, so past this cap we
 *  degrade to the old fire-and-forget behaviour (worst case: one version recorded
 *  with the wrong author) instead of stalling the tool call without bound. */
const SETTLE_MAX_WAIT_MS = 2000;
/** Wait for any in-flight snapshot of this note. Call INSIDE the note's write lock,
 *  immediately before its bytes change. Never throws (history stays best-effort) and
 *  never waits longer than SETTLE_MAX_WAIT_MS. */
async function settleVersion(vault: Vault, rel: string): Promise<void> {
  const p = pendingVersions.get(versionKey(vault, rel));
  if (!p) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    p.catch(() => {}),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, SETTLE_MAX_WAIT_MS);
      timer.unref?.(); // never keep the process alive for a barrier
    }),
  ]);
  clearTimeout(timer);
}

/** Build the MCP server with all tools closing over an ALREADY-authenticated
 *  agent, WITHOUT a transport — reused by the stdio serve() above and the HTTP
 *  serveHttp() below. The caller owns authentication and (for stdio) scope-sync. */
// Repoint every [[wikilink]] that pointed at a note being moved/renamed, so a rename never
// leaves dangling links. Matches the target by basename OR full path (case-insensitive),
// preserving any |alias or #heading.
// Returns BOTH halves of the truth: `changed` = the notes it rewrote, `skipped` = the notes it
// could NOT rewrite (outside the agent's write scope) that really do still link to the old path.
// move_note used to report only `changed` and then claim it had fixed everything "across the
// brain" — with a scoped agent that was a success message over genuinely dangling links.
// `skipped` holds ONLY notes the agent may READ: an unreadable note cannot be named back to the
// caller anyway, and even its COUNT is a disclosure (see the reporting block in move_note), so
// there is nothing to gain by opening it.
// `version` is the caller's snapshot registrar. It is invoked INSIDE each note's write lock, the
// instant after the rewrite, so the next writer of that note has something to wait on — calling it
// after the scan finished left a multi-second window per note in which there was none.
export async function repointWikilinks(
  vault: Vault,
  agent: AgentIdentity,
  from: string,
  to: string,
  version?: (rel: string) => void,
): Promise<{ changed: string[]; skipped: string[] }> {
  // Normalize to forward-slash so the string logic below matches vault.listNotes()' disk-canonical
  // paths even if the caller passed OS-native backslashes (base()/the path compares split on '/').
  from = from.replace(/\\/g, '/');
  to = to.replace(/\\/g, '/');
  const base = (p: string): string => (p.split('/').pop() || '').replace(/\.md$/i, '');
  const noExt = (p: string): string => p.replace(/\.md$/i, '');
  const oldBase = base(from).toLowerCase();
  const oldPath = noExt(from).toLowerCase();
  const newBase = base(to);
  const newPath = noExt(to);
  const all = await vault.listNotes();
  // Bare-basename repointing is only safe when the old basename is UNIQUE in the vault; if another
  // note still shares it, a plain [[Bob]] link may have meant that OTHER note, so repoint only the
  // explicit path form and leave bare links alone (avoids silently retargeting the wrong note).
  // Exclude the moved note itself case-insensitively — if `to` differs from the on-disk path only in
  // letter-case, a raw !== would leave the note counting against its own basename and disable bareOk.
  const bareOk = !all.some((n) => n.toLowerCase() !== to.toLowerCase() && base(n).toLowerCase() === oldBase);
  const WL = /\[\[([^\]|#]+)([#|][^\]]*)?\]\]/g;
  const repoint = (raw: string): string =>
    raw.replace(WL, (m: string, target: string, rest = '') => {
      const t = target.trim().replace(/\.md$/i, '').toLowerCase(); // tolerate a [[Old.md]] suffix form
      if (t === oldPath) return `[[${newPath}${rest || ''}]]`;
      if (bareOk && t === oldBase) return `[[${newBase}${rest || ''}]]`;
      return m;
    });
  const changed: string[] = [];
  const skipped: string[] = [];
  for (const p of all) {
    if (p === from) continue; // old path is gone; the moved note (now `to`) IS scanned to fix its self-links
    if (!canWrite(agent, p)) {
      // NEVER write a note outside the calling agent's write scope — but do not pretend it
      // was repointed either. Read it (server-side only; the content never leaves this
      // function) purely to find out whether it genuinely still points at the old path, so
      // move_note can name what it left behind instead of over-claiming. System/ artifacts
      // are excluded: those are Callosium's own derived files and get regenerated.
      if (isReservedPath(p)) continue;
      // A note the agent cannot READ is not examined at all. Its path can never be named
      // back to the caller, and reporting how many such notes link to a given path is a
      // whole-vault statistic about a corpus the agent is forbidden to see — the same
      // disclosure brain_check refuses to make, and one an agent could mine by repeating
      // the move under different names.
      if (!canRead(agent, p)) continue;
      try {
        const raw = await vault.readFileRetry(p);
        if (repoint(raw) !== raw) skipped.push(p);
      } catch {
        /* unreadable right now — nothing we can honestly say about it either way */
      }
      continue;
    }
    // read-modify-write under the per-note lock (CAS), like every other write tool, so a concurrent
    // append_note to a note we also repoint can't be clobbered.
    const wrote = await vault.withLock(p, async () => {
      let raw: string;
      try {
        raw = await vault.readFileRetry(p);
      } catch {
        return false;
      }
      const out = repoint(raw);
      if (out !== raw) {
        await settleVersion(vault, p); // snapshot barrier — see version() in buildServer
        await vault.writeFile(p, out);
        // Register the snapshot BEFORE this note's lock releases, so the next writer of
        // it has a pending entry to settle against. Registering after the whole scan
        // left a window of seconds per note with nothing to wait on.
        version?.(p);
        return true;
      }
      return false;
    });
    if (wrote) changed.push(p);
  }
  return { changed, skipped };
}

/** Mutable per-brain retrieval cache. Shared across serveHttp's per-request
 *  servers (see serveHttp) so consecutive HTTP calls reuse one vault walk. */
interface McpCache {
  texts: VaultTexts | null;
  emb: EmbeddingIndex | null | undefined;
  graph: Awaited<ReturnType<typeof loadGraph>>;
  graphLoadedOnce: boolean;
  builtToken: string;
  lastFreshCheck: number;
  // The brain (vault.root) the cached structures were built from. serveHttp reuses
  // ONE cache across per-request servers and resolves the live brainPath per call,
  // so a cockpit brain-switch must drop the previous brain's texts/graph/emb even
  // mid-throttle — the freshness TOKEN alone can't catch it, because the throttle
  // returns before the token is ever recomputed (see syncFreshness).
  brainRoot: string;
}
function freshMcpCache(): McpCache {
  return { texts: null, emb: undefined, graph: null, graphLoadedOnce: false, builtToken: '', lastFreshCheck: 0, brainRoot: '' };
}

/** The heavy loaded-brain structures a server's tools read, behind an INJECTABLE
 *  seam. buildServer normally gets mcpCacheSource() — its own private McpCache,
 *  byte-for-byte the behavior certified before this seam existed. A host process
 *  that ALREADY holds the same brain loaded hands in its own source instead, so
 *  the note bodies, the graph and the (large) Float32 vector matrix are resident
 *  ONCE per process rather than once per surface. The dashboard does exactly
 *  that for the HTTP MCP endpoint it auto-starts inside itself: two independent
 *  caches over one brain meant ~76MB of vectors plus every note body held twice
 *  in a single process on a large vault (see dashboard/server.ts).
 *
 *  Contract for an injected implementation:
 *   - it is OWNER-UNSCOPED (the whole brain). Per-agent scoping stays HERE, in
 *     scopedInputs, per request, exactly as it works over the private cache — an
 *     injected source must never be handed an agent or asked to pre-filter.
 *   - texts/graph/emb must be for the vault PASSED IN, never "whichever brain the
 *     host is on now". A request pins its vault at authentication time and the
 *     owner can switch brains while it is still in flight; answering it from the
 *     new brain would hand an agent notes from a brain it was never scoped to.
 *   - they must self-heal on EXTERNAL edits (the owner in Obsidian, a sync
 *     client, another agent's process) — a snapshot frozen at connect time is
 *     what the freshness gate below exists to prevent.
 *   - invalidate() is called after every write this server makes and must drop
 *     whatever the host derived from the brain, so the next read reflects it. */
/** Scoped-corpus memo.
 *
 *  scopedInputs() derives a filtered VaultTexts/graph/emb for a partial-scope agent,
 *  and recall keys its rank index on the VaultTexts OBJECT IDENTITY. Returning a fresh
 *  object per call therefore forced a full re-tokenize AND fuzzy-index rebuild of the
 *  entire vault on EVERY query — measured 16ms → 1644ms per recall at 2,000 notes, and
 *  it hit essentially every real user, because pairAgent defaults to
 *  denyRead:['Private/'] and Private/ is a core schema partition, so no dashboard-paired
 *  agent ever took the full-scope fast path.
 *
 *  Keyed on the SOURCE texts object (a WeakMap, so entries die with the cache generation
 *  that produced them — a re-index or brain switch mints a new VaultTexts and orphans the
 *  old entry) and, within that, on the agent's exact scope signature plus the identities
 *  of the source graph and embeddings. Any scope edit, revocation, expiry or re-index
 *  changes the key and forces a fresh derivation, so this can never serve a stale or
 *  wider-than-current view. */
const scopedMemo = new WeakMap<
  VaultTexts,
  Map<string, {
    graph: GraphIndex | null;
    emb: EmbeddingIndex | null;
    out: { texts: VaultTexts; graph: GraphIndex | null; emb: EmbeddingIndex | null };
  }>
>();
/** Distinct agents per brain is small; this only bounds a pathological case. */
const SCOPED_MEMO_MAX = 16;
const scopeSignature = (s: AgentIdentity['scopes']): string =>
  // denyRead is optional on the type; treat absent and empty as the same signature,
  // which is what canRead does too.
  `${(s.read ?? []).join('|')}»${(s.denyRead ?? []).join('|')}»${(s.write ?? []).join('|')}`;

/** A running server the caller can shut down. Returned by serveHttp (and mirrored by
 *  serveDashboard) so an embedder or a test can stop listening instead of being forced
 *  to process.exit() with the listener still open — which on Windows aborts the process
 *  inside libuv rather than raising a catchable error. */
export interface ServerHandle {
  close(): Promise<void>;
}

export interface BrainSource {
  texts(vault: Vault): Promise<VaultTexts>;
  /** Always a graph: a missing graph.json is BUILT, never served as null (tools
   *  like related() dereference it directly). */
  graph(vault: Vault): Promise<GraphIndex>;
  /** null = no embedding cache → the semantic lane fails open to lexical. */
  emb(vault: Vault): Promise<EmbeddingIndex | null>;
  invalidate(): void;
}

/** The default BrainSource: one private McpCache plus the freshness gate, the
 *  brain-switch guard and the load-then-publish recheck. stdio gets one per
 *  server; serveHttp creates ONE and shares it across its per-request servers.
 *  Exported so a host that normally injects its own can still fall back to a
 *  private cache for a request pinned to a brain it is no longer serving.
 *
 *  Caches (text / embeddings / graph), loaded lazily and invalidated on our own
 *  writes. External writers — the user in Obsidian, a sync client, another agent
 *  — are picked up by a freshness gate on read: before serving any cache we
 *  compare a cheap tree fingerprint against the one we built from, throttled so a
 *  burst of tool calls does at most one stat-walk per interval. Without this a
 *  long-running MCP session answers from a snapshot frozen at connect time.
 *    texts    — loaded lazily, invalidated on our own writes.
 *    emb      — semantic lane; null (no cache) → fail open to lexical, undefined → not yet loaded.
 *    graph    — first load trusts graph.json (fast); after any invalidation we REBUILD
 *               via buildGraph, whose stillValid pass drops edges to deleted/renamed notes.
 *    builtToken — the vault fingerprint the caches currently reflect. */
export function mcpCacheSource(): BrainSource {
  const cache = freshMcpCache();
  const FRESH_THROTTLE_MS = 1500;
  // Shared by every getter (recall reads text+graph, related reads only graph —
  // both must see external edits), so freshness is checked no matter which tool
  // fires. Throttled by a single timestamp so concurrent getters do ONE walk.
  const syncFreshness = async (vault: Vault) => {
    // Brain-switch guard (pass-3 review): a mid-session cockpit brain switch changes
    // vault.root under the SAME shared cache. Drop everything and re-baseline BEFORE
    // the throttle can short-circuit, or a warm request loop would serve the previous
    // brain's notes to an agent authenticated for the new brain for up to the throttle
    // window. lastFreshCheck=0 forces the token recompute for the new brain this call.
    if (cache.brainRoot !== vault.root) {
      cache.brainRoot = vault.root;
      cache.texts = null; cache.emb = undefined; cache.graph = null;
      cache.graphLoadedOnce = false; cache.builtToken = ''; cache.lastFreshCheck = 0;
    }
    const now = Date.now();
    if (now - cache.lastFreshCheck < FRESH_THROTTLE_MS) return;
    cache.lastFreshCheck = now;
    const tok = await vault.freshnessToken();
    if (tok !== cache.builtToken) { cache.texts = null; cache.emb = undefined; cache.graph = null; }
    cache.builtToken = tok;
  };
  // Load-then-publish with a token recheck (P2 review, shared-HTTP-cache race):
  // under serveHttp every per-request server mutates ONE shared cache, so a write
  // in request A can invalidate() while request B's slow loadTexts is mid-flight —
  // B would then commit its PRE-write snapshot over the null. We snapshot
  // builtToken before the load and publish to the shared cache only if it is
  // unchanged (invalidate resets it to ''); otherwise B's caller still gets a
  // coherent snapshot but the shared cache stays invalidated so the next read
  // reloads the fresh version. On the sequential stdio path no concurrent
  // invalidate exists, so the token always matches and this publishes exactly as
  // before (byte-identical certified behavior).
  return {
    texts: async (vault) => {
      await syncFreshness(vault);
      if (cache.texts) return cache.texts;
      const at = cache.builtToken;
      const loaded = await loadTexts(vault);
      if (!cache.texts && cache.builtToken === at) cache.texts = loaded;
      return cache.texts ?? loaded;
    },
    emb: async (vault) => {
      await syncFreshness(vault);
      if (cache.emb !== undefined) return cache.emb;
      const at = cache.builtToken;
      const loaded = await loadEmbeddings(vault);
      if (cache.emb === undefined && cache.builtToken === at) cache.emb = loaded;
      return cache.emb !== undefined ? cache.emb : loaded;
    },
    graph: async (vault) => {
      await syncFreshness(vault);
      if (cache.graph) return cache.graph;
      const at = cache.builtToken;
      const g = cache.graphLoadedOnce
        ? (await buildGraph(vault)).index // reload after a change → rebuild to self-heal
        : ((await loadGraph(vault)) ?? (await buildGraph(vault)).index); // first load → trust cache
      cache.graphLoadedOnce = true;
      if (!cache.graph && cache.builtToken === at) cache.graph = g;
      return cache.graph ?? g;
    },
    invalidate: () => {
      cache.texts = null;
      cache.emb = undefined; // reload on next recall so writes are reflected once re-embedded
      cache.graph = null; // next getGraph rebuilds (graphLoadedOnce is set) → self-heal
      cache.builtToken = ''; // force the next freshness check to re-baseline
      cache.lastFreshCheck = 0; // and clear the throttle, so the NEXT read re-checks
      // freshness immediately instead of serving stale for up to FRESH_THROTTLE_MS
      // after a write (P2 review, shared-cache staleness window).
    },
  };
}

// ensureHistory (baseline the shadow-git repo) only needs to run ONCE per brain
// per process. The stateless HTTP MCP builds a fresh server per request, so
// without this memo an agentic loop of ~30 tool calls fires ~30 redundant
// cross-process lockfile acquires + ref reads, contending with real snapshot
// commits. Drop the id on failure so a transient error retries next request.
const ensuredBrains = new Set<string>();

async function buildServer(vault: Vault, agent: AgentIdentity, schema: BrainSchema, source?: BrainSource): Promise<McpServer> {
  // Version history (external-write safety net): stamp each of this agent's writes into the
  // shadow-git store so every version is recoverable and attributed. ensureHistory lays the
  // baseline at connect; version() is still fire-and-forget so it never adds write latency (a
  // failed or skipped snapshot is still caught by the dashboard's re-index captureExternal
  // pass) — only the NEXT write to the SAME note waits for it, briefly and with a hard cap,
  // via the snapshot barrier above.
  const brainId = Vault.contentHash(vault.root.toLowerCase());
  if (!ensuredBrains.has(brainId)) {
    ensuredBrains.add(brainId);
    void ensureHistory(vault.root, brainId).catch(() => ensuredBrains.delete(brainId));
  }
  const version = (rel: string): void => {
    // Chain per NOTE PATH: the shadow repo's own lock is per BRAIN, so it orders the
    // commits but says nothing about which bytes each one is about to read off disk.
    // The chain gives settleVersion() a single promise to wait on, and guarantees two
    // snapshots of one note commit in write order with each agent on its own version.
    const key = versionKey(vault, rel);
    const next = (pendingVersions.get(key) ?? Promise.resolve())
      .then(() => snapshotNote(vault.root, brainId, rel, agent.displayName))
      .catch(() => {});
    pendingVersions.set(key, next);
    // Drop the entry once it is the tail, so this never grows one key per note written.
    void next.then(() => {
      if (pendingVersions.get(key) === next) pendingVersions.delete(key);
    });
  };
  // Activity log: record THIS agent's action (read/write/append/archive/move/recall/remember) in the
  // per-brain audit trail the dashboard's "recent activity" reads. Fire-and-forget like version() —
  // a logging failure never affects the tool call.
  const act = (action: string, notePath?: string, detail?: string): void => {
    void logAction(brainId, { agentId: agent.id, agent: agent.displayName, action, path: notePath, detail }).catch(() => {});
  };
  // Where the heavy loaded-brain structures come from. Default: this server's own
  // private McpCache (stdio's long-lived server passes no `source` and gets one;
  // serveHttp creates ONE and shares it across its per-request servers, so a fresh
  // server per HTTP request does not re-walk the whole vault on every call).
  // An INJECTED source is a host that already holds this brain loaded — the
  // dashboard hands in its cockpit cache so the vectors and note bodies are
  // resident once per process instead of once per surface. See BrainSource for the
  // contract; everything below this line is identical either way, including
  // per-agent scoping (scopedInputs), which always runs here, per request.
  const brain = source ?? mcpCacheSource();
  const getTexts = () => brain.texts(vault);
  const getEmb = () => brain.emb(vault);
  const getGraph = () => brain.graph(vault);
  const invalidate = () => brain.invalidate();
  // Persist the vault map (System/Map.md) so an AI that reads the FILE — an
  // always-on instruction pointed at it, or read_note — inherits the current
  // shape. Called from get_map (the canonical "read the map" tool, which the
  // structuring flow calls right after it files notes) and by the dashboard
  // re-index; NOT per write, so a bulk note-creation doesn't rewrite this one
  // OneDrive-synced file dozens of times. System-level: it writes Callosium's own
  // derived artifact (like graph.json), bypassing agent write-scope, and always
  // from the FULL unscoped texts so the persisted map is complete. Best-effort.
  const refreshMapFile = async (t: VaultTexts) => {
    try {
      await writeMap(vault, schema, t);
    } catch {
      /* non-fatal: the map is always regenerable on demand via get_map */
    }
  };

  const server = new McpServer({ name: 'callosium', version: '0.1.0' });

  const deny = (path: string, verb: string) => {
    throw new Error(`Scope denied: agent "${agent.id}" cannot ${verb} "${path}".`);
  };

  // Notes tagged with their frontmatter aliases — shared by resolve and
  // write_note so entity dedupe sees aliases, not just basenames (a
  // write_note with aliases:[] would let "Robert" create a duplicate of the
  // note aliased "Robert" on Bob Smith.md).
  const notesWithAliases = (t: { files: string[]; texts: Map<string, string> }) =>
    t.files.map((f) => ({ path: f, aliases: aliasesOf(t.texts.get(f) || '') }));

  // ── SCOPE-BEFORE-RANK (P2 #4) ──────────────────────────────────────────────
  // recall() and its honesty gate must see ONLY the notes THIS agent may read.
  // Filtering the OUTPUT (scopeFilter, still kept below as defense-in-depth) is
  // not enough: (a) an out-of-scope note that answers the query flips found=true
  // and then, once filtered out, leaks "a match exists you can't see" — an
  // existence oracle; and (b) out-of-scope vocabulary contaminates IDF, spelling
  // corrections, the semantic lane and fusion, skewing how the IN-scope results
  // rank. So we scope the INPUTS. The owner / any full-read agent (readable ==
  // every note) takes an identity fast-path: no copy, no behavior change — the
  // certified full-scope benchmark is therefore untouched; only genuinely
  // partial-scope agents pay the filtering cost (the minority, smaller visible set).
  const scopedInputs = (
    texts: VaultTexts,
    graph: GraphIndex | null,
    emb: EmbeddingIndex | null,
  ): { texts: VaultTexts; graph: GraphIndex | null; emb: EmbeddingIndex | null } => {
    const readable = new Set(texts.files.filter((f) => canRead(agent, f)));
    // Full-scope fast-path: fire when every note this agent CANNOT read is a
    // UNIVERSALLY-reserved one (System/, server-only). Those are denied to every
    // agent, belong in the ranking corpus (the certified benchmark ranked with
    // them present), and are stripped from RESULTS post-rank anyway — so scoping
    // them out would needlessly rebuild the rank index every query (ensureRankIndex
    // keys its cache on the VaultTexts object identity) AND diverge the owner's
    // corpus stats from the certified benchmark. A plain `readable.size ===
    // files.length` never held, because System/Map.md is always present yet never
    // readable, forcing EVERY agent onto the copy path. Only genuinely partial-
    // scope agents (a denyRead/allowlist beyond System) get the scoped copy.
    if (texts.files.every((f) => readable.has(f) || isReservedPath(f))) return { texts, graph, emb };
    // Partial scope: reuse the derivation for this (source corpus × scope × graph × emb)
    // rather than rebuilding it — including a fresh Float32 matrix — on every tool call.
    // See scopedMemo for why this is load-bearing rather than a micro-optimization.
    const sig = scopeSignature(agent.scopes);
    let perTexts = scopedMemo.get(texts);
    if (!perTexts) { perTexts = new Map(); scopedMemo.set(texts, perTexts); }
    const hit = perTexts.get(sig);
    if (hit && hit.graph === graph && hit.emb === emb) return hit.out;
    const keep = (p: string): boolean => readable.has(p);
    const filterMap = <V>(m: Map<string, V>): Map<string, V> => new Map([...m].filter(([p]) => keep(p)));
    let contentIndex: VaultTexts['contentIndex'] = null;
    if (texts.contentIndex) {
      contentIndex = new Map();
      for (const [term, postings] of texts.contentIndex) {
        const inner = new Map([...postings].filter(([p]) => keep(p)));
        if (inner.size) contentIndex.set(term, inner);
      }
    }
    const sTexts: VaultTexts = {
      files: texts.files.filter(keep),
      texts: filterMap(texts.texts),
      mtimes: filterMap(texts.mtimes),
      contentIndex,
      archived: new Set([...texts.archived].filter(keep)),
      unreadable: new Set([...texts.unreadable].filter(keep)),
    };
    // Graph: drop any resolved edge touching an unreadable note on EITHER end so a
    // related-hop never surfaces (or even names) a note outside scope. Unresolved
    // edges (target is raw link text, not a note) from a readable note are harmless.
    const sGraph: GraphIndex | null = graph
      ? { ...graph, edges: graph.edges.filter((e) => keep(e.from) && (!!e.unresolved || keep(e.to))) }
      : null;
    // Embeddings: keep only chunks whose note is readable and rebuild the aligned
    // vector matrix; null/absent emb stays null (lexical-only path).
    let sEmb: EmbeddingIndex | null = emb;
    if (emb) {
      const srcIdx: number[] = [];
      const chunks: EmbeddingIndex['chunks'] = [];
      emb.chunks.forEach((c, i) => { if (keep(c.path)) { srcIdx.push(i); chunks.push(c); } });
      const vectors = new Float32Array(srcIdx.length * emb.dims);
      srcIdx.forEach((src, dst) => vectors.set(emb.vectors.subarray(src * emb.dims, (src + 1) * emb.dims), dst * emb.dims));
      const noteHashes: Record<string, string> = {};
      for (const [p, h] of Object.entries(emb.noteHashes)) if (keep(p)) noteHashes[p] = h;
      sEmb = { ...emb, chunks, vectors, noteHashes };
    }
    const out = { texts: sTexts, graph: sGraph, emb: sEmb };
    // Evict oldest-first if a brain somehow accumulates many distinct scope shapes.
    if (perTexts.size >= SCOPED_MEMO_MAX) perTexts.delete(perTexts.keys().next().value as string);
    perTexts.set(sig, { graph, emb, out });
    return out;
  };

  server.registerTool(
    'recall',
    {
      title: 'Recall from the brain',
      description:
        'Deterministic retrieval over the brain. Returns evidence-tagged excerpts, a linked-context block (related notes up to 3 hops — read_note the ones you need), and a create-safety hint. If `clarify` is present, ASK THE USER which option they mean before proceeding — do not guess. If found=false, relay "not in the brain" honestly — never invent an answer.',
      inputSchema: { question: z.string().describe('Natural-language question') },
    },
    async ({ question }) => {
      // Scope the retrieval INPUTS to this agent's readable set BEFORE ranking so
      // the honesty gate can't become an existence oracle and out-of-scope vocab
      // can't skew the ranking (P2 #4). Full-scope agents get the originals back.
      const { texts: sTexts, graph: sGraph, emb: sEmb } = scopedInputs(await getTexts(), await getGraph(), await getEmb());
      let answer = await recall(question, sTexts, sGraph, false, sEmb);
      answer.results = scopeFilter(agent, answer.results); // defense-in-depth: inputs are already scoped
      // M4 (judges the note the agent actually receives): don't answer a
      // "who is my <person-role>" relationship question with a non-person note.
      answer = relationshipHonesty(question, answer, sTexts);
      if (answer.context) {
        answer.context = answer.context.filter((c) => canRead(agent, c.path));
        if (!answer.context.length) delete answer.context;
      }
      // richness.anchor is computed pre-filter inside recall() — re-anchor it
      // to the top VISIBLE result (or drop it) so it can't disclose the path
      // of a note the agent isn't scoped to read.
      if (answer.richness) {
        if (answer.results.length) answer.richness.anchor = answer.results[0].path;
        else delete answer.richness;
      }
      // clarify options may also point outside scope — filter them too.
      if (answer.clarify) {
        answer.clarify.options = answer.clarify.options.filter((o) => canRead(agent, o.path));
        if (!answer.clarify.options.length) delete answer.clarify;
      }
      // With scope-before-rank the honesty gate already ran on the readable set,
      // so a surviving found=true always carries a readable result. This stays as
      // defense-in-depth, but must NOT re-introduce the existence oracle: report a
      // uniform miss, never "matches exist outside your scope".
      if (!answer.results.length && answer.found) {
        answer.found = false;
        answer.notInBrainReason = 'No note answers this.';
      }
      act('recall', answer.results?.[0]?.path, question);
      return { content: [{ type: 'text', text: JSON.stringify(answer, null, 2) }] };
    },
  );

  server.registerTool(
    'search',
    {
      title: 'Search the brain',
      description:
        'Fast ranked search for browsing and disambiguation — returns candidate notes with snippets, no committed answer. Use recall when you need a checked answer; use search when you need to find or choose between notes.',
      inputSchema: { query: z.string(), limit: z.number().optional().describe('Max results, default 20') },
    },
    async ({ query, limit }) => {
      // Scope INSIDE searchNotes (before its top-N slice) so a scoped agent
      // isn't told "no matches" when visible hits sit just past the hidden ones.
      const hits = searchNotes(query, await getTexts(), limit ?? 20, (f) => canRead(agent, f));
      return { content: [{ type: 'text', text: JSON.stringify(hits, null, 2) }] };
    },
  );

  server.registerTool(
    'list_notes',
    {
      title: 'List notes',
      description: 'Browse the brain by folder prefix (e.g. "Knowledge/") — returns paths, newest first.',
      inputSchema: {
        prefix: z.string().optional().describe('Folder prefix; omit for partition overview'),
        limit: z.number().optional(),
      },
    },
    async ({ prefix, limit }) => {
      const t = await getTexts();
      let files = t.files.filter((f) => canRead(agent, f));
      if (prefix) files = files.filter((f) => f.startsWith(prefix));
      files.sort((a, b) => (t.mtimes.get(b) ?? 0) - (t.mtimes.get(a) ?? 0));
      return { content: [{ type: 'text', text: JSON.stringify(files.slice(0, limit ?? 50), null, 2) }] };
    },
  );

  server.registerTool(
    'recent',
    {
      title: 'What happened in a time window',
      description:
        'For "what did I do / what happened / what did we work on / what moved" over a PERIOD (yesterday, last N days, last week, last two weeks, this month). Returns the notes with activity in that window — session logs, memory records, devlog, dated notes — real activity first, with paths + dates, optionally narrowed to a topic. Time-aware by each note\'s REAL date (filename/frontmatter), not topic rank — recall/search rank by topic and surface old notes for a recent-period question. Also surfaces a note whose BODY records a dated event in the window even when the file\'s own date is older (marked ⟨in note: DATE⟩) — real movement written in prose, e.g. an opportunity note that says a deliverable was "filled 7 Jul". A cluster of notes sharing one frontmatter date is flagged [bulk] (a vault-wide edit, not real movement); a bulk note with a genuine body event is promoted out of [bulk]. Use this for the daily driver, then read_note the ones you need.',
      inputSchema: {
        question: z.string().describe('The user question, e.g. "what did we do the last 5 days on Callosium"'),
        days: z.number().optional().describe('Override the window with an explicit number of days back'),
        limit: z.number().optional(),
      },
    },
    async ({ question, days, limit }) => {
      const t = await getTexts();
      const now = Date.now();
      const period = days != null
        ? { fromMs: now - days * 86_400_000, toMs: now + 86_400_000, label: `last ${days} days` }
        : parsePeriod(question, now);
      if (!period) {
        return { content: [{ type: 'text', text: 'No time window in the question. Use recall/search for topic lookups, or pass an explicit `days`.' }] };
      }
      const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
      // topic = content words of the question minus time/stop words; a note must
      // match at least one to be kept (omit → every dated note in the window).
      const STOP = new Set(['what', 'did', 'does', 'was', 'were', 'have', 'has', 'had', 'the', 'and', 'for', 'over', 'last', 'past', 'previous', 'recent', 'recently', 'lately', 'day', 'days', 'week', 'weeks', 'month', 'months', 'two', 'yesterday', 'today', 'this', 'that', 'happen', 'happened', 'across', 'get', 'give', 'our', 'with', 'how', 'when', 'since', 'ago', 'you', 'work', 'working', 'worked', 'done', 'are',
        // generic state/action filler that otherwise matches unrelated notes and
        // drowns the real topic (e.g. "real movement" matched Callosium notes and
        // buried the Opportunity notes for "what opportunities moved").
        'real', 'really', 'movement', 'moved', 'move', 'moving', 'active', 'actively', 'right', 'now', 'current', 'currently', 'still', 'actually', 'genuine', 'genuinely', 'going', 'progress', 'update', 'updates', 'new', 'latest', 'been', 'about', 'made', 'make', 'any', 'some', 'thing', 'things', 'stuff', 'give', 'there']);
      // Topic words via the shared tokenizer (Unicode/Arabic-aware). An ASCII-only
      // /[a-z0-9]{3,}/ dropped EVERY Arabic topic word, so an Arabic "latest on X"
      // returned the whole window unfiltered (Arabic-first audience). Match by
      // token-set membership over path + first 500 chars — still word-level, so
      // "are" won't hit "software" and "opportunities" hits the /Opportunities/ segment.
      // The WINDOW SIZE is not a topic. "what did I do in the last 3 days" put "3"
      // into topic, so a note had to literally contain "3" to survive — measured:
      // "last week" returned 11 notes, "last 3 days" returned 0 ("matching 3"), and
      // "over the last 30 days" matched one note only because its body said
      // "30 June". This is the phrasing get_map itself routes to `recent`, and the
      // failure mode is the worst one for a memory product: a confident "nothing
      // happened" about work that is right there.
      // Drop bare numerals and spelled-out counts. NOT by clearing topic when `days`
      // is passed: topicMatch returns false on an empty topic, which switches OFF the
      // event-time rescue (an out-of-window note whose BODY records an in-window
      // event), so "recent with days:N" would stop surfacing exactly the notes that
      // feature exists for. The window and the topic are independent — `days` decides
      // WHEN, the question still decides WHAT.
      // The tokenizer can glue a stopword to a digit ("past 7"), so strip digits from
      // each token and drop it if what remains is empty or itself a stop word.
      const COUNT_WORD = new Set(['one', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
        'eleven', 'twelve', 'fourteen', 'fifteen', 'twenty', 'thirty', 'sixty', 'ninety', 'hundred', 'couple', 'few', 'several']);
      const isWindowSize = (w: string) => {
        if (COUNT_WORD.has(w)) return true;
        const bare = w.replace(/[\d\s]+/g, '').trim();
        return bare === '' || STOP.has(bare);
      };
      const topic = [...new Set(tokenize(question).filter((w) => !STOP.has(w) && !isWindowSize(w)))];
      const topicMatch = (f: string, text: string) => {
        if (topic.length === 0) return false;
        const hay = new Set(tokenize(f + ' ' + text.slice(0, 500)));
        return topic.some((w) => hay.has(w));
      };

      // Pass 1: collect candidate notes + count front-dated notes per date across
      // the WHOLE window BEFORE the topic filter — a vault-wide audit restamps
      // notes across many partitions, so a topical query would otherwise see only
      // a few and stay under the bulk threshold. A candidate is a note that could
      // produce a row: dated IN the window (topic-passing), OR out-of-window but
      // topic-matching (the stale-date case — a note's file date is old but its body may
      // carry a dated event in the window; see below).
      type Cand = { f: string; text: string; di: { ms: number; source: DateSource } | null; inWindow: boolean };
      const frontByDate = new Map<string, number>();
      const cands: Cand[] = [];
      for (const f of t.files) {
        if (f.startsWith('System/') || /(^|\/)Raw\//.test(f) || t.archived.has(f) || !canRead(agent, f)) continue;
        const text = t.texts.get(f) || '';
        const di = noteDateInfo(f, text);
        const inWindow = !!di && di.ms >= period.fromMs && di.ms <= period.toMs;
        if (inWindow && di!.source === 'front') { const d = isoDay(di!.ms); frontByDate.set(d, (frontByDate.get(d) ?? 0) + 1); }
        const passTopic = topic.length === 0 ? true : topicMatch(f, text);
        if (inWindow && passTopic) cands.push({ f, text, di, inWindow: true });
        else if (!inWindow && topic.length > 0 && topicMatch(f, text)) cands.push({ f, text, di, inWindow: false });
      }
      const bulkDates = new Set([...frontByDate].filter(([, c]) => c >= 8).map(([d]) => d));
      const isBulkFront = (di: { ms: number; source: DateSource } | null, inWindow: boolean) => inWindow && !!di && di.source === 'front' && bulkDates.has(isoDay(di.ms));

      // EVENT-TIME rescue/promotion: a note's file date is document-time; the real
      // movement is often a dated event in its PROSE while the file date is stale
      // or bulk-restamped. Scan ONLY the outcome-changing set — bulk-in-window
      // notes (a body event promotes them out of [bulk]) and out-of-window
      // topic-matches (a body event is their only path in) — freshest-first,
      // hard-capped, so a common-topic query can't scan the whole vault. Body
      // events are bounded to [fromMs, now] (drops a future/deadline date).
      const MAX_BODY_SCANS = 400;
      const scanSet = cands
        .filter((c) => (c.inWindow && isBulkFront(c.di, true)) || !c.inWindow)
        .sort((a, b) => (b.di?.ms ?? 0) - (a.di?.ms ?? 0))
        .slice(0, MAX_BODY_SCANS);
      const eventsByPath = new Map<string, BodyEvent[]>();
      for (const c of scanSet) {
        const ev = bodyEventDates(c.text, period.fromMs, now);
        if (ev.length) eventsByPath.set(c.f, ev);
      }

      // Build rows. Tiers, NOTHING hidden: tier 0 = real activity (a dated
      // artifact log/memory, OR a note with an in-window dated event in its body)
      // → tier 1 = a note on its own distinct front date → tier 2 = bulk-touched
      // (a shared edit date, flagged [bulk], read to judge).
      type Row = { path: string; title: string; rowMs: number; date: string; tier: number; kind: 'artifact' | 'event' | 'front' | 'bulk'; annot: string };
      const eventAnnot = (e: BodyEvent) => `  ⟨in note: ${e.iso} — "${e.snippet}"⟩`;
      const rows: Row[] = [];
      for (const c of cands) {
        const ev = eventsByPath.get(c.f);
        const title = noteTitle(c.f, c.text);
        if (!c.inWindow) {
          if (!ev) continue; // rescue ONLY if a real in-window body event exists
          rows.push({ path: c.f, title, rowMs: ev[0].ms, date: ev[0].iso, tier: 0, kind: 'event', annot: eventAnnot(ev[0]) });
          continue;
        }
        const di = c.di!;
        const bulk = isBulkFront(di, true);
        if (bulk && ev) {
          const rowMs = Math.max(di.ms, ev[0].ms); // show the newer of the real edit / the body event
          rows.push({ path: c.f, title, rowMs, date: isoDay(rowMs), tier: 0, kind: 'event', annot: eventAnnot(ev[0]) });
        } else if (di.source !== 'front') {
          rows.push({ path: c.f, title, rowMs: di.ms, date: isoDay(di.ms), tier: 0, kind: 'artifact', annot: '' });
        } else if (!bulk) {
          rows.push({ path: c.f, title, rowMs: di.ms, date: isoDay(di.ms), tier: 1, kind: 'front', annot: '' });
        } else {
          rows.push({ path: c.f, title, rowMs: di.ms, date: isoDay(di.ms), tier: 2, kind: 'bulk', annot: '  [bulk]' });
        }
      }
      // tier asc, then newest first; within a tier a dated artifact ranks above a
      // prose-event note at the same date (the filename date is stronger evidence).
      const kindRank = (k: Row['kind']) => (k === 'artifact' ? 0 : 1);
      rows.sort((a, b) => a.tier - b.tier || b.rowMs - a.rowMs || kindRank(a.kind) - kindRank(b.kind));
      const out = rows.slice(0, limit ?? 40);

      const shownBulk = [...new Set(out.filter((r) => r.kind === 'bulk').map((r) => r.date))];
      const eventNote = out.some((r) => r.kind === 'event')
        ? `\n(Notes marked ⟨in note: DATE⟩ carry a dated event in their body within the window even though the file itself is older or bulk-stamped — real movement recorded in prose; read them to confirm the detail.)`
        : '';
      const bulkNote = shownBulk.length
        ? `\n(Heads-up: ${shownBulk.join(', ')} is shared by many notes, so it is likely a bulk vault edit — those are flagged [bulk]. That does NOT mean nothing happened: a note can be both bulk-edited AND really worked on that day. For "what MOVED", READ each flagged note and judge by whether its body describes a real dated event.)`
        : '';
      const header = `${out.length} note${out.length === 1 ? '' : 's'} with activity in ${period.label}${topic.length ? ` matching ${topic.join('/')}` : ''}, real activity first. Read the ones you need with read_note.${eventNote}${bulkNote}`;
      const lines = out.map((r) => `${r.date}  ${r.path}  — ${r.title}${r.annot}`);
      return { content: [{ type: 'text', text: out.length ? `${header}\n\n${lines.join('\n')}` : `No notes with activity in ${period.label}${topic.length ? ` matching ${topic.join('/')}` : ''}. Try a wider window or recall/search.` }] };
    },
  );

  server.registerTool(
    'gather',
    {
      title: 'Gather rich context on a topic',
      description:
        'Assemble a CONTEXT PACK for a topic/project: the most relevant notes with their PATHS, dates, and a real excerpt of each — so you get broad context in ONE call, then read_note / fetch_document the ones you need in full. Use for "brief me on X", "what\'s the status of / pending on X", "get me up to speed on X". Broader than recall (a focused answer) and richer than search (thin snippets).',
      inputSchema: {
        topic: z.string().describe('The topic, project, client, or area to gather context on'),
        limit: z.number().optional().describe('How many notes to pack (default 12, max 25)'),
      },
    },
    async ({ topic, limit }) => {
      const t = await getTexts();
      const n = Math.min(Math.max(limit ?? 12, 1), 25);
      const hits = searchNotes(topic, t, n, (f) => canRead(agent, f));
      if (!hits.length) return { content: [{ type: 'text', text: `No notes found for "${topic}". Try recall, or different terms.` }] };
      const terms = topic.toLowerCase().match(/[a-z0-9]{3,}/g) || [];
      const excerpt = (text: string): string => {
        const body = text.replace(/^﻿?---[\s\S]*?\n---\r?\n?/, ''); // drop frontmatter (BOM-tolerant)
        const low = body.toLowerCase();
        let at = -1;
        for (const w of terms) { const p = low.indexOf(w); if (p >= 0 && (at < 0 || p < at)) at = p; }
        const start = at < 0 ? 0 : Math.max(0, body.lastIndexOf('\n', at) + 1);
        return body.slice(start, start + 480).replace(/\s+/g, ' ').trim();
      };
      const packed = hits
        .map((h) => {
          const text = t.texts.get(h.path) || '';
          const d = noteDateMs(h.path, text);
          return `● ${h.path}${d ? `  (${new Date(d).toISOString().slice(0, 10)})` : ''}\n  ${excerpt(text)}`;
        })
        .join('\n\n');
      return {
        content: [{ type: 'text', text: `${hits.length} most relevant notes for "${topic}" — read the ones you need in full with read_note or fetch_document:\n\n${packed}` }],
      };
    },
  );

  server.registerTool(
    'skills',
    {
      title: 'List the brain\'s skills',
      description:
        'The reusable SKILLS this brain carries — a skill is a packaged how-to the AI follows end-to-end (draft a proposal, build a client POC, prep for a meeting, etc.). Because they live in the vault, Callosium serves them to ANY connected AI: a skill authored in one assistant (Claude) works in another (ChatGPT/Gemini). Call this to see what is available, then read_note the skill\'s SKILL.md to follow it.',
      inputSchema: {},
    },
    async () => {
      const t = await getTexts();
      const skills: { name: string; path: string; description: string }[] = [];
      for (const f of t.files) {
        const seg = f.split('/');
        // A skill = <…>/Skills/<name>/SKILL.md — the grandparent folder must be a
        // "Skills" partition. This excludes vendored library skills filed
        // elsewhere (e.g. "GSAP Skills/…/SKILL.md"), which are reference material,
        // not the user's own skills — counting those over-reported 22 vs 14.
        if (seg[seg.length - 1].toLowerCase() !== 'skill.md') continue;
        if ((seg[seg.length - 3] || '').toLowerCase() !== 'skills') continue;
        if (!canRead(agent, f)) continue;
        const text = t.texts.get(f) || '';
        const fm = text.match(/^---\n([\s\S]*?)\n---/);
        const block = fm ? fm[1] : text.slice(0, 800);
        const name = (block.match(/^name:\s*["']?(.+?)["']?\s*$/im)?.[1] || f.split('/').slice(-2, -1)[0] || '').trim();
        // description may be a folded/literal YAML block (>- or |) spanning
        // indented lines; gather them until the next top-level key.
        let desc = '';
        const lines = block.split('\n');
        const di = lines.findIndex((l) => /^description:/i.test(l));
        if (di >= 0) {
          const inline = lines[di].replace(/^description:\s*/i, '').trim();
          if (inline && !/^[|>]/.test(inline)) desc = inline.replace(/^["']|["']$/g, '');
          else {
            // Folded/literal block: gather indented lines, tolerating blank lines
            // WITHIN it (a blank doesn't end a folded scalar); stop at the next
            // top-level key (a non-empty, non-indented line).
            const body: string[] = [];
            for (let j = di + 1; j < lines.length; j++) { const ln = lines[j]; if (ln.trim() !== '' && !/^\s/.test(ln)) break; if (ln.trim()) body.push(ln.trim()); }
            desc = body.join(' ');
          }
        }
        skills.push({ name, path: f, description: desc.slice(0, 280) });
      }
      if (!skills.length) {
        return { content: [{ type: 'text', text: 'No skills in this brain yet. A skill is a SKILL.md the brain carries (e.g. under a Skills/ folder); once filed, it works in any AI connected over Callosium.' }] };
      }
      skills.sort((a, b) => a.name.localeCompare(b.name));
      return { content: [{ type: 'text', text: `${skills.length} skills available — read the SKILL.md to follow one:\n\n${skills.map((s) => `● ${s.name}\n  ${s.description}\n  → read_note "${s.path}"`).join('\n\n')}` }] };
    },
  );

  server.registerTool(
    'resolve',
    {
      title: 'Resolve an entity name',
      description:
        'Resolve a name/alias to its canonical note ("Makoto" → the note that owns that alias). Call before creating any entity note, and when the user references something by a nickname.',
      inputSchema: { name: z.string() },
    },
    async ({ name }) => {
      const t = await getTexts();
      const { nameMap } = buildNameMap(notesWithAliases(t));
      const hit = resolveEntity(nameMap, name);
      const visible = hit.exists && canRead(agent, hit.canonical!);
      if (visible) {
        return { content: [{ type: 'text', text: JSON.stringify({ exists: true, canonical: hit.canonical }) }] };
      }
      // fuzzy fallback: voice-typos ("micro"→Microsoft) resolve against entity names
      const idx = ensureRankIndex(t, null);
      const near = fuzzyEntity(idx.entityNames, name.toLowerCase().trim())
        .filter((h) => canRead(agent, h.path))
        .map((h) => ({ name: h.name, path: h.path, edits: h.edits }));
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              near.length
                ? { exists: false, nearMatches: near, note: 'no exact note — nearMatches are likely voice-typo/misspelling targets; confirm with the user before creating anything' }
                : { exists: false, note: 'no note owns this name — safe to create' },
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    'read_note',
    {
      title: 'Read a note',
      description:
        'Read one note by its path relative to the brain root. Small notes return whole. For a LARGE note (a long reference doc), reading it whole floods your context — pass { section: "<heading>" } to read one section, or { offset, limit } to page through characters. With neither, a large note returns its outline (headings + offsets) + opening so you can pick what to read. When you deliberately need the ENTIRE document to rewrite or edit it, pass { whole: true } to override the guard and get the full text.',
      inputSchema: {
        path: z.string(),
        section: z.string().optional().describe('Return only this heading\'s section (exact heading match, else substring).'),
        offset: z.number().int().min(0).optional().describe('Start character offset for a ranged read.'),
        limit: z.number().int().min(1).optional().describe('Max characters to return from offset (default 12000).'),
        whole: z.boolean().optional().describe('Return the ENTIRE note verbatim even if large — for editing/rewriting a whole document. Ignored if section/offset/limit is set.'),
      },
    },
    async ({ path, section, offset, limit, whole }) => {
      if (!canRead(agent, path)) deny(path, 'read');
      const raw = await vault.readFileRetry(path);
      act('read', path);
      return { content: [{ type: 'text', text: noteView(raw, { section, offset, limit, whole }) }] };
    },
  );

  // ── fetch_document: whole-document / whole-folder assembly ─────────────────
  // The proposal-edit job the architecture review flagged: recall() returns
  // capped SECTIONS, read_note returns ONE note — neither hands back a full
  // multi-file document (a proposal split across a folder) ready to edit. This
  // returns every note under a folder (or a single note) IN FULL, in stable path
  // order, each fenced with its path header, scope-filtered like everything else.
  // A total-size guard keeps a runaway folder from flooding the window: past the
  // cap it lists the remaining notes' paths + sizes instead of their bodies, so
  // the caller can fetch_document the sub-folders. Never a hard filter, never
  // lossy silently — it always tells you exactly what it did and didn't include.
  //
  // A budget is only a guard if it has BOTH ends. maxChars had a floor (min 1000)
  // and no ceiling, so one call with maxChars: 50_000_000 defeated it entirely and
  // read EVERY readable note under the folder off disk into a single reply string —
  // measured: a 10-note folder came back as one 385k-char response with nothing
  // deferred. Clamp rather than reject (an agent asking for "everything" should get
  // as much as is sane, not an error) and say so in the header, because this tool's
  // contract is that it never quietly gives you less than it claims.
  const MAX_FETCH_CHARS = 400_000; // ~100k tokens; past this, fetch the sub-folders
  server.registerTool(
    'fetch_document',
    {
      title: 'Fetch a whole document or folder',
      description:
        'Return the FULL text of a note, or of EVERY note under a folder, concatenated in path order — for rewriting/editing a complete document that may span several files. Pass a note path for one whole note, or a folder path for the whole folder. Large results are capped: notes past the character budget are listed (path + size) instead of inlined, so fetch a sub-folder for those. Use this over read_note when you need everything, not a section.',
      inputSchema: {
        path: z.string().describe('A note path (whole note) or a folder path (every note under it).'),
        maxChars: z.number().int().min(1000).optional().describe('Total character budget for inlined bodies (default 60000, capped at 400000). Notes past it are listed, not inlined.'),
      },
    },
    async ({ path: p, maxChars }) => {
      const asked = maxChars ?? 60000;
      const budget = Math.min(asked, MAX_FETCH_CHARS);
      // Only translate backslashes for the scope check — do NOT strip a leading
      // slash first (that would defeat canRead's hard-deny on absolute paths and
      // diverge from read_note, which validates the raw path). canRead/readFile
      // both re-normalize internally, so the single-note branch checks and reads
      // the SAME string the user gave. `norm` (slashes trimmed) is used only for
      // the folder-prefix comparison, where per-note canRead is the real gate.
      const cleaned = p.replace(/\\/g, '/');
      const norm = cleaned.replace(/^\/+|\/+$/g, '');
      // Single note?
      if (cleaned.endsWith('.md')) {
        if (!canRead(agent, cleaned)) deny(cleaned, 'read');
        const raw = await vault.readFileRetry(cleaned);
        act('read', cleaned);
        return { content: [{ type: 'text', text: `=== ${norm} (${raw.length} chars) ===\n${raw}` }] };
      }
      // Folder: every readable note whose path is inside it.
      const prefix = norm ? norm + '/' : '';
      const all = (await vault.listNotes())
        .filter((f) => (prefix ? f.startsWith(prefix) : true) && canRead(agent, f))
        .sort();
      if (!all.length) {
        return { content: [{ type: 'text', text: `[No readable notes under "${p}". Check the folder path (list_notes to see the tree).]` }] };
      }
      // A single pathological note (a multi-GB file synced in) must not be read
      // wholesale into memory just to be deferred — stat first and skip anything
      // over a hard byte cap WITHOUT reading it. Budget accounting still uses the
      // real char length (bytes≠chars for Arabic, so stat is only the safety cap,
      // never the budget decision — else multibyte notes would defer early).
      const PER_FILE_HARD_CAP = 5_000_000; // bytes
      const parts: string[] = [];
      const deferred: string[] = [];
      let used = 0;
      for (const f of all) {
        let size: number | null = 0;
        try { size = await vault.statSize(f); } catch { size = 0; /* fall through to read */ }
        if ((size ?? 0) > PER_FILE_HARD_CAP) {
          deferred.push(`- ${f} (${size} bytes — over the ${PER_FILE_HARD_CAP}-byte per-file cap)`);
          continue;
        }
        // Budget already spent: DON'T read the rest off disk just to list them.
        // Defer by the stat size we already have. Reading every remaining note in a
        // huge folder to produce a ~budget-sized reply is the exact runaway the budget
        // exists to prevent — the cap bounded the reply, not the disk reads.
        if (parts.length > 0 && used >= budget) {
          deferred.push(`- ${f} (${size ?? 0} bytes)`);
          continue;
        }
        // Fail OPEN per note: a note deleted/renamed by a sync client mid-loop
        // (the exact transient the vault layer is built around) must defer that
        // one note, never throw away the whole assembled document (fail-closed).
        let raw: string;
        try {
          raw = await vault.readFileRetry(f);
        } catch (e) {
          deferred.push(`- ${f} (unreadable — ${(e as NodeJS.ErrnoException)?.code ?? 'error'})`);
          continue;
        }
        if (used + raw.length > budget && parts.length > 0) {
          deferred.push(`- ${f} (${raw.length} chars)`);
          continue;
        }
        parts.push(`=== ${f} (${raw.length} chars) ===\n${raw}`);
        used += raw.length;
      }
      let head = `[FOLDER "${norm || '/'}" — ${all.length} note(s), ${parts.length} inlined in full below`;
      head += deferred.length
        ? `, ${deferred.length} deferred (over the ${budget}-char budget). Fetch these individually or fetch their sub-folder:]\n${deferred.join('\n')}\n`
        : `.]`;
      if (asked > budget) head += `\n(maxChars ${asked} is above the ${MAX_FETCH_CHARS}-char per-call ceiling, so ${budget} was used — fetch the sub-folders for anything deferred.)`;
      // Folder read: log the folder as DETAIL, not path — a trailing-slash path yields a name-less,
      // mis-clickable activity-feed row (the note-jump has no note to open).
      act('read', undefined, norm ? `${norm}/` : '(root)');
      return { content: [{ type: 'text', text: `${head}\n\n${parts.join('\n\n')}` }] };
    },
  );

  server.registerTool(
    'write_note',
    {
      title: 'Write a note',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      description:
        'Create or update a note. Filing rules route new typed notes; attribution is stamped server-side. Writing to a path that ALREADY EXISTS is refused unless overwrite:true — use append_note to add safely, or pass overwrite:true to deliberately replace the body. For new entity notes, entity resolution runs first — if the entity already exists you get its canonical path back instead of a duplicate.',
      inputSchema: {
        path: z.string().optional().describe('Explicit path; omit to let filing rules route a new note'),
        type: z.string().optional().describe('Note type for routing when path is omitted'),
        title: z.string().optional().describe('Title for routing when path is omitted'),
        content: z.string().describe('Markdown body (frontmatter added/merged automatically)'),
        // Without this parameter every AI-written note was stamped `tags: []`, which
        // the brain's own health check then flags forever. Callers were already
        // passing `tags` and it was silently dropped, because an argument absent from
        // the schema never reaches the handler.
        tags: z
          .array(z.string())
          .optional()
          .describe('3-6 lowercase topic tags a future search would actually use. Strongly recommended on every new note: a note with no tags carries no retrievable topic and the brain flags it as unhealthy.'),
        overwrite: z
          .boolean()
          .optional()
          .describe('Set true to intentionally replace an existing note body. Without it, writing to a path that already exists is refused so nothing is silently lost. Prefer append_note to add to a note.'),
      },
    },
    async ({ path, type, title, content, tags, overwrite }) => {
      // Defang any attribution marker the agent smuggled into the body — it would
      // otherwise render in the dashboard as a forged authorship badge (see
      // defangAttribution). Applied once at entry so every write path is covered.
      content = defangAttribution(content);
      // Same reason move_note refuses a non-.md destination: listNotes() only yields
      // *.md, so a file written anywhere else is invisible to texts, the graph,
      // recall, search and health — a write that silently produces nothing findable.
      // Only the EXPLICIT path can be wrong here; the routed path is built from the
      // schema and always carries the extension.
      if (path && !/\.md$/i.test(path)) {
        throw new Error(`write_note: "path" must end in .md — "${path}" would not be readable as a note.`);
      }
      let target = path;
      let routeReason = 'explicit path';
      if (!target) {
        if (!type || !title) throw new Error('write_note needs either path, or type + title for routing.');
        const entity = resolveEntity(
          buildNameMap(notesWithAliases(await getTexts())).nameMap,
          title,
        );
        if (entity.exists && canRead(agent, entity.canonical!)) {
          return {
            content: [
              {
                type: 'text',
                text: `NOT created: "${title}" already exists as ${entity.canonical}. Update that note instead (entity resolution).`,
              },
            ],
          };
        }
        if (entity.exists) {
          // Exists but is OUT of this agent's scope. We must not reveal it (that
          // would leak a restricted note's existence), so we fall through and
          // create a scoped duplicate — but log it server-side so the owner can
          // reconcile the two entity notes later.
          console.warn(`[callosium] ${agent.id} created a likely duplicate of out-of-scope entity "${title}" (canonical: ${entity.canonical}) — reconcile in the dashboard.`);
        }
        const route = routeNote(schema, { type, title, source: agent.displayName });
        target = route.path;
        routeReason = route.reason;
      }
      if (!canWrite(agent, target)) deny(target, 'write');

      // Serialize the whole read-modify-write on this path so a concurrent
      // writer can't read the same content and clobber this change.
      const result = await vault.withLock(target!, async () => {
        const exists = vault.exists(target!);
        // Guard against silent overwrite (the data-loss failure mode): an agent
        // that means to CREATE at an existing path, or re-runs a write, gets a
        // clear stop instead of a replaced body. Intentional edits pass
        // overwrite:true; additive edits use append_note (which never destroys).
        if (exists && !overwrite) return { refused: true as const };
        const existing = exists ? parseNote(target!, await vault.readFileRetry(target!)) : null;
        // Sanitize `type` before it goes into the frontmatter template: a value
        // like "reference\ncreated_by: <human>" would otherwise inject extra
        // frontmatter lines (forged attribution) into a brand-new note.
        const safeType = String(type ?? 'reference').replace(/[\r\n].*/s, '').trim() || 'reference';
        // Seed real tags when the caller supplied them. `tags: []` was the old
        // unconditional default, and nothing in the product could repair it
        // afterwards, so a note born empty stayed empty and stayed flagged.
        const seedTags = Array.isArray(tags)
          ? [...new Set(tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean))]
          : [];
        // BL-8 part 3 (refuse an untagged create) was implemented here and REVERTED:
        // it broke 5 existing tests. A hard throw is the wrong instrument — plenty of
        // legitimate callers create a note and set frontmatter afterwards, and turning
        // that into an error three days before launch trades a cosmetic health finding
        // for a broken write path. Parts 1 and 2 already solve the real problem: tags
        // CAN now be supplied on create, and an existing `tags: []` CAN now be repaired.
        // The right shape for part 3 is a soft signal in the response (or a nudge in the
        // agent rules), not a refusal — post-launch, with the tests updated deliberately.
        const seedTagLine = seedTags.length ? `tags: [${seedTags.join(', ')}]` : 'tags: []';
        const note = existing ?? parseNote(target!, content.startsWith('---') ? content : `---\ntype: ${safeType}\n${seedTagLine}\nstatus: active\nupdated: ${isoDate()}\n---\n\n${content}`);
        if (existing) {
          // Strip a caller-supplied frontmatter block from content before it
          // becomes the body — otherwise an update whose content starts with
          // `---...---` embeds a SECOND frontmatter block, which corrupts the note
          // on the next read. The note's frontmatter stays server-managed; only
          // the body is replaced. (Malformed block → kept as body; the rawFile
          // forgery guard below still governs the whole note.)
          const incoming = content.startsWith('---') ? parseNote(target!, content) : null;
          note.body = incoming && !incoming.rawFile ? incoming.body : content;
          // MERGE the caller's frontmatter over the note's, instead of discarding it.
          // Discarding it made `tags: []` unrepairable through the product: the AI
          // writes a note, brain_check flags it in the same session, the Health
          // screen's own remedy prompt tells the AI to add the missing fields, this
          // path answers "Updated" — and nothing changed. No other tool can do it
          // either (append_note only appends to the body; archive_note only sets
          // status), so the note stayed invalid forever.
          // Identity stays server-owned: created_by/updated_by/created are dropped
          // before the merge, so this cannot become a forgery route — the restamp
          // below (see "agent content can never forge created_by/updated_by") is
          // still the only writer of those.
          if (incoming && !incoming.rawFile && incoming.frontmatter) {
            const caller = { ...(incoming.frontmatter as Record<string, unknown>) };
            delete caller.created_by;
            delete caller.updated_by;
            delete caller.created;
            note.frontmatter = { ...note.frontmatter, ...caller };
          }
        }
        // Attribution forgery guard: a rawFile note serializes VERBATIM and
        // skips stamping, so an agent could ship "---\n...\ncreated_by: <human>"
        // with deliberately-malformed YAML (parseNote falls back to rawFile) and
        // forge authorship. Reject rather than trust: agent content must parse.
        if (note.rawFile) {
          if (existing?.noFrontmatter) {
            // If the agent's CONTENT is itself a malformed --- block, refuse — wrapping the legacy note
            // around it would emit a DOUBLE-frontmatter file (the structured-note path already refuses
            // the same input). Valid --- content had its block stripped into note.body above.
            if (content.startsWith('---') && parseNote(target!, content).rawFile) {
              throw new Error('write_note: your content starts with a --- block whose YAML did not parse. Omit frontmatter (it is added automatically) or fix the block.');
            }
            // ADOPT a legacy note that has NO frontmatter block (nothing to forge): give it a real
            // server-managed frontmatter, keeping the new body. Most of an adopted Obsidian vault is
            // these plain notes — refusing them made the whole vault agent-unwritable.
            note.rawFile = false;
            note.frontmatter = { type: safeType, tags: [], status: 'active' };
          } else {
            // A PRESENT-but-malformed `---` block: refuse. It serializes verbatim, so an agent could
            // ship deliberately-broken YAML carrying forged created_by/updated_by lines.
            throw new Error(
              'write_note: this note has a --- block whose YAML did not parse, so it can not be safely rewritten (its attribution would be lost or forgeable). Fix the frontmatter or delete the block. A brand-new note needs no frontmatter — it is added automatically.',
            );
          }
        }
        // Server-stamped attribution: from the authenticated connection, never
        // from tool input. Capture the REAL prior author (note aliases existing,
        // so read it before deleting), strip any agent-supplied attribution,
        // then restamp — agent content can never forge created_by/updated_by.
        const priorAuthor = exists ? existing!.frontmatter.created_by : undefined;
        delete note.frontmatter.created_by;
        delete note.frontmatter.updated_by;
        // A brand-new note, or a just-adopted no-frontmatter note, is stamped to this agent. An
        // EXISTING structured note keeps its real prior author — and if it never had one, we leave it
        // absent (never fabricate created_by for a note that had none — that's the forgery guard).
        note.frontmatter.created_by = !exists || existing!.noFrontmatter ? agent.displayName : priorAuthor;
        if (note.frontmatter.created_by === undefined) delete note.frontmatter.created_by;
        note.frontmatter.updated_by = agent.displayName;
        note.frontmatter.updated = isoDate();
        // Let this note's previous snapshot finish before we change the bytes it is
        // about to read, so its version isn't overwritten by ours (snapshot barrier).
        await settleVersion(vault, target!);
        await vault.writeFile(target!, serializeNote(note));
        version(target!);
        act('write', target!);
        return { exists, note };
      });
      if ('refused' in result) {
        return {
          content: [
            {
              type: 'text',
              text: `NOT written: a note already exists at "${target}". To ADD to it, use append_note (it never destroys existing content). To intentionally REPLACE its body, call write_note again with overwrite: true. Refusing to overwrite silently so nothing is lost.`,
            },
          ],
        };
      }
      const { exists, note } = result;
      invalidate();
      // Link suggestions: known entities mentioned as plain text but not
      // wikilinked — this is how every note stays graph-linked without
      // trusting agent discipline.
      const suggestions = await suggestLinks(target, note.body);
      // If the note landed in a topic that already has a map-of-content, tell the
      // AI to wire it in THIS turn. The code keeps the DERIVED map live; hub
      // membership is authored by the AI (structuring is the LLM's job, not code's).
      let structureHint = '';
      if (!exists) {
        try {
          const fresh = await getTexts(); // cached: suggestLinks already reloaded (incl. this note)
          // Scope the nudge to hubs this agent can READ — never disclose a hub
          // outside its scope or point it at an append it isn't allowed to do
          // (matches suggestLinks + get_map, which are both scope-filtered).
          const hub = hubForNote(target!, fresh, (p) => canRead(agent, p));
          const title = target!.split('/').pop()!.replace(/\.md$/, '');
          if (hub && hub.toLowerCase() !== title.toLowerCase()) {
            structureHint = `\nMAP UPDATE REQUIRED (do it THIS turn) — this note's area has a map [[${hub}]]. You MUST link [[${title}]] into it now via append_note so the note is reachable, not just reaching. If you created a NEW folder, subfolder, or hierarchy for this note, you MUST ALSO add a map note inside that new folder (type: moc, named "<Folder> Home") and link it into [[${hub}]]. An unmapped note or folder is invisible to every future session.`;
          }
        } catch {
          /* best-effort: get_map is always live regardless of the persisted file */
        }
      }
      return {
        content: [
          {
            type: 'text',
            text:
              `${exists ? 'Updated' : 'Created'}: ${target} (${routeReason}; attribution: ${agent.displayName})` +
              (suggestions.length
                ? `\nLINK SUGGESTIONS — these known entities are mentioned but not [[linked]]; update the note to link them: ${suggestions.map((s) => `[[${s}]]`).join(', ')}`
                : '') +
              structureHint,
          },
        ],
      };
    },
  );

  // Known-entity names mentioned in plain text but not wikilinked.
  async function suggestLinks(selfPath: string, body: string): Promise<string[]> {
    const t = await getTexts();
    const lower = body.toLowerCase();
    const out: string[] = [];
    for (const f of t.files) {
      if (f === selfPath || !canRead(agent, f)) continue;
      if (!/^(People|Initiatives|Work)\//.test(f) || f.split('/').length > 3) continue;
      const name = f.split('/').pop()!.replace(/\.md$/, '');
      if (name.length < 4) continue;
      const idx = lower.indexOf(name.toLowerCase());
      if (idx === -1) continue;
      // already linked? look for [[ right before any occurrence
      if (body.slice(Math.max(0, idx - 2), idx) === '[[') continue;
      out.push(name);
      if (out.length >= 5) break;
    }
    return out;
  }

  server.registerTool(
    'append_note',
    {
      title: 'Append to a note',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      description:
        'ADDITIVE edit: appends content to a note (under a specific heading if given, else at the end). Prefer this over write_note for adding facts to an existing note — it can never destroy what is already there.',
      inputSchema: {
        path: z.string(),
        content: z.string().describe('Markdown to append'),
        heading: z.string().optional().describe('Append inside this section instead of at the end'),
      },
    },
    async ({ path, content, heading }) => {
      if (!canWrite(agent, path)) deny(path, 'write');
      await vault.withLock(path, async () => {
        if (!vault.exists(path)) throw new Error(`No such note: ${path}. Use write_note to create.`);
        const note = parseNote(path, await vault.readFileRetry(path));
        if (note.rawFile) {
          if (note.noFrontmatter) {
            // ADOPT a legacy no-frontmatter note: wrap it with server frontmatter, KEEP its body, and
            // append below — so an agent can add to a plain adopted-vault note instead of being blocked.
            note.rawFile = false;
            note.frontmatter = { type: 'reference', tags: [], status: 'active' };
          } else {
            // A present-but-malformed --- block serializes verbatim (unstampable / forgeable). Refuse.
            throw new Error(`Cannot append to ${path}: its --- frontmatter block did not parse, so the edit can't be attributed. Fix the block, or have a human edit this note directly.`);
          }
        }
        // Per-BLOCK attribution: an INVISIBLE HTML-comment marker after the block.
        // Obsidian hides it, recall strips it (stripComments in the tokenizer), and
        // the dashboard renders it as a "✍ written by X" badge on that block — so
        // every addition is signed at the paragraph level, not just the note.
        const attrMark = `<!-- ✍ written by ${agent.displayName} on ${isoDate()} -->`;
        const block = `${defangAttribution(content).trim()}\n${attrMark}`;
        if (heading) {
          const re = new RegExp(`^(#{1,4} ${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\n)`, 'mi');
          if (!re.test(note.body)) throw new Error(`Heading "${heading}" not found in ${path}.`);
          // Insert at the END of the section: before the next SAME-OR-HIGHER
          // heading. A deeper subheading (e.g. #### under a ## section) is part of
          // the section, so bound the search to the matched heading's own level.
          const m = note.body.match(re)!;
          const lvl = (m[0].match(/^#+/) ?? ['#'])[0].length;
          const start = note.body.indexOf(m[0]) + m[0].length;
          const rest = note.body.slice(start);
          const next = rest.search(new RegExp(`^#{1,${lvl}} `, 'm'));
          const insertAt = next === -1 ? note.body.length : start + next;
          note.body = note.body.slice(0, insertAt).replace(/\n*$/, '\n') + block + '\n\n' + note.body.slice(insertAt);
        } else {
          note.body = note.body.replace(/\n*$/, '\n\n') + block + '\n';
        }
        note.frontmatter.updated_by = agent.displayName;
        note.frontmatter.updated = isoDate();
        await settleVersion(vault, path); // snapshot barrier — see version() above
        await vault.writeFile(path, serializeNote(note));
        version(path);
      });
      invalidate();
      act('append', path);
      return { content: [{ type: 'text', text: `Appended to ${path}${heading ? ` § ${heading}` : ''} (attribution: ${agent.displayName})` }] };
    },
  );

  server.registerTool(
    'archive_note',
    {
      title: 'Archive a note',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description:
        'Retire a note from recall/search WITHOUT deleting it: sets status: archived with your attribution and reason. Reversible by the owner. Agents can never hard-delete anything.',
      inputSchema: { path: z.string(), reason: z.string().describe('Why this should be retired') },
    },
    async ({ path, reason }) => {
      if (!canWrite(agent, path)) deny(path, 'write');
      await vault.withLock(path, async () => {
        const note = parseNote(path, await vault.readFileRetry(path));
        if (note.rawFile) {
          if (note.noFrontmatter) {
            // ADOPT a legacy no-frontmatter note so it can carry status:archived + attribution.
            note.rawFile = false;
            note.frontmatter = { type: 'reference', tags: [], status: 'active' };
          } else {
            throw new Error(`${path} has a --- block whose YAML did not parse — fix it, or ask the owner to archive this note manually.`);
          }
        }
        note.frontmatter.status = 'archived';
        note.frontmatter.archived_reason = reason;
        note.frontmatter.updated_by = agent.displayName;
        note.frontmatter.updated = isoDate();
        await settleVersion(vault, path); // snapshot barrier — see version() above
        await vault.writeFile(path, serializeNote(note));
        version(path);
      });
      invalidate();
      act('archive', path);
      return { content: [{ type: 'text', text: `Archived ${path} (reversible; reason recorded; attribution: ${agent.displayName})` }] };
    },
  );

  server.registerTool(
    'move_note',
    {
      title: 'Move or rename a note',
      description:
        'Rename or move a note to a new path AND repoint the [[wikilinks]] that pointed at it, so nothing breaks. Both the old and new locations must be within your write scope; refuses to overwrite an existing note. Notes outside your write scope cannot be rewritten — any of those you can READ that still link to the old path are listed back to you rather than left silently dangling; notes outside your read scope are never examined. Every change is versioned (undoable).',
      inputSchema: {
        from: z.string().describe('current note path, e.g. "People/Bob.md"'),
        to: z.string().describe('new note path, include the .md, e.g. "People/Robert.md"'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ from, to }) => {
      if (!canWrite(agent, from)) deny(from, 'write');
      if (!canWrite(agent, to)) deny(to, 'write');
      if (from === to) return { content: [{ type: 'text', text: 'from and to are the same — nothing to move.' }] };
      // Canonical lock key, ASKED OF THE VAULT (vault.lockKeyFor) — never re-derived here.
      // Comparing raw strings misses same-file aliases — case-only ('Bob.md'->'bob.md'), separator
      // ('a/b.md'->'a\\b.md'), './' redundancy, unicode form (NFD vs NFC), a trailing space or dot
      // on win32/darwin — which all collapse to ONE key. If we let those through,
      // writeFile(to)+deleteFile(from) targets a single underlying file (destroying the note), and
      // locking lo then hi would self-deadlock on the identical key, permanently poisoning that
      // note's lock for the process. Refuse clearly instead. A local copy of the derivation is what
      // BROKE this guard once: vault.ts's fold gained NFC + trailing dot/space stripping and the
      // copy here did not, so move_note("People/Café.md" NFD → "People/Café.md" NFC) passed the
      // guard and then hung forever on its own lock. One derivation, one truth.
      const kFrom = vault.lockKeyFor(from);
      const kTo = vault.lockKeyFor(to);
      if (kFrom === kTo) {
        return { content: [{ type: 'text', text: `${from} and ${to} resolve to the same file — many filesystems treat those as identical. Move to a distinctly-named path instead.` }] };
      }
      // A destination without .md is not a note. Vault.listNotes() only yields *.md,
      // so writing there and deleting the source removes the note from texts, the
      // graph, recall, search and health — while this tool reports a successful move
      // and repointWikilinks rewrites every inbound [[link]] to a target that now
      // resolves to nothing. Silent data loss with a success message, so refuse it.
      // The description asks for the extension; agents forget, and forgetting must
      // not cost a note.
      if (!/\.md$/i.test(to)) {
        throw new Error(`move_note: "to" must end in .md — "${to}" is not a note, and moving there would remove it from the brain.`);
      }
      if (!vault.exists(from)) throw new Error(`No such note: ${from}`);
      // Lock BOTH paths in a canonical (sorted) order — sorted by the lock KEY, not the raw string,
      // so two concurrent swap-moves that pass differently-cased/separated aliases still sort to the
      // same order and can't deadlock; hold them across the whole read->write->delete (CAS), and
      // re-check the overwrite guard INSIDE the lock so there's no check-then-act TOCTOU window.
      const [lo, hi] = kFrom < kTo ? [from, to] : [to, from];
      let raw = '';
      await vault.withLock(lo, () =>
        vault.withLock(hi, async () => {
          if (vault.exists(to)) throw new Error(`Already exists: ${to} — move refused so nothing is overwritten. Pick a different name.`);
          // Snapshot barrier on BOTH ends (see version() above): a pending snapshot of
          // `from` must land before we delete it, or that version is lost outright.
          await settleVersion(vault, from);
          await settleVersion(vault, to);
          raw = await vault.readFileRetry(from);
          await vault.writeFile(to, raw);
          await vault.deleteFile(from);
          // Register BOTH snapshots while the locks are still held. Registering them after
          // the locks released (and after the whole repointWikilinks scan) left a window in
          // which the next writer of `to` found nothing pending, wrote underneath our
          // in-flight snapshot, and the moved note's own version was recorded with that
          // writer's bytes under THIS agent's name — the very mis-attribution the barrier
          // exists to prevent.
          version(to);
          version(from); // record the deletion of the old path in history
        }),
      );
      // `version` is handed in so each repointed note is registered inside ITS OWN lock too.
      const { changed, skipped } = await repointWikilinks(vault, agent, from, to, version);
      act('move', to, from);
      invalidate();
      // Report what was actually done. The old wording ("repointed N links across the
      // brain") was true only for a full-scope agent: repointWikilinks silently skips
      // every note outside the caller's WRITE scope, so a scoped agent got a success
      // message while real links were left dangling. Name the leftovers it may read.
      //
      // Nothing here is derived from notes the agent cannot READ — not their paths and
      // NOT THEIR COUNT. "4 more are outside your read scope" told the agent that four
      // notes it is forbidden to open reference this path, and repeating the move under
      // different names would map the private corpus's link structure one query at a
      // time. That is exactly the whole-vault statistic brain_check refuses to spread
      // (see its comment below). The caveat we do give is unconditional on vault
      // content — it fires on the shape of the agent's OWN scope, which it already knows
      // from `overview` — so it is honest without being an oracle.
      const scopedRead = agent.scopes.read.length > 0 || !!agent.scopes.denyRead?.length;
      let text = `Moved ${from} → ${to}; repointed the links in ${changed.length} note${changed.length === 1 ? '' : 's'}. All changes versioned (undoable).`;
      if (skipped.length) {
        text +=
          `\nNOT repointed: ${skipped.length} note${skipped.length === 1 ? '' : 's'} outside your write scope still link${skipped.length === 1 ? 's' : ''} to "${from}", so ${skipped.length === 1 ? 'that link is' : 'those links are'} now dangling. Ask the owner (or an agent with a wider scope) to fix ${skipped.length === 1 ? 'it' : 'them'}.` +
          ` Affected: ${skipped.join(', ')}.`;
      }
      if (scopedRead) {
        text += `\nNotes outside your read scope were not checked, so some of them may still link to "${from}". Ask the owner to sweep for leftovers.`;
      }
      return { content: [{ type: 'text', text }] };
    },
  );

  server.registerTool(
    'overview',
    {
      title: 'Brain overview',
      description:
        'Orient yourself: partitions with note counts, the most recently changed notes, and your access scope. Call at session start or when unsure where things live.',
      inputSchema: {},
    },
    async () => {
      const t = await getTexts();
      const visible = t.files.filter((f) => canRead(agent, f));
      const byPartition = new Map<string, number>();
      for (const f of visible) {
        const top = f.includes('/') ? f.split('/')[0] : '(root)';
        byPartition.set(top, (byPartition.get(top) || 0) + 1);
      }
      const recent = [...visible].sort((a, b) => (t.mtimes.get(b) ?? 0) - (t.mtimes.get(a) ?? 0)).slice(0, 10);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                brain: schema.name, // logical name, not the host's absolute disk path
                schema: schema.name,
                notes: visible.length,
                partitions: Object.fromEntries([...byPartition.entries()].sort((a, b) => b[1] - a[1])),
                recentlyChanged: recent,
                yourScope: { read: agent.scopes.read.length ? agent.scopes.read : 'all', deny: agent.scopes.denyRead ?? [], write: agent.scopes.write.length ? agent.scopes.write : 'same as read' },
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    'remember',
    {
      title: 'Store a memory record',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      description: 'One-step episodic memory record, filed per the schema and stamped with your identity.',
      inputSchema: {
        text: z.string().describe('The distilled fact/summary to store — never raw transcript dumps'),
        title: z.string().describe('Short topic name'),
      },
    },
    async ({ text, title }) => {
      // Defang BOTH params: the first fix covered text only, and a ✍ marker
      // smuggled through `title` landed on the heading line and still rendered
      // as a forged authorship badge (17 Jul re-review).
      title = defangAttribution(title);
      const route = routeNote(schema, { type: 'memory', title, source: agent.displayName });
      if (!canWrite(agent, route.path)) deny(route.path, 'write');
      await vault.withLock(route.path, async () => {
        if (vault.exists(route.path)) throw new Error(`Already exists: ${route.path}`);
        const note = {
          path: route.path,
          frontmatter: { ...route.frontmatter, conversation: title, created_by: agent.displayName, updated_by: agent.displayName },
          // defang like write_note/append_note: an embedded ✍ marker in the
          // text would otherwise render as a forged authorship badge.
          body: `\n# ${title}\n\n${defangAttribution(text)}\n`,
          rawFile: false,
        };
        await settleVersion(vault, route.path); // snapshot barrier — see version() above
        await vault.writeFile(route.path, serializeNote(note));
        version(route.path);
      });
      invalidate();
      act('remember', route.path);
      return { content: [{ type: 'text', text: `Stored: ${route.path}\n(${route.reason})` }] };
    },
  );

  server.registerTool(
    'related',
    {
      title: 'Related notes',
      description: 'Typed graph neighbors of a note (zero-LLM knowledge graph: wikilinks + frontmatter edges).',
      inputSchema: { path: z.string() },
    },
    async ({ path }) => {
      if (!canRead(agent, path)) deny(path, 'read');
      // Existence-filter the graph neighbors: a first-load session serves the
      // persisted graph.json unpruned, so an edge to a note deleted/renamed while
      // the process was down would otherwise be returned as a live neighbor whose
      // read_note then ENOENTs. Drop any neighbor not in the current text set (the
      // same guard the semantic lane already applies).
      const t = await getTexts();
      const rel = scopeFilter(agent, related(await getGraph(), path)).filter((r) => t.texts.has(r.other));
      return { content: [{ type: 'text', text: JSON.stringify(rel, null, 2) }] };
    },
  );

  server.registerTool(
    'brain_check',
    {
      title: 'Audit the brain',
      description: 'Validate the whole brain against its schema: broken links, orphans, frontmatter problems, sync conflicts. Report only, never destructive.',
      inputSchema: {},
    },
    async () => {
      const report = await brainCheck(vault);
      // Scope the audit to what THIS agent can read. Two leaks to close:
      // (1) whole-vault stats (report.notes/edges/byKind) would disclose counts —
      //     including of Private/System — so we do NOT spread the report; we return
      //     only the count of notes inside the agent's read scope.
      // (2) a finding's own path is filtered by scopeFilter, but its DETAIL text can
      //     still name OTHER notes' paths (e.g. a duplicate-alias points at two
      //     notes, one of them out of scope), so redact any out-of-scope path the
      //     detail mentions.
      const files = (await getTexts()).files;
      const outOfScope = files.filter((fp) => !canRead(agent, fp));
      const redact = (s: string) => {
        let out = s;
        for (const p of outOfScope) if (out.includes(p)) out = out.split(p).join('[a note outside your scope]');
        return out;
      };
      const findings = scopeFilter(agent, report.findings)
        // `target` was the one structured field not scope-checked. For a
        // broken-wikilink it is a bare NAME (no slash) and harmless, but the
        // moc-gap check puts a real note PATH there — the hub a note should be
        // linked from — so a restricted agent could read back the path of a note it
        // cannot open. Drop the whole finding rather than blanking the field: its
        // `detail` also spells out that hub's basename, and redact() only rewrites
        // full paths, so the name would survive. An agent simply does not see gaps
        // that are about notes outside its scope.
        .filter((f) => !(f.target && f.target.includes('/') && !canRead(agent, f.target)))
        .slice(0, 200)
        .map((f) => {
          // Redact the free-text detail AND the structured path fields — a
          // finding kept because its PRIMARY path is readable can still carry an
          // out-of-scope sibling in paths[]/related (e.g. a duplicate-alias whose
          // second note is under Private/), which would otherwise leak verbatim.
          const g: typeof f = { ...f };
          if (g.detail) g.detail = redact(g.detail);
          if (Array.isArray(g.paths)) g.paths = g.paths.filter((p) => canRead(agent, p));
          if (g.related && !canRead(agent, g.related)) delete g.related;
          return g;
        });
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            notesInYourScope: files.filter((fp) => canRead(agent, fp)).length,
            findings,
            // A check that could not run is reported, not omitted. Without this an AI reads an
            // empty `findings` as "the brain is clean" and tells the owner so — when the truth may
            // be that their own schema failed to load and nothing was checked against it. The
            // agent is the one talking to the human, so it needs the caveat, not just the result.
            ...(report.skipped.length ? { checksThatDidNotRun: report.skipped } : {}),
            schemaUsed: report.schemaSource,
            note: report.skipped.length
              ? 'counts and findings are limited to the folders you can read — AND some checks did not run (see checksThatDidNotRun). Do not report this brain as clean; say which checks were skipped and why.'
              : 'counts and findings are limited to the folders you can read.',
          }, null, 2),
        }],
      };
    },
  );

  server.registerTool(
    'glossary',
    {
      title: 'Entity glossary',
      description:
        'The brain\'s map of known entities — people, initiatives, clients/projects, and all aliases — so you can link correctly ([[Entity Name]]) and know whether something the user mentions already exists. Consult before creating any entity note or writing notes that reference people/clients/projects.',
      inputSchema: {
        partition: z.string().optional().describe('Limit to one partition prefix, e.g. "People/"'),
      },
    },
    async ({ partition }) => {
      const t = await getTexts();
      const entityPrefixes = ['People/', 'Initiatives/', 'Work/', ...schema.partitions.core.filter((p) => p.path === 'Knowledge').map((p) => p.path + '/')];
      const entries: { name: string; path: string; aliases: string[] }[] = [];
      for (const f of t.files) {
        if (!canRead(agent, f)) continue;
        if (partition && !f.startsWith(partition)) continue;
        if (!partition && !entityPrefixes.some((p) => f.startsWith(p))) continue;
        // anchors and entity notes only: depth ≤ 3, skip raw/meeting subfolders
        if (f.split('/').length > 3 || /\/Raw\//.test(f)) continue;
        entries.push({
          name: f.split('/').pop()!.replace(/\.md$/, ''),
          path: f,
          aliases: aliasesOf(t.texts.get(f) || ''),
        });
      }
      entries.sort((a, b) => a.path.localeCompare(b.path));
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                howToLink: 'Reference entities as [[Name]] wikilinks in every note you write. If an entity the user mentions is NOT in this glossary, resolve() it first; if truly new, create it with write_note (type person/initiative/knowledge) BEFORE linking to it.',
                entities: entries.slice(0, 400),
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    'get_map',
    {
      title: 'Map of the brain',
      description:
        'The routing MAP of this brain — how it is organized and how to navigate it: the top-level structure (what lives in each folder), the topic hubs to start from, and how to find things. READ THIS FIRST when you connect, and whenever you need to know WHERE something is. Generated from the brain\'s real structure and always current.',
      inputSchema: {},
    },
    async () => {
      const t = await getTexts();
      // Persist the FULL map to System/Map.md on every get_map — the structuring
      // flow calls get_map right after it files notes, so the file the vault ships
      // (any LLM's always-on reference) is refreshed exactly when the map is
      // consulted, without rewriting it on every individual write. Best-effort.
      await refreshMapFile(t);
      // Scope the RESPONSE to what this agent may read, so a restricted agent never
      // sees folders it has no access to (canRead governs every returned path).
      const visible: VaultTexts = { ...t, files: t.files.filter((f) => canRead(agent, f)) };
      return { content: [{ type: 'text', text: generateMap(schema, visible) }] };
    },
  );

  server.registerTool(
    'get_filing_rules',
    {
      title: 'Filing rules — where new notes go',
      description:
        'The rules for turning raw material (documents, exports, notes) into filed notes in THIS brain: the partitions and what belongs in each, the routing order, naming, required frontmatter, and the ground-truth protocol for verbatim sources. Call this before filing anything so every note lands in its right home and the map stays true. YOU do the reading and distilling; these rules tell you where each note goes.',
      inputSchema: {},
    },
    async () => {
      // Hide partitions this agent can't read (probe a representative path), so a
      // restricted agent never learns that e.g. a gated Private/ exists — same
      // scope invariant get_map enforces.
      return { content: [{ type: 'text', text: generateFilingRules(schema, (p) => canRead(agent, p + '/_probe.md')) }] };
    },
  );

  server.registerTool(
    'get_instructions',
    {
      title: 'How to use this brain',
      description: 'The operating instructions for agents connected to this brain — replaces per-tool CLAUDE.md files.',
      inputSchema: {},
    },
    async () => {
      const custom = vault.exists('System/Instructions.md') ? await vault.readFileRetry('System/Instructions.md') : null;
      const text =
        custom ??
        [
          `You are connected to a Callosium brain as "${agent.displayName}".`,
          `- FIRST call get_map to learn how this brain is organized and where things live; it is your navigation map. Call get_filing_rules before writing/filing anything new.`,
          `- recall FIRST before answering anything about the owner's world; relay "not in the brain" honestly, relay clarify questions to the user, and mention any typo corrections recall reports.`,
          // The engine's own honesty gate keys on absent VOCABULARY (absentMass counts
          // only terms with df=0), so it catches "who is frimbulator" and cannot catch
          // "what is our refund policy" when every word is in the vault but the answer
          // is not. Measured: negativesRefused 18.8% on the in-domain natural bench.
          // Until the gate can tell answer-absence from word-absence, the reading agent
          // is the honest layer — so say so here, by default, for every user.
          `- JUDGE WHETHER THE NOTES ACTUALLY ANSWER THE QUESTION. recall returns the closest notes it has, which is not the same as the answer existing. If the returned notes only mention the same topic or the same words, but do not actually contain what was asked, say plainly that it is not in the brain yet. Never infer a specific fact — a number, a name, a policy, a date, a preference — from a note that merely discusses the subject. An honest "your notes don't cover this" is always better than a confident answer assembled from adjacent material.`,
          `- COUNT/LIST questions ("how many skills", "what's active") → list_notes/overview, not recall.`,
          `- "WHAT DID I DO / what happened / what moved" over a period (yesterday, last N days, last two weeks, this month) → **recent** (notes DATED in the window, newest first + paths), then read_note. Do NOT use recall/search for these — they rank by topic and surface old notes.`,
          `- "BRIEF ME on X / get me up to speed / what's the status of / pending on X" → **gather** (a context pack: the most relevant notes with paths + excerpts, in one call), then read_note the ones you need in full.`,
          `- A task that matches a saved SKILL (draft a proposal, build a POC, prep a meeting) → call **skills** to see them, then read_note the SKILL.md and follow it. The brain's skills work in any AI, not just the one that made them.`,
          `- Voice-input users mangle entity names (a truncated or misspelled name, e.g. "micro"→"Microsoft"): when a name looks off or recall comes back empty, try resolve() — it returns fuzzy nearMatches.`,
          `- BUILD TASKS ("based on what we know about X, build/draft/implement Y"): recall returns a "richness" block — treat the answer as equipment, not a lookup. read_note the FULL text of every result and every context pointer that looks like reference docs, prior PoCs/proposals (especially their gotchas), or related skills. This is a back-and-forth protocol: whenever you hit a gap mid-build (an API detail, a decision, a constraint you don't have), STOP and recall again with that specific gap as the question — repeat until nothing is missing. Never fill a gap from your own general knowledge when the brain might hold the owner's actual version.`,
          `- Write DISTILLED notes, never raw transcript dumps.`,
          `- Before creating an entity note, write_note with type+title runs entity resolution — trust it when it says the note exists.`,
          `- Your writes are attributed to you (${agent.displayName}) automatically.`,
          `- Your access scope: read=${agent.scopes.read.length ? agent.scopes.read.join(',') : 'all'} deny=${agent.scopes.denyRead?.join(',') || 'none'}.`,
        ].join('\n');
      return { content: [{ type: 'text', text }] };
    },
  );

  return server;
}

/** Serve the brain over HTTP (streamable MCP) for clients that connect by URL +
 *  token instead of a spawned command. Loopback-only, stateless, and every
 *  request is authenticated by its bearer token against the LIVE registry — so a
 *  revoked/rescoped agent takes effect immediately, and each agent sees only its
 *  own scope. Runs the SAME tools as the stdio server via buildServer(). */
export async function serveHttp(opts: {
  brainPath?: string;
  getBrain?: () => string | null;
  port?: number;
  host?: string;
  /** Read the brain through a host that ALREADY holds it loaded, instead of this
   *  endpoint owning a second copy. The dashboard auto-starts this endpoint INSIDE
   *  its own process and passes its cockpit cache, so one loaded brain serves both
   *  surfaces (peak-RAM bound). Omitted → a private cache, as when the owner runs
   *  `callosium mcp --http` standalone. See BrainSource for the contract. */
  brain?: BrainSource;
}): Promise<ServerHandle> {
  const port = opts.port ?? 4321;
  const host = opts.host ?? '127.0.0.1';
  // ONE brain source shared across every request's per-request server (this
  // endpoint serves a single brain). Without it, each stateless request built a
  // cold server and re-walked the entire vault + reloaded embeddings before
  // answering. It self-refreshes on the vault's freshness token, so an external
  // edit is still picked up; only per-request auth stays per-request.
  const brain = opts.brain ?? mcpCacheSource();
  const bearer = (req: http.IncomingMessage): string | null => {
    const h = req.headers['authorization'];
    const m = typeof h === 'string' ? h.match(/^Bearer\s+(.+)$/i) : null;
    return m ? m[1].trim() : null;
  };
  const httpServer = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || host}`);
      if (url.pathname !== '/mcp') { res.writeHead(404).end('not found'); return; }
      const token = bearer(req);
      if (!token) { res.writeHead(401, { 'www-authenticate': 'Bearer' }).end('missing bearer token'); return; }
      // Authenticate against the CURRENT registry on every request — revocation and
      // scope edits from the dashboard take effect with no restart.
      // Resolve the CURRENT brain per request (getBrain) so the endpoint follows
      // a mid-session brain switch instead of serving the vault it booted with —
      // otherwise an HTTP agent would read/write the OLD vault after the cockpit
      // switches. The shared cache self-heals: a new brain yields a new freshness
      // token, which rebuilds it. 503 until a brain is connected (fresh onboarding).
      const bp = opts.getBrain ? opts.getBrain() : opts.brainPath;
      if (!bp) { res.writeHead(503).end('no brain connected'); return; }
      const vault = Vault.open(bp);
      let agent: AgentIdentity;
      try { agent = authenticateByToken(await loadAgents(vault), token); }
      catch { res.writeHead(401).end('bad token'); return; }
      const { schema } = await loadSchema(vault);
      // Read the JSON-RPC body (streamableHttp wants the parsed body for POST).
      let body: unknown;
      if (req.method === 'POST') {
        const chunks: Buffer[] = []; let len = 0;
        for await (const c of req) { chunks.push(c as Buffer); len += (c as Buffer).length; if (len > 4 << 20) { res.writeHead(413).end('too large'); return; } }
        try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined; } catch { res.writeHead(400).end('bad json'); return; }
      }
      // Stateless: a fresh server + transport per request (no cross-request
      // session), but the heavy retrieval state (texts/graph/embeddings) comes
      // from one shared source so we don't re-walk the vault on every request.
      const mcp = await buildServer(vault, agent, schema, brain);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => { transport.close().catch(() => {}); mcp.close().catch(() => {}); });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      if (!res.headersSent) res.writeHead(500).end('server error');
      console.error('callosium mcp http:', (e as Error).message);
    }
  });
  // A bind failure (EADDRINUSE — the user already ran `mcp --http`, or a second
  // instance) must REJECT so the dashboard's fire-and-forget .catch() swallows it.
  // Without an 'error' listener Node re-throws the event as an uncaughtException and
  // takes the whole process down — the opposite of the auto-start's "must not stop
  // the dashboard" intent (dashboard/server.ts). The dashboard's own server wires
  // this same guard.
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => {
      httpServer.removeListener('error', reject);
      resolve();
    });
  });
  console.error(`callosium mcp: serving ${opts.brainPath ? `"${opts.brainPath}" ` : ''}over http://${host}:${port}/mcp (bearer-token auth)`);
  // Hand the caller a way to shut this down. Without one the only exit was
  // process.exit() with the listener still open, which on Windows races libuv into
  // `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` — a native abort, not a
  // catchable error. That aborted a CI run and would equally abort an embedder.
  // closeAllConnections() first: server.close() only stops NEW connections and
  // waits for existing (keep-alive) ones, so a connected agent would hang the exit.
  return {
    async close(): Promise<void> {
      httpServer.closeAllConnections?.();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}
