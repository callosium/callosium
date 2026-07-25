// Single source of truth for reading `aliases:` out of a note's frontmatter.
// Supports BOTH the flow form (`aliases: [a, b]`) AND the block form
// (`aliases:` then indented `- a` lines). Four call sites — the ranker, the
// dashboard entity/auto-link map, and two MCP entity readers (resolve dedup +
// entity_map) — each reimplemented a flow-ONLY regex and silently dropped every
// block-style aliases list, so the same note could be deduped by the ranker but
// not by write_note. They now all route through here. (Callosium backlog P2 #9.)
//
// Everything here is CRLF-tolerant and quote-aware, because an alias this module
// gets WRONG is worse than an alias it misses: aliases feed entity dedup, the
// glossary and the auto-link writer, so a phantom alias becomes a wrong-note
// answer and, via connect-orphans, a wrong `[[link|text]]` written into the
// owner's file.
// The `[` may sit on the line BELOW the key — `aliases:\n  [Bobby, Bob S]` is
// ordinary YAML and gray-matter reads it as a two-item list. An earlier revision
// tightened `\s*` to `[ \t]*` (to stop the key swallowing a following block
// sequence) and lost that spelling: it matched neither the flow nor the block
// pattern, so the note came back alias-less while the graph still knew the names.
// One optional indented line break is allowed back, and only that: the indent is
// required (YAML demands the continuation be indented past the key), so a
// following top-level key's own flow list — `aliases:\ntags: [a, b]` — still
// cannot be mistaken for this one, and `^` at column 0 keeps a nested `aliases:`
// out.
const ALIAS_FLOW_OPEN_RE = /^aliases:[ \t]*(?:\r?\n[ \t]+)?\[/m;
// `[ \t]*\n` demanded a BARE LF right after the key, so every Windows-authored
// note (`aliases:\r\n  - Bobby`) fell through to `return []` — gray-matter, which
// feeds the graph's name map, read the same note as ["Bobby","Bob S"]. The split
// was silent and only hit the block form, so it stayed invisible in mixed vaults.
// frontmatter.ts already splits on /\r?\n/; CRLF is a supported input everywhere
// else in the pipeline.
const ALIAS_BLOCK_RE = /^aliases:[ \t]*\r?\n((?:[ \t]*-[ \t]*.+\r?\n?)+)/m;

/** Strip YAML quoting from ONE scalar. Only a MATCHED pair comes off: the old
 *  strip-either-end rule dressed the halves of a wrongly-split quoted alias back
 *  up as plausible aliases, which is how `["Smith, John"]` produced the entities
 *  "Smith" and "John". Escapes are undone so the value equals what gray-matter
 *  hands the rest of the app for the same line. */
const unquote = (s: string): string => {
  const t = s.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    return t.slice(1, -1).replace(/\\([\\"ntr])/g, (_m, c: string) => (c === 'n' ? '\n' : c === 't' ? '\t' : c === 'r' ? '\r' : c));
  }
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
  return t;
};

/** Split the flow list that begins at `i` (just past the `[`) into raw items, or
 *  null when it is never closed. Scanning instead of `split(',')` because the
 *  naive split was a round-trip bug against our OWN writer: frontmatter.ts quotes
 *  a comma-bearing scalar precisely so it stays ONE value (`aliases: ["Smith,
 *  John"]`), and we then shredded it into two phantom aliases — so write_note
 *  refused a legitimate new "Smith" note as "already exists as People/John
 *  Smith.md", an identity it had never verified. Real vaults already contain this
 *  input. Scanning also ends the list at its true `]` rather than the first one,
 *  so a QUOTED alias containing `]` is no longer truncated.
 *
 *  A quote only OPENS a scalar when it is the first non-space character of the
 *  item, because that is the only place YAML lets one quote: everywhere else `'`
 *  and `"` are literal text. Treating every quote as a delimiter made ordinary
 *  vault content unreadable — `[O'Brien, Doc]` ran off the end of the list and
 *  dropped BOTH aliases, and an even count of apostrophes was worse
 *  (`[Dad's Clinic, Mum's Clinic]` fused into one phantom alias). Apostrophes are
 *  normal in People/ names (O'Brien, Dad's Clinic, Q1'26), and `5" pipe` is the
 *  same bug with the other quote. */
function splitFlow(fm: string, i: number): string[] | null {
  const items: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  for (; i < fm.length; i++) {
    const c = fm[i]!;
    if (quote) {
      // Inside a double-quoted scalar a backslash escapes the next char (our
      // serializer emits \" and \\), so it must not be read as the closing quote.
      // A single-quoted scalar's '' escape needs nothing: the toggle re-opens.
      if (c === '\\' && quote === '"') {
        cur += c + (fm[i + 1] ?? '');
        i++;
        continue;
      }
      if (c === quote) quote = null;
      cur += c;
      continue;
    }
    // `cur.trim() === ''` is the "nothing but leading whitespace so far" test —
    // whitespace includes the newlines a flow list may legally contain.
    if ((c === '"' || c === "'") && cur.trim() === '') {
      quote = c;
      cur += c;
      continue;
    }
    if (c === ',') {
      items.push(cur);
      cur = '';
      continue;
    }
    if (c === ']') {
      items.push(cur);
      return items;
    }
    cur += c; // newlines included: a flow list may legally span lines
  }
  return null; // unterminated — no honest reading, so report no aliases
}

/** Parse aliases out of an ALREADY-EXTRACTED frontmatter block. */
export function parseAliases(fm: string): string[] {
  const flow = fm.match(ALIAS_FLOW_OPEN_RE);
  if (flow) {
    const items = splitFlow(fm, (flow.index ?? 0) + flow[0].length);
    if (items) return items.map(unquote).filter(Boolean);
  }
  const block = fm.match(ALIAS_BLOCK_RE);
  if (block) return block[1]!.split(/\r?\n/).map((l) => unquote(l.replace(/^[ \t]*-[ \t]*/, ''))).filter(Boolean);
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
