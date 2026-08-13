// Regression cover for the cross-chain agent index (agent_onchain_events).
//
// Every case here was written against a defect measured on live chain data on
// 2026-08-13, not against an imagined one. The fixtures are trimmed from real
// mainnet transactions and logs, with the transaction signatures kept so any
// claim below can be re-checked against the chain itself.

import { describe, it, expect } from 'vitest';
import {
	agentTokenMintOf,
	classifyAgentTx,
	parsedInstructionsOf,
	accountKeysOf,
	memoPayloadOf,
	transferRecipientOf,
	WRAPPED_SOL_MINT,
	SOLANA_SWEEP_BATCH,
	SOLANA_SWEEP_PERIOD_MIN,
} from '../api/_lib/solana-agent-events.js';
import { normalizeEvent, toDate, agentRef, EVENT_CLASSES } from '../api/_lib/onchain-events.js';
import { sweepCycleMin } from '../api/_lib/ops/index-lag.js';
import { nextChunkSize, backoffChunkSize } from '../api/cron/[name].js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

// Trimmed from mainnet transaction
// 5WtcSn4jJubQnEu71nnjKZJZawtgGNeVayiDgG4QsDsCZreJN2W3MQiJpPWszCFcanFRDMVfojNwrPC7SBumRqw8
// (slot 438961707): a SetAgentTokenV1 binding agent
// ANeykUs3hCNb9B9hVx4sQg7D8hD6MzAyRPJ2M1ays18 to token
// X8k6vcAvvmkavecwAGk7U4JVoKdntDSNfBZsq6KPLEX. The ONLY token balance the
// transaction carries is wrapped SOL, which is why reading balances alone named
// the wrong mint on every token_launch event the index recorded.
const AGENT = 'ANeykUs3hCNb9B9hVx4sQg7D8hD6MzAyRPJ2M1ays18';
const LAUNCHED_MINT = 'X8k6vcAvvmkavecwAGk7U4JVoKdntDSNfBZsq6KPLEX';
const IDENTITY_PROGRAM = '1DREGFgysWYxLnRnKQnwrxnJQeSMk2HmGaC6whw2B2p';
const CORE_PROGRAM = 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d';
const SIGNER = '3NHMeZPXXZVgArbgE6hJU3fq72fR9UsgbmH9zFvQiGC1';

function setAgentTokenTx() {
	return {
		transaction: {
			message: {
				accountKeys: [
					{ pubkey: SIGNER },
					{ pubkey: AGENT },
					{ pubkey: LAUNCHED_MINT },
					{ pubkey: IDENTITY_PROGRAM },
				],
				instructions: [],
			},
		},
		meta: {
			err: null,
			logMessages: ['Program log: Instruction: SetAgentTokenV1'],
			preTokenBalances: [],
			postTokenBalances: [
				{ accountIndex: 7, mint: WRAPPED_SOL_MINT, uiTokenAmount: { amount: '0' } },
			],
			innerInstructions: [
				{
					index: 4,
					instructions: [
						{
							program: 'spl-token',
							parsed: {
								type: 'setAuthority',
								info: { authorityType: 'mintTokens', mint: LAUNCHED_MINT, newAuthority: null },
							},
						},
						{
							program: 'spl-token',
							parsed: {
								type: 'setAuthority',
								info: { authorityType: 'freezeAccount', mint: LAUNCHED_MINT, newAuthority: null },
							},
						},
						{
							program: 'spl-token',
							parsed: {
								type: 'initializeAccount3',
								info: { mint: WRAPPED_SOL_MINT, account: 'irrelevant' },
							},
						},
					],
				},
			],
		},
	};
}

// ─── agentTokenMintOf ────────────────────────────────────────────────────────

describe('agentTokenMintOf', () => {
	it('names the launched token, not the wrapped SOL that funded it', () => {
		expect(agentTokenMintOf(setAgentTokenTx(), AGENT)).toBe(LAUNCHED_MINT);
	});

	it('prefers a mint the transaction initialized over one it only minted from', () => {
		const tx = {
			transaction: { message: { accountKeys: [], instructions: [] } },
			meta: {
				innerInstructions: [
					{
						index: 0,
						instructions: [
							{ parsed: { type: 'mintTo', info: { mint: 'MintToOnly1111111111111111111111111111111111' } } },
							{ parsed: { type: 'initializeMint2', info: { mint: LAUNCHED_MINT } } },
						],
					},
				],
			},
		};
		expect(agentTokenMintOf(tx, AGENT)).toBe(LAUNCHED_MINT);
	});

	it('refuses to guess when one tier names two different mints', () => {
		const tx = {
			transaction: { message: { accountKeys: [], instructions: [] } },
			meta: {
				innerInstructions: [
					{
						index: 0,
						instructions: [
							{ parsed: { type: 'initializeMint', info: { mint: 'AAA1111111111111111111111111111111111111111' } } },
							{ parsed: { type: 'initializeMint', info: { mint: 'BBB1111111111111111111111111111111111111111' } } },
							{ parsed: { type: 'mintTo', info: { mint: 'CCC1111111111111111111111111111111111111111' } } },
						],
					},
				],
			},
		};
		// Ambiguous at the initialize tier, so it falls through to the single
		// unambiguous mintTo rather than picking one of the two arbitrarily.
		expect(agentTokenMintOf(tx, AGENT)).toBe('CCC1111111111111111111111111111111111111111');
	});

	it('never returns the agent account itself', () => {
		const tx = {
			transaction: { message: { accountKeys: [], instructions: [] } },
			meta: {
				innerInstructions: [{ index: 0, instructions: [{ parsed: { type: 'initializeMint', info: { mint: AGENT } } }] }],
				postTokenBalances: [{ mint: AGENT }],
			},
		};
		expect(agentTokenMintOf(tx, AGENT)).toBe(null);
	});

	it('falls back to a non-quote token balance for a raw transaction', () => {
		const tx = {
			meta: { postTokenBalances: [{ mint: WRAPPED_SOL_MINT }, { mint: LAUNCHED_MINT }] },
		};
		expect(agentTokenMintOf(tx, AGENT)).toBe(LAUNCHED_MINT);
	});

	it('returns null rather than wrapped SOL when that is all there is', () => {
		expect(agentTokenMintOf({ meta: { postTokenBalances: [{ mint: WRAPPED_SOL_MINT }] } }, AGENT)).toBe(null);
	});
});

describe('parsedInstructionsOf', () => {
	it('reads top-level and inner instructions, skipping unparsed ones', () => {
		const tx = {
			transaction: { message: { instructions: [{ parsed: { type: 'transfer', info: {} } }, { programId: 'x' }] } },
			meta: { innerInstructions: [{ index: 0, instructions: [{ parsed: { type: 'mintTo', info: {} } }] }] },
		};
		expect(parsedInstructionsOf(tx).map((i) => i.parsed.type)).toEqual(['transfer', 'mintTo']);
	});

	it('tolerates a raw transaction with no parsed instructions at all', () => {
		expect(parsedInstructionsOf({ meta: {} })).toEqual([]);
	});
});

// ─── classifyAgentTx ─────────────────────────────────────────────────────────

describe('classifyAgentTx', () => {
	const base = { agentRef: AGENT, signature: 'sig1', slot: 438961707, blockTime: 1786600541, network: 'mainnet' };

	it('emits a token_launch carrying the real mint', () => {
		const [ev] = classifyAgentTx({ ...base, tx: setAgentTokenTx() });
		expect(ev.eventClass).toBe('token_launch');
		expect(ev.eventName).toBe('SetAgentTokenV1');
		expect(ev.payload.mint).toBe(LAUNCHED_MINT);
		expect(ev.occurredAt).toBe(1786600541);
	});

	it('ignores an instruction name whose owning program is absent', () => {
		// TransferV1 belongs to Metaplex Core; without Core in the account keys
		// the log line is some other program's and must not become a transfer.
		const tx = {
			transaction: { message: { accountKeys: [{ pubkey: SIGNER }], instructions: [] } },
			meta: { logMessages: ['Program log: Instruction: TransferV1'] },
		};
		expect(classifyAgentTx({ ...base, tx })).toEqual([]);
	});

	it('classifies a Core transfer when Core is present', () => {
		const tx = {
			transaction: { message: { accountKeys: [{ pubkey: SIGNER }, { pubkey: 'Recip111111111111111111111111111111111111111' }, { pubkey: CORE_PROGRAM }], instructions: [] } },
			meta: {
				logMessages: ['Program log: Instruction: TransferV1'],
				preBalances: [10, 0, 0],
				postBalances: [5, 5, 0],
			},
		};
		const [ev] = classifyAgentTx({ ...base, tx });
		expect(ev.eventClass).toBe('transfer');
		expect(ev.counterparty).toBe('Recip111111111111111111111111111111111111111');
	});

	it('turns a threews memo into a reputation event', () => {
		const tx = {
			transaction: { message: { accountKeys: [{ pubkey: SIGNER }], instructions: [] } },
			meta: {
				logMessages: ['Program log: Memo (len 42): "{\\"v\\":1,\\"kind\\":\\"threews.feedback.v1\\",\\"score\\":5}"'],
			},
		};
		const [ev] = classifyAgentTx({ ...base, tx });
		expect(ev.eventClass).toBe('reputation');
		expect(ev.eventName).toBe('threews.feedback.v1');
		expect(ev.payload.score).toBe(5);
	});

	it('drops a failed transaction entirely', () => {
		expect(classifyAgentTx({ ...base, tx: { meta: { err: { InstructionError: [0, 'Custom'] } } } })).toEqual([]);
	});

	it('every emitted class is one the index recognizes', () => {
		const evs = classifyAgentTx({ ...base, tx: setAgentTokenTx() });
		for (const ev of evs) expect(EVENT_CLASSES).toContain(ev.eventClass);
	});
});

describe('accountKeysOf', () => {
	it('reads the parsed shape as well as the raw one', () => {
		expect(accountKeysOf({ transaction: { message: { accountKeys: [{ pubkey: AGENT }] } } })).toEqual([AGENT]);
		expect(accountKeysOf({ transaction: { message: { staticAccountKeys: [AGENT] } } })).toEqual([AGENT]);
	});
});

describe('memoPayloadOf', () => {
	it('returns null for a transaction with no memo', () => {
		expect(memoPayloadOf({ meta: { logMessages: ['Program log: Instruction: Foo'] } })).toBe(null);
	});
});

describe('transferRecipientOf', () => {
	it('picks the largest gainer that is not the fee payer', () => {
		const tx = { meta: { preBalances: [100, 0, 0], postBalances: [50, 10, 40] } };
		expect(transferRecipientOf(tx, ['payer', 'small', 'big'])).toBe('big');
	});

	it('returns null when the balances do not say', () => {
		expect(transferRecipientOf({ meta: {} }, ['a', 'b'])).toBe(null);
	});
});

// ─── normalizeEvent ──────────────────────────────────────────────────────────

describe('normalizeEvent', () => {
	const good = {
		chain: 'solana',
		agentRef: AGENT,
		eventClass: 'token_launch',
		eventName: 'SetAgentTokenV1',
		tx: 'sig',
		occurredAt: 1786600541,
	};

	it('accepts a well-formed Solana event and forces chainId 0', () => {
		const e = normalizeEvent(good);
		expect(e.chainId).toBe(0);
		expect(e.network).toBe('mainnet');
		expect(e.occurredAt.toISOString()).toBe('2026-08-13T05:55:41.000Z');
	});

	it('rejects an event with no readable on-chain timestamp', () => {
		// The alternative is stamping it with now(), which silently corrupts every
		// timeline and every lag number computed from this table.
		expect(normalizeEvent({ ...good, occurredAt: null })).toBe(null);
		expect(normalizeEvent({ ...good, occurredAt: 'not a date' })).toBe(null);
	});

	it('rejects an unknown event class', () => {
		expect(normalizeEvent({ ...good, eventClass: 'airdrop' })).toBe(null);
	});
});

describe('toDate', () => {
	it('reads unix seconds and milliseconds alike', () => {
		expect(toDate(1786600541).toISOString()).toBe('2026-08-13T05:55:41.000Z');
		expect(toDate(1786600541000).toISOString()).toBe('2026-08-13T05:55:41.000Z');
	});

	it('rejects values no agent registry could have produced', () => {
		expect(toDate(1)).toBe(null);
		expect(toDate(99999999999999)).toBe(null);
	});
});

describe('agentRef', () => {
	it('keys EVM agents by chain and id, Solana agents by account', () => {
		expect(agentRef({ chain: 'evm', chainId: 8453, agentId: '63521' })).toBe('8453:63521');
		expect(agentRef({ chain: 'solana', ref: AGENT })).toBe(AGENT);
	});
});

// ─── EVM adaptive block window ───────────────────────────────────────────────

describe('nextChunkSize', () => {
	it('holds the window when the chain is caught up', () => {
		expect(nextChunkSize({ stored: 1000, configured: null, behind: 40 })).toBe(1000);
	});

	it('grows while behind so a fast chain can actually catch up', () => {
		// Arbitrum One consumes 1000 blocks per 251s of chain time against a
		// 900s cron period, so a fixed window loses ground on every tick.
		expect(nextChunkSize({ stored: 1000, configured: null, behind: 250_000 })).toBe(2000);
		expect(nextChunkSize({ stored: 2000, configured: null, behind: 250_000 })).toBe(4000);
	});

	it('never overshoots the backlog or the provider ceiling', () => {
		expect(nextChunkSize({ stored: 1000, configured: null, behind: 1500 })).toBe(1500);
		expect(nextChunkSize({ stored: 8000, configured: null, behind: 10_000_000 })).toBe(8000);
	});

	it('seeds from the declared per-chain override on the first tick', () => {
		expect(nextChunkSize({ stored: null, configured: 500, behind: 100 })).toBe(500);
	});
});

describe('backoffChunkSize', () => {
	it('halves the window when a provider rejects the range', () => {
		expect(backoffChunkSize(4000)).toBe(2000);
		expect(backoffChunkSize(1000)).toBe(500);
	});

	it('never falls below a window worth requesting', () => {
		expect(backoffChunkSize(100)).toBe(100);
		expect(backoffChunkSize(1)).toBe(100);
	});
});

// ─── Sweep capacity ──────────────────────────────────────────────────────────

describe('sweepCycleMin', () => {
	it('reports the full-sweep time that sets the median lag floor', () => {
		// The measured failure: 1,576 agents at 40 per 10-minute tick cycles in
		// 400 minutes, which is exactly the ~200-minute median the status surface
		// showed. The batch is the lever, so the cycle has to be visible.
		expect(sweepCycleMin(1576)).toBe(Math.ceil(1576 / SOLANA_SWEEP_BATCH) * SOLANA_SWEEP_PERIOD_MIN);
	});

	it('keeps the median under the degraded threshold at the shipped batch size', () => {
		// Median lag is half the cycle; SOLANA_LAG_DEGRADED_MIN is 90.
		expect(sweepCycleMin(1576) / 2).toBeLessThan(90);
	});

	it('is null when nothing is queued', () => {
		expect(sweepCycleMin(0)).toBe(null);
	});
});
