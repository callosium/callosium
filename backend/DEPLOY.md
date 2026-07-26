# Callosium backend — deploy notes

> **Status (26 Jul 2026): DEPLOYED to the Callosium Supabase project**
> `https://kiimqsadfzwlgywskafq.supabase.co` (project ref `kiimqsadfzwlgywskafq`)
> via the Supabase MCP. Live: the `waitlist` table + edge function, the `profiles`
> / `entitlements` accounts schema + signup trigger, the dashboard onboarding wired
> to Supabase Auth (email + **Google + GitHub enabled and verified live**; Apple
> deferred — needs a paid Apple dev account), the waitlist welcome-email pipeline
> (`on-signup` + `unsubscribe` functions, Resend), and the **account welcome email**
> for real in-app signups (`on-account-created` function + `on_auth_user_welcome`
> trigger — §4). Publishable key (safe to embed) is in `src/dashboard/ui.html.base`.
> The `.sql` files here are the version-controlled source of the applied migrations.
>
> **Repo/live drift to reconcile:** the deployed `on-signup` and `unsubscribe`
> edge functions were built via the MCP and are NOT yet checked into
> `supabase/functions/`. Back-fill them from the live source so the repo stays the
> single source of truth (`on-account-created` IS committed).

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
#
# NOTE: "no-op" is only true when the plan is unchanged. A repeat signup that
# claims plan:"founding" UPGRADES the existing row — it is not ignored. That is
# deliberate: the same person very often joins from the hero form first and
# clicks the founding CTA days later, and the old ON CONFLICT DO NOTHING threw
# that claim away while still telling them they were on the list.
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

`plan` escalates one way only: `free → founding`, never back. So this count is
"people who have ever claimed founding", which is what you want on launch day.
`source` keeps FIRST-touch attribution and is not overwritten by a later signup —
so `select source, count(*) ... where plan='founding'` tells you where those people
originally arrived from, NOT which CTA produced the founding claim. If you need the
latter, add a separate column; don't read it out of `source`.

## 2. Accounts + Auth (DEPLOYED — Google + GitHub live)

The dashboard onboarding uses **real Supabase Auth** (email/password + Google/GitHub
OAuth), client-side via `supabase-js`. The `profiles` + `entitlements` tables and the
`handle_new_user` trigger (auto-creates a profile + a free entitlement on signup) are
applied — see the migration files here. RLS: a user reads/updates only their own
profile and reads only their own entitlement; `entitlements` is service-role-write-only
(for the future Paddle/Keygen webhook).

**A first-time in-app signup writes three places:** `auth.users` (Supabase's own
identity row) → the `on_auth_user_created` trigger creates `public.profiles` (name,
email, avatar) and `public.entitlements` (`tier='free'`). The app also mirrors a
local `~/.callosium/account.json` cache for the signed-in UI; Supabase is the source
of truth. **Subscription level = `entitlements.tier`** (`free`/`connected`/`smart`/
`pro`), flipped only by a service-role webhook (future Paddle/Keygen); nothing in the
app can self-escalate a tier.

**Done (24–26 Jul):** Google + GitHub OAuth apps created under the `callosium.com`
company Google Cloud project + GitHub, both **enabled and verified live** on Supabase
(`email ON, google ON, github ON`), Google **published to production**. Redirect
allow-list includes `http://localhost:4319` (CLI serve) and `http://127.0.0.1:*`
(desktop random ports). Apple is deferred (needs a paid Apple Developer account).
Provider callback for all providers: `https://kiimqsadfzwlgywskafq.supabase.co/auth/v1/callback`.

### Email confirmation + delivery
Supabase confirms emails by default (email/password signup shows "check your email").
For reliable delivery beyond Supabase's low built-in SMTP limits, point Auth → Emails →
SMTP at Resend (domain `callosium.com` is already verified in Resend). OAuth signups are
provider-verified and need no confirmation step.

The older flag-gated scaffold in `src/dashboard/auth.ts` (server-side OAuth +
signed sessions) remains for a future server-mediated flow; the live onboarding
uses the client-side supabase-js path above.

## 3. Welcome emails (Resend)

Two separate welcomes, both via Resend from the verified `callosium.com` domain:

- **Waitlist welcome** — someone joins from the landing page → `public.waitlist`
  insert → `trg_waitlist_signup` trigger → `on-signup` edge function → "you're in,
  here's what happens on Aug 4" email + Resend contact + owner alert. Has a signed
  one-click unsubscribe (`unsubscribe` function). Marketing email. **Live.**
- **Account welcome** — someone creates a real account in the app → `auth.users`
  becomes confirmed → `on_auth_user_welcome` trigger (via pg_net, exception-wrapped
  so it can never block signup) → `on-account-created` edge function → "you're set,
  connect your first AI" email from `abdo@callosium.com`. Transactional (no unsub by
  design). The same function ALSO syncs the user into Resend as a contact and adds
  them to the **"Users" segment** (id `b0d57586-…`) — a marketing list of actual
  customers, kept separate from the pre-launch "Waitlist" segment, so later product
  broadcasts can target real users (broadcasts carry the unsubscribe link).
  **Reliability (hardened 26 Jul after an adversarial review):** the welcome send
  retries on 429/5xx/network (a Resend Idempotency-Key makes retries dedupe-safe)
  and is stamped to `profiles.welcomed_at` the instant it succeeds; the marketing
  sync is best-effort and stamped to its OWN marker `profiles.contact_synced_at`
  only on a complete success, so a transient sync failure never blocks the welcome
  and stays reconcilable. Backfill the (rare) missed syncs any time:
  `select id, email from public.profiles where welcomed_at is not null and contact_synced_at is null;`
  **Live (deployed 26 Jul, function v3); source is `supabase/functions/on-account-created/`
  + migrations `20260726000000_account_welcome.sql` and `20260726010000_account_contact_synced.sql`.**

Both hooks authenticate with the `SIGNUP_HOOK_SECRET` Vault secret via an
`x-signup-secret` header; the Resend API key is read from Vault (`get_resend_key`),
never committed. To test the account welcome safely, sign up in the app with a real
inbox you control and confirm — the email arrives once.

## 4. Licensing / entitlement (later)

## 3. Licensing / entitlement (later)

Offline license verification is scaffolded in `src/entitlement/` and **no-ops to
the free tier** when unlicensed — the free local app is never gated. Wiring it to
a real Keygen account (issuing Ed25519-signed licenses) is a separate, reviewed
step; see `src/entitlement/README.md`.
