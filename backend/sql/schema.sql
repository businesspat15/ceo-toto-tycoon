-- merged schema.sql for CEO TOTO Tycoon (text user ids for compatibility)

-- users table (id as text for cross-platform compatibility)
create table if not exists public.users (
  id text primary key,
  username text,
  coins bigint default 0,
  businesses_json jsonb default '{}'::jsonb,
  level int default 1,
  experience bigint default 0,
  referred_by text null,
  referrals_count int default 0,
  last_mine timestamptz null,
  subscribed boolean default false,
  created_at timestamptz default now()
);

-- transactions for auditability
create table if not exists public.transactions (
  id bigserial primary key,
  user_id text not null references public.users(id) on delete cascade,
  amount bigint not null,
  type text,
  note text,
  created_at timestamptz default now()
);

-- referrals table to prevent duplicate rewards
create table if not exists public.referrals (
  id uuid default gen_random_uuid() primary key,
  referrer_id text not null,
  referred_id text not null,
  created_at timestamptz default now(),
  unique (referrer_id, referred_id)
);

-- ranks table for level calculation
create table if not exists public.ranks (
  level int primary key,
  required_coins bigint not null
);

insert into public.ranks (level, required_coins) values
(1, 0),
(2, 1000),
(3, 10000),
(4, 100000),
(5, 700000)
on conflict (level) do nothing;

-- atomic function: record_and_reward_referral(referrer, referred) -> returns int (new referrals_count or -1 if referrer missing)
create or replace function public.record_and_reward_referral(p_referrer text, p_referred text)
returns int language plpgsql as $$
declare
  new_count int := 0;
  inserted boolean := false;
begin
  -- Try to insert referral row; if already exists, do nothing
  begin
    insert into public.referrals (referrer_id, referred_id)
    values (p_referrer, p_referred);
    inserted := true;
  exception when unique_violation then
    inserted := false;
  end;

  if inserted then
    update public.users
      set referrals_count = coalesce(referrals_count,0) + 1,
          coins = coalesce(coins,0) + 100
    where id = p_referrer;
    -- record a transaction for audit
    insert into public.transactions (user_id, amount, type, note) values (p_referrer, 100, 'refer', concat('Referral reward for referred ', p_referred));
  end if;

  select referrals_count into new_count from public.users where id = p_referrer;
  if new_count is null then
    return -1;
  end if;
  return new_count;
end;
$$;

-- optional shim RPC for legacy usage: increment_referral_bonus(ref_id) that returns new count
create or replace function public.increment_referral_bonus(ref_id text)
returns int language plpgsql as $$
declare
  rc int := 0;
begin
  update public.users set referrals_count = coalesce(referrals_count,0) + 1, coins = coalesce(coins,0) + 100 where id = ref_id;
  select referrals_count into rc from public.users where id = ref_id;
  if rc is null then return -1; end if;
  return rc;
end;
$$;
