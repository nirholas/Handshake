/**
 * GET /api/agents/gmgn-feed  → SSE stream of GMGN smart money events
 * GET /api/agents/gmgn       → one-shot JSON snapshot of the same board
 *
 * Both lanes read the same live source (the GMGN smart-money rank, failing over
 * to the DexScreener boosted board when Cloudflare refuses our egress IP) and
 * return the same normalized item shape. The SSE lane pushes changes as they
 * land; the JSON lane is for clients that cannot hold a stream open (server-side
 * fetches, agent tool calls, curl).
 *
 * Query params, identical on both lanes:
 *   chain         sol | eth | base | bsc | tron  (default: sol)
 *   interval      1m | 5m | 1h | 6h | 24h        (default: 1h)
 *   minSmartBuys  number                          (default: 2)
 *   limit         JSON lane only, 1-50            (default: 25)
 */

import { cors, json, method, error, wrap, rateLimited, serverError } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { connectGmgnFeed, recentGmgnBuffered, gmgnSmartMoneySnapshot } from '../_lib/gmgn-feed.js';

const VALID_CHAINS = ['sol', 'eth', 'base', 'bsc', 'tron'];
const VALID_INTERVALS = ['1m', '5m', '1h', '6h', '24h'];

// Shared query parsing so the two lanes can never drift on what they accept.
// Returns null after writing a 400 when the chain or interval is out of vocabulary.
function feedParams(req, res) {
	const url = new URL(req.url, 'http://x');
	const chain = url.searchParams.get('chain') || 'sol';
	const interval = url.searchParams.get('interval') || '1h';
	const minSmartBuys = Math.max(1, Number(url.searchParams.get('minSmartBuys')) || 2);
	const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 25));
	if (!VALID_CHAINS.includes(chain) || !VALID_INTERVALS.includes(interval)) {
		error(res, 400, 'validation_error', 'invalid chain or interval');
		return null;
	}
	return { chain, interval, minSmartBuys, limit };
}

export default wrap(async (req, res) => {
	const _handler = req.query?._handler;
	if (_handler === 'feed') return handleFeed(req, res);
	return handleSnapshot(req, res);
});

async function handleSnapshot(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const params = feedParams(req, res);
	if (!params) return;

	const snapshot = await gmgnSmartMoneySnapshot(params);
	if (!snapshot.ok) {
		return serverError(
			res,
			502,
			'upstream_error',
			new Error(`smart money rank unavailable (${snapshot.status || snapshot.error || 'no response'})`),
		);
	}

	return json(
		res,
		200,
		{
			data: {
				chain: params.chain,
				interval: params.interval,
				min_smart_buys: params.minSmartBuys,
				source: snapshot.source,
				count: snapshot.items.length,
				items: snapshot.items,
			},
		},
		{ 'cache-control': 'public, max-age=15, s-maxage=30' },
	);
}

async function handleFeed(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.mcpIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl, 'too many feed connections');

	const params = feedParams(req, res);
	if (!params) return;
	const { chain, interval, minSmartBuys } = params;

	res.statusCode = 200;
	res.setHeader('content-type', 'text/event-stream; charset=utf-8');
	res.setHeader('cache-control', 'no-store');
	res.setHeader('connection', 'keep-alive');
	res.setHeader('x-accel-buffering', 'no');
	res.flushHeaders?.();

	const started = Date.now();
	let active = true;
	const wsAbort = new AbortController();
	req.on('close', () => { active = false; wsAbort.abort(); });

	const queue = [];
	const stopFeed = connectGmgnFeed({
		chain, interval, minSmartBuys,
		signal: wsAbort.signal,
		onEvent: (ev) => { if (active) queue.push(ev); },
	});

	writeSse(res, 'hello', { chain, interval, minSmartBuys });

	// Replay recent buffer so a fresh client isn't blank
	const replay = recentGmgnBuffered({ limit: 10 });
	for (const ev of replay.slice().reverse()) {
		writeSse(res, ev.kind, { ...ev.data, replay: true });
	}

	while (active && Date.now() - started < 90_000) {
		while (queue.length > 0 && active) {
			const ev = queue.shift();
			writeSse(res, ev.kind, ev.data);
		}
		writeSse(res, 'ping', { t: Date.now() });
		await sleep(5_000);
	}

	stopFeed();
	if (active) writeSse(res, 'close', { reason: 'duration_limit' });
	res.end();
}

// The client can disconnect between any two writes, so a write to an already-torn-
// down socket is expected, not exceptional: swallow it rather than let it escape as
// an unhandled 5xx on a response whose headers are long gone.
function writeSse(res, event, data) {
	if (res.writableEnded || res.destroyed) return;
	try {
		res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
	} catch { /* client gone mid-stream */ }
}

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}
