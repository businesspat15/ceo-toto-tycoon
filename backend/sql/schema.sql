-- ==========================================
-- 1️⃣ Create users table (if not exists)
-- ==========================================
create table if not exists public.users (
  id text primary key,
  username text,
  coins bigint default 0,
  businesses jsonb default '{}'::jsonb,
  level int default 1,
  last_mine bigint default 0,
  referrals_count int default 0,
  referred_by text default null,
  subscribed boolean default false,
  created_at timestamptz default now()
);

-- Optional: grant insert/update/select to authenticated users
-- grant insert, update, select on public.users to authenticated;


-- ==========================================
-- 2️⃣ Drop old increment_referral_bonus function if exists
-- ==========================================
drop function if exists public.increment_referral_bonus(text);


-- ==========================================
-- 3️⃣ Create increment_referral_bonus function
-- ==========================================
create function public.increment_referral_bonus(ref_id text)
returns integer
language plpgsql
security definer
as $$
declare
  new_count integer := 0;
begin
  update public.users
  set referrals_count = coalesce(referrals_count, 0) + 1,
      coins = coalesce(coins, 0) + 100    -- award 100 coins to referrer (optional)
  where id = ref_id
  returning referrals_count into new_count;

  if new_count is null then
    -- user not found
    return 0;
  end if;

  return new_count;
end;
$$;

-- Optional: allow normal users to call this RPC
-- grant execute on function public.increment_referral_bonus(text) to authenticated;
