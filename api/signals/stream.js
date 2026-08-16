/**
 * GET /api/signals/stream?slug=<feed>&network=mainnet
 *
 * The PAID live feed of a publisher's emissions, as Server-Sent Events. Reads are
 * gated by entitlement: the caller must either own the publishing agent (the
 * publisher previews their own feed) or own an agent with an ACTIVE, non-killed
 * subscription to it, and that subscription is what settles the x402 USDC, so a
 * non-subscriber can never read the live alpha. Unentitled callers get a 402.
 *
 * Like the sniper stream, this DB-polls signal_emissions (Neon serverless HTTP
 * can't hold a LISTEN), emitting only signals minted after connect; the feed
 * detail endpoint supplies the historical backlog the page renders on load.
 *
 * Events: open, signal, ping, close.
 */

import { cors, method, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { sql } from '../_lib/db.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { normNetwork } from './_common.js';

const MAX_DURATION_MS = 90_000;
const PING_INTERVAL_MS = 15_000;
const POLL_INTERVAL_MS = 2_000;

function solscan(sig, network) {
	if (!sig || sig === 'SIMULATED') return null;
	return network === 'devnet' ? `https://solscan.io/tx/${sig}?cluster=devnet` : `https://solscan.io/tx/${sig}`;
}

function shape(e, network) {
	return {
		id: Number(e.id),
		side: e.side,
		mint: e.mint,
		symbol: e.symbol,
		name: e.name,
		size_multiple: e.size_multiple != null ? Number(e.size_multiple) : null,
		conviction: e.conviction != null ? Number(e.conviction) : null,
		entry_sol: e.entry_sol != null ? Number(e.entry_sol) : null,
		status: e.status,
		realized_pnl_pct: e.realized_pnl_pct != null ? Number(e.realized_pnl_pct) : null,
		outcome: e.outcome,
		buy_url: solscan(e.source_buy_sig, network),
		sell_url: solscan(e.source_sell_sig, network),
		emitted_at: e.emitted_at,
	};
}

export default async function handleSignalStream(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.mcpIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, `http://${req.headers.host || 'x'}`);
	const slug = url.searchParams.get('slug');
	if (!slug) return error(res, 400, 'invalid_slug', 'slug required');

	// Authenticate.
	const session = await getSessionUser(req);
	const bearer = session ? null : await authenticateBearer(extractBearer(req));
	const userId = session?.id ?? bearer?.userId;
	if (!userId) return error(res, 401, 'unauthorized', 'sign in required');

	const [feed] = await sql`select id, network, owner_user_id from signal_feeds where slug = ${slug} limit 1`;
	if (!feed) return error(res, 404, 'not_found', 'feed not found');
	// The slug is globally unique, so the ROW decides which cluster the emitted
	// explorer links point at. Trusting a caller-supplied `?network=` would hand a
	// mainnet feed's subscribers devnet solscan links that resolve to nothing.
	const network = normNetwork(feed.network);

	// Entitlement: publisher-owner OR an active, non-killed subscriber.
	let entitled = feed.owner_user_id === userId;
	if (!entitled) {
		const [sub] = await sql`
			select 1 from signal_subscriptions
			where feed_id = ${feed.id} and owner_user_id = ${userId} and status = 'active' and killed = false limit 1
		`;
		entitled = !!sub;
	}
	if (!entitled) {
		return error(res, 402, 'payment_required', 'subscribe to this feed to read its live signals');
	}

	res.writeHead(200, {
		'Content-Type': 'text/event-stream; charset=utf-8',
		'Cache-Control': 'no-cache, no-transform',
		Connection: 'keep-alive',
		'X-Accel-Buffering': 'no',
	});
	res.flushHeaders?.();

	let active = true;
	const send = (event, data) => {
		if (!active) return;
		res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
	};

	// Start from the current head so we stream only fresh emissions.
	let cursor = 0;
	try {
		const [head] = await sql`select coalesce(max(id),0) as head from signal_emissions where feed_id = ${feed.id}`;
		cursor = Number(head?.head || 0);
	} catch { cursor = 0; }

	const poll = async () => {
		if (!active) return;
		try {
			const rows = await sql`
				select id, side, mint, symbol, name, size_multiple, conviction, entry_sol, status,
				       realized_pnl_pct, outcome, source_buy_sig, source_sell_sig, emitted_at
				from signal_emissions
				where feed_id = ${feed.id} and id > ${cursor}
				order by id asc limit 100
			`;
			for (const r of rows) {
				send('signal', shape(r, network));
				if (Number(r.id) > cursor) cursor = Number(r.id);
			}
		} catch {
			send('error', { message: 'poll_failed' });
		}
	};

	send('open', { slug, network, source: 'signal-marketplace' });
	const pollTimer = setInterval(poll, POLL_INTERVAL_MS);
	const ping = setInterval(() => send('ping', { t: Date.now() }), PING_INTERVAL_MS);

	const teardown = () => {
		if (!active) return;
		active = false;
		clearInterval(pollTimer);
		clearInterval(ping);
		clearTimeout(durationTimer);
		try { res.end(); } catch {}
	};
	const durationTimer = setTimeout(() => {
		send('close', { reason: 'duration_limit' });
		teardown();
	}, MAX_DURATION_MS);

	req.on('close', teardown);
}
