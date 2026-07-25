// Entitlement verification battery — proves the offline license logic, and above
// all that EVERY failure path resolves to the free tier (never gates the app).
import { generateKeyPairSync, sign as edSign } from 'node:crypto';
import { evaluateEntitlement, verifyLicense, OFFLINE_GRACE_DAYS, deviceFingerprint } from '../src/entitlement/license.ts';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name); } };

// A throwaway issuer keypair (stands in for Keygen's).
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

const DAY = 86400_000;
const now = Date.parse('2026-07-15T00:00:00.000Z');
const fp = deviceFingerprint();

// Sign a claims object into a SignedLicense with the issuer private key.
const issue = (claims) => {
  const payload = JSON.stringify(claims);
  const sig = edSign(null, Buffer.from(payload, 'utf8'), privateKey).toString('base64');
  return { payload, sig };
};
const ev = (lic, over = {}) => evaluateEntitlement(lic, { now, fingerprint: fp, publicKeyPem: pubPem, ...over });

// 1. No license → free
ok('no license → free', ev(null).tier === 'free' && !ev(null).licensed);

// 2. Valid pro license bound to this device → pro
const proClaims = { tier: 'pro', licensee: 'owner@example.com', fingerprint: fp, seats: 1, issuedAt: '2026-07-01T00:00:00Z', expiresAt: '2027-07-01T00:00:00Z' };
const proLic = issue(proClaims);
{
  const e = ev(proLic);
  ok('valid pro license → pro, licensed', e.tier === 'pro' && e.licensed && !e.viaGrace);
}

// 3. verifyLicense returns claims for a good sig, null for a tampered payload
ok('verifyLicense accepts a good signature', !!verifyLicense(proLic, pubPem));
{
  const tampered = { payload: proLic.payload.replace('"pro"', '"free"'), sig: proLic.sig };
  ok('tampered payload → verify fails → free', verifyLicense(tampered, pubPem) === null && ev(tampered).tier === 'free');
}

// 4. Wrong device fingerprint → free (seat is for another machine)
{
  const other = issue({ ...proClaims, fingerprint: 'someotherdevicefingerprint000000' });
  ok('wrong-device license → free', ev(other).tier === 'free');
}

// 5. Floating license (no fingerprint) → honored on any device
{
  const floating = issue({ ...proClaims, fingerprint: undefined });
  ok('floating (no fingerprint) license → honored', ev(floating).tier === 'pro');
}

// 6. Expired but within offline grace → still granted, viaGrace
{
  const expTs = now - 5 * DAY; // expired 5 days ago
  const graceLic = issue({ ...proClaims, expiresAt: new Date(expTs).toISOString() });
  const e = ev(graceLic);
  ok('expired within grace → tier held, viaGrace=true', e.tier === 'pro' && e.licensed && e.viaGrace);
}

// 7. Expired PAST the grace window → free
{
  const expTs = now - (OFFLINE_GRACE_DAYS + 2) * DAY;
  const lapsed = issue({ ...proClaims, expiresAt: new Date(expTs).toISOString() });
  ok('expired past grace → free', ev(lapsed).tier === 'free' && !ev(lapsed).licensed);
}

// 8. A license signed by a DIFFERENT key does not validate against our public key
{
  const { privateKey: evilKey } = generateKeyPairSync('ed25519');
  const payload = JSON.stringify(proClaims);
  const forged = { payload, sig: edSign(null, Buffer.from(payload, 'utf8'), evilKey).toString('base64') };
  ok('wrong-key signature → free', ev(forged).tier === 'free');
}

// 9. Placeholder public key (shipped default) validates nothing → everyone free
{
  const e = evaluateEntitlement(proLic, { now, fingerprint: fp }); // no publicKeyPem → uses embedded placeholder
  ok('against shipped placeholder key → free', e.tier === 'free');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
