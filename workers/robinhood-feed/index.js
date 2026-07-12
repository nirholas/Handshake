// robinhood-feed entry point. Starts the firehose orchestrator and the
// HTTP/WS/SSE server, wires them together, and shuts down cleanly on SIGINT.

import { config } from './src/config.js';
import { startFirehose } from './src/feed.js';
import { createServer } from './src/server.js';

let onEventRef = () => {};
const firehose = startFirehose((ev) => onEventRef(ev));
const { server, onEvent } = createServer(firehose);
onEventRef = onEvent;

server.listen(config.port, () => {
	console.log(`[robinhood-feed] ${config.network} · listening on :${config.port}`);
	console.log(`[robinhood-feed] rpc=${config.rpcUrl}`);
	console.log(`[robinhood-feed] feed=${config.useFeed ? config.feedUrl : 'disabled'}`);
	console.log('[robinhood-feed] SSE /events · WS /ws · status /healthz');
});

function shutdown(sig) {
	console.log(`[robinhood-feed] ${sig} — shutting down`);
	try { firehose.stop(); } catch { /* ignore */ }
	server.close(() => process.exit(0));
	setTimeout(() => process.exit(0), 3_000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
