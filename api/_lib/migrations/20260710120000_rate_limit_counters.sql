-- Durable rate-limit fallback counters.
--
-- Every per-IP / per-user limiter on the platform normally runs on Upstash Redis
-- (api/_lib/rate-limit.js). When Redis is unreachable the limiter has, until now,
-- had exactly two dispositions, both bad for a money-moving bucket:
--
--   · fail closed  — deny the action. Safe for spend, but it takes every paid
--                    endpoint (checkout, withdraw, mint, trade) down for the
--                    entire outage. Observed 2026-07-09: the shared Upstash store
--                    hit its plan-wide command ceiling ("max requests limit
--                    exceeded. Limit: 500000") and the quota does not reset until
--                    the start of the next month, so "fail closed" meant weeks of
--                    503s on the paid product.
--   · degrade to memory — allow, counting per-instance. Fine for a login guard,
--                    but across a fan-out of Cloud Run instances it is not a
--                    bound on spend at all.
--
-- Postgres is already a hard dependency of every one of those endpoints (the
-- payment, wallet and credit ledgers all live here), so if Neon is down the
-- action cannot succeed anyway. That makes it the correct place to hold the
-- counter when Redis is blind: a limiter backed by this table is genuinely
-- distributed, survives instance fan-out, and costs one upsert.
--
-- Windowing: FIXED, not sliding. `window_start` is the floor of the current
-- window, so one atomic `INSERT … ON CONFLICT DO UPDATE … RETURNING hits` both
-- increments and reads the count with no read-modify-write race. The known
-- tradeoff is boundary burst — a caller can spend its full budget at the end of
-- one window and again at the start of the next, i.e. up to 2× `limit` across
-- the seam. Redis' sliding window does not have that seam. This is an explicit,
-- accepted tradeoff for a FALLBACK path: a 2× burst ceiling during an outage is
-- categorically better than either unbounded spend or a dead paid product, and
-- the single-statement atomicity is worth more here than seam precision.
--
-- Rows are pruned opportunistically by the limiter itself (see prunePgCounters
-- in api/_lib/rate-limit.js); nothing else writes this table.

CREATE TABLE IF NOT EXISTS rate_limit_counters (
	bucket       text   NOT NULL,
	window_start bigint NOT NULL,
	hits         integer NOT NULL DEFAULT 0,
	PRIMARY KEY (bucket, window_start)
);

-- Prune scans by age, never by bucket.
CREATE INDEX IF NOT EXISTS rate_limit_counters_window_start_idx
	ON rate_limit_counters (window_start);
