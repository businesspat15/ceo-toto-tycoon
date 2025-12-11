-- ============================================================================
-- CEO TOTO Tycoon - FULL CORRECTED SCHEMA & RPCs (exception handler fix)
-- Run this in Supabase SQL editor or psql (DB owner/admin).
-- ============================================================================
BEGIN;

-- 1) users table
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

-- 2) transactions table (audit)
create table if not exists public.transactions (
  id bigserial primary key,
  user_id text not null,
  amount bigint not null,
  type text,
  note text,
  created_at timestamptz default now()
);

-- 3) businesses table (global totals + unit price)
create table if not exists public.businesses (
  business text primary key,
  total_coins_invested bigint default 0,
  unit_price bigint default 1000
);

-- 4) Seed common business rows (won't overwrite existing)
insert into public.businesses (business, total_coins_invested, unit_price) values
('DAPP', 0, 1000),
('TOTO_VAULT', 0, 1000),
('CIFCI_STABLE', 0, 1000),
('TYPOGRAM', 0, 1000),
('APPLE', 0, 1000),
('BITCOIN', 0, 1000)
on conflict (business) do nothing;

-- 5) Indexes (idempotent)
create index if not exists idx_transactions_user_id on public.transactions(user_id);
create index if not exists idx_users_coins_desc on public.users(coins desc);

-- 6) Create foreign key constraint only if it doesn't exist (safe)
do $$
begin
  if not exists (
    select 1
    from information_schema.table_constraints
    where constraint_name = 'fk_transactions_user'
      and table_schema = 'public'
      and table_name = 'transactions'
  ) then
    alter table public.transactions
      add constraint fk_transactions_user
        foreign key (user_id) references public.users(id)
        on delete no action
        on update cascade;
  end if;
end
$$;

-- 7) referral_attempts logging table (debug + audit)
create table if not exists public.referral_attempts (
  id bigserial primary key,
  referrer_id text,
  referred_id text,
  referred_username text,
  created_at timestamptz default now(),
  success boolean,
  error_text text,
  details jsonb
);

-- ============================================================================
-- 8) manual_refer_by_id: race-safe, idempotent referral function (with logging)
-- NOTE: exception handler fixed (no PERFORM with UPDATE).
-- ============================================================================
create or replace function public.manual_refer_by_id(
  referrer_id text,
  referred_id text,
  referred_username text
) returns jsonb
language plpgsql
security definer
as $$
declare
  attempt_id bigint;
  ref_row record;
  self_row record;
  inserted_count int := 0;
  created boolean := false;
  awarded boolean := false;
  existing text;
begin
  -- Log attempt placeholder (success will be updated below)
  insert into public.referral_attempts (referrer_id, referred_id, referred_username, created_at, success)
    values (referrer_id, referred_id, referred_username, now(), null)
    returning id into attempt_id;

  -- Validate inviter exists
  select id, username into ref_row from public.users where id = referrer_id limit 1;
  if not found then
    update public.referral_attempts set success = false, error_text = 'inviter_not_found' where id = attempt_id;
    return jsonb_build_object('success', false, 'error', 'inviter_not_found');
  end if;

  -- Prevent self-referral
  if referrer_id = referred_id then
    update public.referral_attempts set success = false, error_text = 'self_referral' where id = attempt_id;
    return jsonb_build_object('success', false, 'error', 'self_referral');
  end if;

  -- Try to create the referred user if missing (idempotent)
  begin
    insert into public.users (
      id, username, coins, businesses, level, last_mine, referrals_count, referred_by, subscribed, created_at
    ) values (
      referred_id, referred_username, 100, '{}'::jsonb, 1, 0, 0, null, true, now()
    ) on conflict (id) do nothing;

    get diagnostics inserted_count = ROW_COUNT;
  exception when others then
    raise notice 'manual_refer_by_id: insert attempt failed: %', sqlerrm;
    inserted_count := 0;
  end;

  created := (inserted_count > 0);

  -- Lock the referred user's row and read referred_by
  select id, referred_by into self_row from public.users where id = referred_id for update;
  if not found then
    update public.referral_attempts set success = false, error_text = 'user_create_failed' where id = attempt_id;
    return jsonb_build_object('success', false, 'error', 'user_create_failed');
  end if;

  existing := coalesce(trim(self_row.referred_by), '');

  if existing <> '' then
    if existing = ref_row.id then
      -- Already referred by same inviter: idempotent success, no award
      update public.referral_attempts set success = true, details = jsonb_build_object('created', created, 'awarded', false) where id = attempt_id;
      return jsonb_build_object(
        'success', true,
        'inviter_id', ref_row.id,
        'inviter_username', ref_row.username,
        'created', created,
        'awarded', false
      );
    else
      -- Already referred by different inviter -> reject
      update public.referral_attempts set success = false, error_text = 'already_referred', details = jsonb_build_object('existing_referrer', existing) where id = attempt_id;
      return jsonb_build_object('success', false, 'error', 'already_referred');
    end if;
  end if;

  -- Not referred yet: set referred_by and award inviter
  update public.users set referred_by = ref_row.id where id = referred_id;

  update public.users
    set coins = coalesce(coins,0) + 100,
        referrals_count = coalesce(referrals_count,0) + 1
    where id = ref_row.id;

  insert into public.transactions (user_id, amount, type, note)
    values (ref_row.id, 100, 'refer', 'Referral bonus from ' || referred_id);

  awarded := true;

  -- Update attempt log as success
  update public.referral_attempts set success = true, details = jsonb_build_object('created', created, 'awarded', awarded) where id = attempt_id;

  return jsonb_build_object(
    'success', true,
    'inviter_id', ref_row.id,
    'inviter_username', ref_row.username,
    'created', created,
    'awarded', awarded
  );
exception
  when others then
    -- Update referral_attempts with error info (fixed: direct UPDATE statement)
    update public.referral_attempts
      set success = false,
          error_text = left(sqlerrm, 1000),
          details = jsonb_build_object('sqlstate', sqlstate)
      where id = attempt_id;
    return jsonb_build_object('success', false, 'error', 'internal_error', 'message', sqlerrm);
end;
$$;

-- ============================================================================
-- 9) purchase_business: atomic increment + RETURNING of the new total
-- ============================================================================
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
  biz_total bigint := 0;
  p_business_norm text;
begin
  -- validate inputs
  if p_qty is null or p_qty <= 0 then
    return jsonb_build_object('success', false, 'error', 'invalid_qty');
  end if;

  if p_unit_cost is null or p_unit_cost < 0 then
    return jsonb_build_object('success', false, 'error', 'invalid_price');
  end if;

  -- normalize business name (trim + upper)
  p_business_norm := upper(trim(coalesce(p_business, '')));
  if p_business_norm = '' then
    return jsonb_build_object('success', false, 'error', 'invalid_business');
  end if;

  total_cost := p_unit_cost * p_qty;

  -- lock user's row
  select * into usr from public.users where id = p_user_id for update;
  if not found then
    return jsonb_build_object('success', false, 'error', 'user_not_found');
  end if;

  if coalesce(usr.coins,0) < total_cost then
    return jsonb_build_object('success', false, 'error', 'insufficient_funds', 'needed', total_cost, 'have', coalesce(usr.coins,0));
  end if;

  -- compute current qty from JSON safely
  if usr.businesses is not null then
    begin
      cur_qty := (usr.businesses ->> p_business_norm)::int;
    exception when others then
      cur_qty := 0;
    end;
    if cur_qty is null then cur_qty := 0; end if;
  else
    cur_qty := 0;
  end if;

  -- update user's businesses JSON: set new qty = cur_qty + p_qty
  new_businesses := jsonb_set(coalesce(usr.businesses, '{}'::jsonb), array[p_business_norm], to_jsonb(cur_qty + p_qty), true);

  new_coins := coalesce(usr.coins,0) - total_cost;

  -- update users row with new coins and businesses
  update public.users
    set coins = new_coins,
        businesses = new_businesses
  where id = p_user_id;

  -- atomically insert-or-increment and RETURN the new total (single statement)
  insert into public.businesses (business, total_coins_invested)
    values (p_business_norm, total_cost)
  on conflict (business) do update
    set total_coins_invested = public.businesses.total_coins_invested + EXCLUDED.total_coins_invested
  returning total_coins_invested into biz_total;

  -- fallback select (shouldn't be needed)
  if biz_total is null then
    select total_coins_invested into biz_total from public.businesses where business = p_business_norm;
    biz_total := coalesce(biz_total, 0);
  end if;

  -- insert transaction record (audit)
  insert into public.transactions (user_id, amount, type, note)
    values (p_user_id, total_cost, 'purchase', 'Bought ' || p_qty || ' x ' || p_business_norm || ' @' || p_unit_cost);

  -- return fresh info
  return jsonb_build_object(
    'success', true,
    'coins', new_coins,
    'user_businesses', (select businesses from public.users where id = p_user_id),
    'total_invested', biz_total,
    'business', p_business_norm
  );
exception
  when others then
    return jsonb_build_object('success', false, 'error', 'internal_error', 'message', sqlerrm);
end;
$$;

COMMIT;

-- ============================================================================
-- Quick verification queries (run manually):
-- insert into public.users (id, username, coins, subscribed) values ('test_u1','tester',10000,true) on conflict (id) do nothing;
-- select public.purchase_business('APPLE','test_u1',2,1000);
-- select public.manual_refer_by_id('inv1','ref1','bob');
-- select * from public.referral_attempts order by created_at desc limit 20;
-- select * from public.businesses;
-- ============================================================================
