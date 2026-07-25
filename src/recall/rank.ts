// The fused ranker — recall v2. Replaces winner-take-all displacement with
// the published, deterministic retrieval stack (research pass, 11 Jul 2026):
//
//   lane 1  title/known-item  (filename + alias words, the v1 stage-2 scorer's job)
//   lane 2  BM25F             (field-weighted: title+aliases / headings / body;
//                              Robertson & Zaragoza CIKM'04; k1=1.2)
//   lane 3  proximity         (min-span of query terms in body; Büttcher SIGIR'06)
//   lane 4  graph             (backlink log-prior + 1-hop reinforcement from
//                              text-matched seeds; Craswell SIGIR'05 damping)
//
// fused with Reciprocal Rank Fusion, k=60 (Cormack SIGIR'09) — rank positions
// only, no score mixing. Known-item queries (user names the note) short-circuit
// to the exact title/alias match. Everything deterministic: fixed constants,
// ties broken by path.

import { tokenize, isDateish } from './tokens.ts';
import { buildFuzzyIndex, type FuzzyIndex } from './fuzzy.ts';
import { parseAliases } from '../core/aliases.ts';
import type { GraphIndex } from '../core/types.ts';

// ─── field index (built once per text-cache load) ─────────────────────

export interface NoteFields {
  path: string;
  /** title + frontmatter aliases, tokenized */
  title: string[];
  titleSet: Set<string>;
  headings: string[];
  /** body term frequencies */
  bodyTf: Map<string, number>;
  /** body token positions for proximity */
  positions: Map<string, number[]>;
  /** terms whose `positions` list hit POS_CAP. Their stored list is a PREFIX of
   *  where the term really occurs, so proximity past its last entry is unknown —
   *  proximityScore uses this to avoid reporting a span it can't verify. */
  saturated: Set<string>;
  bodyLen: number;
  headingsLen: number;
  titleLen: number;
  archived: boolean;
}

export interface RankIndex {
  notes: NoteFields[];
  byPath: Map<string, NoteFields>;
  /** blended document frequency (a term counts once per note, any field) */
  df: Map<string, number>;
  avgBodyLen: number;
  avgTitleLen: number;
  avgHeadingsLen: number;
  backlinks: Map<string, number>;
  /** resolved outgoing/incoming adjacency (undirected view) */
  neighbors: Map<string, Set<string>>;
  n: number;
  /** entity display names (titles + aliases of entity-partition notes) for
   *  fuzzy voice-mangle matching — small, distinctive vocabulary. */
  entityNames: { name: string; path: string }[];
  fuzzy: FuzzyIndex;
}

// Alias parsing lives in ../core/aliases.ts (single source of truth — see P2 #9).

// Per-term ceiling on stored body positions. It exists for COST, not accuracy:
// uncapped, the proximity merge-scan over the biggest note the indexer accepts
// (5MB, engine.ts:175 MAX_NOTE_BYTES) measures 23ms for ONE note, and the scan
// runs over ~100 candidates twice per query (proxLane + tsMatch lane). But the
// old value of 200 was far too tight and undocumented: measured over a 498-file
// real-markdown corpus it truncated a term in 18 files, and because a truncated
// list is a PREFIX, the min-span scan then measured against a stale head of the
// note and reported the fabricated distance as fact. At 2000, ONE of those 498
// files still truncates, positions memory grows 6% (uncapped is 6.3% — the cap
// buys almost nothing on real prose) and the worst-case scan stays ~1ms.
// Whatever still saturates is recorded, so proximityScore can decline to answer
// rather than invent (see the horizon guard there).
const POS_CAP = 2000;

export function buildRankIndex(
  files: string[],
  texts: Map<string, string>,
  archived: Set<string>,
  graph: GraphIndex | null,
): RankIndex {
  const notes: NoteFields[] = [];
  const df = new Map<string, number>();
  let sumBody = 0,
    sumTitle = 0,
    sumHead = 0;

  for (const f of files) {
    const text = texts.get(f) || '';
    // Scan the WHOLE leading frontmatter block for aliases, not a fixed 500-byte
    // window (a note with long frontmatter above `aliases:` would lose them).
    const fmEnd = text.startsWith('---') ? text.indexOf('\n---', 3) : -1;
    const aliases = parseAliases(fmEnd > 0 ? text.slice(0, fmEnd) : text.slice(0, 500));
    const title = tokenize(f.split('/').pop()!.replace(/\.md$/, '') + ' ' + aliases.join(' '));
    // The headings FIELD includes markdown table ROW-LABELS ("| DNS (Hostinger)
    // | A @ ...") alongside `#` headings: row-labels are how registry notes
    // name their facts, and without them a fact stored in a table row has zero
    // presence outside the body field (16 Jul session benchmark: 5 of 12 true
    // misses were registry-table facts). Bold lead-ins ("**Coach note:**") were
    // tried and REVERTED: the same pattern matches transcript speaker labels
    // ("**Owner:** ..."), flooding chat-style notes' heading fields with
    // conversational vocabulary and regressing 3 gold questions. BM25F's
    // length norm absorbs the longer field for table-heavy notes.
    // Row-labels are harvested from FENCE-STRIPPED text: a fenced block of
    // pipe-formatted output (psql dumps, markdown-table examples) would
    // otherwise flood a verbatim note's headings field — the same sponge
    // mechanism that got the bold-lead-in variant reverted (17 Jul re-review).
    // `#` headings keep reading the raw text (long-standing behavior).
    const noFences = text.includes('```') ? text.replace(/```[\s\S]*?(?:```|$)/g, '') : text;
    const headings = tokenize(
      [
        ...[...text.matchAll(/^#{1,4} (.+)$/gm)].map((m) => m[1]),
        ...[...noFences.matchAll(/^\|([^|\n]+)\|/gm)].map((m) => m[1]).filter((c) => !/^[\s:\-]+$/.test(c)),
      ].join(' '),
    );

    const bodyTf = new Map<string, number>();
    const positions = new Map<string, number[]>();
    const saturated = new Set<string>();
    const bodyTokens = tokenize(text);
    for (let i = 0; i < bodyTokens.length; i++) {
      const w = bodyTokens[i];
      bodyTf.set(w, (bodyTf.get(w) || 0) + 1);
      let arr = positions.get(w);
      if (!arr) positions.set(w, (arr = []));
      if (arr.length < POS_CAP) arr.push(i);
      else saturated.add(w);
    }

    const nf: NoteFields = {
      path: f,
      title,
      titleSet: new Set(title),
      headings,
      bodyTf,
      positions,
      saturated,
      bodyLen: bodyTokens.length,
      headingsLen: headings.length,
      titleLen: title.length,
      archived: archived.has(f),
    };
    notes.push(nf);
    sumBody += nf.bodyLen;
    sumTitle += nf.titleLen;
    sumHead += nf.headingsLen;

    const seen = new Set<string>([...title, ...headings, ...bodyTf.keys()]);
    for (const w of seen) df.set(w, (df.get(w) || 0) + 1);
  }

  const backlinks = new Map<string, number>();
  const neighbors = new Map<string, Set<string>>();
  if (graph) {
    for (const e of graph.edges) {
      if (e.unresolved) continue;
      backlinks.set(e.to, (backlinks.get(e.to) || 0) + 1);
      if (!neighbors.has(e.from)) neighbors.set(e.from, new Set());
      if (!neighbors.has(e.to)) neighbors.set(e.to, new Set());
      neighbors.get(e.from)!.add(e.to);
      neighbors.get(e.to)!.add(e.from);
    }
  }

  const n = Math.max(notes.length, 1);
  const entityNames: { name: string; path: string }[] = [];
  for (const f of files) {
    if (!/^(People|Initiatives|Knowledge|Ventures|Agents and Systems|Work[^/]*)\//.test(f)) continue;
    if (f.split('/').length > 3 || /\/Raw\//i.test(f)) continue;
    const base = f.split('/').pop()!.replace(/\.md$/, '');
    entityNames.push({ name: base, path: f });
    const text = texts.get(f) || '';
    const fmEnd = text.startsWith('---') ? text.indexOf('\n---', 3) : -1;
    for (const a of parseAliases(fmEnd > 0 ? text.slice(0, fmEnd) : text.slice(0, 500))) {
      if (a) entityNames.push({ name: a, path: f });
    }
  }
  return {
    notes,
    byPath: new Map(notes.map((x) => [x.path, x])),
    df,
    avgBodyLen: sumBody / n || 1,
    avgTitleLen: sumTitle / n || 1,
    avgHeadingsLen: sumHead / n || 1,
    backlinks,
    neighbors,
    n,
    entityNames,
    fuzzy: buildFuzzyIndex(df, n),
  };
}

// ─── source-type priors (the aggregator-sponge fix) ───────────────────
// Meta notes (logs, indexes, audit reports, raw exports, transcripts) quote
// rare strings from everywhere and act as term sponges, stealing recall
// from the notes where knowledge actually lives. Content-lane matches in
// those partitions are demoted; curated knowledge keeps full strength.
// (Gbrain's source-prefix priors, made schema-conventional. Title-lane
// matches are NOT demoted — naming a log finds the log.)
export function sourcePrior(path: string): number {
  const base = path.split('/').pop()!.toLowerCase();
  // WORD match, mirroring engine.ts isCatalogue: substring 'moc' branded
  // "Landing Mockups.md" (and 'index' anything *index*) with the 0.5x
  // catalogue prior across three lanes (17 Jul re-review).
  const words = base.replace(/\.md$/, '').split(/[^a-z0-9؀-ۿ]+/u);
  if (words.includes('index') || words.includes('moc')) return 0.5;
  if (/^(logs|inbox)\//i.test(path)) return 0.7;
  if (/\/raw\/|raw exports\/|transcripts?\/|recovered sessions?\//i.test(path)) return 0.55;
  // Converted binary dumps ("… v1.0.docx (1).md") are verbatim imports, same
  // sponge behavior as /Raw/ — the note's content is a document, not knowledge.
  if (/\.(docx|pdf|xlsx|pptx)( \(\d+\))?$/i.test(base.replace(/\.md$/, ''))) return 0.55;
  // Verbatim scraped docs NAMED raw ("Typesense Docs Raw", "Vendor API Docs Raw",
  // "…Raw.md") are term sponges exactly like /Raw/ folders — the folder test
  // above missed them when the note sits directly under Reference/<vendor>/.
  // Still findable by NAME (title lane is never demoted).
  if (/\bdocs? raw\b|\braw docs?\b|\braw$/i.test(base.replace(/\.md$/, ''))) return 0.55;
  if (/audit|health check/i.test(base)) return 0.6;
  return 1;
}

// ─── BM25F ─────────────────────────────────────────────────────────────
// Field TFs are weighted and length-normalized BEFORE one shared saturation
// (the whole point of BM25F vs naive per-field bonuses), with blended IDF.

const K1 = 1.2;
const W_TITLE = 4,
  B_TITLE = 0.45;
const W_HEAD = 2,
  B_HEAD = 0.75;
const W_BODY = 1,
  B_BODY = 0.75;

function idf(index: RankIndex, w: string): number {
  const d = index.df.get(w) ?? 0;
  return Math.log(1 + (index.n - d + 0.5) / (d + 0.5));
}

export function bm25f(index: RankIndex, note: NoteFields, words: string[]): number {
  let score = 0;
  for (const w of words) {
    const tfTitle = note.titleSet.has(w) ? 1 : 0;
    let tfHead = 0;
    for (const h of note.headings) if (h === w) tfHead++;
    const tfBody = note.bodyTf.get(w) ?? 0;
    if (!tfTitle && !tfHead && !tfBody) continue;

    const norm =
      (W_TITLE * tfTitle) / (1 - B_TITLE + (B_TITLE * Math.max(note.titleLen, 1)) / index.avgTitleLen) +
      (W_HEAD * tfHead) / (1 - B_HEAD + (B_HEAD * Math.max(note.headingsLen, 1)) / index.avgHeadingsLen) +
      (W_BODY * tfBody) / (1 - B_BODY + (B_BODY * Math.max(note.bodyLen, 1)) / index.avgBodyLen);
    score += idf(index, w) * (norm / (norm + K1));
  }
  return score;
}

// ─── proximity lane (Büttcher-style, top candidates only) ─────────────

export function proximityScore(note: NoteFields, words: string[]): number {
  // DEDUPE first. `words` reaches here raw from tokenize() (engine.ts:1201) and
  // tokenize never dedupes, so "the old callosium plan and the new callosium
  // plan" arrived carrying callosium and plan twice each. Two wrong answers came
  // out of that: the `< 2` guard below was satisfied by ONE distinct term
  // repeated — ["budget","budget"] scored a PERFECT 1.0, maximum proximity from
  // a single word — and present/words counted a repeated term twice, so a note
  // matching 2 of the query's distinct terms outranked one matching 3. That is
  // the same inversion tsMatchScore already dedupes against before calling in
  // here; the guard belongs in this function so it holds for every caller.
  const uniq = [...new Set(words)];
  const present = uniq.filter((w) => note.positions.has(w));
  if (present.length < 2) return 0;
  // minimal window containing one position of each given term (greedy scan),
  // ignoring any window that reaches past `horizon` (see below).
  const span = (terms: string[], horizon: number): number => {
    if (terms.length < 2) return 0;
    const lists = terms.map((w) => note.positions.get(w)!);
    const idxs = lists.map(() => 0);
    let best = Infinity;
    // Bound the merge-scan by the ACTUAL number of positions (each step advances one
    // lane by one), not a fixed 4000 — a term that occurs thousands of times would
    // otherwise cut the scan short and miss the true minimum span.
    const guardMax = lists.reduce((s, l) => s + l.length, 0) + 1;
    for (let guard = 0; guard < guardMax; guard++) {
      const vals = lists.map((l, i) => l[idxs[i]]);
      const lo = Math.min(...vals),
        hi = Math.max(...vals);
      // We always advance the LOWEST lane, so `hi` never decreases: once a
      // window reaches past the horizon, every later one does too.
      if (hi > horizon) break;
      if (hi - lo < best) best = hi - lo;
      const loLane = vals.indexOf(lo);
      if (idxs[loLane] + 1 >= lists[loLane].length) break;
      idxs[loLane]++;
    }
    if (!isFinite(best)) return 0;
    // inverse span, scaled by how many terms co-occur
    return (terms.length / uniq.length) * (1 / (1 + best / terms.length));
  };
  // A saturated term's stored positions stop at POS_CAP, so past its last stored
  // entry we do not know where that term occurs — and a span measured across
  // that gap is invented, not measured. It used to be reported as fact: a
  // 25k-token Devlog holding "callosium" 201× and the phrase "callosium
  // reranker" at token 25,000 scored 0.000153 (span 13,060 against the stale
  // 200-entry prefix) where the truth is 0.666667 (span 1) — the proximity lane
  // failing on precisely the long notes it exists to rescue. POS_CAP=2000 makes
  // that rare; this makes what's left honest. We score only windows inside the
  // region where every present term's occurrences are fully known, and if there
  // are none we retry over the terms whose lists are COMPLETE — an exact answer
  // over less evidence beats a confident answer over none.
  let horizon = Infinity;
  for (const w of present) {
    if (!note.saturated.has(w)) continue;
    const l = note.positions.get(w)!;
    horizon = Math.min(horizon, l[l.length - 1]);
  }
  return span(present, horizon) || span(present.filter((w) => !note.saturated.has(w)), Infinity);
}

// ─── graph lane: backlink prior + 1-hop reinforcement from seeds ───────

export function graphLane(index: RankIndex, seeds: string[], limit = 50): string[] {
  // activation: seeds inject rank-decayed energy; neighbors receive it with
  // damping (constrained spreading activation ≈ truncated personalized PageRank)
  const energy = new Map<string, number>();
  seeds.forEach((s, i) => energy.set(s, (energy.get(s) || 0) + 1 / (i + 1)));
  const DAMP = 0.85;
  // two bounded hops (constrained activation): beyond 2 the signal is noise
  let frontier = new Map(energy);
  for (let hop = 0; hop < 2; hop++) {
    const next = new Map<string, number>();
    for (const [s, e] of frontier) {
      const nb = index.neighbors.get(s);
      if (!nb || nb.size > 200) continue; // hub fan-out guard
      const share = (e * DAMP) / Math.max(nb.size, 1);
      for (const t of nb) next.set(t, (next.get(t) || 0) + share);
    }
    for (const [t, e] of next) energy.set(t, (energy.get(t) || 0) + e);
    frontier = next;
  }
  // backlink log-prior as tie-shaper (capped, never dominant)
  for (const [p, e] of energy) {
    energy.set(p, e * (1 + 0.2 * Math.log(1 + (index.backlinks.get(p) || 0))));
  }
  return [...energy.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([p]) => p);
}

// ─── tsMatch lane: packed lexicographic score (Typesense match_score.h,
// adapted as a LANE beside BM25F, not a replacement for RRF fusion).
// Precedence: distinct words matched >> typo cost >> proximity >> exact-title
// >> earliness. One integer per note, ≤40 bits — JS-Number safe.

export function tsMatchScore(
  note: NoteFields,
  words: string[],
  typoCost: number,
): number {
  // Dedupe (mirroring detectKnownItem): a repeated query word ("budget budget
  // update") must not increment `unique` twice for the same matched term, which
  // would rank a 1-distinct-term match above a genuine 2-distinct-term one and
  // spuriously trip the exact-title flag.
  const singles = [...new Set(words.filter((w) => !w.includes(' ')))];
  if (!singles.length) return 0;
  let unique = 0;
  let firstPos = Infinity;
  for (const w of singles) {
    const inTitle = note.titleSet.has(w);
    const positions = note.positions.get(w);
    if (inTitle || positions?.length) {
      unique++;
      // take the MIN of both signals — a title hit is position 0 and must not
      // be lost just because the same term also appears later in the body
      // (which would rank a title+body match BELOW a title-only one).
      if (inTitle) firstPos = Math.min(firstPos, 0);
      if (positions?.length) firstPos = Math.min(firstPos, positions[0]);
    }
  }
  if (!unique) return 0;
  const prox = proximityScore(note, singles); // 0..1
  const exact = singles.length >= 2 && singles.every((w) => note.titleSet.has(w)) ? 1 : 0;
  const earliness = isFinite(firstPos) ? Math.max(0, 255 - Math.min(255, Math.floor(firstPos / 8))) : 0;
  return (
    unique * 2 ** 32 +
    Math.max(0, 255 - Math.min(typoCost * 64, 255)) * 2 ** 24 +
    Math.floor(prox * 255) * 2 ** 16 +
    exact * 2 ** 8 +
    earliness
  );
}

// ─── RRF fusion ────────────────────────────────────────────────────────

const RRF_K = 60;

export function rrfFuse(lanes: { ranking: string[]; weight: number }[], limit = 20): { path: string; rrf: number }[] {
  const scores = new Map<string, number>();
  for (const { ranking, weight } of lanes) {
    for (let i = 0; i < ranking.length; i++) {
      scores.set(ranking[i], (scores.get(ranking[i]) || 0) + weight / (RRF_K + i + 1));
    }
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([path, rrf]) => ({ path, rrf }));
}

// ─── known-item detection (Broder navigational class, deterministically) ──

export interface KnownItem {
  isKnownItem: boolean;
  /** exact title/alias matches, best first (dated siblings: exact date wins) */
  exactMatches: string[];
  /** how much of the best match's title the query covers (0..1) */
  bestCover: number;
  /** idf-WEIGHTED title cover of the best match (0..1): covering the
   *  distinctive words of a title counts, missing its date/filler barely does.
   *  "c18b5c identification" covers only 2/7 tokens of "Claude Color C18B5C
   *  identification 7 Apr 2026" (bestCover 0.29) but nearly all of its idf mass
   *  — the user IS naming this note, and the token-count cover hid that. */
  bestCoverIdf: number;
  /** how many distinct notes' titles contain ALL the query's content words */
  matchCount: number;
}

const NO_KI: KnownItem = { isKnownItem: false, exactMatches: [], bestCover: 0, bestCoverIdf: 0, matchCount: 0 };

export function detectKnownItem(index: RankIndex, words: string[]): KnownItem {
  // dedupe first — a repeated query word ("plan ... plan") must not count the
  // same title token twice, which would push cover above its documented 0..1.
  const singles = [...new Set(words.filter((w) => !w.includes(' ')))];
  if (singles.length < 2) return NO_KI;
  const content = singles.filter((w) => !isDateish(w));
  const dates = singles.filter((w) => isDateish(w));
  const qSet = new Set(singles);
  // Combo tokens ("9 apr"): a single-digit day exists ONLY inside a combo
  // (bare "9" is dropped by tokenize's length filter), so without matching
  // combos, dated siblings ("… 7 Apr …" vs "… 9 Apr …") tie on dateHits and
  // the WRONG one can take the rank-1 pin while queryHasDate suppresses the
  // clarify (verified end-to-end by the review). Combo matches count as
  // date evidence.
  const qCombos = new Set(words.filter((w) => w.includes(' ')));

  const exact: { path: string; cover: number; coverIdf: number; dateHits: number; extra: number }[] = [];
  for (const note of index.notes) {
    // System/ holds machine state incl. quarantined duplicates whose titles
    // mirror real notes — a known-item pin must never resolve to one.
    if (note.path.startsWith('System/')) continue;
    const contentHits = content.filter((w) => note.titleSet.has(w)).length;
    if (content.length && contentHits < content.length) continue;
    // Date-only queries ("16th of july" → [16, july] once the asking frame is
    // stripped) ARE navigational — the user is naming a note by its date. With
    // no content words the old guard disabled known-item entirely and the
    // body lanes ranked the WRONG dates' session logs. Require ≥2 date tokens
    // (a bare "july" must not pin) and ALL of them in the title.
    if (!content.length) {
      if (dates.length < 2 || dates.some((w) => !note.titleSet.has(w))) continue;
    }
    let dateHits = dates.filter((w) => note.titleSet.has(w)).length;
    if (qCombos.size) for (const t of note.title) if (t.includes(' ') && qCombos.has(t)) dateHits++;
    // how much of the TITLE the query covers (fewer leftover words = better)
    const cover = (contentHits + dateHits) / Math.max(note.titleLen, 1);
    // idf-weighted cover: matched title tokens' idf mass / whole title's idf
    // mass. Long dated titles carry lots of low-idf filler (dates, months,
    // "claude") that the token-count cover unfairly charges the query for.
    let matchedMass = 0;
    let totalMass = 0;
    for (const t of note.title) {
      // combo tokens ("26 jun") can never appear in qSet (built from singles) —
      // counting them as unmatchable denominator mass unfairly depresses every
      // dated title's idf-cover.
      if (t.includes(' ')) continue;
      const m = idf(index, t);
      totalMass += m;
      if (qSet.has(t)) matchedMass += m;
    }
    const coverIdf = totalMass > 0 ? matchedMass / totalMass : 0;
    exact.push({ path: note.path, cover, coverIdf, dateHits, extra: note.titleLen - contentHits - dateHits });
  }
  if (!exact.length) return NO_KI;
  exact.sort(
    (a, b) =>
      b.dateHits - a.dateHits || b.coverIdf - a.coverIdf || b.cover - a.cover || a.extra - b.extra || a.path.localeCompare(b.path),
  );
  // known-item: the query's content words are fully covered by some title
  return {
    isKnownItem: true,
    exactMatches: exact.slice(0, 5).map((x) => x.path),
    bestCover: exact[0].cover,
    bestCoverIdf: exact[0].coverIdf,
    matchCount: exact.length,
  };
}
