-- Welcome email for real in-app account signups (distinct from the landing-page
-- waitlist welcome). When an account becomes CONFIRMED, fire a server-to-server
-- call to the on-account-created edge function, which sends the welcome via
-- Resend. Confirmed = OAuth users on insert (provider-verified), email/password
-- users when they click the confirm link (email_confirmed_at goes non-null).

-- Idempotency marker: the edge function stamps this and skips if already set.
alter table public.profiles
  add column if not exists welcomed_at timestamptz;

-- The trigger function. SECURITY DEFINER so it can read Vault; the whole body is
-- wrapped in an exception handler so a mail/network hiccup can NEVER roll back
-- account creation. pg_net's http_post is queued and dispatched after commit, so
-- by the time the edge function runs, the profiles row (from handle_new_user)
-- already exists.
create or replace function public.tg_on_auth_user_welcome()
returns trigger language plpgsql security definer set search_path to '' as $$
declare v_secret text;
begin
  begin
    select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'SIGNUP_HOOK_SECRET' limit 1;
    perform net.http_post(
      url := 'https://kiimqsadfzwlgywskafq.supabase.co/functions/v1/on-account-created',
      body := jsonb_build_object(
        'user_id', NEW.id,
        'email',   NEW.email,
        'name',    coalesce(NEW.raw_user_meta_data->>'full_name', NEW.raw_user_meta_data->>'name'),
        'provider', coalesce(NEW.raw_app_meta_data->>'provider', 'email')
      ),
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-signup-secret', coalesce(v_secret, '')),
      timeout_milliseconds := 8000
    );
  exception when others then
    -- a welcome-email hiccup must never break sign-up
    null;
  end;
  return NEW;
end $$;

revoke execute on function public.tg_on_auth_user_welcome() from anon, authenticated, public;

-- Fires on INSERT (WHEN the row is already confirmed → OAuth) and on the UPDATE
-- that sets email_confirmed_at (→ email/password confirm). `update of
-- email_confirmed_at` keeps ordinary auth.users updates (last_sign_in_at, etc.)
-- from re-firing; the edge function's welcomed_at guard is the belt to that
-- braces. OLD is deliberately NOT referenced (illegal in an INSERT WHEN clause).
drop trigger if exists on_auth_user_welcome on auth.users;
create trigger on_auth_user_welcome
  after insert or update of email_confirmed_at on auth.users
  for each row
  when (NEW.email_confirmed_at is not null)
  execute function public.tg_on_auth_user_welcome();
