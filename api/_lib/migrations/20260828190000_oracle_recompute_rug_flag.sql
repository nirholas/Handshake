-- Oracle: recompute the stored rug flag from the price-independent ratios.
--
-- The previous migration added `retained` and `hold_multiple` and backfilled
-- them, but left the `rugged` column itself holding the old verdict: the one
-- decided by comparing a bonding curve's dollar value to a hardcoded $3,000,
-- which on a curve worth a fixed 27.958993 SOL amounts to asking whether SOL was
-- above roughly $107.30 that day.
--
-- Leaving it would have been the worst of both worlds. Half a dozen surfaces
-- read that column directly to compute a "clean win rate" that subtracts rugs:
--
--   api/oracle/stats.js       the platform win rate on the /oracle hero
--   api/oracle/backtest.js    the published calibration table
--   api/oracle/wins.js        the winners board
--   api/pump/intel.js         the coin-intel leaderboard and learning view
--   api/_lib/strategy-backtest.js   every strategy backtest
--
-- Every one of them was reading a price feed and calling it a win rate. Fixing
-- the column fixes all of them at once, without touching their code, and keeps
-- them honest for anything written against the column later.
--
-- A rug is a collapse a holder eats, so it is measured against what they paid:
-- hold_multiple <= 0.5, i.e. down more than half from the market cap at first
-- sight. Rows where hold_multiple could not be recovered (the outcomes row was
-- pruned before we could compute it) keep whatever they had; they are excluded
-- from training by `label_version`, and overwriting them with a guess would be
-- inventing data rather than correcting it.
--
-- Measured effect: the non-graduated rug rate drops from about 91% to about
-- 11.4%, which is the real one.

update pump_coin_outcomes
set rugged = (graduated is not true and hold_multiple <= 0.5)
where hold_multiple is not null
  and rugged is distinct from (graduated is not true and hold_multiple <= 0.5);

update oracle_training_set
set rugged = (graduated is not true and hold_multiple <= 0.5)
where hold_multiple is not null
  and rugged is distinct from (graduated is not true and hold_multiple <= 0.5);

-- Keep the categorical label consistent with the flag it was derived from.
-- Precedence is unchanged (graduated, then a 3x run, then a rug, then flat), so
-- this only ever moves a row between 'rugged' and 'flat'; neither is a "moon",
-- so no model target shifts underneath a fitted weight.
update pump_coin_outcomes
set outcome = case
		when graduated then 'graduated'
		when ath_multiple >= 3 then 'pumped'
		when rugged then 'rugged'
		else 'flat'
	end
where hold_multiple is not null
  and outcome <> 'unknown'
  and outcome is distinct from (case
		when graduated then 'graduated'
		when ath_multiple >= 3 then 'pumped'
		when rugged then 'rugged'
		else 'flat'
	end);

update oracle_training_set
set outcome = case
		when graduated then 'graduated'
		when ath_multiple >= 3 then 'pumped'
		when rugged then 'rugged'
		else 'flat'
	end
where hold_multiple is not null
  and outcome <> 'unknown'
  and outcome is distinct from (case
		when graduated then 'graduated'
		when ath_multiple >= 3 then 'pumped'
		when rugged then 'rugged'
		else 'flat'
	end);
