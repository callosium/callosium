// Schema loading. Resolution order: the brain's own System/brain.json (the
// user's customized constitution) → the packaged default. A brain with no
// schema file gets the default; `callosium init` copies it in so users can
// see and edit what governs their filing.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrainSchema } from './types.ts';
import type { Vault } from './vault.ts';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SCHEMA_IN_BRAIN = 'System/brain.json';

export async function loadSchema(vault: Vault): Promise<{ schema: BrainSchema; source: 'brain' | 'default' }> {
  if (vault.exists(SCHEMA_IN_BRAIN)) {
    let raw: string | null = null;
    try {
      raw = await vault.readFileRetry(SCHEMA_IN_BRAIN);
    } catch (e) {
      // vault.exists() said it's there, but the read can still fail (permissions,
      // a race delete, a disk error). That must NOT crash MCP/dashboard/CLI
      // startup at their unguarded call sites — fall back to the default.
      console.warn(`[callosium] couldn't read ${SCHEMA_IN_BRAIN} (${(e as Error).message}); using the default schema.`);
    }
    let parsed: unknown = null;
    if (raw !== null) {
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        // brain.json is documented as hand-editable, so a typo (trailing comma,
        // unmatched brace) must not crash MCP startup with a raw SyntaxError.
        // Fall back to the packaged default and surface a clear, actionable note.
        console.warn(`[callosium] ${SCHEMA_IN_BRAIN} is not valid JSON (${(e as Error).message}); using the default schema until you fix it.`);
      }
    }
    if (parsed !== null) {
      // A syntactically-valid but structurally-invalid brain.json (a hand-edit
      // that empties partitions.core, drops a key, etc.) throws from
      // validateSchema — that must degrade to the default like a JSON typo does,
      // NOT crash MCP/dashboard/CLI startup at their unguarded call sites.
      try {
        return { schema: validateSchema(parsed), source: 'brain' };
      } catch (e) {
        console.warn(`[callosium] ${SCHEMA_IN_BRAIN} isn't a valid brain schema (${(e as Error).message}); using the default until you fix it.`);
      }
    }
  }
  const raw = await fs.readFile(path.join(PKG_ROOT, 'schema', 'default-brain.json'), 'utf8');
  return { schema: validateSchema(JSON.parse(raw)), source: 'default' };
}

/** A partition path is unsafe if it isn't a plain relative sub-path. Covers
 *  POSIX-absolute (`/x`), Windows drive-absolute (`C:\x`, `C:/x`) AND drive-
 *  relative (`C:x`), UNC / drive-root paths (`\\host\share`, `\Users`), and any
 *  `..` traversal segment — the last two are the Windows-only holes the earlier
 *  `startsWith('/')`-based check missed on this app's own target platform. */
const unsafePartitionPath = (pp: unknown): boolean =>
  typeof pp !== 'string' ||
  pp === '' ||
  path.win32.isAbsolute(pp) ||
  path.posix.isAbsolute(pp) ||
  /^[a-zA-Z]:/.test(pp) ||
  /[\x00-\x1f]/.test(pp) || // NUL/control bytes → reject before init scaffolds a bad path
  pp.split(/[\\/]/).includes('..');

/** The canonical form of a partition path: forward slashes, no `./`, no leading,
 *  trailing or doubled separators. Every consumer compares partition paths as
 *  EXACT forward-slash strings — partitionOf tests `startsWith(p + '/')`,
 *  generateMap's `known` set and generateFilingRules do plain lookups — so a
 *  non-canonical but harmless-looking value silently detached the partition from
 *  its own folder. brain.json is documented as hand-editable, and one trailing
 *  slash on `"path": "Work/"` was enough: partitionOf('Work/Projects/Acme.md')
 *  returned undefined, filing stopped conformance-checking every Work note, and
 *  the Brain Map rendered the partition with its declared layout GONE — the exact
 *  regression map.ts's layoutOf comment says made two agents invent two different
 *  shapes for the same folder. `callosium check` still said schema=brain.
 *  Normalising here, at the one place a schema becomes trusted, is what keeps
 *  every downstream exact match honest — patching each consumer would leave the
 *  next one to rediscover this. */
const canonPartitionPath = (pp: string): string =>
  pp
    .replace(/\\/g, '/')
    .split('/')
    .filter((seg) => seg !== '' && seg !== '.')
    .join('/');

export function validateSchema(x: unknown): BrainSchema {
  const s = x as BrainSchema;
  const fail = (msg: string) => {
    throw new Error(`Invalid brain schema: ${msg}`);
  };
  if (!s || typeof s !== 'object') fail('not an object');
  if (!s.schemaVersion) fail('missing schemaVersion');
  // Array.isArray, not just .length: a hand-edit that leaves partitions.core a
  // string has a truthy .length and would iterate CHARACTERS below.
  if (!Array.isArray(s.partitions?.core) || !s.partitions.core.length) fail('missing partitions.core');
  if (s.partitions.modules !== undefined && !Array.isArray(s.partitions.modules)) fail('partitions.modules is not a list');
  if (!Array.isArray(s.noteTypes) || !s.noteTypes.length) fail('missing noteTypes');
  if (!Array.isArray(s.frontmatter?.required)) fail('missing frontmatter.required');
  for (const p of s.partitions.core) {
    if (!p.path || !p.job) fail(`partition missing path or job: ${JSON.stringify(p)}`);
    // Partition paths become real folders (handleInit mkdir, filing routes). An
    // untrusted brain.json (init can point at any folder, incl. a downloaded
    // "starter brain") must not smuggle an absolute path or a `..` escape.
    if (unsafePartitionPath(p.path)) {
      fail(`unsafe partition path (absolute or traversal): ${JSON.stringify(p.path)}`);
    }
    const canon = canonPartitionPath(p.path);
    if (!canon) fail(`partition path is empty once normalised: ${JSON.stringify(p.path)}`);
    p.path = canon;
  }
  for (const p of s.partitions.modules ?? []) {
    // A falsy module path used to skip validation entirely and then flow into
    // partitionPaths as an empty string, giving the map a nameless section.
    if (!p.path) fail(`module partition missing path: ${JSON.stringify(p)}`);
    if (unsafePartitionPath(p.path)) {
      fail(`unsafe module partition path: ${JSON.stringify(p.path)}`);
    }
    const canon = canonPartitionPath(p.path);
    if (!canon) fail(`module partition path is empty once normalised: ${JSON.stringify(p.path)}`);
    p.path = canon;
  }
  return s;
}

/** Every active partition path (core + modules), in schema order. */
export function partitionPaths(schema: BrainSchema): string[] {
  return [
    ...schema.partitions.core.map((p) => p.path),
    ...(schema.partitions.modules ?? []).map((p) => p.path),
  ];
}

/** The partition a note path belongs to, or undefined for root-level files. Longest-prefix match: a
 *  custom schema can define a MULTI-segment partition ("Work/Clients"), and a note belongs to the
 *  DEEPEST partition that prefixes its path — matching only the top segment (the old behavior)
 *  mis-classified or omitted notes under a nested/renamed partition. Identical to the old top-segment
 *  match for the default schema, whose partitions are all single-segment. */
export function partitionOf(schema: BrainSchema, notePath: string): string | undefined {
  let best: string | undefined;
  for (const p of partitionPaths(schema)) {
    if ((notePath === p || notePath.startsWith(p + '/')) && (best === undefined || p.length > best.length)) best = p;
  }
  return best;
}
