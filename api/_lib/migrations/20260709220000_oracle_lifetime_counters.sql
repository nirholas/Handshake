-- Oracle lifetime counters — durable scored-coin tally.
--
-- oracle_conviction is part of the db-retention firehose family (pruned to a
-- 14-day window, 3 days under storage pressure), so count(*) over it is a
-- rolling-window count, not "all-time". The /api/oracle/stats scored_total
-- figure was silently shrinking with every prune. This table holds a monotonic
-- counter incremented once per first-ever score of a (mint, network) —
-- retention never touches it.

CREATE TABLE IF NOT EXISTS oracle_counters (
	network    text        NOT NULL,
	key        text        NOT NULL,
	value      bigint      NOT NULL DEFAULT 0,
	updated_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (network, key)
);

-- Seed from the live cache. The pre-retention history is already gone, so the
-- current cache count is the best available floor; the counter is monotonic
-- from here on.
INSERT INTO oracle_counters (network, key, value)
SELECT network, 'scored_lifetime', count(*)
FROM oracle_conviction
GROUP BY network
ON CONFLICT (network, key) DO NOTHING;
