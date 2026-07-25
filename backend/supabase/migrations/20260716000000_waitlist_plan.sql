-- Waitlist: distinguish founding-member intent from free signups (the landing
-- page's two CTAs now send plan + source). Backfills existing rows as 'free'.
alter table public.waitlist
  add column if not exists plan text not null default 'free'
    check (plan in ('free', 'founding'));

-- source ('hero' / 'footer' / 'pricing' / campaign tags) already exists from the
-- initial migration; nothing else changes. RLS stays deny-all — only the edge
-- function's service role writes.
