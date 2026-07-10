// @ts-check
/**
 * Recording pipeline — one-call health of the whole data→signal→trade loop.
 *
 *   GET /api/pipeline?network=mainnet
 *
 * The platform's edge is a closed feedback loop. A long-lived worker
 * (workers/agent-sniper) sits on the pump.fun new-mint feed and records every
 * launch's first-90s signals; cron jobs then score conviction, fold a wallet
 * reputation graph, label outcomes, and train per-signal weights; armed agents
 * trade on the result. Each link lives in a different table, so "is the loop
 * actually running?" otherwise takes six queries across six surfaces.
 *
 * This endpoint answers it in one round-trip. Every stage is queried
 * independently and degrades on its own — a table that doesn't exist yet
 * (fresh DB) or a worker that has never booted reports an honest zero/offline
 * state rather than failing the whole response. The frontend (/pipeline)
 * renders this as a live flow: all-dark until the recorder boots, then lighting
 * up stage by stage as data flows downstream.
 *
 * Public + IP rate-limited — pipeline health carries no secrets and the point
 * of a status surface is that anyone can see whether the platform is alive.
 */

import { cors, json, method, wrap, rateLimited } from './_lib/http.js';
import { limits, clientIp } from './_lib/rate-limit.js';
import { sql } from './_lib/db.js';
import { summarize } from './_lib/pipeline-summary.js';

const WORKER = 'agent-sniper';
// 2× the 30s heartbeat cadence + slack: one skipped beat under load must not
// flap the recorder between "live" and "down".
const HEARTBEAT_FRESH_MS = 90_000;
// Public spend categories whose 24h counts the loop produces (mirror pulse.js).
const SNIPE = 'snipe';
const TRADE = 'trade';

/** Derive the recorder's operational truth from its heartbeat row. */
function recorderState(beat) {
	if (!beat) return { state: 'offline', reason: 'never started' };
	const lastBeatMs = beat.last_beat_at ? new Date(beat.last_beat_at).getTime() : 0;
	const ageMs = lastBeatMs ? Date.now() - lastBeatMs : null;
	const alive = ageMs != null && ageMs < HEARTBEAT_FRESH_MS;
	const meta = beat.meta && typeof beat.meta === 'object' ? beat.meta : {};
	const feedLive = alive && meta.feedConnected === true;
	const watchdogMs = Number(meta.feedWatchdogMs) || 180_000;
	const feedSilent = alive && Number(meta.lastEventAgeMs) > watchdogMs;
	const state = !alive ? 'down' : feedSilent || !feedLive ? 'degraded' : 'live';
	return {
		state,
		mode: beat.mode || meta.mode || 'unknown',
		network: meta.network || null,
		feedLive,
		feedSilent: !!feedSilent,
		heartbeatAgeMs: ageMs,
		lastEventAgeMs: meta.lastEventAgeMs ?? null,
		reconnects: meta.reconnects ?? null,
		errors: meta.errors ?? null,
		lastError: meta.lastError ?? null,
		intel: meta.intel ?? null,
		bootAt: meta.bootAt ?? null,
	};
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.mcpIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, 'http://x');
	const network = url.searchParams.get('network') === 'devnet' ? 'devnet' : 'mainnet';

	// Each stage resolves independently: a missing table or a cold worker is a
	// zero/offline state for that stage, never a 500 for the whole loop.
	const safe = async (fn, fallback) => {
		try {
			return await fn();
		} catch {
			return fallback;
		}
	};

	const [recorder, intel, outcomes, oracle, reputation, learning, trading] = await Promise.all([
		// 1 — Recorder: is the always-on worker alive and its feed live?
		safe(async () => {
			const [beat] = await sql`
				SELECT mode, last_beat_at, meta FROM bot_heartbeat WHERE worker = ${WORKER} LIMIT 1`;
			return recorderState(beat);
		}, { state: 'unknown', reason: 'status store unreachable' }),

		// 2 — Intel: launches observed + signal-quality distribution.
		safe(async () => {
			const [r] = await sql`
				SELECT
					count(*)::int AS total,
					count(*) filter (where first_seen_at > now() - interval '24 hours')::int AS observed_24h,
					count(*) filter (where first_seen_at > now() - interval '1 hour')::int   AS observed_1h,
					round(avg(quality_score) filter (where quality_score is not null
						and first_seen_at > now() - interval '24 hours'))::int                AS avg_quality,
					count(*) filter (where quality_score >= 70
						and first_seen_at > now() - interval '24 hours')::int                 AS healthy,
					count(*) filter (where quality_score >= 40 and quality_score < 70
						and first_seen_at > now() - interval '24 hours')::int                 AS mixed,
					count(*) filter (where quality_score < 40
						and first_seen_at > now() - interval '24 hours')::int                 AS risky,
					count(*) filter (where smart_money_count > 0
						and first_seen_at > now() - interval '24 hours')::int                 AS smart_money_touched
				FROM pump_coin_intel WHERE network = ${network}`;
			return {
				total: r?.total ?? 0,
				observed_24h: r?.observed_24h ?? 0,
				observed_1h: r?.observed_1h ?? 0,
				avg_quality: r?.avg_quality ?? null,
				healthy: r?.healthy ?? 0,
				mixed: r?.mixed ?? 0,
				risky: r?.risky ?? 0,
				smart_money_touched: r?.smart_money_touched ?? 0,
			};
		}, { total: 0, observed_24h: 0, observed_1h: 0, avg_quality: null, healthy: 0, mixed: 0, risky: 0, smart_money_touched: 0 }),

		// 3 — Outcomes: ground-truth labels folded back in (the learning fuel).
		safe(async () => {
			const [r] = await sql`
				SELECT
					count(*)::int                                            AS labeled,
					count(*) filter (where graduated)::int                   AS graduated,
					count(*) filter (where rugged)::int                      AS rugged,
					count(*) filter (where outcome = 'pumped')::int          AS pumped,
					count(*) filter (where labeled_at > now() - interval '24 hours')::int AS labeled_24h
				FROM pump_coin_outcomes o
				JOIN pump_coin_intel i ON i.mint = o.mint AND i.network = ${network}`;
			return {
				labeled: r?.labeled ?? 0,
				graduated: r?.graduated ?? 0,
				rugged: r?.rugged ?? 0,
				pumped: r?.pumped ?? 0,
				labeled_24h: r?.labeled_24h ?? 0,
			};
		}, { labeled: 0, graduated: 0, rugged: 0, pumped: 0, labeled_24h: 0 }),

		// 4 — Oracle: conviction scoring throughput + tier distribution.
		safe(async () => {
			const [c] = await sql`
				SELECT
					count(*)::int                                                          AS cached,
					count(*) filter (where scored_at >= now() - interval '24 hours')::int  AS scored_24h,
					count(*) filter (where tier = 'prime')::int                            AS prime,
					count(*) filter (where tier = 'strong')::int                           AS strong
				FROM oracle_conviction WHERE network = ${network}`;
			const [a] = await sql`
				SELECT count(*)::int AS open_actions FROM oracle_watch_actions
				WHERE network = ${network} AND outcome = 'open'`;
			// oracle_conviction is retention-pruned, so its row count is a rolling
			// window. The durable counter is the lifetime figure — same source as
			// /api/oracle/stats, so the two surfaces never disagree.
			const [t] = await sql`
				SELECT value::int AS scored_lifetime FROM oracle_counters
				WHERE network = ${network} AND key = 'scored_lifetime'`.catch(() => [{}]);
			return {
				scored_total: Math.max(t?.scored_lifetime ?? 0, c?.cached ?? 0),
				scored_24h: c?.scored_24h ?? 0,
				prime: c?.prime ?? 0,
				strong: c?.strong ?? 0,
				open_actions: a?.open_actions ?? 0,
			};
		}, { scored_total: 0, scored_24h: 0, prime: 0, strong: 0, open_actions: 0 }),

		// 5 — Reputation graph: wallets with a folded track record.
		safe(async () => {
			const [r] = await sql`
				SELECT
					count(*)::int                                          AS wallets,
					count(*) filter (where label = 'smart_money')::int     AS smart_money
				FROM wallet_reputation WHERE network = ${network}`;
			return { wallets: r?.wallets ?? 0, smart_money: r?.smart_money ?? 0 };
		}, { wallets: 0, smart_money: 0 }),

		// 6 — Learning: latest trained per-signal weights (top by |correlation|).
		safe(async () => {
			const [w] = await sql`
				SELECT weights, sample_size, trained_at FROM pump_intel_weights
				WHERE network = ${network} ORDER BY trained_at DESC LIMIT 1`;
			let top = [];
			if (w?.weights && typeof w.weights === 'object') {
				top = Object.entries(w.weights)
					.filter(([, v]) => Number.isFinite(Number(v)))
					.map(([signal, v]) => ({ signal, weight: Number(v) }))
					.sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight))
					.slice(0, 8);
			}
			return { sample_size: w?.sample_size ?? 0, trained_at: w?.trained_at ?? null, weights: top };
		}, { sample_size: 0, trained_at: null, weights: [] }),

		// 7 — Trading: armed strategies, open positions, and 24h confirmed spend.
		safe(async () => {
			const [s] = await sql`
				SELECT count(*)::int AS armed FROM agent_sniper_strategies
				WHERE enabled AND NOT kill_switch AND network = ${network}`;
			const [p] = await sql`
				SELECT count(*)::int AS open FROM agent_sniper_positions
				WHERE status IN ('opening','open','closing') AND network = ${network}`;
			const [e] = await sql`
				SELECT
					count(*) filter (where category = ${SNIPE})::int AS snipes_24h,
					count(*) filter (where category = ${TRADE})::int AS trades_24h
				FROM agent_custody_events
				WHERE network = ${network} AND event_type = 'spend'
				  AND status IN ('ok','confirmed')
				  AND created_at > now() - interval '24 hours'`;
			return {
				strategies_armed: s?.armed ?? 0,
				open_positions: p?.open ?? 0,
				snipes_24h: e?.snipes_24h ?? 0,
				trades_24h: e?.trades_24h ?? 0,
			};
		}, { strategies_armed: 0, open_positions: 0, snipes_24h: 0, trades_24h: 0 }),
	]);

	const stages = { recorder, intel, outcomes, oracle, reputation, learning, trading };
	// Health, one-line summary, and the single most useful next action — derived
	// by a shared pure module so the page, agents, and tests read one truth.
	const { health, summary, next_action } = summarize(network, stages);

	return json(
		res,
		200,
		{
			ok: true,
			network,
			health,
			summary,
			next_action,
			stages,
			docs: 'https://three.ws/pipeline',
			t: Date.now(),
		},
		// Heartbeat + crons refresh on the order of seconds-to-minutes; a short
		// shared cache absorbs page-poll bursts without staling the answer.
		{ 'cache-control': 'public, max-age=8' },
	);
});
