// Tests for the PumpPortal trade-stream path added to connectPumpFunFeed.
//
// Drives a fake `ws` WebSocket so we can assert the real dispatch loop:
//   - kind:'trades' + mints subscribes via subscribeTokenTrade(keys)
//   - buy/sell messages emit normalized { kind:'trade' } events
//   - a tracked mint's migration still surfaces as a graduation
//   - no trade subscription is sent without mints

import { describe, it, expect, vi, beforeEach } from 'vitest';

class FakeWS {
	constructor(url) {
		this.url = url;
		this.sent = [];
		this._h = {};
		FakeWS.instances.push(this);
	}
	on(ev, cb) { (this._h[ev] ||= []).push(cb); return this; }
	emit(ev, ...args) { (this._h[ev] || []).forEach((cb) => cb(...args)); }
	send(data) { this.sent.push(JSON.parse(data)); }
	close() { this.emit('close'); }
}
FakeWS.instances = [];

vi.mock('ws', () => ({ default: FakeWS }));
vi.mock('../api/_lib/db.js', () => ({ sql: vi.fn(async () => []) }));
vi.mock('../api/_lib/env.js', () => ({
	env: { DATABASE_URL: 'postgres://test', APP_ORIGIN: 'http://test' },
}));

// getSolPrice() hits CoinGecko — stub a stable price.
globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ solana: { usd: 150 } }) }));

const { connectPumpFunFeed } = await import('../api/_lib/pumpfun-ws-feed.js');

const flush = () => new Promise((r) => setTimeout(r, 10));

describe('connectPumpFunFeed — trades', () => {
	beforeEach(() => { FakeWS.instances.length = 0; });

	it('subscribes to token trades for the given mints', () => {
		const stop = connectPumpFunFeed({ kind: 'trades', mints: ['MINT1'], onEvent: () => {} });
		const ws = FakeWS.instances[0];
		ws.emit('open');
		const sub = ws.sent.find((m) => m.method === 'subscribeTokenTrade');
		expect(sub).toBeTruthy();
		expect(sub.keys).toContain('MINT1');
		stop();
	});

	it('emits a normalized trade event for buy/sell messages', async () => {
		const events = [];
		const stop = connectPumpFunFeed({ kind: 'trades', mints: ['MINT1'], onEvent: (e) => events.push(e) });
		const ws = FakeWS.instances[0];
		ws.emit('open');
		ws.emit('message', JSON.stringify({
			txType: 'buy', mint: 'MINT1', signature: 'sig-buy-1',
			solAmount: 2.5, marketCapSol: 30, traderPublicKey: 'traderA', tokenAmount: 1000,
		}));
		await flush();
		const trade = events.find((e) => e.kind === 'trade');
		expect(trade).toBeTruthy();
		expect(trade.data.is_buy).toBe(true);
		expect(trade.data.solAmount).toBe(2.5);
		expect(trade.data.sol_amount).toBe(2.5);
		expect(trade.data.mint).toBe('MINT1');
		expect(trade.data.sol_value_usd).toBeCloseTo(375); // 2.5 * 150
		stop();
	});

	it('does not subscribe to trades when no mints are provided', () => {
		const stop = connectPumpFunFeed({ kind: 'trades', mints: [], onEvent: () => {} });
		const ws = FakeWS.instances[0];
		ws.emit('open');
		expect(ws.sent.find((m) => m.method === 'subscribeTokenTrade')).toBeUndefined();
		stop();
	});

	it('ignores trades for non-tracked mints (no firehose leakage)', async () => {
		const events = [];
		const stop = connectPumpFunFeed({ kind: 'trades', mints: ['MINT1'], onEvent: (e) => events.push(e) });
		const ws = FakeWS.instances[0];
		ws.emit('open');
		// A graduation for a different mint must not surface in trades-only mode.
		ws.emit('message', JSON.stringify({ txType: 'migrate', mint: 'OTHER', signature: 'sig-grad-other' }));
		await flush();
		expect(events.find((e) => e.kind === 'graduation')).toBeUndefined();
		stop();
	});
});
