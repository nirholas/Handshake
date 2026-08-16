/**
 * Signal subscriptions: the follower's control surface.
 *
 *   GET    /api/signals/subscribe                       list the caller's subscriptions
 *   POST   /api/signals/subscribe                       create / update a subscription
 *   POST   /api/signals/subscribe { id, status }        pause / resume / stop
 *   POST   /api/signals/subscribe { id, killed:true }   INSTANT kill (no further pay/trade)
 *   POST   /api/signals/subscribe { id, action:'sync' } deliver pending now (owner-triggered)
 *   DELETE /api/signals/subscribe?id=                   stop (soft, keeps delivery history)
 *
 * A subscriber agent's own custodial wallet pays the x402 USDC and signs the
 * mirror, so a subscription is owner-authenticated and scoped to an agent the
 * caller owns. `mode:'simulate'` mirrors WITHOUT paying or trading (trust-building);
 * `live` does both within the agent's spend policy. `killed` halts everything the
 * instant it is set: the kill is honoured before any payment or trade fires.
 */

import { cors, json, error, method, wrap, readJson, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { requireCsrf } from '../_lib/csrf.js';
import { sql } from '../_lib/db.js';
import { deliverSubscription } from '../_lib/signal-engine.js';
import { requireUser, loadOwnedAgent, normNetwork, parseRowId } from './_common.js';

function num(v, fallback) { const n = Number(v); return Number.isFinite(n) ? n : fallback; }

function shapeSub(s) {
	return {
		id: Number(s.id),
		subscriber_agent_id: s.subscriber_agent_id,
		feed_id: Number(s.feed_id),
		network: s.network,
		mode: s.mode,
		billing: s.billing,
		base_sol: num(s.base_sol, 0),
		size_scaling: num(s.size_scaling, 1),
		max_per_trade_sol: num(s.max_per_trade_sol, 0),
		slippage_bps: num(s.slippage_bps, 300),
		firewall_level: s.firewall_level,
		copy_exits: s.copy_exits,
		status: s.status,
		killed: s.killed,
		epoch_paid_until: s.epoch_paid_until || null,
		last_emission_id: Number(s.last_emission_id || 0),
		created_at: s.created_at,
		updated_at: s.updated_at,
	};
}

async function listForUser(userId) {
	const rows = await sql`
		select s.*, f.slug as feed_slug, f.title as feed_title,
		       f.price_per_signal_usdc, f.price_per_epoch_usdc, f.epoch_seconds,
		       a.name as publisher_name, a.profile_image_url as publisher_image, a.avatar_url as publisher_avatar,
		       sub.name as subscriber_name,
		       (select count(*) from signal_deliveries d where d.subscription_id = s.id and d.mirror_status = 'executed') as executed,
		       (select count(*) from signal_deliveries d where d.subscription_id = s.id and d.payment_status = 'paid') as paid_count,
		       (select coalesce(sum(d.payment_usdc),0) from signal_deliveries d where d.subscription_id = s.id and d.payment_status = 'paid') as usdc_spent
		from signal_subscriptions s
		join signal_feeds f on f.id = s.feed_id
		join agent_identities a on a.id = f.publisher_agent_id
		join agent_identities sub on sub.id = s.subscriber_agent_id
		where s.owner_user_id = ${userId}
		order by s.created_at desc
	`;
	return rows.map((s) => ({
		...shapeSub(s),
		feed: { slug: s.feed_slug, title: s.feed_title, publisher_name: s.publisher_name, publisher_image: s.publisher_image || s.publisher_avatar || null,
			price_per_signal_usdc: num(s.price_per_signal_usdc, 0), price_per_epoch_usdc: num(s.price_per_epoch_usdc, 0), epoch_seconds: num(s.epoch_seconds, 86400) },
		subscriber_name: s.subscriber_name,
		stats: { executed: Number(s.executed) || 0, paid_count: Number(s.paid_count) || 0, usdc_spent: Number(s.usdc_spent) || 0 },
	}));
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,DELETE,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'POST', 'DELETE'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const auth = await requireUser(req, res);
	if (!auth) return;
	const { userId } = auth;

	if (req.method === 'GET') {
		return json(res, 200, { subscriptions: await listForUser(userId) });
	}

	if (auth.viaSession && !(await requireCsrf(req, res, userId))) return;

	if (req.method === 'DELETE') {
		const id = parseRowId(new URL(req.url, 'http://x').searchParams.get('id'));
		if (!id) return error(res, 400, 'invalid_id', 'numeric subscription id required');
		const [row] = await sql`
			update signal_subscriptions set status = 'stopped', updated_at = now()
			where id = ${id} and owner_user_id = ${userId} returning id
		`;
		if (!row) return error(res, 404, 'not_found', 'subscription not found');
		return json(res, 200, { ok: true, id: Number(row.id), status: 'stopped' });
	}

	const body = await readJson(req).catch(() => null);
	if (!body) return error(res, 400, 'bad_request', 'JSON body required');

	// ── Mutations on an existing subscription (status / kill / sync) ────────────
	if (body.id && !body.feed_id) {
		const subId = parseRowId(body.id);
		if (!subId) return error(res, 400, 'invalid_id', 'numeric subscription id required');
		// Instant kill: the halt path, takes precedence.
		if (body.killed != null) {
			const killed = body.killed === true || body.killed === 'true';
			const [row] = await sql`
				update signal_subscriptions set killed = ${killed}, status = ${killed ? 'paused' : 'active'}, updated_at = now()
				where id = ${subId} and owner_user_id = ${userId} returning *
			`;
			if (!row) return error(res, 404, 'not_found', 'subscription not found');
			return json(res, 200, { subscription: shapeSub(row) });
		}
		if (body.action === 'sync') {
			const [row] = await sql`select * from signal_subscriptions where id = ${subId} and owner_user_id = ${userId} limit 1`;
			if (!row) return error(res, 404, 'not_found', 'subscription not found');
			const result = await deliverSubscription(row, { maxEvents: 10 });
			return json(res, 200, { ok: true, ...result });
		}
		if (body.status) {
			const status = ['active', 'paused', 'stopped'].includes(body.status) ? body.status : 'paused';
			// Resuming clears any kill; pausing/stopping leaves the kill flag untouched.
			const [row] = status === 'active'
				? await sql`
					update signal_subscriptions set status = 'active', killed = false, updated_at = now()
					where id = ${subId} and owner_user_id = ${userId} returning *`
				: await sql`
					update signal_subscriptions set status = ${status}, updated_at = now()
					where id = ${subId} and owner_user_id = ${userId} returning *`;
			if (!row) return error(res, 404, 'not_found', 'subscription not found');
			return json(res, 200, { subscription: shapeSub(row) });
		}
		return error(res, 400, 'no_op', 'nothing to update');
	}

	// ── Create / update a subscription ──────────────────────────────────────────
	if (!body.feed_id) return error(res, 400, 'invalid_feed', 'feed_id required');
	const feedId = parseRowId(body.feed_id);
	if (!feedId) return error(res, 400, 'invalid_feed', 'numeric feed_id required');
	const owned = await loadOwnedAgent(req, res, userId, body.agent_id);
	if (owned.error) return;

	const [feed] = await sql`select * from signal_feeds where id = ${feedId} limit 1`;
	if (!feed) return error(res, 404, 'feed_not_found', 'feed not found');
	if (feed.status !== 'active') return error(res, 409, 'feed_inactive', 'this feed is not active');
	if (feed.publisher_agent_id === body.agent_id) return error(res, 400, 'self_subscribe', 'an agent cannot subscribe to its own feed');

	const network = normNetwork(feed.network);
	const mode = body.mode === 'live' ? 'live' : 'simulate';
	const billing = body.billing === 'per_epoch' ? 'per_epoch' : 'per_signal';
	const baseSol = Math.max(0.001, Math.min(10, num(body.base_sol, 0.05)));
	const sizeScaling = Math.max(0.01, Math.min(20, num(body.size_scaling, 1)));
	const maxPerTrade = Math.max(0.001, Math.min(50, num(body.max_per_trade_sol, 0.25)));
	const slippageBps = Math.round(Math.max(0, Math.min(5000, num(body.slippage_bps, 300))));
	const firewallLevel = body.firewall_level === 'warn' ? 'warn' : 'block';
	const copyExits = body.copy_exits !== false;

	// New subscriptions start at the current emission head: never charged for or
	// made to mirror a backlog of signals emitted before they subscribed.
	const [head] = await sql`select coalesce(max(id),0) as head from signal_emissions where feed_id = ${feed.id}`;
	const startCursor = Number(head?.head || 0);

	const [sub] = await sql`
		insert into signal_subscriptions
			(subscriber_agent_id, owner_user_id, feed_id, network, mode, billing,
			 base_sol, size_scaling, max_per_trade_sol, slippage_bps, firewall_level, copy_exits, status, killed, last_emission_id)
		values (${body.agent_id}, ${userId}, ${feed.id}, ${network}, ${mode}, ${billing},
			${baseSol}, ${sizeScaling}, ${maxPerTrade}, ${slippageBps}, ${firewallLevel}, ${copyExits}, 'active', false, ${startCursor})
		on conflict (subscriber_agent_id, feed_id) do update set
			mode = excluded.mode, billing = excluded.billing, base_sol = excluded.base_sol,
			size_scaling = excluded.size_scaling, max_per_trade_sol = excluded.max_per_trade_sol,
			slippage_bps = excluded.slippage_bps, firewall_level = excluded.firewall_level,
			copy_exits = excluded.copy_exits, status = 'active', killed = false, updated_at = now()
		returning *
	`;
	return json(res, 200, { subscription: shapeSub(sub) });
});
