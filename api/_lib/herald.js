// Shared shape for the herald delivery rail (api/herald/*).
//
// One module owns the queue key, the caps, and the announcement shape so the
// writer (announce.js) and the reader (stream.js) can never disagree about
// what is in Redis. Pure: no I/O, no env, unit-testable on its own.

/** Live channel, not an archive: an unheard line expires rather than piles up. */
export const QUEUE_TTL_SECONDS = 300;
/** A backlog beyond this is noise; the newest win. */
export const QUEUE_CAP = 20;
/** Cap the line length the same way the API validates it. */
export const TEXT_MAX = 280;

export function queueKey(userId) {
	return `herald:${userId}:queue`;
}

/**
 * Only same-origin paths and absolute http(s) URLs may drive a click-through.
 * Anything else (javascript:, data:, a protocol-relative //host) is dropped, so
 * a compromised integration cannot turn a spoken line into a script execution
 * or an off-site redirect on the recipient's own page.
 */
export function safeUrl(raw) {
	if (!raw || typeof raw !== 'string') return null;
	const s = raw.trim();
	if (!s) return null;
	if (s.startsWith('/') && !s.startsWith('//')) return s;
	if (/^https?:\/\//i.test(s)) return s;
	return null;
}

/** Collapse whitespace and hard-cap a line so one long payload cannot dominate. */
export function cleanText(raw, max = TEXT_MAX) {
	return String(raw ?? '')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, max);
}

/**
 * Build the announcement record that goes on the wire.
 * @param {object} input validated request body plus `text`
 * @param {() => number} [clock] injectable for tests
 * @param {() => string} [idFactory]
 */
export function normalizeAnnouncement(input, clock = Date.now, idFactory = randomId) {
	const at = clock();
	const text = cleanText(input.text);
	return {
		id: idFactory(),
		text,
		from: input.from ? cleanText(input.from, 60) : undefined,
		importance:
			input.importance == null ? 70 : Math.max(0, Math.min(100, Math.round(input.importance))),
		url: safeUrl(input.url) || undefined,
		tone: input.tone || 'alert',
		emote: input.emote ? cleanText(input.emote, 40) : undefined,
		// The dedupe key defaults to the id, which makes every announcement
		// distinct; an integrator sending the same key twice is telling us the
		// two are the same event, and the SDK will only say it once.
		key: input.key ? cleanText(input.key, 120) : undefined,
		meta: input.meta && typeof input.meta === 'object' ? input.meta : undefined,
		at,
	};
}

function randomId() {
	// crypto.randomUUID exists in every runtime this ships on (Node 18+ and
	// modern browsers); the fallback keeps the module usable in a bare test env.
	return globalThis.crypto?.randomUUID?.() ?? `h_${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * Decode one record read back out of Redis. The Upstash REST client parses JSON
 * responses, so a value written as a JSON string can come back already parsed.
 * Both shapes are valid; anything else is unusable and skipped.
 */
export function parseRecord(value) {
	if (value && typeof value === 'object') return value;
	if (typeof value !== 'string') return null;
	try {
		return JSON.parse(value);
	} catch {
		return null;
	}
}
