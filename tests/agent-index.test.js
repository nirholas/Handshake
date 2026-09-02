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
	SOLANA_SWEEP_CONCURRENCY,
	drainWithBudget,
} from '../api/_lib/solana-agent-events.js';
import {
	normalizeEvent,
	toDate,
	agentRef,
	EVENT_CLASSES,
	sanitizeText,
	sanitizePayload,
} from '../api/_lib/onchain-events.js';
import {
	sweepCycleMin,
	indexLagVerdict,
	SOLANA_ERROR_RATE_DEGRADED,
	SOLANA_ERROR_RATE_DOWN,
	SOLANA_LAG_DEGRADED_MIN,
} from '../api/_lib/ops/index-lag.js';
import {
	nextChunkSize,
	backoffChunkSize,
	isRangeRejection,
	isPrunedHistoryRejection,
	catchUpCandidates,
	rank,
} from '../api/cron/[name].js';
import { splitCapabilities } from '../api/explore-item.js';
import { decodeReputationLog } from '../api/_lib/erc8004-reputation-events.js';

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

	// Measured on 2026-08-28: Base mainnet's crawl cursor had been frozen 310
	// hours, Ethereum's 97 and Gnosis's 371, every one of them holding
	// `unsupported Unicode escape sequence` in last_error. A NUL byte inside an
	// on-chain metadata string failed the jsonb INSERT, recordEvents is awaited
	// before the cursor advances, so the next tick re-read the same range and
	// hit the same byte forever.
	it('keeps an event whose on-chain strings carry bytes jsonb cannot store', () => {
		const NUL = String.fromCharCode(0);
		const row = normalizeEvent({
			...good,
			chain: 'evm',
			chainId: 8453,
			eventClass: 'metadata',
			eventName: `MetadataSet${NUL}`,
			actor: `0xabc${NUL}`,
			payload: { [`ur${NUL}i`]: `ipfs://q${NUL}m`, tags: [`a${NUL}b`] },
		});
		expect(row).not.toBe(null);
		expect(row.eventName).toBe('MetadataSet');
		expect(row.actor).toBe('0xabc');
		expect(row.payload).toEqual({ uri: 'ipfs://qm', tags: ['ab'] });
		expect(JSON.stringify(row.payload)).not.toContain('\\u0000');
	});
});

describe('sanitizeText', () => {
	it('drops NUL and replaces a lone surrogate, leaving real text alone', () => {
		expect(sanitizeText(`a${String.fromCharCode(0)}b`)).toBe('ab');
		expect(sanitizeText(`a${String.fromCharCode(0xd800)}b`)).toBe('a\uFFFDb');
		expect(sanitizeText('a\u{1F600}b')).toBe('a\u{1F600}b');
	});
});

describe('sanitizePayload', () => {
	it('walks arrays and nested objects, keys included', () => {
		const NUL = String.fromCharCode(0);
		expect(sanitizePayload({ [`k${NUL}`]: [{ v: `x${NUL}y` }] })).toEqual({ k: [{ v: 'xy' }] });
	});

	it('drops a subtree past the depth guard rather than passing it through raw', () => {
		// Returning the unwalked object would hand unsanitized on-chain strings
		// straight to jsonb, which is the failure this function exists to stop.
		let deep = { v: `x${String.fromCharCode(0)}y` };
		for (let i = 0; i < 12; i += 1) deep = { n: deep };
		expect(JSON.stringify(sanitizePayload(deep))).not.toContain('\\u0000');
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

	it('reaches a fixed point at the floor so the in-tick retry terminates', () => {
		// erc8004CrawlChain retries the same blocks at backoffChunkSize until the
		// value stops shrinking. If halving never converged, that loop would spin.
		let size = 8000;
		for (let i = 0; i < 20; i++) {
			const next = backoffChunkSize(size);
			if (next >= size) break;
			size = next;
		}
		expect(size).toBe(100);
		expect(backoffChunkSize(size)).toBe(size);
	});
});

describe('isPrunedHistoryRejection', () => {
	it('recognises a provider that no longer holds the blocks the cursor points at', () => {
		// Verbatim from erc8004_crawl_cursor.last_error on 2026-09-02, on a chain
		// whose cursor had not moved since 2026-04-28.
		expect(
			isPrunedHistoryRejection('RPC -32701: History has been pruned for this block. To remove restriction'),
		).toBe(true);
		expect(isPrunedHistoryRejection('missing trie node 0xabc (path )')).toBe(true);
	});

	it('reads a paywalled archive range as the same retention wall', () => {
		// Verbatim from the lane that held the busiest secondary chain 17,396,220
		// blocks behind head. A keyless node that serves the last few thousand
		// blocks and charges for anything older has drawn exactly the wall a
		// pruning node draws: no window down to the 100-block floor gets past it,
		// so the shrink loop spun on it for months.
		expect(
			isPrunedHistoryRejection(
				'RPC -32602: Archive requests require a personal token. Get one at: https://www.allnodes.com/publicnode',
			),
		).toBe(true);
		expect(isPrunedHistoryRejection('this method requires an archive node')).toBe(true);
	});

	it('does NOT claim a range rejection or a plan limit is pruned history', () => {
		// These have their own recovery (shrink the window). Reading them as
		// pruned would skip the cursor to the head and silently drop real blocks.
		expect(isPrunedHistoryRejection('block range is too wide (maximum 1024)')).toBe(false);
		expect(isPrunedHistoryRejection('limit exceeded')).toBe(false);
		expect(isPrunedHistoryRejection('HTTP 403')).toBe(false);
		expect(isPrunedHistoryRejection(null)).toBe(false);
		expect(isPrunedHistoryRejection('')).toBe(false);
	});

	it('is disjoint from isRangeRejection, so exactly one recovery can claim a fault', () => {
		for (const msg of [
			'RPC -32701: History has been pruned for this block',
			'block range is too wide (maximum 1024)',
			'query returned more than 10000 results',
			'missing trie node',
			'RPC -32602: Archive requests require a personal token',
		]) {
			expect(isPrunedHistoryRejection(msg) && isRangeRejection(msg)).toBe(false);
		}
	});
});

describe('isRangeRejection', () => {
	it('recognises how each provider words a range it will not serve', () => {
		// Verbatim messages observed from the configured lanes on 2026-08-14.
		expect(isRangeRejection('block range is too wide (maximum 1024)')).toBe(true);
		expect(isRangeRejection('Log response size exceeded')).toBe(true);
		expect(isRangeRejection('query returned more than 10000 results')).toBe(true);
		expect(isRangeRejection('eth_getLogs is limited to a 10000 block range')).toBe(true);
	});

	it('does NOT treat a plan or rate limit as a range the crawl can shrink into', () => {
		// bnbchain's data-seed nodes answer every eth_getLogs with this, at any
		// width. Reading it as a range ceiling shrank BSC Testnet to the 100-block
		// floor and froze its cursor while the backlog grew every tick.
		expect(isRangeRejection('limit exceeded')).toBe(false);
		expect(isRangeRejection('cu limit exceeded; Method "eth_getLogs" is not available')).toBe(false);
	});

	it('treats a missing or empty message as a real fault, not a range problem', () => {
		expect(isRangeRejection(null)).toBe(false);
		expect(isRangeRejection('')).toBe(false);
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

	it('finishes a full cycle inside the fresh threshold, not just the median', () => {
		// The median passing is not enough. The oldest agent in the queue waits a
		// WHOLE cycle, so a cycle longer than the fresh threshold means part of the
		// directory is always stale by the sensor's own definition. Measured on
		// 2026-09-02: 1,604 agents at 120 per tick cycled in 140 minutes against a
		// 90-minute threshold, and the batch, not the cron's budget, was the cap.
		expect(sweepCycleMin(1604)).toBeLessThanOrEqual(SOLANA_LAG_DEGRADED_MIN);
	});

	it('leaves the directory room to grow before the batch has to move again', () => {
		// Headroom is the point: a batch sized exactly to today's directory goes
		// stale the week it grows. This is the size at which someone must revisit.
		expect(sweepCycleMin(2000)).toBeLessThanOrEqual(SOLANA_LAG_DEGRADED_MIN);
	});

	it('is null when nothing is queued', () => {
		expect(sweepCycleMin(0)).toBe(null);
	});
});

describe('drainWithBudget', () => {
	// A hand-cranked clock, not a timer: the budget cases have to be exact, and
	// a real clock would make them race on a loaded machine.
	const clockFrom = (ticks) => {
		let i = 0;
		return () => ticks[Math.min(i++, ticks.length - 1)];
	};

	it('runs every item once, in order, when the budget is not the constraint', async () => {
		const seen = [];
		const run = await drainWithBudget([1, 2, 3, 4, 5], async (n) => void seen.push(n), { concurrency: 1 });
		expect(seen).toEqual([1, 2, 3, 4, 5]);
		expect(run.processed).toBe(5);
		expect(run.truncated).toBe(false);
	});

	it('overlaps work across the pool instead of serialising it', async () => {
		let inFlight = 0;
		let peak = 0;
		const run = await drainWithBudget(
			Array.from({ length: 12 }, (_, i) => i),
			async () => {
				inFlight += 1;
				peak = Math.max(peak, inFlight);
				await Promise.resolve();
				await Promise.resolve();
				inFlight -= 1;
			},
			{ concurrency: 4 },
		);
		expect(peak).toBe(4);
		expect(run.workers).toBe(4);
		expect(run.processed).toBe(12);
	});

	it('never opens more workers than there is work for them to do', async () => {
		const run = await drainWithBudget([1, 2], async () => {}, { concurrency: 8 });
		expect(run.workers).toBe(2);
		expect(run.processed).toBe(2);
	});

	it('stops on the budget and says the rest is still queued', async () => {
		// Clock: start at 0, then jump past the budget on the second check.
		const seen = [];
		const run = await drainWithBudget([1, 2, 3, 4], async (n) => void seen.push(n), {
			concurrency: 1,
			budgetMs: 100,
			now: clockFrom([0, 0, 500]),
		});
		expect(seen).toEqual([1]);
		expect(run.truncated).toBe(true);
		expect(run.processed).toBe(1);
	});

	it('reports a run that consumed its last item on the deadline as complete', async () => {
		// The queue is read before the clock precisely so this is not truncated:
		// a tick that finished everything has no remainder to report, and calling
		// it truncated would tell the sweep to shrink a batch that was fine.
		const run = await drainWithBudget([1, 2], async () => {}, {
			concurrency: 1,
			budgetMs: 100,
			now: clockFrom([0, 0, 50, 9999]),
		});
		expect(run.processed).toBe(2);
		expect(run.truncated).toBe(false);
	});

	it('does nothing, and claims nothing, for an empty queue', async () => {
		const run = await drainWithBudget([], async () => {
			throw new Error('an empty queue must not reach the handler');
		});
		expect(run.processed).toBe(0);
		expect(run.truncated).toBe(false);
	});

	it('keeps the shipped concurrency low enough not to outrun the RPC lanes', () => {
		// The lane router parks a cooling provider; a wide fan-out earns 429s
		// faster than it earns signatures. This is a ceiling, not a target.
		expect(SOLANA_SWEEP_CONCURRENCY).toBeGreaterThan(1);
		expect(SOLANA_SWEEP_CONCURRENCY).toBeLessThanOrEqual(8);
	});
});

// ─── Directory detail fallback ───────────────────────────────────────────────
// /discover lists external Solana agents from the crawled registry directory
// and links every one to /discover/a/sol/<asset>, which is also where the
// on-chain history panel lives. Those rows store capabilities as free text, not
// as the skill records the platform's own agents carry.

describe('splitCapabilities', () => {
	it('splits the separators the registries actually publish', () => {
		expect(splitCapabilities('chat, trade; render|3d')).toEqual(['chat', 'trade', 'render', '3d']);
		expect(splitCapabilities('one\ntwo')).toEqual(['one', 'two']);
	});

	it('passes an array through and drops empties', () => {
		expect(splitCapabilities(['a', '  ', 'b'])).toEqual(['a', 'b']);
		expect(splitCapabilities(',, ,')).toEqual([]);
	});

	it('caps a keyword-stuffed row so it cannot flood the page', () => {
		expect(splitCapabilities(Array.from({ length: 100 }, (_, i) => `c${i}`).join(','))).toHaveLength(24);
	});

	it('returns an empty list for a row with no capabilities at all', () => {
		expect(splitCapabilities(null)).toEqual([]);
		expect(splitCapabilities(undefined)).toEqual([]);
	});
});

// ─── EVM reputation leg ──────────────────────────────────────────────────────
// The reputation registry's logs were fetched from every chain on every tick
// and then used only to look up block timestamps: nothing decoded them. A
// census of the live index on 2026-08-14 found 9,231 EVM events across
// metadata, registration and transfer, and exactly zero reputation events.

describe('decodeReputationLog', () => {
	// Captured verbatim from Base mainnet transaction
	// 0xec66516180e67bb6a9a0352bdf2ed1a7f2d1605ac37dff94b1b4aaafe2730378.
	const NEW_FEEDBACK_LOG = {
		topics: [
			'0x6a4a61743519c9d648a14e6493f47dbe3ff1aa29e7785c96c8326a205e58febc',
			'0x0000000000000000000000000000000000000000000000000000000000006577',
			'0x0000000000000000000000006b51d0d67ff41dab76e499546abe6b8b03cf8732',
			'0xf238dbba46ca4d8272f320ebcffb24310138f9ea6c6609f439e562a0a3a13f26',
		],
		data: '0x00000000000000000000000000000000000000000000000000000000000007ee0000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000140000000000000000000000000000000000000000000000000000000000000018000000000000000000000000000000000000000000000000000000000000001e00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000b6d696e65722d766f7563680000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000007626f74636f696e00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002268747470733a2f2f636f6f7264696e61746f722e6167656e746d6f6e65792e6e6574000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000006068747470733a2f2f636f6f7264696e61746f722e6167656e746d6f6e65792e6e65742f76312f6d696e65722f3078366235316430643637666634316461623736653439393534366162653662386230336366383733322f73636f726563617264',
		blockNumber: '0x2f9fbe2',
		transactionHash: '0xec66516180e67bb6a9a0352bdf2ed1a7f2d1605ac37dff94b1b4aaafe2730378',
		logIndex: '0xdf',
	};

	it('decodes a live NewFeedback into a reputation event', () => {
		const ev = decodeReputationLog(NEW_FEEDBACK_LOG);
		expect(ev.eventClass).toBe('reputation');
		expect(ev.eventName).toBe('NewFeedback');
		expect(ev.agentId).toBe('25975');
		expect(ev.client).toBe('0x6b51d0d67ff41dab76e499546abe6b8b03cf8732');
		expect(ev.tag1).toBe('miner-vouch');
		// int128 kept as a decimal string so a large score never rounds.
		expect(ev.value).toBe('1');
		expect(ev.valueDecimals).toBe(0);
	});

	it('produces a row the index writer accepts', () => {
		const ev = decodeReputationLog(NEW_FEEDBACK_LOG);
		const row = normalizeEvent({
			chain: 'evm',
			chainId: 8453,
			agentRef: agentRef({ chain: 'evm', chainId: 8453, agentId: ev.agentId }),
			eventClass: ev.eventClass,
			eventName: ev.eventName,
			tx: ev.tx,
			logIndex: ev.logIndex,
			blockNumber: ev.blockNumber,
			occurredAt: '2026-08-13T23:35:03.000Z',
			actor: ev.client,
			payload: { tag1: ev.tag1 },
		});
		expect(row).not.toBe(null);
		expect(row.agentRef).toBe('8453:25975');
		expect(row.eventClass).toBe('reputation');
	});

	it('ignores a log from another topic', () => {
		expect(decodeReputationLog({ topics: ['0x' + '11'.repeat(32)], data: '0x' })).toBe(null);
	});
});

// ─── catchUpCandidates ───────────────────────────────────────────────────────

// Measured on 2026-08-28: Arbitrum One sat 18,375,509 blocks behind at an
// 8,000-block window. One chunk per 15-minute tick buys 768,000 blocks a day
// against a chain producing roughly 345,600, so the backlog drained in about
// six weeks while ticks that found every other chain at head returned with most
// of their 240-second budget unspent.
describe('catchUpCandidates', () => {
	it('ranks the chains still behind head, worst backlog first', () => {
		const picked = catchUpCandidates([
			{ chainId: 8453, blocksBehind: 0, scanned: 4000 },
			{ chainId: 42161, blocksBehind: 18_375_509, scanned: 8000 },
			{ chainId: 421614, blocksBehind: 15_668_383, scanned: 8000 },
		]);
		expect(picked.map((r) => r.chainId)).toEqual([42161, 421614]);
	});

	it('drops a chain that scanned nothing', () => {
		// scanned=0 is the provider refusing even the floor window. Re-asking it in
		// the same tick spins on the identical rejection and burns the whole budget.
		expect(catchUpCandidates([{ chainId: 56, blocksBehind: 900_000, scanned: 0 }])).toEqual([]);
	});

	it('returns nothing when every chain is at head, so a current tick does no extra work', () => {
		expect(catchUpCandidates([{ chainId: 8453, blocksBehind: 0, scanned: 120 }])).toEqual([]);
		expect(catchUpCandidates([])).toEqual([]);
		expect(catchUpCandidates(undefined)).toEqual([]);
	});
});

// ─── rank ────────────────────────────────────────────────────────────────────

describe('rank', () => {
	const NOW = 1_787_877_609_500;
	const minsAgo = (m) => new Date(NOW - m * 60_000).toISOString();

	it('puts a never-crawled chain above everything', () => {
		expect(rank(null, NOW)).toBeGreaterThan(rank({ blocks_behind: 18_375_509 }, NOW));
	});

	it('ranks a real backlog by its size', () => {
		expect(rank({ blocks_behind: 18_375_509 }, NOW)).toBe(18_375_509);
		expect(rank({ blocks_behind: 18_375_509 }, NOW)).toBeGreaterThan(
			rank({ blocks_behind: 15_668_383 }, NOW),
		);
	});

	it('separates caught-up chains by cursor age instead of collapsing them', () => {
		// The old Math.min(ageMin, 1) returned exactly 1 for every chain older than
		// a minute, and the cron runs every 15, so the sort fell through to the
		// declared array order on every tick and the tail was served last forever.
		const fresh = rank({ blocks_behind: 0, updated_at: minsAgo(15) }, NOW);
		const stale = rank({ blocks_behind: 0, updated_at: minsAgo(60 * 24 * 122) }, NOW);
		expect(stale).toBeGreaterThan(fresh);
	});

	it('lifts a chain that errors every tick above the healthy ones', () => {
		// blocks_behind is only written by a SUCCESSFUL crawl, so a chain failing on
		// every tick reports 0 behind forever and used to read as caught up. Polygon
		// sat 122 days like this on 2026-08-28.
		const broken = rank({ blocks_behind: 0, updated_at: minsAgo(60 * 24 * 122) }, NOW);
		const healthy = rank({ blocks_behind: 0, updated_at: minsAgo(15) }, NOW);
		expect(broken).toBeGreaterThan(healthy);
	});

	it('never lets mere staleness preempt a chain with a real backlog', () => {
		const stale = rank({ blocks_behind: 0, updated_at: minsAgo(60 * 24 * 365) }, NOW);
		expect(stale).toBeLessThan(rank({ blocks_behind: 18_375_509 }, NOW));
		expect(stale).toBeLessThan(rank({ blocks_behind: 500_000 }, NOW));
	});

	it('treats a missing or future timestamp as no age, never a negative rank', () => {
		expect(rank({ blocks_behind: 0, updated_at: null }, NOW)).toBe(0);
		expect(rank({ blocks_behind: 0, updated_at: new Date(NOW + 60_000).toISOString() }, NOW)).toBe(0);
	});
});

// ─── Index verdict ───────────────────────────────────────────────────────────
//
// Measured on production 2026-09-02: the sensor reported `down` on a secondary
// chain whose cursor had not moved since April, while the Solana leg it was
// burying had 1,101 of 1,604 cursors wedged on an unresolvable-cursor error and
// scored `ok` on a 63-minute median. Both halves of that are covered here: an
// EVM-only fault must not claim an outage users are not having, and a Solana
// leg that is erroring rather than lagging must stop reading as fresh.

/** A synthetic readIndexLag() shape, healthy unless overridden. */
function lagFixture({ solana = {}, evm = {} } = {}) {
	return {
		solana: {
			medianLagMin: 60,
			worstLagMin: 130,
			agents: 1604,
			uncrawled: 0,
			errored: 0,
			events: 1510,
			batch: SOLANA_SWEEP_BATCH,
			sweepCycleMin: 140,
			...solana,
		},
		evm: {
			lagMin: 15,
			chains: 22,
			configuredChains: 22,
			uncrawledChains: 0,
			staleChains: 0,
			behindChains: 0,
			worstBlocksBehind: 0,
			worstChainId: null,
			worstChainName: null,
			historyGapChains: 0,
			historyGapBlocks: 0,
			events: 107296,
			...evm,
		},
		lastEventAt: null,
		lastIndexedAt: null,
	};
}

describe('indexLagVerdict', () => {
	it('is ok when both legs are fresh', () => {
		expect(indexLagVerdict(lagFixture()).status).toBe('ok');
	});

	it('caps an EVM-only fault at degraded and says why', () => {
		// The exact production shape: a cursor stalled for months and a backlog
		// far past the down threshold, with Solana fresh.
		const verdict = indexLagVerdict(
			lagFixture({ evm: { lagMin: 183_014, worstBlocksBehind: 17_396_220, behindChains: 1, staleChains: 3 } }),
		);
		expect(verdict.status).toBe('degraded');
		expect(verdict.detail).toContain('the Solana index users read is fresh');
	});

	it('still reports down when Solana itself is the leg that is behind', () => {
		const verdict = indexLagVerdict(lagFixture({ solana: { medianLagMin: 400 } }));
		expect(verdict.status).toBe('down');
		// The cap is for EVM-only faults; it must never soften a Solana outage.
		expect(verdict.detail).not.toContain('the Solana index users read is fresh');
	});

	it('scores a wedged Solana leg on its error rate, not just its cursor age', () => {
		// 1,101 of 1,604 erroring on a fresh 63-minute median: `ok` before this.
		const verdict = indexLagVerdict(lagFixture({ solana: { medianLagMin: 63, errored: 1101 } }));
		expect(verdict.status).toBe('down');
		expect(verdict.detail).toContain('1101 erroring');
		expect(verdict.hint).toContain('agent_event_cursor');
	});

	it('degrades between the error-rate thresholds and clears below them', () => {
		const agents = 1000;
		const degraded = indexLagVerdict(
			lagFixture({ solana: { agents, errored: Math.ceil(agents * SOLANA_ERROR_RATE_DEGRADED) } }),
		);
		expect(degraded.status).toBe('degraded');

		const down = indexLagVerdict(
			lagFixture({ solana: { agents, errored: Math.ceil(agents * SOLANA_ERROR_RATE_DOWN) } }),
		);
		expect(down.status).toBe('down');

		const clear = indexLagVerdict(lagFixture({ solana: { agents, errored: 10 } }));
		expect(clear.status).toBe('ok');
	});

	it('names a permanent history gap that skipping the retention wall left behind', () => {
		// Skipping is what MAKES the chain report zero backlog again, so without
		// this line the 17M blocks the crawl gave up on vanish from every surface
		// the moment the recovery works.
		const verdict = indexLagVerdict(
			lagFixture({ evm: { historyGapChains: 2, historyGapBlocks: 19_881_607 } }),
		);
		expect(verdict.detail).toContain('2 carrying a permanent 19,881,607-block history gap');
	});

	it('does not let a history gap alone score the index unhealthy', () => {
		// The gap is history that is already lost. Scoring it would pin the
		// subsystem red forever over something no tick can ever fix.
		expect(
			indexLagVerdict(lagFixture({ evm: { historyGapChains: 3, historyGapBlocks: 25_000_000 } })).status,
		).toBe('ok');
	});

	it('reports a never-crawled index as warming up rather than broken', () => {
		const verdict = indexLagVerdict(lagFixture({ solana: { agents: 0 }, evm: { chains: 0 } }));
		expect(verdict.status).toBe('unknown');
	});
});
