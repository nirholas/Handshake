-- Migration: add the "oracle_crossing" trigger to the sniper.
-- Apply: psql "$DATABASE_URL" -f api/_lib/migrations/20260723060000_sniper_oracle_crossing.sql
-- Idempotent.
--
-- Motivation (measured, 2026-07-23, fleet window Jul 20-23): coins whose Oracle
-- conviction crossed 50 went on to pump or graduate 77.5% of the time (55 of 71
-- labeled) vs an 11.8% base rate, yet the fleet bought zero of the 110 qualifying
-- coins: the two conviction-gated arms had bars at 35 (below the band) and 65
-- (above the highest score ever observed, 61). The crossing happens at a median
-- of 2 minutes after launch and the median capturable upside from the crossing
-- candle is 1.23x, with 35% of crossings reaching >=1.5x.
--
--   trigger = 'oracle_crossing' — the sniper buys when a coin FIRST crosses the
--   strategy's min_oracle_score (default 50), driven by a poll on
--   oracle_conviction rather than the launch firehose, so the entry reacts to
--   demonstrated conviction instead of gating at minute zero when no signal
--   exists. Routes through the SAME executeBuy chokepoint (Mayhem gate, trade
--   firewall round-trip, budgets, concurrency, market-cap clamps) as every
--   other trigger.

begin;

alter table agent_sniper_strategies drop constraint if exists agent_sniper_strategies_trigger_check;
alter table agent_sniper_strategies
    add constraint agent_sniper_strategies_trigger_check
    check (trigger in ('new_mint', 'first_claim', 'intel_confirmed', 'prelaunch_radar',
                       'alpha_hunt', 'graduation_ride', 'oracle_crossing'));

alter table agent_sniper_positions drop constraint if exists agent_sniper_positions_entry_trigger_check;
alter table agent_sniper_positions
    add constraint agent_sniper_positions_entry_trigger_check
    check (entry_trigger in ('new_mint', 'first_claim', 'intel_confirmed', 'prelaunch_radar',
                             'alpha_hunt', 'llm_judge', 'llm_intel', 'swarm_consensus',
                             'graduation_ride', 'oracle_crossing'));

commit;
