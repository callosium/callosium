# Entitlement (offline licensing)

The paid tiers are enforced by **offline Ed25519 license verification**. There is
no license server to phone home to at runtime: the app ships the issuer's *public*
key and checks a signed license file locally. This is the standard way to gate a
local-first desktop app without holding users hostage to your uptime.

## The one rule

**The free tier is never gated.** Every failure path — no license, bad signature,
wrong device, expired, tampered — resolves to `tier: 'free'`, which is the whole
local product. A license can only *raise* the tier. See the top of `license.ts`.

## Tiers

`free` → `connected` → `smart` → `pro` (ranked; a `pro` license satisfies any
lower gate). Gate a paid feature with:

```ts
import { loadEntitlement, hasTier } from './entitlement/index.ts';
const ent = await loadEntitlement();
if (hasTier(ent, 'connected')) { /* multi-device sync … */ }
```

## How verification works

1. The customer buys via Paddle (merchant of record). Paddle → Keygen issues a
   **license key**.
2. On activation the app calls Keygen (`keygen.ts`), which binds the key to this
   device's fingerprint and returns a **cryptographic license file**: a small JSON
   claims payload (`tier`, `licensee`, `fingerprint`, `expiresAt`, …) plus an
   Ed25519 signature made with *your* Keygen private key.
3. That file is saved to `~/.callosium/license.json`. From then on, `license.ts`
   verifies the signature against the embedded public key — fully offline.
4. `expiresAt` bounds it; a **21-day offline grace** (`OFFLINE_GRACE_DAYS`) past
   expiry keeps it working through renewals and no-connectivity stretches, then it
   falls back to free.

## Wiring it (later — reviewed, credentialed step)

1. **Generate the issuer keypair** (do this in Keygen, or locally to import):
   ```bash
   # Ed25519 keypair; keep the PRIVATE key secret (Keygen holds it), ship the PUBLIC one.
   openssl genpkey -algorithm ed25519 -out license-private.pem
   openssl pkey -in license-private.pem -pubout -out license-public.pem
   ```
   Paste `license-public.pem`'s contents into `LICENSE_PUBLIC_KEY_PEM` in
   `license.ts`, replacing the placeholder. (While it's the placeholder, no real
   license validates — everyone is free, which is safe.)
2. **Set Keygen config** at runtime (never commit it):
   `CALLOSIUM_KEYGEN_ACCOUNT=<account-id>` (and optionally `CALLOSIUM_KEYGEN_API`).
3. **Implement the network calls** in `keygen.ts` (currently no-op stubs) against
   the Keygen API: validate key → create machine (deviceFingerprint) → store the
   returned signed license via `saveLicense()`.

Nothing above is deployed or credentialed yet — this folder is scaffolding that
compiles, is tested (`test/e2e-entitlement.mjs`), and no-ops to free.
