// The rules engine: everything that decides WHETHER a message is worth
// interrupting a human for, and how it should be delivered.
//
// Pure by design. No DOM, no timers, no network, no globals. The runtime
// (index.js) owns the clock and the side effects; this file owns the judgement,
// which is the part worth testing exhaustively and the part an integrator will
// want to reason about before they let anything walk onto their page.
//
// The model in one paragraph: a message arrives from a source with an optional
// `importance` (0-100). Scorers may raise or lower it. The decision function
// then answers one question, "deliver, hold, or drop", against the caller's
// rules: freshness, dedupe, importance floor, quiet hours, rate limit, focus.
// Anything held is retried by the runtime; anything dropped is reported with a
// reason, so an integrator can always answer "why didn't I hear about that?".

/** Every reason a message can fail to reach a human, as a stable string. */
export const DROP_REASONS = /** @type {const} */ ({
	DUPLICATE: 'duplicate',
	STALE: 'stale',
	BELOW_FLOOR: 'below-importance-floor',
	MUTED: 'muted',
	EMPTY: 'empty',
});

/** Reasons a message is not delivered *yet*, but will be. */
export const HOLD_REASONS = /** @type {const} */ ({
	QUIET_HOURS: 'quiet-hours',
	RATE_LIMITED: 'rate-limited',
	UNFOCUSED: 'window-not-focused',
	BUSY: 'delivering-another',
});

/** The importance a message gets when nothing said otherwise. */
export const DEFAULT_IMPORTANCE = 50;

/**
 * @typedef {object} Message
 * @property {string} [id] stable id; dedupe key when `key` is absent
 * @property {string} text the line a human hears or reads
 * @property {string} [key] explicit dedupe key (two builds of the same alert)
 * @property {number} [importance] 0-100; higher interrupts harder
 * @property {string} [from] who it is from, shown and spoken as attribution
 * @property {string} [url] where clicking through goes
 * @property {number} [at] epoch ms the underlying event happened
 * @property {string} [tone] 'neutral' | 'alert' | 'celebrate'
 * @property {string} [emote] gesture the avatar arrives with
 * @property {object} [meta] anything the integrator wants back in callbacks
 */

/**
 * @typedef {object} Rules
 * @property {number} [minImportance=50] floor a message must clear to deliver
 * @property {number} [freshnessMs=900000] older than this and it is history
 * @property {number} [dedupeTtlMs=21600000] how long a delivered key is remembered
 * @property {[number, number]|null} [quietHours=null] local [startHour, endHour)
 * @property {number} [quietHoursMinImportance=90] what still gets through quiet hours
 * @property {number} [maxPerWindow=4] deliveries allowed per rate window
 * @property {number} [rateWindowMs=60000] the rate window
 * @property {boolean} [focusOnly=true] hold while the tab is in the background
 * @property {number} [batchSize=2] delivered per burst before the rest collapse
 */

/** The defaults, exported so integrators can read them and docs can quote them. */
export const DEFAULT_RULES = Object.freeze({
	minImportance: DEFAULT_IMPORTANCE,
	freshnessMs: 15 * 60_000,
	dedupeTtlMs: 6 * 60 * 60_000,
	quietHours: null,
	quietHoursMinImportance: 90,
	maxPerWindow: 4,
	rateWindowMs: 60_000,
	focusOnly: true,
	batchSize: 2,
});

/** Merge a caller's partial rules onto the defaults. */
export function resolveRules(rules) {
	return { ...DEFAULT_RULES, ...(rules || {}) };
}

/** Clamp anything to a 0-100 importance. */
export function clampImportance(value, fallback = DEFAULT_IMPORTANCE) {
	const n = Number(value);
	if (!Number.isFinite(n)) return fallback;
	return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * Run the caller's scorers over a message, highest wins.
 *
 * A scorer is `(message) => number | undefined`. Returning undefined means "no
 * opinion", which is what lets a scorer speak only about the messages it knows
 * about. A scorer that throws is ignored rather than allowed to break delivery:
 * an integrator's bad rule must never cost a user their message.
 *
 * @param {Message} message
 * @param {Array<(m: Message) => number|undefined>} [scorers]
 * @returns {number} 0-100
 */
export function scoreMessage(message, scorers = []) {
	let score = clampImportance(message?.importance, DEFAULT_IMPORTANCE);
	for (const scorer of scorers) {
		if (typeof scorer !== 'function') continue;
		let opinion;
		try {
			opinion = scorer(message);
		} catch {
			continue;
		}
		if (opinion == null) continue;
		const n = clampImportance(opinion, null);
		if (n != null && n > score) score = n;
	}
	return score;
}

/** The dedupe key for a message: explicit key, then id, then the text itself. */
export function dedupeKeyFor(message) {
	return String(message?.key || message?.id || message?.text || '').trim();
}

/**
 * Is `hour` inside a [start, end) window that may wrap past midnight?
 * `[22, 7]` means 22:00 to 06:59.
 */
export function withinQuietHours(hour, quietHours) {
	if (!Array.isArray(quietHours) || quietHours.length !== 2) return false;
	const [start, end] = quietHours.map((h) => Number(h));
	if (!Number.isFinite(start) || !Number.isFinite(end) || start === end) return false;
	const h = Number(hour);
	return start < end ? h >= start && h < end : h >= start || h < end;
}

/**
 * Decide what happens to one message.
 *
 * @param {Message} message
 * @param {object} ctx
 * @param {Rules} ctx.rules resolved rules
 * @param {number} ctx.now epoch ms
 * @param {number} ctx.hour local hour 0-23
 * @param {Map<string, number>} ctx.seen dedupe key to the ms it was delivered
 * @param {number[]} ctx.recent delivery timestamps inside the rate window
 * @param {boolean} ctx.focused is the surface in front of the human
 * @param {boolean} [ctx.busy] is a delivery already on screen
 * @param {boolean} [ctx.muted] has the human silenced this device
 * @param {Array<(m: Message) => number|undefined>} [ctx.scorers]
 * @returns {{action:'deliver'|'hold'|'drop', reason?:string, importance:number}}
 */
export function decide(message, ctx) {
	const rules = ctx.rules;
	const importance = scoreMessage(message, ctx.scorers);
	const text = String(message?.text || '').trim();

	if (!text) return { action: 'drop', reason: DROP_REASONS.EMPTY, importance };
	if (ctx.muted) return { action: 'drop', reason: DROP_REASONS.MUTED, importance };

	const key = dedupeKeyFor(message);
	const lastSeen = ctx.seen?.get(key);
	if (lastSeen != null && ctx.now - lastSeen < rules.dedupeTtlMs) {
		return { action: 'drop', reason: DROP_REASONS.DUPLICATE, importance };
	}

	// `at` is when the underlying event happened. A source that does not know
	// (a manual announce, a webhook with no timestamp) is treated as now, so
	// freshness never silently swallows a message that has no clock on it.
	const at = Number.isFinite(Number(message?.at)) ? Number(message.at) : ctx.now;
	if (ctx.now - at > rules.freshnessMs) {
		return { action: 'drop', reason: DROP_REASONS.STALE, importance };
	}

	if (importance < rules.minImportance) {
		return { action: 'drop', reason: DROP_REASONS.BELOW_FLOOR, importance };
	}

	// Holds are ordered cheapest-to-recover first: focus and busy resolve in
	// seconds, the rate window in a minute, quiet hours in hours.
	if (ctx.busy) return { action: 'hold', reason: HOLD_REASONS.BUSY, importance };
	if (rules.focusOnly && !ctx.focused) {
		return { action: 'hold', reason: HOLD_REASONS.UNFOCUSED, importance };
	}

	const windowStart = ctx.now - rules.rateWindowMs;
	const inWindow = (ctx.recent || []).filter((t) => t > windowStart).length;
	if (inWindow >= rules.maxPerWindow) {
		return { action: 'hold', reason: HOLD_REASONS.RATE_LIMITED, importance };
	}

	if (
		withinQuietHours(ctx.hour, rules.quietHours) &&
		importance < rules.quietHoursMinImportance
	) {
		return { action: 'hold', reason: HOLD_REASONS.QUIET_HOURS, importance };
	}

	return { action: 'deliver', importance };
}

/**
 * Split a burst into what gets said and what gets summarised.
 *
 * Three alerts in one second is three interruptions; the third is noise. The
 * batch plan delivers the most important few in order and collapses the rest
 * into a single line, so a storm costs the human one extra sentence.
 *
 * @param {Array<Message & {importance?: number}>} messages
 * @param {number} [batchSize=2]
 * @returns {{deliver: Message[], collapsed: Message[], summary: string|null}}
 */
export function planBatch(messages, batchSize = DEFAULT_RULES.batchSize) {
	const list = (Array.isArray(messages) ? messages : []).filter(Boolean);
	const ordered = [...list].sort(
		(a, b) =>
			clampImportance(b.importance) - clampImportance(a.importance) ||
			(Number(b.at) || 0) - (Number(a.at) || 0),
	);
	const size = Math.max(1, Math.floor(batchSize) || 1);
	const deliver = ordered.slice(0, size);
	const collapsed = ordered.slice(size);
	return {
		deliver,
		collapsed,
		summary: collapsed.length
			? `${collapsed.length} more ${collapsed.length === 1 ? 'message' : 'messages'} waiting`
			: null,
	};
}

/**
 * How long a line should stay on screen: long enough to read comfortably,
 * capped so a verbose payload can never park an avatar in someone's corner.
 * Roughly 200 words per minute plus a beat to notice it.
 */
export function dwellMsFor(text, { min = 4200, max = 14_000, perChar = 55 } = {}) {
	const chars = String(text || '').length;
	return Math.max(min, Math.min(max, min + chars * perChar));
}

/**
 * Prune a dedupe map in place and return it. Called by the runtime on a slow
 * cadence so a long-lived page cannot grow an unbounded key set.
 */
export function pruneSeen(seen, now, ttlMs, cap = 500) {
	if (!seen) return seen;
	for (const [key, ts] of seen) {
		if (now - ts > ttlMs) seen.delete(key);
	}
	if (seen.size > cap) {
		const excess = seen.size - cap;
		let i = 0;
		for (const key of seen.keys()) {
			if (i++ >= excess) break;
			seen.delete(key);
		}
	}
	return seen;
}

/**
 * Normalise anything a source hands over into a Message.
 * Sources are allowed to be sloppy so integrators can point one at an existing
 * feed without writing a mapper; this is where that sloppiness stops.
 */
export function toMessage(raw) {
	if (raw == null) return null;
	if (typeof raw === 'string') return { text: raw.trim() } ;
	const text = String(raw.text ?? raw.message ?? raw.title ?? raw.body ?? '').trim();
	if (!text) return null;
	const at = raw.at ?? raw.timestamp ?? raw.created_at ?? raw.createdAt;
	const parsed = typeof at === 'string' ? Date.parse(at) : Number(at);
	return {
		id: raw.id != null ? String(raw.id) : undefined,
		key: raw.key != null ? String(raw.key) : undefined,
		text,
		importance: raw.importance ?? raw.priority ?? undefined,
		from: raw.from != null ? String(raw.from) : undefined,
		url: raw.url ?? raw.link ?? undefined,
		at: Number.isFinite(parsed) ? parsed : undefined,
		tone: raw.tone,
		emote: raw.emote,
		meta: raw.meta ?? undefined,
	};
}
