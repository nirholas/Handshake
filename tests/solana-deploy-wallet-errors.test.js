// Wallet-leg error handling in src/erc8004/solana-deploy.js.
//
// Field failure this covers (2026-07-26): the Create Agent wizard died with
// "Deploy failed: An internal error has occurred" before the prep endpoint was
// ever called. That string is a wallet extension's -32603 internal crash
// (Phantom and Phantom-compatible injectors emit it when their background
// worker is wedged). The contract: the flow retries the wallet call once, and
// any surviving error names the failing step while preserving code/status so
// the UI classifiers still recognize rejection (4001), forbidden, and
// payment_required shapes.

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
	runSolanaDeploy,
	withWalletRetry,
	isWalletInternalError,
	tagStep,
} from '../src/erc8004/solana-deploy.js';

function internalError() {
	const e = new Error('An internal error has occurred');
	e.code = -32603;
	return e;
}

afterEach(() => {
	delete globalThis.window;
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('isWalletInternalError', () => {
	it('matches the -32603 code and the message with or without a code', () => {
		expect(isWalletInternalError(internalError())).toBe(true);
		expect(isWalletInternalError(new Error('An internal error has occurred'))).toBe(true);
		expect(isWalletInternalError({ code: -32603 })).toBe(true);
	});

	it('does not match user rejection or generic failures', () => {
		expect(isWalletInternalError({ code: 4001, message: 'User rejected the request' })).toBe(false);
		expect(isWalletInternalError(new Error('failed to fetch'))).toBe(false);
		expect(isWalletInternalError(null)).toBe(false);
	});
});

describe('withWalletRetry', () => {
	it('retries once on a wallet internal error and returns the second result', async () => {
		const fn = vi.fn()
			.mockRejectedValueOnce(internalError())
			.mockResolvedValueOnce('ok');
		await expect(withWalletRetry('connect', fn)).resolves.toBe('ok');
		expect(fn).toHaveBeenCalledTimes(2);
	});

	it('tags the step when both attempts crash, preserving the code', async () => {
		const fn = vi.fn().mockRejectedValue(internalError());
		const err = await withWalletRetry('sign', fn).catch((e) => e);
		expect(fn).toHaveBeenCalledTimes(2);
		expect(err.step).toBe('sign');
		expect(err.code).toBe(-32603);
		expect(err.message).toBe('Wallet signature failed: An internal error has occurred');
	});

	it('does not retry non-internal errors (a user rejection stays a single prompt)', async () => {
		const reject = Object.assign(new Error('User rejected the request'), { code: 4001 });
		const fn = vi.fn().mockRejectedValue(reject);
		const err = await withWalletRetry('connect', fn).catch((e) => e);
		expect(fn).toHaveBeenCalledTimes(1);
		expect(err.code).toBe(4001);
		expect(err.step).toBe('connect');
		expect(err.message).toMatch(/User rejected the request/);
	});
});

describe('tagStep', () => {
	it('is idempotent: an already-tagged error passes through untouched', () => {
		const first = tagStep(internalError(), 'connect');
		expect(tagStep(first, 'sign')).toBe(first);
	});

	it('preserves status and txSignature for the confirm-leg contract', () => {
		const e = Object.assign(new Error('boom'), { status: 502, txSignature: 'sig123' });
		const tagged = tagStep(e, 'send');
		expect(tagged.status).toBe(502);
		expect(tagged.txSignature).toBe('sig123');
		expect(tagged.message).toBe('Could not broadcast the transaction: boom');
	});
});

describe('runSolanaDeploy wallet leg', () => {
	it('surfaces a step-tagged error when connect crashes twice', async () => {
		const wallet = { isPhantom: true, connect: vi.fn().mockRejectedValue(internalError()) };
		globalThis.window = { phantom: { solana: wallet }, location: { origin: 'https://three.ws' } };
		const err = await runSolanaDeploy({ agent: { id: 'a', name: 'A' }, network: 'mainnet' }).catch((e) => e);
		expect(wallet.connect).toHaveBeenCalledTimes(2);
		expect(err.step).toBe('connect');
		expect(err.code).toBe(-32603);
		expect(err.message).toBe('Wallet connection failed: An internal error has occurred');
	});

	it('recovers when the second connect succeeds and proceeds to the prep call', async () => {
		const wallet = {
			isPhantom: true,
			connect: vi.fn()
				.mockRejectedValueOnce(internalError())
				.mockResolvedValueOnce({ publicKey: { toString: () => '7ownerPubkey11111111111111111111111111111111' } }),
		};
		globalThis.window = { phantom: { solana: wallet }, location: { origin: 'https://three.ws' } };
		const fetchMock = vi.fn().mockResolvedValue({
			ok: false,
			status: 403,
			json: async () => ({ error: 'forbidden', error_description: 'wallet not linked to your account' }),
		});
		vi.stubGlobal('fetch', fetchMock);

		const err = await runSolanaDeploy({ agent: { id: 'a', name: 'A' }, network: 'mainnet' }).catch((e) => e);
		expect(wallet.connect).toHaveBeenCalledTimes(2);
		expect(fetchMock).toHaveBeenCalledWith('/api/agents/solana-register-prep', expect.objectContaining({ method: 'POST' }));
		// The prep leg's server envelope survives untouched for the UI classifier.
		expect(err.code).toBe('forbidden');
		expect(err.status).toBe(403);
		expect(err.message).toBe('wallet not linked to your account');
	});
});
