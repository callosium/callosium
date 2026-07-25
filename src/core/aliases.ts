// Single source of truth for reading `aliases:` out of a note's frontmatter.
// Supports BOTH the flow form (`aliases: [a, b]`) AND the block form
// (`aliases:` then indented `- a` lines). Four call sites — the ranker, the
// dashboard entity/auto-link map, and two MCP entity readers (resolve dedup +
// entity_map) — each reimplemented a flow-ONLY regex and silently dropped every
// block-style aliases list, so the same note could be deduped by the ranker but
// not by write_note. They now all route through here. (Callosium backlog P2 #9.)
const ALIAS_FLOW_RE = /^aliases:\s*\[([^\]]*)\]/m;
const ALIAS_BLOCK_RE = /^aliases:[ \t]*\n((?:[ \t]*-[ \t]*.+\n?)+)/m;
const unquote = (s: string): string => s.trim().replace(/^["']|["']$/g, '');

/** Parse aliases out of an ALREADY-EXTRACTED frontmatter block. */
export function parseAliases(fm: string): string[] {
  const flow = fm.match(ALIAS_FLOW_RE);
  if (flow) return flow[1].split(',').map(unquote).filter(Boolean);
  const block = fm.match(ALIAS_BLOCK_RE);
  if (block) return block[1].split('\n').map((l) => unquote(l.replace(/^[ \t]*-[ \t]*/, ''))).filter(Boolean);
  return [];
}

/** Parse aliases out of a WHOLE note's text: scans the leading `---` frontmatter
 * block (falling back to the first 500 bytes when there is no closing marker, so
 * a note with long frontmatter above `aliases:` still resolves — matching the
 * ranker's long-standing behavior). */
export function aliasesOf(noteText: string): string[] {
  const fmEnd = noteText.startsWith('---') ? noteText.indexOf('\n---', 3) : -1;
  return parseAliases(fmEnd > 0 ? noteText.slice(0, fmEnd) : noteText.slice(0, 500));
}
