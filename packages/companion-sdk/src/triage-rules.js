// The deterministic triage pass: is this worth interrupting a human for?
//
// This module is the single implementation of that judgement anywhere in the
// three.ws companion system. The server imports it (api/_lib/companion/
// triage.js) before it decides whether to speak; the CLI imports it to score
// messages on your own machine so a mail password never has to leave it; and
// anybody building their own body for the companion can import it to make the
// same call locally.
//
// It deliberately needs no model and no key. An LLM pass can refine the score
// and rewrite the line (that is what the hosted service does with your own
// Anthropic key when you have stored one), but everything here works offline,
// costs nothing, and is the floor the refinement is measured against.
//
// Scores are 0 to 100:
//    0-39  it can wait
//   40-69  worth a glance
//  70-100  interrupt the person now

const URGENT = /\b(urgent|asap|emergency|immediately|right now|deadline|overdue|final notice|action required|time sensitive)\b/i;
const PERSONAL = /\b(call me|text me|ring me|where are you|are you (there|around|free)|need you|help|i'?m outside|on my way|pick me up)\b/i;
const MONEY = /\b(payment|invoice|refund|charge|declined|fraud|unauthorized|wire|transfer|past due|receipt)\b/i;
const SECURITY = /\b(verification code|security code|one[- ]time|2fa|otp|password reset|sign[- ]?in attempt|suspicious login)\b/i;
const LOGISTICS = /\b(flight|gate|delayed|cancell?ed|reschedul|boarding|delivery|arriving|appointment)\b/i;
const BULK = /\b(unsubscribe|newsletter|promotion|sale ends|% off|limited time offer|no[- ]reply|noreply|marketing|webinar|survey)\b/i;
const UNATTENDED = /^(no[- ]?reply|do[- ]?not[- ]?reply|notifications?|updates?|info|newsletter)@/i;

/**
 * Where each lane starts before any signal is read. A calendar entry is on the
 * person's own calendar, so it opens higher than a stranger's email, which
 * opens near the floor.
 */
export const LANE_BASELINE = {
	telegram: 42,
	email: 30,
	calendar: 55,
	bridge: 45,
	sms: 45,
	slack: 38,
	discord: 34,
	webhook: 40,
};

export const DEFAULT_BASELINE = 40;

export function clampScore(n) {
	return Math.max(0, Math.min(100, Math.round(Number(n) || 0)));
}

/** Trim any message to something a person can hear in one breath. */
export function shorten(text, max = 220) {
	const flat = String(text || '').replace(/\s+/g, ' ').trim();
	if (flat.length <= max) return flat;
	const cut = flat.slice(0, max);
	const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf(', '), cut.lastIndexOf(' '));
	return `${cut.slice(0, stop > 60 ? stop : max).trim()}…`;
}

export function minutesUntil(when, now = Date.now()) {
	if (!when) return null;
	const ts = when instanceof Date ? when.getTime() : Date.parse(when);
	if (Number.isNaN(ts)) return null;
	return (ts - now) / 60000;
}

/**
 * The line the companion says when no model rewrote it. Plain, specific, and
 * never longer than a sentence or two.
 *
 * @param {CompanionEvent} event
 * @param {CompanionContact|null} contact
 */
export function defaultLine(event, contact = null, now = Date.now()) {
	const who = contact?.display_name || event.sender || 'Someone';
	const body = shorten(event.body || event.title, 180);
	if (event.source_kind === 'calendar') {
		const mins = minutesUntil(event.occurs_at, now);
		const when = mins === null
			? 'coming up'
			: mins <= 1
				? 'starting now'
				: mins < 60
					? `in ${Math.round(mins)} minutes`
					: `at ${new Date(event.occurs_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
		return `Heads up, ${event.title} is ${when}.${event.body ? ` ${shorten(event.body, 120)}` : ''}`;
	}
	if (event.source_kind === 'email') return `${who} emailed you: ${event.title}. ${body}`;
	return `${who} says: ${body}`;
}

/**
 * Score one message.
 *
 * @typedef {object} CompanionEvent
 * @property {string} source_kind  telegram | email | calendar | bridge | ...
 * @property {string} [sender]     display name
 * @property {string} [sender_id]  handle, address, or number
 * @property {string} title
 * @property {string} [body]
 * @property {string} [occurs_at]  ISO, for things that start at a time
 * @property {'high'|'normal'|'low'} [priority_hint] what the sending device knew
 *
 * @typedef {object} CompanionContact
 * @property {string} display_name
 * @property {number} [priority_boost] -100 to 100
 *
 * @param {CompanionEvent} event
 * @param {CompanionContact|null} contact
 * @param {{ now?: number }} [opts]
 * @returns {{ importance:number, reason:string, line:string, signals:string[] }}
 */
export function scoreByRules(event, contact = null, { now = Date.now() } = {}) {
	const text = `${event.title || ''} ${event.body || ''}`;
	const signals = [];
	const reasons = [];
	let score = LANE_BASELINE[event.source_kind] ?? DEFAULT_BASELINE;

	const add = (points, signal, reason) => {
		score += points;
		signals.push(signal);
		reasons.push(reason);
	};

	if (contact) add(18 + (contact.priority_boost || 0), 'known_contact', `from ${contact.display_name}, a saved contact`);
	// A one-time code is the most perishable message a person receives: it is
	// worth interrupting for even from a sender nobody has ever saved, and it
	// expires while it sits unread. It is the single largest signal here on
	// purpose, enough to clear the default bar from the lowest lane baseline.
	if (SECURITY.test(text)) add(40, 'security_code', 'looks like a security or login code');
	if (URGENT.test(text)) add(22, 'urgent_language', 'says it is urgent');
	if (PERSONAL.test(text)) add(18, 'direct_request', 'asks you for something directly');
	if (MONEY.test(text)) add(14, 'money', 'concerns money or a payment');
	if (LOGISTICS.test(text)) add(12, 'logistics', 'affects travel or a delivery');
	if (/\?\s*$/.test((event.body || event.title || '').trim())) add(6, 'question', 'ends in a question');
	if (BULK.test(text)) add(-28, 'bulk', 'reads like a bulk or marketing message');
	if (UNATTENDED.test(event.sender_id || '')) add(-20, 'unattended_sender', 'sent from an unattended address');

	const mins = minutesUntil(event.occurs_at, now);
	if (event.source_kind === 'calendar' && mins !== null) {
		if (mins <= 5) add(32, 'starts_now', 'starts in minutes');
		else if (mins <= 15) add(24, 'starts_soon', 'starts within the quarter hour');
		else if (mins <= 60) add(12, 'starts_this_hour', 'starts within the hour');
	}

	if (event.priority_hint === 'high') add(20, 'device_high', 'the device marked it high priority');
	if (event.priority_hint === 'low') add(-20, 'device_low', 'the device marked it low priority');

	return {
		importance: clampScore(score),
		reason: reasons.length ? reasons.join('; ') : 'no urgency signals in the message',
		line: defaultLine(event, contact, now),
		signals,
	};
}

/**
 * Is it the middle of this person's night? Quiet hours are evaluated in their
 * own timezone, and a window that wraps midnight (22 to 7) is the normal case.
 *
 * @param {{ quiet_start:number|null, quiet_end:number|null, timezone?:string }} settings
 * @param {Date} [now]
 */
export function inQuietHours(settings, now = new Date()) {
	const start = settings?.quiet_start;
	const end = settings?.quiet_end;
	if (start === null || start === undefined || end === null || end === undefined) return false;
	let hour;
	try {
		hour = Number(new Intl.DateTimeFormat('en-US', {
			hour: 'numeric',
			hour12: false,
			timeZone: settings.timezone || 'UTC',
		}).format(now));
	} catch {
		hour = now.getUTCHours();
	}
	if (start === end) return true;
	return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

/**
 * The whole local decision in one call: score it, and say whether this person
 * would want to be interrupted right now.
 */
export function decide(event, { contact = null, threshold = 60, settings = null, now = Date.now() } = {}) {
	const verdict = scoreByRules(event, contact, { now });
	const quiet = settings ? inQuietHours(settings, new Date(now)) : false;
	return {
		...verdict,
		quiet,
		speak: verdict.importance >= threshold && !quiet,
	};
}
