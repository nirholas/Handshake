// Shared, pure helpers for the agent-screen CONTROL channel, the reverse of the
// frame stream. Viewers who OWN an agent can take the wheel of its live cast
// browser: mouse, scroll, keyboard, and navigation. These helpers sanitize the
// wire events on the API boundary so only well-formed, in-range input ever
// reaches the caster's real Chromium page. Pure and dependency-free so both the
// API handler and the unit tests import the same logic.
//
// Wire event shapes (all coordinates NORMALIZED to the streamed viewport, 0..1,
// so a client at any display size maps cleanly to the caster's real pixels):
//   { t: 'move',   x, y }
//   { t: 'down',   x, y, button }
//   { t: 'up',     x, y, button }
//   { t: 'click',  x, y, button }
//   { t: 'scroll', x, y, dy }
//   { t: 'key',    key }                 , a single non-text key from KEY_WHITELIST
//   { t: 'text',   text }                , literal characters to type
//   { t: 'nav',    url }                 , navigate the browser (host-guarded)
//   { t: 'back' } | { t: 'forward' } | { t: 'reload' }

export const EVENT_TYPES = new Set([
	'move', 'down', 'up', 'click', 'scroll', 'key', 'text', 'nav', 'back', 'forward', 'reload',
]);

export const BUTTONS = new Set(['left', 'right', 'middle']);

// Non-text keys a driver may press. Deliberately narrow: navigation, editing,
// and submission keys only. Printable characters go through the 'text' event so
// there is no ambiguity and no way to smuggle key chords. No modifiers in v1.
export const KEY_WHITELIST = new Set([
	'Enter', 'Backspace', 'Tab', 'Delete', 'Escape',
	'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
	'Home', 'End', 'PageUp', 'PageDown',
]);

export const MAX_EVENTS_PER_BATCH = 40;
export const MAX_TEXT_LEN = 256;
export const SCROLL_CLAMP = 1200; // px, per wheel event

const clamp01 = (n) => {
	const v = Number(n);
	if (!Number.isFinite(v)) return null;
	return v < 0 ? 0 : v > 1 ? 1 : v;
};

const finiteClamp = (n, lo, hi) => {
	const v = Number(n);
	if (!Number.isFinite(v)) return 0;
	return v < lo ? lo : v > hi ? hi : v;
};

// Reject text that is only control characters or empty; keep printable content
// (including spaces and unicode) but strip C0/C1 control chars that a keyboard
// couldn't type as a character anyway (newlines included, use the Enter key).
function cleanText(raw) {
	if (typeof raw !== 'string') return null;
	// Strip C0 controls (incl. newlines/tabs, use the Enter/Tab keys), DEL, and
	// C1 controls; keep every printable character (spaces + unicode included).
	const CONTROLS = new RegExp('[\\u0000-\\u001F\\u007F-\\u009F]', 'g');
	const stripped = raw.replace(CONTROLS, '').slice(0, MAX_TEXT_LEN);
	return stripped.length ? stripped : null;
}

// ── Navigation host guard (SSRF) ─────────────────────────────────────────────
// The caster's browser runs inside our infrastructure. A driver-supplied nav URL
// must never let it reach the cloud metadata endpoint, loopback, or any private
// range. Only public http(s) destinations are allowed.

function ipv4Parts(host) {
	const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
	if (!m) return null;
	const p = m.slice(1).map(Number);
	if (p.some((n) => n > 255)) return null;
	return p;
}

function isPrivateIpv4([a, b]) {
	if (a === 0 || a === 127) return true;            // this-host / loopback
	if (a === 10) return true;                         // private
	if (a === 172 && b >= 16 && b <= 31) return true;  // private
	if (a === 192 && b === 168) return true;           // private
	if (a === 169 && b === 254) return true;           // link-local (incl. metadata)
	if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
	return false;
}

export function isNavAllowed(rawUrl) {
	let u;
	try {
		u = new URL(String(rawUrl));
	} catch {
		return false;
	}
	if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
	let host = u.hostname.toLowerCase();
	if (!host) return false;
	// Strip IPv6 brackets for literal checks.
	if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
	if (host === 'localhost' || host.endsWith('.localhost')) return false;
	if (host === 'metadata.google.internal' || host.endsWith('.internal')) return false;
	// IPv6 loopback / unique-local / link-local.
	if (host === '::1' || host === '::' ) return false;
	if (/^fe80:/i.test(host)) return false;         // link-local
	if (/^f[cd][0-9a-f]{2}:/i.test(host)) return false; // fc00::/7 unique-local
	// IPv4 literal ranges.
	const v4 = ipv4Parts(host);
	if (v4 && isPrivateIpv4(v4)) return false;
	// An IPv4 literal that parsed but is public is fine; a hostname resolves at
	// nav time (DNS-rebinding is out of scope for v1 and noted in the docs).
	return true;
}

// Sanitize ONE raw event → a clean event or null (dropped). Coordinates are kept
// normalized; the caster maps them to real pixels at dispatch time.
export function sanitizeEvent(raw) {
	if (!raw || typeof raw !== 'object') return null;
	const t = raw.t;
	if (!EVENT_TYPES.has(t)) return null;

	switch (t) {
		case 'move':
		case 'down':
		case 'up':
		case 'click': {
			const x = clamp01(raw.x);
			const y = clamp01(raw.y);
			if (x === null || y === null) return null;
			const ev = { t, x, y };
			if (t !== 'move') ev.button = BUTTONS.has(raw.button) ? raw.button : 'left';
			return ev;
		}
		case 'scroll': {
			const x = clamp01(raw.x);
			const y = clamp01(raw.y);
			if (x === null || y === null) return null;
			return { t, x, y, dy: finiteClamp(raw.dy, -SCROLL_CLAMP, SCROLL_CLAMP) };
		}
		case 'key':
			return KEY_WHITELIST.has(raw.key) ? { t, key: raw.key } : null;
		case 'text': {
			const text = cleanText(raw.text);
			return text ? { t, text } : null;
		}
		case 'nav':
			return isNavAllowed(raw.url) ? { t, url: String(raw.url) } : null;
		case 'back':
		case 'forward':
		case 'reload':
			return { t };
		default:
			return null;
	}
}

// Sanitize a batch. Drops invalid events silently (a fat-fingered event should
// never fail the whole gesture) and caps the batch length.
export function sanitizeEvents(rawList) {
	if (!Array.isArray(rawList)) return [];
	const out = [];
	for (const raw of rawList) {
		if (out.length >= MAX_EVENTS_PER_BATCH) break;
		const clean = sanitizeEvent(raw);
		if (clean) out.push(clean);
	}
	return out;
}
