// Shared CoinPaprika client — one place that owns the free tier's budget.
//
// **The free tier allows sixty requests per HOUR** (hard cap 25k/month). Past
// that, every request returns `402 payment_required` and the client is blocked
// for a full hour. Three separate surfaces draw on that single budget:
//
//   api/_lib/coin-fallbacks.js   coin profile + exchange listings fallback
//   api/_lib/market-fallbacks.js global stats fallback
//   api/x402/market-heatmap.js   the paid heatmap endpoint's fallback
//
// so the health state has to be process-wide, exactly like the demo-key health
// in api/_lib/coingecko.js. Without it, one surface exhausting the budget leaves
// the others paying a wasted round-trip per request for the rest of the hour,
// and the paid endpoint spends latency discovering what a sibling module already
// knew.
//
// Callers should ALSO cache what they get back. This module bounds the damage of
// a spent budget; it cannot create requests that don't exist. See the payload
// cache in coin-fallbacks.js for the pattern that actually makes 60/hour usable
// under load.

const PAPRIKA_BLOCK_MS = 60 * 60_000;
// 402 = hourly/monthly budget spent (their documented reply), 429 = throttled.
const BUDGET_STATUSES = new Set([402, 429]);

let _benchedUntil = 0;

/** True while CoinPaprika is blocked for exceeding its free-tier budget. */
export function isPaprikaBenched(now = Date.now()) {
	return _benchedUntil > now;
}

/** Bench CoinPaprika for its stated block duration. Exported for tests. */
export function benchPaprika(now = Date.now()) {
	_benchedUntil = now + PAPRIKA_BLOCK_MS;
}

/** Clear the bench. Test-only hook; production heals when the block expires. */
export function resetPaprikaHealth() {
	_benchedUntil = 0;
}

/** Note a budget rejection observed by a caller that fetches on its own. */
export function notePaprikaStatus(status) {
	if (BUDGET_STATUSES.has(status)) {
		benchPaprika();
		console.warn(`[coinpaprika] ${status} — free-tier budget spent; benching for 1h`);
		return true;
	}
	return false;
}

export const PAPRIKA_BASE = 'https://api.coinpaprika.com/v1';

/**
 * GET a CoinPaprika URL, returning null on any miss and never throwing.
 *
 * Deliberately a direct fetch rather than a `fetchFirst` provider: the shared
 * failover primitive rejects every non-2xx alike and before its parser runs, so
 * a 402 would be indistinguishable from a timeout — and the 402 is the one
 * status that must change FUTURE behaviour rather than just this call's outcome.
 *
 * @param {string} url              absolute CoinPaprika URL
 * @param {number} [timeoutMs=8000]
 * @returns {Promise<any|null>} parsed body, or null on miss/budget/error
 */
export async function paprikaGet(url, timeoutMs = 8000) {
	if (isPaprikaBenched()) return null;
	try {
		const res = await fetch(url, {
			headers: { accept: 'application/json', 'user-agent': 'three.ws/1.0' },
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (notePaprikaStatus(res.status)) return null;
		if (!res.ok) return null;
		const body = await res.json();
		// The budget reply is JSON carrying this marker; honour it whatever status
		// delivered it.
		if (body?.type === 'payment_required') {
			benchPaprika();
			console.warn('[coinpaprika] payment_required — free-tier budget spent; benching for 1h');
			return null;
		}
		return body ?? null;
	} catch {
		return null;
	}
}
