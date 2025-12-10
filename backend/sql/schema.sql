-- ============================
-- 1) USERS TABLE
-- ============================
create table if not exists public.users (
  id text primary key,
  username text,
  coins bigint default 0,
  businesses jsonb default '{}'::jsonb,
  level int default 1,
  last_mine bigint default 0,
  referrals_count int default 0,
  referred_by text default null,
  subscribed boolean default true,
  created_at timestamptz default now()
);


-- ============================
-- 2) TRANSACTIONS TABLE
-- ============================
create table if not exists public.transactions (
  id bigserial primary key,
  user_id text not null,
  amount bigint not null,
  type text,
  note text,
  created_at timestamptz default now()
);


-- ============================
-- 3) BUSINESSES TABLE
-- ============================
create table if not exists public.businesses (
  business text primary key,
  total_coins_invested bigint default 0,
  unit_cost bigint default 1000
);


-- ============================
-- 4) REFERRAL FUNCTION
-- ============================
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
  select * into ref_row from public.users where id = referrer_id limit 1;
  if not found then
    return jsonb_build_object('success', false, 'error', 'inviter_not_found');
  end if;

  if ref_row.id = referred_id then
    return jsonb_build_object('success', false, 'error', 'self_referral');
  end if;

  select id, referred_by into self_row from public.users where id = referred_id for update;

  if not found then
    insert into public.users
      (id, username, coins, businesses, level, last_mine, referrals_count, referred_by, subscribed, created_at)
    values
      (referred_id, referred_username, 100, '{}'::jsonb, 1, 0, 0, ref_row.id, false, now());
    updated := true;
  else
    if self_row.referred_by is null or self_row.referred_by = ref_row.id then
      update public.users set referred_by = ref_row.id where id = referred_id;
      updated := true;
    else
      return jsonb_build_object('success', false, 'error', 'already_referred');
    end if;
  end if;

  if updated then
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


-- ============================
-- 5) PURCHASE BUSINESS FUNCTION
-- ============================
create or replace function public.purchase_business(
  p_business text,
  p_user_id text,
  p_qty int,
  p_unit_cost bigint
) returns jsonb
language plpgsql
security definer
as $$
declare
  usr record;
  cur_qty int := 0;
  total_cost bigint;
  new_coins bigint;
  new_businesses jsonb;
  total_qty bigint;
begin
  if p_qty is null or p_qty <= 0 then
    return jsonb_build_object('success', false, 'error', 'invalid_qty');
  end if;

  total_cost := p_unit_cost * p_qty;

  select * into usr from public.users where id = p_user_id for update;
  if not found then
    return jsonb_build_object('success', false, 'error', 'user_not_found');
  end if;

  if coalesce(usr.coins,0) < total_cost then
    return jsonb_build_object(
      'success', false,
      'error', 'insufficient_funds',
      'needed', total_cost,
      'have', coalesce(usr.coins,0)
    );
  end if;

  begin
    cur_qty := (usr.businesses ->> p_business)::int;
  exception when others then
    cur_qty := 0;
  end;
  if cur_qty is null then cur_qty := 0; end if;

  new_businesses := jsonb_set(
    coalesce(usr.businesses, '{}'::jsonb),
    array[p_business],
    to_jsonb(cur_qty + p_qty),
    true
  );

  new_coins := coalesce(usr.coins,0) - total_cost;

  update public.users
    set coins = new_coins,
        businesses = new_businesses
  where id = p_user_id;

  insert into public.businesses (business, total_coins_invested, unit_cost)
  values (p_business, 0, p_unit_cost)
  on conflict (business) do update
    set unit_cost = excluded.unit_cost;

  select coalesce(sum((u.businesses ->> p_business)::bigint),0)
    into total_qty
    from public.users u;

  update public.businesses
    set total_coins_invested = total_qty * p_unit_cost
  where business = p_business;

  insert into public.transactions (user_id, amount, type, note)
    values (p_user_id, total_cost, 'purchase',
      'Bought ' || p_qty || ' x ' || p_business || ' @' || p_unit_cost);

  return jsonb_build_object(
    'success', true,
    'coins', new_coins,
    'user_businesses', new_businesses,
    'total_invested', total_qty * p_unit_cost
  );
end;
$$;


-- ============================
-- 6) HELPER: RECOMPUTE ONE BUSINESS
-- ============================
create or replace function public.recompute_business_total(
  p_business text
) returns jsonb
language plpgsql
security definer
as $$
declare
  qty bigint;
  price bigint;
begin
  select coalesce(sum((u.businesses ->> p_business)::bigint),0)
    into qty
    from public.users u;

  select coalesce(unit_cost,1000)
    into price
    from public.businesses
    where business = p_business;

  if not found then
    insert into public.businesses (business, total_coins_invested, unit_cost)
    values (p_business, qty * 1000, 1000)
    on conflict do nothing;

    return jsonb_build_object(
      'success', true,
      'business', p_business,
      'total_qty', qty,
      'total_invested', qty * 1000
    );
  end if;

  update public.businesses
    set total_coins_invested = qty * price
    where business = p_business;

  return jsonb_build_object(
    'success', true,
    'business', p_business,
    'total_qty', qty,
    'total_invested', qty * price
  );
end;
$$;


-- ============================
-- 7) INDEXES
-- ============================
create index if not exists idx_users_coins_desc on public.users(coins desc);
create index if not exists idx_users_referrals_desc on public.users(referrals_count desc);
create index if not exists idx_businesses_total on public.businesses(total_coins_invested desc);
