// GMGN.ai smart money feed — polls the public ranking endpoint.
// Detects new entries and increases in smart-wallet count, then emits
// smart_entry events so the SSE handler can stream them to the browser.
//
// The GMGN WebSocket requires a full browser session fingerprint, so we use
// the public REST rank endpoint with browser-like headers instead. Requests
// go through Vercel's edge IPs; if Cloudflare starts blocking, swap in a
// GMGN_COOKIE env var containing a valid cf_clearance value.

const GMGN_BASE = 'https://gmgn.ai/defi/quotation/v1';
const DEXSCREENER_BASE = 'https://api.dexscreener.com';
const POLL_MS = 30_000;
const FETCH_TIMEOUT_MS = 10_000;

const CHAIN_TO_DEXSCREENER = { sol: 'solana', eth: 'ethereum', base: 'base', bsc: 'bsc', tron: 'tron' };

function gmgnHeaders() {
	const h = {
		'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
		'accept': 'application/json, text/plain, */*',
		'accept-language': 'en-US,en;q=0.9',
		'referer': 'https://gmgn.ai/',
		'origin': 'https://gmgn.ai',
	};
	const cookie = process.env.GMGN_COOKIE;
	if (cookie) h['cookie'] = cookie;
	return h;
}

async function fetchRank({ chain = 'sol', interval = '1h' } = {}) {
	const url = `${GMGN_BASE}/rank/${chain}/swaps/${interval}?orderby=smartmoney&direction=desc`;
	const ctrl = new AbortController();
	const tid = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
	try {
		const r = await fetch(url, { headers: gmgnHeaders(), signal: ctrl.signal });
		if (!r.ok) return { ok: false, status: r.status };
		const d = await r.json();
		return { ok: true, rank: d?.data?.rank ?? [] };
	} catch (err) {
		return { ok: false, error: err?.message };
	} finally {
		clearTimeout(tid);
	}
}

async function fetchDexScreener({ chain = 'sol' } = {}) {
	const dexChain = CHAIN_TO_DEXSCREENER[chain] || 'solana';
	const ctrl = new AbortController();
	const tid = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
	try {
		const boostsRes = await fetch(`${DEXSCREENER_BASE}/token-boosts/top/v1`, {
			headers: { accept: 'application/json' },
			signal: ctrl.signal,
		});
		if (!boostsRes.ok) return { ok: false, status: boostsRes.status };
		const boosts = await boostsRes.json();
		const chainTokens = boosts.filter((t) => t.chainId === dexChain).slice(0, 20);
		if (!chainTokens.length) return { ok: true, rank: [], source: 'dexscreener' };

		const addresses = chainTokens.map((t) => t.tokenAddress).join(',');
		const pairsRes = await fetch(`${DEXSCREENER_BASE}/tokens/v1/${dexChain}/${addresses}`, {
			headers: { accept: 'application/json' },
			signal: ctrl.signal,
		});
		if (!pairsRes.ok) return { ok: false, status: pairsRes.status };
		const pairs = await pairsRes.json();

		const boostMap = new Map(chainTokens.map((t) => [t.tokenAddress, t]));
		const seen = new Set();
		const rank = [];
		for (const pair of pairs) {
			const addr = pair.baseToken?.address;
			if (!addr || seen.has(addr)) continue;
			seen.add(addr);
			const boost = boostMap.get(addr);
			rank.push({
				address: addr,
				symbol: pair.baseToken?.symbol || '???',
				name: pair.baseToken?.name || pair.baseToken?.symbol || 'Unknown',
				price: pair.priceUsd != null ? Number(pair.priceUsd) : null,
				market_cap: pair.marketCap != null ? Number(pair.marketCap) : null,
				volume: pair.volume?.h24 != null ? Number(pair.volume.h24) : null,
				holder_count: null,
				smart_buy_24h: boost?.totalAmount ?? pair.boosts?.active ?? 0,
				smart_sell_24h: 0,
				price_change_1h: pair.priceChange?.h1 != null ? Number(pair.priceChange.h1) : null,
				price_change_24h: pair.priceChange?.h24 != null ? Number(pair.priceChange.h24) : null,
				liquidity: pair.liquidity?.usd != null ? Number(pair.liquidity.usd) : null,
				txns_h1_buys: pair.txns?.h1?.buys ?? null,
				txns_h1_sells: pair.txns?.h1?.sells ?? null,
			});
		}

		rank.sort((a, b) => (b.smart_buy_24h || 0) - (a.smart_buy_24h || 0));
		return { ok: true, rank, source: 'dexscreener' };
	} catch (err) {
		return { ok: false, error: err?.message };
	} finally {
		clearTimeout(tid);
	}
}

let _pollerId = 0;
// Map<pollerId, Map<address, prevItem>>
const _snapshots = new Map();

const BUFFER_LIMIT = 25;
const _buffer = [];

function pushBuffer(ev) {
	const addr = ev.data?.address;
	if (addr) {
		const idx = _buffer.findIndex((e) => e.data?.address === addr);
		if (idx >= 0) _buffer.splice(idx, 1);
	}
	_buffer.unshift(ev);
	while (_buffer.length > BUFFER_LIMIT) _buffer.pop();
}

export function recentGmgnBuffered({ limit = 10 } = {}) {
	return _buffer.slice(0, Math.min(limit, BUFFER_LIMIT));
}

/**
 * Start polling GMGN smart money rankings and emit events for new/increased entries.
 * @param {{ onEvent: Function, signal?: AbortSignal, chain?: string, interval?: string, minSmartBuys?: number }} opts
 * @returns {Function} stop
 */
export function connectGmgnFeed({ onEvent, signal, chain = 'sol', interval = '1h', minSmartBuys = 2 }) {
	const id = ++_pollerId;
	let active = true;
	let timer = null;
	let _gmgnBlocked = false;

	function stop() {
		active = false;
		clearTimeout(timer);
		_snapshots.delete(id);
	}

	signal?.addEventListener('abort', stop);

	async function poll() {
		if (!active) return;

		let result;
		if (!_gmgnBlocked) {
			result = await fetchRank({ chain, interval });
			if (result.ok) {
				result.source = 'gmgn';
			} else if (result.status === 403) {
				_gmgnBlocked = true;
			}
		}

		if (_gmgnBlocked) {
			result = await fetchDexScreener({ chain });
		}

		if (!active) return;

		if (!result.ok) {
			onEvent({ kind: 'status', data: { state: 'error', status: result.status, error: result.error } });
		} else {
			const prev = _snapshots.get(id) || new Map();
			const next = new Map();

			for (const item of result.rank) {
				const addr = item.address;
				if (!addr) continue;
				const smartCount = Number(item.smart_buy_24h ?? item.smart_buy ?? 0);
				if (smartCount < minSmartBuys) continue;

				next.set(addr, item);

				const prevItem = prev.get(addr);
				const prevCount = prevItem ? Number(prevItem.smart_buy_24h ?? prevItem.smart_buy ?? 0) : 0;

				if (!prevItem || smartCount > prevCount) {
					const source = result.source || 'gmgn';
					const ev = {
						kind: 'smart_entry',
						data: normalize(item, smartCount, prevCount, chain, interval, source),
					};
					pushBuffer(ev);
					if (active) onEvent(ev);
				}
			}

			_snapshots.set(id, next);
			const source = result.source || 'gmgn';
			onEvent({ kind: 'status', data: { state: 'live', polled_at: Date.now(), count: next.size, source } });
		}

		if (active) timer = setTimeout(poll, POLL_MS);
	}

	poll();
	return stop;
}

function normalize(item, smartCount, prevCount, chain, interval, source = 'gmgn') {
	const mc = item.market_cap != null ? Number(item.market_cap) : null;
	const price = item.price != null ? Number(item.price) : null;
	return {
		address: item.address,
		symbol: item.symbol || '???',
		name: item.name || item.symbol || 'Unknown',
		price,
		market_cap: mc,
		volume: item.volume != null ? Number(item.volume) : null,
		holder_count: item.holder_count != null ? Number(item.holder_count) : null,
		smart_buy_24h: smartCount,
		smart_buy_delta: Math.max(0, smartCount - prevCount),
		smart_sell_24h: Number(item.smart_sell_24h ?? 0),
		price_change_1h: item.price_change_1h != null ? Number(item.price_change_1h) : null,
		price_change_24h: item.price_change_24h != null ? Number(item.price_change_24h) : null,
		liquidity: item.liquidity != null ? Number(item.liquidity) : null,
		is_new: prevCount === 0,
		chain,
		interval,
		source,
		txns_h1_buys: item.txns_h1_buys ?? null,
		txns_h1_sells: item.txns_h1_sells ?? null,
		open_timestamp: item.open_timestamp ?? null,
		timestamp: Math.floor(Date.now() / 1000),
	};
}
