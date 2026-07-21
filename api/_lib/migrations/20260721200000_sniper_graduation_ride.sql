-- graduation_ride trigger (the BOOST-window arm) + entry_trigger CHECK repair.
-- Apply: psql "$DATABASE_URL" -f api/_lib/migrations/20260721200000_sniper_graduation_ride.sql
-- Idempotent (drop + re-add of named constraints).
--
-- 1. New trigger value `graduation_ride`: buy a coin's pump AMM pool the moment
--    it migrates off the bonding curve and sell into pump.fun's BOOST window
--    (live 2026-07-21: ~17.6 SOL of buyback+burn TWAP'd over the 5 minutes after
--    every non-Mayhem migration). Entry: workers/agent-sniper/graduation-ride.js.
--    Exits reuse the unchanged exit engine (max_hold_seconds is the window sell).
--
-- 2. REPAIR: the positions entry_trigger CHECK still listed only the original 4
--    values, but the worker has been writing 'llm_judge', 'llm_intel',
--    'alpha_hunt' and 'swarm_consensus' since those paths shipped — every such
--    buy died at the position-claim INSERT with a constraint violation. Widen
--    the CHECK to every value the code actually writes.

begin;

alter table agent_sniper_strategies drop constraint if exists agent_sniper_strategies_trigger_check;
alter table agent_sniper_strategies
    add constraint agent_sniper_strategies_trigger_check
    check (trigger in ('new_mint', 'first_claim', 'intel_confirmed', 'prelaunch_radar',
                       'alpha_hunt', 'graduation_ride'));

alter table agent_sniper_positions drop constraint if exists agent_sniper_positions_entry_trigger_check;
alter table agent_sniper_positions
    add constraint agent_sniper_positions_entry_trigger_check
    check (entry_trigger in ('new_mint', 'first_claim', 'intel_confirmed', 'prelaunch_radar',
                             'alpha_hunt', 'llm_judge', 'llm_intel', 'swarm_consensus',
                             'graduation_ride'));

commit;
