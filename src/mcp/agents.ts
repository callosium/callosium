// Agent identity, pairing, and scope enforcement — the two headline features.
//
// Identity: every AI pairs once and gets a registered identity + random
// token. The server stamps created_by/updated_by from the AUTHENTICATED
// connection on every write; the agent never writes its own signature, so
// attribution is unforgeable. Unstamped edits are the human's.
//
// Scoping: per-agent folder scopes, enforced server-side on every call —
// structural, not "the model promises" (the community's explicit ask).

import { randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import type { AgentIdentity, AgentsRegistry } from '../core/types.ts';
import type { Vault } from '../core/vault.ts';
import { restrictToOwner } from '../util/secrets.ts';

export const AGENTS_REL = 'System/agents.json';

/** Canonical vault-relative path for SCOPE CHECKS. A prefix test on the raw
 *  agent-supplied string is bypassable: "Knowledge/../System/agents.json"
 *  starts with "Knowledge/" so it dodges the SERVER_ONLY/denyRead prefixes,
 *  yet resolves on disk to System/agents.json (inside the root, so vault.abs
 *  lets it through) — a token-registry exfiltration + write-anywhere hole.
 *  We normalize to posix, strip any leading "./", and treat a path that
 *  escapes upward (leading "..") or is absolute as a HARD DENY by returning a
 *  sentinel that no scope can ever match. */
export function normalizeRel(p: string): string {
  const posix = (p ?? '').replace(/\\/g, '/');
  let norm = path.posix.normalize(posix).replace(/^\.\//, '');
  // win32/darwin silently strip trailing dots/spaces from every path segment
  // ("System." and "System " both open the System folder), so the scope check
  // must canonicalize the same way — otherwise "System./agents.json" dodges the
  // RESERVED/SERVER_ONLY prefix tests yet resolves to the token registry on disk.
  if (process.platform !== 'linux') {
    norm = norm.split('/').map((s) => s.replace(/[. ]+$/, '')).join('/');
    // Windows reserved DEVICE names (CON, PRN, AUX, NUL, COM1-9, LPT1-9, and the
    // console pipes) are not files — opening "CON.md" (or any extension) hangs
    // fs.readFile on a device handle. Refuse any segment whose base is a reserved
    // device, with or without an extension, so such a path never reaches disk.
    // WINDOWS ONLY: on macOS (also caught by `!== 'linux'`) "CON.md"/"Aux.md" are
    // perfectly valid note filenames and must NOT be denied.
    if (process.platform === 'win32' && norm.split('/').some((s) => /^(con|prn|aux|nul|com[1-9]|lpt[1-9]|conin\$|conout\$)(\.|$)/i.test(s))) return '\0ESCAPE';
    // Windows resolves an 8.3 short name (e.g. "SYSTEM~1") to its long form on
    // disk, so a scope check comparing the literal string would let
    // "SYSTEM~1/agents.json" reach System/agents.json. Refuse any tilde-digit
    // segment outright — real long names virtually never contain "~<digit>".
    if (/~\d/.test(norm)) return '\0ESCAPE';
    // NFC-normalize so a decomposed-unicode path can't dodge a prefix that the
    // filesystem composes to the same file.
    norm = norm.normalize('NFC');
  }
  if (norm.startsWith('..') || norm.startsWith('/') || /^[a-zA-Z]:/.test(posix) || norm === '.' || norm === '') {
    return '\0ESCAPE'; // matches no prefix and no exact SERVER_ONLY entry
  }
  return norm;
}

/** Case-fold for scope decisions on case-INSENSITIVE filesystems (Windows,
 *  default macOS). The disk layer resolves "system/agents.json" to the same
 *  file as "System/agents.json", so the scope check must too — otherwise a
 *  lowercase path dodges SERVER_ONLY/denyRead and reads the token registry. */
// NFC BOTH SIDES. normalizeRel NFC-normalizes the requested path, but scope prefixes
// arrive raw — the dashboard builds them from fs.readdir, and macOS/iCloud hand back
// decomposed (NFD) names. Comparing an NFC path against an NFD prefix silently matched
// nothing: a denyRead entry for a folder whose name carries any mark (Arabic, accented
// Latin, anything composed) denied NOTHING, and an NFD read allow-list granted nothing.
// Verified before the fix: deny stored NFC → canRead false; the SAME deny stored NFD →
// canRead true. Case folding alone was never enough, because the two forms differ in
// code points, not in case.
const foldCase = (s: string) => {
  const n = s.normalize('NFC');
  return process.platform === 'linux' ? n : n.toLowerCase();
};

/** Paths no agent may ever read or write, regardless of scope: the registry
 *  itself (holds tokens) and the schema (the constitution is human-managed). */
const SERVER_ONLY = ['System/agents.json', 'System/brain.json'];

/** Whole folders hard-denied to EVERY agent, independent of any scope object.
 *  System/ (tokens, schema, machine config) can NEVER be granted — the 🔒 the
 *  dashboard shows. Private/ is NOT here: it is denied to every agent BY DEFAULT
 *  (pairAgent seeds denyRead:['Private/']), but the owner can grant it to a
 *  specific agent by removing it from that agent's denyRead in the Agents screen.
 *  So Private is owner-grantable per-agent; System is not. */
const RESERVED = ['System/'];

export async function loadAgents(vault: Vault): Promise<AgentsRegistry> {
  if (!vault.exists(AGENTS_REL)) return { agents: [] };
  return JSON.parse(await vault.readFileRetry(AGENTS_REL)) as AgentsRegistry;
}

export async function saveAgents(vault: Vault, reg: AgentsRegistry): Promise<void> {
  await vault.writeFile(AGENTS_REL, JSON.stringify(reg, null, 2));
  // This file is the keyring: every agent's bearer token in the clear, and the
  // HTTP transport authenticates by token alone. Written with node's default
  // mode it lands at 0644 on POSIX, so any other local account could read it and
  // then drive the loopback MCP endpoint as that agent — including into folders
  // the owner scoped away from everyone. Scoping is enforced server-side
  // precisely so it can't be talked around; a world-readable keyring walks
  // around it instead.
  await restrictToOwner(vault.abs(AGENTS_REL));
}

/** Serialize every read-modify-write of the token registry ACROSS the whole
 *  process. vault.withLock now mutexes individual file writes cross-instance, but
 *  a registry update is a READ (agents.json) → modify → WRITE span, wider than a
 *  single write — so without this two racing requests (two tabs, a double-click,
 *  a CLI pair vs. a dashboard scope edit) would each read the same snapshot and
 *  the second whole-file save would clobber the first: a revoked agent gets
 *  silently resurrected with its still-valid token, or a scope edit is lost.
 *  A module-level chain keyed by the vault root makes the whole read-modify-write
 *  atomic; cross-process writers stay best-effort (the atomic temp+rename in
 *  writeFile keeps each individual write from tearing). Any given brain has one
 *  dashboard process, so that is the race that actually matters here. */
const agentsChains = new Map<string, Promise<unknown>>();
export async function updateAgents(
  vault: Vault,
  mutate: (reg: AgentsRegistry) => void | Promise<void>,
): Promise<AgentsRegistry> {
  const key = process.platform === 'linux' ? vault.root : vault.root.toLowerCase();
  const prev = agentsChains.get(key) ?? Promise.resolve();
  let result: AgentsRegistry;
  const run = prev.catch(() => {}).then(async () => {
    const reg = await loadAgents(vault);
    await mutate(reg);
    await saveAgents(vault, reg);
    result = reg;
  });
  agentsChains.set(key, run);
  try {
    await run;
  } finally {
    if (agentsChains.get(key) === run) agentsChains.delete(key); // no successor → drop
  }
  return result!;
}

export async function pairAgent(
  vault: Vault,
  id: string,
  displayName: string,
  scopes?: Partial<AgentIdentity['scopes']>,
): Promise<AgentIdentity> {
  // Constrain the id to a safe charset — it's used as a key and rendered into
  // the dashboard, so no quotes/markup/spaces (also prevents attribute/JS
  // injection in the cockpit's agent rows).
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(id)) {
    throw new Error('Agent id must be 1–64 chars: letters, numbers, dot, dash, underscore (start alphanumeric).');
  }
  let agent: AgentIdentity;
  await updateAgents(vault, (reg) => {
    // uniqueness check must be INSIDE the lock — otherwise two concurrent pairs
    // of the same id both pass the check on a stale snapshot and one is lost.
    if (reg.agents.some((a) => a.id === id)) throw new Error(`Agent id "${id}" already paired`);
    agent = {
      id,
      displayName,
      token: randomBytes(24).toString('base64url'),
      // Default scopes: read everything except Private/, write everywhere the
      // read scope covers. The dashboard narrows this per agent later.
      scopes: {
        read: scopes?.read ?? [],
        denyRead: scopes?.denyRead ?? ['Private/'],
        write: scopes?.write ?? [],
      },
      pairedAt: new Date().toISOString(),
    };
    reg.agents.push(agent);
  });
  return agent!;
}

/** Constant-time string compare — avoids leaking how many leading bytes of a
 *  token matched via response timing. timingSafeEqual throws on length
 *  mismatch, so gate on equal byte-length first (and still do the compare on a
 *  mismatch, against the stored token, so the early-out itself isn't a timing
 *  oracle for length). */
function tokenMatches(stored: string, presented: string): boolean {
  const a = Buffer.from(stored);
  const b = Buffer.from(presented);
  if (a.length !== b.length) {
    timingSafeEqual(a, a); // constant work regardless of the length check
    return false;
  }
  return timingSafeEqual(a, b);
}

// A 32-char stand-in so an UNKNOWN id still runs a full constant-time compare —
// otherwise the early-out on a missing agent leaks (via timing) which ids exist.
const DUMMY_TOKEN = 'x'.repeat(32);

/** A token is expired only if the agent carries an explicit expiresAt in the past.
 *  Absent expiresAt = never expires (the default — a local pairing must not stop
 *  working on its own). Checked AFTER the constant-time token compare, so it can't
 *  become a timing oracle: an attacker with a wrong token is rejected before this. */
function isExpired(agent: AgentIdentity): boolean {
  if (!agent.expiresAt) return false;
  const t = Date.parse(agent.expiresAt);
  // Fail CLOSED on an unparseable expiresAt: the owner explicitly time-boxed
  // this connection, so a corrupted date must never quietly become "forever"
  // (16 Jul review). Never-expires is expressed by the field's absence.
  if (!Number.isFinite(t)) return true;
  return t <= Date.now();
}
const EXPIRED_MSG = 'Authentication failed: this connection expired. Rotate or re-pair it in the dashboard.';

export function authenticate(reg: AgentsRegistry, id: string, token: string): AgentIdentity {
  const agent = reg.agents.find((a) => a.id === id);
  const ok = tokenMatches(agent?.token ?? DUMMY_TOKEN, token);
  if (!agent || !ok) {
    throw new Error('Authentication failed: unknown agent id or bad token. Pair with `callosium pair`.');
  }
  if (isExpired(agent)) throw new Error(EXPIRED_MSG);
  return agent;
}

/** Identify an agent by its bearer token alone (the HTTP transport has no id in
 *  the request). Compare against EVERY agent with no early-out so timing doesn't
 *  leak which tokens exist; a run against the dummy on a miss keeps it constant. */
export function authenticateByToken(reg: AgentsRegistry, token: string): AgentIdentity {
  let found: AgentIdentity | null = null;
  for (const a of reg.agents) { if (tokenMatches(a.token, token)) found = a; }
  if (!found) { tokenMatches(DUMMY_TOKEN, token); throw new Error('Authentication failed: bad token.'); }
  if (isExpired(found)) throw new Error(EXPIRED_MSG);
  return found;
}

/** Rotate an agent's bearer token — issue a fresh one and kill the old (a leaked
 *  or over-shared token is revoked the instant this returns, for BOTH the stdio
 *  and HTTP flows, since both authenticate against the live registry each call).
 *  The owner re-copies the new connection into the AI's config. Returns the
 *  updated identity (with the new token) so the caller can show it once. */
export async function rotateAgentToken(vault: Vault, id: string): Promise<AgentIdentity> {
  let updated: AgentIdentity | undefined;
  await updateAgents(vault, (reg) => {
    const a = reg.agents.find((x) => x.id === id);
    if (!a) throw new Error(`No paired agent "${id}" to rotate.`);
    a.token = randomBytes(24).toString('base64url');
    a.rotatedAt = new Date().toISOString();
    updated = a;
  });
  return updated!;
}

/** Change an agent's display name (the label shown in the cockpit and stamped as
 *  attribution). Id and token are untouched, so nothing needs re-pairing. */
export async function renameAgent(vault: Vault, id: string, displayName: string): Promise<AgentIdentity> {
  const name = displayName.trim();
  if (!name) throw new Error('Display name cannot be empty.');
  if (name.length > 64) throw new Error('Display name must be 64 characters or fewer.');
  let updated: AgentIdentity | undefined;
  await updateAgents(vault, (reg) => {
    const a = reg.agents.find((x) => x.id === id);
    if (!a) throw new Error(`No paired agent "${id}" to rename.`);
    a.displayName = name;
    updated = a;
  });
  return updated!;
}

/** Set (or clear, with null) an agent's expiry. A time-boxed connection stops
 *  authenticating after this instant without needing a manual revoke. */
export async function setAgentExpiry(vault: Vault, id: string, expiresAt: string | null): Promise<void> {
  await updateAgents(vault, (reg) => {
    const a = reg.agents.find((x) => x.id === id);
    if (!a) throw new Error(`No paired agent "${id}" to update.`);
    if (expiresAt) a.expiresAt = expiresAt;
    else delete a.expiresAt;
  });
}

// case-folded prefix test (folds BOTH sides so the compare matches the
// filesystem's own case rules on win32/darwin)
const matchesPrefix = (p: string, prefixes: string[]) => {
  const fp = foldCase(p);
  return prefixes.some((pre) => {
    const f = foldCase(pre);
    return fp === f.replace(/\/$/, '') || fp.startsWith(f.endsWith('/') ? f : f + '/');
  });
};

/** True for a path denied to EVERY agent regardless of scope — the System/
 *  tree (RESERVED) and the server-only registry files (SERVER_ONLY). The recall
 *  scope-before-rank fast-path treats these as NOT a scope removal: they are
 *  denied to everyone, belong in the ranking corpus (the certified benchmark
 *  ranked with them present), and are stripped from RESULTS post-rank — so an
 *  agent that can read everything EXCEPT these is still "full scope". */
export function isReservedPath(notePath: string): boolean {
  const p = normalizeRel(notePath);
  if (p === '\0ESCAPE') return false;
  return matchesPrefix(p, RESERVED) || matchesPrefix(p, SERVER_ONLY) || SERVER_ONLY.some((s) => foldCase(p) === foldCase(s));
}

export function canRead(agent: AgentIdentity, notePath: string): boolean {
  const p = normalizeRel(notePath); // canonicalize BEFORE any prefix test
  if (p === '\0ESCAPE') return false; // upward/absolute/degenerate → hard deny
  if (matchesPrefix(p, RESERVED)) return false; // System/ — never, for anyone (Private is per-agent denyRead)
  if (matchesPrefix(p, SERVER_ONLY) || SERVER_ONLY.some((s) => foldCase(p) === foldCase(s))) return false;
  if (agent.scopes.denyRead?.length && matchesPrefix(p, agent.scopes.denyRead)) return false;
  if (!agent.scopes.read.length) return true; // empty = everything (minus denials)
  return matchesPrefix(p, agent.scopes.read);
}

export function canWrite(agent: AgentIdentity, notePath: string): boolean {
  if (!canRead(agent, notePath)) return false; // write implies read (also hard-denies \0ESCAPE)
  const p = normalizeRel(notePath);
  if (!agent.scopes.write.length) return true; // v0 default: write where you can read
  return matchesPrefix(p, agent.scopes.write);
}

/** Filter recall/graph output to the agent's read scope — results must never
 *  leak excerpts from folders the agent cannot open. */
export function scopeFilter<T extends { path?: string; file?: string; other?: string }>(agent: AgentIdentity, items: T[]): T[] {
  return items.filter((it) => canRead(agent, (it.path ?? it.file ?? it.other)!));
}
