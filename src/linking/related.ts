// Note-to-note relatedness — deterministic, embedding-free (research pass,
// 11 Jul 2026: co-citation/Adamic-Adar per the Obsidian graph-analysis
// implementation; pruned TF-IDF topical lane per Bayardo WWW'07 / classic
// MoreLikeThis; Schwarzer JCDL'16 evidence says link-based and text-based
// lanes catch DIFFERENT relatives — so both run and RRF fuses them).
//
// This produces content↔content edges ("these notes are about the same
// thing") — the kind entity-mention links can't provide.

import type { RankIndex } from '../recall/rank.ts';
import { rrfFuse } from '../recall/rank.ts';

export interface RelatedEntry {
  path: string;
  related: { path: string; score: number; via: 'links' | 'text' | 'both' }[];
}

export function buildRelatedness(index: RankIndex, topK = 8): Map<string, RelatedEntry['related']> {
  // ── lane 1: link structure (Jaccard + Adamic-Adar on the undirected graph) ──
  const linkScores = new Map<string, Map<string, number>>();
  const deg = (p: string) => index.neighbors.get(p)?.size ?? 0;
  for (const [a, na] of index.neighbors) {
    // candidate partners: 2-hop co-neighbors only (prunes the quadratic blowup)
    const candidates = new Map<string, number>(); // partner -> adamic-adar
    for (const c of na) {
      const nc = index.neighbors.get(c);
      if (!nc || nc.size > 150) continue; // hub guard: Index.md links everything
      const w = 1 / Math.log(Math.max(nc.size, 2));
      for (const b of nc) {
        if (b === a) continue;
        candidates.set(b, (candidates.get(b) || 0) + w);
      }
    }
    const scored = new Map<string, number>();
    for (const [b, aa] of candidates) {
      const nb = index.neighbors.get(b);
      if (!nb) continue;
      let inter = 0;
      const smaller = na.size <= nb.size ? na : nb;
      const larger = na.size <= nb.size ? nb : na;
      for (const x of smaller) if (larger.has(x)) inter++;
      const jaccard = inter / (na.size + nb.size - inter || 1);
      scored.set(b, aa * 0.5 + jaccard * 3); // AA carries volume, Jaccard carries purity
    }
    linkScores.set(a, scored);
  }

  // ── lane 2: topical (weighted overlap of top TF-IDF terms, postings-pruned) ──
  const N = index.n;
  const topTerms = new Map<string, Map<string, number>>(); // path -> term -> weight
  const postings = new Map<string, string[]>(); // term -> paths
  for (const note of index.notes) {
    const scored: [string, number][] = [];
    for (const [t, tf] of note.bodyTf) {
      if (t.includes(' ') || t.length < 3) continue;
      const df = index.df.get(t) ?? 1;
      if (df > N * 0.2) continue; // ubiquitous terms carry no topical signal
      scored.push([t, (1 + Math.log(tf)) * Math.log(N / df)]);
    }
    scored.sort((a, b) => b[1] - a[1]);
    const top = new Map(scored.slice(0, 15));
    topTerms.set(note.path, top);
    for (const t of top.keys()) {
      if (!postings.has(t)) postings.set(t, []);
      postings.get(t)!.push(note.path);
    }
  }
  const textScores = new Map<string, Map<string, number>>();
  for (const [a, terms] of topTerms) {
    const partner = new Map<string, number>();
    for (const [t, w] of terms) {
      const list = postings.get(t)!;
      if (list.length > 100) continue; // pruning: shared rare terms only
      for (const b of list) {
        if (b === a) continue;
        partner.set(b, (partner.get(b) || 0) + w * (topTerms.get(b)!.get(t) ?? 0));
      }
    }
    textScores.set(a, partner);
  }

  // ── fuse per note ──
  const out = new Map<string, RelatedEntry['related']>();
  for (const note of index.notes) {
    const a = note.path;
    const lRank = [...(linkScores.get(a) ?? new Map())].sort((x, y) => y[1] - x[1]).slice(0, 25).map(([p]) => p);
    const tRank = [...(textScores.get(a) ?? new Map())].sort((x, y) => y[1] - x[1]).slice(0, 25).map(([p]) => p);
    if (!lRank.length && !tRank.length) continue;
    const fused = rrfFuse(
      [
        { ranking: lRank, weight: 1 },
        { ranking: tRank, weight: 1 },
      ],
      topK,
    );
    const lSet = new Set(lRank),
      tSet = new Set(tRank);
    out.set(
      a,
      fused.map((f) => ({
        path: f.path,
        score: +f.rrf.toFixed(4),
        via: lSet.has(f.path) && tSet.has(f.path) ? 'both' : lSet.has(f.path) ? 'links' : 'text',
      })),
    );
  }
  return out;
}
