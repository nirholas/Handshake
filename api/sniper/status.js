// @ts-check
/**
 * Agent Sniper — worker liveness status.
 *
 *   GET /api/sniper/status
 *
 * Answers "is the sniper worker alive AND is its feed actually live?" without
 * SSHing into Cloud Run. The agent-sniper worker (workers/agent-sniper) is a
 * long-lived process that holds the PumpPortal feed open and upserts a
 * bot_heartbeat row (worker='agent-sniper') every SNIPER_HEARTBEAT_MS. This
 * endpoint reads that row and derives the operational truth:
 *
 *   alive          — a heartbeat within the freshness window (process is up)
 *   feedLive       — the worker reports its feed subscription is currently up
 *   degraded       — alive but the feed has been silent past its watchdog window
 *                    (up but deaf), or part of the fleet can no longer trade
 *   starved        — alive, feed fine, and NO armed wallet can afford an entry
 *
 * That last state is why this endpoint no longer answers liveness alone. From
 * 2026-07-29 to 2026-08-08 it reported `live` continuously while the fleet
 * booked a thousand consecutive failed buys and closed nothing: every process
 * fact it measured was true, and the wallets were empty. A trading worker that
 * cannot pay for a trade is not live, so solvency (published in the heartbeat by
 * the worker's funding loop, see api/_lib/sniper-solvency.js) now outranks the
 * feed checks in the verdict.
 *
 * The two cheapest counts (active strategies, open positions) give the page a
 * one-glance "what is it doing" without a second round-trip. Public + IP
 * rate-limited — the worker's status carries no secrets, and the whole point of
 * the platform's status surface is that anyone can see it's running.
 *
 * No heartbeat row yet (fresh deploy, never started) → ok:true with
 * `state: 'unknown'`, so /status renders an honest "not yet reporting" state
 * rather than a false-red "down".
 */

import { cors, json, method, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { sql } from '../_lib/db.js';

const WORKER = 'agent-sniper';
// Allow 2× the default heartbeat cadence (30s) plus slack before declaring the
// worker dead, so one skipped beat under load doesn't flap the status.
const HEARTBEAT_FRESH_MS = 90_000;

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.mcpIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	let beat = null;
	let strategies = null;
	let openPositions = null;
	let funding = null;
	try {
		[beat] = await sql`
			SELECT mode, last_beat_at, meta FROM bot_heartbeat
			WHERE worker = ${WORKER}
			LIMIT 1
		`;
		// Context counts are best-effort — never block the liveness answer on them.
		const [stratRow] = await sql`
			SELECT count(*)::int AS n FROM agent_sniper_strategies
			WHERE enabled AND NOT kill_switch
		`;
		strategies = stratRow?.n ?? null;
		const [posRow] = await sql`
			SELECT count(*)::int AS n FROM agent_sniper_positions
			WHERE status IN ('opening', 'open', 'closing')
		`;
		openPositions = posRow?.n ?? null;
		// Treasury → agent money flow (buy-side auto-funder). DB-only so it never
		// adds an RPC hop to the public liveness path. Reported as 'live' rows only
		// so simulate top-ups don't inflate the real-spend number. Absent table
		// (pre-migration) degrades to null, not a 500.
		try {
			const [f] = await sql`
				SELECT
					coalesce(sum(lamports) FILTER (WHERE created_at >= date_trunc('day', now())), 0)::float8 / 1e9 AS funded_today_sol,
					count(*) FILTER (WHERE created_at >= date_trunc('day', now()))::int AS events_today,
					coalesce(sum(lamports), 0)::float8 / 1e9 AS funded_total_sol,
					max(created_at) AS last_fund_at
				FROM sniper_funding_events
				WHERE mode = 'live'
			`;
			funding = {
				fundedTodaySol: Number(f?.funded_today_sol || 0),
				eventsToday: f?.events_today ?? 0,
				fundedTotalSol: Number(f?.funded_total_sol || 0),
				lastFundAt: f?.last_fund_at ?? null,
			};
		} catch {
			funding = null;
		}
	} catch (err) {
		// DB unreachable: report unknown rather than a misleading green/red. This
		// endpoint's own answering is NOT proof the separate worker is alive.
		return json(
			res,
			200,
			{ ok: true, state: 'unknown', reason: 'status store unreachable', error: err?.code || 'db_error' },
			{ 'cache-control': 'public, max-age=5' },
		);
	}

	if (!beat) {
		return json(
			res,
			200,
			{
				ok: true,
				state: 'unknown',
				reason: 'no heartbeat reported yet',
				strategies,
				openPositions,
				funding,
			},
			{ 'cache-control': 'public, max-age=10' },
		);
	}

	const now = Date.now();
	const lastBeatMs = beat.last_beat_at ? new Date(beat.last_beat_at).getTime() : 0;
	const ageMs = lastBeatMs ? now - lastBeatMs : null;
	const alive = ageMs != null && ageMs < HEARTBEAT_FRESH_MS;
	const meta = beat.meta && typeof beat.meta === 'object' ? beat.meta : {};
	const feedLive = alive && meta.feedConnected === true;
	// Alive but the feed is silent past its watchdog window → degraded (deaf).
	const watchdogMs = Number(meta.feedWatchdogMs) || 180_000;
	const feedSilent = alive && Number(meta.lastEventAgeMs) > watchdogMs;

	// Money before mechanics: a worker that cannot fund an entry is not 'live', no
	// matter how healthy its feed is. Absent (older worker build, first tick not
	// yet run) degrades to 'unknown', which never overrides the feed verdict — an
	// unmeasured fleet must not read as a broke one.
	const solvency = meta.solvency && typeof meta.solvency === 'object' ? meta.solvency : null;
	const solvencyState = solvency?.state || 'unknown';
	const state = !alive
		? 'down'
		: solvencyState === 'starved'
			? 'starved'
			: feedSilent || !feedLive || solvencyState === 'degraded'
				? 'degraded'
				: 'live';

	return json(
		res,
		200,
		{
			ok: state === 'live',
			state,
			mode: beat.mode || meta.mode || 'unknown',
			network: meta.network || 'mainnet',
			feedLive,
			feedSilent: !!feedSilent,
			lastBeatAt: beat.last_beat_at ?? null,
			heartbeatAgeMs: ageMs,
			lastEventAgeMs: meta.lastEventAgeMs ?? null,
			reconnects: meta.reconnects ?? null,
			errors: meta.errors ?? null,
			lastError: meta.lastError ?? null,
			globalKill: meta.globalKill ?? null,
			intel: meta.intel ?? null,
			inFlightBuys: meta.inFlightBuys ?? null,
			bootAt: meta.bootAt ?? null,
			strategies: meta.strategies ?? strategies,
			openPositions,
			funding,
			solvency,
		},
		// Heartbeat refreshes every ~30s; a short shared cache absorbs status-page
		// bursts without meaningfully staling the liveness answer.
		{ 'cache-control': 'public, max-age=5' },
	);
});
