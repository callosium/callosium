// Shared shapes for the Callosium engine. File-first: every index the engine
// keeps is derived from the markdown and rebuildable; the folder is the truth.

/** A note's path relative to the brain root, forward slashes, with .md. */
export type NotePath = string;

export interface Frontmatter {
  type?: string;
  tags?: string[];
  status?: string;
  updated?: string;
  aliases?: string[];
  source?: string;
  date?: string;
  related?: string[];
  area?: string;
  platform?: string;
  creator?: string;
  /** Server-stamped attribution — written only by the brain server, never by agents. */
  created_by?: string;
  updated_by?: string;
  [key: string]: unknown;
}

export interface Note {
  path: NotePath;
  frontmatter: Frontmatter;
  /** Body without the frontmatter block. */
  body: string;
  /** True when the file had no parseable frontmatter (verbatim/reference exempt files). */
  rawFile: boolean;
  /** True when rawFile is due to the file having NO `---` block at all (a plain legacy note), as
   *  opposed to a present-but-malformed YAML block. A no-frontmatter note is safely ADOPTABLE — it
   *  can be wrapped with server frontmatter with nothing to forge; a malformed block is not. */
  noFrontmatter?: boolean;
}

// ─── Schema (the filing constitution, loaded from JSON) ───────────────

export interface PartitionDef {
  path: string;
  job: string;
  scaffold?: string[];
  structure?: string | string[];
  gated?: boolean;
  gateTopics?: string[];
  bucketed?: boolean;
  indexPerSource?: boolean;
  managedByCallosium?: boolean;
}

export interface BrainSchema {
  schemaVersion: string;
  name: string;
  description?: string;
  partitions: { core: PartitionDef[]; modules?: (PartitionDef & { id: string })[] };
  noteTypes: string[];
  frontmatter: {
    required: string[];
    optional?: string[];
    serverStamped?: { fields: string[]; rule: string };
    statusValues?: string[];
    exempt?: string;
  };
  naming?: Record<string, string>;
  linking?: Record<string, unknown>;
  routing?: unknown;
  /** Per-type home folders: maps a noteType to the folder it files into (e.g.
   *  { initiative: "Ventures", knowledge: "Notes" }). Lets an adopted vault route to its OWN
   *  folder names instead of Callosium's defaults; routeNote falls back to the built-in default
   *  for any type not listed, so existing brains keep filing exactly as before. */
  noteTypeHomes?: Record<string, string>;
  [key: string]: unknown;
}

// ─── Graph (zero-LLM typed edges) ─────────────────────────────────────

/** How the edge was derived — provenance, auditable. */
export type EdgeSource = 'wikilink' | 'frontmatter';

export interface Edge {
  /** Note the edge points FROM (relative path). */
  from: NotePath;
  /** Resolved target path, or the raw link text if unresolved. */
  to: string;
  /** Typed relation: related_to, sourced_from, in_area, by_creator, mentions... */
  type: string;
  source: EdgeSource;
  /** True when `to` could not be resolved to an existing note. */
  unresolved?: boolean;
}

export interface GraphIndex {
  /** Bump when extraction logic changes shape — stale pages re-extract (Gbrain pattern). */
  extractorVersion: string;
  builtAt: string;
  edges: Edge[];
  /** Per-note content hash at extraction time, for incremental rebuilds. */
  noteHashes: Record<NotePath, string>;
}

// ─── Recall (evidence-tagged, deterministic) ──────────────────────────

export interface RecallEvidence {
  /** Which query keywords hit, and where (filename, path, heading, body). */
  matchedTerms: { term: string; where: ('filename' | 'path' | 'heading' | 'body' | 'alias')[] }[];
  score: number;
}

export interface RecallResult {
  path: NotePath;
  /** The extracted answering section, not the whole file. */
  excerpt: string;
  evidence: RecallEvidence;
  /**
   * Create-safety hint for agents: does a note for this topic already exist?
   * 'exists' — this note IS the topic; 'probable' — near match, check before
   * creating; 'unknown' — no strong match found.
   */
  createSafety: 'exists' | 'probable' | 'unknown';
  /** Additional high-scoring sections from the SAME note (Typesense
   *  group_by pattern): answers that span sections arrive whole. */
  moreChunks?: { heading: string | null; excerpt: string }[];
}

export interface RecallAnswer {
  /** False = explicit "not in the brain" — agents must not invent an answer. */
  found: boolean;
  results: RecallResult[];
  notInBrainReason?: string;
  /** The interlinked neighborhood of the top result (up to 3 hops, capped,
   *  pointers only): what this knowledge CONNECTS to, so agents get the
   *  thought-context, not an isolated note. */
  context?: { path: string; relation: string; direction: 'out' | 'in'; hops?: number }[];
  /** Set when the top candidates are near-tied and genuinely distinct
   *  (different documents, not duplicates): the agent should ASK THE USER
   *  which one they mean instead of guessing — the human approach. */
  clarify?: { reason: string; options: { path: string; hint: string }[] };
  /** Typo/voice corrections applied to the query — always disclosed, never silent. */
  corrections?: { from: string; to: string }[];
  /** Drop-tokens relaxation applied (weakest terms removed to find an answer)
   *  — always disclosed so the agent knows the match is looser. */
  relaxation?: { droppedTerms: string[] };
  /** Set when the question carries build/synthesis intent ("based on X,
   *  build me a poc for Y"): the answer is EQUIPMENT for producing work.
   *  Delivery widens (8 results, doubled chunk budget, 30 context pointers
   *  seeded from the top 2 results) and guidance tells the agent to read
   *  the full cluster and keep recalling until nothing is missing. */
  richness?: { anchor: string; guidance: string };
}

// ─── Agents (identity, scoping, attribution) ──────────────────────────

export interface AgentIdentity {
  /** Stable id, e.g. "claude-desktop". */
  id: string;
  /** Display name stamped into created_by/updated_by, e.g. "Claude (Desktop)". */
  displayName: string;
  /** Bearer token (random, generated at pairing). Never the display name. */
  token: string;
  /** Path-prefix scopes. Empty read = everything readable; empty write = nothing writable. */
  scopes: { read: string[]; denyRead?: string[]; write: string[] };
  pairedAt: string;
  /** ISO timestamp after which the token is refused. Absent = never expires
   *  (the default — a local pairing shouldn't stop working on its own). Set when
   *  the owner wants a time-boxed connection (e.g. a temporary remote grant). */
  expiresAt?: string;
  /** ISO timestamp of the last token rotation, if any. Purely informational —
   *  lets the cockpit show "rotated 2h ago" so the owner knows the old token died. */
  rotatedAt?: string;
}

export interface AgentsRegistry {
  agents: AgentIdentity[];
}

// ─── brain check (audit findings, never destructive) ──────────────────

export type FindingKind =
  | 'broken-wikilink'
  | 'missing-frontmatter'
  | 'invalid-frontmatter'
  | 'unknown-type'
  | 'invalid-status'
  | 'orphan-note'
  | 'moc-gap'
  | 'hub-gap'
  | 'dated-note-drift'
  | 'duplicate-alias'
  | 'sync-conflict-copy';

export interface Finding {
  kind: FindingKind;
  path: NotePath;
  detail: string;
  /** All notes involved in the finding (e.g. every note claiming a duplicate
   *  name). Lets the dashboard offer a cleanup action without re-parsing detail. */
  paths?: NotePath[];
  /** The canonical/original note a copy shadows (sync-conflict-copy → the real
   *  file the copy duplicates). */
  related?: NotePath;
  /** The missing target of a broken-wikilink ([[target]] that resolves to no
   *  note). Kept as its own field so a stable dismissal key doesn't depend on the
   *  human-readable detail string. */
  target?: string;
  /** A stable identity for this finding (kind + the notes/target it concerns),
   *  computed when served — the dashboard uses it to dismiss/undismiss. Not set by
   *  the checker itself. */
  key?: string;
}
