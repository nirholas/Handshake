// The one live connection to the user's house, shared by every tool.
//
// A stdio MCP server is a long-lived process serving one household, so the
// bridge is opened once on the first tool call and kept: the Home Assistant
// socket reconnects and resubscribes on its own, so a house that goes away for
// a minute comes back without the model noticing.

import { HomeBridge, HomeBridgeError, ERR } from '@three-ws/home-bridge';

let bridge = null;
let opening = null;

/** Env, read at call time so a test can set it and a shell export is honoured. */
export function config() {
	const baseUrl = process.env.HOME_ASSISTANT_URL || '';
	const token = process.env.HOME_ASSISTANT_TOKEN || '';
	const allowed = String(process.env.HOME_ALLOWED_ENTITIES || '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
	return { baseUrl, token, allowed };
}

/**
 * The bridge, connected.
 *
 * Missing credentials are an ordinary state with a designed answer, not a
 * stack trace: the operator has not told the server which house to talk to.
 */
export async function home() {
	if (bridge?.connected) return bridge;
	if (opening) return opening;

	const { baseUrl, token, allowed } = config();
	if (!baseUrl) {
		throw new HomeBridgeError(
			ERR.BAD_URL,
			'HOME_ASSISTANT_URL is not set. Point it at the https URL of your Home Assistant (Home Assistant Cloud, or your own reverse proxy).',
		);
	}
	if (!token) {
		throw new HomeBridgeError(
			ERR.AUTH,
			'HOME_ASSISTANT_TOKEN is not set. Create a long-lived access token in Home Assistant under your profile, Security, Long-lived access tokens.',
		);
	}

	opening = (async () => {
		const next = new HomeBridge({ baseUrl, token, allowedEntities: allowed });
		await next.connect();
		bridge = next;
		opening = null;
		return next;
	})();

	try {
		return await opening;
	} catch (err) {
		opening = null;
		throw err;
	}
}

/** Close the socket. Used by the process exit path and by the tests. */
export function closeHome() {
	bridge?.close();
	bridge = null;
	opening = null;
}
