-- Accounts: a profile per auth user + the tier they're on. Auth is Supabase's
-- built-in (email + OAuth); these tables hang off auth.users.

-- One profile row per auth user, created automatically on signup.
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text,
  full_name  text,
  avatar_url text,
  created_at timestamptz not null default now()
);
alter table public.profiles enable row level security;
drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own" on public.profiles for select using (auth.uid() = id);
drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own" on public.profiles for update using (auth.uid() = id) with check (auth.uid() = id);

-- The tier a user is on. Written ONLY by the service role (a future Paddle/Keygen
-- webhook); users read only their own row. Defaults to free.
create table if not exists public.entitlements (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  tier       text not null default 'free' check (tier in ('free','connected','smart','pro')),
  status     text not null default 'active',
  expires_at timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.entitlements enable row level security;
drop policy if exists "entitlements_select_own" on public.entitlements;
create policy "entitlements_select_own" on public.entitlements for select using (auth.uid() = user_id);
-- no insert/update/delete policy → only the service_role (webhooks) can write.

-- Auto-create the profile (and a default free entitlement) when a user signs up.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name, avatar_url)
  values (new.id, new.email, new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'avatar_url')
  on conflict (id) do nothing;
  insert into public.entitlements (user_id, tier) values (new.id, 'free') on conflict (user_id) do nothing;
  return new;
end; $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- handle_new_user is a SECURITY DEFINER trigger function; it must NOT be callable
-- directly via PostgREST RPC (that would let anon insert arbitrary profiles /
-- entitlements). The trigger keeps firing on inserts without EXECUTE.
revoke execute on function public.handle_new_user() from anon, authenticated, public;
