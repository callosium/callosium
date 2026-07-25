// The MAP — the spine the owner's DIY had and the product was missing. A brain that
// knows its own shape: where everything lives, how to navigate it, and where new
// things go. Generated FROM the vault + schema, not hand-written, so it never
// drifts. Two artifacts:
//   generateMap()          — the routing map an AI reads FIRST (productized
//                            Workspace Instructions.md); derived from the live vault.
//   generateFilingRules()  — the rules the STRUCTURING LLM follows to file raw
//                            data into the canonical structure (the code never
//                            classifies; it hands the LLM these rules via MCP).
// Both are plain markdown so they travel with the vault and any AI (Claude,
// ChatGPT, whatever) inherits them — the data-sovereignty payoff.

import type { BrainSchema } from '../core/types.ts';
import type { VaultTexts } from '../recall/engine.ts';
import type { Vault } from '../core/vault.ts';
import { partitionOf, partitionPaths } from '../core/schema.ts';

/** Canonical in-vault home for the generated map. Under System/ (managed by
 *  Callosium) so it isn't confused with the owner's own notes, and it travels
 *  with the vault so a non-MCP tool that just opens the folder can read it too. */
export const MAP_REL = 'System/Map.md';

/** Safety bound on how deep the map walks below a partition. It is deliberately
 *  generous: a fixed shallow cap is what made a real hierarchy invisible in the
 *  first place, and any cap re-creates that blindness one level deeper. Flooding is
 *  controlled by WHAT earns a line (below), not by depth. */
const MAX_SUB_DEPTH = 6;

const MONTHS =
  'january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec';
/** Is this folder name mechanical date scaffolding ("2026", "07 Jul", "January",
 *  "19") rather than a topic? Temporal folders hold plenty of notes but are worth
 *  nothing as filing destinations — the partition's `layout:` line already explains
 *  the pattern. The walk STOPS at the first one, so date trees collapse to their
 *  topical parent instead of flooding the map with every year/month/day. */
const isDateSegment = (s: string): boolean =>
  /^\d{4}$/.test(s) ||
  /^\d{1,2}$/.test(s) ||
  new RegExp(`^(\\d{1,2}[\\s-]+)?(${MONTHS})$`, 'i').test(s) ||
  new RegExp(`^(${MONTHS})[\\s-]*\\d{0,4}$`, 'i').test(s);

/** Persist the FULL (unscoped) map to the vault so it travels and stays current.
 *  Callers pass the full texts (never a per-agent scoped view — the persisted map
 *  must be complete). Best-effort: a write failure must never break re-index. */
export async function writeMap(vault: Vault, schema: BrainSchema, texts: VaultTexts): Promise<void> {
  try {
    await vault.writeFile(MAP_REL, generateMap(schema, texts));
  } catch {
    /* non-fatal: the map is regenerable on demand via get_map */
  }
}

// Lightly pull frontmatter type/aliases without a full parse (first 400 chars).
function fmType(text: string): string | null {
  return (text.slice(0, 400).match(/^type:\s*["']?([a-z ]+)["']?\s*$/mi)?.[1] || null)?.trim() || null;
}
const baseName = (f: string) => f.split('/').pop()!.replace(/\.md$/, '');

/** A partition's declared layout, normalized. brain.json allows EITHER an array of
 *  layout lines (Work) or a single string (Memory: "<Source>/<Year>/<MM Month>/").
 *  Only the array form used to render, so a string layout was silently invisible in
 *  both the map and the filing rules — which is exactly how two connected agents
 *  invented two different Memory shapes, one dated and one flat. Never drop a
 *  declared layout: it is the only thing telling an AI where inside a partition to file. */
function layoutOf(p: unknown): string[] {
  const st = (p as { structure?: unknown }).structure;
  if (Array.isArray(st)) return st.filter((x): x is string => typeof x === 'string' && x.trim() !== '');
  return typeof st === 'string' && st.trim() !== '' ? [st.trim()] : [];
}

/** Is this note a hub/MOC/index — a navigation anchor worth surfacing on the map?
 *  Exported so brain_check uses the SAME definition the map + write-path nudge do
 *  (a note is a hub via frontmatter `type: moc` OR a home/index/moc basename) —
 *  otherwise the audit and the nudge disagree on what a hub is. */
export function isHub(f: string, text: string): boolean {
  const b = baseName(f).toLowerCase();
  // Case-insensitive on the frontmatter type — "type: MOC" is the dominant PKM
  // spelling; without lowercasing a legit hub would lose its hub role on the map.
  return (fmType(text) || '').toLowerCase() === 'moc' || b === 'home' || b === 'overview' || b.endsWith(' index') || b === 'index' || b.endsWith(' moc');
}

/** The hub/MOC note that governs a note's topic — the NEAREST hub sharing its
 *  folder path, walking from the note's own folder up to the top partition. Lets
 *  write_note nudge the AI to wire a fresh note into its map-of-content (the AI
 *  authors hub membership; the code only points). Returns the hub's basename for
 *  a [[wikilink]], or null when no hub governs the topic. Excludes the note itself
 *  and System/ plumbing. */
export function hubForNote(notePath: string, texts: VaultTexts, canSee?: (p: string) => boolean): string | null {
  if (notePath.startsWith('System/')) return null;
  const seg = notePath.split('/');
  for (let depth = seg.length - 1; depth >= 1; depth--) {
    const prefix = seg.slice(0, depth).join('/') + '/';
    for (const f of texts.files) {
      if (f === notePath || !f.startsWith(prefix)) continue;
      // The hub must sit DIRECTLY in this ancestor folder — not in a deeper
      // sibling subfolder — or a note would be nudged toward an unrelated hub.
      if (f.slice(prefix.length).includes('/')) continue;
      if (/\/Raw\//.test(f)) continue;
      // Never point a scoped agent at a hub it cannot read (matches suggestLinks
      // + get_map, which are both scope-filtered); owner passes no filter.
      if (canSee && !canSee(f)) continue;
      if (isHub(f, texts.texts.get(f) || '')) return baseName(f);
    }
  }
  return null;
}

/** The routing MAP: how this specific brain is organized and how to find things.
 *  Read first by any connected AI (get_map / get_instructions). Derived from the
 *  ACTUAL top-level folders + their schema jobs + the real hub notes present. */
export function generateMap(schema: BrainSchema, texts: VaultTexts): string {
  const partOrder = partitionPaths(schema);
  const jobOf = new Map<string, string>();
  const structOf = new Map<string, string[]>();
  for (const p of [...schema.partitions.core, ...(schema.partitions.modules ?? [])]) {
    jobOf.set(p.path, p.job);
    const lay = layoutOf(p);
    if (lay.length) structOf.set(p.path, lay);
  }

  // Group live notes by the partition that OWNS them (skip the managed System/
  // internals; verbatim Raw/ dumps are skipped further down so the map shows
  // navigable knowledge, not plumbing). Keyed by the DEEPEST matching partition
  // — the same longest-prefix rule partitionOf uses everywhere else — not by the
  // first path segment: a schema may declare a MULTI-segment partition
  // ("Work/Projects"), and keying on seg[0] meant that key never existed, so a
  // `partOrder.filter(byTop.has)` section list silently dropped it. The result
  // was a partition with no section, no job, no layout and no subfolder lines —
  // the identical top-segment-only bug partitionOf was fixed for. Folders the
  // schema doesn't know still fall back to seg[0].
  //
  // OWNERSHIP IS NOT THE SAME QUESTION AS "does this partition get a section".
  // Keying the section list on the owner alone just moved the invisibility from
  // the child to the PARENT: with a declared "Work/Projects", a vault whose Work
  // notes all sit under Work/Projects/ owned nothing at "Work", so Work vanished
  // — its job and its four declared layout lines (Meetings/<Year>/…, People/,
  // Playbooks/) went with it, and an AI reading the map could no longer learn
  // where a Work meeting note belongs. So `present` records EVERY declared
  // partition a visible note lives under — the owner plus all of its ancestors —
  // and that, not byTop, decides who gets a section. A partition with zero
  // visible notes still gets none: get_map hands us a scope-filtered file list
  // (mcp/server.ts), and rendering every declared partition unconditionally
  // would disclose to a restricted agent that a gated Private/ exists.
  const byTop = new Map<string, string[]>();
  const present = new Set<string>();
  for (const f of texts.files) {
    if (f.startsWith('System/')) continue;
    const top = partitionOf(schema, f) ?? (f.includes('/') ? f.split('/')[0] : '(root)');
    (byTop.get(top) ?? byTop.set(top, []).get(top)!).push(f);
    for (const p of partOrder) if (f === p || f.startsWith(p + '/')) present.add(p);
  }

  // Partitions first in schema order, then any custom top-level folders the owner
  // added (so a personalized brain still maps fully), then root files.
  const known = new Set(partOrder);
  const tops = [
    ...partOrder.filter((p) => present.has(p)),
    ...[...byTop.keys()].filter((t) => !known.has(t) && t !== '(root)').sort(),
    ...(byTop.has('(root)') ? ['(root)'] : []),
  ];

  const sections: string[] = [];
  const hubs: string[] = [];
  for (const top of tops) {
    // May be empty: a parent partition whose notes all live under a DEEPER
    // declared partition owns none of them directly, yet still needs its section.
    const files = byTop.get(top) ?? [];
    // How many segments the partition itself occupies. Everything below is
    // measured from HERE, not from seg[0], so a multi-segment partition's own
    // path is never repeated inside its subfolder lines.
    const topDepth = top === '(root)' ? 0 : top.split('/').length;
    // anchor picks: hubs first, then shallow notes; cap the noise.
    const anchors: string[] = [];
    // Subfolders under this top — surfaced as their own nodes with a note count +
    // hub, so a nested workspace the owner (or an AI) creates shows up on the map
    // instead of vanishing into the parent's total. This is what keeps "make a
    // subfolder" a visible structural act.
    //
    // RECURSIVE to MAX_SUB_DEPTH: registering only the second level (seg[1]) made
    // every deeper folder invisible — an AI reading the map could not see, and so
    // would not file into, a real hierarchy like
    // Callosium/Marketing and Launch/Outreach/. Keyed by the path RELATIVE to top.
    const subs = new Map<string, { count: number; hub: string | null; depth: number }>();
    for (const f of files) {
      const t = texts.texts.get(f) || '';
      const isH = isHub(f, t);
      if (isH) hubs.push(baseName(f));
      const seg = f.split('/');
      if (seg.length === topDepth + 1 && !/\/Raw\//.test(f)) anchors.push(baseName(f));
      if (/\/Raw\//.test(f)) continue;
      // Register this note against EVERY ancestor folder BELOW `top`, to the cap.
      // seg.length - 1 is one past the deepest folder index (the last seg is the file).
      // No ancestor here can itself be a partition: a note under a nested
      // partition was grouped under THAT partition, so it never reaches here.
      for (let d = topDepth + 1; d <= Math.min(seg.length - 1, topDepth + MAX_SUB_DEPTH); d++) {
        // Stop at date scaffolding: the note still counts toward every topical
        // ancestor above, but no year/month/day folder becomes its own node.
        if (isDateSegment(seg[d - 1])) break;
        const rel = seg.slice(topDepth, d).join('/');
        if (!rel) continue;
        const cur = subs.get(rel) ?? { count: 0, hub: null, depth: d - topDepth };
        cur.count++;
        // A folder's hub must sit DIRECTLY in it — not in a deeper sibling — or a
        // parent would inherit a child's hub and mislabel the topic.
        if (isH && seg.length === d + 1 && !cur.hub) cur.hub = baseName(f);
        subs.set(rel, cur);
      }
    }
    const job = jobOf.get(top);
    const sub = structOf.get(top);
    // Declared partitions nested INSIDE this one (visible ones only — see the
    // scope note above). Their notes are owned by them, so they are absent from
    // this section's count and its ↳ lines; naming them here is what keeps the
    // count honest and points the AI at the section that governs that subtree.
    const nested = partOrder.filter((p) => p !== top && p.startsWith(top + '/') && present.has(p));
    const head = `### ${top}/  —  ${job ?? 'custom folder'}  (${files.length} note${files.length === 1 ? '' : 's'})`;
    const lines = [head];
    if (nested.length) lines.push(`  contains: ${nested.map((n) => `${n}/`).join(' · ')} — each has its own section here; their notes count there, not in the total above`);
    if (sub?.length) lines.push(`  layout: ${sub.join(' · ')}`);
    if (anchors.length) lines.push(`  anchors: ${anchors.slice(0, 8).map((a) => `[[${a}]]`).join(', ')}${anchors.length > 8 ? ` … (+${anchors.length - 8})` : ''}`);
    // A subfolder earns a line if it holds a HUB (at any depth — a hub is a
    // navigation anchor by definition, and the filing rules tell every AI to give a
    // new folder one, so following the doctrine makes a new area visible here
    // immediately) or holds ≥2 notes. SELECT by importance, then RENDER in path
    // order so parents print above their children and the indentation reads as a
    // tree.
    const eligible = [...subs.entries()].filter(([, v]) => v.hub || v.count >= 2);
    const SUB_LIMIT = 20;
    const picked = eligible
      .sort((a, b) => (b[1].hub ? 1 : 0) - (a[1].hub ? 1 : 0) || b[1].count - a[1].count)
      .slice(0, SUB_LIMIT)
      .map(([rel]) => rel);
    // Then pull in every ANCESTOR of a picked folder. The old code assumed a
    // parent always outranks its child ("a parent's count includes its
    // descendants") — it does not: hub-bearing children sort ahead of every
    // hubless parent, and a parent holding a single note isn't eligible at all.
    // On a 25-client vault the cap kept twenty depth-2 folders and dropped all
    // twenty-five parents, so the map printed twenty indented lines with no
    // parent above them. Ancestors are shown even when they didn't earn a line
    // on their own — an indentation level whose parent is missing is a lie about
    // where the folder lives, and the map is what an AI files by. Ancestors are
    // the only thing that can push the block past SUB_LIMIT, and they bound it at
    // SUB_LIMIT × MAX_SUB_DEPTH; naming a folder correctly is worth those lines.
    const shown = new Set(picked);
    for (const rel of picked) {
      const parts = rel.split('/');
      for (let i = 1; i < parts.length; i++) {
        const anc = parts.slice(0, i).join('/');
        if (subs.has(anc)) shown.add(anc);
      }
    }
    const subLines = [...shown]
      .sort((a, b) => a.localeCompare(b))
      .map((rel) => {
        const v = subs.get(rel)!;
        // Print the path RELATIVE TO THE PARTITION, not the leaf name. The leaf
        // alone left the real path to be inferred from indentation, so twenty
        // sibling "Engagement/" folders rendered as twenty identical lines and
        // an AI could not tell which client any of them belonged to. A line now
        // names its own folder no matter what else got printed.
        return `  ${'  '.repeat(v.depth - 1)}↳ ${rel}/ (${v.count} note${v.count === 1 ? '' : 's'})${v.hub ? ` — hub: [[${v.hub}]]` : ''}`;
      });
    // Never truncate silently — a hidden folder is a folder an AI will not file into.
    const hidden = eligible.filter(([rel]) => !shown.has(rel)).length;
    if (hidden) subLines.push(`  … +${hidden} more subfolders (call list_notes to see them)`);
    lines.push(...subLines);
    sections.push(lines.join('\n'));
  }

  const uniqHubs = [...new Set(hubs)];
  const hubBlock = uniqHubs.length
    ? uniqHubs.map((h) => `- [[${h}]]`).join('\n')
    : '- (no hub/MOC notes yet — a well-formed brain has one Home + a MOC per major topic; housekeeping flags this.)';

  return [
    `# ${schema.name === 'default' ? 'This brain' : schema.name} — Brain Map`,
    ``,
    `_Generated by Callosium from the brain's actual structure. Read this FIRST — it is how this brain is organized and how to find things. It replaces a hand-written vault map and stays in sync automatically._`,
    ``,
    `## How to navigate`,
    `- A factual lookup (a number, a decision, a name, a past commitment) → call **recall** first; relay "not in the brain" honestly.`,
    `- "What did I do / what happened / what moved" over a PERIOD (yesterday, last N days, last two weeks) → **recent** (returns the notes DATED in that window, newest first, with paths), then **read_note** the ones you need.`,
    `- "Where/what is X", browsing, or "latest/last X" → use this map + **list_notes**, then **read_note**.`,
    `- Start at a hub below and fan out through [[wikilinks]]; every note is reachable from a hub.`,
    `- A hub, index, or devlog SUMMARIZES — it is an entry point, not a substitute. For a "what did I do" or detail question, open the underlying notes (session logs, dated entries) IN FULL; don't answer from the summary alone.`,
    `- recall returns each note's PATH and its linked-context hops — walk to adjacent notes when you need more.`,
    `- To file something new, call **get_filing_rules** — it tells you exactly where each kind of note goes.`,
    ``,
    `## Structure — where everything lives`,
    sections.join('\n'),
    ``,
    `## Topic hubs (start here, fan out)`,
    hubBlock,
    ``,
    `## Entities`,
    `Call **glossary** for the people, clients, projects, and their aliases — consult it before linking or creating an entity note.`,
    ``,
  ].join('\n');
}

/** The FILING RULES the structuring LLM follows to turn raw dumps (PDFs, Word,
 *  chat exports) into filed notes. The code does NOT classify content — it hands
 *  the LLM these rules over MCP and the LLM (far better at understanding text)
 *  does the transformation, writing each note to its right home via write_note. */
export function generateFilingRules(schema: BrainSchema, canSee?: (partitionPath: string) => boolean): string {
  const asArr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
  // Scope the partition list to what the caller may see. get_map already hides
  // denied/gated folders from a restricted agent; without this, get_filing_rules
  // would disclose the full taxonomy (incl. that a gated Private/ exists) to any
  // agent — contradicting that invariant. Owner/CLI passes no filter (sees all).
  const allParts = [...schema.partitions.core, ...(schema.partitions.modules ?? [])];
  const parts = allParts.filter((p) => !canSee || canSee(p.path));
  // A restricted agent must not learn a denied folder exists via the ROUTING,
  // STANDING-RULE, or GROUND-TRUTH prose either — not just the partition list.
  // Drop any rule line that names a partition this agent can't see (paths appear
  // as "<Path>/" in the schema's prose). Owner/CLI (no canSee) drops nothing.
  const deniedPaths = canSee ? allParts.filter((p) => !canSee(p.path)).map((p) => p.path) : [];
  // Match a denied partition wherever it is used as a PATH EXPRESSION — the name
  // itself plus everything hanging off it ("Work/Projects/<Name>/Raw/"), bounded
  // so "Homework/" never counts as "Work/". Matching only the literal "<Path>/"
  // prefix (the old test) let the tail survive the redaction: with the shipped
  // schema a Work-denied agent read "named to never collide with a private
  // areaProjects" — the hidden partition's child folder leaked verbatim, inside
  // a nonsense token, in the rules an LLM is told to follow. Names with no
  // trailing slash count too: a rule that says "goes to Private" discloses the
  // folder just as plainly as "Private/".
  const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const deniedRe = deniedPaths.map((dp) => new RegExp(`(?<![\\w-])${escRe(dp)}(?:\\/[^\\s,;.)]*)?(?![\\w-])`, 'g'));
  const mentionsDenied = (s: string) => deniedRe.some((re) => { re.lastIndex = 0; return re.test(s); });
  // A partition's OWN free text (job, layout, gate topics) can incidentally name
  // another partition by path (e.g. a job that reads "successor to Private/").
  // Scrub any denied path out of that prose too, so a restricted agent can't
  // learn a hidden folder exists through a visible partition's description. This
  // is a no-op for the owner/CLI (deniedPaths is empty).
  const scrubDenied = (s: string) => deniedRe.reduce((acc, re) => acc.replace(re, 'a private area'), s);
  // gateTopics is hand-editable JSON — coerce to a clean string[] so a malformed
  // value (a bare string, null, numbers) can't throw and take down the whole
  // rules render for every caller.
  const gateTopicsOf = (p: unknown): string[] => {
    const gt = (p as { gateTopics?: unknown }).gateTopics;
    return Array.isArray(gt) ? gt.filter((x): x is string => typeof x === 'string') : [];
  };
  const GATE_FALLBACK = 'health, medical, intimate, or identity matters';
  const routing = asArr<{ order?: number; test: string; action: string; onUnsure?: string }>(schema.routing)
    .slice()
    .sort((a, b) => (a.order ?? 99) - (b.order ?? 99))
    .filter((r) => !mentionsDenied(r.action) && !mentionsDenied(r.test));
  const standing = asArr<{ match: string; destination: string; note?: string }>((schema as { standingRules?: unknown }).standingRules)
    .filter((s) => !mentionsDenied(s.destination) && !mentionsDenied(s.match));
  const gtp = asArr<string>((schema as { groundTruthProtocol?: unknown }).groundTruthProtocol)
    .filter((s) => !mentionsDenied(s));
  const naming = (schema.naming ?? {}) as Record<string, string>;
  const fm = schema.frontmatter;

  const out: string[] = [
    `# Filing rules for this brain`,
    ``,
    `You (the AI) do the structuring — read raw material, distill it into notes, and file each note where these rules say. Every note has a home; put it there so the Brain Map stays true and retrieval stays precise. NEVER dump raw transcripts as notes; write distilled notes and preserve raw sources verbatim (see the ground-truth protocol).`,
    ``,
    `**Write through Callosium, not the raw file system.** When you're connected over MCP, create and change notes with write_note / append_note — you get attribution, write-scope, safe no-silent-overwrite, and automatic version history for free. Edit files directly only as a fallback; if you must, follow the same rules: add an attribution comment, append rather than wholesale-replace, and never bulk-delete. Every change is versioned and recoverable either way, but going through the tools keeps your work attributed and safe.`,
    ``,
    `## Partitions — the top-level homes`,
    ...parts.map((p) => {
      const lay = layoutOf(p);
      const gt = gateTopicsOf(p);
      const gated = (p as { gated?: boolean }).gated
        ? `  [GATED — anything about ${scrubDenied(gt.length ? gt.join(', ') : GATE_FALLBACK)} goes here; see the SENSITIVE rule below]`
        : '';
      return `- **${p.path}/** — ${scrubDenied(p.job)}${gated}${lay.length ? `\n    layout: ${scrubDenied(lay.join(' · '))}` : ''}`;
    }),
    ``,
    // Gated partitions get an explicit, override-everything rule FIRST — a real
    // structuring run leaked a spouse's medical detail into Personal/ because the
    // rules only hinted "gated sensitive content". Enumerate the topics and make
    // the mixed-content case unambiguous: any touch of a gate topic sends the
    // WHOLE note to the gated partition, no matter who it's about.
    ...(() => {
      const gatedParts = parts.filter((p) => (p as { gated?: boolean }).gated);
      if (!gatedParts.length) return [];
      // The open (non-gated) partitions this agent can see — the folders a
      // sensitive note must NEVER land in. Derived from the already-visible list
      // (never a hardcoded literal) so a denied folder is never named to a
      // restricted agent, and so the clause tracks THIS brain's real taxonomy.
      const openPaths = parts.filter((p) => !(p as { gated?: boolean }).gated).map((p) => `${p.path}/`);
      const orList = (xs: string[]) =>
        xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')}${xs.length > 2 ? ',' : ''} or ${xs[xs.length - 1]}`;
      const lines: string[] = [`## SENSITIVE — check this FIRST (it overrides every rule below)`];
      // One rule PER gated partition, each with ITS OWN topics + destination, so a
      // schema with several gated homes routes each topic set to the right folder
      // instead of unioning every gate topic onto the first gated partition.
      for (const gp of gatedParts) {
        const gt = gateTopicsOf(gp);
        const topics = scrubDenied(gt.length ? gt.join(', ') : GATE_FALLBACK);
        const never = openPaths.length ? ` It NEVER goes in ${orList(openPaths)}, even when it also reads as everyday personal life or work.` : '';
        lines.push(
          `If a note touches ${topics} — YOURS OR ANYONE ELSE'S (a spouse, parent, sibling, or any relative counts) — file it in **${gp.path}/** and nowhere else.${never} If a single raw source MIXES this with non-sensitive content, the WHOLE distilled note goes to ${gp.path}/ — do not split the sensitive part into an open folder.`,
        );
      }
      lines.push(``);
      return lines;
    })(),
    `## Where a new item goes — decide in this order`,
    ...(routing.length
      ? routing.map((r, i) => `${i + 1}. If ${r.test} → ${r.action}${r.onUnsure ? ` (if unsure: ${r.onUnsure})` : ''}`)
      : [`1. Distil to the matching partition above; preserve any authoritative source verbatim in Reference/.`]),
    ``,
    // A note whose type has no fixed home (a client/project workspace, a Home/MOC
    // hub) does NOT auto-file — write_note routes only the types with a home and
    // sends the rest to Inbox for triage. Tell the AI to pass an explicit path so
    // it lands where it belongs instead of piling up in the Inbox. No partition
    // names here (they would bypass the denied-folder scrub for a scoped agent).
    `## When a note has no home of its own`,
    `Some notes — a client or project workspace, a Home or map-of-content (MOC) hub — don't match a single type-to-folder rule. Don't let them fall to the Inbox: give write_note an explicit \`path\` into the partition they belong to (for example a project's own folder, or a hub at the topic's folder). Everything else files by its type automatically.`,
    ``,
  ];
  if (standing.length) {
    out.push(`## Standing rules`, ...standing.map((s) => `- ${s.match} → ${s.destination}${s.note ? ` (${s.note})` : ''}`), ``);
  }
  if (gtp.length) {
    out.push(
      `## Ground-truth protocol (for authoritative/verbatim sources — PDFs, specs, contracts, exports)`,
      ...gtp.map((s, i) => `${i + 1}. ${s}`),
      `Never skip the raw copy: a summary without its source is a lossy single point of failure.`,
      ``,
    );
  }
  out.push(
    `## Naming`,
    ...Object.entries(naming).map(([k, v]) => `- ${k}: ${v}`),
    ``,
    `## Frontmatter (required on every note)`,
    `Required: ${fm.required.join(', ')}.` + (fm.statusValues ? ` status ∈ {${fm.statusValues.join(', ')}}.` : ''),
    `type ∈ {${schema.noteTypes.join(', ')}}.`,
    `Every required field must carry a REAL value: a present-but-empty field (\`tags: []\`, \`status: ""\`) fails the brain's health check exactly like a missing one. Give each note 3-6 lowercase topic tags a future search would actually use.`,
    fm.serverStamped ? `Do NOT write ${fm.serverStamped.fields.join('/')} — the brain server stamps them from your authenticated identity; you cannot forge them.` : ``,
    ``,
    `## Structure — folders and hubs`,
    `The Brain Map is generated from the REAL folder tree, so structure you create is structure every AI sees. When you create a NEW subfolder:`,
    `1. Create a hub note inside it (\`type: moc\`, named "<Folder> Home" or "<Folder> Index").`,
    `2. Link that hub FROM the parent folder's hub, and link back to the parent from it.`,
    `3. Write the folder's filing rule INSIDE that hub — one line on what belongs there — so the next AI files correctly without guessing.`,
    `A folder holding notes but no hub is invisible to navigation, and brain_check flags it. Don't create a subfolder for a single note; create one when at least two notes share a durable category.`,
    ``,
    `## Linking`,
    `Use [[wikilinks]]; link generously so every note is reachable from a hub; add aliases to frequently-referenced notes; verify each link target resolves before saving. Call glossary for known entities + aliases.`,
    ``,
    `When you have filed a batch, call brain_check to verify structure and fix what it flags.`,
  );
  // Keep the intentional blank-line separators between sections; only collapse
  // accidental multiples (from omitted optional sections) and trim the edges.
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
