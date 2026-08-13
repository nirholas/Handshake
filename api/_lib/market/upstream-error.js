// Shared client contract for GeckoTerminal (api/_lib/market/ohlcv.js) failures.
//
// ohlcv.js deliberately preserves the real upstream status on the errors it
// throws so callers can tell a missing pool from a throttle from an outage. What
// it does NOT do is decide how that reaches the client, and every handler used to
// answer differently:
//   - an unmapped 502 bubbled into wrap(), which logs `[api] unhandled`, captures
//     to Sentry, and pages ops once per request, for someone else's rate limit;
//   - an unmapped 429/404 came back as `bad_request` with the vendor's raw body
//     (ref ids and all) pasted into error_description;
//   - a handler that forwarded `err.code` emitted `{"error": undefined}`, i.e. a
//     JSON error with no error code at all, because upstream errors carry a
//     status but never a code.
// One mapper, used by every market-data handler, so the answer is the same
// everywhere and a third-party throttle never reads as a three.ws bug.

import { error } from '../http.js';

// Classify an ohlcv.js failure into the response contract. Pure, so the mapping
// is unit-testable without a live upstream.
export function classifyMarketError(err) {
	const upstream = err?.status;
	if (upstream === 404) {
		return {
			status: 404,
			code: 'pool_not_found',
			message: 'no indexed pool or candle history for this market',
			retryable: false,
		};
	}
	if (upstream === 429) {
		return {
			status: 503,
			code: 'upstream_rate_limited',
			message: 'the market data source is throttled, retry shortly',
			retryable: true,
		};
	}
	return {
		status: 502,
		code: 'upstream_error',
		message: 'the market data source is temporarily unavailable',
		retryable: false,
	};
}

// Answer a market-data failure. The upstream body is never echoed: it carries
// vendor ref ids and nothing a caller can act on.
export function marketUpstreamError(res, err) {
	const mapped = classifyMarketError(err);
	return error(res, mapped.status, mapped.code, mapped.message, { retryable: mapped.retryable });
}

// Marker set on an error that came out of a market-data call, so a single catch
// at the top of a handler can tell an upstream fault apart from the handler's own
// validation errors (which carry their own status + code) and from a genuine bug
// (which must keep bubbling to wrap() so it is logged and alerted).
const MARKET_UPSTREAM = Symbol.for('three.ws.marketUpstream');

// Run a market-data call, tagging whatever it throws as an upstream fault.
export async function callMarket(fn) {
	try {
		return await fn();
	} catch (err) {
		const tagged = err instanceof Error ? err : new Error(String(err));
		tagged[MARKET_UPSTREAM] = true;
		throw tagged;
	}
}

export function isMarketUpstreamError(err) {
	return Boolean(err && err[MARKET_UPSTREAM]);
}
