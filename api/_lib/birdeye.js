// Shared Birdeye OHLCV fetch. Keeps BIRDEYE_API_KEY server-side and returns
// parsed candles [{ t, o, h, l, c, v }] (t = unix seconds), ascending by time.
// Throws an Error tagged with { status } so callers map to the right HTTP code.
// Never fabricates candles: upstream failures surface verbatim, and only when
// every rung failed and nothing is cached.
//
// Rungs, in order:
//   1. Birdeye token OHLCV (keyed)
//   2. GeckoTerminal: top pool for the mint, then that pool's candles
//      (api/_lib/market/ohlcv.js, which itself carries Birdeye-pair and CEX
//      rungs behind GeckoTerminal)
//   3. The last good answer for this mint + interval + window, from the shared
//      cache, when both live sources are down.

import { cacheWrapLastGood } from './cache.js';
import { fetchUpstream } from './upstream-fetch.js';
import { topPoolForToken, fetchOhlcv, barSeconds } from './market/ohlcv.js';

const BIRDEYE_OHLCV_URL = 'https://public-api.birdeye.so/defi/ohlcv';

// Fresh window for the shared cache: a chart poll inside it reuses the candles
// verbatim. Stale window: how long a last-good series is servable in an outage.
const FRESH_TTL_S = 15;
const STALE_TTL_S = 6 * 3600;
const GECKO_MAX_BARS = 1000;

export function birdeyeConfigured() {
	return !!process.env.BIRDEYE_API_KEY;
}

// Birdeye `type` -> the closest GeckoTerminal timeframe/aggregate pair. Birdeye
// offers finer steps than GeckoTerminal (3m, 30m, 2H...); those map to the
// nearest cadence GeckoTerminal serves, and the caller's [from, to] window is
// still honoured by filtering.
export function geckoFrameFor(interval) {
	const map = {
		'1m': ['minute', 1], '3m': ['minute', 5], '5m': ['minute', 5], '15m': ['minute', 15], '30m': ['minute', 15],
		'1H': ['hour', 1], '2H': ['hour', 1], '4H': ['hour', 4], '6H': ['hour', 4], '8H': ['hour', 4], '12H': ['hour', 12],
		'1D': ['day', 1], '3D': ['day', 1], '1W': ['day', 1], '1M': ['day', 1],
	};
	const [timeframe, aggregate] = map[String(interval)] || ['hour', 1];
	return { timeframe, aggregate };
}

function tag(message, status) {
	return Object.assign(new Error(message), { status });
}

async function fromBirdeye({ mint, interval, from, to }) {
	const apiKey = process.env.BIRDEYE_API_KEY;
	if (!apiKey) throw tag('On-chain data provider is not configured', 503);

	const url =
		`${BIRDEYE_OHLCV_URL}?address=${encodeURIComponent(mint)}` +
		`&type=${interval}&time_from=${from}&time_to=${to}`;

	let upstream;
	try {
		upstream = await fetchUpstream(
			url,
			{ headers: { 'X-API-KEY': apiKey, 'x-chain': 'solana', accept: 'application/json' } },
			{ timeoutMs: 10_000, attempts: 2, name: 'birdeye:ohlcv', label: 'Birdeye OHLCV' },
		);
	} catch (e) {
		throw tag(`Birdeye ${e?.status ? `${e.status}: ${String(e.body || '').slice(0, 200)}` : `unreachable: ${e?.message || e}`}`, 502);
	}

	const payload = await upstream.json().catch(() => null);
	const items = payload?.data?.items;
	if (!Array.isArray(items)) throw tag('Birdeye returned an unexpected payload', 502);

	return items
		.map((it) => ({
			t: Number(it.unixTime),
			o: Number(it.o),
			h: Number(it.h),
			l: Number(it.l),
			c: Number(it.c),
			v: Number(it.v ?? 0),
		}))
		.filter((d) => Number.isFinite(d.t) && Number.isFinite(d.c));
}

async function fromGeckoTerminal({ mint, interval, from, to }) {
	const { timeframe, aggregate } = geckoFrameFor(interval);
	const bars = Math.ceil(Math.max(0, to - from) / barSeconds(timeframe, aggregate)) + 2;
	const pool = await topPoolForToken(mint, 'solana');
	const { candles } = await fetchOhlcv({
		pool,
		network: 'solana',
		timeframe,
		aggregate,
		limit: Math.min(GECKO_MAX_BARS, Math.max(2, bars)),
	});
	const inWindow = candles.filter((d) => d.t >= from && d.t <= to);
	if (!inWindow.length) throw tag('GeckoTerminal has no candles in this window', 502);
	return inWindow;
}

async function fetchLive(args) {
	let firstErr = null;
	try {
		return await fromBirdeye(args);
	} catch (e) {
		firstErr = e;
	}
	try {
		return await fromGeckoTerminal(args);
	} catch (e) {
		// A pool GeckoTerminal never indexed is not an outage; keep Birdeye's
		// verdict (503 unconfigured / 502 upstream) as the one the route maps.
		if (firstErr.status === 503 && e?.status !== 404) firstErr = tag(`GeckoTerminal: ${e?.message || e}`, 502);
	}
	throw firstErr;
}

/**
 * Candles for a mint over [from, to] at a Birdeye interval ('1m', '15m', '1H',
 * '1D', ...). Birdeye first, GeckoTerminal second, last good series third.
 *
 * @param {{ mint: string, interval: string, from: number, to: number }} args
 * @returns {Promise<Array<{ t: number, o: number, h: number, l: number, c: number, v: number }>>}
 */
export async function fetchBirdeyeOhlcv({ mint, interval, from, to }) {
	const span = Math.max(0, Number(to) - Number(from));
	return cacheWrapLastGood(
		`birdeye:ohlcv:v1:${mint}:${interval}:${span}`,
		FRESH_TTL_S,
		() => fetchLive({ mint, interval, from, to }),
		{ staleTtlSeconds: STALE_TTL_S },
	);
}
