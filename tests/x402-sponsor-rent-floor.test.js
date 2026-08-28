// Cover for the sponsor floor guard learning about a dry fee payer from a
// SETTLE FAILURE rather than from a balance read
// (api/_lib/x402/self-facilitator.js).
//
// Measured in production on 2026-08-28. The sponsor wallet sat at 0.000899107
// SOL against a 0.02 SOL floor, which is 0.0000082 SOL of spendable headroom,
// less than two transaction fees. Every transaction it fee-paid therefore died
// at simulation with InsufficientFundsForRent on account index 0.
//
// The guard that exists to stop exactly this never fired, because the only thing
// that ever wrote it was getBalance, and all four paid Solana RPC lanes were
// over quota at the same moment. refreshSponsorFloorState fails open on an RPC
// error by design, so the two failures compounded: the ring spent three hours
// making payments that could not settle. 95 attempts, 0 settled, and healthz
// reported the cause as `rail`, which sends an operator hunting duplicate
// signatures instead of funding the wallet.
//
// The fix reads the verdict off the failure itself. It costs no RPC call and it
// is available precisely when the RPC is too degraded to answer one.

import { describe, it, expect, beforeEach } from 'vitest';

const SPONSOR = 'WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW';
const OTHER = 'wwwwwDxFWRn7grgr3Esrsg5C6NvDoDHSA4gaCffccrU';

process.env.X402_FEE_PAYER_SOLANA = SPONSOR;

const { isFeePayerRentFailure, noteSponsorRentFailure, sponsorKnownBelowFloor } = await import(
	'../api/_lib/x402/self-facilitator.js'
);

// The two spellings the RPCs actually produced, kept verbatim from the
// x402_self_facilitator_log and x402_autonomous_log rows of that outage.
const SIM_ERR_OBJECT = { InsufficientFundsForRent: { account_index: 0 } };
const SWEEP_MESSAGE =
	'Simulation failed. \nMessage: Transaction simulation failed: Transaction results in an ' +
	'account (0) with insufficient funds for rent. \n\nCatch the `SendTransactionError` and call `getLogs()`';

describe('isFeePayerRentFailure', () => {
	it('recognizes the structured simulation error', () => {
		expect(isFeePayerRentFailure(SIM_ERR_OBJECT)).toBe(true);
		expect(isFeePayerRentFailure(JSON.stringify(SIM_ERR_OBJECT))).toBe(true);
	});

	it('recognizes the sentence the sweep path receives', () => {
		expect(isFeePayerRentFailure(SWEEP_MESSAGE)).toBe(true);
	});

	it('ignores rent failures against an account that is not the fee payer', () => {
		// Account index 0 is the fee payer by definition. Any other index is some
		// other account in the message and says nothing about the sponsor.
		expect(isFeePayerRentFailure({ InsufficientFundsForRent: { account_index: 3 } })).toBe(false);
	});

	it('ignores unrelated failures and empty input', () => {
		expect(isFeePayerRentFailure({ InstructionError: [0, { Custom: 1 }] })).toBe(false);
		expect(isFeePayerRentFailure('blockhash not found')).toBe(false);
		expect(isFeePayerRentFailure(null)).toBe(false);
		expect(isFeePayerRentFailure(undefined)).toBe(false);
		expect(isFeePayerRentFailure('')).toBe(false);
	});
});

describe('noteSponsorRentFailure', () => {
	// The guard holds for 60s and clears by timestamp, so each case runs on its
	// own clock far past any previous trip rather than sharing a reset hook.
	// There is deliberately no way to force-clear it: the expiry IS the recovery
	// path, and a test that reached around it would not be testing the guard.
	const BASE = 1_787_877_609_500;
	let tick = 0;
	beforeEach(() => {
		tick += 1;
	});
	const clock = () => BASE + tick * 600_000;

	it('trips the floor guard when our own sponsor is the broke fee payer', () => {
		const now = clock();
		expect(sponsorKnownBelowFloor(now)).toBe(false);
		expect(noteSponsorRentFailure(SIM_ERR_OBJECT, SPONSOR, now)).toBe(true);
		expect(sponsorKnownBelowFloor(now)).toBe(true);
	});

	it('trips from the sweep path message too, which carried 86 of the 95 faults', () => {
		const now = clock();
		expect(noteSponsorRentFailure(SWEEP_MESSAGE, SPONSOR, now)).toBe(true);
		expect(sponsorKnownBelowFloor(now)).toBe(true);
	});

	it('does NOT trip when the broke fee payer is a self-paying buyer', () => {
		// In a self-pay settle the buyer is the fee payer. Tripping the
		// platform-wide guard because one buyer is broke would withdraw the Solana
		// accept from every 402 challenge on the site: a self-inflicted outage.
		const now = clock();
		expect(noteSponsorRentFailure(SIM_ERR_OBJECT, OTHER, now)).toBe(false);
		expect(sponsorKnownBelowFloor(now)).toBe(false);
	});

	it('does NOT trip on a failure that is not about rent', () => {
		const now = clock();
		expect(noteSponsorRentFailure({ InstructionError: [0, { Custom: 1 }] }, SPONSOR, now)).toBe(false);
		expect(sponsorKnownBelowFloor(now)).toBe(false);
	});

	it('expires so a topped-up sponsor starts settling again without a redeploy', () => {
		const now = clock();
		noteSponsorRentFailure(SIM_ERR_OBJECT, SPONSOR, now);
		expect(sponsorKnownBelowFloor(now + 59_000)).toBe(true);
		expect(sponsorKnownBelowFloor(now + 61_000)).toBe(false);
	});
});
