/**
 * Oracle — live agent action stream (SSE).
 *
 *   GET /api/oracle/action-stream?network=mainnet&mode=live|simulate
 *
 * Polls oracle_watch_actions for rows inserted since a cursor (~3s) and fans
 * new entries + outcome updates to every connected client. This powers the
 * /activity trading-floor page with sub-5-second latency instead of 30s polling.
 *
 * Events:
 *   hello  — sent on connect with network + ts
 *   action — a new oracle_watch_actions row (entry or outcome update)
 *   settle — an existing action whose outcome just changed (win/loss/flat)
 *   ping   — keepalive every 15s
 *   bye    — server rotating the connection after MAX_DURATION_MS
 *
 * The client reconnects automatically via EventSource's built-in retry.
 * It passes `?since=<iso>` on reconnect so no events are missed.
 */

import { cors, method, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { sql } from '../_lib/db.js';
import { isoTimestamp } from '../_lib/validate.js';

const NETWORKS     = new Set(['mainnet', 'devnet']);
const MODES        = new Set(['live', 'simulate']);
const MAX_DURATION_MS = 90_000;
const PING_MS         = 15_000;
const POLL_MS         =  3_000;

function shapeAction(r) {
	return {
		id:                r.id,
		agent_id:          r.agent_id,
		agent_name:        r.agent_name || 'Agent',
		agent_image:       r.agent_image || r.agent_avatar || null,
		network:           r.network,
		mint:              r.mint,
		symbol:            r.symbol,
		conviction:        r.conviction   != null ? Number(r.conviction)        : null,
		tier:              r.tier,
		mode:              r.mode,
		size_sol:          r.size_sol     != null ? Number(r.size_sol)          : null,
		status:            r.status,
		outcome:           r.outcome      || 'open',
		peak_multiple:     r.peak_multiple    != null ? Number(r.peak_multiple)     : null,
		realized_pnl_sol:  r.realized_pnl_sol != null ? Number(r.realized_pnl_sol) : null,
		entry_mc_usd:      r.entry_mc_usd     != null ? Number(r.entry_mc_usd)      : null,
		reason:            r.reason       || null,
		tx_signature:      r.tx_signature || null,
		acted_at:          r.acted_at,
		settled_at:        r.settled_at   || null,
		pump_url:          `https://pump.fun/coin/${r.mint}`,
		agent_url:         `/agents/${r.agent_id}`,
		tx_url:            r.tx_signature ? `https://solscan.io/tx/${r.tx_signature}` : null,
	};
}

async function pollActions(network, mode, cursor, limit = 30) {
	const rows = await sql`
		select
			a.id, a.agent_id, a.network, a.mint, a.symbol,
			a.conviction, a.tier, a.mode, a.size_sol, a.status,
			a.outcome, a.peak_multiple, a.realized_pnl_sol,
			a.entry_mc_usd, a.reason, a.tx_signature,
			a.acted_at, a.settled_at,
			ai.name              as agent_name,
			ai.avatar_url        as agent_avatar,
			ai.profile_image_url as agent_image
		from oracle_watch_actions a
		left join agent_identities ai on ai.id = a.agent_id and ai.deleted_at is null
		where a.network = ${network}
		  and a.acted_at > ${cursor}::timestamptz
		  and ${mode ? sql`a.mode = ${mode}` : sql`true`}
		order by a.acted_at asc
		limit ${limit}
	`.catch(() => []);
	return rows;
}

// Poll for settlements: actions updated since cursor whose outcome is now resolved.
async function pollSettlements(network, cursor, limit = 20) {
	const rows = await sql`
		select
			a.id, a.agent_id, a.network, a.mint, a.symbol,
			a.conviction, a.tier, a.mode, a.size_sol, a.status,
			a.outcome, a.peak_multiple, a.realized_pnl_sol,
			a.entry_mc_usd, a.reason, a.tx_signature,
			a.acted_at, a.settled_at,
			ai.name              as agent_name,
			ai.avatar_url        as agent_avatar,
			ai.profile_image_url as agent_image
		from oracle_watch_actions a
		left join agent_identities ai on ai.id = a.agent_id and ai.deleted_at is null
		where a.network = ${network}
		  and a.settled_at > ${cursor}::timestamptz
		  and a.outcome in ('win', 'loss', 'flat')
		order by a.settled_at asc
		limit ${limit}
	`.catch(() => []);
	return rows;
}

export default async function handleActionStream(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.mcpIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url     = new URL(req.url, `http://${req.headers.host || 'x'}`);
	const network = NETWORKS.has(url.searchParams.get('network')) ? url.searchParams.get('network') : 'mainnet';
	const mode    = MODES.has(url.searchParams.get('mode'))       ? url.searchParams.get('mode')    : null;
	// Client passes `since` on reconnect to avoid gaps. Validate it BEFORE the
	// stream headers go out: an unparseable cursor makes every `::timestamptz`
	// cast below reject, both poll queries swallow that rejection, and the client
	// then holds an open stream that emits hello + ping forever and never a single
	// action. EventSource reconnects with the same bad cursor, so the stall is
	// permanent and silent. A 400 tells the caller what is actually wrong.
	const sinceParam = url.searchParams.get('since');
	const since      = sinceParam ? isoTimestamp(sinceParam) : null;
	if (sinceParam && !since) {
		return error(res, 400, 'validation_error', 'since must be an ISO 8601 timestamp');
	}
	let cursor    = since || new Date(Date.now() - 10_000).toISOString();
	let settleCursor = cursor;

	res.writeHead(200, {
		'Content-Type':    'text/event-stream; charset=utf-8',
		'Cache-Control':   'no-cache, no-transform',
		Connection:        'keep-alive',
		'X-Accel-Buffering': 'no',
	});
	res.flushHeaders?.();

	let active = true;
	const send = (event, data) => {
		if (!active || res.writableEnded) return;
		try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* client gone */ }
	};

	send('hello', { ts: Date.now(), network, mode: mode || 'all' });

	const poll = async () => {
		if (!active) return;
		try {
			const [actions, settles] = await Promise.all([
				pollActions(network, mode, cursor),
				pollSettlements(network, settleCursor),
			]);
			for (const r of actions) {
				send('action', shapeAction(r));
			}
			if (actions.length) cursor = actions[actions.length - 1].acted_at;
			for (const r of settles) {
				send('settle', shapeAction(r));
			}
			if (settles.length) settleCursor = settles[settles.length - 1].settled_at;
		} catch { /* transient — next tick */ }
	};

	const pollTimer = setInterval(poll, POLL_MS);
	const pingTimer = setInterval(() => send('ping', { ts: Date.now() }), PING_MS);
	const stopTimer = setTimeout(() => { send('bye', { reason: 'rotate', since: cursor }); cleanup(); }, MAX_DURATION_MS);

	function cleanup() {
		if (!active) return;
		active = false;
		clearInterval(pollTimer);
		clearInterval(pingTimer);
		clearTimeout(stopTimer);
		try { res.end(); } catch { /* already closed */ }
	}

	req.on('close', cleanup);
	req.on('error', cleanup);
}
