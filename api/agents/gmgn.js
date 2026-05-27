/**
 * GET /api/agents/gmgn-feed  → SSE stream of GMGN smart money events
 * GET /api/agents/gmgn       → (reserved for future JSON ops)
 *
 * Query params for the feed:
 *   chain         sol | eth | base | bsc     (default: sol)
 *   interval      1m | 5m | 1h | 6h | 24h   (default: 1h)
 *   minSmartBuys  number                     (default: 2)
 */

import { cors, method, error } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { connectGmgnFeed, recentGmgnBuffered } from '../_lib/gmgn-feed.js';

export default async function handler(req, res) {
	const _handler = req.query?._handler;
	if (_handler === 'feed') return handleFeed(req, res);

	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;
	res.statusCode = 200;
	res.setHeader('content-type', 'application/json; charset=utf-8');
	res.end(JSON.stringify({ ok: true, service: 'gmgn-smart-money' }));
}

async function handleFeed(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.mcpIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many feed connections');

	const url = new URL(req.url, 'http://x');
	const chain = url.searchParams.get('chain') || 'sol';
	const interval = url.searchParams.get('interval') || '1h';
	const minSmartBuys = Math.max(1, Number(url.searchParams.get('minSmartBuys')) || 2);

	const VALID_CHAINS = ['sol', 'eth', 'base', 'bsc', 'tron'];
	const VALID_INTERVALS = ['1m', '5m', '1h', '6h', '24h'];
	if (!VALID_CHAINS.includes(chain) || !VALID_INTERVALS.includes(interval)) {
		return error(res, 400, 'validation_error', 'invalid chain or interval');
	}

	res.statusCode = 200;
	res.setHeader('content-type', 'text/event-stream; charset=utf-8');
	res.setHeader('cache-control', 'no-store');
	res.setHeader('connection', 'keep-alive');
	res.setHeader('x-accel-buffering', 'no');
	res.flushHeaders?.();

	const started = Date.now();
	let active = true;
	req.on('close', () => { active = false; });

	const wsAbort = new AbortController();
	req.on('close', () => wsAbort.abort());

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
	writeSse(res, 'close', { reason: 'duration_limit' });
	res.end();
}

function writeSse(res, event, data) {
	res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}
