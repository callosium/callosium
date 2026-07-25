# Callosium backend — deploy notes

> **Status (15 Jul 2026): DEPLOYED to the Callosium Supabase project**
> `https://kiimqsadfzwlgywskafq.supabase.co` (project ref `kiimqsadfzwlgywskafq`)
> via the Supabase MCP. The `waitlist` table + edge function, the `profiles` /
> `entitlements` accounts schema + signup trigger are live; the dashboard
> onboarding is wired to Supabase Auth (email + Google/Apple/GitHub). Publishable
> key (safe to embed) is in `src/dashboard/ui.html.base`. The `.sql` files here are
> the version-controlled source of the applied migrations. **Still needs you** —
> the one-time Auth-dashboard steps in §1d below (OAuth providers + redirect URLs).

The steps below reproduce the deploy from scratch (e.g. on a fresh project). No
project ref, key, or secret beyond the public publishable key is committed.

> Prereqs: a Supabase project and the Supabase CLI (`npm i -g supabase`,
> `supabase login`) — OR use the Supabase MCP as we did.

## 1. Waitlist

Captures landing-page emails into a locked-down `public.waitlist` table, written
only by an edge function running with the service role. The landing page never
holds any privileged key.

### a. Apply the table migration

```bash
cd backend
supabase link --project-ref <your-project-ref>     # one-time
supabase db push                                   # applies supabase/migrations/*
```

This creates `public.waitlist` (email, source, user_agent, created_at), a
case-insensitive unique index on email (dup-safe), and turns on RLS with **no**
policies — so the anon key can't read or write the table directly.

### b. Deploy the edge function

```bash
supabase functions deploy waitlist --no-verify-jwt   # supabase/functions/waitlist/
```

**`--no-verify-jwt` is required.** The waitlist is a PUBLIC endpoint — the landing
page posts an email with no auth. A plain `supabase functions deploy waitlist`
re-enables JWT verification and every signup then 401s. The flag is belt-and-
suspenders with `supabase/config.toml` (`[functions.waitlist] verify_jwt = false`),
which makes the exemption declarative and survive any redeploy.

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically for
deployed functions — you don't set them by hand. Optional: lock CORS to your site:

```bash
supabase secrets set WAITLIST_ALLOW_ORIGIN=https://your-landing-domain.com
```

The function URL will be:

```
https://<your-project-ref>.supabase.co/functions/v1/waitlist
```

### c. Wire the landing page

Include `waitlist-embed.js` and point it at that URL:

```html
<script>window.CALLOSIUM_WAITLIST_URL = 'https://<ref>.supabase.co/functions/v1/waitlist'</script>
<script src="/waitlist-embed.js"></script>

<form data-callosium-waitlist data-cw-source="landing">
  <input type="email" name="email" required placeholder="you@email.com">
  <button>Get early access</button>
  <p data-cw-message hidden></p>
</form>

<!-- founding-member CTA: add data-cw-plan="founding" so the signup is stored
     as 'founding' instead of 'free'. -->
<form data-callosium-waitlist data-cw-source="founding-cta" data-cw-plan="founding">
  <input type="email" name="email" required placeholder="you@email.com">
  <button>Claim founding-member price</button>
  <p data-cw-message hidden></p>
</form>
```

Or call it directly: `await callosiumJoinWaitlist(email, 'landing', 'founding')`
(third arg is the plan — omit or pass anything but `'founding'` for a free signup).

### d. Smoke test

```bash
curl -X POST https://<ref>.supabase.co/functions/v1/waitlist \
  -H 'content-type: application/json' \
  -d '{"email":"test@example.com","source":"smoke"}'
# → {"ok":true}   (a second identical call is also {"ok":true} — dup-safe no-op)
```

Read signups (from the SQL editor, service role):

```sql
select email, source, created_at from public.waitlist order by created_at desc;
```

### e. 16 Jul 2026 upgrade — plan column + rate limit (DEPLOYED 16 Jul, function v2)

The landing page POSTs `{ email, plan, source }` — `plan` is `'founding'` when
the visitor clicked the founding-member CTA, else `'free'`. Applied via the
Supabase MCP: migration `waitlist_plan` + function v2. Smoke-tested live:
founding stored as `founding`, duplicate → friendly 200, bad email → 400,
bogus plan value → stored as `'free'`; test rows deleted after.

What changed: `waitlist.plan` column (`'free'`/`'founding'`, default `'free'`,
existing rows backfilled `'free'`), the function validates and stores `plan`,
and abusive IPs get a 429 after 8 requests in 5 minutes (in-instance, resets on
cold start — a flood guard, not a fortress).

**17 Jul (function v7): rate-limiter + IP-header hardening deployed.** Expiry-first bucket eviction (a blunt clear handed flooders a fresh window per client), and the client IP is read from `cf-connecting-ip` then the LAST x-forwarded-for entry — the forgeable leftmost XFF / caller-supplied x-real-ip are no longer trusted. Verified live: valid signup 200, CORS reflect for real origins + refuse foreign, bad email 400.

**CORS locked 16 Jul (function v3):** the function now carries an in-code origin
allowlist — `callosium.com`, `www.callosium.com`, `callosium.vercel.app` — and
reflects the matching origin (the site answers on all three; a single pinned
value would have broken two of them). Foreign origins get refused. Verified via
preflight from all four cases + a live form submit from https://callosium.com.
`WAITLIST_ALLOW_ORIGIN` (comma-separated, or `*`) still overrides the default
if the domain set ever changes.

Read the split (SQL editor):

```sql
select plan, count(*) from public.waitlist group by plan;
```

## 2. Accounts + Auth (DEPLOYED — one dashboard step left)

The dashboard onboarding now uses **real Supabase Auth** (email/password + Google/
Apple/GitHub OAuth), client-side via `supabase-js`. The `profiles` + `entitlements`
tables and the `handle_new_user` trigger (auto-creates a profile + a free
entitlement on signup) are applied — see the two migration files here. RLS: a user
reads/updates only their own profile and reads only their own entitlement;
`entitlements` is service-role-write-only (for the future Paddle/Keygen webhook).

**Email signup works today.** OAuth needs a one-time setup you do in the Supabase
dashboard (I can't create Google/Apple/GitHub app credentials for you):

### a. Add the redirect URL (Auth → URL Configuration → Redirect URLs)
Add the dashboard origin(s), e.g. `http://localhost:4319` (dev) and your future
desktop/prod URL. Without this, an OAuth round-trip won't return the session.

### b. Enable providers (Auth → Providers)
For each of **Google / Apple / GitHub**: create an OAuth app in that provider's
console (Google Cloud Console, Apple Developer, GitHub → Developer settings →
OAuth Apps), set its redirect/callback to
`https://kiimqsadfzwlgywskafq.supabase.co/auth/v1/callback`, then paste the client
ID + secret into the Supabase provider. Until a provider is enabled, its button
shows a friendly "isn't enabled yet — use email" message (handled, no crash).

### c. (optional) Email confirmation
Supabase confirms emails by default (the signup shows "check your email"). To let
email signups sign in instantly, turn confirmation off in Auth → Providers →
Email, and/or configure custom SMTP for real delivery.

The older flag-gated scaffold in `src/dashboard/auth.ts` (server-side OAuth +
signed sessions) remains for a future server-mediated flow; the live onboarding
uses the client-side supabase-js path above.

## 3. Licensing / entitlement (later)

Offline license verification is scaffolded in `src/entitlement/` and **no-ops to
the free tier** when unlicensed — the free local app is never gated. Wiring it to
a real Keygen account (issuing Ed25519-signed licenses) is a separate, reviewed
step; see `src/entitlement/README.md`.
