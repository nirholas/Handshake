// Hardening for autonomous agent-to-agent payments.
//
// An Intent Mandate is a signed, offline-verifiable bearer credential with a
// lifetime of up to 90 days. On its own it authorizes spend and has no way to
// take that authorization back, so the mandate alone cannot be the whole safety
// story: /api/agents/a2a-call has to run every payment through the SAME
// server-side per-agent spend policy the trade / snipe / x402 / withdraw paths
// already use, and has to leave a durable receipt behind.
//
// These tests cover the two halves of that:
//   1. The per-counterparty ceiling added to the shared policy — the cap that
//      bounds CONCENTRATED loss, which a wallet-wide daily cap does not.
//   2. The a2a-call handler: the kill switch stops it before the peer is even
//      contacted, each ceiling blocks it before anything is signed, a blocked
//      call gives the mandate's budget back, and a settled call finalizes a
//      queryable receipt.
//
// The DB is mocked here so these stay deterministic; the same four limits are
// additionally proven against a real Postgres (real advisory locks, real atomic
// reserve) by scripts/a2a-spend-hardening-proof.mjs.

import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
process.env.A2A_MANDATE_SECRET = 'test-a2a-mandate-secret';
process.env.A2A_PAYER_SOLANA_SECRET = 'test-payer-secret';

// ── shared mocks ──────────────────────────────────────────────────────────────

const sqlState = { queue: [], calls: [] };
vi.mock('../api/_lib/db.js', () => ({
	sql: vi.fn(async (strings, ...values) => {
		sqlState.calls.push({ query: strings.join('?'), values });
		return sqlState.queue.length ? sqlState.queue.shift() : [];
	}),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

vi.mock('../api/_lib/avatar-wallet.js', () => ({ solUsdPrice: vi.fn(async () => 200) }));
vi.mock('../api/_lib/audit.js', () => ({ logAudit: vi.fn() }));
vi.mock('../api/_lib/anomaly-events.js', () => ({
	guardOutboundAnomaly: vi.fn(async () => ({ decision: 'allow', verdict: null, anomalyId: null, froze: false })),
}));

const guards = await import('../api/_lib/agent-trade-guards.js');
const { enforceSpendLimit, normalizeSpendLimits, SpendLimitError } = guards;

beforeEach(() => {
	sqlState.queue = [];
	sqlState.calls = [];
});

// ── 1. the per-counterparty ceiling ───────────────────────────────────────────

const PEER_A = 'PeerAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const PEER_B = 'PeerBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

describe('per-counterparty daily ceiling', () => {
	it('normalizes the cap off the agent meta blob', () => {
		expect(normalizeSpendLimits({ per_counterparty_daily_usd: 5 }).per_counterparty_daily_usd).toBe(5);
		expect(normalizeSpendLimits({}).per_counterparty_daily_usd).toBeNull();
		// Garbage and negatives fall back to "no cap" rather than to a cap of zero,
		// which would silently brick every spend.
		expect(normalizeSpendLimits({ per_counterparty_daily_usd: -4 }).per_counterparty_daily_usd).toBeNull();
		expect(normalizeSpendLimits({ per_counterparty_daily_usd: 'lots' }).per_counterparty_daily_usd).toBeNull();
	});

	it('blocks a payment that pushes this counterparty over its 24h ceiling', async () => {
		sqlState.queue.push([{ usd: 8 }]); // already sent $8 to PEER_A today
		await expect(
			enforceSpendLimit({
				agentId: 'agent-1',
				limits: normalizeSpendLimits({ per_counterparty_daily_usd: 10 }),
				policyRules: null,
				category: 'x402',
				usdValue: 4,
				destination: PEER_A,
			}),
		).rejects.toMatchObject({ code: 'counterparty_daily_exceeded' });
	});

	it('names the counterparty and both numbers so the owner can act on the block', async () => {
		sqlState.queue.push([{ usd: 9.5 }]);
		const err = await enforceSpendLimit({
			agentId: 'agent-1',
			limits: normalizeSpendLimits({ per_counterparty_daily_usd: 10 }),
			policyRules: null,
			category: 'x402',
			usdValue: 1,
			destination: PEER_A,
		}).catch((e) => e);
		expect(err).toBeInstanceOf(SpendLimitError);
		expect(err.detail.destination).toBe(PEER_A);
		expect(err.detail.counterparty_spent_usd).toBe(9.5);
		expect(err.detail.per_counterparty_daily_usd).toBe(10);
	});

	it('allows the identical amount to a DIFFERENT counterparty', async () => {
		// This is the whole point of the cap: it meters per payee, not in total. A
		// fresh peer has spent nothing, so the same $4 goes through.
		sqlState.queue.push([{ usd: 0 }]);
		await expect(
			enforceSpendLimit({
				agentId: 'agent-1',
				limits: normalizeSpendLimits({ per_counterparty_daily_usd: 10 }),
				policyRules: null,
				category: 'x402',
				usdValue: 4,
				destination: PEER_B,
			}),
		).resolves.toMatchObject({ ok: true });
	});

	it('does not fire when the wallet sets no per-counterparty cap', async () => {
		await expect(
			enforceSpendLimit({
				agentId: 'agent-1',
				limits: normalizeSpendLimits({}),
				policyRules: null,
				category: 'x402',
				usdValue: 1000,
				destination: PEER_A,
			}),
		).resolves.toMatchObject({ ok: true });
	});

	it('cannot meter a spend that names no counterparty', async () => {
		// Nothing to group by. The wallet-wide caps still govern it; this one abstains
		// rather than blocking (or silently passing) on a payee it never saw.
		await expect(
			enforceSpendLimit({
				agentId: 'agent-1',
				limits: normalizeSpendLimits({ per_counterparty_daily_usd: 1 }),
				policyRules: null,
				category: 'x402',
				usdValue: 500,
				destination: null,
			}),
		).resolves.toMatchObject({ ok: true });
	});
});

// ── 1b. the policy resolves fail-closed ───────────────────────────────────────
//
// The ceilings above are only guarantees if there is no way to call the guard
// that skips them. There used to be one: with neither `limits` nor `meta`, both
// shared guards fell back to an empty default policy (every cap null, frozen
// false), so a caller that forgot to load the agent row spent unbounded and
// nothing said so. The guard now reads the agent's real policy itself.

const AGENT_ROW = (spendLimits) => [{ user_id: 'owner-1', meta: { spend_limits: spendLimits } }];

describe('spend policy resolution', () => {
	it('reads the kill switch off the agent row when the caller passes neither limits nor meta', async () => {
		sqlState.queue.push(AGENT_ROW({ frozen: true }));
		await expect(
			enforceSpendLimit({ agentId: 'agent-1', category: 'x402', usdValue: 1, destination: PEER_A }),
		).rejects.toMatchObject({ code: 'wallet_frozen' });
	});

	it('reads the per-transaction ceiling off the agent row the same way', async () => {
		sqlState.queue.push(AGENT_ROW({ per_tx_usd: 1 }));
		await expect(
			enforceSpendLimit({ agentId: 'agent-1', category: 'x402', usdValue: 5, destination: PEER_A }),
		).rejects.toMatchObject({ code: 'per_tx_exceeded' });
	});

	it('refuses the spend outright when the agent row is gone', async () => {
		// A deleted agent can hold no policy, so there is nothing to enforce against.
		// Fail closed: refuse, never fall through to an unrestricted wallet.
		sqlState.queue.push([]);
		await expect(
			enforceSpendLimit({ agentId: 'agent-1', category: 'x402', usdValue: 1, destination: PEER_A }),
		).rejects.toMatchObject({ code: 'agent_not_found' });
	});

	it('does not re-read the row when the caller already resolved the limits', async () => {
		// The safety net must not cost every well-behaved call site an extra query.
		await expect(
			enforceSpendLimit({
				agentId: 'agent-1',
				limits: normalizeSpendLimits({ per_tx_usd: 10 }),
				policyRules: null,
				category: 'x402',
				usdValue: 1,
				destination: PEER_A,
			}),
		).resolves.toMatchObject({ ok: true });
		expect(sqlState.calls.some((c) => /FROM agent_identities/.test(c.query))).toBe(false);
	});

	it('honors an explicitly empty meta as an explicitly empty policy', async () => {
		// `meta: {}` is a real answer from the caller ("this agent has set nothing"),
		// not a missing one, so it must not trigger the row read.
		await expect(
			enforceSpendLimit({ agentId: 'agent-1', meta: {}, category: 'x402', usdValue: 1000, destination: PEER_A }),
		).resolves.toMatchObject({ ok: true });
		expect(sqlState.calls.some((c) => /FROM agent_identities/.test(c.query))).toBe(false);
	});

	it('halts the atomic reserve on the same row-resolved kill switch', async () => {
		// Part 2 stubs reserveSpendUsd to steer the handler, so reach past the stub
		// for the real one: both guards have to resolve the policy the same way.
		const real = await vi.importActual('../api/_lib/agent-trade-guards.js');
		sqlState.queue.push(AGENT_ROW({ frozen: true, daily_usd: 1000 }));
		await expect(
			real.reserveSpendUsd({ agentId: 'agent-1', category: 'x402', usdValue: 1, destination: PEER_A }),
		).rejects.toMatchObject({ code: 'wallet_frozen' });
	});
});

// ── 2. the a2a-call handler ───────────────────────────────────────────────────

const AGENT_ID = '33333333-3333-4333-8333-333333333333';
const PEER_ENDPOINT = 'https://peer.example/a2a';

// Hoisted so the guards mock factory (which vitest runs during the first import
// of agent-trade-guards, before this line of the module body executes) can see
// them without hitting the temporal dead zone.
const { guardState, guardCalls } = vi.hoisted(() => ({
	guardState: {
		limits: { frozen: false },
		reserve: null, // null = allow; an Error = block with it
	},
	guardCalls: { reserve: [], release: [], update: [] },
}));

vi.mock('../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => ({ id: 'owner-1' })),
	authenticateBearer: vi.fn(async () => null),
	extractBearer: vi.fn(() => null),
}));
vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: { mcpAgentPay: vi.fn(async () => ({ success: true })) },
	clientIp: () => '127.0.0.1',
}));
vi.mock('../api/_lib/ssrf-guard.js', () => ({
	assertSafePublicUrl: vi.fn(async (u) => new URL(u)),
	SsrfBlockedError: class SsrfBlockedError extends Error {},
}));

// Partial mock: the handler's ledger calls (reserve / release / finalize) are
// stubbed so part 2 can steer them, while enforceSpendLimit,
// normalizeSpendLimits, and SpendLimitError stay REAL so part 1 exercises the
// actual policy code, not a copy of it.
vi.mock('../api/_lib/agent-trade-guards.js', async (importOriginal) => {
	const actual = await importOriginal();
	return {
		...actual,
		getSpendLimits: vi.fn(() => guardState.limits),
		reserveSpendUsd: vi.fn(async (args) => {
			guardCalls.reserve.push(args);
			if (guardState.reserve) throw guardState.reserve;
			return { reservationId: 4242, dailySpentUsd: 0 };
		}),
		releaseSpendReservation: vi.fn(async (id, reason) => { guardCalls.release.push({ id, reason }); }),
		updateCustodyEvent: vi.fn(async (id, patch) => { guardCalls.update.push({ id, patch }); }),
	};
});

const clientState = { quoteCalls: 0, submitCalls: 0, submitResult: null };
vi.mock('../api/_lib/x402/a2a-client.js', () => ({
	A2AClientError: class A2AClientError extends Error {
		constructor(code, message, detail) { super(message); this.code = code; this.detail = detail; }
	},
	NETWORK_SOLANA_MAINNET: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
	NETWORK_SOLANA_DEVNET: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
	isSolanaNetwork: (n) => String(n).startsWith('solana'),
	requestQuote: vi.fn(async () => {
		clientState.quoteCalls += 1;
		return {
			taskId: 'task-1',
			required: {
				accepts: [{
					scheme: 'exact',
					network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
					amount: '2000000', // $2.00 USDC
					payTo: PEER_A,
					extra: { name: 'USDC' },
				}],
				resource: { url: PEER_ENDPOINT, mimeType: 'application/json' },
			},
		};
	}),
	submitPayment: vi.fn(async () => {
		clientState.submitCalls += 1;
		return clientState.submitResult;
	}),
	createSolanaSigner: vi.fn(async () => ({ address: 'PayerAddress1111111111111111111111111111111' })),
	createPrivateKeySigner: vi.fn(async () => ({ address: '0xpayer' })),
	buildSolanaExactPayload: vi.fn(async () => ({ payload: 'solana' })),
	buildEvmExactPayload: vi.fn(async () => ({ payload: 'evm' })),
}));

const { issueIntentMandate } = await import('../api/_lib/a2a/mandate.js');
const { _resetMemoryStore, spent: mandateSpent } = await import('../api/_lib/a2a/spend-ledger.js');
const { default: handler } = await import('../api/agents/a2a-call.js');

function makeRes() {
	return {
		statusCode: 0,
		payload: null,
		headers: {},
		setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
		getHeader(k) { return this.headers[String(k).toLowerCase()]; },
		removeHeader(k) { delete this.headers[String(k).toLowerCase()]; },
		writeHead(code) { this.statusCode = code; return this; },
		get headersSent() { return false; },
		get writableEnded() { return false; },
		end(chunk) {
			if (chunk) { try { this.payload = JSON.parse(String(chunk)); } catch { this.payload = String(chunk); } }
			return this;
		},
	};
}

async function callWithMandate(overrides = {}) {
	const { jws, mandate } = await issueIntentMandate({
		ownerUserId: 'owner-1',
		subjectAgentId: AGENT_ID,
		maxAtomics: '100000000', // $100 lifetime
		perCallAtomics: '10000000', // $10 per call
		networks: ['solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'],
		ttlSec: 3600,
		...overrides,
	});
	const res = makeRes();
	await handler({
		method: 'POST',
		url: '/api/agents/a2a-call',
		headers: { 'content-type': 'application/json', origin: 'https://three.ws' },
		body: { mandate: jws, endpoint: PEER_ENDPOINT, text: 'Do the thing.' },
	}, res);
	return { res, mandate };
}

beforeEach(() => {
	sqlState.queue = [];
	sqlState.calls = [];
	guardState.limits = { frozen: false };
	guardState.reserve = null;
	guardCalls.reserve.length = 0;
	guardCalls.release.length = 0;
	guardCalls.update.length = 0;
	clientState.quoteCalls = 0;
	clientState.submitCalls = 0;
	clientState.submitResult = { state: 'completed', receipts: [{ transaction: 'sig-1' }], task: { artifacts: [] } };
	_resetMemoryStore();
});

function ownedAgent(meta = {}) {
	return [{ id: AGENT_ID, user_id: 'owner-1', meta }];
}

describe('POST /api/agents/a2a-call — the kill switch', () => {
	it('halts a frozen agent before the peer is even quoted', async () => {
		sqlState.queue.push(ownedAgent());
		guardState.limits = { frozen: true };

		const { res } = await callWithMandate();

		expect(res.statusCode).toBe(403);
		expect(res.payload.error).toBe('wallet_frozen');
		// The whole point of halting: no outbound traffic in the agent's name, no
		// spend reserved, nothing signed or submitted.
		expect(clientState.quoteCalls).toBe(0);
		expect(clientState.submitCalls).toBe(0);
		expect(guardCalls.reserve).toHaveLength(0);
	});

	it('lets an unfrozen agent through the same path', async () => {
		sqlState.queue.push(ownedAgent());
		const { res } = await callWithMandate();
		expect(res.statusCode).toBe(200);
		expect(clientState.submitCalls).toBe(1);
	});
});

describe('POST /api/agents/a2a-call — the agent still has to be the caller’s', () => {
	it('404s once the subject agent is gone, even with a valid mandate', async () => {
		sqlState.queue.push([]); // deleted since the mandate was signed
		const { res } = await callWithMandate();
		expect(res.statusCode).toBe(404);
		expect(res.payload.error).toBe('agent_not_found');
		expect(clientState.quoteCalls).toBe(0);
	});

	it('403s once the subject agent belongs to someone else', async () => {
		sqlState.queue.push([{ id: AGENT_ID, user_id: 'someone-else', meta: {} }]);
		const { res } = await callWithMandate();
		expect(res.statusCode).toBe(403);
		expect(res.payload.error).toBe('agent_not_yours');
		expect(clientState.quoteCalls).toBe(0);
	});
});

describe('POST /api/agents/a2a-call — each spend ceiling blocks', () => {
	const cases = [
		['per_tx_exceeded', 'This x402 is $2.00, over the per-transaction limit of $1.00.'],
		['daily_exceeded', 'This x402 would bring today’s spend to $12.00, over the daily limit of $10.00.'],
		['counterparty_daily_exceeded', 'This x402 would bring today’s spend to this counterparty to $6.00, over the per-counterparty limit of $5.00.'],
		['wallet_anomaly_frozen', 'This wallet was frozen automatically: the payment is unlike anything this agent has done.'],
	];

	for (const [code, message] of cases) {
		it(`refuses the payment on ${code} and settles nothing`, async () => {
			sqlState.queue.push(ownedAgent());
			guardState.reserve = new SpendLimitError(code, message, {});

			const { res, mandate } = await callWithMandate();

			expect(res.statusCode).toBe(403);
			expect(res.payload.error).toBe(code);
			expect(res.payload.error_description).toBe(message);
			// Nothing was signed or sent...
			expect(clientState.submitCalls).toBe(0);
			// ...and the mandate's budget was handed back, so a blocked call does not
			// quietly burn the authorization the owner issued.
			expect(await mandateSpent(mandate.mandateId)).toBe(0);
		});
	}

	it('prices the payment in USD and names the peer as the counterparty', async () => {
		sqlState.queue.push(ownedAgent());
		await callWithMandate();
		expect(guardCalls.reserve[0]).toMatchObject({
			agentId: AGENT_ID,
			userId: 'owner-1',
			category: 'x402',
			usdValue: 2, // 2_000_000 USDC atomics
			destination: PEER_A,
			network: 'mainnet',
			asset: 'USDC',
		});
		expect(guardCalls.reserve[0].rowMeta).toMatchObject({ kind: 'a2a', endpoint: PEER_ENDPOINT });
	});
});

describe('POST /api/agents/a2a-call — receipts', () => {
	it('finalizes a queryable receipt when the payment settles', async () => {
		sqlState.queue.push(ownedAgent());
		const { res } = await callWithMandate();

		expect(res.statusCode).toBe(200);
		expect(res.payload.receipt_id).toBe('4242');
		expect(res.payload.usd).toBe(2);
		expect(res.payload.agent_id).toBe(AGENT_ID);

		expect(guardCalls.update).toHaveLength(1);
		expect(guardCalls.update[0].id).toBe(4242);
		expect(guardCalls.update[0].patch.status).toBe('confirmed');
		expect(guardCalls.update[0].patch.signature).toBe('sig-1');
		// The receipt has to carry the signed cart, or the durable record can't prove
		// WHAT was bought without asking the peer again.
		expect(typeof guardCalls.update[0].patch.meta.cart_mandate).toBe('string');
		expect(guardCalls.release).toHaveLength(0);
	});

	it('releases the receipt when the peer never completes the task', async () => {
		sqlState.queue.push(ownedAgent());
		clientState.submitResult = { state: 'failed', receipts: [{ errorReason: 'peer said no' }] };

		const { res, mandate } = await callWithMandate();

		expect(res.statusCode).toBe(502);
		// A payment that never landed must not keep holding daily headroom.
		expect(guardCalls.release).toEqual([{ id: 4242, reason: 'peer_task_incomplete' }]);
		expect(guardCalls.update).toHaveLength(0);
		expect(await mandateSpent(mandate.mandateId)).toBe(0);
	});
});
