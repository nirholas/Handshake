import { ERR, HomeBridgeError } from './errors.js';

/**
 * Home Assistant is reached at a base URL the user types by hand, so it arrives
 * with trailing slashes, a stray `/lovelace`, or no scheme at all. Normalize it
 * once, here, and let every other module assume it is clean.
 *
 * @param {string} input
 * @param {{ requireSecure?: boolean }} [options] requireSecure rejects http://
 *   for non-loopback hosts, which is what a browser on an https origin needs:
 *   mixed content would be blocked anyway, and failing early with a real reason
 *   beats a silent network error.
 * @returns {{ http: string, ws: string, origin: string, secure: boolean, loopback: boolean }}
 */
export function normalizeBaseUrl(input, options = {}) {
	const raw = typeof input === 'string' ? input.trim() : '';
	if (!raw) throw new HomeBridgeError(ERR.BAD_URL, 'A Home Assistant URL is required.');

	const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
	let url;
	try {
		url = new URL(withScheme);
	} catch (cause) {
		throw new HomeBridgeError(ERR.BAD_URL, `"${raw}" is not a valid URL.`, cause);
	}

	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new HomeBridgeError(ERR.BAD_URL, `Unsupported scheme "${url.protocol}". Use http or https.`);
	}

	const loopback = isLoopbackHost(url.hostname);
	const secure = url.protocol === 'https:';
	if (options.requireSecure && !secure && !loopback) {
		throw new HomeBridgeError(
			ERR.BAD_URL,
			`${url.origin} is plain http, which a page served over https cannot reach. Use your remote https URL, or connect from inside your network.`,
		);
	}

	// Home Assistant can live under a path prefix behind a reverse proxy, so keep
	// the path but drop the trailing slash: every caller appends its own.
	const path = url.pathname.replace(/\/+$/, '');
	const http = `${url.origin}${path}`;
	const ws = `${secure ? 'wss' : 'ws'}://${url.host}${path}/api/websocket`;
	return { http, ws, origin: url.origin, secure, loopback };
}

function isLoopbackHost(hostname) {
	const h = hostname.toLowerCase();
	if (h === 'localhost' || h === '::1' || h.endsWith('.localhost')) return true;
	return /^127(?:\.\d{1,3}){3}$/.test(h);
}

/**
 * True when the host is one a public three.ws server can never route to. The
 * connect UI uses this to explain the LAN problem up front instead of letting
 * the user wait out a timeout.
 */
export function isPrivateHost(hostname) {
	const h = String(hostname || '').toLowerCase();
	if (isLoopbackHost(h)) return true;
	if (h.endsWith('.local') || h.endsWith('.lan') || h.endsWith('.internal') || h === 'homeassistant') return true;
	if (/^10(?:\.\d{1,3}){3}$/.test(h)) return true;
	if (/^192\.168(?:\.\d{1,3}){2}$/.test(h)) return true;
	if (/^172\.(1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}$/.test(h)) return true;
	if (/^169\.254(?:\.\d{1,3}){2}$/.test(h)) return true;
	return false;
}
