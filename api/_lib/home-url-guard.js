// The one place a user-supplied Home Assistant URL is allowed to become a socket.
//
// A home connection record carries a base URL the user typed. Our servers then
// dial it from inside the production network, on three different channels:
//
//   1. the state WebSocket   wss://<host>/api/websocket
//   2. the MCP channel       https://<host>/api/mcp   (streamable HTTP)
//   3. plain REST probes     https://<host>/api/config, /api/states, ...
//
// That is a textbook SSRF surface with a physical actuator behind it: the URL is
// attacker-controlled, the dial happens with our network identity, and the
// response is relayed back to the caller. Cloud metadata (169.254.169.254),
// loopback, and RFC1918 are all one string away.
//
// packages/home-bridge/src/url.js already normalizes the URL and knows which
// hostnames are unroutable, but a hostname check alone is not a security
// control: DNS decides what a name means, and it can mean 93.184.216.34 during
// validation and 169.254.169.254 a millisecond later at connect time. So this
// module resolves the name ONCE, rejects the connection if any resolved address
// is private, and hands back a dispatcher pinned to exactly those addresses.
// Every one of the three channels above takes that dispatcher, which is what
// closes the check-then-connect window rather than narrowing it.
//
// The primitives come from api/_lib/ssrf.js (the same guard the x402 proxy and
// the model fetcher use). This module is the home lane's spelling of them, so
// there is one function to call and no room to compose them wrongly.

import { normalizeBaseUrl } from '../../packages/home-bridge/src/url.js';
import { isPrivateAddress, pinnedAgent, resolvePublicHost, SsrfError } from './ssrf.js';

/**
 * Refusal to dial a home. `code` is stable and safe to branch on; `message` is
 * written for the person who typed the URL, because most refusals here are not
 * attacks at all: they are somebody entering `homeassistant.local`, which is the
 * single most common thing a real user types and is genuinely unroutable from a
 * public server.
 */
export class HomeUrlError extends Error {
	constructor(code, message) {
		super(message);
		this.name = 'HomeUrlError';
		this.code = code;
	}
}

/** Refusals that mean "your house is on a LAN", not "you are attacking us". */
export const REACHABILITY_CODES = new Set(['private_address', 'unroutable_host']);

// The connect probe talks to a home that may be a residential uplink on the far
// side of a reverse proxy. Ten seconds is long enough for that and short enough
// that a black-holed address cannot pin a request for its whole lifetime.
const DIAL_TIMEOUT_MS = 10_000;

/**
 * Validate a user-supplied Home Assistant base URL and resolve it to a pinned
 * set of public addresses. Throws HomeUrlError on anything we refuse to dial.
 *
 * @param {string} rawBaseUrl the URL as the user typed it
 * @param {object} [options]
 * @param {boolean} [options.allowHttp] permit plain http. Off by default: a
 *   token that opens a building does not travel in clear text. Callers that dial
 *   a local instance from a developer machine pass it explicitly.
 * @returns {Promise<{http: string, ws: string, origin: string, host: string, secure: boolean, addresses: Array<{address: string, family: number}>}>}
 */
export async function assertDialableHomeUrl(rawBaseUrl, { allowHttp = false } = {}) {
	// A literal private address is checked before anything else, so that a
	// redirect to http://169.254.169.254/ is reported as what it is rather than
	// as a scheme complaint. The order matters for the operator reading the log,
	// and for the caller branching on REACHABILITY_CODES.
	const literalHost = literalHostOf(rawBaseUrl);
	if (literalHost) {
		const family = literalHost.includes(':') ? 6 : 4;
		if (isPrivateAddress(literalHost, family)) {
			throw new HomeUrlError(
				'private_address',
				`${literalHost} is a private address. A three.ws server on the public internet cannot route to it. Use your remote https URL, or connect the add-on so your house dials out to us instead.`,
			);
		}
	}

	let normalized;
	try {
		normalized = normalizeBaseUrl(rawBaseUrl, { requireSecure: !allowHttp });
	} catch (err) {
		throw new HomeUrlError('bad_url', err?.message || 'That is not a Home Assistant URL.');
	}

	const url = new URL(normalized.http);

	let addresses;
	try {
		addresses = await resolvePublicHost(url.hostname);
	} catch (err) {
		throw toHomeUrlError(err, url.hostname);
	}

	return {
		http: normalized.http,
		ws: normalized.ws,
		origin: normalized.origin,
		host: url.hostname,
		secure: normalized.secure,
		addresses,
	};
}

/**
 * An undici dispatcher that will only ever open a socket to the addresses the
 * validation above approved, for the host it approved them for.
 *
 * @param {{host: string, addresses: Array<{address: string, family: number}>}} pin
 */
export function homeDispatcher(pin) {
	return pinnedAgent(pin.host, pin.addresses);
}

/**
 * A pinned WebSocket to the home's state channel.
 *
 * Node's global WebSocket is undici's, and it honours a `dispatcher`, so the
 * same pin that protects our HTTP calls protects the socket. Verified against a
 * live Home Assistant: the pinned lookup is consulted for the socket handshake.
 * This matters more than the HTTP path does, because the socket is the channel
 * that stays open for the life of the connection.
 *
 * `home-assistant-js-websocket` takes this as its `createSocket` option, so the
 * bridge runtime never constructs a raw socket of its own.
 *
 * @param {{host: string, addresses: Array<{address: string, family: number}>}} pin
 * @param {string} wsUrl the ws:// or wss:// URL from assertDialableHomeUrl
 * @param {string[]} [protocols]
 */
export function pinnedHomeSocket(pin, wsUrl, protocols = []) {
	const target = new URL(wsUrl);
	if (target.hostname !== pin.host) {
		throw new HomeUrlError('host_pin_mismatch', 'Refusing to open a socket to a host we did not validate.');
	}
	return new WebSocket(wsUrl, { protocols, dispatcher: homeDispatcher(pin) });
}

/**
 * SSRF-guarded fetch against a validated home.
 *
 * Redirects are followed by hand, and every hop is re-validated and re-pinned:
 * a home that answers `302 Location: http://169.254.169.254/` is refused at the
 * hop, not at the first request, which is the case a `redirect: 'follow'` fetch
 * gets wrong silently.
 *
 * @param {{host: string, addresses: Array<{address: string, family: number}>}} pin
 * @param {string} url an absolute URL on the pinned home
 * @param {object} [init] fetch init, plus `timeoutMs` and `maxRedirects`
 */
export async function homeFetch(pin, url, init = {}) {
	const { timeoutMs = DIAL_TIMEOUT_MS, maxRedirects = 2, fetchImpl = fetch, ...rest } = init;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	let current = new URL(url);
	// A home reached over plain http (a developer instance, or the add-on relay's
	// loopback leg) may follow its own same-origin redirects; everything else is
	// held to https from the first hop on.
	let currentPin = { ...pin, allowHttp: pin.allowHttp ?? pin.secure === false };
	let dispatcher = homeDispatcher(currentPin);
	let hops = 0;

	try {
		while (true) {
			if (current.hostname !== currentPin.host) {
				throw new HomeUrlError('host_pin_mismatch', 'Refusing to dial a host we did not validate.');
			}
			const res = await fetchImpl(current, {
				...rest,
				redirect: 'manual',
				signal: controller.signal,
				dispatcher,
			});

			const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
			if (!location) return res;

			if (++hops > maxRedirects) {
				throw new HomeUrlError('too_many_redirects', 'That home redirected too many times.');
			}
			const next = new URL(location, current);
			// The redirect target is a fresh untrusted URL. It gets the whole
			// validation again, including its own DNS resolution and its own pin.
			// A same-origin hop inherits the origin's scheme allowance; a hop to
			// anywhere else is held to https, because a home that bounces us to a
			// new host in clear text is not a home we dial.
			const revalidated = await assertDialableHomeUrl(next.origin, {
				allowHttp: next.hostname === currentPin.host && next.protocol === 'http:' && currentPin.allowHttp === true,
			});
			currentPin = {
				host: revalidated.host,
				addresses: revalidated.addresses,
				secure: revalidated.secure,
				allowHttp: currentPin.allowHttp === true && next.hostname === currentPin.host,
			};
			await dispatcher.close().catch(() => {});
			dispatcher = homeDispatcher(currentPin);
			current = next;
		}
	} finally {
		clearTimeout(timer);
		await dispatcher.close().catch(() => {});
	}
}

// The bare IP literal a URL points at, or null when it names a host. Parsed
// leniently (the user may have typed no scheme at all) because this runs before
// normalizeBaseUrl has had a chance to reject anything.
function literalHostOf(rawBaseUrl) {
	const raw = String(rawBaseUrl ?? '').trim();
	if (!raw) return null;
	const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
	let hostname;
	try {
		hostname = new URL(withScheme).hostname;
	} catch {
		return null;
	}
	const bare = hostname.replace(/^\[|\]$/g, '');
	if (/^\d{1,3}(\.\d{1,3}){3}$/.test(bare)) return bare;
	return bare.includes(':') ? bare : null;
}

function toHomeUrlError(err, hostname) {
	if (!(err instanceof SsrfError)) {
		return new HomeUrlError('dial_failed', `Could not reach ${hostname}.`);
	}
	if (err.code === 'private_address') {
		return new HomeUrlError(
			'private_address',
			`${hostname} resolves to a private address, which a three.ws server on the public internet cannot route to. Use your remote https URL, or connect the add-on so your house dials out to us instead.`,
		);
	}
	if (err.code === 'dns_timeout' || err.code === 'dns_failed') {
		return new HomeUrlError(
			'unroutable_host',
			`${hostname} does not resolve from the public internet. A ".local" or LAN-only name only works from inside your own network.`,
		);
	}
	return new HomeUrlError('bad_url', err.message);
}
