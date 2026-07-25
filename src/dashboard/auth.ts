// Real auth scaffolding — OAuth (Google/GitHub) + signed sessions — behind a
// feature flag that ships OFF.
//
// Callosium is local-first: today "sign in" is a device-only record with no
// server (see the dummy signup in server.ts). This module is what a REAL hosted
// account will use — but it stays dormant until CALLOSIUM_AUTH=1 AND the provider
// secrets are set. With the flag off, authEnabled() is false and the dashboard
// keeps its local account exactly as-is. Nothing here is wired into the request
// loop yet; turning it on is a separate, credentialed, reviewed step.
//
// No client secrets are committed — they come from the environment at runtime.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** The master switch. Off unless CALLOSIUM_AUTH is 1/true. While off, the app
 *  uses the local device-only account and none of the OAuth paths run. */
export function authEnabled(): boolean {
  const v = (process.env.CALLOSIUM_AUTH ?? '').toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

export type Provider = 'google' | 'github';

interface ProviderSpec {
  authorizeUrl: string;
  tokenUrl: string;
  userUrl: string;
  scope: string;
  clientId?: string;
  clientSecret?: string;
}

/** Provider endpoints + credentials-from-env. clientId/clientSecret are undefined
 *  until set, which keeps the provider unusable (configuredProviders() hides it). */
export function providerSpec(p: Provider): ProviderSpec {
  if (p === 'google') {
    return {
      authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      userUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
      scope: 'openid email profile',
      clientId: process.env.CALLOSIUM_GOOGLE_CLIENT_ID,
      clientSecret: process.env.CALLOSIUM_GOOGLE_CLIENT_SECRET,
    };
  }
  return {
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    userUrl: 'https://api.github.com/user',
    scope: 'read:user user:email',
    clientId: process.env.CALLOSIUM_GITHUB_CLIENT_ID,
    clientSecret: process.env.CALLOSIUM_GITHUB_CLIENT_SECRET,
  };
}

/** Which providers are actually usable right now (flag on + client id present). */
export function configuredProviders(): Provider[] {
  if (!authEnabled()) return [];
  return (['google', 'github'] as Provider[]).filter((p) => !!providerSpec(p).clientId);
}

/** A random, URL-safe OAuth `state` (CSRF defense for the redirect round-trip).
 *  Store it in a short-lived cookie and require it to match on the callback. */
export function makeState(): string {
  return randomBytes(16).toString('base64url');
}

/** Build the provider's authorize URL to redirect the user to. Throws if the
 *  provider isn't configured, so a caller can't accidentally start a broken flow. */
export function buildAuthorizeUrl(p: Provider, redirectUri: string, state: string): string {
  const spec = providerSpec(p);
  if (!spec.clientId) throw new Error(`${p} OAuth is not configured (set CALLOSIUM_${p.toUpperCase()}_CLIENT_ID).`);
  const q = new URLSearchParams({
    client_id: spec.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: spec.scope,
    state,
  });
  return `${spec.authorizeUrl}?${q.toString()}`;
}

// ── sessions ──────────────────────────────────────────────────────────────
// A session is a signed, self-contained token: base64url(json).base64url(hmac).
// HMAC-SHA256 with a server secret from env — no session store needed, and a
// tampered token fails the signature check. Bounded lifetime via exp.

export interface Session {
  sub: string; // stable user id (provider:providerUserId)
  email?: string;
  name?: string;
  provider: Provider;
  iat: number; // issued-at (ms)
  exp: number; // expiry (ms)
}

const SESSION_TTL_MS = 30 * 86400_000; // 30 days

let _fallbackSecret: string | null = null;
function sessionSecret(): string {
  if (process.env.CALLOSIUM_SESSION_SECRET) return process.env.CALLOSIUM_SESSION_SECRET;
  // Must be set when auth is enabled. The fallback is generated ONCE per process
  // (cached) so create/verify agree within a run — but it's not persisted, so a
  // restart invalidates every session, which is the safe direction for dev.
  if (!_fallbackSecret) _fallbackSecret = randomBytes(32).toString('hex');
  return _fallbackSecret;
}

export function createSession(user: Omit<Session, 'iat' | 'exp'>, now = Date.now()): string {
  const session: Session = { ...user, iat: now, exp: now + SESSION_TTL_MS };
  const body = Buffer.from(JSON.stringify(session), 'utf8').toString('base64url');
  const mac = createHmac('sha256', sessionSecret()).update(body).digest('base64url');
  return `${body}.${mac}`;
}

/** Verify a session token: signature must check out (constant-time) and it must
 *  not be expired. Returns the Session or null — never throws on bad input. */
export function verifySession(token: string | undefined, now = Date.now()): Session | null {
  if (!token || token.indexOf('.') === -1) return null;
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const expected = createHmac('sha256', sessionSecret()).update(body).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const session = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Session;
    if (typeof session.exp !== 'number' || session.exp <= now) return null;
    return session;
  } catch {
    return null;
  }
}

/** Exchange an OAuth `code` for the provider's profile → a Session. STUB: the
 *  token-exchange + userinfo network calls are not implemented in this build. The
 *  state-match and provider-config guards ARE here so the flow is ready to fill in.
 *  Returns { ok:false } until wired; see src/entitlement/README-style notes above. */
export async function handleOAuthCallback(
  p: Provider,
  _code: string,
  stateFromQuery: string,
  stateFromCookie: string,
): Promise<{ ok: boolean; session?: string; error?: string }> {
  if (!authEnabled()) return { ok: false, error: 'Auth is disabled in this build.' };
  const spec = providerSpec(p);
  if (!spec.clientId || !spec.clientSecret) return { ok: false, error: `${p} OAuth is not configured.` };
  if (!stateFromQuery || stateFromQuery !== stateFromCookie) return { ok: false, error: 'OAuth state mismatch — request rejected.' };
  // TODO(wire): POST code → spec.tokenUrl (with client secret) → GET spec.userUrl →
  // createSession({ sub: `${p}:${id}`, email, name, provider: p }). Until then:
  return { ok: false, error: 'OAuth token exchange is not implemented in this build yet.' };
}
