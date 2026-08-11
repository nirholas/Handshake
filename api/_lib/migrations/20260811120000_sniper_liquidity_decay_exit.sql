-- Migration: allow the 'liquidity_decay' and 'take_initials' sniper exit reasons.
-- Apply: psql "$DATABASE_URL" -f api/_lib/migrations/20260811120000_sniper_liquidity_decay_exit.sql
-- Idempotent.
--
-- Both reasons are produced by the running worker but were never added to the
-- CHECK, so every exit that used them was rejected by the database AFTER its
-- sell had already landed on-chain. The failure was silent and self-repeating:
--
--   1. positions.js sees a dead market and calls executeSell with
--      reason='liquidity_decay'. The sell broadcasts and confirms; the tokens
--      are gone and the SOL is in the wallet.
--   2. The close UPDATE in executor.js violates this CHECK and throws.
--   3. The catch treats any sell failure as retryable and resets the row to
--      status='open', which is correct for a sell that never landed and wrong
--      for one that did.
--   4. The next sweep finds an on-chain balance of 0, routes to
--      reconcileVanishedBag, and that UPDATE carries the same rejected reason.
--      It logs 'reconcile failed, will retry next sweep' and loops forever.
--
-- The position never books its realized P&L and never releases its concurrency
-- slot. Production evidence before this migration: agent_sniper_positions held
-- zero rows with exit_reason='liquidity_decay' despite the worker logging
-- 'liquidity decay exit' on nearly every sweep.
--
-- 'take_initials' reaches the same UPDATE through a narrower door. It is
-- normally a partial sell that returns before the close, but executeSell
-- degrades a fraction that rounds to zero base units into a full exit, and that
-- path books the position closed under the take-initials reason.
--
-- Widens the agent_sniper_positions.exit_reason CHECK. Existing rows are
-- unaffected: this only adds accepted values.

begin;

alter table agent_sniper_positions
    drop constraint if exists agent_sniper_positions_exit_reason_check;

alter table agent_sniper_positions
    add constraint agent_sniper_positions_exit_reason_check
    check (exit_reason in
        ('take_profit','stop_loss','trailing_stop','timeout',
         'manual','kill_switch','graduated','error','signal_flip',
         'liquidity_decay','take_initials'));

commit;
