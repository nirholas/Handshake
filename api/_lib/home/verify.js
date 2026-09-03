/**
 * The handshake we run before we agree to store a home.
 *
 * Connecting is the one moment where we can tell the user something true and
 * specific about their instance, so we measure rather than assume: the Home
 * Assistant version, how many entities and areas it actually has, and whether
 * the optional `mcp_server` integration answers (and with how many tools). None
 * of that is inferred from the URL, the token, or a version string we hope is
 * there. If a capability is unknown we say unknown; we never claim one.
 *
 * The MCP probe is deliberately allowed to fail. `mcp_server` is an upgrade, not
 * a requirement: an instance without it is a perfectly good home, and the connect
 * screen offers the setting path rather than an error.
 */

import { connectHomeMcp, ERR, HomeBridge, HomeBridgeError, normalizeBaseUrl } from '@three-ws/home-bridge';

/** A house behind a slow tunnel is common; a hang is not. */
const CONNECT_TIMEOUT_MS = 15_000;
/** The optional channel gets a shorter leash: it must never dominate connect latency. */
const MCP_TIMEOUT_MS = 8_000;
/** The version lookup is a nicety: never let it hold up a connect. */
const CONFIG_TIMEOUT_MS = 5_000;

/**
 * Open a real connection, measure it, close it.
 *
 * @param {object} input
 * @param {string} input.baseUrl
 * @param {string} input.token
 * @param {number} [input.timeoutMs]
 * @returns {Promise<{ capabilities: object, graph: object }>}
 * @throws {HomeBridgeError} with the `ERR` vocabulary, so the route layer can
 *   map one table of codes instead of two.
 */
export async function verifyConnection({ baseUrl, token, timeoutMs = CONNECT_TIMEOUT_MS }) {
	// Throws BAD_URL before anything opens a socket, which is what lets the UI
	// refuse a LAN address without a network call.
	const { http } = normalizeBaseUrl(baseUrl);

	const bridge = new HomeBridge({ baseUrl: http, token });
	let graph;
	try {
		graph = await withTimeout(
			bridge.connect(),
			timeoutMs,
			() => new HomeBridgeError(ERR.UNREACHABLE, `${http} did not answer within ${Math.round(timeoutMs / 1000)} seconds. If it is only on your home network, three.ws cannot route to it.`),
		);
	} catch (err) {
		bridge.close();
		throw err;
	}

	try {
		const states = bridge.states || {};
		const entityCount = Object.keys(states).length;
		const [mcp, config] = await Promise.all([probeMcp({ baseUrl: http, token }), readConfig({ baseUrl: http, token })]);

		return {
			graph,
			capabilities: {
				websocket: true,
				entityCount,
				areaCount: graph?.rooms?.length ?? 0,
				floorCount: graph?.floors?.length ?? 0,
				macroCount: bridge.macros().length,
				haVersion: config.version,
				locationName: config.locationName,
				mcp: mcp.available,
				mcpToolCount: mcp.toolCount,
				mcpDetail: mcp.detail,
				measuredAt: new Date().toISOString(),
			},
		};
	} finally {
		bridge.close();
	}
}

/**
 * Home Assistant publishes its own version on the `zone.home`/`sun.sun`-style
 * state attributes only sporadically, but `persistent_notification` and the
 * config entry do not travel over subscribeEntities at all. The reliable place
 * on the state channel is any entity carrying the supervisor/core version
 * attribute; when nothing does, we return null rather than inventing a number.
 */
/**
 * Home Assistant's version, from the instance itself.
 *
 * Read from /api/config rather than scraped off entity attributes: a house full
 * of `update.*` entities publishes half a dozen `installed_version` attributes
 * belonging to add-ons and firmware, and picking one of those reports a
 * confident, wrong number to the user. An unreadable version is null, never a
 * guess, because the connect screen prints this verbatim.
 */
async function readConfig({ baseUrl, token }) {
	try {
		const res = await fetch(`${baseUrl}/api/config`, {
			headers: { authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(CONFIG_TIMEOUT_MS),
		});
		if (!res.ok) return { version: null, locationName: null };
		const body = await res.json();
		return {
			version: typeof body?.version === 'string' ? body.version : null,
			locationName: typeof body?.location_name === 'string' ? body.location_name : null,
		};
	} catch {
		// The state channel already proved the instance is reachable and the token
		// works, so a failure here costs a version string, not the connection.
		return { version: null, locationName: null };
	}
}

async function probeMcp({ baseUrl, token }) {
	try {
		const session = await withTimeout(
			connectHomeMcp({ baseUrl, token }),
			MCP_TIMEOUT_MS,
			() => new HomeBridgeError(ERR.NO_MCP, 'The MCP endpoint did not answer in time.'),
		);
		const toolCount = Array.isArray(session.tools) ? session.tools.length : 0;
		await session.close().catch(() => {});
		return { available: true, toolCount, detail: null };
	} catch (err) {
		// Not an error: the integration is simply not enabled, or this instance
		// does not expose it to this token. The connect screen offers the setting.
		return {
			available: false,
			toolCount: 0,
			detail: err instanceof HomeBridgeError && err.code === ERR.NO_MCP ? err.message : 'The Model Context Protocol Server integration did not answer.',
		};
	}
}

function withTimeout(promise, ms, makeError) {
	let timer;
	const timeout = new Promise((_resolve, reject) => {
		timer = setTimeout(() => reject(makeError()), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
