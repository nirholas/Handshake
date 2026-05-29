// GET /api/pump/trades-stream — SSE live trade stream (PumpPortal proxy).
//
// Query:
//   ?mint=<base58>[,<base58>...]  stream buy/sell trades for those token(s)
//   (no mint)                     forward the global new-mint + graduation feed
//
// PumpPortal's subscribeTokenTrade is per-mint (there is no all-trades firehose),
// so a `mint` is required to receive trade events; without one we degrade to the
// public mint/graduation feed rather than emitting an empty stream.

import { cors, method } from '../_lib/http.js';
import { connectPumpFunFeed } from '../_lib/pumpfun-ws-feed.js';

const MAX_DURATION_MS = 90_000;
const PING_INTERVAL_MS = 15_000;
const MAX_MINTS = 20;

export default async function handleTradesStream(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	const url = new URL(req.url, `http://${req.headers.host || 'x'}`);
	const mints = (url.searchParams.get('mint') || '')
		.split(',')
		.map((m) => m.trim())
		.filter(Boolean)
		.slice(0, MAX_MINTS);
	const kind = mints.length ? 'trades' : 'all';

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

	const abort = new AbortController();
	const stop = connectPumpFunFeed({
		kind,
		mints,
		signal: abort.signal,
		onEvent: ({ kind: evKind, data }) => send(evKind, data),
	});

	send('open', { kind, mints, source: 'pumpportal' });

	const ping = setInterval(() => send('ping', { t: Date.now() }), PING_INTERVAL_MS);

	const teardown = () => {
		if (!active) return;
		active = false;
		clearInterval(ping);
		clearTimeout(durationTimer);
		abort.abort();
		stop();
		try { res.end(); } catch {}
	};

	const durationTimer = setTimeout(() => {
		send('close', { reason: 'duration_limit' });
		teardown();
	}, MAX_DURATION_MS);

	req.on('close', teardown);
}
