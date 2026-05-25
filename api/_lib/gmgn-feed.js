// GMGN.ai smart money feed — polls the public ranking endpoint.
// Detects new entries and increases in smart-wallet count, then emits
// smart_entry events so the SSE handler can stream them to the browser.
//
// The GMGN WebSocket requires a full browser session fingerprint, so we use
// the public REST rank endpoint with browser-like headers instead. Requests
// go through Vercel's edge IPs; if Cloudflare starts blocking, swap in a
// GMGN_COOKIE env var containing a valid cf_clearance value.

const GMGN_BASE = 'https://gmgn.ai/defi/quotation/v1';
const POLL_MS = 30_000;
const FETCH_TIMEOUT_MS = 10_000;

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

	function stop() {
		active = false;
		clearTimeout(timer);
		_snapshots.delete(id);
	}

	signal?.addEventListener('abort', stop);

	async function poll() {
		if (!active) return;

		const result = await fetchRank({ chain, interval });
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
					const ev = {
						kind: 'smart_entry',
						data: normalize(item, smartCount, prevCount, chain, interval),
					};
					pushBuffer(ev);
					if (active) onEvent(ev);
				}
			}

			_snapshots.set(id, next);
			onEvent({ kind: 'status', data: { state: 'live', polled_at: Date.now(), count: next.size } });
		}

		if (active) timer = setTimeout(poll, POLL_MS);
	}

	poll();
	return stop;
}

function normalize(item, smartCount, prevCount, chain, interval) {
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
		open_timestamp: item.open_timestamp ?? null,
		timestamp: Math.floor(Date.now() / 1000),
	};
}
