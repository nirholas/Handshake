// GET /api/pump/trades-stream — SSE live trade stream (PumpPortal proxy).
//
// Query:
//   ?mint=<base58>[,<base58>...]  stream buy/sell trades for those token(s)
//   (no mint)                     forward the global new-mint + graduation feed
//
// PumpPortal's subscribeTokenTrade is per-mint (there is no all-trades firehose),
// so a `mint` is required to receive trade events; without one we degrade to the
// public mint/graduation feed rather than emitting an empty stream.
//
// PumpPortal also gates subscribeTokenTrade behind an API key funded with at
// least 0.02 SOL. When it refuses the subscription the socket stays open and
// simply never delivers a trade, which reads to a viewer as a working-but-dead
// tape. We forward that refusal as an SSE `notice` event so consumers can show
// an honest degraded state instead of an empty panel and a lit "live" lamp.

import { cors, method, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { connectPumpFunFeed } from '../_lib/pumpfun-ws-feed.js';

const MAX_DURATION_MS = 90_000;
const PING_INTERVAL_MS = 15_000;
const MAX_MINTS = 20;
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export default async function handleTradesStream(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	// Each client connection opens an upstream PumpPortal WS — same bucket as
	// the [action].js live-stream path so one IP can't fan out connections.
	const rl = await limits.mcpIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, `http://${req.headers.host || 'x'}`);
	const requested = (url.searchParams.get('mint') || '')
		.split(',')
		.map((m) => m.trim())
		.filter(Boolean)
		.slice(0, MAX_MINTS);
	// Reject a malformed address at the boundary instead of opening a stream that
	// subscribes upstream to a key that cannot match anything.
	const invalid = requested.filter((m) => !BASE58_RE.test(m));
	if (invalid.length) {
		return error(res, 400, 'invalid_mint', `not a base58 Solana address: ${invalid[0]}`);
	}
	const mints = requested;
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

	// `open` first: it describes the stream a client is about to read, so it has
	// to precede anything the feed itself can emit (a refusal notice included).
	send('open', { kind, mints, source: 'pumpportal' });

	const abort = new AbortController();
	const stop = connectPumpFunFeed({
		kind,
		mints,
		signal: abort.signal,
		onEvent: ({ kind: evKind, data }) => send(evKind, data),
		onNotice: (notice) => send('notice', { ...notice, kind, mints }),
	});

	const ping = setInterval(() => send('ping', { t: Date.now() }), PING_INTERVAL_MS);

	const teardown = () => {
		if (!active) return;
		active = false;
		clearInterval(ping);
		clearTimeout(durationTimer);
		abort.abort();
		stop();
		try {
			res.end();
		} catch {}
	};

	const durationTimer = setTimeout(() => {
		send('close', { reason: 'duration_limit' });
		teardown();
	}, MAX_DURATION_MS);

	req.on('close', teardown);
}
