// Scan-to-fund: the deposit request encoding and the arrival watcher.
//
// The two things that are genuinely dangerous here are not visual:
//
//   1. The QR encodes an address a stranger's wallet will send real money to.
//      A Base asset encoded against the Solana address, or a USDC request that
//      forgets the mint and therefore asks for native SOL, loses funds with no
//      error anywhere. These lock the encoding per asset.
//   2. "Your deposit arrived" is a claim about the chain. It must come from an
//      actual balance increase, never from an unreadable balance, a re-quote of
//      the same number, or float noise. detectArrival is the whole guard.
//
// The watcher is exercised with fake timers and an injected reader, so the
// backoff, the hidden-tab suspension and the stop path are asserted directly
// rather than inferred from a comment.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
	buildRequestUri,
	addressFor,
	detectArrival,
	watchDelay,
	watchForDeposit,
} from '../src/wallet-deposit.js';

const SOL_ADDR = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
const EVM_ADDR = '0x1111111111111111111111111111111111111111';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

describe('deposit request encoding', () => {
	it('encodes a bare SOL request as Solana Pay against the Solana address', () => {
		const uri = buildRequestUri({ asset: 'sol', solanaAddress: SOL_ADDR, evmAddress: EVM_ADDR });
		expect(uri.startsWith(`solana:${SOL_ADDR}?`)).toBe(true);
		const q = new URLSearchParams(uri.slice(uri.indexOf('?') + 1));
		// No amount asked for, so the sender chooses one.
		expect(q.get('amount')).toBeNull();
		// Critically: no spl-token, so this is native SOL and not a token request.
		expect(q.get('spl-token')).toBeNull();
		expect(q.get('label')).toBe('three.ws');
	});

	it('carries the amount so the sending wallet opens pre-filled', () => {
		const uri = buildRequestUri({ asset: 'sol', solanaAddress: SOL_ADDR, amount: '1.25' });
		expect(new URLSearchParams(uri.split('?')[1]).get('amount')).toBe('1.25');
	});

	it('pins the USDC mint on a Solana USDC request', () => {
		const uri = buildRequestUri({ asset: 'usdc', solanaAddress: SOL_ADDR, amount: '10' });
		const q = new URLSearchParams(uri.split('?')[1]);
		// Without spl-token this would silently request 10 SOL instead of 10 USDC.
		expect(q.get('spl-token')).toBe(USDC_MINT);
		expect(q.get('amount')).toBe('10');
	});

	it('encodes a Base USDC request as an EIP-681 transfer to the EVM address', () => {
		const uri = buildRequestUri({
			asset: 'base',
			solanaAddress: SOL_ADDR,
			evmAddress: EVM_ADDR,
			amount: '2.5',
		});
		// Target is the token contract; the recipient rides in `address`.
		expect(uri.startsWith(`ethereum:${BASE_USDC}@8453/transfer?`)).toBe(true);
		const q = new URLSearchParams(uri.split('?')[1]);
		expect(q.get('address')).toBe(EVM_ADDR);
		expect(q.get('uint256')).toBe('2500000'); // 6 decimals
		// The Solana address must never appear in a Base request.
		expect(uri).not.toContain(SOL_ADDR);
	});

	it('falls back to a plain chain-scoped address when Base has no amount', () => {
		expect(buildRequestUri({ asset: 'base', evmAddress: EVM_ADDR })).toBe(
			`ethereum:${EVM_ADDR}@8453`,
		);
	});

	it('treats a blank, zero or unparsable amount as no amount rather than zero', () => {
		for (const amount of ['', '   ', '0', 'abc', null, undefined]) {
			const uri = buildRequestUri({ asset: 'sol', solanaAddress: SOL_ADDR, amount });
			expect(new URLSearchParams(uri.split('?')[1]).get('amount')).toBeNull();
		}
	});

	it('returns null instead of a malformed URI when the address is missing', () => {
		expect(buildRequestUri({ asset: 'sol', solanaAddress: null })).toBeNull();
		expect(buildRequestUri({ asset: 'base', evmAddress: null })).toBeNull();
	});

	it('routes each asset to the address it actually settles on', () => {
		const addrs = { solanaAddress: SOL_ADDR, evmAddress: EVM_ADDR };
		expect(addressFor('sol', addrs)).toBe(SOL_ADDR);
		expect(addressFor('usdc', addrs)).toBe(SOL_ADDR);
		expect(addressFor('base', addrs)).toBe(EVM_ADDR);
	});
});

describe('arrival detection', () => {
	const base = { sol: 1, sol_usdc: 5, evm_usdc: 2 };

	it('reports the delta when a balance rises', () => {
		const hit = detectArrival(base, { ...base, sol_usdc: 8 });
		expect(hit).toMatchObject({ asset: 'usdc', label: 'USDC', network: 'Solana' });
		expect(hit.delta).toBeCloseTo(3, 9);
	});

	it('detects a Base deposit and names Base as the network', () => {
		expect(detectArrival(base, { ...base, evm_usdc: 2.5 })).toMatchObject({
			asset: 'base',
			network: 'Base',
		});
	});

	it('reports nothing when balances are unchanged', () => {
		expect(detectArrival(base, { ...base })).toBeNull();
	});

	it('never invents an arrival from an unreadable balance', () => {
		// An RPC failure surfaces as null. Reading null as zero and back again
		// would announce a deposit that never happened.
		expect(detectArrival({ ...base, sol: null }, base)).toBeNull();
		expect(detectArrival(base, { ...base, sol: null })).toBeNull();
		expect(detectArrival(base, {})).toBeNull();
	});

	it('ignores a falling balance, which is a send and not a deposit', () => {
		expect(detectArrival(base, { ...base, sol: 0.4 })).toBeNull();
	});

	it('ignores float noise below the dust threshold', () => {
		expect(detectArrival(base, { ...base, sol: 1 + 1e-12 })).toBeNull();
	});
});

describe('watch backoff', () => {
	it('polls tightly at first and relaxes as the wait lengthens', () => {
		expect(watchDelay(0)).toBe(4000);
		expect(watchDelay(4)).toBe(4000);
		expect(watchDelay(5)).toBe(8000);
		expect(watchDelay(14)).toBe(8000);
		expect(watchDelay(15)).toBe(15000);
		expect(watchDelay(500)).toBe(15000);
	});

	it('stays well inside the 60-per-minute wallet read budget', () => {
		// Worst case is the opening burst: five polls at 4s is 5 reads in 20s,
		// which extrapolates to 15/min against a ceiling of 60.
		const firstMinute = [0, 1, 2, 3, 4].reduce((ms, i) => ms + watchDelay(i), 0);
		expect(5 / (firstMinute / 60000)).toBeLessThan(60);
	});
});

describe('watchForDeposit', () => {
	// The watcher reads exactly one DOM property, behind a typeof guard, so a
	// two-line stub is a truer test than a jsdom environment: it runs in the
	// default node pool (jsdom workers time out in this workspace) and it makes
	// the module's entire DOM surface visible in one place.
	let visibility = 'visible';
	beforeEach(() => {
		vi.useFakeTimers();
		visibility = 'visible';
		globalThis.document = {
			get visibilityState() {
				return visibility;
			},
		};
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		delete globalThis.document;
	});

	it('fires onArrival once with the delta and then stops polling', async () => {
		const baseline = { sol: 1, sol_usdc: 0, evm_usdc: 0 };
		const readBalances = vi
			.fn()
			.mockResolvedValueOnce({ ...baseline })
			.mockResolvedValue({ ...baseline, sol: 1.5 });
		const onArrival = vi.fn();

		const w = watchForDeposit({ baseline, readBalances, onArrival });
		await vi.advanceTimersByTimeAsync(4000);
		expect(onArrival).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(4000);

		expect(onArrival).toHaveBeenCalledTimes(1);
		expect(onArrival.mock.calls[0][0].delta).toBeCloseTo(0.5, 9);
		expect(w.stopped).toBe(true);

		// Nothing further is read once it has fired.
		const after = readBalances.mock.calls.length;
		await vi.advanceTimersByTimeAsync(60000);
		expect(readBalances).toHaveBeenCalledTimes(after);
	});

	it('survives a failing read and keeps waiting', async () => {
		const baseline = { sol: 1 };
		const readBalances = vi
			.fn()
			.mockRejectedValueOnce(new Error('rpc down'))
			.mockResolvedValue({ sol: 2 });
		const onArrival = vi.fn();

		watchForDeposit({ baseline, readBalances, onArrival });
		await vi.advanceTimersByTimeAsync(4000);
		expect(onArrival).not.toHaveBeenCalled(); // the throw was absorbed
		await vi.advanceTimersByTimeAsync(4000);
		expect(onArrival).toHaveBeenCalledTimes(1);
	});

	it('spends no reads while the tab is hidden', async () => {
		visibility = 'hidden';
		const readBalances = vi.fn().mockResolvedValue({ sol: 99 });
		const onArrival = vi.fn();

		watchForDeposit({ baseline: { sol: 1 }, readBalances, onArrival });
		await vi.advanceTimersByTimeAsync(40000);

		// The loop stayed alive but never hit the network, so a user who
		// switched to their phone burns none of their rate-limit budget.
		expect(readBalances).not.toHaveBeenCalled();
		expect(onArrival).not.toHaveBeenCalled();
	});

	it('stops on demand and issues no further reads', async () => {
		const readBalances = vi.fn().mockResolvedValue({ sol: 1 });
		const w = watchForDeposit({ baseline: { sol: 1 }, readBalances });
		await vi.advanceTimersByTimeAsync(4000);
		w.stop();
		const after = readBalances.mock.calls.length;
		await vi.advanceTimersByTimeAsync(120000);
		expect(readBalances).toHaveBeenCalledTimes(after);
	});

	it('gives up rather than polling a forgotten tab forever', async () => {
		const readBalances = vi.fn().mockResolvedValue({ sol: 1 });
		const onTick = vi.fn();
		watchForDeposit({ baseline: { sol: 1 }, readBalances, onTick });
		await vi.advanceTimersByTimeAsync(11 * 60 * 1000);
		expect(onTick.mock.calls.some(([t]) => t.state === 'timeout')).toBe(true);
	});

	it('hands the fresh balances to onTick so a caller needs no second read', async () => {
		const readBalances = vi.fn().mockResolvedValue({ sol: 1, sol_usdc: 7 });
		const onTick = vi.fn();
		watchForDeposit({ baseline: { sol: 1, sol_usdc: 7 }, readBalances, onTick });
		await vi.advanceTimersByTimeAsync(4000);
		const waiting = onTick.mock.calls.map(([t]) => t).find((t) => t.state === 'waiting');
		expect(waiting.balances).toEqual({ sol: 1, sol_usdc: 7 });
	});
});
