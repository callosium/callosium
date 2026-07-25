// Typo/voice-tolerance layer — deterministic (research: Meilisearch length
// budgets, trigram candidate filtering, Damerau-Levenshtein).
//
// Two very different problems, two mechanisms:
//   1. NON-WORD typos ("calosium"): query term absent from the corpus →
//      trigram-filtered DL correction against the vocabulary, budgets
//      0 typos <5 chars / 1 at ≥5 / 2 at ≥9, plus prefix expansion for
//      voice-truncations ("micro" → "microsoft").
//   2. REAL-WORD voice-mangles ("micro"→Microsoft, "goog"→Google): the term EXISTS
//      in the corpus, so absent-term triggers never fire. Only safe against a
//      small vocabulary: ENTITY names. fuzzyEntity() matches query terms
//      against titles/aliases with the same budgets + prefix rule and is used
//      by resolve/glossary and as a low-weight recall lane — never a silent
//      substitution.

import { MONTHS_SET } from './tokens.ts';

export function damerauLevenshtein(a: string, b: string, cap = 3): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  const m = a.length,
    n = b.length;
  const d: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) d[i][0] = i;
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    let rowMin = Infinity;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1); // transposition
      }
      rowMin = Math.min(rowMin, d[i][j]);
    }
    if (rowMin > cap) return cap + 1; // early exit
  }
  return d[m][n];
}

/** Meilisearch budgets: 0 typos under 5 chars, 1 at ≥5, 2 at ≥9. */
export const typoBudget = (len: number) => (len < 5 ? 0 : len < 9 ? 1 : 2);

const trigrams = (w: string): Set<string> => {
  const t = new Set<string>();
  const padded = `  ${w} `;
  for (let i = 0; i < padded.length - 2; i++) t.add(padded.slice(i, i + 3));
  return t;
};

export interface FuzzyIndex {
  /** trigram -> vocabulary terms containing it */
  byTrigram: Map<string, string[]>;
  /** SymSpell-style: delete-variant -> original vocab terms. Generated for
   *  vocab terms (deletes within distance 1); query terms generate their own
   *  deletes at lookup — meet-in-the-middle covers distance <=2 cheaply. */
  byDelete: Map<string, string[]>;
  df: Map<string, number>;
  n: number;
}

export function deletes1(w: string): string[] {
  const out = [w];
  for (let i = 0; i < w.length; i++) out.push(w.slice(0, i) + w.slice(i + 1));
  return out;
}

export function buildFuzzyIndex(df: Map<string, number>, n: number): FuzzyIndex {
  const byTrigram = new Map<string, string[]>();
  const byDelete = new Map<string, string[]>();
  for (const term of df.keys()) {
    if (term.length < 4 || term.includes(' ')) continue;
    for (const g of trigrams(term)) {
      if (!byTrigram.has(g)) byTrigram.set(g, []);
      byTrigram.get(g)!.push(term);
    }
    if (term.length <= 24) {
      for (const d of deletes1(term)) {
        if (!byDelete.has(d)) byDelete.set(d, []);
        const arr = byDelete.get(d)!;
        if (arr.length < 50) arr.push(term);
      }
    }
  }
  return { byTrigram, byDelete, df, n };
}

/** Correct one ABSENT query term against the whole vocabulary, or null. */
export function correctTerm(fz: FuzzyIndex, term: string): { corrected: string; edits: number } | null {
  // Length guard (mirrors the vocab-side `<= 24` cap in buildFuzzyIndex): a very
  // long query token — e.g. a 50k-char alnum run pasted/injected into the
  // question — would make deletes1() allocate ~L² chars and OOM-crash the single
  // process (taking the dashboard + MCP server with it). No vocab term exceeds 24
  // chars, so anything past 25 can't be within edit distance of a candidate.
  if (term.length > 25) return null;
  const budget = typoBudget(term.length);
  const counts = new Map<string, number>();
  // SymSpell meet-in-the-middle: query deletes ∩ vocab deletes = all
  // candidates within edit distance ~2, regardless of which chars mangled.
  // Far higher recall than trigram overlap for short words.
  for (const d of deletes1(term)) {
    for (const cand of fz.byDelete.get(d) ?? []) counts.set(cand, Math.max(counts.get(cand) ?? 0, 2));
  }
  for (const g of trigrams(term)) {
    for (const cand of fz.byTrigram.get(g) ?? []) counts.set(cand, (counts.get(cand) || 0) + 1);
  }
  let best: { corrected: string; edits: number; overlap: number; df: number } | null = null;
  const shortCands: string[] = [];
  for (const [cand, overlap] of counts) {
    if (overlap < 2) continue;
    const df = fz.df.get(cand) ?? 0;
    // prefix expansion (voice truncation) — free when the term is a prefix,
    // but bounded to a few extra chars (like fuzzyEntity): "docu" should reach
    // "docs"/"document", NOT "documentation" at a fabricated edit-distance of 1.
    const isPrefix = term.length >= 4 && cand.startsWith(term) && cand.length <= term.length + 4;
    const edits = isPrefix ? 1 : damerauLevenshtein(term, cand, budget || 1);
    // short-word exception (judge-audit finding): a 4-char ABSENT term may
    // take 1 edit — uniqueness is enforced after the loop
    // guard: 2-edit corrections toward ubiquitous words are drift, not typos;
    // 1-edit corrections of an ABSENT term are near-certain typos even when
    // the target is common ("preparign"->"preparing").
    // absolute floor of 5 so a small personal vault (n≈few dozen) doesn't
    // blackhole legitimate 2-edit targets — 5% of 20 notes is 1, which would
    // exclude almost any word appearing twice.
    if (edits >= 2 && df > Math.max(fz.n * 0.05, 5)) continue;
    const allowed = isPrefix || (budget > 0 && edits <= budget) || (term.length === 4 && edits === 1 && df >= 2);
    if (!allowed) continue;
    if (term.length === 4 && edits === 1 && budget === 0) {
      shortCands.push(cand);
      if (shortCands.length > 1) return null; // ambiguous — refuse, stay honest
    }
    // tie-break by CORPUS FREQUENCY first (SymSpell's rule): overlap is a
    // candidate-generation artifact — "gaols" was correcting to df-1 "gaos"
    // (overlap 3) instead of "goals" (overlap 2) under overlap-first ordering.
    if (
      !best ||
      edits < best.edits ||
      (edits === best.edits && df > best.df) ||
      (edits === best.edits && df === best.df && overlap > best.overlap)
    ) {
      best = { corrected: cand, edits, overlap, df };
    }
  }
  return best ? { corrected: best.corrected, edits: best.edits } : null;
}

/** Fuzzy entity matching over a SMALL vocabulary (titles + aliases): safe for
 *  real-word voice-mangles because entity names are distinctive. Uses relaxed
 *  budgets (voice errors are bigger than typing errors) + prefix rule. */
/** Consonant skeleton for phonetic matching: first letter + the remaining
 *  consonants, doubles collapsed. Voice transcription preserves the consonant
 *  frame of a name while mangling its vowels — "mindset"→mndst vs
 *  "googel"→ggl vs "google"→ggl (1 apart), "amazn"→amzn (1 apart). */
function skeleton(w: string): string {
  const first = w[0];
  const rest = w.slice(1).replace(/[aeiou]/g, '');
  return (first + rest).replace(/(.)\1+/g, '$1');
}

export function fuzzyEntity(
  names: { name: string; path: string }[],
  term: string,
): { path: string; name: string; edits: number; kind: 'prefix' | 'dl' | 'phonetic' }[] {
  if (term.length < 3) return [];
  const out: { path: string; name: string; edits: number; kind: 'prefix' | 'dl' | 'phonetic' }[] = [];
  const termSkel = term.length >= 4 ? skeleton(term) : '';
  for (const { name, path } of names) {
    const lower = name.toLowerCase();
    // prefix rule (voice truncation): "micro" → "microsoft". Safe even for common
    // words because entity names are distinctive.
    if (lower.startsWith(term) && term.length >= 3 && lower.length <= term.length + 4 && lower !== term) {
      out.push({ path, name, edits: 1, kind: 'prefix' });
      continue;
    }
    const budget = Math.max(1, typoBudget(Math.max(term.length, lower.length)));
    const edits = damerauLevenshtein(term, lower, budget);
    if (edits <= budget && lower !== term) {
      out.push({ path, name, edits, kind: 'dl' });
      continue;
    }
    // phonetic fallback (voice mangles beyond edit budgets): "projekt"→Project is
    // 3 raw edits but the consonant skeletons are 1 apart. Gated hard — single
    // WORD names ≥4 chars, same first letter, BOTH skeletons ≥4 chars (short
    // skeletons like "hmn"/"hms" make half the dictionary 1 apart), skeleton
    // DL ≤ 1 — and ranked below prefix/dl hits (edits 2) so a direct match
    // always wins.
    if (termSkel && termSkel.length >= 4 && lower.length >= 4 && !lower.includes(' ') && lower[0] === term[0]) {
      const nameSkel = skeleton(lower);
      if (nameSkel.length >= 4 && damerauLevenshtein(termSkel, nameSkel, 1) <= 1) out.push({ path, name, edits: 2, kind: 'phonetic' });
    }
  }
  return out.sort((a, b) => a.edits - b.edits).slice(0, 5);
}


/** Morphological variants (light stemming, query-side): when a query term is
 *  rare/absent, its plural/verb-form sibling often carries the content.
 *  Deterministic suffix rules; the highest-df variant wins. */
export function morphVariant(df: Map<string, number>, term: string): string | null {
  if (term.length < 4) return null;
  const cands: string[] = [];
  if (term.endsWith('ies')) cands.push(term.slice(0, -3) + 'y');
  if (term.endsWith('es')) cands.push(term.slice(0, -2));
  if (term.endsWith('s')) cands.push(term.slice(0, -1));
  if (term.endsWith('ing')) cands.push(term.slice(0, -3), term.slice(0, -3) + 'e');
  if (term.endsWith('ed')) cands.push(term.slice(0, -2), term.slice(0, -1));
  if (term.endsWith('y')) cands.push(term.slice(0, -1) + 'ies');
  if (!term.endsWith('s')) cands.push(term + 's', term + 'es');
  // Arabic light rules: definite-article/conjunction prefixes, plural suffixes
  if (/^[؀-ۿ]/.test(term)) {
    if (term.startsWith('ال') && term.length > 5) cands.push(term.slice(2));
    else if (!term.startsWith('ال')) cands.push('ال' + term); // don't double-prefix "البيت"→"الالبيت"
    // و is the conjunction proclitic BUT also a root-initial radical (وزارة,
    // وقت, وثيقة...). Only strip it for a rare/absent term, so a common
    // root-initial-و word isn't mangled into an unrelated higher-df word.
    if (term.startsWith('و') && term.length > 4 && (df.get(term) ?? 0) < 2) cands.push(term.slice(1));
    if (term.endsWith('ات')) cands.push(term.slice(0, -2), term.slice(0, -2) + 'ة');
    if (term.endsWith('ين') || term.endsWith('ون')) cands.push(term.slice(0, -2));
    if (term.endsWith('ة')) cands.push(term.slice(0, -1), term.slice(0, -1) + 'ات');
  }
  // Gate against the ORIGINAL term's df (a fixed floor), not an escalating
  // bestDf — otherwise the first accepted candidate raises the bar and a later,
  // genuinely higher-df sibling can be rejected for not clearing 2× the winner.
  // Among candidates that clear the floor, the true maximum-df one wins (the
  // documented "highest-df variant wins" contract).
  const floor = df.get(term) ?? 0;
  let best: string | null = null;
  let bestDf = floor;
  for (const c of cands) {
    // Never rewrite into a date token: month abbreviations have artificially
    // inflated df in dated vaults (every "14 Jul 2026" title), so "mars"→"mar"
    // would hijack the whole query — including the semantic lane, which embeds
    // the rewritten question.
    if (MONTHS_SET.has(c)) continue;
    const d = df.get(c) ?? 0;
    if (d > floor * 2 && d >= 2 && d > bestDf) {
      best = c;
      bestDf = d;
    }
  }
  return best;
}
