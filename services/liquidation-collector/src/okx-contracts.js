// OKX contract specifications.
//
// The liquidation-orders channel reports `sz` in CONTRACTS. One BTC-USDT-SWAP
// contract is 0.01 BTC, one BONK-USDT-SWAP contract is 100000 BONK, and one
// BTC-USD-SWAP contract is 100 USD of notional. Without these multipliers the
// USD value of every OKX liquidation is wrong by orders of magnitude, so the
// collector loads them from the public instruments endpoint at boot and
// refreshes them periodically (new listings appear between restarts).
//
// No key or account is required: this is the same public REST surface the
// exchange serves to anonymous callers.

const INSTRUMENTS_URL = 'https://www.okx.com/api/v5/public/instruments?instType=SWAP';
const REFRESH_MS = 6 * 60 * 60 * 1000;
const MIN_REFRESH_MS = 60_000;
const QUOTE_CURRENCIES = ['USD', 'USDT', 'USDC'];

/**
 * @param {Array<Record<string, string>>} rows raw `data` array from OKX
 * @returns {Map<string, { ctVal: number, ctMult: number, quoteDenominated: boolean }>}
 */
export function parseInstruments(rows) {
	const map = new Map();
	for (const row of rows ?? []) {
		const instId = String(row.instId ?? '');
		const ctVal = parseFloat(row.ctVal);
		const ctMult = row.ctMult === undefined || row.ctMult === '' ? 1 : parseFloat(row.ctMult);
		if (!instId || !Number.isFinite(ctVal) || ctVal <= 0) continue;
		if (!Number.isFinite(ctMult) || ctMult <= 0) continue;
		map.set(instId, {
			ctVal,
			ctMult,
			quoteDenominated: QUOTE_CURRENCIES.includes(String(row.ctValCcy ?? '').toUpperCase()),
		});
	}
	return map;
}

/**
 * Live registry of OKX swap contract sizes.
 *
 * @param {{ fetchImpl?: typeof fetch, url?: string, refreshMs?: number, minRefreshMs?: number, now?: () => number, log?: (msg: string) => void }} [opts]
 */
export function createOkxContractRegistry({
	fetchImpl = fetch,
	url = INSTRUMENTS_URL,
	refreshMs = REFRESH_MS,
	minRefreshMs = MIN_REFRESH_MS,
	now = Date.now,
	log = console.log,
} = {}) {
	let contracts = new Map();
	let lastAttempt = 0;
	let inFlight = null;
	let timer = null;

	async function refresh() {
		if (inFlight) return inFlight;
		lastAttempt = now();
		inFlight = (async () => {
			try {
				const resp = await fetchImpl(url, {
					headers: { accept: 'application/json' },
					signal: AbortSignal.timeout(15_000),
				});
				if (!resp.ok) throw new Error(`instruments responded ${resp.status}`);
				const body = await resp.json();
				const parsed = parseInstruments(body?.data);
				if (parsed.size === 0) throw new Error('instruments payload had no usable contracts');
				contracts = parsed;
				log(`[OKX] loaded ${parsed.size} swap contract sizes`);
				return parsed;
			} catch (err) {
				log(`[OKX] contract sizes unavailable (${err.message}); OKX liquidations are dropped until this succeeds`);
				return contracts;
			} finally {
				inFlight = null;
			}
		})();
		return inFlight;
	}

	return {
		refresh,
		get size() {
			return contracts.size;
		},
		/**
		 * Contract spec for an instrument, or undefined when it is unknown. A
		 * miss schedules a rate-limited refresh so a brand-new listing starts
		 * counting within the minute instead of at the next restart.
		 */
		get(instId) {
			const hit = contracts.get(instId);
			if (hit) return hit;
			if (now() - lastAttempt >= minRefreshMs) refresh();
			return undefined;
		},
		start() {
			if (timer) return;
			timer = setInterval(() => { refresh(); }, refreshMs);
			timer.unref?.();
		},
		stop() {
			if (!timer) return;
			clearInterval(timer);
			timer = null;
		},
	};
}
