import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PublicKey } from '@solana/web3.js';

vi.mock('@solana/spl-token', async (importOriginal) => {
	const actual = await importOriginal();
	return { ...actual, getMint: vi.fn() };
});

import { getMint } from '@solana/spl-token';
import {
	mintDecimals,
	ataExists,
	getRecentBlockhash,
	getRecentBlockhashInfo,
	readAccountInfoOrNull,
	readBalanceOrNull,
	rpcUnavailableError,
	isRpcUnavailable,
	respondRpcUnavailable,
	guardRpc,
	THREE_MINT,
	_resetReadGuardCaches,
} from '../api/_lib/solana/read-guards.js';

const USDC = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const ATA = new PublicKey('HgwbNyweQUiV5diWJ1a7ocxgzf3AYSLhTpphEYRLujtN');
const BH = 'GfVcyD4kkTrj4bKc7Wd9G4nf2k1zk8mF8YQ4i6N2bQrs';
const fetchFailed = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });

beforeEach(() => {
	_resetReadGuardCaches();
	getMint.mockReset();
});

describe('mintDecimals', () => {
	it('never calls getMint for USDC or $THREE', async () => {
		const conn = {};
		expect(await mintDecimals(conn, USDC)).toBe(6);
		expect(await mintDecimals(conn, THREE_MINT)).toBe(6);
		expect(await mintDecimals(conn, 'So11111111111111111111111111111111111111112')).toBe(9);
		expect(getMint).not.toHaveBeenCalled();
	});

	it('reads an unknown mint once and remembers it', async () => {
		const mint = PublicKey.unique();
		getMint.mockResolvedValue({ decimals: 4 });
		expect(await mintDecimals({}, mint)).toBe(4);
		expect(await mintDecimals({}, mint)).toBe(4);
		expect(getMint).toHaveBeenCalledTimes(1);
	});

	it('tags a transport failure as a retryable 503 rpc_unavailable', async () => {
		getMint.mockRejectedValue(fetchFailed());
		const err = await mintDecimals({}, PublicKey.unique()).catch((e) => e);
		expect(err.status).toBe(503);
		expect(err.code).toBe('rpc_unavailable');
		expect(err.retryable).toBe(true);
		expect(err.expose).toBe(true);
		expect(isRpcUnavailable(err)).toBe(true);
	});

	it('lets a token-program verdict through untouched (the address is not a mint)', async () => {
		const notMint = Object.assign(new Error('TokenInvalidAccountOwnerError'), { name: 'TokenInvalidAccountOwnerError' });
		getMint.mockRejectedValue(notMint);
		const err = await mintDecimals({}, PublicKey.unique()).catch((e) => e);
		expect(err).toBe(notMint);
		expect(err.status).toBeUndefined();
	});
});

describe('ataExists', () => {
	it('reports existing / missing on a clean reply', async () => {
		expect(await ataExists({ getAccountInfo: async () => ({ data: Buffer.alloc(165) }) }, ATA)).toBe(true);
		expect(await ataExists({ getAccountInfo: async () => null }, ATA)).toBe(false);
	});

	it('fails open to missing when the RPC throws', async () => {
		const conn = { getAccountInfo: async () => { throw fetchFailed(); } };
		await expect(ataExists(conn, ATA)).resolves.toBe(false);
	});
});

describe('getRecentBlockhash', () => {
	const ok = (blockhash, lastValidBlockHeight) => ({ getLatestBlockhash: async () => ({ blockhash, lastValidBlockHeight }) });
	const dead = { getLatestBlockhash: async () => { throw new Error('failed to get recent blockhash: TypeError: fetch failed'); } };

	it('serves the cached blockhash inside the validity window when the chain fails', async () => {
		await getRecentBlockhash(ok(BH, 1000), 'mainnet', { now: () => 1000 });
		const info = await getRecentBlockhashInfo(dead, 'mainnet', { now: () => 1000 + 20_000 });
		expect(info.blockhash).toBe(BH);
		expect(info.stale).toBe(true);
		expect(info.as_of).toBe(1000);
	});

	it('refuses a cached blockhash past the age cap', async () => {
		await getRecentBlockhash(ok(BH, 1000), 'devnet', { now: () => 1000 });
		const err = await getRecentBlockhash(dead, 'devnet', { now: () => 1000 + 60_000 }).catch((e) => e);
		expect(err.code).toBe('rpc_unavailable');
		expect(err.status).toBe(503);
		expect(err.message).toMatch(/fetch failed/);
	});

	it('refuses a cached blockhash when the chain height has reached lastValidBlockHeight minus the margin', async () => {
		await getRecentBlockhash(ok(BH, 5000), 'height-net', { now: () => 1000 });
		const deadWithHeight = { ...dead, getBlockHeight: async () => 4990 };
		await expect(getRecentBlockhash(deadWithHeight, 'height-net', { now: () => 1000 + 5000 + 5000 })).rejects.toMatchObject({ code: 'rpc_unavailable' });
	});

	it('serves a cached blockhash when the chain height is still comfortably below lastValidBlockHeight', async () => {
		await getRecentBlockhash(ok(BH, 5000), 'height-ok', { now: () => 1000 });
		const deadWithHeight = { ...dead, getBlockHeight: async () => 4900 };
		expect(await getRecentBlockhash(deadWithHeight, 'height-ok', { now: () => 1000 + 20_000 })).toBe(BH);
	});

	it('throws typed when the cache is cold', async () => {
		await expect(getRecentBlockhash(dead, 'cold-net', { now: () => 1000 })).rejects.toMatchObject({ code: 'rpc_unavailable', retryable: true });
	});
});

describe('soft reads', () => {
	it('readAccountInfoOrNull returns null on transport failure and the cause when asked', async () => {
		const conn = { getAccountInfo: async () => { throw fetchFailed(); } };
		expect(await readAccountInfoOrNull(conn, ATA)).toBeNull();
		const r = await readAccountInfoOrNull(conn, ATA, { withCause: true });
		expect(r.info).toBeNull();
		expect(r.cause.message).toBe('fetch failed');
	});

	it('readBalanceOrNull returns null on transport failure and lamports otherwise', async () => {
		expect(await readBalanceOrNull({ getBalance: async () => 42 }, ATA)).toBe(42);
		expect(await readBalanceOrNull({ getBalance: async () => { throw fetchFailed(); } }, ATA)).toBeNull();
	});

	it('guardRpc rethrows non-transport errors untouched', async () => {
		const boom = new Error('bad argument');
		await expect(guardRpc(async () => { throw boom; })).rejects.toBe(boom);
		await expect(guardRpc(async () => { throw fetchFailed(); })).rejects.toMatchObject({ code: 'rpc_unavailable' });
	});
});

describe('respondRpcUnavailable', () => {
	function fakeRes() {
		const headers = {};
		return {
			headers,
			statusCode: 0,
			body: '',
			setHeader(k, v) { headers[k.toLowerCase()] = v; },
			getHeader(k) { return headers[k.toLowerCase()]; },
			end(b) { this.body = b; },
		};
	}

	it('answers 503 rpc_unavailable with Retry-After 15 for a tagged or raw transport error', () => {
		const res = fakeRes();
		expect(respondRpcUnavailable(res, rpcUnavailableError(fetchFailed()))).toBe(true);
		expect(res.statusCode).toBe(503);
		expect(res.headers['retry-after']).toBe('15');
		expect(JSON.parse(res.body).error).toBe('rpc_unavailable');
		expect(respondRpcUnavailable(fakeRes(), fetchFailed())).toBe(true);
	});

	it('leaves unrelated errors to the caller', () => {
		expect(respondRpcUnavailable(fakeRes(), new Error('validation'))).toBe(false);
	});
});
