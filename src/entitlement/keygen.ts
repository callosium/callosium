// Keygen.sh client — STUB.
//
// This is the interface the app will call to turn a license KEY the customer buys
// (via Paddle → Keygen) into a signed, device-bound license this app can verify
// offline (see license.ts). It is intentionally NOT wired to the network yet: no
// account id, no API host, no key is committed, and every method is a documented
// no-op that returns "not configured". So today the app is always free; flipping
// this on is a separate, credentialed, reviewed step.
//
// Real flow when wired:
//   activate(key)  → POST /accounts/<id>/licenses/<key>/actions/validate + create a
//                    machine (device fingerprint) → Keygen returns a cryptographic
//                    license file (Ed25519-signed by YOUR Keygen keypair). Save it
//                    with saveLicense(); from then on verification is fully offline.
//   validate(key)  → periodic online re-check (respecting the offline-grace window
//                    so a plane trip doesn't drop the user to free).
//   deactivate()   → release the machine seat so another device can claim it.

import type { SignedLicense } from './license.ts';
import { deviceFingerprint } from './license.ts';

export interface KeygenConfig {
  accountId: string;
  /** Keygen API base; defaults to the hosted service when wired. */
  apiBase?: string;
}

export interface ActivationResult {
  ok: boolean;
  license?: SignedLicense;
  error?: string;
}

/** Read Keygen config from the environment. Returns null until it's set, which is
 *  the signal to every method below to stay a no-op. Nothing is hardcoded. */
export function keygenConfig(): KeygenConfig | null {
  const accountId = process.env.CALLOSIUM_KEYGEN_ACCOUNT;
  if (!accountId) return null;
  return { accountId, apiBase: process.env.CALLOSIUM_KEYGEN_API ?? 'https://api.keygen.sh/v1' };
}

const NOT_CONFIGURED: ActivationResult = {
  ok: false,
  error: 'Licensing is not enabled in this build. The app is running the free local tier.',
};

/** Activate a purchased license key on THIS device. Stub: returns not-configured
 *  until CALLOSIUM_KEYGEN_ACCOUNT is set and the network call is implemented. */
export async function activate(_licenseKey: string): Promise<ActivationResult> {
  const cfg = keygenConfig();
  if (!cfg) return NOT_CONFIGURED;
  // TODO(wire): validate the key + create a machine bound to deviceFingerprint(),
  // then return the Ed25519-signed license file Keygen issues. Until then:
  void deviceFingerprint();
  return { ok: false, error: 'Keygen activation is not implemented in this build yet.' };
}

/** Re-validate the current license online (periodic). Stub: no-op. */
export async function validate(_licenseKey: string): Promise<ActivationResult> {
  const cfg = keygenConfig();
  if (!cfg) return NOT_CONFIGURED;
  return { ok: false, error: 'Keygen validation is not implemented in this build yet.' };
}

/** Release this device's seat. Stub: no-op. */
export async function deactivate(): Promise<{ ok: boolean; error?: string }> {
  const cfg = keygenConfig();
  if (!cfg) return { ok: false, error: NOT_CONFIGURED.error };
  return { ok: false, error: 'Keygen deactivation is not implemented in this build yet.' };
}
