/**
 * Signal feeds: the publisher's CRUD surface.
 *
 *   GET    /api/signals/feeds                     list the caller's feeds
 *   GET    /api/signals/feeds?agent_id=&network=  one agent's feed + publish eligibility
 *   POST   /api/signals/feeds                     create / update a feed (verified gate)
 *   POST   /api/signals/feeds  { id, status }     pause / resume
 *   DELETE /api/signals/feeds?id=                 pause (soft, keeps signal history)
 *
 * Publishing is gated on a REAL, verified on-chain track record: the publisher
 * agent must clear api/_lib/trader-stats.js's `verified` badge (12+ closed trades,
 * 5+ coins, ≤40% churn, positive realized SOL). An unproven wallet gets a 403 with
 * the exact thresholds it still has to meet. Sellers can never self-declare edge.
 */

import { cors, json, error, method, wrap, readJson, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { requireCsrf } from '../_lib/csrf.js';
import { sql } from '../_lib/db.js';
import { publisherMetrics } from '../_lib/signal-engine.js';
import { requireUser, loadOwnedAgent, normNetwork, NETWORKS, feedSlug, parseRowId } from './_common.js';

const MAX_USDC = 1000;            // sane per-signal / per-epoch ceiling
const MIN_EPOCH_SECONDS = 3600;   // 1 hour
const MAX_EPOCH_SECONDS = 30 * 86400;

function num(v, fallback = 0) {
	const n = Number(v);
	return Number.isFinite(n) ? n : fallback;
}

function shapeFeedRow(f) {
	return {
		id: Number(f.id),
		publisher_agent_id: f.publisher_agent_id,
		network: f.network,
		slug: f.slug,
		title: f.title,
		description: f.description || null,
		price_per_signal_usdc: num(f.price_per_signal_usdc),
		price_per_epoch_usdc: num(f.price_per_epoch_usdc),
		epoch_seconds: num(f.epoch_seconds, 86400),
		emit_entries: f.emit_entries,
		emit_exits: f.emit_exits,
		reveal_sizing: f.reveal_sizing,
		min_conviction: num(f.min_conviction),
		visibility: f.visibility,
		status: f.status,
		payout_address: f.payout_address,
		created_at: f.created_at,
		updated_at: f.updated_at,
	};
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,DELETE,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'POST', 'DELETE'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const auth = await requireUser(req, res);
	if (!auth) return;
	const { userId } = auth;

	// ── GET ───────────────────────────────────────────────────────────────────
	if (req.method === 'GET') {
		const url = new URL(req.url, 'http://x');
		const agentId = url.searchParams.get('agent_id');
		const network = normNetwork(url.searchParams.get('network'));

		if (agentId) {
			const owned = await loadOwnedAgent(req, res, userId, agentId);
			if (owned.error) return;
			const [feed] = await sql`
				select * from signal_feeds where publisher_agent_id = ${agentId} and network = ${network} limit 1
			`;
			const metrics = await publisherMetrics(agentId, network).catch(() => null);
			const eligible = !!metrics?.verified;
			return json(res, 200, {
				feed: feed ? shapeFeedRow(feed) : null,
				eligibility: {
					verified: eligible,
					score: metrics?.score ?? null,
					closed_trades: metrics?.closed_count ?? 0,
					unique_coins: metrics?.unique_coins ?? 0,
					churn_pct: metrics?.churn_pct ?? null,
					realized_pnl_sol: metrics?.realized_pnl_sol ?? null,
					requirements: { min_closed: 12, min_unique_coins: 5, max_churn_pct: 40, positive_realized: true },
				},
				solana_address: owned.meta.solana_address || null,
			});
		}

		const rows = await sql`
			select f.*, a.name as publisher_name
			from signal_feeds f join agent_identities a on a.id = f.publisher_agent_id
			where f.owner_user_id = ${userId}
			order by f.created_at desc
		`;
		return json(res, 200, { feeds: rows.map((f) => ({ ...shapeFeedRow(f), publisher_name: f.publisher_name })) });
	}

	// State-changing methods: CSRF for cookie sessions.
	if (auth.viaSession && !(await requireCsrf(req, res, userId))) return;

	// ── DELETE (soft pause) ─────────────────────────────────────────────────────
	if (req.method === 'DELETE') {
		const id = parseRowId(new URL(req.url, 'http://x').searchParams.get('id'));
		if (!id) return error(res, 400, 'invalid_id', 'numeric feed id required');
		const [row] = await sql`
			update signal_feeds set status = 'paused', updated_at = now()
			where id = ${id} and owner_user_id = ${userId} returning id
		`;
		if (!row) return error(res, 404, 'not_found', 'feed not found');
		return json(res, 200, { ok: true, id: Number(row.id), status: 'paused' });
	}

	// ── POST ────────────────────────────────────────────────────────────────────
	const body = await readJson(req).catch(() => null);
	if (!body) return error(res, 400, 'bad_request', 'JSON body required');

	// Pause / resume an existing feed.
	if (body.id && body.status && !body.agent_id) {
		const feedId = parseRowId(body.id);
		if (!feedId) return error(res, 400, 'invalid_id', 'numeric feed id required');
		const status = body.status === 'active' ? 'active' : 'paused';
		const [row] = await sql`
			update signal_feeds set status = ${status}, updated_at = now()
			where id = ${feedId} and owner_user_id = ${userId} returning *
		`;
		if (!row) return error(res, 404, 'not_found', 'feed not found');
		return json(res, 200, { feed: shapeFeedRow(row) });
	}

	const network = normNetwork(body.network);
	if (body.network && !NETWORKS.has(body.network)) return error(res, 400, 'invalid_network', 'network must be mainnet or devnet');

	const owned = await loadOwnedAgent(req, res, userId, body.agent_id);
	if (owned.error) return;

	const payoutAddress = owned.meta.solana_address;
	if (!payoutAddress) return error(res, 409, 'wallet_preparing', 'agent wallet is still being provisioned, try again shortly');

	// THE GATE: only a verified track record may publish.
	const metrics = await publisherMetrics(body.agent_id, network).catch(() => null);
	if (!metrics?.verified) {
		return error(res, 403, 'not_verified', 'Only a verified track record can publish signals.', {
			eligibility: {
				score: metrics?.score ?? null,
				closed_trades: metrics?.closed_count ?? 0,
				unique_coins: metrics?.unique_coins ?? 0,
				churn_pct: metrics?.churn_pct ?? null,
				realized_pnl_sol: metrics?.realized_pnl_sol ?? null,
				requirements: { min_closed: 12, min_unique_coins: 5, max_churn_pct: 40, positive_realized: true },
			},
		});
	}

	// Validate input.
	const title = String(body.title || owned.row.name || 'Signals').trim().slice(0, 80);
	const description = body.description != null ? String(body.description).trim().slice(0, 500) : null;
	const perSignal = Math.max(0, Math.min(MAX_USDC, num(body.price_per_signal_usdc)));
	const perEpoch = Math.max(0, Math.min(MAX_USDC, num(body.price_per_epoch_usdc)));
	if (perSignal <= 0 && perEpoch <= 0) {
		return error(res, 400, 'no_price', 'set a per-signal and/or per-epoch USDC price (one must be > 0)');
	}
	const epochSeconds = Math.round(Math.max(MIN_EPOCH_SECONDS, Math.min(MAX_EPOCH_SECONDS, num(body.epoch_seconds, 86400))));
	const minConviction = Math.max(0, Math.min(1, num(body.min_conviction)));
	const visibility = body.visibility === 'unlisted' ? 'unlisted' : 'public';
	const emitEntries = body.emit_entries !== false;
	const emitExits = body.emit_exits !== false;
	const revealSizing = body.reveal_sizing !== false;
	if (!emitEntries && !emitExits) return error(res, 400, 'no_emission', 'emit entries and/or exits (one must be on)');

	const slug = feedSlug(owned.row.name || title, body.agent_id, network);

	const [feed] = await sql`
		insert into signal_feeds
			(publisher_agent_id, owner_user_id, network, slug, title, description,
			 price_per_signal_usdc, price_per_epoch_usdc, epoch_seconds,
			 emit_entries, emit_exits, reveal_sizing, min_conviction, visibility, status, payout_address)
		values (${body.agent_id}, ${userId}, ${network}, ${slug}, ${title}, ${description},
			${perSignal}, ${perEpoch}, ${epochSeconds},
			${emitEntries}, ${emitExits}, ${revealSizing}, ${minConviction}, ${visibility}, 'active', ${payoutAddress})
		on conflict (publisher_agent_id, network) do update set
			title = excluded.title, description = excluded.description,
			price_per_signal_usdc = excluded.price_per_signal_usdc, price_per_epoch_usdc = excluded.price_per_epoch_usdc,
			epoch_seconds = excluded.epoch_seconds, emit_entries = excluded.emit_entries, emit_exits = excluded.emit_exits,
			reveal_sizing = excluded.reveal_sizing, min_conviction = excluded.min_conviction,
			visibility = excluded.visibility, status = 'active', payout_address = excluded.payout_address,
			updated_at = now()
		returning *
	`;
	return json(res, 200, { feed: shapeFeedRow(feed) });
});
