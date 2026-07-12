-- Ops alerts store — the durable record behind the admin ops dashboard.
--
-- Every sendOpsAlert() (api/_lib/alerts.js) upserts one row here, keyed by the
-- alert's stable signature, so a recurring condition is ONE row with a growing
-- count rather than a flood. This is independent of the Telegram channel: alerts
-- persist here even when no chat is configured, which is what lets the admin
-- surface at /admin/ops show them. Acknowledging a row silences it in the active
-- feed until the same signature fires again (which re-activates it).

CREATE TABLE IF NOT EXISTS ops_alerts (
	signature        text PRIMARY KEY,
	title            text NOT NULL,
	detail           text,
	severity         text NOT NULL DEFAULT 'warn',   -- 'critical' | 'warn' | 'info'
	count            integer NOT NULL DEFAULT 1,
	environment      text,
	first_seen       timestamptz NOT NULL DEFAULT now(),
	last_seen        timestamptz NOT NULL DEFAULT now(),
	acknowledged_at  timestamptz,
	acknowledged_by  text
);

-- Active feed: unacknowledged, newest breach first.
CREATE INDEX IF NOT EXISTS ops_alerts_active_idx
	ON ops_alerts (acknowledged_at, last_seen DESC);

-- Full history browse.
CREATE INDEX IF NOT EXISTS ops_alerts_last_seen_idx
	ON ops_alerts (last_seen DESC);
