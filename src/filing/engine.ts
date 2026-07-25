// Filing engine: the routing rules that turn "store this" into the right
// path, plus frontmatter validation against the schema. Deterministic and
// auditable — an agent can ask WHERE something will file before writing it.
// Entity resolution runs before any create: aliases map to one canonical
// note so duplicate entities (the community's "silent killer") never fork.

import type { BrainSchema, Finding, Frontmatter, Note } from '../core/types.ts';
import { partitionOf, partitionPaths } from '../core/schema.ts';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Local date parts — NOT UTC. An evening write in a +offset timezone must
 *  not file under yesterday (the recall.mjs lesson, kept). */
function dateParts(d = new Date()) {
  return {
    yyyy: d.getFullYear(),
    mm: String(d.getMonth() + 1).padStart(2, '0'),
    mon: MONTHS[d.getMonth()],
    dd: String(d.getDate()).padStart(2, '0'),
    dUnpadded: d.getDate(),
    monthLong: d.toLocaleString('en', { month: 'long' }),
    iso: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
  };
}

export interface RouteRequest {
  /** Note type from the schema's noteTypes. */
  type: string;
  /** Human title, plain words with spaces (schema naming rule). */
  title: string;
  /** For memory records: the writing source's display name, e.g. "Claude". */
  source?: string;
  date?: Date;
}

export interface Route {
  path: string;
  frontmatter: Frontmatter;
  /** Why it filed there — agents relay this, humans can audit it. */
  reason: string;
}

function partition(schema: BrainSchema, path: string) {
  return [...schema.partitions.core, ...(schema.partitions.modules ?? [])].find((p) => p.path === path);
}

// Strip anything that can't safely be a single filesystem path segment:
// path separators (would nest into an unplanned folder or climb out via "../"),
// the Windows-reserved chars : " * ? < > | (writeFile throws on them, and ':'
// specifically can hijack an NTFS alternate data stream), and leading/trailing
// dots or spaces (invalid as a trailing Windows path segment).
const sanitizeSegment = (s: string): string =>
  s.replace(/[\x00-\x1f]+/g, ' ').replace(/[\\/:*?"<>|]+/g, ' - ').replace(/^[.\s]+/, '').replace(/[.\s]+$/, '').trim();

export function routeNote(schema: BrainSchema, req: RouteRequest): Route {
  const d = dateParts(req.date);
  const title = sanitizeSegment(req.title.trim());
  if (!title) throw new Error('routeNote: empty title');
  // A type the owner gave an explicit home (noteTypeHomes) is intentional even if they forgot to
  // also add it to noteTypes — route it to that home (default branch) rather than throwing.
  if (
    !schema.noteTypes.includes(req.type) &&
    !(
      schema.noteTypeHomes &&
      typeof schema.noteTypeHomes === 'object' &&
      // hasOwnProperty, not `in` — `in` walks the prototype chain, so a type literally named
      // 'toString'/'constructor'/'hasOwnProperty' would wrongly bypass the unknown-type throw and
      // get filed with a bogus type.
      Object.prototype.hasOwnProperty.call(schema.noteTypeHomes, req.type)
    )
  ) {
    throw new Error(`Unknown note type "${req.type}". Schema types: ${schema.noteTypes.join(', ')}`);
  }
  const base = (fm: Partial<Frontmatter>): Frontmatter => ({
    type: req.type,
    tags: [req.type],
    status: 'active',
    updated: d.iso,
    ...fm,
  });

  // Per-type home folder: an adopted vault can override where each type files (e.g.
  // { initiative: "Ventures", knowledge: "Notes" }) via schema.noteTypeHomes; otherwise
  // Callosium's default folder is used, so existing brains keep filing exactly as before.
  // Coerce a malformed noteTypeHomes (a hand-edited brain.json could set it to a string/number)
  // to an empty map so lookups just miss and fall back, rather than throwing later.
  const homes = (schema.noteTypeHomes && typeof schema.noteTypeHomes === 'object' ? schema.noteTypeHomes : {}) as Record<string, string>;
  // Normalize a configured home into a safe relative folder, or `fallback` if it's unusable. Strips
  // leading/trailing separators so "/Reports" files under Reports/ (instead of yielding "/Title.md",
  // which the containment guard rejects and which would hard-fail the write), collapses an
  // only-slashes value like "///" to the fallback, and refuses a "../x" traversal to the fallback.
  const cleanHome = (raw: unknown, fallback: string): string => {
    if (typeof raw !== 'string') return fallback;
    const cleaned = raw.trim().replace(/^[/\\]+/, '').replace(/[/\\]+$/, '');
    if (!cleaned) return fallback;
    if (cleaned.split(/[/\\]+/).some((seg) => seg === '..')) return fallback;
    return cleaned;
  };
  const home = (type: string, fallback: string): string => cleanHome(homes[type], fallback);

  switch (req.type) {
    case 'memory': {
      // `source` is the agent's free-form displayName and is interpolated
      // straight into the path — sanitize it the same way, or a displayName like
      // "../Work" would mis-file the record outside Memory/<Source>/.
      const source = sanitizeSegment(req.source?.trim() || 'Unknown') || 'Unknown';
      // Falls back to the canonical 'Memory' partition name when the schema does
      // not declare one. This used to fall back to a specific author's folder name
      // instead — a personal detail that was never part of the shipped schema, so it
      // could only ever match one vault while reading as if it were a real
      // compatibility path. If a legacy layout ever needs supporting, it belongs in
      // the schema as a declared alias, not hardcoded here.
      const memRoot = home('memory', 'Memory');
      const name = `${source} ${title} ${d.dd} ${d.mon} ${d.yyyy}`;
      return {
        path: `${memRoot}/${source}/${d.yyyy}/${d.mm} ${d.mon}/${name}.md`,
        frontmatter: base({ source: source.toLowerCase(), date: d.iso, tags: ['memory', source.toLowerCase()] }),
        reason: `memory records file per-source under ${memRoot}/<Source>/<Year>/<MM Mon>/, named "<Source> <Topic> <DD Mon YYYY>"`,
      };
    }
    case 'log': {
      const logRoot = home('log', 'Logs');
      // M7: sub-structure logs by <Source>/<Year>/<MM Mon>/ like Memory when the writer is
      // known (an AI's displayName), so a busy multi-AI vault doesn't pile hundreds of flat
      // "Session …" files in one folder. No source (a human/pre-AI log) → flat Logs/, unchanged.
      const source = sanitizeSegment(req.source?.trim() || '') || '';
      const dir = source ? `${logRoot}/${source}/${d.yyyy}/${d.mm} ${d.mon}` : logRoot;
      return {
        path: `${dir}/Session ${d.dUnpadded} ${d.monthLong} ${d.yyyy}.md`,
        frontmatter: base({ date: d.iso, tags: source ? ['log', 'session', source.toLowerCase()] : ['log', 'session'] }),
        reason: source
          ? `session logs file under ${logRoot}/<Source>/<Year>/<MM Mon>/, named "Session <D> <Month> <YYYY>"`
          : `session logs file under ${logRoot}/, named "Session <D> <Month> <YYYY>" (day unpadded)`,
      };
    }
    case 'person': {
      const f = home('person', 'People');
      return { path: `${f}/${title}.md`, frontmatter: base({}), reason: `one short note per person under ${f}/` };
    }
    case 'initiative': {
      const f = home('initiative', 'Initiatives');
      return { path: `${f}/${title}.md`, frontmatter: base({}), reason: `own ventures and side projects anchor under ${f}/` };
    }
    case 'knowledge': {
      const f = home('knowledge', 'Knowledge');
      return { path: `${f}/${title}.md`, frontmatter: base({}), reason: `evergreen know-how under ${f}/` };
    }
    case 'milestone': {
      const f = home('milestone', 'Milestones');
      return {
        path: `${f}/${title}.md`,
        frontmatter: base({ status: 'done', completed: d.iso }),
        reason: `finished workstreams under ${f}/`,
      };
    }
    case 'reference': {
      const f = home('reference', 'Reference');
      return {
        path: `${f}/${title}.md`,
        frontmatter: base({}),
        reason: `verbatim source material under ${f}/ (move into a topic bucket when one fits)`,
      };
    }
    default: {
      // A type with a declared home files there; an undeclared type (or one whose home value cleans
      // to nothing / a traversal) goes to Inbox for human triage rather than being guessed into the
      // wrong partition or emitting a leading-slash path the write layer would reject.
      const declared = cleanHome(homes[req.type], '');
      if (declared) {
        return { path: `${declared}/${title}.md`, frontmatter: base({}), reason: `type "${req.type}" files under ${declared}/ (schema noteTypeHomes)` };
      }
      return {
        path: `Inbox/${title}.md`,
        frontmatter: base({}),
        reason: `no home declared for type "${req.type}" — filed to Inbox/ for triage, never guessed`,
      };
    }
  }
}

// ─── validation (shared with brain check) ─────────────────────────────

/** Files exempt from note-conformance rules by design: verbatim source (/Raw/ and
 *  /Recovered Sessions/ dumps, and transcripts — the schema's frontmatter.exempt
 *  rule keeps verbatim source untouched), skill-package manifests (SKILL.md), and
 *  Callosium-managed/generated System/ files. Each keeps its own format (or none),
 *  so judging it against note conventions is a false flag, not a real problem. */
export function isConformanceExempt(path: string): boolean {
  if (/(^|\/)Raw\//i.test(path)) return true;
  if (/(^|\/)Recovered Sessions\//i.test(path)) return true;
  if (path.startsWith('System/')) return true;
  const base = path.split('/').pop() || '';
  if (base === 'SKILL.md') return true;
  if (/(^|\/)Transcripts?\//i.test(path) || /\btranscripts?\b/i.test(base)) return true;
  return false;
}

export function validateNote(
  schema: BrainSchema,
  note: Note,
  strict = true,
  accepted?: { types?: Set<string>; statuses?: Set<string> },
): Finding[] {
  const findings: Finding[] = [];
  // Obsidian drawings (.excalidraw.md) are canvases, not notes — they legitimately
  // carry no Callosium frontmatter, so never flag them for conformance.
  if (/\.excalidraw\.md$/i.test(note.path)) return findings;
  // Verbatim source, skill manifests, and managed System files keep their own format
  // by design (schema frontmatter.exempt) — never judge them for conformance.
  if (isConformanceExempt(note.path)) return findings;
  // Against the GENERIC DEFAULT schema (not one the user authored), a note that
  // uses its own type/status or lacks Callosium fields is NOT malformed — it's
  // just the user's own convention. Only a user-declared brain.json makes these
  // rules worth flagging. So skip all conformance checks when not strict.
  if (!strict) return findings;
  const part = partitionOf(schema, note.path);
  const partDef = part ? partition(schema, part) : undefined;

  // Reference/verbatim files are exempt from frontmatter rules by schema.
  if (note.rawFile) {
    if (part && !partDef?.bucketed && part !== 'Inbox' && !note.path.startsWith('Reference/')) {
      findings.push({ kind: 'missing-frontmatter', path: note.path, detail: `no frontmatter block (partition ${part} expects one)` });
    }
    return findings;
  }

  for (const req of schema.frontmatter.required) {
    const v = note.frontmatter[req];
    if (v === undefined) {
      findings.push({ kind: 'invalid-frontmatter', path: note.path, detail: `missing required field "${req}"` });
      continue;
    }
    // A required field that is PRESENT but EMPTY carries no information and is
    // just as broken as a missing one — agents were shipping `tags: []` and
    // sailing past this check, leaving notes with no retrievable topic at all.
    const isEmpty =
      v === null ||
      (typeof v === 'string' && v.trim() === '') ||
      (Array.isArray(v) && v.filter((x) => String(x ?? '').trim() !== '').length === 0);
    if (isEmpty) {
      findings.push({ kind: 'invalid-frontmatter', path: note.path, detail: `required field "${req}" is empty` });
    }
  }
  // A type/status is valid if the schema lists it OR the vault itself uses it consistently
  // (accepted = the auto-derived vocabulary passed by brainCheck) — so a customized vault's own
  // conventions aren't flagged as a storm of "unknown type"/"invalid status".
  const t = note.frontmatter.type;
  if (t && !schema.noteTypes.includes(String(t)) && !accepted?.types?.has(String(t))) {
    findings.push({ kind: 'unknown-type', path: note.path, detail: `type "${t}" not in schema noteTypes` });
  }
  const s = note.frontmatter.status;
  if (s && schema.frontmatter.statusValues && !schema.frontmatter.statusValues.includes(String(s)) && !accepted?.statuses?.has(String(s))) {
    findings.push({ kind: 'invalid-status', path: note.path, detail: `status "${s}" not in schema statusValues` });
  }
  return findings;
}

// ─── entity resolution ────────────────────────────────────────────────

/**
 * Before creating a note for an entity, resolve its name against everything
 * the brain already knows (basenames + aliases from the graph name map).
 * Exact match → the existing canonical note. No match → safe to create.
 */
export function resolveEntity(nameMap: Map<string, string>, name: string): { exists: boolean; canonical?: string } {
  const hit = nameMap.get(name.normalize('NFC').toLowerCase().trim());
  return hit ? { exists: true, canonical: hit } : { exists: false };
}
