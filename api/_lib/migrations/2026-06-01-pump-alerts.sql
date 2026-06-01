-- Pump dashboard: server-side alert configuration + delivery, and a real
-- heartbeat the pumpfun-monitor cron writes so /api/healthz can report live
-- bot status instead of a hardcoded constant.
--
-- Idempotent: safe to re-run.

-- ── Per-user alert rules ────────────────────────────────────────────────────
-- One row per user. Edited via PUT /api/alerts/config; evaluated server-side by
-- the pumpfun-monitor cron so alerts fire even when no dashboard tab is open.
create table if not exists user_alert_configs (
	user_id          uuid primary key references users(id) on delete cascade,
	graduation       boolean     not null default true,
	whale            boolean     not null default false,
	fees             boolean     not null default false,
	launch           boolean     not null default false,
	whale_threshold  numeric     not null default 10,    -- SOL
	claim_threshold  numeric     not null default 0.5,   -- SOL
	cooldown_seconds integer     not null default 30,
	webhook_url      text,
	created_at       timestamptz not null default now(),
	updated_at       timestamptz not null default now()
);

-- ── Cooldown tracker ────────────────────────────────────────────────────────
-- Per (user, rule_type) last-fired timestamp. The evaluator skips delivery when
-- now() - last_fired_at < cooldown_seconds, so a busy feed can't spam a user.
create table if not exists user_alert_fires (
	user_id       uuid        not null references users(id) on delete cascade,
	rule_type     text        not null,
	last_fired_at timestamptz not null default now(),
	last_event_id text,
	primary key (user_id, rule_type)
);

-- ── Bot heartbeat ───────────────────────────────────────────────────────────
-- The pumpfun-monitor cron upserts its row each run. /api/healthz reads the
-- freshest row to report monitor.running / monitor.mode for real.
create table if not exists bot_heartbeat (
	worker        text        primary key,
	mode          text        not null default 'cron',
	last_beat_at  timestamptz not null default now(),
	meta          jsonb       not null default '{}'::jsonb
);

create index if not exists user_alert_configs_enabled
	on user_alert_configs (user_id)
	where graduation or whale or fees or launch;
