// Semantic lane — on-device multilingual embeddings (zero API keys, zero
// cloud). Model: multilingual-e5-small (MIT, 384 dims, strong Arabic —
// chosen because the owner and audience are Arabic speakers: سيارة and car
// must be neighbors). e5 requires "query: "/"passage: " prefixes.
//
// Chunk-level: each note section is a passage with metadata
// {path, heading, date, noteType} — the completeness principle: chunks
// arrive with their provenance. Cache: ~/.callosium/cache/<brain-id>/
// embeddings.json, content-hash incremental + version stamp (graph pattern).

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import { Vault } from '../core/vault.ts';
import { parseNote } from '../core/frontmatter.ts';
import { cacheDir } from '../graph/index.ts';
import { modelProgress as termModelProgress, modelProgressDone as termModelProgressDone } from '../util/term.ts';

// .2: embed backstop slice 1500→2000 — bumped so existing brains re-embed once
// and stop serving tail-truncated vectors from the incremental cache.
export const EMBEDDER_VERSION = 'multilingual-e5-small.2';
const MODEL = 'Xenova/multilingual-e5-small';

/** A short, writable, install-independent model-cache dir, used when
 *  CALLOSIUM_MODEL_DIR is unset or mistyped. %LOCALAPPDATA%\Callosium\models on
 *  Windows (avoids the deep-path MAX_PATH trap that breaks onnxruntime's native
 *  file open), ~/.callosium/models elsewhere. */
function defaultModelDir(): string {
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'Callosium', 'models');
  }
  return path.join(os.homedir(), '.callosium', 'models');
}

export interface ChunkMeta {
  path: string;
  heading: string | null;
  date?: string;
  noteType?: string;
}

export interface EmbeddingIndex {
  version: string;
  dims: number;
  chunks: ChunkMeta[];
  /** Float32 vectors, row-major, normalized — kept as base64 in the JSON. */
  vectors: Float32Array;
  noteHashes: Record<string, string>;
}

/** Thrown when the embedding model can't be loaded (first run offline, blocked
 *  network, disk full). Callers degrade to lexical-only — a core doctrine:
 *  semantic is an upgrade lane, never a gate on the product working. */
export class ModelUnavailableError extends Error {
  constructor(cause: unknown) {
    super(
      'couldn’t get the language model (first run needs ~120MB, one-time). ' +
        'Keyword recall works fully without it — semantic search will enable itself on the next re-index once you’re online. ' +
        `(${(cause as Error)?.message ?? cause})`,
    );
    this.name = 'ModelUnavailableError';
  }
}

/** Optional subscriber for first-run model download progress (the dashboard
 *  ingest stream forwards it to the UI). pct is 0-100 for the big weights file. */
let modelProgressCb: ((pct: number) => void) | null = null;
export function onModelProgress(cb: ((pct: number) => void) | null): void {
  modelProgressCb = cb;
}

let extractor: any = null;
// Memoize the IN-FLIGHT load, not only the result. Indexing fires many embed
// batches at once; without this each concurrent caller entered the load path
// before `extractor` was assigned and kicked off its OWN pipeline() — several
// parallel downloads, N overlapping progress meters (the "0→100 twice" the
// terminal showed), and wasted work. One shared promise = one download, one
// clean progress line.
let extractorP: Promise<any> | null = null;
async function getExtractor() {
  if (extractor) return extractor;
  if (!extractorP) {
    extractorP = (async () => {
      const { pipeline, env } = await import('@huggingface/transformers');
      // Model cache override for portable installs. The default cache lives
      // inside node_modules/@huggingface/transformers/.cache — fine for
      // npm/npx, but a portable bundle can sit under a deep folder (the model
      // path then exceeds Windows' 260-char MAX_PATH, and onnxruntime's
      // NATIVE file-open fails even though Node's fs downloads it fine) or a
      // read-only one. The portable launcher sets CALLOSIUM_MODEL_DIR to a
      // short, writable, install-independent path (%LOCALAPPDATA%\Callosium\
      // models on Windows). Unset = unchanged behavior.
      // Honor CALLOSIUM_MODEL_DIR if set, else fall back to a sane default. A
      // missing or mistyped env (e.g. a fumbled key in an MCP client's config)
      // must NEVER leave the model in a deep node_modules path that blows Windows
      // MAX_PATH — so we always set an explicit, short cacheDir.
      env.cacheDir = process.env.CALLOSIUM_MODEL_DIR || defaultModelDir();
      let last = -1;
      let sawPartial = false;
      let lastActivity = Date.now();
      const load = pipeline('feature-extraction', MODEL, {
        dtype: 'q8',
        // Only the big weights file (>5MB) is surfaced — config/tokenizer files
        // would just flicker the meter. CACHE LOADS emit a single 100% event
        // (measured in the portable bundle: every fresh CLI process printed
        // "downloading… 100%"), so nothing is shown until a genuinely partial
        // event proves a real network download is in flight.
        progress_callback: (p: any) => {
          lastActivity = Date.now(); // any progress keeps the stall watchdog at bay
          if (p?.status === 'progress' && p.total > 5_000_000) {
            const pct = Math.min(100, Math.floor((p.loaded / p.total) * 100));
            if (pct < 100) sawPartial = true;
            if (pct !== last && sawPartial) {
              last = pct;
              modelProgressCb?.(pct); // dashboard SSE stream
              termModelProgress(pct); // one redrawing terminal line
            }
          }
        },
      });
      // Stall watchdog. The DOWNLOAD streams progress, but the onnxruntime LOAD
      // after it is silent — and on some machines it hangs forever without ever
      // throwing, which would trap onboarding on "learning what they mean" with
      // nothing to catch. If nothing makes progress for STALL_MS we give up, so
      // the caller falls back to keyword-only recall (a normal cold load is ~4s).
      // Every progress event resets the timer, so a slow-but-live download or a
      // genuinely long build never trips it.
      const STALL_MS = 90_000;
      let watchIv: ReturnType<typeof setInterval> | undefined;
      const watchdog = new Promise<never>((_resolve, reject) => {
        watchIv = setInterval(() => {
          if (Date.now() - lastActivity > STALL_MS) {
            reject(new Error(`embedding model stalled: no progress for ${STALL_MS / 1000}s`));
          }
        }, 5000);
      });
      let ex: any;
      try {
        ex = await Promise.race([load, watchdog]);
      } finally {
        if (watchIv) clearInterval(watchIv);
      }
      // Resolve the terminal line to "✓ ready" ONLY when a real download ran —
      // a silent cache load (sawPartial stays false) prints nothing, keeping
      // every normal run quiet.
      if (sawPartial) termModelProgressDone();
      return ex;
    })().catch((e) => {
      extractorP = null; // stay retryable — next call attempts the download again
      throw new ModelUnavailableError(e);
    });
  }
  return (extractor = await extractorP);
}

export async function embedTexts(texts: string[], kind: 'query' | 'passage'): Promise<Float32Array[]> {
  const ex = await getExtractor();
  const out: Float32Array[] = [];
  const BATCH = 16;
  for (let i = 0; i < texts.length; i += BATCH) {
    // 2000 is a runaway backstop only: chunking governs real size (CHUNK_CHARS
    // 1400 + heading/kind prefixes fit comfortably). The old 1500 cut the tail
    // off fully-loaded chunks, violating the no-truncation invariant.
    const batch = texts.slice(i, i + BATCH).map((t) => `${kind}: ${t.slice(0, 2000)}`);
    let res;
    try {
      res = await ex(batch, { pooling: 'mean', normalize: true });
    } catch (e) {
      // Inference failures (native OOM, corrupted cache) must degrade exactly
      // like a failed download: typed + retryable, never aborting the caller's
      // whole connect/ingest flow with a raw native error.
      extractor = null;
      throw new ModelUnavailableError(e);
    }
    const [n, dims] = res.dims.length === 2 ? res.dims : [1, res.dims[0]];
    for (let j = 0; j < n; j++) out.push(new Float32Array(res.data.slice(j * dims, (j + 1) * dims)));
  }
  return out;
}

/** Preload the embedding pipeline (and warm the first-inference path) so the
 *  FIRST semantic query doesn't pay the multi-second cold model load (~4s
 *  measured on a 1.1k-note brain). Throws ModelUnavailableError like any other
 *  load; the caller decides to ignore it. Semantic stays an upgrade lane,
 *  never a gate. Shares the memoized in-flight load, so a warm racing a real
 *  query is one download, not two. */
export async function warmModel(): Promise<void> {
  await embedTexts(['warmup'], 'query');
}

// The embedder's usable window (~512 tokens). embedTexts slices to 1500; a
// little headroom is left below that for the title/heading prefix prepended in
// buildEmbeddings, so nothing the chunk carries is silently truncated away.
const CHUNK_CHARS = 1400;
// Max chunks embedded per note. Raised from 20 so long notes (yearly journals,
// growing reference docs) keep semantic coverage past the 20th section.
const MAX_CHUNKS = 40;

/** Pack a piece of text into ≤CHUNK_CHARS windows (on paragraph breaks where
 *  possible, hard-splitting any single over-long paragraph) so the whole thing
 *  is embedded instead of everything past ~1500 chars being dropped. */
function windows(text: string, heading: string | null): { heading: string | null; text: string }[] {
  const t = text.trim();
  if (!t) return [];
  if (t.length <= CHUNK_CHARS) return [{ heading, text: t }];
  const out: { heading: string | null; text: string }[] = [];
  let buf = '';
  const flush = () => {
    if (buf.trim()) out.push({ heading, text: buf.trim() });
    buf = '';
  };
  for (const para of t.split(/\n{2,}/)) {
    if (para.length > CHUNK_CHARS) {
      flush();
      for (let i = 0; i < para.length; i += CHUNK_CHARS) out.push({ heading, text: para.slice(i, i + CHUNK_CHARS).trim() });
      continue;
    }
    if (buf && (buf.length + 2 + para.length) > CHUNK_CHARS) flush();
    buf = buf ? `${buf}\n\n${para}` : para;
  }
  flush();
  return out;
}

/** Split a note body into chunk texts (heading sections; small notes whole),
 *  each windowed to the embedder's real capacity. */
export function chunkNote(body: string): { heading: string | null; text: string }[] {
  if (body.length < 3000) return windows(body, null).slice(0, MAX_CHUNKS);
  const out: { heading: string | null; text: string }[] = [];
  for (const part of body.split(/^(?=#{1,4} )/m)) {
    if (part.trim().length <= 80) continue;
    const heading = ((part.match(/^#{1,4} (.+)/) || [, null])[1] as string | null) ?? null;
    out.push(...windows(part, heading));
    if (out.length >= MAX_CHUNKS) break;
  }
  // A large note whose heading sections are ALL tiny (<=80 chars) would otherwise
  // yield zero chunks and never be embedded — fall back to plain windows.
  if (out.length === 0) return windows(body, null).slice(0, MAX_CHUNKS);
  return out.slice(0, MAX_CHUNKS);
}

function idxFile(vault: Vault): string {
  return path.join(cacheDir(vault), 'embeddings.json');
}
// Vectors live in a RAW Float32 binary sidecar, NOT base64 inside the JSON.
// Base64-in-JSON put every vector into ONE V8 string; past ~40-55k notes that
// string blows the ~512MB max-string-length cap → JSON.parse/stringify throws →
// the old catch swallowed it to null → semantic died SILENTLY and forever. A
// binary sidecar has no string cap, is ~33% smaller, and skips base64 codec.
function vecFile(vault: Vault): string {
  return path.join(cacheDir(vault), 'embeddings.f32');
}
// The sidecar is prefixed with a 16-byte ascii buildId that also lives in the
// json, so a reader can prove the two files belong to the same build (see the
// identity check in loadEmbeddings). 16 is 4-aligned, so the vectors that follow
// stay Float32-aligned after the header is sliced off.
const VEC_HEADER_BYTES = 16;
// Monotonic per-process counter so two concurrent buildEmbeddings() calls never
// collide on the atomic-write temp name (pid alone is not unique in-process —
// the sibling graph module hit and fixed this exact bug).
let embWriteSeq = 0;

/** Surfaced when an EXISTING embedding cache fails to load (corrupt, size
 *  mismatch, torn concurrent write) — as opposed to simply not existing yet.
 *  Without this the failure was invisible: semantic silently stayed off. Two
 *  live surfaces consume it: the dashboard subscribes via this callback and
 *  raises a "re-index to restore semantic" banner in the overview payload
 *  (see dashboard/server.ts), and surfaceCacheError also console.error's to
 *  stderr for the CLI/MCP (stdio) contexts where the host captures logs. */
let cacheErrorCb: ((msg: string) => void) | null = null;
export function onEmbeddingCacheError(cb: ((msg: string) => void) | null): void {
  cacheErrorCb = cb;
}
function surfaceCacheError(msg: string): void {
  console.error(`[callosium] embedding cache: ${msg} — semantic search is off until the next re-index (node test/build-embeddings.mjs <brain>).`);
  cacheErrorCb?.(msg);
}

// Identity of the embedding files the memo below was built from.
let embMemo: { key: string; idx: EmbeddingIndex } | null = null;

export async function loadEmbeddings(vault: Vault): Promise<EmbeddingIndex | null> {
  // This runs on EVERY cache reload, and a reload happens after every write. Re-reading
  // and re-allocating the Float32 matrix (~30MB on a 10k-chunk brain) each time is the
  // dominant cost of a reload that only actually needed the texts — exactly what an
  // agent's write→recall loop does, once per written note. Memoize on the identity of
  // BOTH files (size + mtime of the metadata and of the vector sidecar): if neither
  // moved, the bytes on disk are the ones we already parsed, so hand back the same
  // index. Keyed by vault root so two brains never share. Any stat failure skips the
  // memo entirely and takes the full path, so correctness never depends on it. Safe to
  // share: consumers treat the index as read-only (semanticLane reads it; buildEmbeddings
  // reads `prev` and constructs a NEW index rather than mutating this one).
  let memoKey = '';
  try {
    const [meta, vec] = await Promise.all([fs.stat(idxFile(vault)), fs.stat(vecFile(vault))]);
    memoKey = `${vault.root}|${meta.size}:${meta.mtimeMs}|${vec.size}:${vec.mtimeMs}`;
    if (embMemo && embMemo.key === memoKey) return embMemo.idx;
  } catch {
    memoKey = ''; // no sidecar yet (legacy base64 cache) or unreadable → no memo
  }
  let rawJson: string;
  try {
    rawJson = await fs.readFile(idxFile(vault), 'utf8');
  } catch {
    return null; // no cache yet — first run, expected, stay silent
  }
  // From here the cache EXISTS. Any failure past this point is a real problem
  // that must be surfaced, never swallowed into a permanent silent-off state.
  try {
    const raw = JSON.parse(rawJson);
    if (raw.version !== EMBEDDER_VERSION) return null; // model changed — clean rebuild, not an error
    // noteHashes must be a real object — buildEmbeddings indexes into it
    // (prev.noteHashes[f]) OUTSIDE any try/catch, so a cache missing/corrupt in
    // this one field would otherwise crash the whole rebuild instead of falling
    // back to a clean full re-embed.
    if (!raw.noteHashes || typeof raw.noteHashes !== 'object') {
      surfaceCacheError('metadata missing noteHashes');
      return null;
    }
    // Validate the shape the vector math depends on. A malformed-but-parseable
    // json (chunks not an array, dims 0/non-number) would otherwise sail through
    // to a bogus index and crash buildEmbeddings' prev.chunks.forEach later.
    if (!Array.isArray(raw.chunks) || typeof raw.dims !== 'number' || raw.dims <= 0) {
      surfaceCacheError('metadata chunks/dims malformed');
      return null;
    }
    const nChunks = raw.chunks.length;
    const dims = raw.dims;
    const wantBytes = nChunks * dims * 4;

    // Read the vectors. Preferred path: the binary sidecar. Legacy path: base64
    // still embedded in the JSON (pre-sidecar caches) — decode it once so those
    // users keep semantic with ZERO re-embed; the next build writes the sidecar
    // form and drops vectorsB64.
    let raw0: Buffer;
    let fromSidecar = false;
    try {
      raw0 = await fs.readFile(vecFile(vault));
      fromSidecar = true;
    } catch {
      if (typeof raw.vectorsB64 === 'string') {
        raw0 = Buffer.from(raw.vectorsB64, 'base64'); // one-time legacy migration read
      } else {
        surfaceCacheError('vector sidecar embeddings.f32 is missing');
        return null;
      }
    }
    // IDENTITY CHECK (fixes the silently-wrong-vectors race): a concurrent build
    // could leave embeddings.json describing one run's chunks while embeddings.f32
    // physically holds another run's vectors. A byte-count match alone can't catch
    // that. Every sidecar this version writes is prefixed with a random 16-byte
    // buildId that is ALSO stored in the json; if they disagree the pairing is
    // stale/torn and we rebuild rather than serve mismatched vectors. Absent
    // buildId = legacy base64 (vectors are IN the json, inherently paired) or an
    // interim headerless sidecar — both fall through to whole-buffer, size-checked.
    let buf: Buffer = raw0;
    if (fromSidecar && typeof raw.buildId === 'string') {
      const header = raw0.subarray(0, VEC_HEADER_BYTES).toString('ascii');
      if (header !== raw.buildId) {
        surfaceCacheError('sidecar/metadata id mismatch (torn or concurrent write) — rebuilding');
        return null;
      }
      buf = raw0.subarray(VEC_HEADER_BYTES);
    }
    if (buf.byteLength % 4 !== 0) { surfaceCacheError('vector file is truncated (not 4-aligned)'); return null; }
    // Size must match chunks×dims exactly, else semanticLane reads past the end
    // → undefined → NaN similarity → chunks silently vanish from ranking.
    if (buf.byteLength !== wantBytes) {
      surfaceCacheError(`vector count mismatch (have ${buf.byteLength / 4}, expected ${nChunks}×${dims}=${wantBytes / 4})`);
      return null;
    }
    // Buffer.from()/readFile can hand back a view into Node's shared pool at a
    // non-4-aligned byteOffset; Float32Array requires 4-byte alignment or it
    // throws. Copy into a fresh, aligned ArrayBuffer to be safe.
    const aligned = new Uint8Array(buf.byteLength);
    aligned.set(buf);
    const idx: EmbeddingIndex = {
      version: raw.version,
      dims,
      chunks: raw.chunks,
      noteHashes: raw.noteHashes,
      vectors: new Float32Array(aligned.buffer, 0, aligned.byteLength / 4),
    };
    if (memoKey) embMemo = { key: memoKey, idx };
    return idx;
  } catch (e) {
    surfaceCacheError(`unreadable (${(e as Error)?.message ?? e})`);
    return null;
  }
}

export async function buildEmbeddings(
  vault: Vault,
  files: string[],
  texts: Map<string, string>,
  onProgress?: (done: number, total: number) => void,
): Promise<EmbeddingIndex> {
  const prev = await loadEmbeddings(vault);
  const chunks: ChunkMeta[] = [];
  const chunkTexts: string[] = [];
  const reuse: { meta: ChunkMeta; vec: Float32Array }[] = [];
  const noteHashes: Record<string, string> = {};

  // Group the previous index's chunks by note path ONCE — the old inline
  // `prev.chunks.forEach(... if c.path === f)` re-scanned every previous chunk
  // for every unchanged file (O(files × chunks), quadratic over the vault).
  const prevByPath = new Map<string, { meta: ChunkMeta; vec: Float32Array }[]>();
  if (prev) {
    prev.chunks.forEach((c, i) => {
      const entry = { meta: c, vec: prev.vectors.slice(i * prev.dims, (i + 1) * prev.dims) };
      const arr = prevByPath.get(c.path);
      if (arr) arr.push(entry);
      else prevByPath.set(c.path, [entry]);
    });
  }

  for (const f of files) {
    const raw = texts.get(f) || '';
    if (!raw) continue;
    const hash = Vault.contentHash(raw);
    noteHashes[f] = hash;
    // incremental reuse: unchanged note → copy its old chunk vectors
    if (prev && prev.noteHashes[f] === hash) {
      for (const entry of prevByPath.get(f) ?? []) reuse.push(entry);
      continue;
    }
    const note = parseNote(f, raw);
    const date = String(note.frontmatter.date ?? note.frontmatter.updated ?? '');
    const noteType = note.frontmatter.type ? String(note.frontmatter.type) : undefined;
    for (const ch of chunkNote(note.body)) {
      chunks.push({ path: f, heading: ch.heading, ...(date ? { date } : {}), ...(noteType ? { noteType } : {}) });
      // Cap the title+heading prefix so a long filename/heading can't eat into the
      // embedder's ~1500-char window and truncate away the chunk's real body.
      const prefix = `${f.split('/').pop()!.replace('.md', '')} ${ch.heading ?? ''}`.slice(0, 120).trim();
      chunkTexts.push(`${prefix}\n${ch.text}`);
    }
  }

  const newVecs: Float32Array[] = [];
  const BATCH = 64;
  for (let i = 0; i < chunkTexts.length; i += BATCH) {
    newVecs.push(...(await embedTexts(chunkTexts.slice(i, i + BATCH), 'passage')));
    onProgress?.(Math.min(i + BATCH, chunkTexts.length), chunkTexts.length);
  }

  const dims = newVecs[0]?.length ?? reuse[0]?.vec.length ?? 384;
  const allChunks = [...reuse.map((r) => r.meta), ...chunks];
  const vectors = new Float32Array(allChunks.length * dims);
  reuse.forEach((r, i) => vectors.set(r.vec, i * dims));
  newVecs.forEach((v, i) => vectors.set(v, (reuse.length + i) * dims));

  const index: EmbeddingIndex = { version: EMBEDDER_VERSION, dims, chunks: allChunks, vectors, noteHashes };
  await fs.mkdir(cacheDir(vault), { recursive: true });
  // A random per-build id ties the sidecar to its json so a torn/concurrent
  // write can never pair one run's metadata with another run's vectors (the
  // loadEmbeddings identity check rejects a mismatch and rebuilds). It prefixes
  // the sidecar (16 ascii bytes) AND is stored in the json.
  const buildId = randomBytes(VEC_HEADER_BYTES / 2).toString('hex'); // 8 bytes → 16 hex chars
  // Write the vectors to the raw binary sidecar FIRST, via a UNIQUE temp file +
  // rename (pid+seq so concurrent same-process builds don't clobber each other's
  // temp), then the json — both atomic. No base64, no V8 string cap — this scales
  // past the ~40-55k-note wall where the old single-string cache threw and
  // silently killed semantic.
  const vecBytes = Buffer.from(vectors.buffer, vectors.byteOffset, vectors.byteLength);
  const seq = embWriteSeq++;
  const vecTmp = `${vecFile(vault)}.tmp-${process.pid}-${seq}`;
  await fs.writeFile(vecTmp, Buffer.concat([Buffer.from(buildId, 'ascii'), vecBytes]));
  await fs.rename(vecTmp, vecFile(vault));
  const jsonTmp = `${idxFile(vault)}.tmp-${process.pid}-${seq}`;
  await fs.writeFile(
    jsonTmp,
    // vectorsB64 is intentionally gone — a stale one would double the file and
    // re-introduce the string cap. buildId is the sidecar-pairing token.
    JSON.stringify({ version: index.version, dims, chunks: allChunks, noteHashes, vectorCount: allChunks.length, buildId }),
  );
  await fs.rename(jsonTmp, idxFile(vault));
  return index;
}

// Past this many chunks an EXACT brute-force scan per query starts to cost more
// than a few ms and an approximate index (hnswlib) becomes worth its native-dep
// and its (small) recall risk. Below it — the overwhelming common case for a
// personal brain — exact scan is both fast AND never misses the true nearest
// neighbour, which matters more than latency when "missed info is dangerous".
// ~50k chunks ≈ a vault of ~8k substantial notes. We surface the crossing ONCE
// rather than silently degrade, so the ANN upgrade is a deliberate choice.
export const SEMANTIC_ANN_THRESHOLD = 50_000;
let annNoticeShown = false;

/** Rank notes by best-chunk cosine similarity to the query, KEEPING the score.
 *  Returns `[path, score]` pairs, best first. Vectors are L2-normalized at embed
 *  time, so the dot product IS the cosine (−1..1; e5 sits ~0.70–0.95 in practice).
 *
 *  The score is not decoration: the honesty gate uses the top note's cosine to
 *  tell a legitimate PARAPHRASE (a real note worded differently — high cosine)
 *  apart from a NONSENSE entity (nothing in the brain is close — weak cosine).
 *  Lexical absent-mass cannot separate those two; they look identical to it.
 *
 *  Stage-2 seam: pass `candidates` (a Set of note paths) to score ONLY those
 *  notes — a retrieve-then-rerank narrowing that stays EXACT within the set.
 *  Omit it (the default) to scan the whole corpus exactly, unchanged. This is
 *  the clean insertion point for an approximate first stage later, without a
 *  lossy default and without a native dependency today. */
export async function semanticLaneScored(
  index: EmbeddingIndex,
  question: string,
  limit = 50,
  candidates?: Set<string>,
): Promise<[string, number][]> {
  const { vectors, dims, chunks } = index;
  if (!annNoticeShown && chunks.length > SEMANTIC_ANN_THRESHOLD && !candidates) {
    annNoticeShown = true;
    console.error(`[callosium] semantic index is large (${chunks.length} chunks); exact scan still runs (never misses) but an approximate index would cut per-query latency. See SEMANTIC_ANN_THRESHOLD.`);
  }
  const [q] = await embedTexts([question], 'query');
  const best = new Map<string, number>();
  for (let i = 0; i < chunks.length; i++) {
    if (candidates && !candidates.has(chunks[i].path)) continue;
    let dot = 0;
    const off = i * dims;
    for (let d = 0; d < dims; d++) dot += vectors[off + d] * q[d];
    const cur = best.get(chunks[i].path);
    if (cur === undefined || dot > cur) best.set(chunks[i].path, dot);
  }
  return [...best.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit);
}

/** Paths only — the original signature, unchanged for every caller that just
 *  wants the ranking. */
export async function semanticLane(
  index: EmbeddingIndex,
  question: string,
  limit = 50,
  candidates?: Set<string>,
): Promise<string[]> {
  return (await semanticLaneScored(index, question, limit, candidates)).map(([p]) => p);
}
