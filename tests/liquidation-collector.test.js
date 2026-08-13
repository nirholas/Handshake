// Core-path coverage for services/liquidation-collector: the pure parsing /
// sizing / aggregation logic in src/collector.js and src/okx-contracts.js,
// plus one real boot smoke of src/index.js (spawns the actual service, hits
// its real HTTP surface, then shuts it down).
//
// The exchange frames below are shaped exactly like the live WebSocket
// payloads each exchange documents; the parsers are pure functions, so no
// socket is needed to exercise them.

import { describe, it, expect, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
	TRACKED,
	MAX_CACHE,
	MAX_AGE_MS,
	buildSnapshot,
	bybitBase,
	bybitInstrument,
	bybitTopics,
	classify,
	createStore,
	okxSide,
	okxSize,
	parseBinanceMessage,
	parseBybitMessage,
	parseOkxMessage,
	readBybitAck,
} from '../services/liquidation-collector/src/collector.js';
import {
	createOkxContractRegistry,
	parseInstruments,
} from '../services/liquidation-collector/src/okx-contracts.js';

const SERVICE_DIR = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	'../services/liquidation-collector',
);

describe('classify', () => {
	it('buckets USD value into the documented severities', () => {
		expect(classify(9_999)).toBe('SMALL');
		expect(classify(10_000)).toBe('MEDIUM');
		expect(classify(99_999.99)).toBe('MEDIUM');
		expect(classify(100_000)).toBe('LARGE');
		expect(classify(1_000_000)).toBe('MEGA');
	});
});

describe('createStore', () => {
	it('stamps severity on push and evicts oldest past the cap', () => {
		const store = createStore({ max: 2 });
		const base = { exchange: 'OKX', price: 1, qty: 1, side: 'LONG', symbol: 'SOL', time: 1 };
		store.push({ ...base, value: 5_000 });
		store.push({ ...base, value: 250_000 });
		expect(store.entries.map((e) => e.severity)).toEqual(['SMALL', 'LARGE']);
		store.push({ ...base, value: 2_000_000 });
		expect(store.size).toBe(2);
		expect(store.entries.map((e) => e.severity)).toEqual(['LARGE', 'MEGA']);
	});

	it('defaults the cap to MAX_CACHE', () => {
		expect(MAX_CACHE).toBe(10_000);
	});
});

describe('parseBinanceMessage', () => {
	const frame = JSON.stringify({
		e: 'forceOrder',
		E: 1786600000100,
		o: {
			s: 'BTCUSDT', S: 'SELL', o: 'LIMIT', f: 'IOC',
			q: '0.014', p: '61000', ap: '61234.5',
			X: 'FILLED', l: '0.014', z: '0.014', T: 1786600000000,
		},
	});

	it('parses a forceOrder frame; a forced SELL is a liquidated LONG', () => {
		const [entry] = parseBinanceMessage(frame);
		expect(entry).toMatchObject({
			exchange: 'Binance',
			symbol: 'BTC',
			side: 'LONG',
			price: 61234.5,
			qty: 0.014,
			time: 1786600000000,
		});
		expect(entry.value).toBeCloseTo(61234.5 * 0.014);
	});

	it('maps a forced BUY to a liquidated SHORT', () => {
		const buy = JSON.parse(frame);
		buy.o.S = 'BUY';
		expect(parseBinanceMessage(JSON.stringify(buy))[0].side).toBe('SHORT');
	});

	it('drops untracked symbols, invalid numbers, and non-JSON', () => {
		const alien = JSON.parse(frame);
		alien.o.s = 'SHIBUSDT';
		expect(parseBinanceMessage(JSON.stringify(alien))).toEqual([]);
		const broken = JSON.parse(frame);
		broken.o.q = '0';
		expect(parseBinanceMessage(JSON.stringify(broken))).toEqual([]);
		expect(parseBinanceMessage('not json')).toEqual([]);
	});
});

describe('Bybit instrument mapping', () => {
	it('lists small-denomination memecoins in 1000x lots', () => {
		expect(bybitInstrument('PEPE')).toBe('1000PEPEUSDT');
		expect(bybitInstrument('BTC')).toBe('BTCUSDT');
		expect(bybitBase('1000BONKUSDT')).toEqual({ base: 'BONK', lot: 1000 });
		expect(bybitBase('SOLUSDT')).toEqual({ base: 'SOL', lot: 1 });
	});

	it('subscribes one allLiquidation topic per tracked coin', () => {
		const topics = bybitTopics(TRACKED);
		expect(topics).toHaveLength(TRACKED.length);
		expect(topics).toContain('allLiquidation.BTCUSDT');
		expect(topics).toContain('allLiquidation.1000PEPEUSDT');
		expect(topics.every((t) => t.startsWith('allLiquidation.'))).toBe(true);
	});
});

describe('readBybitAck', () => {
	it('surfaces a rejected subscribe with its req_id topic', () => {
		const ack = readBybitAck(JSON.stringify({
			success: false,
			ret_msg: 'error:handler not found',
			op: 'subscribe',
			req_id: 'allLiquidation.BTCUSDT',
			conn_id: 'abc',
		}));
		expect(ack).toEqual({
			op: 'subscribe',
			ok: false,
			topic: 'allLiquidation.BTCUSDT',
			message: 'error:handler not found',
		});
	});

	it('returns null for data frames so parsing falls through', () => {
		expect(readBybitAck(JSON.stringify({ topic: 'allLiquidation.BTCUSDT', data: [] }))).toBeNull();
		expect(readBybitAck('pong')).toBeNull();
	});
});

describe('parseBybitMessage', () => {
	it('reads position side directly and normalizes 1000x lots', () => {
		const frame = JSON.stringify({
			topic: 'allLiquidation.1000PEPEUSDT',
			type: 'snapshot',
			ts: 1786600001000,
			data: [{ T: 1786600000500, s: '1000PEPEUSDT', S: 'Buy', v: '25000', p: '0.012' }],
		});
		const [entry] = parseBybitMessage(frame);
		// Bybit's `S` on allLiquidation is the POSITION side: Buy means a long
		// position was liquidated (inverted vs the Binance/OKX order-side rule).
		expect(entry.side).toBe('LONG');
		expect(entry.symbol).toBe('PEPE');
		expect(entry.price).toBeCloseTo(0.012 / 1000);
		expect(entry.qty).toBeCloseTo(25000 * 1000);
		expect(entry.value).toBeCloseTo(0.012 * 25000);
		expect(entry.time).toBe(1786600000500);
	});

	it('ignores op frames and untracked instruments', () => {
		expect(parseBybitMessage(JSON.stringify({ op: 'pong', success: true }))).toEqual([]);
		const frame = JSON.stringify({
			topic: 'allLiquidation.SHIBUSDT',
			ts: 1,
			data: [{ T: 1, s: 'SHIBUSDT', S: 'Sell', v: '1', p: '1' }],
		});
		expect(parseBybitMessage(frame)).toEqual([]);
	});
});

describe('OKX contract sizing', () => {
	const rows = [
		{ instId: 'BTC-USDT-SWAP', ctVal: '0.01', ctMult: '1', ctValCcy: 'BTC' },
		{ instId: 'BONK-USDT-SWAP', ctVal: '100000', ctMult: '1', ctValCcy: 'BONK' },
		{ instId: 'BTC-USD-SWAP', ctVal: '100', ctMult: '1', ctValCcy: 'USD' },
		{ instId: 'BROKEN-SWAP', ctVal: '0', ctMult: '1', ctValCcy: 'X' },
	];

	it('parses instrument rows and drops unusable ones', () => {
		const map = parseInstruments(rows);
		expect(map.size).toBe(3);
		expect(map.get('BTC-USDT-SWAP')).toEqual({ ctVal: 0.01, ctMult: 1, quoteDenominated: false });
		expect(map.get('BTC-USD-SWAP').quoteDenominated).toBe(true);
	});

	it('converts contract counts to base units (the 100x BTC bug)', () => {
		const contracts = parseInstruments(rows);
		// 976.6 contracts of BTC-USDT-SWAP is 9.766 BTC, NOT 976.6 BTC.
		const sized = okxSize({ contract: contracts.get('BTC-USDT-SWAP'), sz: '976.6', price: '63756.3' });
		expect(sized.qty).toBeCloseTo(9.766);
		expect(sized.value).toBeCloseTo(9.766 * 63756.3);
	});

	it('handles inverse (quote-denominated) contracts', () => {
		const contracts = parseInstruments(rows);
		const sized = okxSize({ contract: contracts.get('BTC-USD-SWAP'), sz: '5', price: '60000' });
		expect(sized.value).toBeCloseTo(500);
		expect(sized.qty).toBeCloseTo(500 / 60000);
	});

	it('returns null rather than fabricating a size', () => {
		expect(okxSize({ contract: undefined, sz: '1', price: '1' })).toBeNull();
		const contracts = parseInstruments(rows);
		expect(okxSize({ contract: contracts.get('BTC-USDT-SWAP'), sz: 'x', price: '1' })).toBeNull();
	});
});

describe('parseOkxMessage', () => {
	const registry = {
		get: (instId) => (instId === 'OP-USDT-SWAP' ? { ctVal: 1, ctMult: 1, quoteDenominated: false } : undefined),
	};

	it('parses a liquidation-orders frame using the contract registry', () => {
		const frame = JSON.stringify({
			arg: { channel: 'liquidation-orders', instType: 'SWAP' },
			data: [{
				details: [{ bkLoss: '0', bkPx: '0.7831', ccy: '', posSide: 'short', side: 'buy', sz: '130', ts: '1786600002000' }],
				instFamily: 'OP-USDT',
				instId: 'OP-USDT-SWAP',
				instType: 'SWAP',
				uly: 'OP-USDT',
			}],
		});
		const [entry] = parseOkxMessage(frame, registry);
		expect(entry).toMatchObject({ exchange: 'OKX', symbol: 'OP', side: 'SHORT', time: 1786600002000 });
		expect(entry.qty).toBeCloseTo(130);
		expect(entry.value).toBeCloseTo(130 * 0.7831);
	});

	it('drops instruments the registry does not know', () => {
		const frame = JSON.stringify({
			arg: { channel: 'liquidation-orders', instType: 'SWAP' },
			data: [{
				details: [{ bkPx: '60000', side: 'sell', sz: '10', ts: '1' }],
				instId: 'BTC-USDT-SWAP',
			}],
		});
		expect(parseOkxMessage(frame, registry)).toEqual([]);
	});

	it('ignores pong, event frames, and non-JSON', () => {
		expect(parseOkxMessage('pong', registry)).toEqual([]);
		expect(parseOkxMessage(JSON.stringify({ event: 'subscribe', arg: {} }), registry)).toEqual([]);
		expect(parseOkxMessage('<<<', registry)).toEqual([]);
	});

	it('falls back to the order side when posSide is absent', () => {
		expect(okxSide({ posSide: 'long' })).toBe('LONG');
		expect(okxSide({ side: 'buy' })).toBe('SHORT');
		expect(okxSide({ side: 'sell' })).toBe('LONG');
	});
});

describe('createOkxContractRegistry', () => {
	it('loads contracts, rate-limits miss-triggered refreshes, and refreshes on schedule', async () => {
		let clock = 1_000_000;
		const fetchImpl = vi.fn(async () => ({
			ok: true,
			json: async () => ({ data: [{ instId: 'BTC-USDT-SWAP', ctVal: '0.01', ctMult: '1', ctValCcy: 'BTC' }] }),
		}));
		const registry = createOkxContractRegistry({
			fetchImpl,
			now: () => clock,
			minRefreshMs: 60_000,
			log: () => {},
		});
		await registry.refresh();
		expect(registry.size).toBe(1);
		expect(registry.get('BTC-USDT-SWAP')).toBeDefined();

		// A miss inside the throttle window must NOT refetch.
		expect(registry.get('NEW-USDT-SWAP')).toBeUndefined();
		expect(fetchImpl).toHaveBeenCalledTimes(1);

		// Past the window, a miss schedules a refresh.
		clock += 61_000;
		registry.get('NEW-USDT-SWAP');
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it('keeps the previous contract map when a refresh fails', async () => {
		let fail = false;
		const fetchImpl = vi.fn(async () => {
			if (fail) throw new Error('offline');
			return {
				ok: true,
				json: async () => ({ data: [{ instId: 'ETH-USDT-SWAP', ctVal: '0.1', ctMult: '1', ctValCcy: 'ETH' }] }),
			};
		});
		let clock = 0;
		const registry = createOkxContractRegistry({ fetchImpl, now: () => clock, log: () => {} });
		await registry.refresh();
		expect(registry.size).toBe(1);
		fail = true;
		clock += 120_000;
		await registry.refresh();
		expect(registry.size).toBe(1);
		expect(registry.get('ETH-USDT-SWAP')).toBeDefined();
	});
});

describe('buildSnapshot', () => {
	const now = 1786600000000;
	const entry = (over) => ({
		exchange: 'OKX', price: 1, qty: 1, side: 'LONG', symbol: 'BTC',
		time: now - 1000, value: 50_000, severity: 'MEDIUM', ...over,
	});

	it('windows to 4h, sorts newest first, and caps the feed at 50', () => {
		const entries = [
			entry({ time: now - MAX_AGE_MS - 1 }),
			...Array.from({ length: 60 }, (_, i) => entry({ time: now - i * 1000 })),
		];
		const snap = buildSnapshot(entries, now);
		expect(snap.liquidations).toHaveLength(50);
		expect(snap.summary.totalCount).toBe(60);
		expect(snap.liquidations[0].time).toBe(now);
		expect(snap.timestamp).toBe(new Date(now).toISOString());
	});

	it('computes sides, severities, and dominant-side thresholds', () => {
		const entries = [
			entry({ side: 'LONG', value: 2_000_000, severity: 'MEGA' }),
			entry({ side: 'LONG', value: 500_000, severity: 'LARGE' }),
			entry({ side: 'SHORT', value: 100_000, severity: 'LARGE', symbol: 'ETH' }),
		];
		const snap = buildSnapshot(entries, now);
		expect(snap.summary).toMatchObject({
			dominantSide: 'LONG PAIN',
			largeCount: 2,
			megaCount: 1,
			longCount: 2,
			shortCount: 1,
			longValue: 2_500_000,
			shortValue: 100_000,
			totalValue: 2_600_000,
		});
		// symbolStats sorted by total value, BTC first.
		expect(snap.symbolStats.map((s) => s.symbol)).toEqual(['BTC', 'ETH']);
		expect(snap.symbolStats[0]).toEqual({ count: 2, longValue: 2_500_000, shortValue: 0, symbol: 'BTC' });

		const balanced = buildSnapshot([
			entry({ side: 'LONG', value: 100 }),
			entry({ side: 'SHORT', value: 90 }),
		], now);
		expect(balanced.summary.dominantSide).toBe('BALANCED');

		const squeeze = buildSnapshot([
			entry({ side: 'SHORT', value: 200 }),
			entry({ side: 'LONG', value: 100 }),
		], now);
		expect(squeeze.summary.dominantSide).toBe('SHORT SQUEEZE');
	});

	it('serves a designed empty state, never a crash', () => {
		const snap = buildSnapshot([], now);
		expect(snap.liquidations).toEqual([]);
		expect(snap.summary.totalCount).toBe(0);
		expect(snap.summary.dominantSide).toBe('BALANCED');
		expect(snap.symbolStats).toEqual([]);
	});
});

describe('service boot smoke', () => {
	it('boots the real service, serves /health and /liquidations, exits on SIGTERM', async () => {
		const port = 3900 + (process.pid % 100);
		const child = spawn(process.execPath, ['src/index.js'], {
			cwd: SERVICE_DIR,
			env: { ...process.env, PORT: String(port), NODE_ENV: 'test' },
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let out = '';
		child.stdout.on('data', (c) => { out += c; });
		child.stderr.on('data', (c) => { out += c; });
		try {
			await new Promise((resolve, reject) => {
				const fail = setTimeout(() => reject(new Error(`service never listened; output:\n${out}`)), 60_000);
				const poll = setInterval(() => {
					if (out.includes(`listening on :${port}`)) {
						clearTimeout(fail);
						clearInterval(poll);
						resolve();
					}
				}, 200);
				child.on('exit', (code) => {
					clearTimeout(fail);
					clearInterval(poll);
					reject(new Error(`service exited early (code ${code}); output:\n${out}`));
				});
			});

			const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
			expect(health.ok).toBe(true);
			expect(typeof health.cached).toBe('number');
			expect(typeof health.uptime).toBe('number');
			expect(typeof health.okxContracts).toBe('number');
			for (const lane of ['Binance', 'Bybit', 'OKX']) {
				expect(health.streams[lane]).toMatchObject({ events: expect.any(Number) });
				expect(typeof health.streams[lane].state).toBe('string');
			}

			const snap = await (await fetch(`http://127.0.0.1:${port}/liquidations`)).json();
			expect(Array.isArray(snap.liquidations)).toBe(true);
			expect(snap.summary).toMatchObject({ totalCount: expect.any(Number), dominantSide: expect.any(String) });
			expect(Array.isArray(snap.symbolStats)).toBe(true);

			const missing = await fetch(`http://127.0.0.1:${port}/nope`);
			expect(missing.status).toBe(404);

			const exited = new Promise((resolve) => child.on('exit', resolve));
			child.kill('SIGTERM');
			const code = await Promise.race([
				exited,
				new Promise((resolve) => setTimeout(() => resolve('timeout'), 10_000)),
			]);
			expect(code).toBe(0);
		} finally {
			if (child.exitCode === null) child.kill('SIGKILL');
		}
	}, 90_000);
});
