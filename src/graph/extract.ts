// Zero-LLM typed knowledge graph. All extraction functions are PURE —
// content in, edge candidates out, no filesystem or index access (the Gbrain
// design lesson worth keeping). Resolution and persistence live in index.ts.
//
// Edge types come from two zero-cost sources:
//   wikilinks in the body           → 'mentions'
//   typed frontmatter keys          → related_to, sourced_from, in_area,
//                                     by_creator, on_platform
// No API calls, no models, no cost. This is the single biggest retrieval
// quality lever the Gbrain dissection demonstrated.

import type { Edge, Note } from '../core/types.ts';

/**
 * Bump when extraction logic changes shape — pages stamped with an older
 * version re-extract on the next build (Gbrain's staleness-watermark pattern).
 */
export const EXTRACTOR_VERSION = '2026-07-14.2'; // + code-span skip, separator-tolerant resolve

/** Frontmatter key → edge type. Values must name other notes. */
const FRONTMATTER_EDGE_KEYS: Record<string, string> = {
  related: 'related_to',
  source: 'sourced_from',
  area: 'in_area',
  creator: 'by_creator',
  platform: 'on_platform',
};

/** Raw candidate before target resolution: `to` is link text, not a path. */
export interface EdgeCandidate {
  toText: string;
  type: string;
  source: Edge['source'];
  /** Soft candidates (frontmatter values) may be labels rather than note
   *  references: kept as edges when they resolve, dropped silently when they
   *  don't. Body wikilinks are strict — unresolved means a broken link. */
  soft?: boolean;
}

export function extractCandidates(note: Note): EdgeCandidate[] {
  const out: EdgeCandidate[] = [];
  const seen = new Set<string>();

  // A wikilink inside `inline code` or a ```fenced block``` is literal text — a
  // documentation syntax example ("link with `[[Note Name]]`"), not a real link,
  // and Obsidian doesn't render it as one either. Skip those so instruction notes
  // (Agent Instructions, Vault Health Check, …) don't spawn phantom broken links.
  const codeSpans: [number, number][] = [];
  for (const m of note.body.matchAll(/```[\s\S]*?```|`(?:[^`\n]|\n(?!\n)){0,4000}`/g)) codeSpans.push([m.index!, m.index! + m[0].length]);
  const inCode = (i: number) => codeSpans.some(([a, b]) => i >= a && i < b);

  // Wikilinks: [[Target]], [[Target|label]], [[Target#heading]].
  // Embeds ![[...]] point at attachments (images/PDFs), not notes — skip them
  // or they'd be reported as broken links for every embedded file.
  for (const m of note.body.matchAll(/(!?)\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)) {
    if (m[1] === '!') continue; // embed, not a note link
    if (inCode(m.index!)) continue; // literal example inside code, not a link
    const target = m[2].trim();
    if (!target) continue;
    const key = `mentions:${target.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ toText: target, type: 'mentions', source: 'wikilink' });
  }

  // Typed frontmatter keys
  for (const [fmKey, edgeType] of Object.entries(FRONTMATTER_EDGE_KEYS)) {
    const v = note.frontmatter[fmKey];
    if (v === undefined || v === null) continue;
    const values = Array.isArray(v) ? v : [v];
    for (const raw of values) {
      // strip [[ ]] AND any |alias / #heading suffix (same as body wikilinks)
      // — otherwise "[[Real Project|Nick]]" keeps the pipe and never resolves.
      const target = String(raw).replace(/^\[\[/, '').replace(/\]\]$/, '').split(/[|#]/)[0].trim();
      if (!target) continue;
      const key = `${edgeType}:${target.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // Explicit [[...]] syntax in frontmatter is a deliberate reference —
      // strict. A bare value ("source: claude") may be a label — soft.
      const explicit = /^\[\[.*\]\]$/.test(String(raw).trim());
      out.push({ toText: target, type: edgeType, source: 'frontmatter', soft: !explicit });
    }
  }

  return out;
}

/**
 * Basename/alias → path lookup table. Aliases come from frontmatter; when two
 * notes claim the same name the shallower path wins and the collision is
 * reported (brain check surfaces it as duplicate-alias).
 */
export function buildNameMap(notes: { path: string; aliases: string[] }[]): {
  nameMap: Map<string, string>;
  collisions: { name: string; paths: string[] }[];
  /** Separator-normalized names ('-'/'_' → space) with a SINGLE unambiguous owner,
   *  for resolving links that use a different separator than the note title. */
  sepMap: Map<string, string>;
} {
  const claims = new Map<string, string[]>();
  const claim = (name: string, p: string) => {
    const k = name.normalize('NFC').toLowerCase().trim();
    if (!k) return;
    if (!claims.has(k)) claims.set(k, []);
    claims.get(k)!.push(p);
  };
  for (const n of notes) {
    claim(n.path.split('/').pop()!.replace(/\.md$/, ''), n.path);
    for (const a of n.aliases) claim(a, n.path);
  }
  const nameMap = new Map<string, string>();
  const collisions: { name: string; paths: string[] }[] = [];
  for (const [name, paths] of claims) {
    const unique = [...new Set(paths)];
    if (unique.length > 1) {
      unique.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
      collisions.push({ name, paths: unique });
    }
    nameMap.set(name, unique[0]);
  }
  // ALSO index PATH forms (full path, and path-without-.md, lowercased) so that
  // path-qualified links `[[Folder/Note]]` and extension links `[[Note.md]]`
  // resolve instead of being reported as broken. These are for RESOLUTION only —
  // they never participate in collision detection (a name claim ≠ a path form).
  for (const n of notes) {
    const full = n.path.normalize('NFC').toLowerCase();
    const noMd = full.replace(/\.md$/, '');
    if (!nameMap.has(noMd)) nameMap.set(noMd, n.path);
    if (!nameMap.has(full)) nameMap.set(full, n.path);
  }
  // Separator-tolerant map: fold '-'/'_' to spaces so "[[Jane-Doe]]" can resolve
  // to "Jane Doe". Keep ONLY keys with a single owner — if two DISTINCT notes
  // normalize to the same key ("Acme Voice of Customer" vs "Acme Voice-of-Customer"),
  // the name is ambiguous and must never silently resolve to one of them.
  const sepKeyOf = (s: string) => s.normalize('NFC').toLowerCase().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  const sepOwners = new Map<string, Set<string>>();
  for (const n of notes) {
    const add = (name: string) => { const k = sepKeyOf(name); if (k) { if (!sepOwners.has(k)) sepOwners.set(k, new Set()); sepOwners.get(k)!.add(n.path); } };
    add(n.path.split('/').pop()!.replace(/\.md$/, ''));
    for (const a of n.aliases) add(a);
  }
  const sepMap = new Map<string, string>();
  for (const [k, owners] of sepOwners) if (owners.size === 1) sepMap.set(k, [...owners][0]);
  return { nameMap, collisions, sepMap };
}

/** Resolve candidates to edges using the name map. Unresolved STRICT edges
 *  are kept and flagged (brain check reports them as broken links);
 *  unresolved SOFT candidates are labels, not links — dropped. */
export function resolveEdges(fromPath: string, candidates: EdgeCandidate[], nameMap: Map<string, string>, sepMap?: Map<string, string>): Edge[] {
  const out: Edge[] = [];
  for (const c of candidates) {
    const key = c.toText.normalize('NFC').toLowerCase().trim();
    // exact name/path form → trailing-.md stripped (`[[Note.md]]`) → separator-
    // normalized unambiguous fallback (`[[Jane-Doe]]` → "Jane Doe"; a stray
    // trailing "\" from `[[Name\]]` is dropped first).
    const sepKey = key.replace(/\\+$/, '').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
    const resolved = nameMap.get(key) ?? nameMap.get(key.replace(/\.md$/, '')) ?? sepMap?.get(sepKey);
    if (!resolved && c.soft) continue;
    out.push({
      from: fromPath,
      to: resolved ?? c.toText,
      type: c.type,
      source: c.source,
      ...(resolved ? {} : { unresolved: true }),
    });
  }
  return out;
}
