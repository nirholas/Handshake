/**
 * IRL visit links: the scannable handoff that lands a stranger on one placed agent.
 *
 * A street demo needs one URL a passer-by can scan from a sign, open on their
 * phone, and end up looking at the agent that lives at that spot. This module
 * holds the pure rules for that handoff so the page, the printable sign, and
 * the owner's dashboard all agree on them:
 *
 *   /irl?pin=<pinId>        the visit link (the legacy `?highlight=` is an alias)
 *   /irl/sign?pin=<pinId>   the printable sign that carries the visit link as a QR
 *
 * Neither URL carries a coordinate. The pin id alone resolves only to the public
 * agent card (name, bio, wallet, services), and the agent itself still appears
 * only through the presence-gated nearby read once the visitor is standing there.
 * That keeps the privacy model intact: a scanned sign tells you WHO is here, the
 * walk-up tells you WHERE.
 */

// Pin ids are UUIDs or the shorter ids older rows carry; either way a visit link
// only ever holds one path-safe token, so anything else is dropped at the boundary.
const PIN_ID_RE = /^[A-Za-z0-9_-]{6,64}$/;

/** Normalise a raw pin id from a URL; `null` when it is not a plausible id. */
export function normalizePinId(raw) {
	const v = typeof raw === 'string' ? raw.trim() : '';
	return PIN_ID_RE.test(v) ? v : null;
}

/**
 * Which pin a visitor came to meet, read from the page's query string.
 * `?pin=` is canonical; `?highlight=` (the dashboard's older "View in IRL" link)
 * means the same thing. Returns `{ pinId }` with `null` when neither is present.
 */
export function parseVisitTarget(search) {
	const sp = new URLSearchParams(typeof search === 'string' ? search : '');
	return { pinId: normalizePinId(sp.get('pin')) || normalizePinId(sp.get('highlight')) };
}

function baseFrom(origin) {
	const o = typeof origin === 'string' && origin ? origin : 'https://three.ws';
	return o.replace(/\/+$/, '');
}

/** The visit link for a pin: what the sign's QR encodes and what the owner copies. */
export function buildVisitUrl(pinId, origin) {
	const id = normalizePinId(pinId);
	if (!id) throw new Error('a pin id is required to build a visit link');
	return `${baseFrom(origin)}/irl?pin=${encodeURIComponent(id)}`;
}

/** The printable sign for a pin. */
export function buildSignUrl(pinId, origin) {
	const id = normalizePinId(pinId);
	if (!id) throw new Error('a pin id is required to build a sign link');
	return `${baseFrom(origin)}/irl/sign?pin=${encodeURIComponent(id)}`;
}

/**
 * How "See it in AR" should launch for a DISCOVERED pin (someone else's agent).
 *
 * iOS has no WebXR, but ARKit Quick Look can show the agent on the real floor,
 * so the page bakes the pin's GLB into an animated USDZ on the device and opens
 * it in place. Everything else goes through the server-side AR launcher, which
 * already routes Android to a native AR intent and desktops to the WebGL viewer.
 * A pin with no https GLB (a legacy relative path, a blob) gets `none`, and the
 * button stays hidden rather than pointing at a viewer that would refuse it.
 */
export function discoveredArLaunch({ avatarUrl, name, ios } = {}) {
	const src = typeof avatarUrl === 'string' ? avatarUrl.trim() : '';
	if (!/^https:\/\//i.test(src)) return { mode: 'none' };
	if (ios) return { mode: 'quicklook', src };
	const title = typeof name === 'string' ? name.trim().slice(0, 120) : '';
	const qs = new URLSearchParams({ src, kind: 'avatar' });
	if (title) qs.set('title', title);
	return { mode: 'link', src, url: `/api/ar?${qs.toString()}` };
}

/**
 * Copy for the "you came to meet" banner while the visitor is not yet within
 * discovery range, and once the agent has appeared. The radius is the server's
 * hard cap on the nearby read, so the number a visitor is told is the real one.
 */
export function meetBannerCopy({ name, state, radiusM = 60 } = {}) {
	const who = typeof name === 'string' && name.trim() ? name.trim() : 'this agent';
	switch (state) {
		case 'found':
			return { title: `${who} is here`, body: 'Look around, then tap it to see its profile, wallet, and services.' };
		case 'gone':
			return { title: `${who} has moved on`, body: 'This placement is no longer active. Place your own agent here instead.' };
		case 'no-gps':
			return { title: `You're here to meet ${who}`, body: 'Allow location so we can tell when you are standing near it.' };
		default:
			return { title: `You're here to meet ${who}`, body: `Walk to the spot on the sign. It appears in your camera within ${radiusM} m.` };
	}
}
