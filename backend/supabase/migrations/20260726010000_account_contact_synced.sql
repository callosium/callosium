-- Second idempotency marker for on-account-created: the marketing-list sync
-- (Resend contact + "Users" segment) is best-effort and separate from the
-- transactional welcome email, so it needs its OWN marker. Without it, welcomed_at
-- doubled as the retry gate and a transient contact-sync failure was made
-- permanent (the user was welcomed but silently never added to the segment, with
-- no way to re-attempt). With this column the function stamps contact_synced_at
-- only on a complete sync, so a failure stays queryable and re-attemptable.
--
-- Backfill / reconcile query (service role): users welcomed but not yet synced —
--   select id, email from public.profiles
--   where welcomed_at is not null and contact_synced_at is null;
-- Re-fire the hook for those (or add them to Resend directly) at any time.
alter table public.profiles
  add column if not exists contact_synced_at timestamptz;
