// Pure logic behind /converter: USD-anchored conversion math, amount / asset
// formatting, and the shareable-URL codec. Everything here is DOM-free and
// side-effect-free so the browser module (src/converter.js) stays a thin
// rendering layer and this can be unit tested directly.
//
// Asset shapes used throughout:
//   crypto: { kind:'crypto', id, symbol, name, image, priceUSD }
//   fiat:   { kind:'fiat', code, name, unit, per_btc }
// `per_btc` is the fiat's units per 1 BTC, as served by /api/coin/rates. A
// `usdPerBtc` anchor turns that into units per 1 USD, which is what the math
// below runs on.

/** Placeholder glyph for a value the page cannot compute yet. */
export const EMPTY = '\u2014';

/** Largest amount the converter accepts. Beyond this the result is noise. */
export const MAX_AMOUNT = 1e15;

// ── Conversion math (USD anchored) ────────────────────────────────────────────

/** Units of `fiat` per 1 USD, derived from the shared BTC anchor. */
export function fiatPerUsd(fiat, usdPerBtc) {
	if (!fiat || !Number.isFinite(fiat.per_btc)) return NaN;
	if (!Number.isFinite(usdPerBtc) || usdPerBtc <= 0) return NaN;
	return fiat.per_btc / usdPerBtc;
}

/** USD value of `amount` units of `asset`. Null when the asset has no price. */
export function toUsd(amount, asset, usdPerBtc) {
	if (!asset || !Number.isFinite(amount)) return null;
	if (asset.kind === 'crypto') {
		if (!Number.isFinite(asset.priceUSD)) return null;
		return amount * asset.priceUSD;
	}
	const perUsd = fiatPerUsd(asset, usdPerBtc);
	if (!Number.isFinite(perUsd) || perUsd <= 0) return null;
	return amount / perUsd;
}

/** Express a USD value in `asset`. Null when the asset has no usable price. */
export function fromUsd(valueUsd, asset, usdPerBtc) {
	if (!asset || !Number.isFinite(valueUsd)) return null;
	if (asset.kind === 'crypto') {
		if (!Number.isFinite(asset.priceUSD) || asset.priceUSD <= 0) return null;
		return valueUsd / asset.priceUSD;
	}
	const perUsd = fiatPerUsd(asset, usdPerBtc);
	if (!Number.isFinite(perUsd)) return null;
	return valueUsd * perUsd;
}

/**
 * Convert `amount` of `from` into `to`. One formula covers all four
 * directions: crypto to crypto, crypto to fiat, fiat to crypto, fiat to fiat.
 * Null whenever either leg is missing a live price.
 */
export function convert(amount, from, to, usdPerBtc) {
	const usd = toUsd(amount, from, usdPerBtc);
	if (usd == null) return null;
	return fromUsd(usd, to, usdPerBtc);
}

// ── Formatting ────────────────────────────────────────────────────────────────

/**
 * Fiat amount with the currency's own unit symbol and thousands separators.
 * Alphabetic units ("Fr.", "R$", "kr") take a space; glyphs ("$", "EUR sign",
 * "rupee sign") hug the number.
 */
export function formatFiatAmount(n, unit) {
	if (n == null || !Number.isFinite(n)) return EMPTY;
	const sign = n < 0 ? '-' : '';
	const abs = Math.abs(n);
	let body;
	if (abs !== 0 && abs < 0.01) body = abs.toPrecision(4);
	else body = abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
	const u = unit || '';
	const sep = /[A-Za-z.]$/.test(u) ? ' ' : '';
	return `${sign}${u}${sep}${body}`;
}

/**
 * Crypto amount: full precision for whole coins, significant figures for the
 * deep decimals a fiat to BTC conversion produces (e.g. 0.00001587 BTC).
 */
export function formatCryptoAmount(n) {
	if (n == null || !Number.isFinite(n)) return EMPTY;
	if (n === 0) return '0';
	const abs = Math.abs(n);
	if (abs >= 1) return n.toLocaleString('en-US', { maximumFractionDigits: 8 });
	const s = n.toPrecision(6);
	const expanded = s.includes('e') ? Number(s).toFixed(18) : s;
	return expanded.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

/** Format `n` in whatever `asset` is: used by the result field and rate line. */
export function formatInAsset(n, asset) {
	if (!asset) return EMPTY;
	return asset.kind === 'fiat' ? formatFiatAmount(n, asset.unit) : formatCryptoAmount(n);
}

/** Short ticker shown on the asset button and in the rate line. */
export function assetCode(asset) {
	if (!asset) return '';
	return asset.kind === 'fiat' ? asset.code : asset.symbol;
}

// ── Shareable URL codec ───────────────────────────────────────────────────────
//
// A converter URL carries the whole view: /converter?from=bitcoin&to=EUR&amount=3
// Fiat sides use their ISO code (USD, EUR); crypto sides use their coin id
// (bitcoin, ethereum). Resolution checks the fiat table first, so a ref is
// unambiguous without a type prefix and the URL stays readable.

/**
 * Parse a normalized amount out of user text or a URL parameter. Returns NaN
 * for anything that is not a finite, non-negative, in-range number so callers
 * have one "no usable amount" signal.
 */
export function parseAmount(raw) {
	if (raw == null) return NaN;
	const text = String(raw).replace(/[,\s]/g, '').trim();
	if (!text || text.length > 24) return NaN;
	if (!/^\d*\.?\d*$/.test(text)) return NaN;
	const n = Number(text);
	if (!Number.isFinite(n) || n < 0 || n > MAX_AMOUNT) return NaN;
	return n;
}

/** Serialize an amount back into URL form without trailing float noise. */
function amountParam(n) {
	if (!Number.isFinite(n)) return null;
	// Avoid exponent notation, which parseAmount deliberately rejects.
	const fixed = n < 1e-6 && n > 0 ? n.toFixed(12).replace(/0+$/, '') : String(n);
	return fixed.includes('e') ? n.toFixed(12).replace(/0+$/, '').replace(/\.$/, '') : fixed;
}

/** The URL ref for an asset: its ISO code (fiat) or coin id (crypto). */
export function assetRef(asset) {
	if (!asset) return null;
	return asset.kind === 'fiat' ? asset.code : asset.id;
}

/**
 * Build the query string for the current view. Returns "" when there is
 * nothing worth sharing, so the canonical /converter URL stays clean.
 */
export function buildConverterQuery({ from, to, amount } = {}) {
	const params = new URLSearchParams();
	const f = assetRef(from);
	const t = assetRef(to);
	if (f) params.set('from', f);
	if (t) params.set('to', t);
	const a = amountParam(amount);
	if (a != null && a !== '1') params.set('amount', a);
	const q = params.toString();
	return q ? `?${q}` : '';
}

/**
 * Read a converter view out of a query string. `amount` is NaN when absent or
 * unusable; refs are trimmed, length-capped strings or null.
 */
export function parseConverterQuery(search) {
	const params = new URLSearchParams(search || '');
	const ref = (key) => {
		const v = params.get(key);
		if (!v) return null;
		const trimmed = v.trim();
		// Coin ids and ISO codes are short slugs; anything longer is not a ref.
		if (!trimmed || trimmed.length > 64 || !/^[A-Za-z0-9._-]+$/.test(trimmed)) return null;
		return trimmed;
	};
	return { from: ref('from'), to: ref('to'), amount: parseAmount(params.get('amount')) };
}

/**
 * Turn a URL ref into an asset descriptor the page can load. Fiat wins when the
 * uppercased ref names a currency in `fiatByCode`; everything else is treated
 * as a coin id. Null for an empty ref.
 */
export function resolveAssetRef(ref, fiatByCode) {
	if (!ref) return null;
	const upper = ref.toUpperCase();
	if (fiatByCode && fiatByCode.has(upper)) return { kind: 'fiat', code: upper };
	return { kind: 'crypto', id: ref.toLowerCase() };
}
