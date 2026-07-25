// brain check — the audit command. Validates the whole brain against its
// schema and reports findings. NEVER destructive: output is a report; fixes
// that need judgment go to the human (or, later, the housekeeping task inbox
// their own AI processes). Productizes the vault health check.

import { Vault } from '../core/vault.ts';
import { parseNote } from '../core/frontmatter.ts';
import { loadSchema } from '../core/schema.ts';
import { validateNote, isConformanceExempt } from '../filing/engine.ts';
import { buildGraph, type BuildResult } from '../graph/index.ts';
import { isHub } from '../structure/map.ts';
import type { VaultTexts } from '../recall/engine.ts';
import type { Finding, Note } from '../core/types.ts';

/** An EPISODIC note — a memory record or a session log — is a snapshot of ONE day. If
 *  it is still being written days later, an agent is appending today's work into an old
 *  dated note: the record then lies about when things happened, and "what did I do on
 *  the 22nd" finds nothing dated the 22nd. Living documents (plans, MOCs, references)
 *  are SUPPOSED to be revised later, so only day-scoped types are checked, and one
 *  day of slack is allowed for a session that runs past midnight. */
function datedNoteDrift(path: string, note: Note): Finding[] {
  const t = String(note.frontmatter.type ?? '').toLowerCase();
  if (t !== 'memory' && t !== 'log') return [];
  const day = (v: unknown): number | null => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v ?? '').trim().replace(/^["']/, ''));
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null;
  };
  const d = day(note.frontmatter.date);
  const u = day(note.frontmatter.updated);
  if (d === null || u === null) return [];
  const days = Math.round((u - d) / 86_400_000);
  if (days < 2) return [];
  return [
    {
      kind: 'dated-note-drift',
      path,
      detail: `dated ${String(note.frontmatter.date).replace(/["']/g, '').slice(0, 10)} but still being written ${days} days later — start a new note for each day instead of appending into an older dated one`,
    },
  ];
}

export interface CheckReport {
  notes: number;
  edges: number;
  findings: Finding[];
  /** Findings grouped by kind, for the summary line. */
  byKind: Record<string, number>;
  schemaSource: 'brain' | 'default';
  ms: number;
}

/** Sync-conflict copies: "Note-DEVICE NAME.md" siblings of "Note.md" — the
 *  cloud-sync staleness artifact found in real vaults (OneDrive appends the
 *  device name; Dropbox uses "conflicted copy"; Syncthing ".sync-conflict"). */
function syncConflictFindings(files: string[]): Finding[] {
  const set = new Set(files);
  const out: Finding[] = [];
  // A suffix is treated as a device/user name (not part of the title) only when
  // it's device-SHAPED: a DESKTOP-/LAPTOP-/MacBook- auto-name, a possessive
  // ("Bob's ..."), or any multi-word computer name ("MacBook Air"). A bare
  // hyphen-word like "PC-Build" or "Report-Final" is NOT device-shaped, so
  // ordinary hyphenated titles aren't mistaken for conflict copies.
  // Device-SHAPED = a DESKTOP-/LAPTOP-/MacBook- auto-name or a possessive
  // ("the owner's MacBook Air"). We deliberately do NOT treat "any multi-word suffix"
  // as a device — that flagged ordinary titles like "Report - Final Draft".
  const deviceShaped = (s: string) =>
    /^(desktop|laptop|macbook)[- ]\S+/i.test(s) || /['’]s(\s|$)/.test(s);
  for (const f of files) {
    // Syncthing: "Note.sync-conflict-YYYYMMDD-HHMMSS-DEVICEID.md" — the suffix
    // is inserted BEFORE the extension, with no parentheses (the real format;
    // the parenthetical form below never appears in a Syncthing vault).
    const syncthing = f.match(/^(.*)\.sync-conflict-\d{8}-\d{6}-[^./]+\.md$/);
    // Dropbox parenthetical marker. The real filename usually carries the
    // device/user name BEFORE the marker ("File (Bob's conflicted copy ...)"),
    // so allow any prefix inside the parens before the marker word.
    const explicit = f.match(/^(.*) \([^()]*?(?:conflicted copy|sync-conflict)[^)]*\)\.md$/);
    let base: string | null = syncthing?.[1] ?? explicit?.[1] ?? null;
    if (base == null && !syncthing && !explicit) {
      // OneDrive device suffix: "Name-<device>.md". A device name
      // ("DESKTOP-AB12", "the owner's MacBook Air") can itself contain hyphens, so
      // scan split points from the RIGHT and accept the one whose ENTIRE
      // trailing segment is device-shaped — this correctly isolates a trailing
      // "DESKTOP-AB12" even when the title itself contains hyphens.
      // Split the BASENAME only, never the full path — a folder name's hyphens
      // ("Q1-Reports/Note.md") must not fabricate a cross-folder "original".
      const slash = f.lastIndexOf('/');
      const dir = slash === -1 ? '' : f.slice(0, slash + 1);
      const parts = f.slice(slash + 1).replace(/\.md$/i, '').split('-');
      for (let i = parts.length - 1; i > 0; i--) {
        if (deviceShaped(parts.slice(i).join('-'))) { base = dir + parts.slice(0, i).join('-'); break; }
      }
    }
    if (base == null) continue;
    const original = `${base}.md`;
    if (original !== f && set.has(original)) {
      out.push({
        kind: 'sync-conflict-copy',
        path: f,
        related: original,
        paths: [f, original],
        detail: `looks like a sync-conflict duplicate of "${original}" — review, merge, delete manually`,
      });
    }
  }
  return out;
}

/** Verbatim, owner-must-not-edit source: /Raw/ scraped dumps and /Recovered
 *  Sessions/ chat transcripts. Broken links and orphans inside these are expected
 *  and unfixable-in-place, so the checker leaves them alone. */
const inVerbatim = (p: string) => /(^|\/)Raw\//i.test(p) || /(^|\/)Recovered Sessions\//i.test(p);

/** Curated set of single-word tokens that are almost always a SYNTAX EXAMPLE in
 *  prose ("which phrases become [[links]]", "the format was [[text]]"), never a
 *  real note name. Deliberately narrow + membership-gated so a real single-word
 *  note is never hidden. */
const PLACEHOLDER_LINK_WORDS = new Set([
  'name', 'names', 'link', 'links', 'text', 'note', 'notes', 'example', 'examples',
  'title', 'tag', 'tags', 'foo', 'bar', 'baz', 'thing', 'item', 'items', 'key',
  'value', 'id', 'page', 'slug', 'label', 'field', 'type', 'x', 'y', 'z',
]);
function isPlaceholderLinkTarget(raw: string): boolean {
  const s = raw.split('/').pop()!.replace(/\.md$/i, '').trim();
  return /^[a-z]+$/.test(s) && PLACEHOLDER_LINK_WORDS.has(s);
}

export async function brainCheck(vault: Vault, shared?: { texts?: VaultTexts; build?: BuildResult | null }): Promise<CheckReport> {
  const t0 = Date.now();
  const { schema, source } = await loadSchema(vault);
  const findings: Finding[] = [];

  // Callers that already loaded the vault (the dashboard's loadAll) hand the
  // texts and the graph build IN, so a post-write rebuild reads the vault ONCE
  // instead of loadTexts + buildGraph + brainCheck each re-reading every note.
  const { index, collisions } = shared?.build ?? (await buildGraph(vault, shared?.texts));
  const files = Object.keys(index.noteHashes);

  // 1. broken wikilinks (unresolved graph edges). A link to a real ATTACHMENT
  //    (a .pdf/.html/.docx/… file that exists in the vault, with or without its
  //    extension) is not a broken NOTE link — Callosium just doesn't index it as a
  //    note. Don't flag those.
  const attachments = await vault.listAttachmentNames();
  for (const e of index.edges) {
    if (!e.unresolved) continue;
    // Verbatim source is sacrosanct: /Raw/ dumps and /Recovered Sessions/ chat
    // transcripts contain example links ("i think it was [[text]]") and links to
    // notes that never existed, and the owner must not edit them — so a broken
    // link inside one is not an actionable finding.
    if (inVerbatim(e.from)) continue;
    // System/ is Callosium-generated (e.g. Map.md's "fan out through [[wikilinks]]"
    // teaching line is an example, not a real link). The owner doesn't author it, so
    // a "broken link" there is never actionable — same treatment orphans/moc-gap give it.
    if (e.from.startsWith('System/')) continue;
    const raw = e.to.trim();
    // Can't name any real note → a documentation placeholder, not a broken link:
    // chars that never survive filename sanitisation (< > : | * ? "), or a bare-dot
    // link like [[.]] / [[...]].
    if (/[<>:|*?"]/.test(raw) || /^\.+$/.test(raw)) continue;
    // Single all-lowercase common word (`[[name]]`, `[[links]]`, `[[text]]`) is a
    // syntax/format placeholder in prose, not a real note reference — real notes
    // and entities are Title-Case or multi-word. Only the curated set is skipped,
    // so a genuine single-word note (`[[myproject]]`) still surfaces.
    if (isPlaceholderLinkTarget(raw)) continue;
    const base = raw.split('/').pop()!.normalize('NFC').toLowerCase().trim();
    if (attachments.has(base)) continue;
    findings.push({ kind: 'broken-wikilink', path: e.from, target: e.to, detail: `[[${e.to}]] resolves to no note` });
  }

  // 2. duplicate aliases / name collisions. Per-folder structural files (a
  //    README, SKILL, or Index in every folder) repeat by DESIGN — that isn't
  //    "two notes fight over a name", so they aren't a real clash. Skip them.
  const STRUCTURAL = new Set(['readme', 'index', 'skill', 'sources', 'guide', 'home', 'moc', 'overview', 'notes', '_index', 'about', 'readme.md']);
  // Same-name-different-folder is INTENTIONAL structure, not a clash, when the
  // colliding notes are: per-client data dumps under /Raw/ (booking.md,
  // google_maps.md …); a recurring dated series under /Meetings/ (a bi-weekly
  // that files one note per date); or a sync-conflict/quarantine copy (already
  // surfaced as sync-conflict-copy). A real clash is two DISTINCT notes fighting
  // over the same name/alias — those we keep flagging.
  const inRaw = (p: string) => /(^|\/)Raw\//i.test(p);
  const inMeetings = (p: string) => /(^|\/)Meetings\//i.test(p);
  const isConflictCopy = (p: string) => /(^|\/)Quarantine\b/i.test(p) || /-[^/]*(?:macbook|imac|desktop|laptop|['’]s )/i.test(p.split('/').pop() || '');
  for (const c of collisions) {
    if (STRUCTURAL.has(c.name)) continue;
    if (c.paths.every(inRaw)) continue;
    if (c.paths.every(inMeetings)) continue;
    if (c.paths.some(isConflictCopy)) continue;
    findings.push({
      kind: 'duplicate-alias',
      path: c.paths[0],
      paths: c.paths,
      detail: `"${c.name}" claimed by ${c.paths.length} notes: ${c.paths.join(' · ')}`,
    });
  }

  // 3. frontmatter validation per note. Only STRICT (against a user-authored
  //    brain.json) — the generic default schema must not judge a mature vault's
  //    own type/status conventions as "malformed".
  const strict = source === 'brain';
  // Detect hubs while we already have each note's text in hand — using the SAME
  // isHub() the map + write-path nudge use (frontmatter type:moc OR home/index/moc
  // basename), so the moc-gap audit can't disagree with what the map calls a hub.
  const hubPaths = new Set<string>();
  // M3: derive the vault's OWN type/status vocabulary in this single read pass, so a customized
  // vault whose notes consistently use types/statuses the stock schema never listed isn't flagged
  // as a storm of "unknown type"/"invalid status". A value used across enough notes is intentional
  // vocabulary; a one-off odd value is more likely a typo and still surfaces.
  const parsedNotes: Array<{ f: string; parsed: ReturnType<typeof parseNote> }> = [];
  const typeCounts = new Map<string, number>();
  const statusCounts = new Map<string, number>();
  for (const f of files) {
    // A transient read failure must NOT be treated as an empty note — that would
    // emit a bogus "missing-frontmatter" finding for a file that's merely locked.
    // With shared texts, loadTexts already made that distinction (unreadable set).
    const raw = shared?.texts
      ? (shared.texts.unreadable.has(f) ? null : (shared.texts.texts.get(f) ?? null))
      : await vault.readFileRetry(f).catch(() => null);
    if (raw === null) continue;
    if (!f.startsWith('System/') && !inVerbatim(f) && isHub(f, raw)) hubPaths.add(f);
    const parsed = parseNote(f, raw);
    parsedNotes.push({ f, parsed });
    // Exclude the same files validateNote never conformance-checks (exempt/raw/excalidraw), so a
    // drawing's or verbatim file's stray type/status can't pad the accepted vocabulary.
    if (!isConformanceExempt(f) && !parsed.rawFile && !/\.excalidraw\.md$/i.test(f)) {
      const ty = parsed.frontmatter.type;
      if (ty) typeCounts.set(String(ty), (typeCounts.get(String(ty)) ?? 0) + 1);
      const st = parsed.frontmatter.status;
      if (st) statusCounts.set(String(st), (statusCounts.get(String(st)) ?? 0) + 1);
    }
  }
  const VOCAB_MIN = 3; // a type/status in >= 3 notes is the vault's intentional vocabulary, not a typo
  const accepted = {
    types: new Set([...typeCounts].filter(([, c]) => c >= VOCAB_MIN).map(([v]) => v)),
    statuses: new Set([...statusCounts].filter(([, c]) => c >= VOCAB_MIN).map(([v]) => v)),
  };
  for (const { f, parsed } of parsedNotes) {
    findings.push(...validateNote(schema, parsed, strict, accepted));
    if (!inVerbatim(f)) findings.push(...datedNoteDrift(f, parsed));
  }

  // 4. orphans: nothing links in, it links nothing, and no catalogue names it
  const connected = new Set<string>();
  for (const e of index.edges) {
    if (e.unresolved) continue;
    connected.add(e.from);
    connected.add(e.to);
  }
  const orphanPaths = new Set<string>();
  for (const f of files) {
    const stem = f.split('/').pop()!.toLowerCase().replace(/\.md$/, '');
    // Leaves by design are NOT orphans: index/MOC/home hubs, Templates, Inbox,
    // and anything under a /Raw/ folder — verbatim scraped/exported source dumps
    // that are meant to be terminal data, not interlinked knowledge notes. Match
    // "index"/"moc" as whole WORDS (not substrings — "reindexing-plan" isn't a hub).
    // Union of the shared isHub set (catches a frontmatter type:moc hub whose
    // NAME isn't moc-ish) and the original name pattern — so this only ever grows
    // the leaf set, never newly flags a note as an orphan that wasn't before.
    const isLeaf = hubPaths.has(f) || /(^|[^a-z])(index|moc)([^a-z]|$)/.test(stem) || stem === 'home' ||
      f.startsWith('Templates/') || f.startsWith('Inbox/') || inVerbatim(f);
    if (!connected.has(f) && !isLeaf) {
      orphanPaths.add(f);
      findings.push({ kind: 'orphan-note', path: f, detail: 'no links in or out — unreachable from any note' });
    }
  }

  // 4b. hub gaps: a note sits in a folder that HAS a map-of-content (a Home/MOC/
  //     index note) but that hub doesn't link it — so the note is present in the
  //     topic yet missing from the topic's map. This is the structure-drift the
  //     write path nudges the AI to avoid; this pass catches what slipped. Kept
  //     tight (SAME folder only, hubs detected by the shared isHub, capped,
  //     advisory weight) so it stays low-noise.
  const backlinks = new Map<string, Set<string>>();
  for (const e of index.edges) {
    if (e.unresolved) continue;
    (backlinks.get(e.to) ?? backlinks.set(e.to, new Set<string>()).get(e.to)!).add(e.from);
  }
  const folderHub = new Map<string, string>(); // folder prefix → first hub note in it
  for (const f of hubPaths) {
    const folder = f.split('/').slice(0, -1).join('/') + '/';
    if (!folderHub.has(folder)) folderHub.set(folder, f);
  }
  // No cap: every finding is a real note path, so byKind counts, the CLI summary,
  // the health card, and per-agent scope-filtering all stay honest (a synthetic
  // "+N more" row undercounted in byKind, fell past the dashboard's 50-row slice,
  // and was scope-filtered away for restricted agents). moc-gap is advisory weight
  // (0.1), so even a large count barely moves the score; the dashboard caps its
  // own visible rows.
  for (const f of files) {
    if (f.startsWith('System/') || inVerbatim(f) || f.startsWith('Inbox/') || f.startsWith('Templates/')) continue;
    if (hubPaths.has(f)) continue; // a hub isn't its own gap
    if (orphanPaths.has(f)) continue; // fully unlinked → orphan-note owns it (don't double-count)
    const hub = folderHub.get(f.split('/').slice(0, -1).join('/') + '/');
    if (!hub || hub === f) continue; // no hub governs this folder
    if (backlinks.get(f)?.has(hub)) continue; // the hub already links it → wired
    findings.push({
      kind: 'moc-gap',
      path: f,
      detail: `sits beside a map-of-content ([[${hub.split('/').pop()!.replace(/\.md$/, '')}]]) that doesn't link it — add it to the hub so the note stays reachable`,
    });
  }

  // 4c. hub gaps — structural drift when a new folder/hierarchy appears. These are
  //     two failures the note-level moc-gap audit structurally CANNOT see:
  //     (a) a hub exists but isn't linked from its nearest ANCESTOR hub — the
  //         "made a subfolder, wrote its map, forgot to wire it into the parent"
  //         case, which leaves a whole new area unreachable from navigation;
  //     (b) a folder holds >=3 notes, has no hub of its own, and NOT ONE of its
  //         notes is linked from any hub. moc-gap only fires for folders that
  //         ALREADY have a hub, so without this an entire new hierarchy can be
  //         created and never audited at all.
  const skipStructural = (p: string) =>
    p.startsWith('System/') || p.startsWith('Templates/') || p.startsWith('Inbox/') || inVerbatim(p) || /(^|\/)Reference\/Skills\//.test(p);
  const folderOf = (p: string) => p.split('/').slice(0, -1).join('/');

  // DELIBERATELY NOT CHECKED: "every hub must be linked from another hub". Both
  // forms of it were measured against a real 1,100-note vault and both are noise.
  // Naming a nearest-ancestor hub as "the parent" misfires when two PEER topic hubs
  // share a partition root (it reported Callosium - Home against LinkedIn Brand MOC),
  // and the looser "linked from ANY hub" form still fires ~38 times on a healthy
  // vault — per-client folder hubs and per-source Index.md files are reached by
  // convention, not by link. A safety net that cries wolf is worse than none, so the
  // audit keeps only the unambiguous case below: content nothing can navigate to.
  const byFolder = new Map<string, string[]>();
  for (const f of files) {
    if (skipStructural(f) || hubPaths.has(f)) continue;
    const fold = folderOf(f);
    if (!fold) continue;
    (byFolder.get(fold) ?? byFolder.set(fold, []).get(fold)!).push(f);
  }
  for (const [fold, notes] of byFolder) {
    if (notes.length < 3 || folderHub.has(fold + '/')) continue;
    // Reachable if ANY note here is linked from any hub (e.g. a parent hub that
    // lists the folder's notes directly) — that's wired enough, don't nag.
    if (notes.some((n) => [...(backlinks.get(n) ?? [])].some((src) => hubPaths.has(src)))) continue;
    findings.push({
      kind: 'hub-gap',
      path: notes[0],
      detail: `"${fold}/" holds ${notes.length} notes but has no map-of-content and none of them is linked from any hub — add a hub here, or link them into the parent's hub`,
    });
  }

  // 4d. one-way-to-the-map: a note that links OUT to a hub/MOC but NO hub links
  //     BACK to it, and which neither moc-gap (same-folder hub) nor hub-gap (a
  //     >=3-note hub-less folder) already covers. This is the blind spot a brand-
  //     new single-note project falls into — it NAMES a map (links to it) yet was
  //     never added to one, so nothing can navigate TO it. Precise + low-noise:
  //     it only fires on notes that already reference a map, so a note reached by
  //     convention that never mentions a hub is never nagged.
  const outHubOf = new Map<string, string>();
  for (const e of index.edges) {
    if (e.unresolved || !hubPaths.has(e.to) || outHubOf.has(e.from)) continue;
    outHubOf.set(e.from, e.to);
  }
  for (const f of files) {
    if (skipStructural(f) || f.startsWith('Inbox/') || hubPaths.has(f) || orphanPaths.has(f)) continue;
    if (folderHub.has(folderOf(f) + '/')) continue;                     // same-folder hub → moc-gap (4b) owns it
    if ([...(backlinks.get(f) ?? [])].some((src) => hubPaths.has(src))) continue; // a hub already links it → wired
    const outHub = outHubOf.get(f);
    if (!outHub) continue;                                              // doesn't reference any map → not this finding
    findings.push({
      kind: 'moc-gap',
      path: f,
      target: outHub,
      detail: `links to a map-of-content ([[${outHub.split('/').pop()!.replace(/\.md$/, '')}]]) but that map doesn't link back — add [[${f.split('/').pop()!.replace(/\.md$/, '')}]] to it so the note is reachable, not only reaching`,
    });
  }

  // 5. sync-conflict duplicate files
  findings.push(...syncConflictFindings(files));

  const byKind: Record<string, number> = {};
  for (const f of findings) byKind[f.kind] = (byKind[f.kind] || 0) + 1;

  return { notes: files.length, edges: index.edges.length, findings, byKind, schemaSource: source, ms: Date.now() - t0 };
}
