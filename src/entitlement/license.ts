// Entitlement — offline license verification.
//
// FOUNDATIONAL RULE: this module NEVER gates the free local app. Unlicensed,
// invalid, expired, wrong-device, tampered — every failure path returns tier
// 'free', which is the complete local product (your brain, your files, your AIs).
// A license only ever UPGRADES the effective tier; it can never take the base
// away. So a bug here can lock nobody out of their own notes.
//
// How it verifies (fully offline, no network): a license is a small JSON payload
// signed with an Ed25519 private key that lives only in the license issuer
// (Keygen — see keygen.ts). This app embeds the matching PUBLIC key and checks
// the signature locally. Nothing to phone home to; nothing forgeable without the
// private key. Device fingerprint + expiry + an offline-grace window bound it.

import { createPublicKey, verify as edVerify } from 'node:crypto';
import { hostname } from 'node:os';
import { createHash } from 'node:crypto';

export type Tier = 'free' | 'connected' | 'smart' | 'pro';
const PAID_TIERS: readonly Tier[] = ['connected', 'smart', 'pro'];
const TIER_RANK: Record<Tier, number> = { free: 0, connected: 1, smart: 2, pro: 3 };

/** Days a license keeps working PAST its expiry before falling back to free —
 *  covers clock skew, a renewal in flight, and stretches of no connectivity. */
export const OFFLINE_GRACE_DAYS = 21;

/** The claims a signed license asserts. Signed as UTF-8 JSON in License.payload. */
export interface LicenseClaims {
  tier: Tier;
  licensee: string; // email or org, informational
  fingerprint?: string; // device this seat is bound to; omit for a floating license
  seats?: number;
  issuedAt: string; // ISO
  expiresAt: string; // ISO
}

/** On-disk license file: the exact signed bytes + the detached signature. We sign
 *  the RAW payload string (not a re-serialized object) so there's zero JSON-
 *  canonicalization ambiguity between signer and verifier. */
export interface SignedLicense {
  payload: string; // JSON.stringify(LicenseClaims) — the exact bytes that were signed
  sig: string; // base64 Ed25519 signature over payload's UTF-8 bytes
}

export interface Entitlement {
  tier: Tier;
  licensed: boolean; // true only when a valid paid license is in force
  viaGrace: boolean; // true when running on the post-expiry offline-grace window
  licensee?: string;
  expiresAt?: string;
  reason: string; // human-readable why (for the cockpit / logs)
}

const FREE = (reason: string): Entitlement => ({ tier: 'free', licensed: false, viaGrace: false, reason });

// The issuer's Ed25519 PUBLIC key (SPKI PEM). This is SAFE to embed and ship —
// it can only VERIFY, never sign. Replace the placeholder with your real public
// key (see src/entitlement/README.md: `generate-keypair`). While it's the
// placeholder, no real license can validate, so everyone is simply 'free'.
export const LICENSE_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAGb9ECWmEzf6FQbrBZ9w7lshQhqowtrbLDFw4rXAxZuE
-----END PUBLIC KEY-----`;
// ↑ PLACEHOLDER (a throwaway public key). Swap for the real one before shipping paid tiers.

/** A stable, non-PII device id: hostname + platform + arch, hashed. Good enough
 *  to bind a seat to a machine without storing anything identifying. (A persisted
 *  random salt can be layered on later; kept deterministic here so it's testable.) */
export function deviceFingerprint(): string {
  const raw = `${hostname()}|${process.platform}|${process.arch}`;
  return createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

/** Verify a signed license's Ed25519 signature and return its claims, or null if
 *  the signature doesn't check out (tampered, wrong key, malformed). Pure crypto —
 *  no expiry/device logic here. */
export function verifyLicense(lic: SignedLicense, publicKeyPem = LICENSE_PUBLIC_KEY_PEM): LicenseClaims | null {
  try {
    const pub = createPublicKey(publicKeyPem);
    const ok = edVerify(null, Buffer.from(lic.payload, 'utf8'), pub, Buffer.from(lic.sig, 'base64'));
    if (!ok) return null;
    const claims = JSON.parse(lic.payload) as LicenseClaims;
    if (!claims || typeof claims.tier !== 'string' || !claims.expiresAt) return null;
    return claims;
  } catch {
    return null;
  }
}

/** Turn a (possibly absent/invalid) signed license into the effective entitlement.
 *  ALWAYS returns something; the failure cases all resolve to a fully-usable free
 *  tier. `now`/`fingerprint` are injectable for testing. */
export function evaluateEntitlement(
  license: SignedLicense | null | undefined,
  opts: { now?: number; fingerprint?: string; publicKeyPem?: string } = {},
): Entitlement {
  if (!license) return FREE('No license — running the free local tier.');
  const now = opts.now ?? Date.now();
  const fp = opts.fingerprint ?? deviceFingerprint();

  const claims = verifyLicense(license, opts.publicKeyPem);
  if (!claims) return FREE('License signature did not verify — running free.');
  if (!PAID_TIERS.includes(claims.tier)) return FREE('License is for the free tier.');

  // Seat binding: a device-bound license must match THIS machine. A license with
  // no fingerprint is floating (any device) — allowed.
  if (claims.fingerprint && claims.fingerprint !== fp) {
    return FREE('This license is registered to a different device — running free here.');
  }

  const exp = Date.parse(claims.expiresAt);
  if (!Number.isFinite(exp)) return FREE('License has no valid expiry — running free.');
  const graceEnd = exp + OFFLINE_GRACE_DAYS * 86400_000;

  if (now <= exp) {
    return { tier: claims.tier, licensed: true, viaGrace: false, licensee: claims.licensee, expiresAt: claims.expiresAt, reason: `Licensed: ${claims.tier}.` };
  }
  if (now <= graceEnd) {
    return { tier: claims.tier, licensed: true, viaGrace: true, licensee: claims.licensee, expiresAt: claims.expiresAt, reason: `License expired ${claims.expiresAt}; within the ${OFFLINE_GRACE_DAYS}-day offline grace — renew to keep ${claims.tier}.` };
  }
  return FREE(`License lapsed (expired ${claims.expiresAt}, past the ${OFFLINE_GRACE_DAYS}-day grace) — back to free.`);
}

/** Does the effective entitlement meet AT LEAST `required`? Used at each paid
 *  feature's gate. free features pass for everyone (required='free' → always true). */
export function hasTier(ent: Entitlement, required: Tier): boolean {
  return TIER_RANK[ent.tier] >= TIER_RANK[required];
}
