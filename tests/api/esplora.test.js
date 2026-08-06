// api/_lib/esplora.js: Blockstream Esplora Bitcoin chain-data layer, plus
// its wiring into api/forever/status.js (real on-chain confirmation for
// inscription reveal txs, failing soft).
//
// No live network: fetch is mocked with vi.stubGlobal so these exercise the
// module's real caching, validation, and shape-mapping logic against payloads
// captured from the real blockstream.info/api on 2026-08-05. Live-network
// verification was run separately with real `node -e` calls.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable } from 'node:stream';
import {
	getTipHeight,
	getFeeEstimates,
	getAddress,
	getTransaction,
	getTransactionStatus,
	isPlausibleBitcoinAddress,
	isPlausibleTxid,
	clearEsploraCache,
	ESPLORA_BASE,
} from '../../api/_lib/esplora.js';
import foreverStatusHandler from '../../api/forever/status.js';

// Esplora answers plain text for some endpoints, JSON for others; the module
// reads .text() and parses, so the stub only needs text().
function textResponse(status, body) {
	const text = typeof body === 'string' ? body : JSON.stringify(body);
	return { ok: status >= 200 && status < 300, status, statusText: String(status), text: async () => text };
}

let fetchMock;

beforeEach(() => {
	clearEsploraCache();
	fetchMock = vi.fn();
	vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

const ADDRESS = 'bc1qgdjqv0av3q56jvd82tkdjpy7gdp9ut8tlqmgrpmv24sq90ecnvqqjwvw97';
const TXID = 'c9f1953cdb5e3af87adaa960d2f6baae21e521061092c02a2946dcedcfb5f102';

const ADDRESS_FIXTURE = {
	address: ADDRESS,
	chain_stats: {
		funded_txo_count: 343,
		funded_txo_sum: 530775983879384,
		spent_txo_count: 296,
		spent_txo_sum: 517774975978040,
		tx_count: 335,
	},
	mempool_stats: { funded_txo_count: 0, funded_txo_sum: 0, spent_txo_count: 0, spent_txo_sum: 0, tx_count: 0 },
};

const FEES_FIXTURE = { 1: 2.232, 2: 2.232, 3: 2.006, 6: 1.223, 144: 0.292, 504: 0.1, 1008: 0.1 };

const TX_STATUS_FIXTURE = {
	confirmed: true,
	block_height: 961103,
	block_hash: '00000000000000000001b5a599a4d9dc6b333167c824eae917dac56a444aa097',
	block_time: 1785896637,
};

const TX_FIXTURE = {
	txid: TXID,
	version: 1,
	locktime: 961101,
	size: 700,
	weight: 1870,
	fee: 4690,
	status: TX_STATUS_FIXTURE,
	vin: [{ txid: 'a'.repeat(64), vout: 1 }],
	vout: [
		{ scriptpubkey_address: 'bc1qexample', value: 2025623207327 },
		{ scriptpubkey_address: 'bc1qchange', value: 265259169 },
	],
};

describe('validators', () => {
	it('accepts mainnet address classes and rejects junk', () => {
		expect(isPlausibleBitcoinAddress(ADDRESS)).toBe(true);
		expect(isPlausibleBitcoinAddress('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa')).toBe(true);
		expect(isPlausibleBitcoinAddress('3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy')).toBe(true);
		expect(isPlausibleBitcoinAddress('not-an-address')).toBe(false);
		expect(isPlausibleBitcoinAddress('')).toBe(false);
	});

	it('accepts a 64-hex txid and rejects junk', () => {
		expect(isPlausibleTxid(TXID)).toBe(true);
		expect(isPlausibleTxid('xyz')).toBe(false);
		expect(isPlausibleTxid(null)).toBe(false);
	});
});

describe('getTipHeight', () => {
	it('parses the plain-text height and caches it', async () => {
		fetchMock.mockResolvedValueOnce(textResponse(200, '961224'));
		await expect(getTipHeight()).resolves.toBe(961224);
		await expect(getTipHeight()).resolves.toBe(961224);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock).toHaveBeenCalledWith(`${ESPLORA_BASE}/blocks/tip/height`, expect.any(Object));
	});
});

describe('getFeeEstimates', () => {
	it('maps confirmation targets to sat/vB and derives the familiar tiers', async () => {
		fetchMock.mockResolvedValueOnce(textResponse(200, FEES_FIXTURE));
		const fees = await getFeeEstimates();
		expect(fees.fastest).toBeCloseTo(2.232, 6);
		expect(fees.halfHour).toBeCloseTo(2.006, 6);
		expect(fees.hour).toBeCloseTo(1.223, 6);
		expect(fees.economy).toBeCloseTo(0.292, 6);
		expect(fees.estimates['504']).toBeCloseTo(0.1, 6);
	});

	it('falls back to the nearest slower target when the exact one is absent', async () => {
		fetchMock.mockResolvedValueOnce(textResponse(200, { 1: 5, 5: 2, 144: 0.5 }));
		const fees = await getFeeEstimates();
		expect(fees.halfHour).toBe(2); // target 3 absent, nearest at-or-above is 5
		expect(fees.hour).toBe(0.5); // target 6 absent, nearest at-or-above is 144
	});
});

describe('getAddress', () => {
	it('computes confirmed and pending balances from the txo sums', async () => {
		fetchMock.mockResolvedValueOnce(textResponse(200, ADDRESS_FIXTURE));
		const info = await getAddress(ADDRESS);
		expect(info.address).toBe(ADDRESS);
		expect(info.balanceSats).toBe(530775983879384 - 517774975978040);
		expect(info.pendingBalanceSats).toBe(0);
		expect(info.txCount).toBe(335);
		expect(info.chainStats.fundedTxoCount).toBe(343);
	});

	it('rejects an implausible address without hitting the network', async () => {
		await expect(getAddress('nope')).rejects.toThrow(/Bitcoin mainnet address/);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe('getTransaction / getTransactionStatus', () => {
	it('normalizes a confirmed tx with derived vsize and fee rate', async () => {
		fetchMock.mockResolvedValueOnce(textResponse(200, TX_FIXTURE));
		const tx = await getTransaction(TXID);
		expect(tx.txid).toBe(TXID);
		expect(tx.status.confirmed).toBe(true);
		expect(tx.status.blockHeight).toBe(961103);
		expect(tx.vsize).toBe(Math.ceil(1870 / 4));
		expect(tx.feeRate).toBeCloseTo(4690 / Math.ceil(1870 / 4), 6);
		expect(tx.inputCount).toBe(1);
		expect(tx.outputCount).toBe(2);
		expect(tx.outputValueSats).toBe(2025623207327 + 265259169);
	});

	it('maps the small status endpoint', async () => {
		fetchMock.mockResolvedValueOnce(textResponse(200, TX_STATUS_FIXTURE));
		const status = await getTransactionStatus(TXID);
		expect(status).toEqual({
			confirmed: true,
			blockHeight: 961103,
			blockHash: TX_STATUS_FIXTURE.block_hash,
			blockTime: 1785896637,
		});
		expect(fetchMock).toHaveBeenCalledWith(`${ESPLORA_BASE}/tx/${TXID}/status`, expect.any(Object));
	});

	it('throws with status 404 for an unseen txid, without retrying', async () => {
		fetchMock.mockResolvedValueOnce(textResponse(404, 'Transaction not found'));
		await expect(getTransactionStatus('f'.repeat(64))).rejects.toMatchObject({ status: 404 });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('rejects an implausible txid without hitting the network', async () => {
		await expect(getTransaction('short')).rejects.toThrow(/txid/);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

// ── /api/forever/status wiring ──────────────────────────────────────────────

function makeReq(url) {
	const req = Readable.from([]);
	req.method = 'GET';
	req.url = url;
	req.headers = { host: 'localhost' };
	return req;
}

function makeRes() {
	return {
		statusCode: 200,
		headers: {},
		body: '',
		writableEnded: false,
		setHeader(k, v) {
			this.headers[k.toLowerCase()] = v;
		},
		end(chunk) {
			if (chunk !== undefined) this.body += chunk;
			this.writableEnded = true;
		},
	};
}

const ORDER_FIXTURE = {
	id: 'order-1',
	status: 'completed',
	tx: { reveal: TXID, commit: 'b'.repeat(64) },
	files: [{ inscriptionId: `${TXID}i0` }],
	charge: { address: 'bc1qexamplechargeaddr', amount: 12345 },
};

describe('forever/status onchain enrichment', () => {
	it('adds real esplora confirmation depth to the inscription block', async () => {
		fetchMock.mockImplementation((url) => {
			const u = String(url);
			if (u.includes('ordinalsbot')) return Promise.resolve(textResponse(200, ORDER_FIXTURE));
			if (u.endsWith(`/tx/${TXID}/status`)) return Promise.resolve(textResponse(200, TX_STATUS_FIXTURE));
			if (u.endsWith('/blocks/tip/height')) return Promise.resolve(textResponse(200, '961224'));
			return Promise.resolve(textResponse(404, 'not found'));
		});

		const res = makeRes();
		await foreverStatusHandler(makeReq('/api/forever/status?id=order-1'), res);
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.body);
		expect(body.state).toBe('inscribed');
		expect(body.inscription.onchain).toEqual({
			confirmed: true,
			confirmations: 961224 - 961103 + 1,
			blockHeight: 961103,
			blockTime: 1785896637,
			source: 'esplora',
		});
	});

	it('fails soft to onchain: null when esplora cannot see the tx', async () => {
		fetchMock.mockImplementation((url) => {
			const u = String(url);
			if (u.includes('ordinalsbot')) return Promise.resolve(textResponse(200, ORDER_FIXTURE));
			return Promise.resolve(textResponse(404, 'Transaction not found'));
		});

		const res = makeRes();
		await foreverStatusHandler(makeReq('/api/forever/status?id=order-1'), res);
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.body);
		expect(body.inscription.id).toBe(`${TXID}i0`);
		expect(body.inscription.onchain).toBeNull();
	});
});
