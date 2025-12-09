-- 1) Users table (create if not exists) - matches your earlier schema
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

-- 2) Transactions table (to record referral bonuses)
create table if not exists public.transactions (
  id bigserial primary key,
  user_id text not null,
  amount bigint not null,
  type text,
  note text,
  created_at timestamptz default now()
);

-- 3) Atomic referral function for "ref_<INVITER_ID>" deep links.
--    CALL: SELECT manual_refer_by_id(referrer_id := '12345', referred_id := '67890', referred_username := 'tg_user')
-- Returns a jsonb: { success: true/false, inviter_id: ..., inviter_username: ..., error: 'code' }
create or replace function public.manual_refer_by_id(
  referrer_id text,
  referred_id text,
  referred_username text
) returns jsonb
language plpgsql
security definer
as $$
declare
  ref_row record;
  self_row record;
  updated boolean := false;
begin
  -- find inviter by id
  select * into ref_row from public.users where id = referrer_id limit 1;
  if not found then
    return jsonb_build_object('success', false, 'error', 'inviter_not_found');
  end if;

  -- prevent self-referral
  if ref_row.id = referred_id then
    return jsonb_build_object('success', false, 'error', 'self_referral');
  end if;

  -- lock referred user's row (if exists)
  select id, referred_by into self_row from public.users where id = referred_id for update;

  if not found then
    -- create referred user and attach referred_by
    insert into public.users
      (id, username, coins, businesses, level, last_mine, referrals_count, referred_by, subscribed, created_at)
    values
      (referred_id, referred_username, 100, '{}'::jsonb, 1, 0, 0, ref_row.id, false, now());
    updated := true;
  else
    -- if user exists and hasn't been referred (or already referred to same referrer), set referred_by
    if self_row.referred_by is null or self_row.referred_by = ref_row.id then
      update public.users set referred_by = ref_row.id where id = referred_id;
      updated := true;
    else
      return jsonb_build_object('success', false, 'error', 'already_referred');
    end if;
  end if;

  if updated then
    -- reward inviter
    update public.users
      set coins = coins + 100,
          referrals_count = coalesce(referrals_count,0) + 1
      where id = ref_row.id;

    insert into public.transactions (user_id, amount, type, note)
      values (ref_row.id, 100, 'refer', 'Referral bonus from ' || referred_id);

    return jsonb_build_object('success', true, 'inviter_id', ref_row.id, 'inviter_username', ref_row.username);
  end if;

  return jsonb_build_object('success', false, 'error', 'unknown');
end;
$$;

-- Optional: index to speed up leaderboard sorting
create index if not exists idx_users_coins_desc on public.users(coins desc);
