#!/usr/bin/env node
/**
 * Entry point. One binary, two roles.
 *
 *   node src/index.js satellite   run beside Home Assistant (the default)
 *   node src/index.js hub         run the hosted room server
 *
 * Everything is configurable by environment variable so the container needs no
 * arguments; the flags exist because reading a `docker run` line with eight
 * `-e` switches is worse than reading one with eight flags.
 */

import { createSatelliteService, createHubService, SERVICE_VERSION } from './server.js';

const argv = process.argv.slice(2);
const role = argv.find((a) => !a.startsWith('-')) || process.env.SATELLITE_ROLE || 'satellite';
const flag = (name, fallback) => {
	const i = argv.indexOf(`--${name}`);
	return i === -1 ? fallback : argv[i + 1];
};

if (argv.includes('--help') || argv.includes('-h')) {
	process.stdout.write(`three.ws home satellite ${SERVICE_VERSION}

  node src/index.js satellite [flags]
    --pairing-code <code>   redeem a code from three.ws/home/satellite (first run only)
    --name <name>           what Home Assistant calls this satellite
    --area <area>           suggested area for the device
    --api-base <url>        three.ws base URL (default https://three.ws)
    --state-dir <dir>       where the claimed identity is written (default ./.satellite)
    --wyoming-port <port>   TCP port Home Assistant connects to (default 10700)
    --viewer-port <port>    HTTP/WebSocket port browsers on this network use (default 10701)
    --no-hub                do not dial out; LAN viewers only

  node src/index.js hub [flags]
    --port <port>           listen port (default 8080, or $PORT)

  node src/index.js token   print a viewer token for the LAN path and exit
`);
	process.exit(0);
}

const log = (entry) => console.log(JSON.stringify({ ts: new Date().toISOString(), ...entry }));

if (role === 'hub') {
	const service = await createHubService({ port: Number(flag('port', process.env.PORT || 8080)), log });
	for (const signal of ['SIGTERM', 'SIGINT']) {
		process.on(signal, () => {
			log({ level: 'info', event: 'hub.shutdown', signal, ...service.stats() });
			service.close().then(() => process.exit(0), () => process.exit(1));
		});
	}
} else {
	const service = await createSatelliteService({
		stateDir: flag('state-dir', process.env.SATELLITE_STATE_DIR || './.satellite'),
		apiBase: flag('api-base', process.env.THREE_WS_API_BASE || 'https://three.ws'),
		pairingCode: flag('pairing-code', process.env.THREE_WS_PAIRING_CODE || null),
		name: flag('name', process.env.SATELLITE_NAME || 'three.ws agent'),
		area: flag('area', process.env.SATELLITE_AREA || null),
		wyomingPort: Number(flag('wyoming-port', process.env.WYOMING_PORT || 10700)),
		viewerPort: Number(flag('viewer-port', process.env.VIEWER_PORT || 10701)),
		hub: !argv.includes('--no-hub') && process.env.SATELLITE_HUB !== 'off',
		log,
	});

	if (role === 'token') {
		const token = service.viewerToken(3600);
		await service.close();
		if (!token) {
			console.error('this satellite has not been paired, so it has no room to hand out tokens for');
			process.exit(1);
		}
		process.stdout.write(`${token}\n`);
		process.exit(0);
	}

	const health = service.health();
	log({ level: 'info', event: 'satellite.ready', ...health });
	if (!health.paired) {
		// Stay up. An unpaired satellite still answers its health endpoint and
		// still tells a connecting Home Assistant exactly why it is refusing, and
		// both of those are more useful than a container that exits on boot.
		log({ level: 'warn', event: 'satellite.unpaired', message: health.pairing_error });
	}

	for (const signal of ['SIGTERM', 'SIGINT']) {
		process.on(signal, () => {
			log({ level: 'info', event: 'satellite.shutdown', signal });
			service.close().then(() => process.exit(0), () => process.exit(1));
		});
	}
}
