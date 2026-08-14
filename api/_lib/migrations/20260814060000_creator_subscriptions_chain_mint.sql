-- creator_subscriptions: carry the chain and mint a renewal must be billed on.
--
-- chargeSubscription() in api/_lib/subscription-billing.js has always selected
-- cs.chain and cs.currency_mint. `chain` picks the creator's payout wallet for
-- that chain (the join onto agent_payout_wallets.chain) and sets the renewal
-- intent's cluster; `currency_mint` is the mint the intent is denominated in.
-- Neither column was ever created by schema.sql or any migration.
--
-- The effect was total and silent: every due renewal threw "column cs.chain
-- does not exist". /api/cron/process-subscriptions catches per row, so it kept
-- answering HTTP 200 with processed > 0 and charged = 0 while no subscription
-- on the platform ever renewed, and POST /api/subscriptions 500ed after having
-- already written its creator_subscriptions row.
--
-- Solana is the home chain, so `chain` defaults to 'solana'. That also matches
-- the on-chain checkout path, which writes payment_method = 'solana'.
-- `currency_mint` stays nullable: a real mint is only known where a checkout
-- produced one, and chargeSubscription already falls back when it is absent.
-- Existing rows are backfilled from the confirmed subscription_checkouts row
-- that activated them, newest first, so the value is real data rather than a
-- guess.
--
-- Apply: node scripts/apply-migrations.mjs --apply --file 20260814060000_creator_subscriptions_chain_mint.sql
-- Idempotent.

begin;

alter table creator_subscriptions
    add column if not exists chain         text not null default 'solana',
    add column if not exists currency_mint text;

update creator_subscriptions cs
set currency_mint = latest.currency_mint,
    chain         = latest.chain
from (
    select distinct on (user_id, plan_id)
           user_id, plan_id, currency_mint, chain
    from subscription_checkouts
    where status = 'confirmed'
    order by user_id, plan_id, confirmed_at desc nulls last, created_at desc
) latest
where latest.plan_id = cs.plan_id
  and latest.user_id = cs.subscriber_user_id
  and cs.currency_mint is null;

commit;
