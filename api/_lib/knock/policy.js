// Knock policy: the pure rules behind a priced door.
//
// Everything in this file is a pure function of its arguments. No database, no
// network, no clock beyond an injectable `now`. That is deliberate: the price
// a stranger is quoted, the line the avatar says out loud, and the reasons a
// knock is refused are the parts of this feature a person will argue with, so
// they are the parts that are unit-tested end to end
// (tests/knock-policy.test.js) rather than only exercised through HTTP.

/** USDC has 6 decimals on every chain we settle on. */
export const USDC_DECIMALS = 6;

// A door priced below a tenth of a cent is not a filter, it is a rounding
// error, and the facilitator fee would exceed it. The ceiling is a guardrail
// against a typo turning $5 into $5,000: a door that wants more can raise it
// in steps.
export const MIN_PRICE_ATOMICS = 1000n;      // $0.001
export const MAX_PRICE_ATOMICS = 1000000000n; // $1,000
export const DEFAULT_PRICE_ATOMICS = 50000n;  // $0.05

export const MIN_MESSAGE_CHARS = 8;
export const MAX_SUBJECT_CHARS = 120;
export const MAX_SENDER_CHARS = 64;

export const KNOCK_STATUSES = ['pending', 'read', 'replied', 'dismissed'];
export const SENDER_KINDS = ['agent', 'human', 'unknown'];

/** A knock is a companion event of this kind. Nothing else writes it. */
export const KNOCK_SOURCE_KIND = 'knock';

/**
 * Render atomic USDC as a human price string.
 * Trailing zeros are trimmed past the cent, so $0.05 reads as "$0.05" and
 * $0.001 as "$0.001" rather than "$0.050000".
 */
export function formatUsdc(atomics) {
	const value = BigInt(atomics ?? 0);
	const negative = value < 0n;
	const abs = negative ? -value : value;
	const whole = abs / 1000000n;
	const frac = (abs % 1000000n).toString().padStart(6, '0').replace(/0+$/, '');
	const cents = frac.length <= 2 ? frac.padEnd(2, '0') : frac;
	return `${negative ? '-' : ''}$${whole.toString()}.${cents}`;
}

/**
 * Parse a price a person typed. Accepts "0.05", "$0.05", "5c" is NOT accepted
 * (ambiguous), and plain atomics when `unit` is 'atomics'.
 * @returns {bigint}
 * @throws {Error} with code 'bad_price' on anything unparseable or out of range.
 */
export function parsePrice(input, { unit = 'usdc' } = {}) {
	const raw = String(input ?? '').trim().replace(/^\$/, '').replace(/,/g, '');
	if (!/^\d+(\.\d{1,6})?$/.test(raw)) throw knockError('bad_price', 'price must be a USDC amount like 0.05');
	let atomics;
	if (unit === 'atomics') {
		if (raw.includes('.')) throw knockError('bad_price', 'atomic prices must be whole numbers');
		atomics = BigInt(raw);
	} else {
		const [whole, frac = ''] = raw.split('.');
		atomics = BigInt(whole) * 1000000n + BigInt(frac.padEnd(6, '0'));
	}
	// Zero is legal and means "free door": it is the one value outside the
	// paid range that the rest of the system understands.
	if (atomics !== 0n && (atomics < MIN_PRICE_ATOMICS || atomics > MAX_PRICE_ATOMICS)) {
		throw knockError(
			'bad_price',
			`price must be 0 (free) or between ${formatUsdc(MIN_PRICE_ATOMICS)} and ${formatUsdc(MAX_PRICE_ATOMICS)}`,
		);
	}
	return atomics;
}

/** Lowercased, @-stripped username. Returns '' when nothing usable is left. */
export function normalizeHandle(raw) {
	return String(raw ?? '')
		.trim()
		.replace(/^@+/, '')
		.toLowerCase()
		.slice(0, 40)
		.replace(/[^a-z0-9._-]/g, '');
}

/**
 * The keys a block list is matched against for one knock. Both the paying
 * wallet and the name the sender gave are checked, so blocking works whether
 * the sender is a wallet or a named agent.
 */
export function blockKeysFor({ payerWallet = null, senderName = null } = {}) {
	const keys = [];
	if (payerWallet) keys.push(String(payerWallet).trim().toLowerCase());
	if (senderName) keys.push(String(senderName).trim().toLowerCase());
	return [...new Set(keys.filter(Boolean))];
}

/**
 * How loudly a knock lands, on the companion's 0-100 importance scale.
 *
 * A knock is not ranked by keywords like a mail message: the sender already
 * told us how much it is worth to them, in money. The scale is logarithmic so
 * a $50 knock outranks a $0.05 one without a $5,000 knock being able to sit
 * permanently at the top of the feed, and every paid knock starts above the
 * default interrupt threshold (60) because paying to reach someone IS the
 * signal. A free-door knock lands below it: it goes in the feed and the bell,
 * and it does not stop the person's day.
 */
export function importanceFor(amountAtomics) {
	const value = Number(BigInt(amountAtomics ?? 0));
	if (value <= 0) return 45;
	const dollars = value / 10 ** USDC_DECIMALS;
	// log10($0.001) = -3 → 62, log10($1) = 0 → 80, log10($1000) = 3 → 98.
	const scaled = 80 + Math.log10(dollars) * 6;
	return Math.max(62, Math.min(99, Math.round(scaled)));
}

/**
 * The line the avatar says out loud when it walks on.
 *
 * It names the sender and the price first, because those are what the listener
 * needs to decide whether to care, and only then the subject. The message body
 * itself is never spoken: it is shown in the bubble and the inbox, so a long
 * or hostile paragraph cannot be read at someone by their own avatar.
 */
export function spokenLineFor({ senderName, amountAtomics = 0, subject = null } = {}) {
	const who = String(senderName || 'Someone').trim().slice(0, MAX_SENDER_CHARS);
	const topic = String(subject || '').trim();
	const paid = BigInt(amountAtomics ?? 0) > 0n
		? ` paid ${formatUsdc(amountAtomics)} to reach you`
		: ' is at your door';
	return topic ? `${who}${paid}: ${topic}.` : `${who}${paid}.`;
}

/** The one-line title stored on the knock and shown in the inbox. */
export function titleFor({ senderName, amountAtomics = 0, subject = null } = {}) {
	const who = String(senderName || 'Someone').trim().slice(0, MAX_SENDER_CHARS);
	const topic = String(subject || '').trim();
	if (topic) return `${who}: ${topic}`.slice(0, 200);
	return BigInt(amountAtomics ?? 0) > 0n
		? `${who} knocked (${formatUsdc(amountAtomics)})`.slice(0, 200)
		: `${who} knocked`.slice(0, 200);
}

/**
 * Validate the caller-supplied half of a knock against the door's own limits.
 * Returns the cleaned payload. Throws a coded error the HTTP layer renders
 * verbatim, because every one of these is something the sender can fix.
 */
export function validateKnock(input, door) {
	const maxChars = Math.max(40, Math.min(2000, Number(door?.max_chars ?? 600)));
	const message = String(input?.message ?? '').trim();
	if (message.length < MIN_MESSAGE_CHARS) {
		throw knockError('message_too_short', `say at least ${MIN_MESSAGE_CHARS} characters`);
	}
	if (message.length > maxChars) {
		throw knockError('message_too_long', `this door accepts up to ${maxChars} characters`);
	}
	const senderName = String(input?.from ?? '').trim().slice(0, MAX_SENDER_CHARS);
	if (!senderName) throw knockError('missing_sender', 'tell them who you are with `from`');

	const subject = String(input?.subject ?? '').trim().slice(0, MAX_SUBJECT_CHARS) || null;
	const senderKind = SENDER_KINDS.includes(input?.sender_kind) ? input.sender_kind : 'unknown';

	let senderUrl = null;
	if (input?.url) {
		const url = String(input.url).trim();
		// Only http(s) links are stored: the inbox renders this as a real anchor
		// and a javascript: or data: URL there would be a handed-over XSS.
		if (!/^https?:\/\/[^\s]+$/i.test(url) || url.length > 400) {
			throw knockError('bad_url', 'url must be a plain http(s) link under 400 characters');
		}
		senderUrl = url;
	}

	const requestId = input?.request_id ? String(input.request_id).trim().slice(0, 80) : null;

	return { message, senderName, subject, senderKind, senderUrl, requestId };
}

/** Reasons a door refuses before any payment is taken. */
export function doorRefusal(door, { now = new Date(), knocksToday = 0 } = {}) {
	if (!door) return knockError('no_door', 'that person has not opened a door');
	if (!door.open) return knockError('door_closed', 'this door is closed right now');
	if (knocksToday >= Number(door.daily_cap ?? 25)) {
		return knockError('door_full', 'this door has taken all the knocks it accepts today');
	}
	void now;
	return null;
}

/** An Error carrying the machine code and the HTTP status the API should use. */
export function knockError(code, message) {
	const err = new Error(message);
	err.code = code;
	err.status = STATUS_BY_CODE[code] ?? 400;
	return err;
}

const STATUS_BY_CODE = {
	no_door: 404,
	door_closed: 403,
	door_full: 429,
	blocked: 403,
	duplicate: 409,
	bad_price: 400,
	bad_url: 400,
	missing_sender: 400,
	message_too_short: 400,
	message_too_long: 400,
};
