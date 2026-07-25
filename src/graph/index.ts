// Graph index: build, persist, query. File-first philosophy — the index is
// DERIVED state, rebuildable from the markdown at any time. It lives OUTSIDE
// the brain folder (~/.callosium/cache/<brain-id>/) because brains typically
// sit inside OneDrive/Drive/iCloud: derived state written into the brain
// would sync, churn, and conflict — the exact staleness pain Callosium
// exists to remove. Each device rebuilds its own cache; the markdown stays
// the only source of truth.

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Vault } from '../core/vault.ts';
import { parseNote } from '../core/frontmatter.ts';
import type { Edge, GraphIndex } from '../core/types.ts';
import { EXTRACTOR_VERSION, buildNameMap, extractCandidates, resolveEdges } from './extract.ts';

// Monotonic per-process counter so two concurrent buildGraph() calls never
// collide on the atomic-write temp name (pid alone is not unique in-process).
let graphWriteSeq = 0;

export function cacheDir(vault: Vault): string {
  const brainId = Vault.contentHash(vault.root.toLowerCase());
  return path.join(os.homedir(), '.callosium', 'cache', brainId);
}

function indexFile(vault: Vault): string {
  return path.join(cacheDir(vault), 'graph.json');
}

export interface BuildResult {
  index: GraphIndex;
  collisions: { name: string; paths: string[] }[];
  /** Notes re-extracted this run (vs reused from the previous index). */
  extracted: number;
  reused: number;
}

/** Pre-read note texts (the dashboard's loadTexts output) so a rebuild can
 *  skip re-reading the whole vault from disk: one read feeds texts, graph, and
 *  the health check. Structurally the subset of VaultTexts buildGraph needs,
 *  declared here instead of imported so the graph module stays leaf-level. */
export interface SharedTexts {
  files: string[];
  texts: Map<string, string>;
  /** Notes that failed to read this pass (loadTexts stores '' for them). Carried so buildGraph
   *  treats them as unreadable (prior hash forward), not as EMPTY notes whose edges are dropped. */
  unreadable?: Set<string>;
}

export async function buildGraph(vault: Vault, shared?: SharedTexts): Promise<BuildResult> {
  const previous = await loadGraph(vault);
  const stale =
    !previous || previous.extractorVersion !== EXTRACTOR_VERSION ? null : previous;

  const files = shared ? shared.files : await vault.listNotes();
  const notes: { note: ReturnType<typeof parseNote>; hash: string }[] = [];
  /** Notes we could not read this pass; their prior edges are carried forward verbatim
   *  and no hash is recorded, so the next build re-reads them for real. */
  const unreadable: string[] = [];
  for (const f of files) {
    let raw: string | null = null;
    if (shared) raw = shared.unreadable?.has(f) ? null : (shared.texts.get(f) ?? '');
    else {
      try { raw = await vault.readFileRetry(f); } catch { /* transient lock */ }
    }
    if (raw === null) {
      // Transiently unreadable (a sync lock, an AV scan). It must NOT be indexed as
      // empty. Feeding it forward as parseNote(f,'') with the prior hash looked safe
      // — the hash matches, so the reuse branch fires — but reuse is conditional on
      // stillValid, and when that fails (a link target was renamed) the note fell
      // through to re-extraction FROM THE EMPTY BODY: every edge erased, and the
      // stale hash recorded so it reads as "unchanged" on every later build too. The
      // note became a permanent phantom with no links.
      // Handled out-of-band instead: keep whatever edges we already had, and record
      // NO hash, so the next build treats it as new and genuinely re-reads it.
      unreadable.push(f);
      continue;
    }
    // NFC-normalize before hashing: shared texts come from loadTexts, which
    // NFC-normalizes, so hashing the shared map and hashing our own raw read on
    // the same basis keeps noteHashes stable no matter which caller builds.
    // Without this, NFD-authored notes (macOS/iCloud, Arabic) would flip hashes
    // every time the builder alternates and re-extract on every pass.
    raw = raw.normalize('NFC');
    notes.push({ note: parseNote(f, raw), hash: Vault.contentHash(raw) });
  }

  const { nameMap, collisions, sepMap } = buildNameMap(
    notes.map((n) => ({
      path: n.note.path,
      aliases: Array.isArray(n.note.frontmatter.aliases) ? n.note.frontmatter.aliases.map(String) : [],
    })),
  );

  // Index previous edges by source note, and file existence as a Set, ONCE —
  // the old per-note `stale.edges.filter(...)` + `files.includes(...)` was
  // O(notes × edges), quadratic over the whole vault on every build.
  const fileSet = new Set(files);
  const staleByFrom = new Map<string, Edge[]>();
  if (stale) {
    for (const e of stale.edges) {
      const arr = staleByFrom.get(e.from);
      if (arr) arr.push(e);
      else staleByFrom.set(e.from, [e]);
    }
  }

  const edges: Edge[] = [];
  const noteHashes: Record<string, string> = {};
  let extracted = 0,
    reused = 0;
  // Would a link with this raw text resolve under the CURRENT name map? (mirrors
  // resolveEdges: exact key → .md-stripped → separator-normalized unambiguous.)
  const nameOf = (p: string) => p.split('/').pop()!.replace(/\.md$/, '').toLowerCase();
  const resolvesNow = (toText: string): string | undefined => {
    const key = toText.normalize('NFC').toLowerCase().trim();
    const sk = key.replace(/\\+$/, '').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
    return nameMap.get(key) ?? nameMap.get(key.replace(/\.md$/, '')) ?? sepMap.get(sk);
  };
  for (const { note, hash } of notes) {
    noteHashes[note.path] = hash;
    // Incremental: reuse an unchanged note's edges ONLY when re-extraction would
    // produce the identical resolution. A RESOLVED edge is stable only if the
    // target's basename still maps to that exact path (else a newly-added shallower
    // same-named note re-points it); an UNRESOLVED (broken) edge is stable only if
    // its target STILL can't resolve (else a note was created that should link it).
    if (stale && stale.noteHashes[note.path] === hash) {
      const old = staleByFrom.get(note.path) ?? [];
      const stillValid = old.every((e) => (e.unresolved ? !resolvesNow(e.to) : nameMap.get(nameOf(e.to)) === e.to));
      if (stillValid) {
        edges.push(...old);
        reused++;
        continue;
      }
    }
    edges.push(...resolveEdges(note.path, extractCandidates(note), nameMap, sepMap));
    extracted++;
  }

  // Notes we could not read: keep the edges we already knew about rather than
  // asserting the note has none, and deliberately leave them OUT of noteHashes so the
  // next build sees them as unhashed and re-reads them. Losing a rebuild is cheap;
  // silently erasing a note's links is not.
  for (const f of unreadable) {
    const old = staleByFrom.get(f);
    if (old?.length) edges.push(...old);
  }

  // Nothing re-extracted AND the exact same note set as before → the derived
  // graph is identical. Keep the previous builtAt (so "last indexed" reflects
  // the real last rebuild, not whenever someone merely opened the Health tab,
  // which calls this) and skip the disk write entirely.
  const unchanged =
    !!stale &&
    extracted === 0 &&
    Object.keys(stale.noteHashes).length === notes.length &&
    notes.every((n) => stale.noteHashes[n.note.path] !== undefined);

  const index: GraphIndex = {
    extractorVersion: EXTRACTOR_VERSION,
    builtAt: unchanged ? stale!.builtAt : new Date().toISOString(),
    edges,
    noteHashes,
  };
  if (!unchanged) {
    // Persisting the cache is BEST-EFFORT: a failed write (disk full, a OneDrive/
    // iCloud lock, a read-only volume) must NOT throw out of buildGraph and take
    // recall/health/map down with it — we already hold the fully-built index in
    // memory. Serve it; the next rebuild retries the write.
    try {
      const full = indexFile(vault);
      await fs.mkdir(path.dirname(full), { recursive: true });
      // Atomic: write to a unique temp then rename, so a concurrent build (or a
      // crash mid-write) can never leave a half-written, unparseable graph.json.
      // pid+seq (not pid alone) so two in-process builds can't collide on the temp.
      const tmp = `${full}.tmp-${process.pid}-${graphWriteSeq++}`;
      await fs.writeFile(tmp, JSON.stringify(index), 'utf8');
      await fs.rename(tmp, full);
    } catch (e) {
      console.error('callosium graph: cache write failed (serving in-memory index):', (e as Error).message);
    }
  }
  return { index, collisions, extracted, reused };
}

export async function loadGraph(vault: Vault): Promise<GraphIndex | null> {
  try {
    return JSON.parse(await fs.readFile(indexFile(vault), 'utf8')) as GraphIndex;
  } catch {
    return null;
  }
}

/** Everything connected to a note, both directions, grouped by relation. */
export function related(index: GraphIndex, notePath: string): { type: string; direction: 'out' | 'in'; other: string }[] {
  const out: { type: string; direction: 'out' | 'in'; other: string }[] = [];
  for (const e of index.edges) {
    if (e.unresolved) continue;
    if (e.from === notePath) out.push({ type: e.type, direction: 'out', other: e.to });
    else if (e.to === notePath) out.push({ type: e.type, direction: 'in', other: e.from });
  }
  return out;
}
