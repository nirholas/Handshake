// GET /api/admin/circulation-health
//
// Why this exists: the autonomous activity engine (api/_lib/circulation.js, driven
// by the pulse-tick cron every 2 min) records EVERY action into circulation_actions
// with a status of 'ok' | 'skipped' | 'error' and a reason in `detail`. When tips and
// payments flow but trades / launches / marketplace purchases sit at zero, the cause
// is almost always one kind of action silently Skipping every tick (e.g. the pump.fun
// swap rail rejecting, the launcher erroring, treasury too low to fund a launch). That
// signal was previously invisible — the only way to read it was a raw DB query. This
// endpoint surfaces it: per-kind ok/skipped/error counts plus the most recent failure
// reason, so a stalled rail is diagnosable at a glance.
//
// Auth: session + admin, OR `Bearer $CRON_SECRET` for monitoring scrapers (matches
// api/admin/pump-cron-health.js). No secrets are ever returned — the treasury secret
// is reported only as a configured/not-configured boolean.

import { sql } from '../_lib/db.js';
import { requireAdmin } from '../_lib/admin.js';
import { cors, json, method, wrap } from '../_lib/http.js';
import { env } from '../_lib/env.js';
import { constantTimeEquals } from '../_lib/crypto.js';
import { config as circulationConfig } from '../_lib/circulation.js';
import { fuelStatus } from '../_lib/economy-fuel.js';

// pulse-tick runs every 2 min. A tick that returns early (disabled, pool warming,
// treasury too low) logs nothing, so a gap can mean either the cron is down OR the
// treasury is empty — the warning text says as much rather than guessing.
const STALE_AFTER_MIN = 15;

// The action kinds that move real value and back the public Money Pulse counters.
// If one of these has attempts but zero 'ok' in 24h, that's the thing to investigate.
const VALUE_KINDS = ['tip', 'payment', 'trade', 'launch', 'buy_skill', 'buy_asset', 'trial'];

const num = (v) => (v == null ? 0 : Number(v));

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	// Monitoring scrapers authenticate with the cron secret; everyone else must be a
	// real admin (same gate as pump-cron-health).
	const auth = req.headers.authorization || '';
	const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
	const isCron = !!env.CRON_SECRET && constantTimeEquals(bearer, env.CRON_SECRET);
	if (!isCron) {
		const admin = await requireAdmin(req, res);
		if (!admin) return;
	}

	const cfg = circulationConfig();

	// One pass over the 24h ledger: per (kind, status) counts, the latest event time,
	// and the most recent human-readable problem reason for the failing rows. The
	// `.catch` guards a not-yet-migrated table the same way pump-cron-health does.
	const [byKindStatus, liveness, pool, quarantined, fuel] = await Promise.all([
		sql`
			select kind, status, count(*)::int as n, max(created_at) as last_at,
			       (array_agg(coalesce(nullif(detail->>'reason',''), nullif(detail->>'error',''))
			          order by created_at desc)
			          filter (where status in ('skipped','error')
			                  and coalesce(detail->>'reason', detail->>'error') is not null))[1] as last_problem
			from circulation_actions
			where created_at > now() - interval '24 hours'
			group by kind, status
		`.catch(() => []),
		sql`
			select max(created_at) as last_action_at,
			       count(*) filter (where created_at > now() - interval '1 hour')::int as actions_1h,
			       count(*) filter (where created_at > now() - interval '24 hours')::int as actions_24h
			from circulation_actions
		`.catch(() => [{}]),
		sql`
			select count(*)::int as n from agent_identities
			where (meta->>'circulation') = 'true' and deleted_at is null
			  and coalesce((meta->>'circulation_key_broken')::boolean, false) = false
		`.catch(() => [{}]),
		sql`
			select count(*)::int as n from agent_identities
			where (meta->>'circulation') = 'true' and deleted_at is null
			  and coalesce((meta->>'circulation_key_broken')::boolean, false) = true
		`.catch(() => [{}]),
		fuelStatus({ limit: 5 }).catch(() => null),
	]);

	// Fold the (kind, status) rows into one record per kind.
	const byKind = {};
	const ensureKind = (k) => (byKind[k] ||= { ok: 0, skipped: 0, error: 0, last_problem: null, last_at: null });
	for (const r of byKindStatus) {
		const k = ensureKind(r.kind);
		if (r.status === 'ok') k.ok = num(r.n);
		else if (r.status === 'skipped') k.skipped = num(r.n);
		else if (r.status === 'error') k.error = num(r.n);
		// Newest problem reason across the skipped/error rows of this kind.
		if (r.last_problem && (!k.last_at || (r.last_at && new Date(r.last_at) >= new Date(k.last_at)))) {
			k.last_problem = r.last_problem;
		}
		if (r.last_at && (!k.last_at || new Date(r.last_at) > new Date(k.last_at))) k.last_at = r.last_at;
	}
	// Always show the value kinds, even at all-zero, so a rail that never fired once is
	// visibly present rather than silently absent.
	for (const k of VALUE_KINDS) ensureKind(k);

	const totals = Object.values(byKind).reduce(
		(t, k) => ({ ok: t.ok + k.ok, skipped: t.skipped + k.skipped, error: t.error + k.error }),
		{ ok: 0, skipped: 0, error: 0 },
	);

	const lastActionAt = liveness[0]?.last_action_at || null;
	const minutesSince = lastActionAt ? Math.round((Date.now() - new Date(lastActionAt).getTime()) / 60000) : null;
	const stale = minutesSince == null || minutesSince > STALE_AFTER_MIN;

	// Warnings — the actionable summary an operator reads first.
	const warnings = [];
	if (!cfg.enabled) {
		warnings.push('CIRCULATION_ENABLED is off — the engine is inert and no activity is generated.');
	} else if (!cfg.treasurySecret) {
		warnings.push('CIRCULATION_TREASURY_SECRET is unset — every tick skips before any action runs.');
	}
	if (cfg.enabled && stale) {
		warnings.push(
			minutesSince == null
				? 'No circulation actions recorded yet — cron may not be running, or the treasury is unfunded.'
				: `No circulation action in ${minutesSince} min (cron is every 2 min) — the cron may be down, or the treasury is too low to fund any action (early skips are not logged).`,
		);
	}
	// The core signal: a value kind that is being attempted but never succeeds.
	for (const k of VALUE_KINDS) {
		const s = byKind[k];
		const attempts = s.ok + s.skipped + s.error;
		if (attempts > 0 && s.ok === 0) {
			warnings.push(`${k}: 0 ok / ${s.skipped} skipped / ${s.error} error in 24h — last: ${s.last_problem || 'no reason recorded'}`);
		}
	}
	const quarantinedCount = num(quarantined[0]?.n);
	if (quarantinedCount > 0) {
		warnings.push(
			`${quarantinedCount} agent(s) quarantined for unrecoverable custodial keys; their wallets were encrypted under a rotated WALLET_ENCRYPTION_KEY and are excluded from the pool.`,
		);
	}
	// Fuel is the SOL source of last resort. Flag it when it is off (the feed can
	// then only run on manually-topped SOL) or when today's cap is spent while the
	// engine is still starving.
	if (fuel && !fuel.enabled) {
		warnings.push('Economy fuel (USDC→SOL auto-refuel) is disabled; a drained funding root will stall the feed until SOL is added by hand.');
	} else if (fuel && fuel.daily_remaining_usd <= 0 && cfg.enabled && stale) {
		warnings.push('Economy fuel daily cap is spent and the feed is stale; raise ECONOMY_FUEL_DAILY_USDC or add SOL to the master.');
	}

	return json(res, 200, {
		now: new Date().toISOString(),
		config: {
			enabled: cfg.enabled,
			treasury_configured: !!cfg.treasurySecret,
			evm_treasury_configured: !!cfg.evmTreasurySecret,
			network: cfg.network,
			pool_target: cfg.poolTarget,
			actions_per_tick: cfg.actionsPerTick,
		},
		pool_size: num(pool[0]?.n),
		quarantined_agents: quarantinedCount,
		fuel,
		liveness: {
			last_action_at: lastActionAt,
			minutes_since: minutesSince,
			actions_1h: num(liveness[0]?.actions_1h),
			actions_24h: num(liveness[0]?.actions_24h),
			stale,
		},
		window_24h: { by_kind: byKind, totals },
		warnings,
	});
});
