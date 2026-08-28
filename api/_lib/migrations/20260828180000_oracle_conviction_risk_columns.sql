-- Oracle conviction: store the risk numbers, not just the score.
--
-- v3 of the conviction engine produces three probabilities per coin instead of
-- one (a run, a run you get to keep, and a collapse). Two of them only existed
-- in the response object, which meant the feed could not sort, filter, or alert
-- on them, and a card had to re-score a coin to find out whether the thing it
-- was recommending typically hands the run straight back.
--
--   rug_risk       P(a holder from first sight ends down more than half), 0-100
--   upside         P(graduates or peaks at 3x or more), 0-100
--   give_back_risk P(gives the run back | it runs), 0-100
--   model_version_id  which oracle_model_versions row produced this verdict
--
-- give_back_risk is the one worth having in a column. It is the difference
-- between "this will probably run" and "this will probably still be worth
-- something", and sorting the live feed by it surfaces the exact trap that made
-- a high score feel dishonest: coins that reliably spike and reliably round-trip.
--
-- model_version_id makes every stored verdict reproducible. Given a mint you can
-- fetch the exact weights that scored it (GET /api/oracle/model?view=registry)
-- and recompute it offline, which is the difference between a published track
-- record and a claim about one.

alter table oracle_conviction add column if not exists rug_risk smallint;
alter table oracle_conviction add column if not exists upside smallint;
alter table oracle_conviction add column if not exists give_back_risk smallint;
alter table oracle_conviction add column if not exists model_version_id bigint;

-- The feed's two new orderings: safest high-conviction calls first, and the
-- give-back trap list. Partial, because a null risk is a pre-v3 row and sorting
-- it in with the rest would silently rank unmeasured coins as safe.
create index if not exists idx_oracle_conviction_rug_risk
	on oracle_conviction (network, rug_risk asc, score desc)
	where rug_risk is not null;
create index if not exists idx_oracle_conviction_give_back
	on oracle_conviction (network, give_back_risk desc, score desc)
	where give_back_risk is not null;

-- Same three numbers on the history table, so a coin's risk profile can be
-- charted over its life the way its score already is.
alter table oracle_conviction_history add column if not exists rug_risk smallint;
alter table oracle_conviction_history add column if not exists upside smallint;
alter table oracle_conviction_history add column if not exists give_back_risk smallint;
