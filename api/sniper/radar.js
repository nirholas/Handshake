/**
 * Agent Sniper — Pre-Launch Radar API.
 *
 *   GET /api/sniper/radar?network=mainnet
 *
 * The radar (workers/agent-sniper/prelaunch-radar.js) watches proven creator +
 * smart-money wallets on-chain and records launch precursors to radar_events,
 * curating the monitored set into radar_watchlist. This endpoint surfaces both:
 *
 *   • Public (no auth): the anonymized live precursor stream — recent event counts,
 *     the radar's operational state, and a redacted recent-events tape. Wallet
 *     addresses are truncated; no owner-specific data leaks.
 *   • Owner (session or bearer): full watchlist with the reason each wallet is
 *     watched, full-detail recent events, their armed prelaunch_radar strategies,
 *     and — correlating radar_events.mint with their positions — whether their
 *     agent actually fired on a precursor.
 *
 * Honest degradation: the radar's state is read from the worker's heartbeat. If
 * the worker hasn't reported, state is 'unknown' rather than a false green.
 */

import { cors, json, method, wrap, rateLimited } from '../_lib/http.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { sql } from '../_lib/db.js';

const NETWORKS = new Set(['mainnet', 'devnet']);
const HEARTBEAT_FRESH_MS = 90_000;

function trunc(addr) {
	if (!addr || typeof addr !== 'string' || addr.length < 10) return addr || null;
	return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

async function resolveUserId(req) {
	try {
		const session = await getSessionUser(req);
		if (session) return session.id;
		const bearer = await authenticateBearer(extractBearer(req));
		if (bearer) return bearer.userId;
	} catch {}
	return null;
}

async function radarStatus() {
	try {
		const [beat] = await sql`
			SELECT last_beat_at, meta FROM bot_heartbeat WHERE worker = 'agent-sniper' LIMIT 1
		`;
		if (!beat) return { state: 'unknown', reason: 'no heartbeat reported yet' };
		const ageMs = beat.last_beat_at ? Date.now() - new Date(beat.last_beat_at).getTime() : null;
		const alive = ageMs != null && ageMs < HEARTBEAT_FRESH_MS;
		const meta = beat.meta && typeof beat.meta === 'object' ? beat.meta : {};
		const r = meta.radar && typeof meta.radar === 'object' ? meta.radar : null;
		if (!alive) return { state: 'down', reason: 'worker heartbeat stale' };
		if (!r) return { state: 'unknown', reason: 'radar not reporting' };
		const state = r.paused ? 'paused' : r.active ? 'live' : 'unknown';
		return {
			state,
			source: r.source ?? null,
			reason: r.reason ?? null,
			watched: r.watched ?? null,
			deployWatch: r.deployWatch ?? null,
			events: r.events ?? null,
			prearmed: r.prearmed ?? null,
			lastEventAgeMs: r.lastEventAt ? Date.now() - r.lastEventAt : null,
			lastTickAgeMs: r.lastTickAt ? Date.now() - r.lastTickAt : null,
		};
	} catch {
		return { state: 'unknown', reason: 'status store unreachable' };
	}
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.mcpIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, `http://${req.headers.host || 'x'}`);
	const network = NETWORKS.has(url.searchParams.get('network')) ? url.searchParams.get('network') : 'mainnet';
	const userId = await resolveUserId(req);

	let status, watchRows, eventRows, counts, watchedTotal;
	try {
		[status, watchRows, eventRows, counts, watchedTotal] = await Promise.all([
			radarStatus(),
			sql`
				select address, reason, source, score, creator_graduated, realized_score, labels,
				       added_at, last_hit_at, hits
				from radar_watchlist
				where network = ${network}
				order by score desc
				limit 100
			`,
			sql`
				select id, kind, trigger_wallet, new_wallet, mint, confidence,
				       watch_reason, watch_score, observed_ts, created_at
				from radar_events
				where network = ${network}
				order by created_at desc
				limit 60
			`,
			sql`
				select
					count(*) filter (where created_at > now() - interval '1 hour')  as events_1h,
					count(*) filter (where created_at > now() - interval '24 hours') as events_24h,
					count(*) filter (where mint is not null and created_at > now() - interval '24 hours') as armable_24h
				from radar_events
				where network = ${network}
			`.then((r) => r[0] || {}),
			// How many wallets the radar actually watches. The list above is the top
			// 100 by score, so reporting its length made the dashboard's "Watched
			// wallets" KPI read 100 while the worker's own heartbeat, rendered on the
			// same screen, reported the real (much larger) figure.
			sql`select count(*)::int as n from radar_watchlist where network = ${network}`
				.then((r) => Number(r[0]?.n) || 0),
		]);
	} catch (err) {
		return json(res, 200, {
			ok: false, network, state: 'unknown',
			error: err?.code || 'db_error',
			status: { state: 'unknown', reason: 'radar store unreachable' },
			watchlist: [], events: [], counts: { events_1h: 0, events_24h: 0, armable_24h: 0, watched: 0, listed: 0 },
		}, { 'cache-control': 'public, max-age=5' });
	}

	const isOwner = !!userId;

	// Which event mints did THIS owner's agents actually fire on?
	let firedMints = new Set();
	let armed = null;
	if (isOwner) {
		try {
			const mints = eventRows.map((e) => e.mint).filter(Boolean);
			const [positions, strategies] = await Promise.all([
				mints.length
					? sql`
						select mint, status, realized_pnl_lamports, buy_sig
						from agent_sniper_positions
						where user_id = ${userId} and network = ${network}
						  and entry_trigger = 'prelaunch_radar' and mint = any(${mints})
					`
					: Promise.resolve([]),
				sql`
					select s.agent_id, a.name as agent_name, s.enabled, s.kill_switch,
					       s.min_creator_graduated_radar, s.require_smart_money_funder, s.radar_max_age_ms,
					       s.per_trade_lamports
					from agent_sniper_strategies s
					join agent_identities a on a.id = s.agent_id
					where s.user_id = ${userId} and s.network = ${network} and s.trigger = 'prelaunch_radar'
					order by s.updated_at desc
				`,
			]);
			firedMints = new Set(positions.map((p) => p.mint));
			const posByMint = new Map(positions.map((p) => [p.mint, p]));
			armed = {
				strategies: strategies.map((s) => ({
					agent_id: s.agent_id, agent_name: s.agent_name,
					enabled: s.enabled, kill_switch: s.kill_switch,
					min_creator_graduated_radar: s.min_creator_graduated_radar,
					require_smart_money_funder: s.require_smart_money_funder,
					radar_max_age_ms: s.radar_max_age_ms,
					per_trade_sol: s.per_trade_lamports != null ? Number(BigInt(s.per_trade_lamports)) / 1e9 : null,
				})),
				positions: positions.map((p) => ({
					mint: p.mint, status: p.status,
					pnl_sol: p.realized_pnl_lamports != null ? Number(BigInt(p.realized_pnl_lamports)) / 1e9 : null,
				})),
				_posByMint: posByMint,
			};
		} catch {
			armed = { strategies: [], positions: [] };
		}
	}

	const watchlist = watchRows.map((w) => ({
		address: isOwner ? w.address : trunc(w.address),
		reason: w.reason,
		source: w.source,
		score: Number(w.score),
		creator_graduated: w.creator_graduated,
		realized_score: w.realized_score != null ? Number(w.realized_score) : null,
		labels: Array.isArray(w.labels) ? w.labels : [],
		added_at: w.added_at,
		last_hit_at: w.last_hit_at,
		hits: w.hits,
	}));

	const events = eventRows.map((e) => ({
		id: e.id,
		kind: e.kind,
		trigger_wallet: isOwner ? e.trigger_wallet : trunc(e.trigger_wallet),
		new_wallet: isOwner ? e.new_wallet : trunc(e.new_wallet),
		mint: e.mint,
		confidence: Number(e.confidence),
		watch_reason: e.watch_reason,
		watch_score: e.watch_score != null ? Number(e.watch_score) : null,
		observed_ts: e.observed_ts,
		created_at: e.created_at,
		fired: isOwner ? firedMints.has(e.mint) : undefined,
	}));

	if (armed) delete armed._posByMint;

	return json(res, 200, {
		ok: true,
		network,
		owner: isOwner,
		status,
		watchlist,
		events,
		counts: {
			events_1h: Number(counts.events_1h || 0),
			events_24h: Number(counts.events_24h || 0),
			armable_24h: Number(counts.armable_24h || 0),
			watched: watchedTotal,
			listed: watchlist.length,
		},
		armed,
	}, { 'cache-control': isOwner ? 'private, no-store' : 'public, max-age=5' });
});
