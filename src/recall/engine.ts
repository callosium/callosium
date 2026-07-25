// Deterministic recall — the port of the owner's recall.mjs v2 retrieval ladder
// (4,000-case tested). Zero model calls; the AI only ever sees the evidence
// this returns. The scoring math is preserved verbatim from the original;
// what's new here is schema-driven generalization plus three additions from
// the 11 Jul 2026 competitive research: evidence tags on every result, a
// create-safety hint, and an explicit "not in the brain" answer.
//
// The ladder:
//   1. strip the question to keywords (filler discarded)
//   2. score every candidate WITHOUT opening files (filename, path, catalogue lines)
//   3. open only the single top-scoring file, extract the answering section
//   4. coverage check: weak evidence → length-normalized content scan fallback
//   5. follow one wiki-link pointer if the section redirects

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import type { Vault } from '../core/vault.ts';
import type { GraphIndex, RecallAnswer, RecallResult } from '../core/types.ts';

import { tokenize, isDateish, EPISODIC_RE, MONTHS_SET } from './tokens.ts';
import { buildRankIndex, bm25f, proximityScore, graphLane, rrfFuse, detectKnownItem, sourcePrior, tsMatchScore } from './rank.ts';
import { correctTerm, fuzzyEntity, morphVariant } from './fuzzy.ts';
import { semanticLaneScored, type EmbeddingIndex } from './semantic.ts';
import { noteDateMs } from './temporal.ts';
import type { RankIndex } from './rank.ts';
export { tokenize, isDateish };

// Mirror of Vault.contentHash — the EXACT hash semantic.ts stamps into
// emb.noteHashes at embed time. Kept inline (instead of a value import of the
// Vault class) so the recall engine stays a pure data-in function; the algorithm
// is the cache-key format and is frozen. Used only by the stale-vector guard.
const contentHash16 = (s: string): string => createHash('sha1').update(s).digest('hex').slice(0, 16);

// ─── vault text cache ─────────────────────────────────────────────────

export interface VaultTexts {
  files: string[];
  texts: Map<string, string>;
  mtimes: Map<string, number>;
  contentIndex: Map<string, Map<string, number>> | null;
  /** Notes with status: archived — DEMOTED in ranking, never excluded.
   *  (Real vaults archive old memory records as lifecycle; the episodic
   *  history must stay recallable. An agent-archived note just stops
   *  outranking its replacement.) */
  archived: Set<string>;
  /** Files whose read/stat FAILED during load (transient lock, AV scan). They
   *  are registered with blank text so recall keeps serving them, but consumers
   *  that validate content (the health check) must treat them as "unreadable",
   *  not "empty": an empty note is a finding, a locked note is not. */
  unreadable: Set<string>;
}

/** Ranking multiplier for archived notes: still findable by a specific
 *  question, but never outranks a live note on a generic one. */
export const ARCHIVE_DEMOTION = 0.45;

/** One honesty-gate decision, as the gate saw it. */
export interface GateProbe {
  question: string;
  topPath: string | null;
  absentMass: number;
  gateCov: number;
  /** cosine of the top note's best chunk vs the query (0 when semantic is off) */
  semTopScore: number;
  /** semantic vote available at all: lane non-empty, top note in its head, vector fresh */
  semEligible: boolean;
  semFresh: boolean;
  /** the honesty gate's own condition, before the semantic vote is consulted */
  gateFires: boolean;
  semConfirms: boolean;
}
/** Calibration seam for the honesty gate. Null unless CALLOSIUM_GATE_PROBE=1, so
 *  the shipped path allocates and records nothing. It exists because
 *  RETRIEVAL_SCHEMA.semanticRescueMin is a MEASURED constant: cosines are only
 *  comparable within one embedder, so every EMBEDDER_VERSION bump needs the
 *  threshold re-swept against the bench's negative + paraphrase families (see
 *  test/calibrate-sem-rescue.mjs). recall() recurses — comparison split before
 *  the gate, drop-tokens relaxation after a refusal — so entries accumulate:
 *  reset `log` before a query and read log[0] for that query's own decision. */
export const _gateProbe: { log: GateProbe[] } | null =
  process.env.CALLOSIUM_GATE_PROBE === '1' ? { log: [] } : null;

/** LOCKED retrieval schema — the single source of truth for every fusion
 *  weight, budget, and tuning constant the ranker uses. Frozen so the design
 *  is auditable and stable across benchmark runs: to retune, change a value
 *  HERE and re-bench — never scatter a magic number back into the pipeline.
 *  (Companion locked constants that live where they're used: BM25F field
 *  weights W_TITLE/W_HEAD/W_BODY + k1 in rank.ts; RRF k in rank.ts; typo
 *  budgets in fuzzy.ts `typoBudget`; chunk sizes CHUNK_CHARS/MAX_CHUNKS in
 *  semantic.ts. This object owns the FUSION layer.) */
export const RETRIEVAL_SCHEMA = Object.freeze({
  // Per-lane RRF weights. Two intent profiles: navigational (the user named a
  // note → trust the title) vs topical (a concept question → trust the body).
  laneWeights: Object.freeze({
    navigational: Object.freeze({ title: 1.2, bm: 1, cov: 1, prox: 0.8, g: 0.5 }),
    topical: Object.freeze({ title: 0.4, bm: 1.2, cov: 1.5, prox: 1, g: 0.5 }),
    tsMatch: 0.9,
    rare: 1.1,
    semantic: 1,
    entity: 1,
    // recency lanes — weighted only when the query carries temporal intent
    timeTemporal: 2.2,
    titleRecencyTemporal: 1.6,
  }),
  /** known-item cover fraction at/above which a query is treated navigational */
  navigationalCoverMin: 0.3,
  /** known-item cover at/above which the best exact-title match is PINNED to
   *  rank 1 (was a magic 0.45 at the pin site). Both thresholds are tested
   *  against max(token-cover, idf-cover) — see KnownItem.bestCoverIdf. */
  knownItemPinMin: 0.45,
  /** relaxed pin floor when the title AND-match is UNIQUE (matchCount === 1):
   *  exactly one note in the vault carries all the query's content words in its
   *  title — uniqueness is the disambiguation, so a lower cover suffices
   *  ("c18b5c identification" covers 0.42 of its long dated title's idf mass). */
  knownItemPinUniqueMin: 0.25,
  /** post-fusion multiplier for catalogue notes (Index/MOC/Home/map) when the
   *  query doesn't name the catalogue itself: a catalogue that merely LISTS the
   *  answer in a link line must never outrank the note that IS the answer (the
   *  measured aggregator-sponge failure mode). */
  catalogueDemotion: 0.45,
  /** a near-tie clarify whose best candidate covers less than this (raw,
   *  bonus-free) is noise, not ambiguity: five unrelated notes each matching
   *  one scattered word must refuse honestly, not offer a garbage "did you
   *  mean" list (16 Jul session-benchmark honesty failures #52/#53). */
  clarifyRefuseFloor: 0.42,
  /** post-fusion recency boost: ×(1 + maxBoost) freshest, fading linearly to ×1 over fadeDays */
  recency: Object.freeze({ fadeDays: 60, maxBoost: 1 }),
  /** delivery budgets (chars / counts) — caps, never knowledge filters */
  budgets: Object.freeze({
    answerChars: 14000,
    answerCharsRich: 28000,
    contextChars: 12000,
    contextCap: 15,
    contextCapRich: 30,
    topResults: 5,
    topResultsRich: 8,
    /** hard ceiling on ANY single returned section/excerpt. A note that is one
     *  giant heading-less block (a scraped 150k-word doc) whose query words don't
     *  localize used to return the ENTIRE body as one excerpt (measured max
     *  122,537 chars — a context-window bomb). The agent read_notes for more. */
    maxSectionChars: 4000,
  }),
});

/** Hard-cap a section to the schema ceiling, marking the truncation so the agent
 *  knows to read_note the full section if it needs the rest. */
function capSection(s: string): string {
  const max = RETRIEVAL_SCHEMA.budgets.maxSectionChars;
  if (s.length <= max) return s;
  let cut = s.slice(0, max);
  // never cut between the two halves of a surrogate pair (would emit a lone
  // surrogate → replacement char / broken JSON for e.g. emoji, some scripts)
  const lastCode = cut.charCodeAt(cut.length - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) cut = cut.slice(0, -1);
  return cut.trimEnd() + `\n\n[… section truncated at ${max} chars — read_note this path with { section } for the full text.]`;
}

export async function loadTexts(vault: Vault, withIndex = true): Promise<VaultTexts> {
  const all = await vault.listNotes();
  const files: string[] = [];
  const texts = new Map<string, string>();
  const mtimes = new Map<string, number>();
  const archived = new Set<string>();
  const unreadable = new Set<string>();
  // Read notes with BOUNDED concurrency instead of one-at-a-time: the reads are
  // I/O-bound (each `await` idled the event loop between files), so a small pool
  // cuts cold-load wall time markedly on a real brain. Each result is stored at
  // its ORIGINAL index and the maps are assembled in `all` order afterward, so
  // files[] order — and every downstream tie-break that depends on it — is
  // byte-identical to the old sequential read. (P3 perf, [BOTH].)
  type Loaded = { text: string; mtime: number; archived: boolean } | { unreadable: true };
  const slots: (Loaded | undefined)[] = new Array(all.length);
  let nextIdx = 0;
  const readWorker = async (): Promise<void> => {
    for (;;) {
      const i = nextIdx++;
      if (i >= all.length) return;
      const f = all[i];
      try {
        // NFC-normalize once at load: queries are NFC-normalized in tokenize(),
        // so decomposed (NFD) vault text — common in Arabic-with-diacritics and
        // in files round-tripped through macOS/iCloud/OneDrive — would silently
        // fail substring matching (coverage → honesty-gate false refusals).
        const text = (await vault.readFileRetry(f)).normalize('NFC');
        // Metadata is SEPARATE from content: a note whose bytes read fine but whose fs.stat throws
        // transiently (OneDrive/iCloud hand back a synced file's metadata as unavailable) must keep
        // its real text, not get blanked into the unreadable set. Fall back to "seen now" for the
        // mtime — the next freshness re-index picks up the true mtime — rather than dropping the note.
        let mtime: number;
        try {
          mtime = (await fs.stat(vault.abs(f))).mtimeMs;
        } catch {
          mtime = Date.now();
        }
        // "archived" only counts in the FRONTMATTER block, not body prose that
        // happens to contain a "status: archived" line.
        const fmEnd = text.startsWith('---') ? text.indexOf('\n---', 3) : -1;
        const isArch = fmEnd > 0 && /^status:\s*archived\s*$/m.test(text.slice(0, fmEnd));
        slots[i] = { text, mtime, archived: isArch };
      } catch {
        slots[i] = { unreadable: true };
      }
    }
  };
  const IO_CONCURRENCY = 12;
  await Promise.all(Array.from({ length: Math.min(IO_CONCURRENCY, all.length) }, readWorker));
  for (let i = 0; i < all.length; i++) {
    const f = all[i];
    if (texts.has(f)) continue; // listNotes yields unique paths; guard matches the old dedup
    const s = slots[i]!;
    if ('unreadable' in s) { files.push(f); texts.set(f, ''); mtimes.set(f, 0); unreadable.add(f); }
    else { if (s.archived) archived.add(f); files.push(f); texts.set(f, s.text); mtimes.set(f, s.mtime); }
  }
  let contentIndex: VaultTexts['contentIndex'] = null;
  if (withIndex) {
    contentIndex = new Map();
    for (const [f, text] of texts) {
      const counts = new Map<string, number>();
      for (const w of tokenize(text)) counts.set(w, (counts.get(w) || 0) + 1);
      for (const [w, c] of counts) {
        if (!contentIndex.has(w)) contentIndex.set(w, new Map());
        contentIndex.get(w)!.set(f, c);
      }
    }
  }
  return { files, texts, mtimes, contentIndex, archived, unreadable };
}


// Catalogue notes: indexes/MOCs whose link lines vouch for other notes.
// Generic patterns, not vault-specific names. WORD match, not substring:
// substring 'map'/'index' branded Roadmap.md, Heatmap.md, Landing Mockups...
// as catalogues, stacking a 0.45x demotion + pin exclusion onto legitimate
// operational notes (16 Jul review, confirmed with a live A/B repro).
const isCatalogue = (f: string) => {
  const b = f.split('/').pop()!.toLowerCase().replace(/\.md$/, '');
  if (b === 'home') return true;
  const words = b.split(/[^a-z0-9؀-ۿ]+/u);
  return words.includes('index') || words.includes('moc') || words.includes('map');
};

// ask-intent → heading vocabulary
const INTENTS: [RegExp, RegExp][] = [
  [/follow|commit|next|pending|todo|action|open item|agreed/, /action|next step|open|follow|todo|commit|agreed/],
  [/cost|price|pricing|budget|commercial|monthly|fee/, /commercial|budget|pricing|cost|p&l|deliverable/],
  [/decision|decide|verdict|chose|why/, /decision|verdict|diagnosis|why/],
];

interface Section {
  file: string;
  heading: string | null;
  section: string;
  bytes: number;
  extras?: { file: string; heading: string | null; section: string }[];
}

/** Top-K sections of one note (Typesense group_by/group_limit pattern):
 *  the answer may span sections — return the best chunks per note, not one. */
function bestSections(file: string, text: string, words: string[], idf: Map<string, number>, k = 3): Section[] {
  if (text.length < 4000) return [{ file, heading: null, section: text.trim(), bytes: text.length }];
  const parts = text.split(/^(?=#{1,4} )/m).filter((p) => p.trim());
  const scored = parts
    .map((part) => {
      const ll = part.toLowerCase();
      const heading = (part.match(/^#{1,4} (.+)/) || [, null])[1];
      let sc = 0;
      for (const w of words) {
        const n = ll.split(w).length - 1;
        if (n > 0) sc += (idf.get(w) ?? 1) * Math.min(n, 3);
      }
      return { part, heading, sc };
    })
    .filter((x) => x.sc > 0)
    .sort((a, b) => b.sc - a.sc)
    .slice(0, k);
  return scored.map((x) => ({
    file,
    heading: x.heading,
    section: capSection((x.part.length > 2000 ? densestWindow(x.part, words, idf, 1800) : x.part).trim()),
    bytes: text.length,
  }));
}

function bestSection(file: string, text: string, words: string[], idf: Map<string, number>): Section {
  if (text.length < 4000) return { file, heading: null, section: text.trim(), bytes: text.length };
  const qLower = words.join(' ');
  const parts = text.split(/^(?=#{1,4} )/m).filter((p) => p.trim());
  const scoredParts = parts
    .map((part) => {
      const ll = part.toLowerCase();
      const isTitle = /^# /.test(part);
      const heading = (part.match(/^#{1,4} (.+)/) || [, ''])[1]!.toLowerCase();
      let distinct = 0,
        occ = 0;
      for (const w of words) {
        const n = ll.split(w).length - 1;
        if (n > 0) {
          distinct += idf.get(w) ?? 1;
          occ += n;
        }
        if (!isTitle && heading.includes(w)) distinct += 1.5;
      }
      if (!isTitle)
        for (const [ask, head] of INTENTS) {
          if (ask.test(qLower) && head.test(heading)) {
            distinct += 4;
            break;
          }
        }
      const perKb = occ / Math.max(part.length / 1024, 0.3);
      return { part, sc: distinct * 4 + Math.min(perKb, 6) };
    })
    .sort((a, b) => b.sc - a.sc);
  let best = scoredParts[0]?.part || text;
  for (const rp of scoredParts.slice(1, 3)) {
    if (rp.sc >= scoredParts[0].sc * 0.55) best += '\n\n' + rp.part;
  }
  const headingMatch = best.match(/^#{1,4} (.+)/);
  const capped = best.length > 3600 ? densestWindow(best, words, idf, 3200) : best;
  return { file, heading: headingMatch ? headingMatch[1] : null, section: capSection(capped.trim()), bytes: text.length };
}

function densestWindow(text: string, words: string[], idf: Map<string, number>, span: number): string {
  const ll = text.toLowerCase();
  const marks: [number, number][] = [];
  for (const w of words) {
    const k = idf.get(w) ?? 1;
    let pos = -1,
      c = 0;
    while (c < 60 && (pos = ll.indexOf(w, pos + 1)) !== -1) {
      marks.push([pos, k]);
      c++;
    }
  }
  if (!marks.length) return text.slice(0, span);
  marks.sort((a, b) => a[0] - b[0]);
  let bestStart = 0,
    bestMass = -1,
    lo = 0,
    mass = 0;
  for (let hi = 0; hi < marks.length; hi++) {
    mass += marks[hi][1];
    while (marks[hi][0] - marks[lo][0] > span) {
      mass -= marks[lo][1];
      lo++;
    }
    if (mass > bestMass) {
      bestMass = mass;
      bestStart = marks[lo][0];
    }
  }
  let start = Math.max(0, bestStart - 200);
  // Snap to line boundaries only when one is NEARBY. A single-line note (a
  // scraped transcript is often one giant paragraph) used to snap start to 0
  // and end to EOF, returning the ENTIRE text as the "window" — which the
  // downstream 4k excerpt cap then cut blind, slicing the matched term out
  // (term present in the note, coverage 0, wrongly refused as not-in-brain).
  const lineStart = text.lastIndexOf('\n', start) + 1;
  // Snap at most the lead margin (200): a larger left-shift would slide the
  // window off the TAIL marks it was chosen to cover.
  if (start - lineStart <= 200) start = lineStart;
  let end = Math.min(text.length, start + span);
  const nl = text.indexOf('\n', end);
  if (nl !== -1 && nl - end <= span * 0.15) end = nl;
  else {
    const sp = text.indexOf(' ', end);
    if (sp !== -1 && sp - end <= 100) end = sp; // break at a word, never mid-word
  }
  return (start > 0 ? '[...]\n' : '') + text.slice(start, end) + (end < text.length ? '\n[...]' : '');
}

function coverage(text: string, words: string[], idf: Map<string, number>): number {
  const ll = text.toLowerCase();
  // Verification runs on CONTENT words; date tokens locate, they don't verify.
  const contentWords = words.filter((w) => !isDateish(w));
  if (contentWords.length) words = contentWords;
  let got = 0,
    total = 0;
  for (const w of words) {
    const k = idf.get(w) ?? 1;
    total += k;
    if (ll.includes(w)) got += k;
  }
  let cov = total ? got / total : 0;
  // query echo: bigram overlap means the text quotes the question, not answers it
  if (words.length >= 5) {
    const tw = tokenize(text);
    const tB = new Set<string>();
    for (let i = 0; i < tw.length - 1; i++) tB.add(tw[i] + ' ' + tw[i + 1]);
    let hit = 0,
      n = 0;
    for (let i = 0; i < words.length - 1; i++) {
      n++;
      if (tB.has(words[i] + ' ' + words[i + 1])) hit++;
    }
    if (n >= 4 && hit / n >= 0.6) cov *= 0.25;
  }
  return cov;
}

function resolveNote(files: string[], name: string): string | null {
  // NFC both sides: a sync client can hand back a basename in decomposed (NFD)
  // form while the wiki-link text is composed (NFC) — without normalizing, a
  // [[café]] pointer silently fails to resolve to café.md.
  const target = name.normalize('NFC').toLowerCase();
  return files.find((f) => f.split('/').pop()!.replace(/\.md$/, '').normalize('NFC').toLowerCase() === target) || null;
}

// ─── the core ─────────────────────────────────────────────────────────

export interface FindResult {
  words: string[];
  ms: number;
  stage: 'index' | 'content-fallback';
  candidates: { score: number; file: string }[];
  evidence: Section | null;
  hop: Section | null;
  evidenceText: string;
  /** idf-weighted coverage of the final evidence — the honesty signal. */
  finalCoverage: number;
  /** finalCoverage WITHOUT intent bonuses (money etc.) — what the honesty
   *  gate consumes. Bonuses steer RANKING between real candidates; they must
   *  never manufacture confidence that an answer exists at all (16 Jul review:
   *  5 dollar figures gave any note +0.30 on the gate for cost questions). */
  finalCoverageRaw: number;
  /** Query terms that appear NOWHERE in the brain (df = 0). */
  absentTerms: string[];
  /** Share of the question's idf mass carried by absent terms (0..1). */
  absentMass: number;
}

export async function brainFind(
  question: string,
  vaultTexts: VaultTexts,
  opts?: { episodicHint?: boolean },
): Promise<FindResult | { error: string }> {
  const t0 = Date.now();
  const words = tokenize(question);
  if (!words.length) return { error: 'no usable keywords' };

  const { files, texts, mtimes, contentIndex, archived } = vaultTexts;

  // catalogue boost
  const catWords = new Map<string, Set<string>>();
  for (const c of files) {
    if (!isCatalogue(c)) continue;
    const text = texts.get(c) || '';
    for (const line of text.split('\n')) {
      const ll = line.toLowerCase();
      const hits = words.filter((w) => ll.includes(w));
      if (!hits.length) continue;
      for (const m of line.matchAll(/\[\[([^\]|#]+)/g)) {
        const key = m[1].trim().normalize('NFC').toLowerCase(); // match the NFC basename lookup
        if (!catWords.has(key)) catWords.set(key, new Set());
        hits.forEach((w) => catWords.get(key)!.add(w));
      }
    }
  }
  const catBoost = new Map<string, number>();
  for (const [k, set] of catWords) catBoost.set(k, Math.min(set.size * 3, 6));

  // content idf
  const lower = files.map((f) => f.normalize('NFC').toLowerCase());
  const df = new Map<string, number>(words.map((w) => [w, 0]));
  if (contentIndex) {
    for (const w of words) df.set(w, contentIndex.get(w)?.size ?? 0);
  } else {
    for (const f of files) {
      const ll = (texts.get(f) || '').toLowerCase();
      for (const w of words) if (ll.includes(w)) df.set(w, df.get(w)! + 1);
    }
  }
  const idf = new Map<string, number>(
    words.map((w) => {
      const d = Math.max(df.get(w)!, 1);
      return [w, Math.min(Math.max(Math.log2(files.length / d) / 3, 0.5), 3)];
    }),
  );

  // stage 2: score without opening files
  const statusIntent = /\b(status|stopp?e?d?|left|resume|continue|latest|last|standing|progress|update)\b/.test(words.join(' '));
  // recall() strips conversational frames ("did we ever discuss…") BEFORE this
  // runs, which are exactly the episodic cues — so it forwards the intent it
  // detected on the ORIGINAL question. Standalone brainFind callers (MCP find)
  // still self-detect from their unstripped input.
  const episodicIntent = opts?.episodicHint ?? EPISODIC_RE.test(question);
  const exactTitleFiles = new Set<string>();
  const now = Date.now();
  const scored: [number, string][] = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (f.startsWith('System/')) continue; // operational state, never knowledge
    const base = f.split('/').pop()!.replace(/\.md$/, '').normalize('NFC').toLowerCase();
    const dir = lower[i];
    const baseWords = new Set(base.split(/[^\p{L}\p{N}]+/u));
    let sc = 0;
    for (const w of words) {
      const k = idf.get(w)!;
      if (baseWords.has(w)) sc += 4 * k;
      else if (base.includes(w)) sc += 2 * k;
      else if (dir.includes(w)) sc += 1 * k;
    }
    for (let j = 0; j < words.length - 1; j++) {
      const pair = words[j] + ' ' + words[j + 1];
      if (pair.includes('  ') || /\d/.test(pair)) continue;
      if (base.includes(pair)) sc += 6 * Math.max(idf.get(words[j])!, idf.get(words[j + 1])!);
      else if (dir.includes(pair)) sc += 3 * Math.max(idf.get(words[j])!, idf.get(words[j + 1])!);
    }
    sc += catBoost.get(base) || 0;
    // Exact-title dominance: when EVERY content word of the query appears in
    // the basename as a whole word, the user is naming this note — it must
    // not lose top rank to a content-heavy file that merely discusses it.
    if (sc > 0) {
      const singles = words.filter((w) => !w.includes(' '));
      if (singles.length >= 2 && singles.every((w) => baseWords.has(w))) {
        const titleCover = singles.length / Math.max([...baseWords].filter(Boolean).length, 1);
        sc += (10 + 15 * Math.min(titleCover, 1)) * Math.max(...singles.map((w) => idf.get(w)!));
        exactTitleFiles.add(f);
      }
    }
    // generic-word-only matches must not outrank entity matches
    if (sc > 0) {
      let bestK = 0;
      for (const w of words)
        if ((baseWords.has(w) || base.includes(w) || dir.includes(w)) && idf.get(w)! > bestK) bestK = idf.get(w)!;
      const maxK = Math.max(...words.map((w) => idf.get(w)!));
      if (maxK > 1 && bestK < maxK * 0.6) sc *= 0.55;
    }
    if (statusIntent && sc > 0) {
      const ageDays = (now - (mtimes.get(f) || 0)) / 86400000;
      sc += Math.max(0, 1 - ageDays / 45) * 5;
      // anchor notes (shallow files directly under a partition) orient status
      // questions — generalized from the original's client-anchor boost
      if (dir.split('/').length <= 3 && !isCatalogue(f)) sc += 3;
    }
    if (archived.has(f) && !episodicIntent) sc *= ARCHIVE_DEMOTION;
    if (sc > 0) scored.push([sc, f]);
  }
  scored.sort((a, b) => b[0] - a[0] || a[1].split('/').length - b[1].split('/').length);

  // stage 3: open only the top file
  let evidence: Section | null = null;
  let stage: FindResult['stage'] = 'index';
  if (scored.length) {
    evidence = bestSection(scored[0][1], texts.get(scored[0][1]) || '', words, idf);
  }

  // stage 4: content-scan fallback when index evidence is weak
  const costIntent = /cost|price|pricing|budget|commercial|monthly|fee|total/.test(words.join(' '));
  const rawCov1 = evidence ? coverage(evidence.section, words, idf) : 0;
  const cov1 = rawCov1 + (evidence && costIntent && /\$ ?[\d,]{3,}/.test(evidence.section) ? 0.2 : 0);
  let finalCoverage = cov1;
  let finalCoverageRaw = rawCov1;
  const closeRace = scored.length > 1 && scored[1][0] > scored[0][0] * 0.8;
  if (cov1 < 0.65 || closeRace) {
    const lenNorm = (f: string) => Math.max(1, Math.log2(Math.max((texts.get(f) || '').length, 1024) / 8192));
    const agg = new Map<string, number>();
    if (contentIndex) {
      for (const w of words) {
        const m = contentIndex.get(w);
        if (!m) continue;
        const k = idf.get(w)!;
        for (const [f, c] of m) agg.set(f, (agg.get(f) || 0) + k * Math.min(c, 3) + k * 3);
      }
    } else {
      for (const f of files) {
        const ll = (texts.get(f) || '').toLowerCase();
        let s = 0;
        for (const w of words) {
          const k = idf.get(w)!;
          let c = 0,
            pos = -1;
          while (c < 3 && (pos = ll.indexOf(w, pos + 1)) !== -1) c++;
          if (c > 0) s += k * c + k * 3;
        }
        if (s > 0) agg.set(f, s);
      }
    }
    if (!episodicIntent) for (const f of archived) if (agg.has(f)) agg.set(f, agg.get(f)! * ARCHIVE_DEMOTION);
    const contentTops = [...agg.entries()]
      .map(([f, s]) => [s / lenNorm(f), f] as [number, string])
      .sort((a, b) => b[0] - a[0])
      .slice(0, 5)
      .map(([, f]) => f);
    const pool = [...new Set([...contentTops, ...scored.slice(0, 5).map(([, f]) => f)])];
    const money = (t: string) => (t.match(/\$ ?[\d,]{3,}/g) || []).length;
    const judged: { ev: Section; cov: number; covRaw: number; money: number }[] = [];
    for (const f of pool) {
      if (evidence && f === evidence.file) continue;
      const ev = bestSection(f, texts.get(f) || '', words, idf);
      const covRaw = coverage(ev.section, words, idf);
      judged.push({ ev, cov: covRaw + (costIntent ? Math.min(money(ev.section), 5) * 0.06 : 0), covRaw, money: money(ev.section) });
    }
    judged.sort(
      (a, b) =>
        b.cov - a.cov ||
        (costIntent ? b.money - a.money : 0) ||
        a.ev.file.split('/').length - b.ev.file.split('/').length,
    );
    const original = evidence;
    // An exact-title index pick is the user NAMING the note: a challenger
    // must beat it decisively on coverage, not by rounding error.
    const displaceMargin = original && exactTitleFiles.has(original.file) ? 0.3 : 0.03;
    if (judged[0] && judged[0].cov > cov1 + displaceMargin) {
      evidence = judged[0].ev;
      stage = 'content-fallback';
    }
    if (evidence) {
      finalCoverage = Math.max(cov1, judged[0]?.cov ?? 0);
      // Max over the WHOLE pool: judged is sorted by bonus-inclusive cov, so
      // judged[0] can be a money-dense section with low RAW coverage while a
      // better bonus-free answer sits at judged[1] — taking only [0]'s raw
      // understated the gate signal and could refuse an answerable cost
      // question (17 Jul re-review).
      finalCoverageRaw = Math.max(rawCov1, ...judged.map((j) => j.covRaw), 0);
      const extras: Section[] = [];
      if (stage === 'content-fallback' && original && original.file !== evidence.file) extras.push(original);
      for (const j of judged) {
        if (extras.length >= 3) break;
        if (j.ev.file === evidence.file || extras.some((e) => e.file === j.ev.file)) continue;
        if (j.cov >= finalCoverage - 0.12 || (finalCoverage < 0.9 && j.cov > 0.1)) extras.push(j.ev);
      }
      let budget = RETRIEVAL_SCHEMA.budgets.contextChars - evidence.section.length;
      const kept: Section[] = [];
      for (const e of extras) {
        if (budget - e.section.length > 0) {
          kept.push(e);
          budget -= e.section.length;
        }
      }
      if (kept.length)
        evidence = { ...evidence, extras: kept.map((e) => ({ file: e.file, heading: e.heading, section: e.section })) };
    }
  }

  // stage 5: follow one pointer if the section is basically a redirect
  let hop: Section | null = null;
  if (evidence && evidence.section.length < 500) {
    const ptr = evidence.section.match(/\[\[([^\]|#]+)/);
    if (ptr) {
      const target = resolveNote(files, ptr[1].trim());
      if (target && target !== evidence.file) {
        hop = bestSection(target, texts.get(target) || '', words, idf);
      }
    }
  }

  return {
    words,
    ms: Date.now() - t0,
    stage,
    candidates: scored.slice(0, 50).map(([sc, f]) => ({ score: +sc.toFixed(1), file: f })),
    evidence,
    hop,
    evidenceText:
      (evidence ? evidence.section : '') +
      (evidence?.extras ? evidence.extras.map((e) => '\n' + e.section).join('') : '') +
      (hop ? '\n' + hop.section : ''),
    finalCoverage,
    finalCoverageRaw,
    absentTerms: words.filter((w) => (df.get(w) ?? 0) === 0),
    // Share of the question's idf mass carried by terms the brain never
    // mentions. High = the question's core entities are unknown here, and
    // whatever matched is generic-word noise.
    absentMass: (() => {
      let absent = 0,
        total = 0;
      for (const w of words) {
        const k = idf.get(w)!;
        total += k;
        if ((df.get(w) ?? 0) === 0) absent += k;
      }
      return total ? absent / total : 0;
    })(),
  };
}

// ─── fast search (stage-2 scoring only, for browsing/disambiguation) ──
// The recall/search split (Gbrain-validated): `search` returns ranked
// candidates cheaply so an agent can browse or disambiguate; `recall`
// commits to an evidence-checked answer. Different jobs, different tools.

export interface SearchHit {
  path: string;
  score: number;
  /** First matching line as a preview snippet. */
  snippet: string;
}

export function searchNotes(query: string, vaultTexts: VaultTexts, limit = 20, isVisible?: (f: string) => boolean): SearchHit[] {
  const words = tokenize(query);
  if (!words.length) return [];
  const { files, texts, contentIndex, archived } = vaultTexts;
  const df = new Map<string, number>(words.map((w) => [w, contentIndex?.get(w)?.size ?? 0]));
  const idf = new Map<string, number>(
    words.map((w) => {
      const d = Math.max(df.get(w)!, 1);
      return [w, Math.min(Math.max(Math.log2(files.length / d) / 3, 0.5), 3)];
    }),
  );
  const agg = new Map<string, number>();
  for (const f of files) {
    // Scope BEFORE ranking/slicing: filtering the already-sliced top-N would
    // return [] to a scoped agent when 20+ higher-ranked hits are out of scope,
    // even though a visible match exists at rank 21+.
    if (isVisible && !isVisible(f)) continue;
    const base = f.split('/').pop()!.replace(/\.md$/, '').toLowerCase();
    const dir = f.toLowerCase();
    let sc = 0;
    for (const w of words) {
      const k = idf.get(w)!;
      if (base.includes(w)) sc += 4 * k;
      else if (dir.includes(w)) sc += 1.5 * k;
      sc += (contentIndex?.get(w)?.get(f) ?? 0) > 0 ? k : 0;
    }
    if (archived.has(f)) sc *= ARCHIVE_DEMOTION;
    if (sc > 0) agg.set(f, sc);
  }
  return [...agg.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([f, score]) => {
      const text = texts.get(f) || '';
      const ll = text.toLowerCase();
      let snippet = '';
      for (const w of words) {
        const pos = ll.indexOf(w);
        if (pos >= 0) {
          const lineStart = text.lastIndexOf('\n', pos) + 1;
          let lineEnd = text.indexOf('\n', pos);
          if (lineEnd === -1) lineEnd = text.length;
          snippet = text.slice(lineStart, Math.min(lineEnd, lineStart + 200)).trim();
          break;
        }
      }
      return { path: f, score: +score.toFixed(1), snippet };
    });
}

// ─── the agent-facing answer (evidence tags, create-safety, not-in-brain) ──

function evidenceFor(file: string, section: string, words: string[]): RecallResult['evidence'] {
  const base = file.split('/').pop()!.replace(/\.md$/, '').toLowerCase();
  const dir = file.toLowerCase();
  const ll = section.toLowerCase();
  const headings = [...section.matchAll(/^#{1,4} (.+)$/gm)].map((m) => m[1].toLowerCase());
  const matchedTerms = words
    .map((term) => {
      const where: ('filename' | 'path' | 'heading' | 'body' | 'alias')[] = [];
      if (base.includes(term)) where.push('filename');
      else if (dir.includes(term)) where.push('path');
      if (headings.some((h) => h.includes(term))) where.push('heading');
      if (ll.includes(term)) where.push('body');
      return { term, where };
    })
    .filter((m) => m.where.length);
  return { matchedTerms, score: 0 };
}

// ─── fused recall (v2): BM25F + proximity + graph lanes, RRF k=60 ─────
// The v1 ladder survives as the title lane + the honesty gate; ranking is
// now rank-fusion across independent lanes instead of winner-take-all
// displacement (research pass + Gbrain source dissection, 11 Jul 2026).

const rankCache = new WeakMap<VaultTexts, { graph: GraphIndex | null; index: RankIndex }>();

export function ensureRankIndex(vaultTexts: VaultTexts, graph: GraphIndex | null): RankIndex {
  const hit = rankCache.get(vaultTexts);
  if (hit && hit.graph === graph) return hit.index;
  const index = buildRankIndex(vaultTexts.files, vaultTexts.texts, vaultTexts.archived, graph);
  rankCache.set(vaultTexts, { graph, index });
  return index;
}

/** Date-stripped filename key for dated-sibling demotion (Gbrain MMR-lite). */
function dateKey(p: string): string {
  // Token-split rather than a \b-anchored regex: \b never matches next to
  // Arabic letters, so the old regex silently failed to strip Arabic month
  // names and treated 'تقرير يناير' / 'تقرير فبراير' as unrelated documents.
  // Drop pure 1-2 or 4-digit tokens (years/day numbers, as before — 3-digit
  // list counts like "Top 100" are kept) and any month name in either script.
  return p
    .split('/')
    .pop()!
    .replace(/\.md$/, '')
    .normalize('NFC')
    .toLowerCase()
    .split(/[\s._-]+/)
    .filter((t) => t && !/^(\d{1,2}|\d{4})$/.test(t) && !MONTHS_SET.has(t))
    .join(' ')
    .trim();
}

const COMPARE_RE = /^(.*?)\s+(?:vs\.?|versus|compared?\s+(?:to|with|than)|different\s+(?:than|from))\s+(.*?)\??$/i;
const BETWEEN_RE = /(?:difference(?:s)? between|(?:قارن(?:\s+لي)?|الفرق)\s+بين)\s+(.*?)\s+(?:and|و)\s+(.*?)\??$/i;

// Conversational ASKING frames, stripped from every query as PHRASES.
// This is why Arabic was outscoring English on identical anchors: Arabic
// filler is fully stop-worded, but English frames leave one polluting
// content-word behind ("I need to REVIEW X", "what was the DEAL with X",
// "can you pull UP X FOR ME") that dilutes known-item coverage and feeds
// hub notes. Phrases only — a bare "review"/"deal" in a query or title
// stays meaningful.
const CONV_FRAME_RES: RegExp[] = [
  /\bi (?:need|want|would like|'?d like) to (?:review|see|check|read|look at|revisit|go over)\b/gi,
  /\bwhat(?:'?s| was| is)? (?:the )?deal with\b/gi,
  /\bcan you (?:pull up|bring up|show me|get me|find me|grab|open)\b/gi,
  /\b(?:pull|bring) up\b/gi,
  /\bshow me\b/gi,
  /\bfor me\b/gi,
  /\bwhere did we (?:leave|stop with|leave off (?:on|with)?)\b/gi,
  /\bwhat did we do (?:recently|yesterday|today|last (?:week|month|time)) (?:with|on|in|about)\b/gi,
  /\b(?:what'?s\s+)?(?:the\s+)?latest (?:on|about|with)\b/gi,
  /\bwhat(?:'?s| is) (?:the )?(?:status|update) (?:on|of|with)\b/gi,
  /\bwhat(?:'?s| is) going on with\b/gi,
  // bare "what happened" is asking vocabulary — and it collides with the
  // "## What happened" heading every session log carries, so leaving it in
  // ranked the WRONG dates' logs for "what happened 16th of july".
  /\bwhat happened(?: (?:with|to|in|on|at|around))?\b/gi,
  /\bwhat'?s the story (?:with|on|behind)\b/gi,
  /\bdid we (?:ever )?(?:discuss|talk about|cover|go over)\b/gi,
  /\bcatch me up (?:on|with)\b/gi,
  // temporal "current-state" framing — the TOPIC is whatever survives these.
  // (Detected as temporal above; here we strip the recency vocabulary so it
  // stops polluting the topical match — the measured cause of "what's new with
  // chatgpt daily" matching on "new"/"daily" instead of the chatgpt-daily note.)
  /\bwhat(?:'?s| is| are)?\s+new\s+(?:with|on|for|about|in|regarding)\b/gi,
  /\bmost recent\b/gi,
  /\bwhere (?:do|does)\s+(?:things|it|stuff|matters?|we)\s+stand\b/gi,
  /\bwhere (?:are|were)\s+we\s+(?:on|with|at|regarding|in)\b/gi,
  /\bwhat happened\s+lately\s+(?:with|to|on|in|about)\b/gi,
  /\bstands?\s+(?:now|today|currently|right now|at the moment)\b/gi,
  // "where does/is <topic> stand" — strip the opener only when a "stand" follows
  /\bwhere (?:do|does|is|are)\b(?=.{0,60}\bstands?\b)/gi,
  // "how's it going with <topic>", "where do we stand on <topic>"
  /\bhow(?:'?s| is| are)?\s+(?:it|things)\s+going\s+(?:with|on|for)\b/gi,
  // more casual-recall framing (measured: these verbs leaked as fake topic words
  // — "remind"/"notes"/"find"/"stuff" — and broke the known-item full-coverage
  // match, letting index/catalogue notes that merely LIST the target outrank it)
  /\bremind me (?:about|of)\b/gi,
  /\bany notes? (?:on|about|for|regarding)\b/gi,
  // content-search meta-vocabulary — "mentioning"/"anything on" describe the ACT
  // of searching, not the topic. Measured: "notes mentioning pathway instadoodle"
  // buried a note that "pathway instadoodle" alone found at #1 ("mentioning" is
  // also just rare enough to poison the rare-term AND-pin).
  /\bnotes? (?:mentioning|that mention|discussing|containing|about)\b/gi,
  /\banything (?:on|about|regarding|for|mentioning)\b/gi,
  /\bwhere do (?:we|i) talk about\b/gi,
  /\bdo (?:we|i) have anything (?:on|about)\b/gi,
  // the vault IS "the brain" — a locative "in the brain / to my second brain"
  // is meta ("is X in the brain?" asks about X, not about brains). PHRASE-FINAL
  // only (lookahead: end or punctuation) so a query naming a real note like
  // "…in the Project Roadmap Note" keeps its title words.
  /\b(?:in|into|to|from|inside) (?:the |my )?(?:second )?brain\b(?=\s*(?:[?.!,;]|$))/gi,
  /\bwhat (?:was|is|were) included in\b/gi,
  /\b(?:the )?latest updates? (?:on|to|of|for|about)\b/gi,
  /\b(?:pull up |bring up )?my notes? (?:on|about|for|regarding)\b/gi,
  /\bfind me (?:the )?\b/gi,
  /\bwhere(?:'?s| is| are)? (?:the |my )\b/gi,
  /\b(?:do you |can you )?remember (?:the |that |our )?\b/gi,
  /\bwhat do (?:we|i|you) know about\b/gi,
  /\bstuff\s*\??\s*$/gi, // trailing "…stuff"
  /\bagain\s*\??\s*$/gi, // trailing "…again?"
  // small-fact "date / figure" framing — topic is what's LEFT
  /\bwhat date (?:was|is|did)\b/gi,
  /\bwhen (?:was|is|did) (?:we|i|you|the)?\b/gi,
  /\bhow much (?:was|is|for|did)\b/gi,
  /\bwhat(?:'?s| is)? the figure for\b/gi,
  /\bwhat number did (?:we|i|you) land on for\b/gi,
  /\bwhat(?:'?s| is)? the\b(?=.{0,50}\bamount\b)/gi, // "what's the <topic> amount"
  /\bamount\s*\??\s*$/gi,
  // no \b next to Arabic (ASCII-only) — the space inside the phrase anchors it
  /وش سالفة/g,
  /في شي (?:مسجل|مكتوب|محفوظ) عن/g,
];

// The request FRAME of a build question ("build me a poc", "for a new
// client", "سويلي demo") is instruction, not content — left in the query it
// pulls every note that merely mentions poc/demo and can trip the honesty
// gate on absent Arabic colloquials. Stripped as PHRASES (never single
// words) so titles like "Brain MCP Build Plan" or "GMC demo" survive.
// Named targets survive too: "for acme company" doesn't match.
const RICH_FRAME_RES: RegExp[] = [
  // "me/us" or an article is REQUIRED — bare "build plan" is a note title
  // ("Brain MCP Build Plan"), not an instruction.
  /\b(?:build|make|create|draft|prepare|design|write)\s+(?:(?:me|us)\s+(?:an?\s+|the\s+)?|(?:an?|the)\s+)(?:new\s+)?(?:poc|proof of concept|prototype|demo|proposal|pitch(?:\s+deck)?|deck|integration plan|plan|workflow|app|api|agent|solution|architecture)\b/gi,
  /\bfor\s+(?:an?\s+)?(?:new\s+)?(?:client|customer|company|prospect)\b/gi,
  /\b(?:based on|using)\s+(?:what|everything|all)\s+(?:we|you|i)\s+know(?:\s+about)?/gi,
  /(?:بناء|بناءً)\s+على\s+(?:اللي|ما|الي)\s+نعرفه?\s*(?:عن)?/g,
  /مبني(?:ة)?\s+على(?:\s+كل)?(?:\s+اللي)?(?:\s+عندنا)?(?:\s+عن)?/g,
  /(?:سويلي|سولي|ابنيلي|ابني\s+لي|جهزلي|جهز\s+لي|حضرلي|حضر\s+لي|صمملي|صمم\s+لي|اعملي?\s*لي)\s*(?:poc|demo|عرض|نموذج|خطة|حل)?/g,
  /لعميل\s+جديد/g,
];

// Build/synthesis intent: the asker is about to PRODUCE work from this
// knowledge ("based on a project, build me a poc for X"). That flips the request
// from "answer me" to "equip me" — the agent needs the complete cluster
// (reference docs, prior PoCs with gotchas, related skills), not the single
// best section. Requires a build verb + artifact noun, or an explicit
// "based on / using what we know" frame, so plain content questions
// ("what did we build for X?") don't trigger it.
const RICH_RE = new RegExp(
  [
    // imperative shape required ("build me a...", "draft a...") — bare
    // verb+noun ("build plan") is a note title, not an instruction
    // ASCII nouns keep \b; Arabic nouns need a script-aware boundary (\b is
    // ASCII-only and never fires before an Arabic letter — it silently killed
    // the code-switched "build me a مشروع" branch).
    '(?:build|creat\\w*|implement\\w*|develop\\w*|draft|prepar\\w*|design\\w*|writ\\w*|mak\\w*|set\\s*up)\\s+(?:(?:me|us)\\s+(?:an?\\s+|the\\s+)?|(?:an?|the)\\s+)(?:new\\s+)?[^.?!]{0,40}?(?:\\b(?:poc|proof of concept|prototype|proposal|demo|pitch|deck|integration|solution|architecture|plan|workflow|agent|app|api)|(?<![؀-ۿ])(?:مشروع|عرض|حل|نموذج)(?![؀-ۿ]))',
    'based on (?:what|everything|all)',
    'using (?:what|everything|all)\\s+(?:we|you|i)\\s+know',
    // NB: \b is ASCII-only — useless around Arabic letters. Script lookarounds instead.
    '(?:بناء|بناءً)\\s+على\\s+(?:اللي|ما|الي)\\s+نعرف',
    '(?<![؀-ۿ])(?:ابني|ابنيلي|اعمل|اعملي?لي|سوي|سويلي|سولي|جهز|جهزلي|حضر|حضرلي|صمم|صمملي)(?![؀-ۿ])',
  ].join('|'),
  'i',
);

// M4 — relationship-query honesty. "who is my <role>" (manager/boss/wife/…) is a question about a
// PERSON: it must resolve to an actual person note, never to a note that merely contains the role
// word — the live "who is my manager" → top-ranked a same-word PARTNER note trap. Applied at the
// recall call sites (not inside the ranker) to the final top-level answer only.
const RELATIONSHIP_RE = /\bwho(?:'?s| is| are|'re)\s+(?:my|our)\s+([a-z][a-z '-]*)/i;
// Only UNAMBIGUOUSLY-personal roles gate. Business-relationship words (client, partner, vendor,
// customer, supplier, team) are deliberately excluded: "who is our client/partner" often resolves
// to an ORGANIZATION note, and hard-gating those would hide a correct answer and mislabel it as a
// person question. The original trap was "who is my manager" — this set covers that class only.
const PERSON_ROLES = new Set([
  'manager', 'boss', 'supervisor', 'mentor', 'wife', 'husband', 'spouse', 'fiance', 'fiancee',
  'girlfriend', 'boyfriend', 'mother', 'father', 'mom', 'dad', 'mum', 'parent', 'sister', 'brother',
  'sibling', 'son', 'daughter', 'cousin', 'aunt', 'uncle', 'colleague', 'coworker', 'assistant',
  'secretary', 'doctor', 'dentist', 'lawyer', 'attorney', 'accountant', 'therapist', 'trainer',
  'coach', 'tutor', 'landlord', 'physician', 'nanny', 'roommate',
]);
export function isRelationshipQuery(question: string): boolean {
  const m = RELATIONSHIP_RE.exec(question);
  if (!m) return false;
  // The role phrase can be multi-word ("direct manager", "line manager") and plural ("managers",
  // "bosses") — gate if ANY word is a personal role, matching singular/plural forms.
  const words = m[1].toLowerCase().split(/[\s'-]+/).filter(Boolean);
  return words.some(
    (w) => PERSON_ROLES.has(w) || PERSON_ROLES.has(w.replace(/es$/, '')) || PERSON_ROLES.has(w.replace(/s$/, '')),
  );
}
// A note of a KNOWN non-person type is the wrong sort of answer for a "who is my <person>"
// question. We gate ONLY these — an unknown/ambiguous type fails OPEN (trust recall), so an adopted
// vault that keeps people under its own folder/type is never wrongly suppressed.
const NON_PERSON_TYPES = new Set([
  'partner', 'client', 'organization', 'organisation', 'company', 'venture', 'initiative', 'project',
  'vendor', 'customer', 'supplier', 'team', 'product', 'platform', 'opportunity', 'deliverable',
]);
function frontmatterType(notePath: string, texts: VaultTexts): string {
  const raw = texts.texts.get(notePath);
  if (!raw) return '';
  const fm = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  // Anchor to a TOP-LEVEL key (column 0). Allowing leading whitespace here would match an indented
  // `type:` sub-key nested under some other map (e.g. `meta:\n  type: partner`), wrongly classifying
  // a person note as a non-person and over-gating it — M4 must fail OPEN on ambiguity, not suppress.
  const m = fm && /(^|\n)type:\s*['"]?([a-z][a-z-]*)['"]?/i.exec(fm[1]);
  return m ? m[2].toLowerCase() : '';
}
export function relationshipHonesty(question: string, answer: RecallAnswer, texts: VaultTexts): RecallAnswer {
  if (!answer.found || !isRelationshipQuery(question)) return answer;
  const top = answer.results?.[0];
  if (!top) return answer;
  if (/(^|\/)People\//i.test(top.path)) return answer; // clearly a person — trust it
  const type = frontmatterType(top.path, texts);
  if (type === 'person') return answer; // clearly a person
  if (!NON_PERSON_TYPES.has(type)) return answer; // unknown/ambiguous → fail open, never suppress
  // top hit is a KNOWN non-person type (partner/org/…): the wrong kind of note for a person question
  const article = /^[aeiou]/i.test(type) ? 'an' : 'a'; // "an organization" / "an opportunity", not "a"
  return {
    ...answer,
    found: false,
    results: answer.results ?? [],
    notInBrainReason: `That's a question about a person, but the closest match is ${article} ${type} note, not a person — so answering it could be wrong. Add a note for them, or tell me who you mean.`,
  };
}

export async function recall(
  question: string,
  vaultTexts: VaultTexts,
  graph: GraphIndex | null = null,
  _noSplit = false,
  emb: EmbeddingIndex | null = null,
  // Intent detected from the ORIGINAL user question, forwarded into recursive
  // calls (drop-tokens relaxation) whose query text has already been
  // frame-stripped/corrected and can no longer re-trigger the regexes. Without
  // this a relaxed "build me a poc based on X" silently loses rich widening.
  _intent?: { rich: boolean; temporal: boolean; episodic: boolean },
): Promise<RecallAnswer> {
  // Bound the query length before any tokenizing/scoring. A pathological query
  // (a huge pasted/injected blob) would otherwise explode into tens of thousands
  // of tokens and RangeError the variadic Math.max(...words) spreads — or OOM the
  // fuzzy corrector — crashing the single-process host. Real questions are a
  // sentence; 4000 chars is already far past any genuine query. (Note indexing
  // is unaffected — this caps only the QUERY, never the corpus.)
  if (question.length > 4000) question = question.slice(0, 4000);
  const index = ensureRankIndex(vaultTexts, graph);

  // ── multi-target comparisons: "how does X compare to Y" is TWO lookups.
  // Split at the pivot, run both sides through the full pipeline, interleave
  // so BOTH subjects reach the agent.
  if (!_noSplit) {
    const m = question.match(BETWEEN_RE) ?? question.match(COMPARE_RE);
    if (m) {
      const clean = (x: string) => x.replace(/^(how|what|was|is|are|does|did|the|a|an|were)\s*/gi, '').trim();
      const left = clean(m[1]);
      const right = clean(m[2]);
      if (tokenize(left).length && tokenize(right).length) {
        const [a, b] = await Promise.all([
          recall(left, vaultTexts, graph, true, emb),
          recall(right, vaultTexts, graph, true, emb),
        ]);
        if (a.found || b.found) {
          const results: RecallResult[] = [];
          const seen = new Set<string>();
          const la = a.results ?? [],
            lb = b.results ?? [];
          for (let i = 0; i < Math.max(la.length, lb.length) && results.length < 6; i++) {
            for (const r of [la[i], lb[i]]) {
              if (r && !seen.has(r.path)) {
                seen.add(r.path);
                results.push(r);
              }
            }
          }
          // dedup the two sub-queries' context pointers by path — a note related
          // to BOTH sides would otherwise appear twice and waste a context slot.
          type Ctx = NonNullable<typeof a.context>[number];
          const ctxByPath = new Map<string, Ctx>();
          for (const c of [...(a.context ?? []), ...(b.context ?? [])]) if (!ctxByPath.has(c.path)) ctxByPath.set(c.path, c);
          const context = [...ctxByPath.values()].slice(0, 15);
          const corrections = [...(a.corrections ?? []), ...(b.corrections ?? [])];
          return {
            found: true,
            results: results.slice(0, 6),
            ...(context.length ? { context } : {}),
            ...(corrections.length ? { corrections } : {}),
          };
        }
      }
    }
  }

  // ALL intent is judged on the RAW question — frame-stripping and the
  // correction layer below rewrite the text before regexes could match.
  const rawQ = question;
  const rich = _intent?.rich ?? RICH_RE.test(rawQ);
  const episodic = _intent?.episodic ?? EPISODIC_RE.test(rawQ);
  const temporal =
    _intent?.temporal ??
    // Recency triggers. Deterministic on purpose: temporal *intent* is a
    // pragmatic cue that content-embeddings miss — an e5-small probe scored
    // "what's the date today" and "the 2020 report" ABOVE real recency
    // paraphrases, so no cosine threshold separates the two classes cleanly.
    // The model earns its keep on topical recall, not here. It did, however,
    // *surface* the paraphrases below (which the regex would never have
    // enumerated), so it did the discovery; the runtime stays a phrase list.
    // "new" is deliberately NOT a bare word (too common: "new project idea") —
    // only the phrase-anchored "what's new / anything new" and the unambiguous
    // superlatives "newest / most recent" count. Every added cue is phrase- or
    // idiom-anchored so it can't fire on time-*topical* (non-recency) queries.
    /(yesterday|today|tonight|this (week|month|morning)|last (week|month|night|meeting|session|time)|recently|latest|newest|most recent|(?:what'?s|anything|something|whats) new|just (?:built|shipped|committed|made|added|finished|did|created|wrote|pushed)|not long ago|a while (?:back|ago)|lately|of late|these days|(?:in )?recent days|where (?:did |do )?(?:i|we) (?:leave off|left off|stop|stopped)|where (?:do|does)(?: things| it| we)? stand|stands? (?:now|today|currently|right now)|where are we (?:on|with|at)|what happened lately|what'?s fresh|anything fresh|catch me up|bring me up to speed|till now|so far|right now|at the moment|last (?:\d+|two|three|four|few|couple(?: of)?) (?:days?|weeks?|months?)|امس|أمس|اليوم|البارح|هالاسبوع|هالشهر|هالايام|هاليومين|من فترة|من مدة|اخر|آخر|مؤخرا|مؤخراً|وين وقفنا|وين وصلنا|لحد الان|لحد الآن)/i.test(rawQ);

  // strip asking/build frames (phrases, never bare words) — the vocabulary
  // of requesting carries no content signal
  {
    let stripped = question;
    for (const re of CONV_FRAME_RES) stripped = stripped.replace(re, ' ');
    if (rich) for (const re of RICH_FRAME_RES) stripped = stripped.replace(re, ' ');
    stripped = stripped.replace(/\s+/g, ' ').trim();
    if (tokenize(stripped).length) question = stripped;
  }

  // ── typo layer 1: NON-WORD corrections (absent terms → vocabulary) ──
  const corrections: { from: string; to: string }[] = [];
  // TRUST FIX 2 (architecture review P8): a NOVEL (df==0) term corrected onto an
  // existing vault word is a guess — it may be a real new entity the brain has
  // never seen ("Zayd" auto-fixed to existing "Zaid" is a DIFFERENT person). We
  // still try the correction (recall over the guess), but flag it so the answer
  // can never be presented as a confident "exists" — it caps at 'probable' and
  // the correction is surfaced, turning a silent wrong-entity answer into a
  // visible "I read X as Y" the user can veto.
  let novelCorrection = false;
  {
    const qWords = tokenize(question).filter((w) => !w.includes(' '));
    for (const w of qWords) {
      if (isDateish(w)) continue;
      const df = index.df.get(w) ?? 0;
      if (df === 0) {
        const fix = correctTerm(index.fuzzy, w);
        if (fix) {
          corrections.push({ from: w, to: fix.corrected });
          novelCorrection = true;
          continue;
        }
      }
      // morphological sibling ("proposal"→"proposals") when the exact form is
      // rare and the sibling is clearly the corpus's word for it
      if (df < 3) {
        const mv = morphVariant(index.df, w);
        if (mv) corrections.push({ from: w, to: mv });
      }
    }
    for (const c of corrections) {
      // NOTE: template-literal `\b` is BACKSPACE, not word-boundary — this
      // replacement silently no-opped until 13 Jul. Concatenated form + script-
      // aware boundaries (Arabic letters are word chars too).
      const escaped = c.from.replace(/[.*+?^$()|[\]{}\\]/g, '\\$&');
      question = question.replace(new RegExp('(?<![a-z0-9؀-ۿ])' + escaped + '(?![a-z0-9؀-ۿ])', 'gi'), c.to);
    }
  }

  const r = await brainFind(question, vaultTexts, { episodicHint: episodic });
  if ('error' in r) return { found: false, results: [], notInBrainReason: r.error };
  const words = r.words;

  // ── lanes ──
  const titleLane = r.candidates.map((c) => c.file);

  const bmScored: [number, string][] = [];
  for (const note of index.notes) {
    const sc = bm25f(index, note, words) * sourcePrior(note.path);
    if (sc > 0) bmScored.push([sc, note.path]);
  }
  bmScored.sort((a, b) => b[0] - a[0] || a[1].localeCompare(b[1]));
  const bmLane = bmScored.slice(0, 50).map(([, p]) => p);

  // rare-term guarantee: a query term with df<=10 is a PINPOINT — every note
  // containing it enters the candidate pool directly (whole-note BM25 dilutes
  // rare terms buried in one section of a big note; this un-dilutes them).
  const rareHits: string[] = [];
  for (const w of words) {
    if (w.includes(' ') || isDateish(w)) continue;
    const m = vaultTexts.contentIndex?.get(w);
    if (m && m.size > 0 && m.size <= 15) rareHits.push(...m.keys());
  }
  const proxPool = [...new Set([...bmLane, ...titleLane.slice(0, 30), ...rareHits])];
  const proxScored: [number, string][] = [];
  for (const p of proxPool) {
    const note = index.byPath.get(p);
    if (!note) continue;
    const sc = proximityScore(note, words.filter((w) => !w.includes(' ')));
    if (sc > 0) proxScored.push([sc, p]);
  }
  proxScored.sort((a, b) => b[0] - a[0] || a[1].localeCompare(b[1]));
  const proxLane = proxScored.slice(0, 50).map(([, p]) => p);

  // rare-term lane: notes containing the query's rarest terms, rarest-first
  let rareLane: string[] = [];
  if (rareHits.length) {
    const cnt = new Map<string, number>();
    for (const p of rareHits) cnt.set(p, (cnt.get(p) || 0) + 1);
    rareLane = [...cnt.entries()]
      .sort((a, b) => b[1] - a[1] || (sourcePrior(b[0]) - sourcePrior(a[0])) || a[0].localeCompare(b[0]))
      .slice(0, 30)
      .map(([p]) => p);
  }

  // tsMatch lane (Typesense packed lexicographic score, as a lane):
  // rewards matching MORE distinct words, cleanly, close together, early —
  // signals BM25F's tf/length math doesn't capture.
  const totalTypoCost = corrections.length;
  const tsScored: [number, string][] = [];
  for (const p of proxPool) {
    const note = index.byPath.get(p);
    if (!note) continue;
    const sc = tsMatchScore(note, words, totalTypoCost) * sourcePrior(p);
    if (sc > 0) tsScored.push([sc, p]);
  }
  tsScored.sort((a, b) => b[0] - a[0] || a[1].localeCompare(b[1]));
  const tsLane = tsScored.slice(0, 50).map(([, p]) => p);

  const seeds = rrfFuse(
    [
      { ranking: titleLane, weight: 1 },
      { ranking: bmLane, weight: 1 },
    ],
    10,
  ).map((x) => x.path);
  const gLane = graph ? graphLane(index, seeds) : [];

  // ── typo layer 2: fuzzy ENTITY lane (real-word voice-mangles) ──
  // "micro"→Microsoft exists as a word, so absent-term correction never fires;
  // against the small entity vocabulary the match is decidable.
  let entityLane: string[] = [];
  {
    const hits = new Map<string, number>();
    for (const w of words) {
      if (w.includes(' ') || isDateish(w) || w.length < 3) continue;
      const common = (index.df.get(w) ?? 0) > index.n * 0.02;
      for (const h of fuzzyEntity(index.entityNames, w)) {
        // common words qualify via the safe PREFIX rule only ("micro"→Microsoft);
        // rare words may also DL-match ("goggle"→Google)
        if (common && h.kind !== 'prefix') continue;
        hits.set(h.path, Math.min(hits.get(h.path) ?? 9, h.edits));
      }
    }
    entityLane = [...hits.entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).slice(0, 15).map(([p]) => p);
  }

  // semantic lane: on-device multilingual embeddings — meaning, not words.
  // سيارة finds car; paraphrases find their notes. Zero keys, zero cloud.
  let semLane: string[] = [];
  // Cosine of each lane note's best chunk against the query. Ranking uses the
  // ORDER, as it always has; the score is carried so the honesty gate's
  // calibration seam can report it (see the COSINE ESCAPE HATCH note at the
  // gate — the score was measured as a rescue signal and found too flat to use).
  let semScores = new Map<string, number>();
  if (emb) {
    try {
      // The embedding index is persisted and only rebuilt when notes are
      // re-embedded, so a note deleted since the last embed still has its rows.
      // Drop any lane path that no longer exists in the live text set — otherwise
      // recall could rank (and try to cite) a note that's gone from disk. Cheap:
      // no re-embed, just an existence check against the current listing.
      const scored = (await semanticLaneScored(emb, question, 50)).filter(([p]) => vaultTexts.texts.has(p));
      semLane = scored.map(([p]) => p);
      semScores = new Map(scored);
    } catch {
      semLane = []; // fail-open: semantic unavailable → lexical stack carries
      semScores = new Map();
    }
  }

  // temporal lane: for "yesterday / last month / recently" questions the WHEN
  // is half the query. Any-word matching flooded the lane with mtime noise
  // ("second brain" admitted every note containing "brain") — a note must
  // match ALL content words (≤3-word queries) or ≥60% of them to ride the
  // recency ranking.
  // Temporal lanes rank by the date the note is ABOUT (content date: a dated
  // filename, a /YYYY/MM Mon/ path, or frontmatter updated/date/created), NOT the
  // file mtime — a Tuesday meeting note edited today is still Tuesday's meeting.
  // Falls back to mtime when a note carries no content date, so undated notes
  // rank exactly as before (no regression on notes the certified bench relied on
  // mtime for). Memoized per recall() call — noteDateMs is regex-heavy.
  // (Callosium backlog P2 #7.)
  const recencyMemo = new Map<string, number>();
  const recencyMs = (f: string): number => {
    let v = recencyMemo.get(f);
    if (v === undefined) {
      v = noteDateMs(f, vaultTexts.texts.get(f) || '') ?? (vaultTexts.mtimes.get(f) ?? 0);
      recencyMemo.set(f, v);
    }
    return v;
  };

  let timeLane: string[] = [];
  if (temporal) {
    const contentWords = words.filter((w) => !w.includes(' ') && !isDateish(w));
    const need = contentWords.length <= 3 ? contentWords.length : Math.ceil(contentWords.length * 0.6);
    const hits = new Map<string, number>();
    for (const w of contentWords) {
      const m = vaultTexts.contentIndex?.get(w);
      if (m) for (const f of m.keys()) hits.set(f, (hits.get(f) || 0) + 1);
    }
    timeLane = [...hits.entries()]
      .filter(([, c]) => c >= need)
      .map(([f]) => f)
      .sort((a, b) => recencyMs(b) - recencyMs(a))
      .slice(0, 30);
  }

  // TITLE/PATH recency lane: "what's the latest on <topic>" should surface the
  // FRESHEST note whose title or folder is about that topic, even when it lacks
  // the surface words the body-anchored timeLane requires (the Devlog answers
  // "latest on Callosium" but never says "latest"/"built"/"committed"). Match is
  // on the path only — the note's own name + its folder — which is far more
  // selective than body matching, so it can't flood the way "brain" in every
  // note's body did. Gated on temporal intent, so non-temporal recall is untouched.
  let titleRecencyLane: string[] = [];
  if (temporal) {
    const terms = words.filter((w) => !w.includes(' ') && !isDateish(w) && w.length >= 3);
    if (terms.length) {
      titleRecencyLane = vaultTexts.files
        .filter((f: string) => { const hay = f.toLowerCase(); return terms.some((w) => hay.includes(w)); })
        .sort((a: string, b: string) => recencyMs(b) - recencyMs(a))
        .slice(0, 20);
    }
  }

  // coverage lane — v1's section-coverage judge as a ranking signal: rank
  // candidates by how much of the question their BEST SECTION answers.
  // This is what wins deep-body ("medium/hard") queries; BM25F sees whole
  // documents, this sees the one section where the terms co-occur.
  const idfMapEarly = new Map<string, number>(
    words.map((w) => {
      const d = Math.max(index.df.get(w) ?? 0, 1);
      return [w, Math.min(Math.max(Math.log2(index.n / d) / 3, 0.5), 3)];
    }),
  );
  const covScored: [number, string][] = [];
  for (const p of proxPool) {
    const sec = bestSection(p, vaultTexts.texts.get(p) || '', words, idfMapEarly);
    const cov = coverage(sec.section, words, idfMapEarly) * sourcePrior(p);
    if (cov > 0.1) covScored.push([cov, p]);
  }
  covScored.sort((a, b) => b[0] - a[0] || a[1].localeCompare(b[1]));
  const covLane = covScored.slice(0, 50).map(([, p]) => p);

  // ── fusion (intent-adaptive weights: navigational vs topical) ──
  const kiEarly = detectKnownItem(index, words);
  const LW = RETRIEVAL_SCHEMA.laneWeights;
  // Navigational when the query covers the best title by TOKEN count or by IDF
  // mass — the idf form recognizes "c18b5c identification" as naming "Claude
  // Color C18B5C identification 7 Apr 2026" even though the date/filler tokens
  // drag its token-count cover to 0.29.
  const kiCover = Math.max(kiEarly.bestCover, kiEarly.bestCoverIdf);
  const navigational = kiEarly.isKnownItem && kiCover >= RETRIEVAL_SCHEMA.navigationalCoverMin;
  const W = navigational ? LW.navigational : LW.topical;
  let fused = rrfFuse(
    [
      { ranking: titleLane, weight: W.title },
      { ranking: bmLane, weight: W.bm },
      { ranking: covLane, weight: W.cov },
      { ranking: proxLane, weight: W.prox },
      { ranking: tsLane, weight: LW.tsMatch },
      { ranking: rareLane, weight: LW.rare },
      { ranking: semLane, weight: LW.semantic },
      { ranking: gLane, weight: W.g },
      // on a temporal question the WHEN is half the query — recency must be
      // able to outvote any single topical lane (now that the lane is
      // AND-filtered, its members are all genuinely on-topic)
      { ranking: timeLane, weight: temporal ? LW.timeTemporal : 0 },
      // title/path-anchored recency: lets the freshest note ABOUT the topic win a
      // "latest on X" question even when its body lacks the query's surface words.
      { ranking: titleRecencyLane, weight: temporal ? LW.titleRecencyTemporal : 0 },
      { ranking: entityLane, weight: LW.entity },
    ],
    20,
  );

  // System/ is operational state (agent registry, dismissed findings, the
  // quarantine folder), never knowledge — a quarantined duplicate of Index.md
  // surfaced at rank 2 in owner recall. Filtered post-fusion so every lane is
  // covered at one chokepoint. (Agent-side scoping already hides System/;
  // this makes owner-side recall match.)
  fused = fused.filter((f) => !f.path.startsWith('System/'));

  // temporal recency boost, post-fusion: on a "latest/yesterday/اخر شي"
  // question, six topical lanes stack on evergreen hub notes and outvote the
  // single recency lane — so recency SCALES the fused score instead of only
  // voting once. Multiplicative and bounded (≤2x, fading over ~60 days);
  // applied only under temporal intent, never inside RRF (the bucket-tier
  // experiment showed rank-position tiers collapse under RRF's decay).
  if (temporal && fused.length) {
    const now = Math.max(...fused.map((f) => vaultTexts.mtimes.get(f.path) ?? 0));
    const { fadeDays, maxBoost } = RETRIEVAL_SCHEMA.recency;
    // Coverage gate: recency may only re-rank the BEST-matching tier. A recent
    // note that matches FEWER of the query's content words must never leapfrog a
    // better-matching (often older) note — the measured bug where "what's new
    // with chatgpt daily" surfaced recent notes sharing only "daily" and buried
    // the note that actually matched both terms. With a single content word
    // (e.g. "latest on callosium") every match is full-coverage, so the freshest
    // still wins — unchanged. (index.byPath is the field index; titleSet+bodyTf
    // are the note's title/body vocab.)
    const cWords = words.filter((w) => !w.includes(' ') && !isDateish(w) && w.length >= 3);
    const covOf = (p: string): number => {
      if (cWords.length < 2) return 1;
      const nf = index.byPath.get(p);
      if (!nf) return 0;
      return cWords.filter((w) => nf.titleSet.has(w) || nf.bodyTf.has(w)).length / cWords.length;
    };
    const covs = new Map(fused.map((f) => [f.path, covOf(f.path)]));
    const maxCov = Math.max(...covs.values());
    fused = fused
      .map((f) => {
        if ((covs.get(f.path) ?? 0) < maxCov - 1e-9) return f; // not a best-tier match — no recency lift
        const age = (now - (vaultTexts.mtimes.get(f.path) ?? 0)) / 86400000;
        const recency = Math.max(0, 1 - age / fadeDays);
        return { ...f, rrf: f.rrf * (1 + maxBoost * recency) };
      })
      .sort((a, b) => b.rrf - a.rrf || a.path.localeCompare(b.path));
  }

  // archive demotion post-fusion (lifted entirely for episodic questions)
  if (!episodic) {
    fused = fused
      .map((f) => (index.byPath.get(f.path)?.archived ? { ...f, rrf: f.rrf * ARCHIVE_DEMOTION } : f))
      .sort((a, b) => b.rrf - a.rrf || a.path.localeCompare(b.path));
  }

  // aggregator demotion post-fusion: a catalogue (Index/MOC/Home/map) contains
  // the answer's TITLE in its link lines, so it sweeps every body lane (BM25F,
  // coverage, proximity, rare) and outranks the note that IS the answer — the
  // measured cause of "remind me about c18b5c identification" returning
  // Index.md #1. Demote catalogues UNLESS the query names the catalogue itself
  // (all content words in its own basename: "opportunities index" still finds
  // Opportunities Index.md undemoted). sourcePrior already demotes catalogues
  // inside the coverage lane; this closes the other lanes.
  {
    const qContent = words.filter((w) => !w.includes(' ') && !isDateish(w));
    if (qContent.length) {
      fused = fused
        .map((f) => {
          if (!isCatalogue(f.path)) return f;
          const baseWords = new Set(tokenize(f.path.split('/').pop()!.replace(/\.md$/, '')));
          if (qContent.every((w) => baseWords.has(w))) return f; // user asked FOR the catalogue
          return { ...f, rrf: f.rrf * RETRIEVAL_SCHEMA.catalogueDemotion };
        })
        .sort((a, b) => b.rrf - a.rrf || a.path.localeCompare(b.path));
    }
  }

  // dated-sibling demotion: keep the best per date-stripped key, demote twins
  const seenKey = new Map<string, number>();
  fused = fused
    .map((f) => {
      // A date-ONLY filename ("2026-05-31.md") strips to an empty key; fall back to
      // the unique path so every such note isn't collapsed into one "sibling" group.
      const k = dateKey(f.path) || f.path;
      const n = seenKey.get(k) ?? 0;
      seenKey.set(k, n + 1);
      return n === 0 ? f : { ...f, rrf: f.rrf * 0.95 };
    })
    .sort((a, b) => b.rrf - a.rrf || a.path.localeCompare(b.path));

  // pinpoint injection: a note containing ALL of the query's rare terms
  // (>=2 of them) is what the user is pointing at — RRF dilution across nine
  // lanes must not bury it.
  {
    const rareTerms = words.filter((w) => {
      if (w.includes(' ') || isDateish(w)) return false;
      const m = vaultTexts.contentIndex?.get(w);
      return !!m && m.size > 0 && m.size <= 25;
    });
    if (rareTerms.length >= 2) {
      const perNote = new Map<string, number>();
      for (const w of rareTerms) {
        for (const f of vaultTexts.contentIndex!.get(w)!.keys()) {
          if (f.startsWith('System/') || isCatalogue(f)) continue; // never pin machine state or an aggregator
          perNote.set(f, (perNote.get(f) || 0) + 1);
        }
      }
      // Pin the top TWO all-rare-terms notes (was one): when several notes carry
      // both rare words, sourcePrior's tie-break can put a session log first and
      // the actual answer second — the measured "lunches weddings" miss.
      const pins = [...perNote.entries()]
        .filter(([, c]) => c === rareTerms.length)
        .sort((a, b) => sourcePrior(b[0]) - sourcePrior(a[0]) || a[0].localeCompare(b[0]))
        .slice(0, 2);
      let slot = 2;
      for (const [p] of pins) {
        if (fused.slice(0, 3).some((f) => f.path === p)) continue;
        const hit = fused.find((f) => f.path === p);
        const others = fused.filter((f) => f.path !== p);
        fused = [...others.slice(0, slot), hit ?? { path: p, rrf: 0 }, ...others.slice(slot)];
        slot++;
      }
    }

    // Pair-intersection pin: the rare-term pin above needs EACH word to be rare,
    // but a conjunction of two individually-COMMON words can still be a
    // distinctive pointer — "sharjah translation" (each df ~30+) co-occurs in
    // only a couple of notes. If the AND-set of the query's 2-3 content words
    // is tiny (≤6 notes), those notes are the honest candidates by construction
    // — surface the best two.
    const pairTerms = words.filter((w) => !w.includes(' ') && !isDateish(w) && w.length >= 4 && vaultTexts.contentIndex?.get(w));
    if (pairTerms.length >= 2 && pairTerms.length <= 3 && rareTerms.length < 2) {
      let acc: string[] = [...vaultTexts.contentIndex!.get(pairTerms[0])!.keys()];
      for (const w of pairTerms.slice(1)) {
        const m = vaultTexts.contentIndex!.get(w)!;
        acc = acc.filter((f) => m.has(f));
        if (!acc.length) break;
      }
      const and = acc.filter((f) => !f.startsWith('System/') && !isCatalogue(f));
      if (and.length >= 1 && and.length <= 6) {
        // Prefer the AND-note whose TITLE carries the pair terms (it is ABOUT
        // them), then non-sponge sources, then freshness.
        const titleHits = (f: string) => {
          const st = new Set(tokenize(f.split('/').pop()!.replace(/\.md$/, '')));
          return pairTerms.filter((w) => st.has(w)).length;
        };
        const best = and
          .sort(
            (a, b) =>
              titleHits(b) - titleHits(a) ||
              sourcePrior(b) - sourcePrior(a) ||
              (vaultTexts.mtimes.get(b) ?? 0) - (vaultTexts.mtimes.get(a) ?? 0) ||
              a.localeCompare(b),
          )
          .slice(0, 2);
        let slot = 2;
        for (const p of best) {
          if (fused.slice(0, 3).some((f) => f.path === p)) continue;
          const hit = fused.find((f) => f.path === p);
          const others = fused.filter((f) => f.path !== p);
          fused = [...others.slice(0, slot), hit ?? { path: p, rrf: 0 }, ...others.slice(slot)];
          slot++;
        }
      }
    }
  }

  // category-recency injection: a temporal question about a CATEGORY — "when
  // was the last MEETING", "what OPPORTUNITIES are active right now", "latest
  // update on ACME" — is answered by the freshest notes under the folder (or
  // title) that carries that category noun. Lexical lanes can't see this
  // (transcripts rarely contain the word "meeting"; their FOLDER does). Take
  // the query's highest-idf content word that names a real category (matches
  // path-segment tokens of 2..15% of notes, plural-folded — an unbounded match
  // like "chatgpt", which prefixes hundreds of Memory titles, is a naming
  // CONVENTION, not a category), inject its 2 freshest non-catalogue notes at
  // slots 3-4. Runs BEFORE the stronger naming-level injections so they land
  // on top of it, never under it.
  if (temporal) {
    const fold = (st: Set<string>, w: string) => st.has(w) || st.has(w + 's') || (w.endsWith('s') && st.has(w.slice(0, -1)));
    // FOLDER matches are uncapped: a folder is the vault's own curated category
    // ("Meetings/", "Opportunities/"), however big. BASENAME matches are capped:
    // "chatgpt" prefixes hundreds of Memory titles — a naming convention,
    // not a category.
    const maxBase = Math.max(20, Math.floor(vaultTexts.files.length * 0.15));
    const cand = words
      .filter((w) => !w.includes(' ') && !isDateish(w) && w.length >= 4)
      .sort((a, b) => (idfMapEarly.get(b) ?? 0) - (idfMapEarly.get(a) ?? 0));
    // Among folder-matching candidates take the SMALLEST folder set (the most
    // specific category): for "…acme…references…" the 12-note Acme folder is
    // the category, not the 350-note Reference/ tree that "references" matches.
    // Reference/Skills is machine tooling, not vault knowledge — a "meeting"
    // category must surface meetings, not the meeting-prep skill.
    const eligible = (f: string) => !f.startsWith('System/') && !f.startsWith('Reference/Skills/') && !isCatalogue(f);
    let matched: string[] = [];
    let matchedWord = '';
    for (const w of cand) {
      const inFolder = vaultTexts.files.filter(
        (f) => eligible(f) && fold(new Set(tokenize(f.split('/').slice(0, -1).join('/'))), w),
      );
      if (inFolder.length >= 2 && (!matched.length || inFolder.length < matched.length)) { matched = inFolder; matchedWord = w; }
    }
    if (!matched.length) {
      for (const w of cand) {
        const byName = vaultTexts.files.filter(
          (f) => eligible(f) && fold(new Set(tokenize(f.split('/').pop()!.replace(/\.md$/, ''))), w),
        );
        if (byName.length >= 2 && byName.length <= maxBase) { matched = byName; break; }
      }
    }
    // Displacement gate: if the fused top-5 ALREADY carries a category member,
    // the lexical lanes answered the question — injecting would only push a
    // correct result off the page (measured: -3.5/-7.5pts on the certified v4
    // temporal family, whose targets usually match the key lexically).
    if (matched.length) {
      const matchedSet = new Set(matched);
      if (fused.slice(0, 5).some((f) => matchedSet.has(f.path))) matched = [];
    }
    if (matched.length) {
      // TRUST FIX 3 (architecture review P9): if the query names a SPECIFIC
      // topic beyond the category word ("latest meeting about the acme discount"
      // — category=meeting, topic=acme/discount), the freshest folder note must
      // actually mention that topic. Without this, mtime alone returned a
      // fresh-but-irrelevant note dressed as a confident answer. When the query
      // is only the category ("latest meeting"), there's no extra topic to check
      // and freshness stands.
      // Only DISTINCTIVE topic words gate (a specific entity like "acme", df<=20),
      // never common descriptors ("transcribed", "did") that describe the
      // category itself — those aren't a topic and filtering on them wrongly
      // emptied "last meeting transcribed" (gold Q12). And degrade gracefully:
      // if the topic filter leaves nothing, fall back to freshest-in-category
      // rather than injecting nothing.
      const topicWords = words.filter(
        (w) => !w.includes(' ') && !isDateish(w) && w.length >= 4 && w !== matchedWord && (index.df.get(w) ?? 0) <= 20,
      );
      const onTopic = (p: string) => {
        const t = (vaultTexts.texts.get(p) ?? '').toLowerCase();
        return topicWords.some((w) => t.includes(w));
      };
      const topical = topicWords.length ? matched.filter(onTopic) : [];
      const freshest = (topical.length ? topical : matched)
        .sort((a, b) => recencyMs(b) - recencyMs(a))
        .slice(0, 2);
      let slot = 2;
      for (const p of freshest) {
        if (fused.slice(0, 5).some((f) => f.path === p)) continue;
        const hit = fused.find((f) => f.path === p);
        const others = fused.filter((f) => f.path !== p);
        fused = [...others.slice(0, slot), hit ?? { path: p, rrf: 0 }, ...others.slice(slot)];
        slot++;
      }
    }
  }

  // title-subset injection (the inverse of known-item): the QUERY CONTAINS a
  // note's entire title — "do I have any open api key on chatgpt…" contains
  // the full title "API Keys" — so the user is naming that note inside a longer
  // sentence, even though the sentence's extra words (chatgpt, openai) drag
  // every similarity lane toward content-heavy notes. Plural-folded so
  // key/keys match. Gated: ≥2 non-date title tokens, all in the query.
  {
    const qTok = new Set(words.filter((w) => !w.includes(' ')));
    const qHas = (t: string) => qTok.has(t) || qTok.has(t + 's') || (t.endsWith('s') && qTok.has(t.slice(0, -1)));
    let best: { path: string; mass: number } | null = null;
    for (const note of index.notes) {
      if (note.path.startsWith('System/')) continue; // quarantine twins share titles — never inject
      const tks = note.title.filter((t) => !isDateish(t));
      if (tks.length < 2 || tks.length > 6) continue; // long titles: covered by known-item instead
      if (!tks.every(qHas)) continue;
      let mass = 0;
      for (const t of tks) mass += Math.log2(1 + index.n / Math.max(index.df.get(t) ?? 1, 1));
      if (!best || mass > best.mass || (mass === best.mass && note.path < best.path)) best = { path: note.path, mass };
    }
    if (best && !fused.slice(0, 5).some((f) => f.path === best!.path)) {
      const hit = fused.find((f) => f.path === best!.path);
      const others = fused.filter((f) => f.path !== best!.path);
      fused = [...others.slice(0, 3), hit ?? { path: best.path, rrf: 0 }, ...others.slice(3)];
    }
  }

  // entity-hop injection (Gbrain's alias-hop pattern): a fuzzy entity match is
  // the user NAMING something with a voice-slip — it must reach the agent, so
  // the best entity hit is guaranteed a top-5 slot. When the word that matched
  // is the query's MOST DISTINCTIVE (highest-idf) content word, the whole query
  // hinges on that entity ("decision on projekt" → Project) — slot 2, so it also
  // survives a comparison split's interleave ("alpha versus beta" keeps each
  // side's entity in the final top-4).
  if (entityLane.length && !fused.slice(0, 5).some((f) => f.path === entityLane[0])) {
    const contentWs = words.filter((w) => !w.includes(' ') && !isDateish(w) && w.length >= 3);
    const maxIdf = Math.max(0, ...contentWs.map((w) => idfMapEarly.get(w) ?? 0));
    const namingWord = contentWs.some((w) => {
      if ((idfMapEarly.get(w) ?? 0) < maxIdf - 1e-9) return false;
      const common = (index.df.get(w) ?? 0) > index.n * 0.02; // mirror the entity lane's gate
      return fuzzyEntity(index.entityNames, w).some((h) => h.path === entityLane[0] && h.edits <= 2 && (!common || h.kind === 'prefix'));
    });
    const hit = fused.find((f) => f.path === entityLane[0]);
    const others = fused.filter((f) => f.path !== entityLane[0]);
    const slot = namingWord ? 1 : 4;
    fused = [...others.slice(0, slot), hit ?? { path: entityLane[0], rrf: 0 }, ...others.slice(slot)];
  }

  // known-item short-circuit: the user NAMED a note — the exact title/alias
  // match takes rank 1 outright (dated siblings resolved by exact date match).
  const ki = kiEarly;
  let siblingClarify: RecallAnswer['clarify'];
  const kiPin =
    kiCover >= RETRIEVAL_SCHEMA.knownItemPinMin ||
    (ki.matchCount === 1 && kiCover >= RETRIEVAL_SCHEMA.knownItemPinUniqueMin);
  if (ki.isKnownItem && ki.exactMatches.length && kiPin) {
    const head = ki.exactMatches[0];
    fused = [{ path: head, rrf: Infinity }, ...fused.filter((f) => f.path !== head)];
    // "which date?" — the query names a document that exists in ≥2 dated
    // versions and carries no date itself: surface the fork, best-first.
    const queryHasDate = words.some((w) => isDateish(w));
    if (!queryHasDate && ki.exactMatches.length >= 2) {
      const stems = new Set(ki.exactMatches.slice(0, 4).map((p) => dateKey(p)));
      if (stems.size === 1) {
        siblingClarify = {
          reason: `${ki.exactMatches.length} dated versions of this document exist — best guess is first, confirm WHICH DATE is meant.`,
          options: ki.exactMatches.slice(0, 4).map((p) => ({ path: p, hint: p.split('/').slice(0, -1).join('/') || '(root)' })),
        };
      }
    }
  }

  // Final System/ chokepoint: the injections and the known-item pin above all
  // splice paths into `fused` AFTER the post-fusion System filter, so a
  // quarantined twin (same title tokens as a real note) could be resurrected
  // at any rank. The sources are individually guarded too; this is the
  // guarantee that no future injection can regress it.
  fused = fused.filter((f) => !f.path.startsWith('System/'));

  // ── honesty gate (v1's semantics, judged on the fused pick too) ──
  const idfMap = idfMapEarly;
  const topPath = fused[0]?.path;
  const topCov = topPath
    ? coverage(bestSection(topPath, vaultTexts.texts.get(topPath) || '', words, idfMap).section, words, idfMap)
    : 0;
  const gateCov = Math.max(r.finalCoverageRaw, topCov);
  // TRUST FIX 1 (17 Jul, architecture review P1): the gate was lexical-only, so
  // a note that is the correct SEMANTIC answer but worded differently from the
  // query got asserted "not in your brain". Give semantic a confirming vote:
  // rescue from refusal when the note we'd return sits in the semantic lane's
  // head (top 3). Semantic can only CONFIRM a lexically-weak note, never invent
  // one absent from fusion, so this closes the silent-refusal hole without
  // opening fabrication. Conservative top-3 (top-5 was measured to leak more
  // personal negatives than it recovered). Degrades safely: semLane empty
  // (post-reindex / model off) → this term is false and lexical carries alone.
  // STALE-VECTOR GUARD (P2 #3): the embedding cache can lag the vault between an
  // edit and the next re-index (loadEmbeddings serves cached vectors, it does not
  // re-embed). Only let semantic RESCUE a lexically-weak note from refusal when
  // the cached vector for THAT note was built from its CURRENT content — a stale
  // vector must never confirm an answer the note no longer contains, or the
  // honesty gate would assert a fact the file has since lost. noteHashes stamps
  // Vault.contentHash(raw) at embed time; we recompute it on the live text.
  // Fails OPEN when the note carries no recorded hash (older cache) so a fresh
  // brain behaves exactly as before.
  const topEmbHash = topPath ? emb?.noteHashes?.[topPath] : undefined;
  const semFresh = !topEmbHash || (!!topPath && topEmbHash === contentHash16(vaultTexts.texts.get(topPath) || ''));
  // ENTITY-ABSENCE GUARD (25 Jul): the semantic rescue exists to save a note that
  // IS the right answer but is worded differently from the query — that note has
  // the queried entity PRESENT (low absent-mass). It must NOT rescue when the
  // specific entity the user named is almost entirely absent from the corpus: a
  // temporal/recall query about a non-existent entity ("latest on <nonsense>")
  // otherwise gets a recent note confirmed by embedding proximity to the query's
  // filler words, bypassing the gate. When most of the query's idf-mass is absent
  // there is nothing legitimate to rescue, so semantic must not override refusal.
  // COSINE ESCAPE HATCH — TRIED, MEASURED, REJECTED (25 Jul). The guard above is
  // known to be blunt: it also refuses a legitimate PARAPHRASE, where the one
  // distinctive word is a synonym the vault never uses (df=0) and absentMass
  // lands ~0.8 — arithmetically identical to a nonsense entity. The proposed fix
  // was a second, narrower door: let a high-cosine top note through anyway. It
  // does not work, and the numbers are worth keeping so nobody re-derives them:
  //
  //   top-note cosine, contested queries   negative        paraphrase
  //     p05 / p50 / max                    0.834/0.851/0.870   0.838/0.860/0.872
  //
  // The distributions sit on top of each other — e5's dynamic range on short
  // queries is ~0.04 wide, so an absolute cosine carries almost no signal. Every
  // threshold that recovered anything leaked nonsense: 0.86 bought 2 more
  // paraphrase answers for 49 nonsense queries newly answered (negatives refused
  // 100.0% → 96.6%); at 0.88+ the door is shut again and the gain is exactly zero.
  // The guard itself is cheap and effective in the other direction: it blocks 580
  // of 1450 nonsense queries that would otherwise be confidently answered, and
  // costs 5 paraphrase answers out of 178. Keeping it is a 116:1 trade.
  //
  // The real paraphrase ceiling is upstream anyway, not here: the semantic lane
  // ranks the correct note #1 for ~12% of paraphrase queries and top-3 for ~26%,
  // with a median cosine gap of ~0.01 between its #1 and the right answer. A gate
  // cannot rescue what retrieval never surfaced — that needs a precision stage or
  // a model with real separation, not a looser honesty rule.
  // TRACEABILITY: those three upstream figures came from the calibration run and
  // are NOT in the retained test/_calib-report.txt (that artifact predates the
  // harness's UPSTREAM CEILING block), so they are quoted here to one significant
  // figure. Reproduce them — and the sweep above — with
  //   CALLOSIUM_GATE_PROBE=1 node test/calibrate-sem-rescue.mjs "<brain>"
  // Re-measure whenever EMBEDDER_VERSION changes: cosines only compare within one
  // embedder, and the sweep's floor must be re-derived, not inherited.
  const semTopScore = topPath ? (semScores.get(topPath) ?? 0) : 0;
  // Split out so the calibration harness can replay a sweep exactly.
  const semEligible = semLane.length > 0 && !!topPath && semFresh && semLane.slice(0, 3).includes(topPath);
  // Calibration-only, and deliberately INERT in a shipped build. Two hazards this
  // closes. (1) `Number('')` is 0, so a CALLOSIUM_SEM_RESCUE_MIN that exists but is
  // blank — an empty line in a .env, a `set VAR=` on Windows — would silently drop
  // the floor to 0 and let the semantic lane rescue EVERY query, measured at
  // 100% → 60.7% of nonsense questions refused. (2) A threshold that decides whether
  // the honesty gate can be overridden must not be settable by ambient environment
  // in production at all. So: honored only while the calibration probe is active
  // (CALLOSIUM_GATE_PROBE=1, which calibrate-sem-rescue.mjs requires), and only for
  // a finite number. Anything else — unset, blank, junk, Infinity — is Infinity,
  // which makes the score branch dead and the gate byte-identical to 574508f.
  const rescueRaw = process.env.CALLOSIUM_SEM_RESCUE_MIN;
  const rescueNum = rescueRaw == null || rescueRaw.trim() === '' ? Infinity : Number(rescueRaw);
  const semRescueMin = _gateProbe && Number.isFinite(rescueNum) ? rescueNum : Infinity;
  const semConfirms = semEligible && (r.absentMass < 0.5 || semTopScore >= semRescueMin);
  const gateFires = !fused.length || gateCov < 0.2 || (r.absentMass > 0.35 && gateCov < 0.6);
  _gateProbe?.log.push({
    question,
    topPath: topPath ?? null,
    absentMass: r.absentMass,
    gateCov,
    semTopScore,
    semEligible,
    semFresh,
    gateFires,
    semConfirms,
  });
  if (gateFires && !semConfirms) {
    // ── drop-tokens relaxation (Typesense drop_tokens_threshold, adapted):
    // strict interpretation failed — retry once without the LOWEST-IDF
    // content word (voice filler sits anywhere, so we drop by weakness, not
    // position). Disclosed, never silent. Honesty-preserving: invented/rare
    // terms are the HIGHEST-idf words, so they are never the ones dropped —
    // a question about an unknown entity still refuses.
    if (!_noSplit) {
      const singles = words.filter((w) => !w.includes(' ') && !isDateish(w));
      if (singles.length >= 3) {
        const byIdf = [...singles].sort((a, b) => (idfMap.get(a) ?? 1) - (idfMap.get(b) ?? 1));
        const drop = byIdf[0];
        // Same backspace-in-template-literal trap as the corrections block:
        // concatenated RegExp + script-aware boundaries, double-escaped $&.
        const dropEsc = drop.replace(/[.*+?^$()|[\]{}\\]/g, '\\$&');
        const relaxedQ = question
          .replace(new RegExp('(?<![a-z0-9؀-ۿ])' + dropEsc + '(?![a-z0-9؀-ۿ])', 'gi'), ' ')
          .replace(/\s+/g, ' ');
        const relaxed = relaxedQ.trim().toLowerCase() !== question.trim().toLowerCase()
          ? await recall(relaxedQ, vaultTexts, graph, true, emb, { rich, temporal, episodic })
          : { found: false as const, results: [] };
        if (relaxed.found) {
          return {
            ...relaxed,
            corrections: [...(corrections ?? []), ...(relaxed.corrections ?? [])],
            relaxation: { droppedTerms: [drop, ...(relaxed.relaxation?.droppedTerms ?? [])] },
          };
        }
      }
    }
    const absent = r.absentTerms.length ? ` The brain never mentions: ${r.absentTerms.join(', ')}.` : '';
    return {
      found: false,
      results: [],
      notInBrainReason: `No note answers this (best coverage ${gateCov.toFixed(2)}).${absent}`,
      ...(corrections.length ? { corrections } : {}),
    };
  }

  // ── NO second-stage reranker here, on purpose (retired 25 Jul) ────────────
  // A cross-encoder precision stage lived at this exact point — after the honesty
  // gate, never before it — and was removed after the full 15K CallosiumBench
  // measured it at 94.0% vs 96.4% with it off, and p99 latency 143ms → 2439ms.
  // It lost content -8pt (it second-guesses a correct rare-word literal match),
  // ambiguous:ar -31pt (it collapses the ">=2 siblings → clarify" tie into one
  // confident pick) and compare -2pt, winning only typo +0.8pt where the lexical
  // signal is genuinely corrupted. Narrowing the gate does not rescue it: wins and
  // losses are statistically identical on every feature this code can compute
  // (closeRace 89% of both), closeRace is a strict subset of the clarify near-tie
  // band, and an exhaustive search of 23,100 gate bands found nothing shippable —
  // its best candidate helped 3 distinct retrieval cases and did not survive a
  // split-half holdout. Full reasoning and numbers: docs/RERANKER.md.
  //
  // If a precision stage is ever reintroduced it goes HERE, after the gate, never
  // before: running it first was measured to collapse negatives-refused 18.8%→6.3%
  // for only +1.2pt of positives, and a confident false answer is the cardinal sin.

  // ── evidence assembly for the fused top 5 (top 8 + double budget when the
  // question carries build intent — the agent is about to produce work) ──
  const results: RecallResult[] = [];
  let chunkBudget = rich ? RETRIEVAL_SCHEMA.budgets.answerCharsRich : RETRIEVAL_SCHEMA.budgets.answerChars; // total chars across the whole answer
  for (const { path: f } of fused.slice(0, rich ? RETRIEVAL_SCHEMA.budgets.topResultsRich : RETRIEVAL_SCHEMA.budgets.topResults)) {
    // Budget caps rich mode's EXTRA results (6–8) only — the standard top-5
    // must always come through (a large index note at rank 1-2 could otherwise
    // exhaust the budget and drop a legitimate rank-3 answer, which regressed
    // content by ~4pts). Extras are gutter; the core five are the answer.
    if (rich && results.length >= 5 && chunkBudget <= 0) break;
    const sections = bestSections(f, vaultTexts.texts.get(f) || '', words, idfMap, rich ? 5 : 3);
    const section = sections[0] ?? bestSection(f, vaultTexts.texts.get(f) || '', words, idfMap);
    const more: { heading: string | null; excerpt: string }[] = [];
    chunkBudget -= section.section.length;
    for (const sec of sections.slice(1)) {
      if (chunkBudget - sec.section.length < 0) break;
      more.push({ heading: sec.heading, excerpt: sec.section });
      chunkBudget -= sec.section.length;
    }
    const ev = evidenceFor(f, section.section, words);
    const base = f.split('/').pop()!.replace(/\.md$/, '').toLowerCase();
    const rare = words.filter((w) => !r.absentTerms.includes(w));
    const filenameHits = rare.filter((w) => base.includes(w)).length;
    // Confidence must describe THIS result. `gateCov` was computed on fused[0], so
    // the TOP result (results.length === 0 here) IS the gateCov note → keep gateCov;
    // but results 2..N previously ALSO inherited gateCov (the TOP's coverage),
    // overstating their confidence (ChatGPT I13) — they now get their OWN section
    // coverage. Only a display hint; never affects ranking/found.
    const covForLabel = results.length === 0 ? gateCov : coverage(section.section, words, idfMap);
    const createSafety: RecallResult['createSafety'] =
      // A novel-term auto-correction can never yield a confident 'exists' — the
      // corrected word might be a different entity than the user meant (TRUST FIX 2).
      (!novelCorrection && filenameHits >= Math.max(1, Math.ceil(rare.length * 0.6))) ? 'exists'
        : covForLabel >= 0.4 ? 'probable' : 'unknown';
    results.push({ path: f, excerpt: section.section, evidence: ev, createSafety, ...(more.length ? { moreChunks: more } : {}) });
  }

  // ── ambiguity detection: near-tied, genuinely distinct top candidates ──
  // (different date-groups/folders, not dupes of one document). The agent is
  // told to ask the user which one they mean instead of guessing.
  let clarify: RecallAnswer['clarify'] = siblingClarify;
  // Two behaviors live here: (a) an honesty REFUSAL when the top matches are
  // scattered low-coverage noise, and (b) a near-tie option-list clarify prompt.
  // Both read the rrf near-tie set. Note for anyone reintroducing a reordering
  // stage above: (b) depends on `.rrf` ordering and would go stale, but (a) is a
  // coverage+anchoring judgment that MUST keep running either way — else the new
  // stage silently converts an honest "not in your brain" into a confident answer.
  if (!clarify && !ki.isKnownItem && !temporal && fused.length >= 2 && isFinite(fused[0].rrf)) {
    const contenders = fused.slice(0, 4).filter((f) => f.rrf >= fused[0].rrf * 0.88);
    if (contenders.length >= 2) {
      // Weak near-tie = scattered single-word noise, not genuine ambiguity:
      // when even the best candidate's bonus-free coverage is under the floor
      // AND no contender carries a DISTINCTIVE query term in its title/alias/
      // headings (pure body-scatter), the honest answer is "not in your
      // brain", not a garbage option list. The anchor check keeps rescuable
      // cases alive: a typo-corrected query whose word sits in a real note's
      // alias is genuine ambiguity worth clarifying, not noise.
      if (gateCov < RETRIEVAL_SCHEMA.clarifyRefuseFloor) {
        const content = words.filter((w) => !isDateish(w));
        const avgIdf = content.reduce((s, w) => s + (idfMap.get(w) ?? 1), 0) / Math.max(content.length, 1);
        const distinctive = content.filter((w) => (idfMap.get(w) ?? 1) >= avgIdf);
        const anchored = contenders.some((c) => {
          const nf = index.byPath.get(c.path);
          return !!nf && distinctive.some((w) => nf.titleSet.has(w) || nf.headings.includes(w));
        });
        if (!anchored) {
          const absent = r.absentTerms.length ? ` The brain never mentions: ${r.absentTerms.join(', ')}.` : '';
          return {
            found: false,
            results: [],
            notInBrainReason: `No note answers this with confidence (best coverage ${gateCov.toFixed(2)}; ${contenders.length} weak scattered matches).${absent}`,
            ...(corrections.length ? { corrections } : {}),
          };
        }
      }
      const sameStem = new Set(contenders.map((f) => dateKey(f.path))).size === 1;
      clarify = {
        reason: sameStem
          ? `${contenders.length} dated versions of the same document match — confirm WHICH DATE is meant.`
          : `${contenders.length} distinct notes match this about equally — confirm which one is meant.`,
        options: contenders.slice(0, 4).map((f) => ({
          path: f.path,
          hint: f.path.split('/').slice(0, -1).join('/') || '(root)',
        })),
      };
    }
  }

  // ── interlinked context: the top result's neighborhood, up to 3 hops ──
  // Pointers only (path + relation + hop) — the agent read_notes what it
  // needs, so context depth can never blow the consumer's window.
  let context: RecallAnswer['context'];
  if (graph && results.length) {
    const top = results[0].path;
    // Rich mode: the cluster is anchored on the top TWO results (entity note
    // + its best evidence doc), and the pointer cap doubles — a build task
    // needs the whole neighborhood on the table.
    const cap = rich ? RETRIEVAL_SCHEMA.budgets.contextCapRich : RETRIEVAL_SCHEMA.budgets.contextCap;
    const seeds = rich ? results.slice(0, 2).map((x) => x.path) : [top];
    const seedSet = new Set(seeds);
    const byNode = new Map<string, { relation: string; direction: 'out' | 'in'; hops: number }>();
    let frontier = new Set(seeds);
    for (let hop = 1; hop <= 3 && byNode.size < cap; hop++) {
      const next = new Set<string>();
      for (const e of graph.edges) {
        if (e.unresolved) continue;
        // Existence guard: a first-load session may serve an unpruned graph.json, so
        // an edge to a note deleted/renamed while the process was down could hand the
        // agent a context pointer whose read_note ENOENTs. Skip any endpoint not in
        // the live text set — it's neither emitted nor traversed through.
        if (frontier.has(e.from) && !seedSet.has(e.to) && !byNode.has(e.to) && vaultTexts.texts.has(e.to)) {
          byNode.set(e.to, { relation: e.type, direction: 'out', hops: hop });
          next.add(e.to);
        } else if (frontier.has(e.to) && !seedSet.has(e.from) && !byNode.has(e.from) && vaultTexts.texts.has(e.from)) {
          byNode.set(e.from, { relation: e.type, direction: 'in', hops: hop });
          next.add(e.from);
        }
        if (byNode.size >= cap) break;
      }
      frontier = next;
      if (!frontier.size) break;
    }
    context = [...byNode.entries()].map(([p, m]) => ({ path: p, relation: m.relation, direction: m.direction, hops: m.hops }));
    if (!context.length) context = undefined;
  }

  return {
    found: true,
    results,
    ...(context ? { context } : {}),
    ...(clarify ? { clarify } : {}),
    ...(corrections.length ? { corrections } : {}),
    ...(rich && results.length
      ? {
          richness: {
            anchor: results[0].path,
            guidance:
              'Build intent detected — this answer is EQUIPMENT, not a lookup. Before producing work: read_note the full text of every result and every context pointer that looks like reference docs, prior PoCs/proposals (their gotchas especially), or related skills. If anything is still missing while you build, recall again with the specific gap as the question. Do not build from excerpts alone.',
          },
        }
      : {}),
  };
}
