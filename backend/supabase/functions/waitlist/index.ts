// Callosium waitlist edge function (Supabase / Deno).
//
// POST { email, plan?, source? } → inserts into public.waitlist, dup-safe. Runs
// server-side with the service role, so the landing page never needs (and never
// gets) any privileged key — it just POSTs an email to this URL.
//
// Deploy: `supabase functions deploy waitlist` (see backend/DEPLOY.md). The two
// env vars below are injected by Supabase automatically for deployed functions;
// nothing secret is hardcoded here.
//
// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Allowlist the sites that may call this (comma-separated; '*' allows all).
// The site answers on three origins (apex, www, the vercel.app alias), so the
// matching origin is reflected back rather than pinning a single value.
// WAITLIST_ALLOW_ORIGIN overrides the default — the list is public, not secret.
const ALLOW = ((Deno.env.get('WAITLIST_ALLOW_ORIGIN')?.trim() ||
  'https://callosium.com,https://www.callosium.com,https://callosium.vercel.app'))
  .split(',').map((s) => s.trim()).filter(Boolean);
// Guard: a secrets misconfig (e.g. set to whitespace) must fall back to the
// default list, never emit 'Access-Control-Allow-Origin: undefined' and
// silently break every browser signup.
function corsFor(req: Request): Record<string, string> {
  const origin = req.headers.get('origin') ?? '';
  const allowed = ALLOW.includes('*') ? '*' : (ALLOW.includes(origin) ? origin : ALLOW[0]);
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    'Vary': 'Origin',
  };
}
const json = (status: number, body: unknown, cors: Record<string, string>) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'content-type': 'application/json' } });

// Conservative email shape — good enough to reject typos/garbage without
// pretending to be an RFC validator (real validation is the confirmation email).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Per-IP rate limit: 8 requests / 5 minutes, in-instance. Resets on cold start,
// which is fine — this guards against dumb floods, not determined attackers
// (Supabase's own edge limits sit in front of us for those).
const RATE = new Map<string, number[]>();
const WINDOW_MS = 5 * 60_000;
function rateLimited(ip: string): boolean {
  const now = Date.now();
  const hits = (RATE.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  hits.push(now);
  RATE.set(ip, hits);
  // Memory guard: evict EXPIRED buckets first — clearing everything handed a
  // flooder a fresh window for every tracked client (16 Jul review). Only if
  // the map is somehow still oversized after expiry eviction (5000+ genuinely
  // active IPs in 5 minutes) does the blunt clear run.
  if (RATE.size > 5000) {
    for (const [k, v] of RATE) {
      if (!v.some((t) => now - t < WINDOW_MS)) RATE.delete(k);
    }
    if (RATE.size > 5000) RATE.clear();
  }
  return hits.length > 8;
}

// A browser request whose Origin is NOT on the allowlist is refused (unless the
// list is '*'). Requests with NO Origin header (curl, server-to-server) are not
// browser-CSRF vectors and pass. Previously a foreign origin was silently mapped
// to the first allowed origin and processed — so the row still got written and
// the doc's "foreign origins refused" was untrue (ChatGPT I04).
function originRefused(req: Request): boolean {
  if (ALLOW.includes('*')) return false;
  const origin = req.headers.get('origin');
  return !!origin && !ALLOW.includes(origin);
}

Deno.serve(async (req: Request) => {
  const cors = corsFor(req);
  if (originRefused(req)) return json(403, { error: 'Origin not allowed.' }, cors);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json(405, { error: 'POST only.' }, cors);

  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return json(400, { error: 'Expected a JSON body.' }, cors);
  }

  // Prefer the platform-set client IP; the LEFTMOST x-forwarded-for entry is
  // client-forgeable on stacks that preserve caller-supplied XFF, which would
  // hand a flooder a fresh bucket per spoofed value (16 Jul review).
  const ip = (req.headers.get('cf-connecting-ip') ??
    (req.headers.get('x-forwarded-for') ?? '').split(',').pop() ?? '').trim() || 'unknown';
  // cf-connecting-ip is platform-managed; the LAST x-forwarded-for entry is the
  // one appended by the closest proxy. x-real-ip was dropped from the chain:
  // gateways here don't strip a caller-supplied value, so trusting it first
  // handed a flooder a fresh bucket per spoofed header (17 Jul re-review).
  if (rateLimited(ip)) return json(429, { error: 'Too many attempts — try again in a few minutes.' }, cors);

  const email = typeof payload?.email === 'string' ? payload.email.trim().toLowerCase() : '';
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) {
    return json(400, { error: 'Please enter a valid email.' }, cors);
  }
  // Free-text tag, bounded so it can't be abused as a storage field.
  const source = typeof payload?.source === 'string' ? payload.source.slice(0, 64) : null;
  // founding-member intent: the launch-day revenue segment. Anything else is 'free'.
  const plan = payload?.plan === 'founding' ? 'founding' : 'free';
  const userAgent = (req.headers.get('user-agent') ?? '').slice(0, 256) || null;

  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceKey) return json(500, { error: 'Waitlist is not configured yet.' }, cors);

  const supabase = createClient(url, serviceKey, { auth: { persistSession: false } });

  // Dup-safe AND escalation-safe. This used to be one upsert with
  // ignoreDuplicates (ON CONFLICT DO NOTHING), which threw the second signup
  // away: someone who joined via the hero form on Monday and then clicked
  // "Claim founding-member price" on Wednesday was told "You're on the list"
  // while their row stayed plan='free'. The launch read (`select plan, count(*)
  // from public.waitlist group by plan`) then undercounted founding by exactly
  // the people who asked for it hardest — and we'd reported success for a write
  // that never happened, which is the one thing this product promises not to do.
  //
  // So: insert first, and on the unique-email conflict escalate the existing row
  // ONLY when the new signup is founding. Escalation is deliberately one-way — a
  // later free signup must never pull a founding row back down, which is why
  // simply flipping ignoreDuplicates to false (ON CONFLICT DO UPDATE SET every
  // column) would have been a worse bug than the one it fixed.
  const { error } = await supabase
    .from('waitlist')
    .insert({ email, source, plan, user_agent: userAgent });

  // 23505 = Postgres unique_violation on waitlist_email_unique: already on the list.
  if (error?.code === '23505') {
    if (plan === 'founding') {
      // Two statements instead of one ON CONFLICT DO UPDATE (which PostgREST
      // can't express — that would need an RPC, and therefore a migration that
      // has to land BEFORE this function or every signup 500s). Splitting it is
      // safe here because the update only ever runs for plan='founding', so no
      // interleaving of concurrent signups can produce a downgrade.
      // `neq` keeps a repeat founding click from rewriting a row that is already
      // founding. source and created_at are left alone on purpose: they are the
      // first-touch record of how this person found us, and the founding claim
      // is already carried by `plan`.
      const { error: escalateError } = await supabase
        .from('waitlist')
        .update({ plan: 'founding' })
        .eq('email', email)
        .neq('plan', 'founding');
      if (escalateError) {
        console.error('waitlist founding escalation failed:', escalateError.message);
        return json(500, { error: 'Could not save your spot right now — please try again.' }, cors);
      }
    }
    // A repeat FREE signup really is a friendly no-op — nothing to record.
  } else if (error) {
    // Never leak DB internals to the browser; log for the operator.
    console.error('waitlist insert failed:', error.message);
    return json(500, { error: 'Could not save your spot right now — please try again.' }, cors);
  }
  return json(200, { ok: true }, cors);
});
