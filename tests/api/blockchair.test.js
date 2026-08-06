// api/_lib/blockchair.js: Blockchair multichain explorer layer.
//
// No live network: fetch is mocked with vi.stubGlobal so these exercise the
// module's real caching, allowlisting, and shape-mapping logic against
// payloads captured (trimmed) from the real api.blockchair.com on 2026-08-05.
// Live-network verification was run separately with real `node -e` calls.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	getChainStats,
	getMultiChainStats,
	clearBlockchairCache,
	BLOCKCHAIR_CHAINS,
	BLOCKCHAIR_BASE,
} from '../../api/_lib/blockchair.js';

function jsonResponse(status, body) {
	return { ok: status >= 200 && status < 300, status, statusText: String(status), json: async () => body };
}

let fetchMock;

beforeEach(() => {
	clearBlockchairCache();
	fetchMock = vi.fn();
	vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

const BITCOIN_STATS = {
	data: {
		blocks: 961223,
		transactions: 1411912353,
		circulation: 2006629291655096,
		blocks_24h: 142,
		transactions_24h: 606929,
		difficulty: 126231507121868.2,
		mempool_transactions: 7876,
		mempool_tps: 1.8166666666666667,
		best_block_height: 961222,
		best_block_hash: '000000000000000000012009d00d076443d9e33fa2299b68ff75471fd1880bc1',
		best_block_time: '2026-08-05 23:40:44',
		hashrate_24h: '891710846732260109258',
		average_transaction_fee_usd_24h: 0.39175778696063296,
		median_transaction_fee_usd_24h: 0.09239087,
		market_price_usd: 64609,
		market_price_usd_change_24h_percentage: 0.7,
		market_cap_usd: 1296529427283,
		market_dominance_percentage: 28.53,
		suggested_transaction_fee_per_byte_sat: 2,
	},
	context: { code: 200 },
};

const ETHEREUM_STATS = {
	data: {
		blocks: 25693055,
		transactions: 3652141935,
		circulation_approximate: '122374665718230000000000000',
		blocks_24h: 7173,
		transactions_24h: 2634319,
		difficulty: 0,
		mempool_transactions: 391,
		mempool_tps: 6.516666666666667,
		best_block_height: 25692153,
		best_block_hash: '43da7c17a8c3199c561e63620a80e59a4bc1748553b7aa8bed9ca052bb9495e1',
		best_block_time: '2026-08-05 23:56:11',
		hashrate_24h: '0',
		average_transaction_fee_usd_24h: 0.0974379280008165,
		median_transaction_fee_usd_24h: 0.008989736155474198,
		market_price_usd: 1907.8,
		market_price_usd_change_24h_percentage: 2,
		market_cap_usd: 230231886205,
		market_dominance_percentage: 9.99,
		suggested_transaction_fee_gwei_options: { sloth: 0, slow: 0, normal: 0, fast: 0, cheetah: 2 },
	},
	context: { code: 200 },
};

describe('getChainStats', () => {
	it('normalizes bitcoin stats to the camelCase shape', async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse(200, BITCOIN_STATS));
		const stats = await getChainStats('bitcoin');
		expect(stats).toMatchObject({
			chain: 'bitcoin',
			blocks: 961223,
			bestBlockHeight: 961222,
			bestBlockTime: '2026-08-05 23:40:44',
			transactions24h: 606929,
			mempoolTransactions: 7876,
			marketPriceUsd: 64609,
			marketCapUsd: 1296529427283,
			marketDominancePct: 28.53,
			suggestedFeePerByteSat: 2,
			suggestedFeeGweiOptions: null,
		});
		// The big-number hash rate string becomes a (necessarily approximate) number.
		expect(stats.hashRate24h).toBeCloseTo(8.917108467322601e20, -6);
		expect(fetchMock).toHaveBeenCalledWith(`${BLOCKCHAIR_BASE}/bitcoin/stats`, expect.any(Object));
	});

	it('normalizes ethereum stats including approximate circulation and gwei fee options', async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse(200, ETHEREUM_STATS));
		const stats = await getChainStats('ethereum');
		expect(stats.chain).toBe('ethereum');
		expect(stats.circulation).toBeCloseTo(1.2237466571823e26, -12);
		expect(stats.suggestedFeePerByteSat).toBeNull();
		expect(stats.suggestedFeeGweiOptions).toEqual({ sloth: 0, slow: 0, normal: 0, fast: 0, cheetah: 2 });
	});

	it('rejects a chain outside the allowlist without hitting the network', async () => {
		await expect(getChainStats('not-a-chain')).rejects.toThrow(/unsupported chain/);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(BLOCKCHAIR_CHAINS).toContain('bitcoin');
		expect(BLOCKCHAIR_CHAINS).toContain('ethereum');
	});

	it('caches per chain within the TTL', async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse(200, BITCOIN_STATS));
		await getChainStats('bitcoin');
		await getChainStats('bitcoin');
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});

describe('getMultiChainStats', () => {
	it('fetches chains in parallel and keeps successes when one fails', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		fetchMock.mockImplementation((url) => {
			if (String(url).includes('/bitcoin/')) return Promise.resolve(jsonResponse(200, BITCOIN_STATS));
			return Promise.resolve(jsonResponse(404, {}));
		});
		const result = await getMultiChainStats(['bitcoin', 'ethereum']);
		expect(result.map((s) => s.chain)).toEqual(['bitcoin']);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('ethereum'));
		warn.mockRestore();
	});

	it('rejects when every chain failed', async () => {
		fetchMock.mockResolvedValue(jsonResponse(404, {}));
		await expect(getMultiChainStats(['bitcoin', 'ethereum'])).rejects.toThrow(/HTTP 404/);
	});

	it('rejects an empty chain list without hitting the network', async () => {
		await expect(getMultiChainStats([])).rejects.toThrow(/at least one chain/);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
