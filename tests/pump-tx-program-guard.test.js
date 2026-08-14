// Unit tests for the confirm-path program guards in api/_lib/pump.js.
//
// txInvokesPumpProgram() is what stops a confirmed tx that merely *references*
// a freshly-ground mint pubkey (a memo, a transfer) from being recorded in
// pump_agent_mints as a real launch, and txInvokesAgentPaymentsProgram() does
// the same job for withdraw-confirm. The real module is imported (no vi.mock)
// so we exercise the actual parsing + the real program-id constants.

import { describe, it, expect } from 'vitest';
import {
	txProgramIds,
	txInvokesPumpProgram,
	txInvokesAgentPaymentsProgram,
} from '../api/_lib/pump.js';
import {
	PUMP_PROGRAM_ID,
	PUMP_AGENT_PAYMENTS_PROGRAM_ID,
} from '../api/_lib/solana/programs.js';

const SYSTEM = '11111111111111111111111111111111';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

// Mirror the getParsedTransaction shape: programId may be a base58 string or a
// PublicKey-like object exposing toString().
const pk = (s) => ({ toString: () => s });

describe('txProgramIds', () => {
	it('collects top-level and inner-instruction program ids (string + pubkey forms)', () => {
		const tx = {
			transaction: { message: { instructions: [{ programId: pk(PUMP_PROGRAM_ID) }, { programId: SYSTEM }] } },
			meta: { innerInstructions: [{ index: 0, instructions: [{ programId: pk(TOKEN) }] }] },
		};
		const ids = txProgramIds(tx);
		expect(ids.has(PUMP_PROGRAM_ID)).toBe(true);
		expect(ids.has(SYSTEM)).toBe(true);
		expect(ids.has(TOKEN)).toBe(true);
	});

	it('returns an empty set for malformed / empty txs', () => {
		expect(txProgramIds(null).size).toBe(0);
		expect(txProgramIds({}).size).toBe(0);
		expect(txProgramIds({ transaction: { message: {} }, meta: {} }).size).toBe(0);
	});
});

describe('txInvokesPumpProgram', () => {
	it('true when the pump program is a top-level instruction', () => {
		const tx = { transaction: { message: { instructions: [{ programId: pk(PUMP_PROGRAM_ID) }] } } };
		expect(txInvokesPumpProgram(tx)).toBe(true);
	});

	it('true when the pump program is invoked via CPI (inner instruction)', () => {
		const tx = {
			transaction: { message: { instructions: [{ programId: SYSTEM }] } },
			meta: { innerInstructions: [{ index: 0, instructions: [{ programId: pk(PUMP_PROGRAM_ID) }] }] },
		};
		expect(txInvokesPumpProgram(tx)).toBe(true);
	});

	it('false when a confirmed tx only references the mint without running pump (memo/transfer)', () => {
		// mint pubkey is in accountKeys but no instruction targets the pump program.
		const tx = {
			transaction: {
				message: {
					accountKeys: [{ pubkey: pk('3wsGroundMint1111111111111111111111') }],
					instructions: [{ programId: SYSTEM }, { programId: TOKEN }],
				},
			},
			meta: { innerInstructions: [] },
		};
		expect(txInvokesPumpProgram(tx)).toBe(false);
	});

	it('false for malformed input', () => {
		expect(txInvokesPumpProgram(null)).toBe(false);
		expect(txInvokesPumpProgram({})).toBe(false);
	});
});

describe('txInvokesAgentPaymentsProgram', () => {
	it('true when the agent-payments program is a top-level instruction', () => {
		const tx = {
			transaction: {
				message: { instructions: [{ programId: pk(PUMP_AGENT_PAYMENTS_PROGRAM_ID) }] },
			},
		};
		expect(txInvokesAgentPaymentsProgram(tx)).toBe(true);
	});

	it('true when it is invoked via CPI (inner instruction)', () => {
		const tx = {
			transaction: { message: { instructions: [{ programId: SYSTEM }] } },
			meta: {
				innerInstructions: [
					{ index: 0, instructions: [{ programId: pk(PUMP_AGENT_PAYMENTS_PROGRAM_ID) }] },
				],
			},
		};
		expect(txInvokesAgentPaymentsProgram(tx)).toBe(true);
	});

	it('false for a plain token transfer that merely touches the mint and authority', () => {
		const tx = {
			transaction: {
				message: {
					accountKeys: [{ pubkey: pk('3wsGroundMint1111111111111111111111') }],
					instructions: [{ programId: TOKEN }],
				},
			},
			meta: { innerInstructions: [] },
		};
		expect(txInvokesAgentPaymentsProgram(tx)).toBe(false);
	});

	it('false for the bonding-curve program (a launch is not a withdrawal)', () => {
		const tx = { transaction: { message: { instructions: [{ programId: pk(PUMP_PROGRAM_ID) }] } } };
		expect(txInvokesAgentPaymentsProgram(tx)).toBe(false);
	});

	it('false for malformed input', () => {
		expect(txInvokesAgentPaymentsProgram(null)).toBe(false);
		expect(txInvokesAgentPaymentsProgram({})).toBe(false);
	});
});
