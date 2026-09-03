// The one live connection to the user's house, shared by every tool.
//
// A stdio MCP server is a long-lived process serving one household, so the
// bridge is opened once on the first tool call and then KEPT, including while it
// is disconnected. That last part is the whole design of this file.
//
// `home-assistant-js-websocket` reconnects and resubscribes on its own, so a
// house that drops off for a minute is a bridge whose `connected` reads false
// for a minute and then recovers by itself. Building a second bridge on that
// signal would abandon the first one mid-reconnect, with its retry loop still
// running and its socket still counted against the user's instance, and would do
// it again on the next blip. One connection per process, for the life of the
// process, is the correct number.
//
// What callers get instead of a reconnect race is the truth: `stale` says the
// room graph is the last one that arrived rather than the live one, so a tool
// can report "this is what the house looked like when it last answered" instead
// of presenting a cached house as a live one.

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
 * The bridge, connected at least once.
 *
 * Missing credentials are an ordinary state with a designed answer, not a stack
 * trace: the operator has not told the server which house to talk to.
 */
export async function home() {
	if (bridge) return bridge;
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

/**
 * Is the room graph the live house, or the last one that answered?
 *
 * Every tool that returns state reports this, because a cached house presented
 * as a live one is how an agent says "everything is locked" about a building it
 * has not heard from since Tuesday.
 *
 * @param {HomeBridge} live
 * @returns {{ connected: boolean, stale: boolean, note: string|null }}
 */
export function freshness(live) {
	const connected = Boolean(live?.connected);
	return {
		connected,
		stale: !connected,
		note: connected
			? null
			: 'The connection to this house has dropped and is retrying. What follows is the last state that arrived, not the live house. Say so rather than reporting it as current, and do not act on it without reading again.',
	};
}

/** The entities the operator pre-approved for guarded actions, if any. */
export function standingAllowances(live) {
	return live?.allowList?.list?.() || [];
}

/** Close the socket. Used by the process exit path and by the tests. */
export function closeHome() {
	bridge?.close();
	bridge = null;
	opening = null;
}
