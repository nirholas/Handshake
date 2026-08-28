// Turning a checkout page into something safe to send.
//
// This module is the client-side half of the checkout companion and the only
// code that ever touches a live payment page. Everything it does is shaped by
// one rule, stated here because every future edit has to keep it true:
//
//   IT NEVER READS AN INPUT. Not the value, not the placeholder, not a
//   contenteditable, not a shadow root's form, not an iframe. The card number,
//   the CVV, the billing address and the email are all in inputs, and the
//   simplest way to guarantee we never transmit them is to have no code path
//   that can read them. `collectText()` refuses those nodes structurally rather
//   than filtering their contents afterwards, because a filter is a list of the
//   cases someone thought of.
//
// What it does read is what the page has already rendered as text: the prices,
// the labels beside them, and the terms block. That is exactly the information
// the person is looking at and, by definition, not their secret.
//
// It is a plain ES module so the parsing is testable in Node without a browser
// (tests/checkout-extract.test.js). The content script loads it with a dynamic
// import of a web-accessible resource.

/** Currencies whose smallest unit is the major unit: no cents to parse. */
const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'XAF', 'XOF']);

const SYMBOL_TO_CODE = {
	$: 'USD',
	'US$': 'USD',
	'€': 'EUR',
	'£': 'GBP',
	'¥': 'JPY',
	'₹': 'INR',
	'R$': 'BRL',
	'C$': 'CAD',
	'A$': 'AUD',
	'₩': 'KRW',
	'₺': 'TRY',
	'zł': 'PLN',
	'CHF': 'CHF',
	'kr': 'SEK',
};

const CODE_RE = /\b(USD|EUR|GBP|JPY|CAD|AUD|CHF|SEK|NOK|DKK|PLN|BRL|MXN|INR|KRW|SGD|HKD|NZD|ZAR|TRY)\b/;
const SYMBOL_RE = /(US\$|R\$|C\$|A\$|zł|CHF|kr|[$€£¥₹₩₺])/;

/**
 * Parse one rendered money string into integer minor units.
 *
 * The hard case is not the symbol, it is the separators: "1.234,56" is twelve
 * hundred euros in most of Europe and "1,234.56" is twelve hundred dollars in
 * the US, and the same page can carry both when a merchant localises badly. The
 * rule used here is positional and needs no locale: whichever separator appears
 * LAST is the decimal point, and only when it is followed by exactly two digits.
 * Anything else is a thousands separator. "1,299" is therefore 129900 minor
 * units, not 1299, which is the reading a person would give it.
 *
 * Returns null for anything that is not unambiguously an amount, which is the
 * common case: page text is full of numbers that are not money.
 */
export function parseAmount(raw, { currencyHint = null } = {}) {
	const text = String(raw || '').trim();
	if (!text) return null;

	const codeMatch = text.match(CODE_RE);
	const symbolMatch = text.match(SYMBOL_RE);
	const currency =
		(codeMatch && codeMatch[1]) ||
		(symbolMatch && SYMBOL_TO_CODE[symbolMatch[1]]) ||
		currencyHint ||
		null;
	// No currency marker anywhere means this is a quantity, a date, or a SKU.
	if (!currency) return null;

	const digits = text.match(/\d[\d.,   ]*\d|\d/);
	if (!digits) return null;
	let body = digits[0].replace(/[   ]/g, '');

	const lastComma = body.lastIndexOf(',');
	const lastDot = body.lastIndexOf('.');
	const sepIndex = Math.max(lastComma, lastDot);
	let major = body;
	let minorDigits = '';

	if (sepIndex !== -1) {
		const tail = body.slice(sepIndex + 1);
		if (/^\d{2}$/.test(tail)) {
			major = body.slice(0, sepIndex);
			minorDigits = tail;
		}
	}
	major = major.replace(/[.,]/g, '');
	if (!/^\d+$/.test(major)) return null;

	const code = currency.toUpperCase();
	const exponent = ZERO_DECIMAL.has(code) ? 0 : 2;
	let value;
	if (exponent === 0) {
		// A zero-decimal currency has no cents, so a trailing ",56" was never a
		// decimal: fold it back on as part of the number.
		value = Number.parseInt(major + minorDigits, 10);
	} else {
		value = Number.parseInt(major, 10) * 100 + Number.parseInt(minorDigits.padEnd(2, '0') || '0', 10);
	}
	if (!Number.isFinite(value)) return null;
	const negative = /^\s*[-−]|\(\s*[^)]*\d[^)]*\)/.test(text);
	return { value: negative ? -value : value, currency: code };
}

/** Label text beside an amount, mapped to the role the analysis reasons about. */
const ROLE_RULES = [
	[/\b(order )?total\b|\bamount due\b|\byou pay\b|\bgrand total\b|\btotal due\b|\bpay now\b|\bcharged today\b/i, 'total'],
	[/\bsub-?total\b|\bitems? total\b|\bmerchandise\b/i, 'subtotal'],
	[/\bshipping\b|\bdelivery\b|\bpostage\b|\bfreight\b/i, 'shipping'],
	[/\btax\b|\bvat\b|\bgst\b|\bhst\b|\bsales tax\b/i, 'tax'],
	[/\bprocessing\b/i, 'processing'],
	[/\bhandling\b/i, 'handling'],
	[/\bservice (fee|charge)\b/i, 'service'],
	[/\bsurcharge\b/i, 'surcharge'],
	[/\bfee\b|\bcharge\b(?! ?card)/i, 'fee'],
	[/\bdiscount\b|\bsavings?\b|\bpromo\b|\bcoupon\b|\boff\b/i, 'discount'],
	[/\bprice\b|\bitem\b|\bqty\b|\beach\b|\bper unit\b/i, 'line'],
];

export function roleFor(label) {
	const text = String(label || '');
	for (const [re, role] of ROLE_RULES) {
		if (re.test(text)) return role;
	}
	return 'unknown';
}

/** Does this page look like a place money changes hands? */
const CHECKOUT_URL_RE = /\/(checkout|cart|payment|pay|billing|subscribe|order|purchase|upgrade|plans?)\b/i;
const CHECKOUT_TEXT_RE = /\b(place (your )?order|complete (your )?purchase|pay now|confirm (and )?pay|order summary|payment method|start (my |your )?(free )?trial|subscribe now|billing address)\b/i;

export function looksLikeCheckout({ url = '', text = '' } = {}) {
	let score = 0;
	if (CHECKOUT_URL_RE.test(url)) score += 2;
	const matches = String(text).match(new RegExp(CHECKOUT_TEXT_RE, 'gi'));
	if (matches) score += Math.min(matches.length, 3);
	return score >= 2;
}

// ── DOM reading ──────────────────────────────────────────────────────────────

/** Node types that hold user secrets. None of them is ever descended into. */
const FORBIDDEN_TAGS = new Set([
	'INPUT',
	'TEXTAREA',
	'SELECT',
	'OPTION',
	'IFRAME',
	'FRAME',
	'OBJECT',
	'EMBED',
	'SCRIPT',
	'STYLE',
	'NOSCRIPT',
	'CANVAS',
	'SVG',
	'TEMPLATE',
]);

/**
 * Is this node a surface a person types into?
 *
 * Both halves are needed. `isContentEditable` is the live, inherited answer a
 * browser computes, and it is the one that catches a child of an editable
 * container. The attribute check catches every environment that does not
 * implement that property, and an editable region is exactly where a payment
 * form built out of divs puts its card field, so failing open here would defeat
 * the whole no-inputs rule.
 */
function isEditable(el) {
	if (!el) return false;
	if (el.isContentEditable === true) return true;
	if (typeof el.getAttribute !== 'function') return false;
	const attr = el.getAttribute('contenteditable');
	return attr !== null && attr !== 'false';
}

function isHidden(el, view) {
	if (!el || !view) return false;
	const style = view.getComputedStyle(el);
	if (!style) return false;
	return style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0';
}

/**
 * Walk visible text out of a document, refusing every node that could hold an
 * entered value, and refusing `contenteditable` for the same reason: some
 * payment forms are rich-text surfaces rather than inputs.
 *
 * `maxChars` bounds the walk so a page with a hundred thousand nodes cannot
 * stall the tab it is running in.
 */
export function collectText(root, { maxChars = 20_000, view = null } = {}) {
	const out = [];
	let used = 0;
	const win = view || (typeof globalThis !== 'undefined' ? globalThis : null);

	const walk = (node) => {
		if (used >= maxChars || !node) return;
		if (node.nodeType === 3) {
			const value = String(node.nodeValue || '').replace(/\s+/g, ' ').trim();
			if (value) {
				out.push(value);
				used += value.length + 1;
			}
			return;
		}
		if (node.nodeType !== 1) return;
		const tag = String(node.tagName || '').toUpperCase();
		if (FORBIDDEN_TAGS.has(tag)) return;
		if (isEditable(node)) return;
		if (node.getAttribute && node.getAttribute('aria-hidden') === 'true') return;
		if (isHidden(node, win)) return;
		for (const child of node.childNodes || []) walk(child);
	};

	walk(root);
	return out.join(' ').slice(0, maxChars);
}

/**
 * Find the money on the page, each amount carrying the label nearest to it.
 *
 * The label is taken from the element's own text with the amount removed, and
 * failing that from the previous sibling or the parent row. That is how a table
 * of "Shipping | $5.00" survives: the number and the word that explains it live
 * in different cells, and an amount with no label is nearly useless because its
 * role is what makes it checkable.
 */
export function collectAmounts(root, { limit = 60, view = null } = {}) {
	const amounts = [];
	const seen = new Set();
	const win = view || (typeof globalThis !== 'undefined' ? globalThis : null);
	const doc = root?.ownerDocument || root;
	if (!doc || typeof doc.createTreeWalker !== 'function') return amounts;

	const walker = doc.createTreeWalker(root, 4 /* SHOW_TEXT */, {
		acceptNode(node) {
			const parent = node.parentElement;
			if (!parent) return 2;
			let el = parent;
			while (el) {
				const tag = String(el.tagName || '').toUpperCase();
				if (FORBIDDEN_TAGS.has(tag) || isEditable(el)) return 2;
				el = el.parentElement;
			}
			if (isHidden(parent, win)) return 2;
			return /\d/.test(node.nodeValue || '') ? 1 : 2;
		},
	});

	let node = walker.nextNode();
	while (node && amounts.length < limit) {
		const raw = String(node.nodeValue || '').trim();
		const parsed = parseAmount(raw);
		if (parsed) {
			const label = labelFor(node.parentElement, raw);
			const key = `${parsed.value}:${parsed.currency}:${label}`;
			if (!seen.has(key)) {
				seen.add(key);
				amounts.push({
					value: parsed.value,
					currency: parsed.currency,
					role: roleFor(label),
					context: label.slice(0, 120) || undefined,
				});
			}
		}
		node = walker.nextNode();
	}
	return amounts;
}

function labelFor(el, amountText) {
	if (!el) return '';
	const strip = (s) => String(s || '').replace(amountText, ' ').replace(/\s+/g, ' ').trim();
	const own = strip(el.textContent);
	if (own) return own;
	const prev = el.previousElementSibling;
	if (prev) {
		const sibling = strip(prev.textContent);
		if (sibling) return sibling;
	}
	const row = el.closest ? el.closest('tr, li, [class*="row"], [class*="line"]') : null;
	if (row) return strip(row.textContent);
	const parent = el.parentElement;
	return parent ? strip(parent.textContent) : '';
}

/**
 * The highest-confidence "total" on the page, used as the price to remember for
 * a later comparison. A product page has no total, so this returns null there
 * and `rememberPrice` in the content script falls back to the largest line.
 */
export function primaryTotal(amounts) {
	const totals = (amounts || []).filter((a) => a.role === 'total');
	if (!totals.length) return null;
	return totals.reduce((best, a) => (a.value > best.value ? a : best), totals[0]);
}

/** Build the exact payload the API accepts, with nothing else attached. */
export function buildExtract({ url, title, text, amounts, quoted = null }) {
	const currency = amounts?.find((a) => a.currency)?.currency || 'USD';
	return {
		url: String(url || '').split('#')[0],
		title: String(title || '').slice(0, 300),
		text: String(text || '').slice(0, 60_000),
		currency,
		amounts: (amounts || []).slice(0, 60),
		quoted: quoted ? { value: quoted.value, currency: quoted.currency || currency } : null,
	};
}
