// The checkout companion: read a payment screen, say what it actually costs.
//
// A checkout page is the one screen where the gap between what a person thinks
// they are agreeing to and what they are actually agreeing to is widest, and it
// is the screen they read least carefully. The dark patterns are well known and
// boring: a total that is higher than the advertised price, a "free trial" that
// silently becomes an annual charge, a fee introduced on the last step, a
// cancellation window buried in a terms block nobody scrolls. None of them are
// hidden. They are just unread.
//
// This module turns a checkout page into a short list of plain findings. Two
// design rules run through all of it, and both exist because the naive version
// of this feature is actively dangerous:
//
//   1. ARITHMETIC IS NEVER THE MODEL'S JOB. Whether 49.99 + 12.50 equals the
//      total is decided here, in code, against integer minor units. A language
//      model is used only to read prose (what does this cancellation clause
//      say), never to decide whether the numbers add up. A model that
//      hallucinates a fee into existence on a payment screen is worse than no
//      feature, and a model that misses one because it did mental arithmetic is
//      the same failure wearing a different hat.
//
//   2. NO LEGAL VERDICTS. The findings say what the page says and where the
//      numbers disagree. They never say a charge is illegal, non-compliant,
//      fraudulent, or a scam. We are not in a position to know that, the user
//      cannot verify it, and a false accusation rendered over a legitimate
//      merchant's checkout is a liability we would deserve. `SYSTEM_PROMPT`
//      forbids it and `sanitizeModelFindings()` drops any finding that does it
//      anyway, because a prompt is a request and a filter is a guarantee.
//
// The module is PURE: page extract in, findings out. No database, no network,
// no clock. `analyzeCheckout()` takes the model callback as an argument so the
// endpoint owns the LLM chain and the tests own a deterministic stub.

/** Minor units (cents) per major unit, for the currencies a checkout shows. */
const MINOR_UNITS = { JPY: 1, KRW: 1, VND: 1, CLP: 1, ISK: 1 };

function minorPerMajor(currency) {
	return MINOR_UNITS[String(currency || '').toUpperCase()] ?? 100;
}

/** Render integer minor units back to a human string: 4999 USD -> "$49.99". */
export function formatAmount(minor, currency = 'USD') {
	const code = String(currency || 'USD').toUpperCase();
	const per = minorPerMajor(code);
	const sign = minor < 0 ? '-' : '';
	const abs = Math.abs(minor);
	const symbol = { USD: '$', EUR: '€', GBP: '£', JPY: '¥' }[code] || '';
	const body = per === 1 ? String(abs) : `${Math.floor(abs / per)}.${String(abs % per).padStart(2, '0')}`;
	return symbol ? `${sign}${symbol}${body}` : `${sign}${body} ${code}`;
}

// ── Redaction ────────────────────────────────────────────────────────────────
//
// Everything below runs BEFORE a single byte leaves the browser. The extension
// never reads form input values at all (see extensions/checkout-companion), so
// a card number should never reach this function; it runs anyway, because
// "should never" is not a security control. A merchant that prints the last
// four, a confirmation step that echoes the card back as text, and a page that
// stashes an order payload in a visible <pre> are all real, and all of them put
// payment data in the visible text we were about to send off-device.

/** Luhn check: the difference between a card number and a 16-digit order id. */
function luhnValid(digits) {
	let sum = 0;
	let alt = false;
	for (let i = digits.length - 1; i >= 0; i -= 1) {
		let n = digits.charCodeAt(i) - 48;
		if (n < 0 || n > 9) return false;
		if (alt) {
			n *= 2;
			if (n > 9) n -= 9;
		}
		sum += n;
		alt = !alt;
	}
	return sum % 10 === 0;
}

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const CARDISH_RE = /\b(?:\d[ -]?){12,19}\b/g;
const IBAN_RE = /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}\b/g;
const PHONE_RE = /(?:\+\d{1,3}[ .-]?)?(?:\(\d{2,4}\)[ .-]?|\d{2,4}[ .-])\d{3,4}[ .-]\d{3,4}\b/g;
const CVV_RE = /\b(?:cvv|cvc|cid|security code)\b\s*[:#]?\s*\d{3,4}\b/gi;
const SSNISH_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
const LONG_TOKEN_RE = /\b[A-Za-z0-9_-]{32,}\b/g;

/**
 * Strip payment and identity material out of page text.
 *
 * Returns the cleaned text plus a count per class, which the extension shows in
 * its privacy panel: "3 redactions" is the only honest way to tell someone what
 * left their device, and it is checkable against the text we display.
 */
export function redactPageText(raw) {
	const counts = { card: 0, iban: 0, email: 0, phone: 0, cvv: 0, government_id: 0, token: 0 };
	let text = String(raw || '');

	text = text.replace(CVV_RE, () => {
		counts.cvv += 1;
		return '[security code removed]';
	});
	text = text.replace(CARDISH_RE, (match) => {
		const digits = match.replace(/[^\d]/g, '');
		// A 12-19 digit run that passes Luhn is a card number often enough that
		// the cost of being wrong (dropping an order id) is worth paying every
		// time. A run that fails Luhn is left alone: order numbers, tracking
		// numbers, and SKUs are exactly the context a finding needs.
		if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) {
			counts.card += 1;
			return `[card ending ${digits.slice(-4)}]`;
		}
		return match;
	});
	text = text.replace(IBAN_RE, () => {
		counts.iban += 1;
		return '[bank account removed]';
	});
	text = text.replace(SSNISH_RE, () => {
		counts.government_id += 1;
		return '[government id removed]';
	});
	text = text.replace(EMAIL_RE, () => {
		counts.email += 1;
		return '[email removed]';
	});
	text = text.replace(PHONE_RE, () => {
		counts.phone += 1;
		return '[phone removed]';
	});
	text = text.replace(LONG_TOKEN_RE, () => {
		counts.token += 1;
		return '[token removed]';
	});

	const total = Object.values(counts).reduce((a, b) => a + b, 0);
	return { text: text.replace(/[ \t]+/g, ' ').trim(), counts, redactionCount: total };
}

// ── Deterministic findings ───────────────────────────────────────────────────

/** Recurrence, trial, fee, and cancellation language, with what each implies. */
const PHRASE_RULES = [
	{
		id: 'recurring',
		severity: 'flag',
		re: /\b(auto-?renew(s|al|ing)?|recurring|rebill(ed|ing)?|subscription|billed (monthly|annually|yearly|weekly)|per month|per year|\/mo\b|\/yr\b|every month|monthly thereafter)\b/i,
		title: 'This sets up a repeating charge',
		detail: 'The page describes a charge that repeats rather than a single payment.',
	},
	{
		id: 'trial_converts',
		severity: 'flag',
		re: /\b(free trial|trial period|after (your |the )?trial|then \$?\d|at the end of the trial|trial (ends|expires))\b/i,
		title: 'A trial converts into a paid plan',
		detail: 'A trial is mentioned alongside a later charge, so the free period ends in a payment unless it is cancelled.',
	},
	{
		id: 'cancellation_terms',
		severity: 'notice',
		re: /\b(cancel(lation)?|non-?refundable|no refunds?|refund (policy|window)|notice period|cancel at least|30 days'? notice)\b/i,
		title: 'There are conditions on cancelling or refunding',
		detail: 'The page carries cancellation or refund conditions worth reading before confirming.',
	},
	{
		id: 'preselected_addon',
		severity: 'flag',
		re: /\b(pre-?selected|already (added|included)|uncheck (this|the box)|opt out|by default you)\b/i,
		title: 'Something may be pre-selected for you',
		detail: 'The page uses language associated with add-ons that are enabled unless you turn them off.',
	},
	{
		id: 'price_increase_later',
		severity: 'flag',
		re: /\b(introductory (rate|price|offer)|first (year|month) only|renews at|then \$?\d+(\.\d{2})? ?(per|\/)|price (will )?increase)\b/i,
		title: 'The price changes after the first period',
		detail: 'The advertised rate is introductory; a different amount applies when it renews.',
	},
];

/** Amount roles the extension labels from the surrounding DOM text. */
const FEE_ROLES = new Set(['fee', 'surcharge', 'handling', 'processing', 'service']);

function toMinor(amount) {
	if (!amount || typeof amount.value !== 'number' || !Number.isFinite(amount.value)) return null;
	return Math.round(amount.value);
}

/**
 * Every check that can be decided from numbers alone, with no model involved.
 *
 * `extract` is the shape the content script produces:
 *   { url, title, text, amounts: [{ value, currency, role, context }], quoted }
 * where `value` is INTEGER MINOR UNITS. Parsing "$49.99" into 4999 happens in
 * the content script, next to the DOM that gave it the currency; by the time a
 * number reaches here it is an integer or it is ignored.
 */
export function deterministicFindings(extract) {
	const findings = [];
	const amounts = Array.isArray(extract?.amounts) ? extract.amounts : [];
	const currency = String(extract?.currency || amounts[0]?.currency || 'USD').toUpperCase();
	const text = String(extract?.text || '');

	const totals = amounts.filter((a) => a.role === 'total');
	const total = totals.length ? toMinor(totals[totals.length - 1]) : null;
	const quoted = extract?.quoted ? toMinor(extract.quoted) : null;

	// 1. The headline check: the number you are about to pay against the number
	//    that got you here. This is the finding the whole feature exists for.
	if (total !== null && quoted !== null && total > quoted) {
		const delta = total - quoted;
		findings.push({
			id: 'total_above_quoted',
			severity: 'flag',
			title: 'The total is higher than the price you were shown',
			detail: `You saw ${formatAmount(quoted, currency)} earlier and this page charges ${formatAmount(total, currency)}, a difference of ${formatAmount(delta, currency)}.`,
			amount: delta,
			currency,
			source: 'arithmetic',
		});
	}

	// 2. Do the parts add up to the whole? A total that exceeds its own line
	//    items means something was added without a row of its own.
	const lines = amounts.filter((a) => a.role === 'line' || a.role === 'subtotal');
	const fees = amounts.filter((a) => FEE_ROLES.has(a.role));
	const tax = amounts.filter((a) => a.role === 'tax' || a.role === 'shipping');
	if (total !== null && lines.length) {
		const declared = [...lines, ...fees, ...tax]
			.map(toMinor)
			.filter((n) => n !== null)
			.reduce((a, b) => a + b, 0);
		const gap = total - declared;
		// A one-unit gap is rounding, not a dark pattern.
		if (Math.abs(gap) > 1) {
			findings.push({
				id: gap > 0 ? 'unexplained_addition' : 'total_below_lines',
				severity: gap > 0 ? 'flag' : 'info',
				title:
					gap > 0
						? 'The total is more than the items listed'
						: 'The total is less than the items listed',
				detail:
					gap > 0
						? `The listed amounts come to ${formatAmount(declared, currency)} but the total is ${formatAmount(total, currency)}. ${formatAmount(gap, currency)} is not itemised on this page.`
						: `The listed amounts come to ${formatAmount(declared, currency)} and the total is ${formatAmount(total, currency)}, so a discount of ${formatAmount(-gap, currency)} is applied.`,
				amount: Math.abs(gap),
				currency,
				source: 'arithmetic',
			});
		}
	}

	// 3. Fees called out on their own, so the number is visible even when the
	//    total happens to match what was quoted.
	if (fees.length) {
		const feeTotal = fees.map(toMinor).filter((n) => n !== null).reduce((a, b) => a + b, 0);
		if (feeTotal > 0) {
			findings.push({
				id: 'fees_present',
				severity: 'notice',
				title: `${formatAmount(feeTotal, currency)} of this is fees`,
				detail: fees
					.map((f) => `${f.context || 'Fee'}: ${formatAmount(toMinor(f) ?? 0, currency)}`)
					.join('. '),
				amount: feeTotal,
				currency,
				source: 'arithmetic',
			});
		}
	}

	// 4. Language checks. These say a phrase is present, not what it means; the
	//    model reads the clause itself in the second pass.
	for (const rule of PHRASE_RULES) {
		const match = text.match(rule.re);
		if (!match) continue;
		findings.push({
			id: rule.id,
			severity: rule.severity,
			title: rule.title,
			detail: rule.detail,
			evidence: excerptAround(text, match.index ?? text.indexOf(match[0])),
			source: 'phrase',
		});
	}

	return findings;
}

/** A readable window of text around a match, for "here is where I saw that". */
export function excerptAround(text, index, span = 160) {
	if (index < 0) return '';
	const start = Math.max(0, index - Math.floor(span / 2));
	const end = Math.min(text.length, start + span);
	const slice = text.slice(start, end).trim();
	return `${start > 0 ? '…' : ''}${slice}${end < text.length ? '…' : ''}`;
}

// ── Model pass ───────────────────────────────────────────────────────────────

export const SYSTEM_PROMPT = [
	'You read checkout and payment pages and report, in plain language, what a person is actually agreeing to.',
	'',
	'Report only what the supplied text states. Quote or closely paraphrase the page.',
	'',
	'Hard limits:',
	'- Never perform arithmetic and never state, correct, or infer a total, fee, or difference. The amounts are computed separately and any number you produce is discarded.',
	'- Never judge legality, compliance, or regulation. Do not call anything illegal, unlawful, non-compliant, fraudulent, a scam, or a violation. You are describing a page, not rendering a verdict.',
	'- Never advise whether to complete the purchase.',
	'- If the text does not support a finding, return no finding. An empty list is a correct answer and a normal one: most checkouts are ordinary.',
	'',
	'Focus on clauses a person would want to know before confirming: what the charge is for, whether it repeats and how often, what happens when a trial ends, conditions on cancelling or refunding, and anything the page commits them to beyond this one payment.',
	'',
	'Respond with JSON only: {"findings":[{"severity":"flag"|"notice"|"info","title":"under 70 characters","detail":"one or two sentences","evidence":"the phrase from the page"}]}',
].join('\n');

/** The user-side prompt: redacted page text, never form values, never amounts. */
export function buildAnalysisPrompt(extract, { maxChars = 6000 } = {}) {
	const text = String(extract?.text || '').slice(0, maxChars);
	const host = safeHost(extract?.url);
	return [
		host ? `Site: ${host}` : null,
		extract?.title ? `Page title: ${String(extract.title).slice(0, 200)}` : null,
		'',
		'Page text:',
		text,
	]
		.filter((line) => line !== null)
		.join('\n');
}

function safeHost(url) {
	try {
		return new URL(String(url)).host;
	} catch {
		return null;
	}
}

const BANNED_VERDICT_RE = /\b(illegal|unlawful|non-?compliant|violat(es|ion|ing)|fraud(ulent)?|scam|criminal|sue|lawsuit|breaks? the law|against the law)\b/i;
const SEVERITIES = new Set(['flag', 'notice', 'info']);

/**
 * Take the model's JSON and keep only what it is allowed to have said.
 *
 * A finding is dropped, not softened, when it renders a legal verdict or claims
 * an amount. Softening would leave a mangled sentence on a payment screen with
 * our avatar's face on it; dropping loses one line of a list that is allowed to
 * be empty.
 */
export function sanitizeModelFindings(raw) {
	let parsed = raw;
	if (typeof raw === 'string') {
		const start = raw.indexOf('{');
		const end = raw.lastIndexOf('}');
		if (start === -1 || end <= start) return [];
		try {
			parsed = JSON.parse(raw.slice(start, end + 1));
		} catch {
			return [];
		}
	}
	const list = Array.isArray(parsed?.findings) ? parsed.findings : [];
	const out = [];
	for (const item of list) {
		const title = String(item?.title || '').trim();
		const detail = String(item?.detail || '').trim();
		if (!title || !detail) continue;
		if (BANNED_VERDICT_RE.test(title) || BANNED_VERDICT_RE.test(detail)) continue;
		// The model was told not to produce amounts; one that appears anyway is
		// unverified arithmetic, which is the exact failure mode rule 1 exists
		// to prevent.
		if (/[$€£¥]\s?\d|\b\d+\.\d{2}\b/.test(detail)) continue;
		const severity = SEVERITIES.has(item?.severity) ? item.severity : 'info';
		out.push({
			id: `model_${out.length}`,
			severity,
			title: title.slice(0, 90),
			detail: detail.slice(0, 400),
			evidence: String(item?.evidence || '').slice(0, 240),
			source: 'reading',
		});
		if (out.length >= 6) break;
	}
	return out;
}

const SEVERITY_RANK = { flag: 0, notice: 1, info: 2 };

/**
 * Merge both passes into one ordered list.
 *
 * Arithmetic findings always sort above read findings at equal severity: a
 * number we computed is worth more than a sentence we paraphrased, and it is
 * the one the person can check against their own screen in two seconds.
 */
export function mergeFindings(deterministic, model) {
	const seen = new Set();
	const all = [...(deterministic || []), ...(model || [])];
	const merged = [];
	for (const f of all) {
		const key = `${f.severity}:${f.title.toLowerCase().replace(/[^a-z ]/g, '').trim()}`;
		if (seen.has(key)) continue;
		seen.add(key);
		merged.push(f);
	}
	const weight = (f) => (f.source === 'arithmetic' ? 0 : f.source === 'phrase' ? 1 : 2);
	return merged.sort(
		(a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || weight(a) - weight(b),
	);
}

/** One line for the avatar to say out loud, or null when there is nothing to say. */
export function spokenSummary(findings, currency = 'USD') {
	const flags = findings.filter((f) => f.severity === 'flag');
	if (!flags.length) return null;
	const money = flags.find((f) => f.source === 'arithmetic' && typeof f.amount === 'number');
	if (money && money.id === 'total_above_quoted') {
		return `Heads up: this total is ${formatAmount(money.amount, currency)} more than the price you were shown.`;
	}
	if (money) {
		return `Heads up: ${formatAmount(money.amount, currency)} on this page is not itemised.`;
	}
	return `Heads up: ${flags[0].title.charAt(0).toLowerCase()}${flags[0].title.slice(1)}.`;
}

/**
 * The whole read, in one call.
 *
 * `complete` is `({ system, user }) => Promise<string>`, supplied by the caller
 * so this module never imports the LLM chain. When it throws or is absent the
 * arithmetic findings still stand: a checkout read that degrades to "the total
 * is $12.50 more than you were quoted" is the most valuable part of the feature
 * anyway, and it must never depend on a model being reachable.
 */
export async function analyzeCheckout(extract, { complete = null, maxChars = 6000 } = {}) {
	const redacted = redactPageText(extract?.text || '');
	const safeExtract = { ...extract, text: redacted.text };
	const deterministic = deterministicFindings(safeExtract);

	let model = [];
	let readingStatus = 'skipped';
	if (complete && redacted.text.length > 40) {
		try {
			const raw = await complete({
				system: SYSTEM_PROMPT,
				user: buildAnalysisPrompt(safeExtract, { maxChars }),
			});
			model = sanitizeModelFindings(raw);
			readingStatus = 'ok';
		} catch {
			// The arithmetic pass is the floor. A model outage costs the prose
			// findings and nothing else, and the response says so rather than
			// implying the page was fully read.
			readingStatus = 'unavailable';
		}
	}

	const currency = String(extract?.currency || extract?.amounts?.[0]?.currency || 'USD').toUpperCase();
	const findings = mergeFindings(deterministic, model);
	return {
		findings,
		spoken: spokenSummary(findings, currency),
		currency,
		reading_status: readingStatus,
		redactions: redacted.redactionCount,
		redaction_counts: redacted.counts,
	};
}
