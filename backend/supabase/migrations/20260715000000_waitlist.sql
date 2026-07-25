-- Callosium waitlist — capture emails from the landing page.
-- Applied with `supabase db push` (see backend/DEPLOY.md). No data, no secrets here.

create table if not exists public.waitlist (
  id         uuid primary key default gen_random_uuid(),
  email      text not null,
  -- where the signup came from: 'landing', 'launch-tweet', 'hn', … (free text tag)
  source     text,
  -- coarse context for follow-up, never anything identifying beyond the email
  user_agent text,
  created_at timestamptz not null default now()
);

-- Dup-safe: one row per email. The edge function always lowercases the email
-- before insert, so a plain UNIQUE constraint gives case-insensitive uniqueness in
-- practice AND is a valid ON CONFLICT target for the upsert (an expression index on
-- lower(email) is not addressable via PostgREST's on_conflict=email).
-- Idempotent: reruns of this migration (fresh-project replays, supabase db
-- push retries) must not fail on an existing constraint.
do $$ begin
  alter table public.waitlist add constraint waitlist_email_unique unique (email);
exception when duplicate_table or duplicate_object then null;
end $$;

-- Fast "how many signed up / when" without scanning.
create index if not exists waitlist_created_at_idx
  on public.waitlist (created_at desc);

-- Lock the table down. RLS ON with NO policies means the anon/auth roles can do
-- nothing directly — only the service_role (used exclusively by the edge function,
-- server-side) can write. The landing page never talks to this table directly, so
-- the anon key can't be used to read the email list or spam rows.
alter table public.waitlist enable row level security;

comment on table public.waitlist is 'Landing-page waitlist signups. Written only by the waitlist edge function via the service role; RLS denies all direct anon/auth access.';
