// Auth scaffold battery — the deterministic parts (flag gating, authorize-URL,
// signed sessions). The OAuth token exchange is a documented stub, not tested.
import {
  authEnabled, configuredProviders, buildAuthorizeUrl, makeState,
  createSession, verifySession, handleOAuthCallback,
} from '../src/dashboard/auth.ts';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name); } };

// stable secret so create/verify agree
process.env.CALLOSIUM_SESSION_SECRET = 'test-secret-please-ignore';

// 1. Flag OFF by default → auth dormant, no providers, local account stays
delete process.env.CALLOSIUM_AUTH;
ok('auth disabled by default', authEnabled() === false && configuredProviders().length === 0);

// 2. Flag ON but no client ids → still no usable providers
process.env.CALLOSIUM_AUTH = '1';
delete process.env.CALLOSIUM_GOOGLE_CLIENT_ID;
delete process.env.CALLOSIUM_GITHUB_CLIENT_ID;
ok('enabled but unconfigured → no providers', authEnabled() === true && configuredProviders().length === 0);

// 3. Flag ON + a google client id → google is offered, authorize URL is well-formed
process.env.CALLOSIUM_GOOGLE_CLIENT_ID = 'test-google-client.apps.googleusercontent.com';
ok('configured provider appears', configuredProviders().includes('google'));
{
  const state = makeState();
  const url = buildAuthorizeUrl('google', 'http://localhost:4319/auth/callback', state);
  const u = new URL(url);
  ok('authorize URL points at Google', u.origin + u.pathname === 'https://accounts.google.com/o/oauth2/v2/auth');
  ok('authorize URL carries client_id/redirect/state', u.searchParams.get('client_id') === process.env.CALLOSIUM_GOOGLE_CLIENT_ID
    && u.searchParams.get('redirect_uri') === 'http://localhost:4319/auth/callback'
    && u.searchParams.get('state') === state
    && u.searchParams.get('response_type') === 'code');
}
// building an unconfigured provider's URL throws (no broken flow)
{
  let threw = false;
  try { buildAuthorizeUrl('github', 'http://localhost/cb', 'x'); } catch { threw = true; }
  ok('unconfigured provider authorize URL throws', threw);
}

// 4. Session round-trip
{
  const tok = createSession({ sub: 'google:123', email: 'a@b.com', name: 'Owner', provider: 'google' });
  const s = verifySession(tok);
  ok('valid session verifies', !!s && s.sub === 'google:123' && s.email === 'a@b.com');
}
// 5. Tampered session → null
{
  const tok = createSession({ sub: 'google:123', provider: 'google' });
  const [body, mac] = tok.split('.');
  const forgedBody = Buffer.from(JSON.stringify({ sub: 'google:999', provider: 'google', iat: Date.now(), exp: Date.now() + 1e9 })).toString('base64url');
  ok('tampered body → rejected', verifySession(`${forgedBody}.${mac}`) === null);
  ok('garbage token → rejected', verifySession('not-a-token') === null && verifySession(undefined) === null);
}
// 6. Expired session → null
{
  const past = Date.now() - 1000;
  const tok = createSession({ sub: 'google:123', provider: 'google' }, past - 30 * 86400_000 - 5000);
  ok('expired session → rejected', verifySession(tok, past + 1) === null);
}

// 7. OAuth callback with a state mismatch → rejected (CSRF guard). Needs a fully
// configured provider so the flow reaches the state check (not the config guard).
{
  process.env.CALLOSIUM_GOOGLE_CLIENT_SECRET = 'test-google-secret';
  const r = await handleOAuthCallback('google', 'somecode', 'state-A', 'state-B');
  ok('callback state mismatch rejected', r.ok === false && /state mismatch/i.test(r.error || ''));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
