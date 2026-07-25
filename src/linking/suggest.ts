// Deterministic link suggestion — wikification for the brain (research pass,
// 11 Jul 2026: Milne & Witten CIKM'08, Mihalcea & Csomai's Wikify!, and the
// guardrails every real PKM auto-linker converged on).
//
// Pipeline:
//   1. Gazetteer scan: every note title + alias, matched word-boundary-safe
//      in one pass per note (first-token trie — Aho-Corasick at word
//      granularity, dependency-free), longest match wins.
//   2. Keyphraseness from the vault's OWN links: linkProb(phrase) =
//      notes where phrase appears linked / notes where it appears at all.
//      History suppresses common-word junk and ranks suggestions.
//   3. Commonness disambiguation: when a phrase could target several notes,
//      prefer the target this vault's history links it to most.
//
// Zero ML, zero API calls; the vault's own linking habits are the training
// signal.

export interface LinkCandidate {
  /** Exact text span as it appears in the note. */
  phrase: string;
  /** Char offset of the first unlinked mention. */
  offset: number;
  /** Canonical target note path. */
  target: string;
  /** Historical link probability of this phrase (0..1; 0 = never linked before). */
  keyphraseness: number;
  /** Commonness of this target for this phrase (1 = unambiguous). */
  commonness: number;
}

interface Pattern {
  /** lowercased tokens of the name/alias */
  tokens: string[];
  raw: string;
  target: string;
}

export interface LinkerIndex {
  byFirstToken: Map<string, Pattern[]>;
  /** phrase(lower) -> { mentions, linked } across the corpus */
  phraseStats: Map<string, { mentions: number; linked: number }>;
  /** phrase(lower) -> target -> count of historical links */
  commonness: Map<string, Map<string, number>>;
}

// Unicode-aware "is a word char" — matches any letter/number in any script, so
// boundary checks and the prose scan don't mis-handle accented Latin, Cyrillic,
// CJK, etc. (the same class the recall tokenizer now uses).
const WORD_RE = /[\p{L}\p{N}]/u;
// Plain surface tokenizer for gazetteer names — unlike the recall tokenizer it
// does NOT drop interior stopwords, so a title like "State of the Union" keeps
// all four tokens and stays contiguous with the prose token stream (which also
// keeps "of"/"the"); the query tokenizer would collapse it to ["state","union"]
// and never match.
const surfaceTokens = (s: string): string[] => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

function boundaryOk(text: string, start: number, end: number): boolean {
  const before = start > 0 ? text[start - 1] : ' ';
  const after = end < text.length ? text[end] : ' ';
  // A name touching a letter/number, or a compound/path connector (- _ / \), is a
  // FRAGMENT of a bigger identifier — "acme-decrypt", "Folder/Note", "foo_bar" —
  // and wikifying the fragment mangles it. A following ".<letter>" is a file
  // extension or domain ("Note.md", "openai.com"), also not a reference (a plain
  // "Acme." ending a sentence still links, since the next char isn't a letter).
  const glue = (c: string) => WORD_RE.test(c) || c === '-' || c === '_' || c === '/' || c === '\\';
  if (glue(before) || glue(after)) return false;
  if (after === '.' && end + 1 < text.length && /[A-Za-z]/.test(text[end + 1])) return false;
  return true;
}

/** Spans already inside [[...]], `code`, or fenced blocks — never re-link. */
function protectedSpans(text: string): [number, number][] {
  const spans: [number, number][] = [];
  // Protected from linking: existing [[wikilinks]]; fenced ``` blocks; inline code
  // (which may WRAP across a line — a long `path/to/file.md` that soft-wraps ends
  // at the closing backtick or a blank line, not the first newline); bare URLs;
  // and markdown link/image targets `](…)` — so a word inside a URL like
  // ".../models-overview" is never wikified into a broken link.
  // inline-code body is bounded ({0,4000}) so a note full of unclosed backticks
  // can't drive quadratic backtracking; no real inline span is anywhere near that.
  const PAT = /\[\[[^\]]*\]\]|```[\s\S]*?```|`(?:[^`\n]|\n(?!\n)){0,4000}`|\]\([^)]*\)|https?:\/\/[^\s)]+|www\.[^\s)]+/g;
  for (const m of text.matchAll(PAT)) {
    spans.push([m.index!, m.index! + m[0].length]);
  }
  return spans;
}

const inSpan = (spans: [number, number][], pos: number) => spans.some(([a, b]) => pos >= a && pos < b);

export function buildLinkerIndex(
  notes: { path: string; text: string; aliases: string[] }[],
): LinkerIndex {
  const byFirstToken = new Map<string, Pattern[]>();
  const nameOf = (p: string) => p.split('/').pop()!.replace(/\.md$/, '');

  // Notes that must never be link TARGETS: scaffolding, raw exports, and
  // generic structural files. Linking "client" to a template is graph poison.
  const badTarget = (p: string) => {
    const base = p.split('/').pop()!;
    return (
      /^(Templates|System|Inbox)\//.test(p) ||
      /\/Raw\//i.test(p) ||
      /^_|^(SOURCES|GUIDE|SKILL|README|INDEX)\.md$/i.test(base) ||
      p.includes('.excalidraw')
    );
  };

  for (const n of notes) {
    if (badTarget(n.path)) continue;
    // A note whose BASENAME carries wikilink metacharacters ([ ] | #) can never be a
    // link target: applyLinks writes `[[${nameOf(target)}|${phrase}]]`, so the basename
    // is what lands in the note. This has to be checked on the TARGET, not on the name
    // being matched — the per-`raw` check below only coincided with the basename on the
    // first iteration, so any ALIAS of a note called "Notes [archive].md" sailed through
    // and wrote the broken "[[Notes [archive]|Archive]]" into the user's file.
    if (/[[\]|#]/.test(nameOf(n.path))) continue;
    for (const raw of [nameOf(n.path), ...n.aliases]) {
      // Belt and braces: an alias with metacharacters is never a sane surface either.
      if (/[[\]|#]/.test(raw)) continue;
      const toks = surfaceTokens(raw);
      if (!toks.length) continue;
      // guardrails: single-token names must be ≥4 chars and not purely numeric
      if (toks.length === 1 && (toks[0].length < 4 || /^\d+$/.test(toks[0]))) continue;
      const pat: Pattern = { tokens: toks, raw, target: n.path };
      if (!byFirstToken.has(toks[0])) byFirstToken.set(toks[0], []);
      byFirstToken.get(toks[0])!.push(pat);
    }
  }
  // longest patterns first per bucket → longest-match-wins for free
  for (const arr of byFirstToken.values()) arr.sort((a, b) => b.tokens.length - a.tokens.length);

  // keyphraseness + commonness from the corpus's own links
  const phraseStats = new Map<string, { mentions: number; linked: number }>();
  const commonness = new Map<string, Map<string, number>>();
  const nameToPath = new Map<string, string>();
  for (const n of notes) {
    nameToPath.set(nameOf(n.path).toLowerCase(), n.path);
    for (const a of n.aliases) if (!nameToPath.has(a.toLowerCase())) nameToPath.set(a.toLowerCase(), n.path);
  }
  for (const n of notes) {
    // linked usages: [[Target]] and [[Target|shown]]
    for (const m of n.text.matchAll(/\[\[([^\]|#]+)(?:\|([^\]]+))?\]\]/g)) {
      const shown = (m[2] ?? m[1]).trim().toLowerCase();
      const target = nameToPath.get(m[1].trim().toLowerCase());
      if (!shown || !target) continue;
      const s = phraseStats.get(shown) ?? { mentions: 0, linked: 0 };
      s.linked++;
      s.mentions++;
      phraseStats.set(shown, s);
      if (!commonness.has(shown)) commonness.set(shown, new Map());
      const c = commonness.get(shown)!;
      c.set(target, (c.get(target) || 0) + 1);
    }
  }
  // unlinked mentions: count occurrences of every known phrase (plain scan)
  for (const n of notes) {
    const lower = n.text.toLowerCase();
    // Spans already inside [[...]] in THIS note — occurrences within them are the
    // linked mentions (already counted above); only the ones OUTSIDE count as
    // unlinked. Subtracting the corpus-wide s.linked here (the old code) was wrong:
    // it mixed this note's occurrence count with every note's link count.
    const linkSpans: [number, number][] = [];
    for (const m of n.text.matchAll(/\[\[[^\]]*\]\]/g)) linkSpans.push([m.index!, m.index! + m[0].length]);
    // Only test phrases whose FIRST word actually occurs in this note — skips an
    // indexOf scan of every historical phrase against every note (the O(notes ×
    // phrases) shape) for the common case where the phrase isn't present at all.
    const present = new Set(lower.match(/[\p{L}\p{N}]+/gu) ?? []);
    for (const [phrase, s] of phraseStats) {
      if (phrase.length < 4) continue;
      const firstWord = phrase.match(/[\p{L}\p{N}]+/u)?.[0];
      if (!firstWord || !present.has(firstWord)) continue;
      let pos = -1,
        c = 0;
      while (c < 20 && (pos = lower.indexOf(phrase, pos + 1)) !== -1) {
        if (boundaryOk(lower, pos, pos + phrase.length) && !inSpan(linkSpans, pos)) c++;
      }
      s.mentions += c; // c already excludes linked occurrences (they're inside linkSpans)
    }
  }
  return { byFirstToken, phraseStats, commonness };
}

/** Milne & Witten's detection threshold. Phrases with NO link history pass
 *  only when they're a real entity name (the gazetteer guarantees that). */
const KEYPHRASENESS_FLOOR = 0.065;

export function suggestLinks(
  index: LinkerIndex,
  selfPath: string,
  text: string,
  maxSuggestions = 20,
): LinkCandidate[] {
  const spans = protectedSpans(text);
  const out: LinkCandidate[] = [];
  const suggestedTargets = new Set<string>();
  // Char spans of already-accepted candidates. applyLinks() assumes accepted
  // spans never overlap (it rewrites them independently in reverse-offset
  // order); a nested/overlapping second candidate would corrupt the markdown.
  const acceptedSpans: [number, number][] = [];
  const overlaps = (a: number, b: number) => acceptedSpans.some(([x, y]) => a < y && b > x);

  // tokenize with char offsets (word-granularity scan; same Unicode class the
  // gazetteer patterns are built with, so multi-word names stay contiguous)
  const tokenRe = /[\p{L}\p{N}]+/gu;
  const toks: { t: string; start: number; len: number }[] = [];
  let m: RegExpExecArray | null;
  // Tokenize the ORIGINAL text and lowercase each token for gazetteer matching. Tokenizing a
  // globally-lowercased copy drifts offsets whenever a char changes LENGTH under toLowerCase()
  // (İ→i̇, ẞ→ss): start/end from the lowercased string would then slice the WRONG bytes of the real
  // text and applyLinks would corrupt the note. Original-text offsets stay valid.
  // len = the ORIGINAL token length. The end offset MUST use this, not t.length: t is lowercased,
  // and a char that GROWS under toLowerCase (İ→i̇, ẞ→ss) would make t longer than the real token, so
  // start+t.length overshoots and the phrase captures a trailing char — the exact drift we fixed for
  // start; the applyLinks assert can't catch it because both sides size the span from phrase.length.
  while ((m = tokenRe.exec(text))) toks.push({ t: m[0].toLowerCase(), start: m.index, len: m[0].length });

  for (let i = 0; i < toks.length && out.length < maxSuggestions; i++) {
    const bucket = index.byFirstToken.get(toks[i].t);
    if (!bucket) continue;
    for (const pat of bucket) {
      if (pat.target === selfPath) continue;
      if (i + pat.tokens.length > toks.length) continue;
      let ok = true;
      for (let j = 1; j < pat.tokens.length; j++) {
        if (toks[i + j].t !== pat.tokens[j]) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      const start = toks[i].start;
      const endTok = toks[i + pat.tokens.length - 1];
      const end = endTok.start + endTok.len;
      if (!boundaryOk(text, start, end) || inSpan(spans, start)) continue;
      // Never accept a span that overlaps one already accepted (e.g. a "York"
      // note nested inside a just-matched "New York City") — that is the case
      // applyLinks can't apply safely.
      if (overlaps(start, end)) continue;
      if (suggestedTargets.has(pat.target)) break;

      const phrase = text.slice(start, end);
      // A real name never spans a line break or carries markdown structure. When
      // the tokenizer matched two name-tokens that are only ADJACENT after markup
      // is stripped (e.g. "Acme" + "**: " + "workflows", or a title broken across
      // a wrapped line), the reconstructed span carries that junk — wrapping it in
      // [[ ]] would write a BROKEN link into the note. Reject it. `continue`, not
      // `break`: a shorter clean pattern at this same token may still be valid.
      if (/[\r\n`*|[\]]/.test(phrase)) continue;
      const stats = index.phraseStats.get(phrase.toLowerCase());
      const keyphraseness = stats && stats.mentions > 0 ? stats.linked / stats.mentions : 0;
      // Proper-noun rule (Virtual Linker heuristic): a single-token match with
      // NO linking history must be capitalized in the text to qualify —
      // lowercase "client"/"home" prose words never auto-link.
      if (pat.tokens.length === 1 && keyphraseness === 0 && !/^[A-Z؀-ۿ]/.test(phrase)) continue;
      // suppression: phrases with real history below the floor are the
      // common-word junk Milne & Witten's threshold exists for. `continue`, not
      // `break` — a shorter alternate pattern anchored at this same token (e.g.
      // "Washington" under a junk "Washington State University") may still be a
      // valid, well-keyphrased link.
      if (stats && stats.mentions >= 5 && keyphraseness < KEYPHRASENESS_FLOOR) continue;

      const cm = index.commonness.get(phrase.toLowerCase());
      let target = pat.target;
      let commonnessScore = 1;
      if (cm && cm.size) {
        const total = [...cm.values()].reduce((a, b) => a + b, 0);
        const best = [...cm.entries()].sort((a, b) => b[1] - a[1])[0];
        if (best[1] / total >= 0.5) {
          target = best[0];
          commonnessScore = best[1] / total;
        }
      }
      // re-check self-target AFTER disambiguation — commonness could have
      // re-pointed the phrase back at this very note (same-basename collisions),
      // which would write a [[self-link]] into the note.
      if (target === selfPath) continue;
      // dedup on the POST-disambiguation target: the earlier break tests pat.target,
      // but commonness may have re-pointed this phrase to an already-suggested note,
      // so re-check here (continue, not break — a shorter pattern may still qualify).
      if (suggestedTargets.has(target)) continue;
      out.push({ phrase, offset: start, target, keyphraseness, commonness: commonnessScore });
      suggestedTargets.add(target);
      acceptedSpans.push([start, end]);
      i += pat.tokens.length - 1; // advance past the whole matched span (the
      break; // outer i++ then lands on the first token AFTER the match)
    }
  }
  return out;
}

/** Apply suggestions: wikify the FIRST unlinked mention of each accepted
 *  phrase, in reverse offset order so offsets stay valid. */
export function applyLinks(text: string, accepted: LinkCandidate[]): string {
  const nameOf = (p: string) => p.split('/').pop()!.replace(/\.md$/, '');
  let result = text;
  for (const c of [...accepted].sort((a, b) => b.offset - a.offset)) {
    const canonical = nameOf(c.target);
    // Belt-and-suspenders against offset drift: only splice if the bytes at [offset, offset+len) are
    // EXACTLY the phrase we intend to wikify. If they aren't (a stale/miscomputed offset, or overlap),
    // skip this one — a missed link is fine; a wrong-offset splice corrupts the note. Reverse-offset
    // order keeps every not-yet-processed span's bytes untouched, so this check is meaningful.
    if (result.slice(c.offset, c.offset + c.phrase.length) !== c.phrase) continue;
    // EXACT match → bare [[Name]]; any difference (including case, "acme" vs
    // "Acme") → piped [[Name|surface]] so the note's original text is preserved
    // byte-for-byte and the wikify is purely additive.
    const replacement = canonical === c.phrase ? `[[${canonical}]]` : `[[${canonical}|${c.phrase}]]`;
    result = result.slice(0, c.offset) + replacement + result.slice(c.offset + c.phrase.length);
  }
  return result;
}
