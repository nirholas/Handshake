/**
 * Cloud Run entry point for the three.ws home relay.
 *
 * The relay is a long-lived WebSocket terminator, so it deploys with
 * --no-cpu-throttling and a min instance count: a house's dial-out socket has
 * to survive between platform requests, and a throttled container would let it
 * die and reconnect in a loop. See cloudbuild.yaml.
 */

import { createRelay } from './server.js';

const port = Number(process.env.PORT || 8080);
const relay = createRelay();

const address = await relay.listen(port);
console.log(JSON.stringify({ event: 'relay.listening', port: address.port }));

// Cloud Run sends SIGTERM before it takes an instance away. Closing the sockets
// ourselves tells every house to reconnect immediately instead of leaving them
// waiting out a heartbeat timeout against a container that is already gone.
for (const signal of ['SIGTERM', 'SIGINT']) {
	process.on(signal, () => {
		console.log(JSON.stringify({ event: 'relay.shutdown', signal, ...relay.stats() }));
		relay.close().then(() => process.exit(0), () => process.exit(1));
	});
}
