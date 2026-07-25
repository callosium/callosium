// Entitlement entry point — read the on-disk license (if any) and report the
// effective tier. Everything funnels through here so the rest of the app asks a
// single question ("what tier am I?") and never touches crypto directly.
//
// The license lives OUTSIDE the brain (~/.callosium/license.json), like the graph
// cache — it's per-device machine state, not part of the user's notes, and must
// never sync into a vault. Absent file → free. Every failure → free.

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evaluateEntitlement, type Entitlement, type SignedLicense, type Tier, hasTier } from './license.ts';
import { restrictToOwner, restrictDirToOwner } from '../util/secrets.ts';

export { hasTier, type Tier, type Entitlement } from './license.ts';

export function licensePath(): string {
  return path.join(os.homedir(), '.callosium', 'license.json');
}

/** Read + evaluate the license from disk. Never throws — a missing or malformed
 *  file resolves to the free tier. Cheap enough to call on demand; callers that
 *  hit it in a hot path can cache the result for the process lifetime. */
export async function loadEntitlement(file = licensePath()): Promise<Entitlement> {
  let signed: SignedLicense | null = null;
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.payload === 'string' && typeof parsed.sig === 'string') signed = parsed;
  } catch {
    signed = null; // no file / unreadable / bad JSON → free
  }
  return evaluateEntitlement(signed);
}

/** Persist a signed license (e.g. after a Keygen activation). Writes atomically
 *  via temp+rename so a crash can't leave a half-written license that then reads
 *  as free on next boot. */
export async function saveLicense(license: SignedLicense, file = licensePath()): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(license, null, 2), 'utf8');
  // Tighten the TEMP file, before the rename — chmod'ing after would leave a
  // window where the final path is world-readable.
  await restrictToOwner(tmp);
  await fs.rename(tmp, file);
  await restrictDirToOwner(path.dirname(file));
}

/** Remove a stored license (deactivation / sign-out) — back to free. */
export async function clearLicense(file = licensePath()): Promise<void> {
  await fs.rm(file, { force: true }).catch(() => {});
}
