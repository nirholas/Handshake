// Whole-chain transport fallbacks in the Solana RPC rotation: the cause code on
// the exhausted-chain error, the jittered re-sweep when every lane died at the
// wire, and last-good serving for idempotent reads when the chain stays down.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
	makeRotatingFetch,
	transportCause,
	lastGoodKey,
	_resetLastGoodMemo,
} from '../api/_lib/solana/connection.js';

const body = (method, params = [], id = 7) => JSON.stringify({ jsonrpc: '2.0', id, method, params });
const ok = (result, id = 7) =>
	new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
		status: 200,
		headers: { 'content-type': 'application/json' },
	});
const netFail = (code) => {
	const err = new TypeError('fetch failed');
	err.cause = Object.assign(new Error(code), { code });
	return err;
};

let origFetch;
beforeEach(() => {
	origFetch = global.fetch;
	_resetLastGoodMemo();
});
afterEach(() => {
	global.fetch = origFetch;
	vi.restoreAllMocks();
});

describe('transportCause', () => {
	it('surfaces the undici errno behind "fetch failed"', () => {
		expect(transportCause(netFail('ECONNRESET'))).toBe('ECONNRESET');
		expect(transportCause(netFail('EAI_AGAIN'))).toBe('EAI_AGAIN');
	});
	it('names a bare transport failure without an errno, and ignores everything else', () => {
		expect(transportCause(new TypeError('fetch failed'))).toBe('transport');
		expect(transportCause(new Error('solana rpc 429 @ https://x'))).toBe('');
		const abort = new Error('This operation was aborted');
		abort.name = 'AbortError';
		expect(transportCause(abort)).toBe('');
		expect(transportCause(null)).toBe('');
	});
});

describe('lastGoodKey', () => {
	it('keys an idempotent read by method and params, never by request id', () => {
		const a = lastGoodKey(body('getBalance', ['abc'], 1));
		const b = lastGoodKey(body('getBalance', ['abc'], 99));
		expect(a).toBeTruthy();
		expect(a).toBe(b);
		expect(lastGoodKey(body('getBalance', ['xyz']))).not.toBe(a);
	});
	it('refuses writes, blockhash and slot reads, batches, and junk', () => {
		expect(lastGoodKey(body('sendTransaction', ['sig']))).toBeNull();
		expect(lastGoodKey(body('getLatestBlockhash'))).toBeNull();
		expect(lastGoodKey(body('getSlot'))).toBeNull();
		expect(lastGoodKey(JSON.stringify([JSON.parse(body('getBalance', ['a']))]))).toBeNull();
		expect(lastGoodKey('not json')).toBeNull();
		expect(lastGoodKey('')).toBeNull();
	});
});

describe('makeRotatingFetch whole-chain transport fallbacks', () => {
	it('re-sweeps every lane once after a transport-only first sweep and returns the live answer', async () => {
		const eps = ['https://resweep-a.test/', 'https://resweep-b.test/'];
		let calls = 0;
		global.fetch = vi.fn(async () => {
			calls += 1;
			if (calls <= 2) throw netFail('ECONNRESET');
			return ok({ value: 42 });
		});
		const resp = await makeRotatingFetch(eps)(eps[0], { method: 'POST', body: body('getSlot') });
		expect(await resp.json()).toMatchObject({ result: { value: 42 } });
		expect(calls).toBe(3);
	});

	it('does not re-sweep when a lane failed with an HTTP verdict rather than at the wire', async () => {
		const eps = ['https://verdict-a.test/', 'https://verdict-b.test/'];
		let calls = 0;
		global.fetch = vi.fn(async (url) => {
			calls += 1;
			if (String(url).includes('verdict-a')) return new Response('slow down', { status: 429 });
			throw netFail('ECONNREFUSED');
		});
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		await expect(
			makeRotatingFetch(eps)(eps[0], { method: 'POST', body: body('getSlot') }),
		).rejects.toThrow(/ECONNREFUSED/);
		expect(calls).toBe(2);
		expect(warn.mock.calls.some(([m]) => /all 2 endpoints failed .*ECONNREFUSED/.test(m))).toBe(true);
	});

	it('names the errno on the exhausted-chain error instead of a bare "fetch failed"', async () => {
		const eps = ['https://errno-a.test/'];
		global.fetch = vi.fn(async () => {
			throw netFail('EAI_AGAIN');
		});
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		await expect(
			makeRotatingFetch(eps)(eps[0], { method: 'POST', body: body('getSlot') }),
		).rejects.toThrow(/fetch failed \(EAI_AGAIN\) @ https:\/\/errno-a\.test/);
	});

	it('serves the last-good body for an idempotent read when the whole chain stays down', async () => {
		const eps = ['https://stale-a.test/'];
		let down = false;
		global.fetch = vi.fn(async () => {
			if (down) throw netFail('ECONNRESET');
			return ok({ context: { slot: 1 }, value: 1234 }, 7);
		});
		const rotate = makeRotatingFetch(eps);
		const live = await rotate(eps[0], { method: 'POST', body: body('getBalance', ['wallet1'], 7) });
		expect(await live.json()).toMatchObject({ id: 7, result: { value: 1234 } });
		// The publish is fire-and-forget; let it land.
		await new Promise((r) => setTimeout(r, 20));

		down = true;
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const stale = await rotate(eps[0], { method: 'POST', body: body('getBalance', ['wallet1'], 31) });
		expect(stale.status).toBe(200);
		expect(Number(stale.headers.get('x-solana-rpc-stale'))).toBeGreaterThanOrEqual(0);
		// Re-addressed to the caller's own request id so web3.js matches it.
		expect(await stale.json()).toMatchObject({ id: 31, result: { value: 1234 } });
		expect(warn.mock.calls.some(([m]) => /serving last-good/.test(m))).toBe(true);

		// A different wallet has no last-good and still fails honestly.
		await expect(
			rotate(eps[0], { method: 'POST', body: body('getBalance', ['wallet2'], 32) }),
		).rejects.toThrow(/ECONNRESET/);
	});

	it('never serves a stale blockhash', async () => {
		const eps = ['https://hash-a.test/'];
		let down = false;
		global.fetch = vi.fn(async () => {
			if (down) throw netFail('ECONNRESET');
			return ok({ value: { blockhash: 'abc', lastValidBlockHeight: 1 } });
		});
		const rotate = makeRotatingFetch(eps);
		await rotate(eps[0], { method: 'POST', body: body('getLatestBlockhash') });
		await new Promise((r) => setTimeout(r, 20));
		down = true;
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		await expect(rotate(eps[0], { method: 'POST', body: body('getLatestBlockhash') })).rejects.toThrow(/ECONNRESET/);
	});
});
