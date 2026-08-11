// robinhood-feed entry point. Starts the firehose orchestrator and the
// HTTP/WS/SSE server, wires them together, and shuts down cleanly on SIGINT.

import { config, redactRpcUrl } from './src/config.js';
import { probeRpcUrls } from './src/chain.js';
import { startFirehose } from './src/feed.js';
import { createServer } from './src/server.js';

let onEventRef = () => {};
const firehose = startFirehose((ev) => onEventRef(ev));
const { server, onEvent, close } = createServer(firehose);
onEventRef = onEvent;

server.listen(config.port, () => {
	console.log(`[robinhood-feed] ${config.network} · listening on :${config.port}`);
	console.log(`[robinhood-feed] rpc=${config.rpcUrls.map(redactRpcUrl).join(' → ')}`);
	console.log(`[robinhood-feed] feed=${config.useFeed ? config.feedUrl : 'disabled'}`);
	console.log('[robinhood-feed] SSE /events · WS /ws · status /healthz');
});

// One-shot reachability probe. The client falls back across these URLs on its
// own, so a dead rung is not fatal, but it must be visible, or an RPC that
// answers every call with an error (an Alchemy key whose app lacks the
// Robinhood network) reads as "the chain is quiet" instead of a misconfig.
probeRpcUrls().then((results) => {
	for (const r of results) {
		const label = redactRpcUrl(r.url);
		if (r.ok) console.log(`[robinhood-feed] rpc ok · ${label} · chain_id=${r.chain_id}`);
		else console.warn(`[robinhood-feed] rpc unusable · ${label} · ${r.error}`);
	}
	if (!results.some((r) => r.ok)) console.error('[robinhood-feed] no RPC answered, the feed will stay empty until one does');
}).catch(() => {});

function shutdown(sig) {
	console.log(`[robinhood-feed] ${sig} · shutting down`);
	try { firehose.stop(); } catch { /* ignore */ }
	close().then(() => process.exit(0), () => process.exit(0));
	setTimeout(() => process.exit(0), 3_000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
