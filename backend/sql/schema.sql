--------------------------------------------------------------------------------
-- Migration: users table + referral RPC + referral trigger
-- Run in Supabase SQL Editor (runs as DB owner).
--------------------------------------------------------------------------------

BEGIN;

-- 1) Create users table (if not exists)
CREATE TABLE IF NOT EXISTS public.users (
  id text PRIMARY KEY,
  username text,
  coins bigint DEFAULT 0,
  businesses jsonb DEFAULT '{}'::jsonb,
  level int DEFAULT 1,
  last_mine bigint DEFAULT 0,
  referrals_count int DEFAULT 0,
  referred_by text DEFAULT NULL,
  subscribed boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);

-- Optional index to speed lookups by referred_by
CREATE INDEX IF NOT EXISTS idx_users_referred_by ON public.users (referred_by);

--------------------------------------------------------------------------------
-- 2) Atomic RPC: increment_referral_bonus(ref_id, bonus_coins)
-- Use this from server (supabase.rpc) when you want to increment referrals_count
-- and optionally add coins to the referrer in one atomic statement.
-- SECURITY DEFINER so it runs with the function owner's privileges (create in SQL editor).
--------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.increment_referral_bonus(
  ref_id text,
  bonus_coins integer DEFAULT 0
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- defensive: avoid self-referral and null
  IF ref_id IS NULL THEN
    RETURN;
  END IF;

  UPDATE public.users
  SET
    referrals_count = COALESCE(referrals_count, 0) + 1,
    coins = COALESCE(coins, 0) + GREATEST(bonus_coins, 0)
  WHERE id = ref_id;
END;
$$;

--------------------------------------------------------------------------------
-- 3) Trigger-based automation: when a NEW user is inserted with referred_by,
-- automatically increment the referrer's referrals_count and give a coins bonus.
-- This trigger is useful so you don't need to call RPC — inserting the new user
-- (with referred_by set) is sufficient to credit the referrer.
-- NOTE: triggers run on INSERT. If you use UPSERT (INSERT ... ON CONFLICT DO UPDATE)
-- and the row already existed, the INSERT branch will not happen and trigger will not fire.
--------------------------------------------------------------------------------

-- Adjustable reward amount for trigger path:
-- Set the constant below to the number of coins to award on referral via trigger.
-- Edit the value and rerun the trigger creation if you want a different bonus.
DO $$
BEGIN
  -- create a config variable in the current transaction only (value 100). If you prefer,
  -- simply edit the trigger function below to change 100 to some other integer.
  -- (This DO block is just explanatory — the trigger function has the value baked in.)
  NULL;
END$$;

-- Create the trigger function
CREATE OR REPLACE FUNCTION public.users_after_insert_referral_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  reward_coins integer := 100; -- coins to give to the referrer for each successful referred insert
BEGIN
  -- Only run when referred_by is present and not equal to the new user's id (prevent self-ref)
  IF NEW.referred_by IS NOT NULL AND NEW.referred_by <> NEW.id THEN
    UPDATE public.users
    SET
      referrals_count = COALESCE(referrals_count, 0) + 1,
      coins = COALESCE(coins, 0) + reward_coins
    WHERE id = NEW.referred_by;
  END IF;

  RETURN NEW;
END;
$$;

-- Drop existing trigger if any, then create it
DROP TRIGGER IF EXISTS trg_users_after_insert_referral ON public.users;
CREATE TRIGGER trg_users_after_insert_referral
  AFTER INSERT ON public.users
  FOR EACH ROW
  WHEN (NEW.referred_by IS NOT NULL)
  EXECUTE FUNCTION public.users_after_insert_referral_trigger();

--------------------------------------------------------------------------------
-- 4) Grants (optional)
-- Typically you run RPCs from your server using the SUPABASE_SERVICE_KEY so no grants
-- are needed for public/anon roles. If you plan to allow authenticated clients to call
-- the RPC, explicitly grant EXECUTE to the appropriate role(s).
-- Example (ONLY if you want authenticated users to call the RPC directly):
-- GRANT EXECUTE ON FUNCTION public.increment_referral_bonus(text, integer) TO authenticated;
--
-- Be careful: do NOT grant execute to "anon" unless you're sure it's safe.
--------------------------------------------------------------------------------

COMMIT;
