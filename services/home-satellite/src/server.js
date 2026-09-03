/**
 * The service. Composes everything into the two shapes it deploys in.
 *
 *   createSatelliteService()  runs beside Home Assistant, on the user's own
 *                             network. It listens for Wyoming on TCP, serves
 *                             viewers on the LAN, and optionally dials out to a
 *                             hub so a browser on https://three.ws can watch.
 *
 *   createHubService()        runs on Cloud Run. It joins satellites to viewers
 *                             and does nothing else.
 *
 * Everything about the satellite is local-first by construction. The Wyoming
 * socket, the pipeline, the microphone and the speaker never leave the house.
 * The hub carries the face and only the face; unplug it and the voice assistant
 * keeps working exactly as it did before three.ws was installed.
 */

import { WyomingSatellite } from './satellite.js';
import { createViewerServer, createHub, createHubLink } from './bridge.js';
import { loadIdentity, saveIdentity, claimPairingCode, refreshHubToken } from './pairing.js';
import { signToken, ROLE } from './token.js';
import { WYOMING_VERSION } from './protocol.js';

export const SERVICE_VERSION = '1.0.0';

/** Refresh the hub token this long before it expires. */
const HUB_TOKEN_LEAD_SECONDS = 600;

const stamp = (entry) => JSON.stringify({ ts: new Date().toISOString(), ...entry });

/**
 * @param {object} options
 * @param {string} [options.stateDir]        Where the identity is persisted.
 * @param {string} [options.apiBase]         three.ws base URL.
 * @param {string|null} [options.pairingCode] Redeemed once, on first start.
 * @param {string} [options.name]
 * @param {string|null} [options.area]
 * @param {number} [options.wyomingPort=10700]
 * @param {number} [options.viewerPort=10701]
 * @param {string} [options.host='0.0.0.0']
 * @param {boolean} [options.hub=true]       Dial out so https browsers can attach.
 * @param {(entry: object) => void} [options.log]
 * @param {typeof fetch} [options.fetchImpl]
 */
export async function createSatelliteService({
	stateDir = process.env.SATELLITE_STATE_DIR || './.satellite',
	apiBase = process.env.THREE_WS_API_BASE || 'https://three.ws',
	pairingCode = process.env.THREE_WS_PAIRING_CODE || null,
	name = process.env.SATELLITE_NAME || 'three.ws agent',
	area = process.env.SATELLITE_AREA || null,
	wyomingPort = Number(process.env.WYOMING_PORT || 10700),
	viewerPort = Number(process.env.VIEWER_PORT || 10701),
	host = process.env.BIND_HOST || '0.0.0.0',
	hub = process.env.SATELLITE_HUB !== 'off',
	log = (entry) => console.log(stamp(entry)),
	fetchImpl = fetch,
} = {}) {
	let identity = await loadIdentity(stateDir);
	let pairingError = null;

	if (!identity && pairingCode) {
		log({ level: 'info', event: 'pairing.claiming' });
		try {
			identity = await claimPairingCode({ apiBase, code: pairingCode, name, version: SERVICE_VERSION, area, fetchImpl });
			await saveIdentity(stateDir, identity);
			log({ level: 'info', event: 'pairing.claimed', satellite_id: identity.satellite_id, agent: identity.agent?.name || null });
		} catch (err) {
			pairingError = err.message;
			log({ level: 'error', event: 'pairing.failed', message: err.message, code: err.code || null });
		}
	} else if (!identity) {
		pairingError = 'no pairing code was supplied and no identity has been claimed';
		log({ level: 'error', event: 'pairing.missing' });
	}

	const paired = !!identity;
	const displayName = identity?.name || name;

	// Declared before the satellite is constructed, not after: the satellite is
	// handed `hasViewer` and starts listening in the same tick, and a reference
	// that is still in its temporal dead zone when the first socket lands throws
	// instead of answering.
	let viewerServer = null;
	let viewerAddress = null;
	let hubLink = null;
	let hubRefresh = null;
	const viewerCount = () => (viewerServer?.viewers || 0) + (hubLink?.connected ? 1 : 0);
	const satellite = new WyomingSatellite({
		name: displayName,
		description: identity?.agent?.name
			? `${identity.agent.name}, a three.ws agent with a face, a voice and a body`
			: 'A three.ws agent with a face, a voice and a body',
		version: SERVICE_VERSION,
		area,
		paired,
		hasViewer: () => viewerCount() > 0,
	});
	satellite.on('log', log);
	satellite.on('state', ({ state, detail }) => log({ level: 'debug', event: 'satellite.state', state, detail }));

	const wyomingAddress = await satellite.listen(wyomingPort, host);
	log({ level: 'info', event: 'wyoming.listening', port: wyomingAddress.port, paired });

	const identityForViewer = {
		name: displayName,
		agent: identity?.agent || null,
		version: SERVICE_VERSION,
	};

	if (paired) {
		viewerServer = createViewerServer({
			satellite,
			satelliteId: identity.satellite_id,
			secret: identity.secret,
			identity: identityForViewer,
			onLog: log,
		});
		viewerAddress = await viewerServer.listen(viewerPort, host);
		log({ level: 'info', event: 'viewer.listening', port: viewerAddress.port });

		if (hub && identity.hub_url) {
			// The token is read fresh on every dial, so a reconnect after a long
			// outage picks up whatever the refresh loop last stored rather than
			// replaying an expired one.
			hubLink = createHubLink({
				satellite,
				url: identity.hub_url,
				token: () => identity.hub_token,
				identity: identityForViewer,
				onLog: log,
			});

			const refresh = async () => {
				try {
					const next = await refreshHubToken({ identity, fetchImpl });
					identity = { ...identity, ...next };
					await saveIdentity(stateDir, identity);
					log({ level: 'info', event: 'hub.token_refreshed', expires: identity.hub_token_exp });
				} catch (err) {
					log({ level: 'warn', event: 'hub.token_refresh_failed', message: err.message });
				}
			};
			const schedule = () => {
				const seconds = Math.max(60, (identity.hub_token_exp || 0) - Math.floor(Date.now() / 1000) - HUB_TOKEN_LEAD_SECONDS);
				hubRefresh = setTimeout(async () => {
					await refresh();
					schedule();
				}, seconds * 1000);
				hubRefresh.unref?.();
			};
			schedule();
		}
	}

	return {
		satellite,
		identity,
		wyomingPort: wyomingAddress.port,
		viewerPort: viewerAddress?.port ?? null,
		/**
		 * Mint a viewer token for the LAN path. A browser on the same network as
		 * the house can attach with this and never touch three.ws at all.
		 * @param {number} [ttlSeconds=900]
		 */
		viewerToken(ttlSeconds = 900) {
			if (!identity) return null;
			return signToken({ sid: identity.satellite_id, role: ROLE.VIEWER }, identity.secret, ttlSeconds);
		},
		health() {
			return {
				ok: paired,
				service: 'home-satellite',
				version: SERVICE_VERSION,
				wyoming: WYOMING_VERSION,
				paired,
				pairing_error: pairingError,
				satellite_id: identity?.satellite_id || null,
				agent: identity?.agent || null,
				hub_connected: !!hubLink?.connected,
				viewers: viewerCount(),
				...satellite.snapshot(),
			};
		},
		async close() {
			if (hubRefresh) clearTimeout(hubRefresh);
			hubLink?.close();
			await viewerServer?.close();
			await satellite.close();
		},
	};
}

/**
 * @param {object} options
 * @param {string} [options.secret]  Hub token signing key.
 * @param {number} [options.port]
 * @param {(entry: object) => void} [options.log]
 */
export async function createHubService({
	secret = process.env.HOME_SATELLITE_HUB_SECRET,
	port = Number(process.env.PORT || 8080),
	log = (entry) => console.log(stamp(entry)),
} = {}) {
	if (!secret) throw new Error('createHubService: HOME_SATELLITE_HUB_SECRET is required');
	const hub = createHub({ secret, onLog: log });
	const address = await hub.listen(port);
	log({ level: 'info', event: 'hub.listening', port: address.port });
	return { hub, port: address.port, stats: hub.stats, close: () => hub.close() };
}
