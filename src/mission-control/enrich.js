/**
 * Mission Control — per-mint enrichment.
 *
 * The launch stream gives us thin rows (mint, name, symbol, market cap). The
 * intel score, firewall verdict, and smart-money flow come from three real,
 * public, rate-limited endpoints. Fetching them for every row on a fast stream
 * would hammer those services, so this layer:
 *
 *   • caches each result with a short TTL (the endpoints themselves cache too),
 *   • dedupes in-flight requests so N panes asking for the same mint share one,
 *   • bounds concurrency so a burst of newly-visible rows can't open 50 sockets,
 *   • patches results onto the store row so every pane sees the same data.
 *
 * Only rows the user can actually see (virtualized feed → ~20 at a time, plus
 * the selected coin) get enriched — never the whole 300-row buffer.
 */

const TTL = { intel: 30_000, safety: 25_000, smart: 20_000 };
const MAX_CONCURRENT = 4;

export function createEnricher({ store }) {
	const cache = new Map(); // key -> { at, value }
	const inflight = new Map(); // key -> Promise
	const queue = [];
	let running = 0;

	function net() {
		return store.getNetwork();
	}
	function key(kind, mint) {
		return `${net()}:${kind}:${mint}`;
	}
	function cached(kind, mint) {
		const hit = cache.get(key(kind, mint));
		if (hit && Date.now() - hit.at < TTL[kind]) return hit.value;
		return undefined;
	}

	function pump() {
		while (running < MAX_CONCURRENT && queue.length) {
			const job = queue.shift();
			running += 1;
			job().finally(() => {
				running -= 1;
				pump();
			});
		}
	}

	function schedule(fn) {
		return new Promise((resolve) => {
			queue.push(() => fn().then(resolve, () => resolve(null)));
			pump();
		});
	}

	// Bounded per request. Enrichment runs behind a small concurrency queue, so
	// a single stalled upstream would otherwise hold a queue slot forever and
	// starve every later row of its enrichment.
	async function fetchJson(url, { timeout = 8000 } = {}) {
		const r = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeout) });
		if (!r.ok) throw new Error(`HTTP ${r.status}`);
		return r.json();
	}

	function run(kind, mint, urlFor, shape, patchFor) {
		const k = key(kind, mint);
		const hit = cached(kind, mint);
		if (hit !== undefined) {
			if (patchFor) store.enrichRow(mint, patchFor(hit));
			return Promise.resolve(hit);
		}
		if (inflight.has(k)) return inflight.get(k);
		const p = schedule(async () => {
			try {
				const raw = await fetchJson(urlFor(mint));
				const value = shape ? shape(raw) : raw;
				cache.set(k, { at: Date.now(), value });
				if (patchFor) store.enrichRow(mint, patchFor(value));
				return value;
			} catch {
				// Honest failure: cache a null briefly so we don't retry-storm, and
				// mark the row's field as unavailable rather than faking a value.
				cache.set(k, { at: Date.now(), value: null });
				if (patchFor) store.enrichRow(mint, patchFor(null));
				return null;
			} finally {
				inflight.delete(k);
			}
		});
		inflight.set(k, p);
		return p;
	}

	const ensureIntel = (mint) =>
		run(
			'intel',
			mint,
			(m) => `/api/pump/intel?mint=${encodeURIComponent(m)}&network=${net()}`,
			(raw) => raw?.coin || (raw?.found === false ? { _none: true } : null),
			(coin) => ({ intel: coin }),
		);

	const ensureSafety = (mint, amountSol) =>
		run(
			'safety',
			mint,
			(m) => {
				const u = new URLSearchParams({ mint: m, network: net() });
				if (amountSol > 0) u.set('amount', String(amountSol));
				return `/api/pump/safety?${u.toString()}`;
			},
			(raw) => raw, // { verdict, score, simulated, reasons, checks }
			(v) => ({ safety: v }),
		);

	const ensureSmart = (mint) =>
		run(
			'smart',
			mint,
			(m) => `/api/intel/smart-money?mint=${encodeURIComponent(m)}&network=${net()}`,
			(raw) => raw, // { smart_money_score, count, wallets, clusters, computed, ... }
			(v) => ({ smart: v }),
		);

	return {
		ensureIntel,
		ensureSafety,
		ensureSmart,
		/** Light enrichment for a visible feed row: intel score + smart-money + firewall verdict. */
		ensureRow(mint, amountSol) {
			ensureIntel(mint);
			ensureSmart(mint);
			ensureSafety(mint, amountSol);
		},
		/** Drop everything for a mint so the focus pane refetches fresh. */
		invalidate(mint) {
			for (const kind of Object.keys(TTL)) cache.delete(key(kind, mint));
		},
		clear() {
			cache.clear();
			inflight.clear();
			queue.length = 0;
		},
	};
}
