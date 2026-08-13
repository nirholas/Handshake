// Tests for autonomous agent-to-agent payments: Intent Mandates, the spend
// ledger that enforces total budget, the ERC-8004 reputation gate, and the
// /api/agents/a2a-call endpoint that composes all three before paying a peer.

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mandate signing reads env lazily; set the secret before anything imports it.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
process.env.A2A_MANDATE_SECRET = 'test-a2a-mandate-secret';

import {
	assertMandateAllows,
	issueIntentMandate,
	MandateError,
	verifyIntentMandate,
} from '../api/_lib/a2a/mandate.js';
import { assertReputationOk, ReputationError } from '../api/_lib/a2a/reputation-gate.js';
import { _resetMemoryStore, release, reserve, spent } from '../api/_lib/a2a/spend-ledger.js';

// ── Intent Mandate ──────────────────────────────────────────────────────────

describe('Intent Mandate', () => {
	const base = {
		ownerUserId: 'user-1',
		subjectAgentId: 'agent-1',
		maxAtomics: '10000000', // $10
		perCallAtomics: '1000000', // $1
		networks: ['eip155:8453'],
		ttlSec: 3600,
	};

	it('issues and verifies a mandate round-trip', async () => {
		const { jws, mandate } = await issueIntentMandate(base);
		expect(typeof jws).toBe('string');
		const verified = await verifyIntentMandate(jws);
		expect(verified.ownerUserId).toBe('user-1');
		expect(verified.subjectAgentId).toBe('agent-1');
		expect(verified.maxAtomics).toBe('10000000');
		expect(verified.perCallAtomics).toBe('1000000');
		expect(verified.mandateId).toBe(mandate.mandateId);
		expect(verified.networks).toEqual(['eip155:8453']);
	});

	it('rejects a tampered/invalid mandate', async () => {
		await expect(verifyIntentMandate('not.a.jwt')).rejects.toMatchObject({ code: 'invalid_mandate' });
		const { jws } = await issueIntentMandate(base);
		await expect(verifyIntentMandate(jws + 'x')).rejects.toBeInstanceOf(MandateError);
	});

	it('rejects perCall greater than max at issuance', async () => {
		await expect(
			issueIntentMandate({ ...base, perCallAtomics: '99000000' }),
		).rejects.toMatchObject({ code: 'invalid_amount' });
	});

	it('rejects an unsupported network at issuance', async () => {
		await expect(
			issueIntentMandate({ ...base, networks: ['eip155:999999'] }),
		).rejects.toMatchObject({ code: 'unsupported_network' });
	});

	it('rejects a non-http resource prefix at issuance', async () => {
		await expect(
			issueIntentMandate({ ...base, resources: ['ftp://evil'] }),
		).rejects.toMatchObject({ code: 'invalid_resources' });
	});

	describe('assertMandateAllows', () => {
		let mandate;
		beforeEach(async () => {
			mandate = (
				await issueIntentMandate({ ...base, resources: ['https://peer.example/'] })
			).mandate;
		});

		it('allows a payment within policy', () => {
			expect(() =>
				assertMandateAllows({
					mandate,
					amountAtomics: '1000000',
					network: 'eip155:8453',
					resource: 'https://peer.example/skill',
					currency: 'USDC',
				}),
			).not.toThrow();
		});

		it('blocks a payment over the per-call cap', () => {
			expect(() =>
				assertMandateAllows({ mandate, amountAtomics: '2000000', network: 'eip155:8453' }),
			).toThrow(/per-call/);
		});

		it('blocks a disallowed network', () => {
			expect(() =>
				assertMandateAllows({ mandate, amountAtomics: '1000000', network: 'eip155:137' }),
			).toThrow(/network/);
		});

		it('blocks a resource outside the allowlist', () => {
			expect(() =>
				assertMandateAllows({
					mandate,
					amountAtomics: '1000000',
					network: 'eip155:8453',
					resource: 'https://other.example/skill',
				}),
			).toThrow(/does not authorize paying/);
		});

		it('blocks a currency mismatch', () => {
			expect(() =>
				assertMandateAllows({
					mandate,
					amountAtomics: '1000000',
					network: 'eip155:8453',
					currency: 'DAI',
				}),
			).toThrow(/authorizes USDC/);
		});

		it('blocks an expired mandate', () => {
			expect(() =>
				assertMandateAllows({
					mandate,
					amountAtomics: '1000000',
					network: 'eip155:8453',
					nowSec: mandate.expiresAt + 1,
				}),
			).toThrow(/expired/);
		});
	});
});

// ── Spend ledger ────────────────────────────────────────────────────────────

describe('Spend ledger', () => {
	beforeEach(() => _resetMemoryStore());

	it('reserves within the cap and accumulates spend', async () => {
		const r1 = await reserve('m-1', 1_000_000, 3_000_000, 3600);
		expect(r1).toMatchObject({ ok: true, spent: 1_000_000, cap: 3_000_000 });
		const r2 = await reserve('m-1', 1_000_000, 3_000_000, 3600);
		expect(r2.ok).toBe(true);
		expect(r2.spent).toBe(2_000_000);
		expect(await spent('m-1')).toBe(2_000_000);
	});

	it('refuses a reservation that would exceed the cap and reserves nothing', async () => {
		await reserve('m-2', 2_000_000, 3_000_000, 3600);
		const r = await reserve('m-2', 2_000_000, 3_000_000, 3600);
		expect(r.ok).toBe(false);
		expect(r.spent).toBe(2_000_000); // unchanged
		expect(await spent('m-2')).toBe(2_000_000);
	});

	it('releases a reservation and floors at zero', async () => {
		await reserve('m-3', 1_000_000, 3_000_000, 3600);
		expect(await release('m-3', 1_000_000)).toBe(0);
		expect(await release('m-3', 1_000_000)).toBe(0); // double release stays at 0
	});

	it('rejects unsafe amounts', async () => {
		await expect(reserve('m-4', -1, 10, 60)).rejects.toThrow();
		await expect(reserve('m-4', Number.MAX_SAFE_INTEGER + 2, 10, 60)).rejects.toThrow();
	});
});

// ── Reputation gate ─────────────────────────────────────────────────────────

describe('Reputation gate', () => {
	it('is a no-op when no threshold is set', async () => {
		const read = vi.fn();
		const out = await assertReputationOk({ agentId: '1', chainId: 8453, read });
		expect(out).toBeNull();
		expect(read).not.toHaveBeenCalled();
	});

	it('passes when the peer clears the bar', async () => {
		const read = vi.fn(async () => ({ average: 4.5, count: 12 }));
		const out = await assertReputationOk({ agentId: '1', chainId: 8453, minAverage: 4, minCount: 5, read });
		expect(out).toEqual({ average: 4.5, count: 12 });
	});

	it('fails when average is too low', async () => {
		const read = vi.fn(async () => ({ average: 2.0, count: 50 }));
		await expect(
			assertReputationOk({ agentId: '1', chainId: 8453, minAverage: 4, read }),
		).rejects.toMatchObject({ code: 'reputation_too_low' });
	});

	it('fails when there are too few reviews', async () => {
		const read = vi.fn(async () => ({ average: 5, count: 1 }));
		await expect(
			assertReputationOk({ agentId: '1', chainId: 8453, minCount: 5, read }),
		).rejects.toMatchObject({ code: 'reputation_too_few_reviews' });
	});

	it('requires an agentId when a threshold is set', async () => {
		await expect(assertReputationOk({ chainId: 8453, minAverage: 4 })).rejects.toMatchObject({
			code: 'reputation_required',
		});
	});

	it('fails closed when the reader throws', async () => {
		const read = vi.fn(async () => {
			throw new Error('rpc down');
		});
		await expect(
			assertReputationOk({ agentId: '1', chainId: 8453, minAverage: 4, read }),
		).rejects.toBeInstanceOf(ReputationError);
	});
});

// ── /api/agents/a2a-call endpoint ───────────────────────────────────────────

const authState = { session: null, bearer: null };
const rlState = { success: true };
const clientState = {
	quote: null,
	submit: null,
};

vi.mock('../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => authState.session),
	authenticateBearer: vi.fn(async () => authState.bearer),
	extractBearer: vi.fn(() => null),
}));

vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: {
		mcpAgentPay: vi.fn(async () => ({ success: rlState.success })),
		mcpAgent: vi.fn(async () => ({ success: rlState.success })),
	},
	clientIp: vi.fn(() => '127.0.0.1'),
}));

vi.mock('../api/_lib/ssrf-guard.js', () => ({
	SsrfBlockedError: class SsrfBlockedError extends Error {},
	assertSafePublicUrl: vi.fn(async (u) => new URL(u)),
}));

// The handler re-resolves the mandate's subject agent from the DB (gate 4a) and
// runs the payment through the agent's own custody policy (gate 4c). Both are
// covered in depth by tests/a2a-payment-hardening.test.js; here they are stubbed
// so these tests stay focused on mandate policy, budget ledger, and settlement.
vi.mock('../api/_lib/db.js', () => ({
	sql: vi.fn(async () => [{ id: 'agent-1', user_id: 'user-1', meta: {} }]),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
	isStoragePressured: () => false,
}));
vi.mock('../api/_lib/avatar-wallet.js', () => ({ solUsdPrice: vi.fn(async () => 200) }));
vi.mock('../api/_lib/audit.js', () => ({ logAudit: vi.fn() }));
vi.mock('../api/_lib/anomaly-events.js', () => ({
	guardOutboundAnomaly: vi.fn(async () => ({ decision: 'allow', verdict: null, anomalyId: null, froze: false })),
}));
vi.mock('../api/_lib/agent-trade-guards.js', async (importOriginal) => {
	const actual = await importOriginal();
	return {
		...actual,
		getSpendLimits: vi.fn(() => ({ frozen: false })),
		reserveSpendUsd: vi.fn(async () => ({ reservationId: 7001, dailySpentUsd: 0 })),
		releaseSpendReservation: vi.fn(async () => {}),
		updateCustodyEvent: vi.fn(async () => {}),
	};
});

vi.mock('../api/_lib/x402/a2a-client.js', () => ({
	A2AClientError: class A2AClientError extends Error {
		constructor(code, message, details) {
			super(message);
			this.code = code;
			this.details = details;
		}
	},
	requestQuote: vi.fn(async () => clientState.quote),
	submitPayment: vi.fn(async () => clientState.submit),
	buildEvmExactPayload: vi.fn(async () => ({ scheme: 'exact', payload: {} })),
	createPrivateKeySigner: vi.fn(async () => ({ address: '0xPayer', signAuthorization: vi.fn() })),
	buildSolanaExactPayload: vi.fn(async () => ({ scheme: 'exact', payload: { transaction: 'base64tx' } })),
	createSolanaSigner: vi.fn(async () => ({ address: 'SoLPayer1111111111111111111111111111111111' })),
	NETWORK_SOLANA_MAINNET: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
	NETWORK_SOLANA_DEVNET: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
	isSolanaNetwork: (network) =>
		network === 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' ||
		network === 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1' ||
		network === 'solana',
}));

const { invoke } = await import('./_helpers/monetization.js');
const { default: a2aCallHandler } = await import('../api/agents/a2a-call.js');

function quoteWith(amount) {
	return {
		taskId: 'task-1',
		required: {
			resource: { url: 'https://peer.example/skill', mimeType: 'application/json' },
			accepts: [
				{
					scheme: 'exact',
					network: 'eip155:8453',
					amount,
					payTo: '0xPeer',
					asset: '0xUSDC',
					extra: { name: 'USD Coin', version: '2', decimals: 6 },
				},
			],
		},
	};
}

const completed = {
	state: 'completed',
	receipts: [{ success: true, transaction: '0xtx', network: 'eip155:8453' }],
	task: { artifacts: [{ artifactId: 'a1', name: 'report.json', parts: [] }] },
};

async function freshMandate(overrides = {}) {
	const { jws } = await issueIntentMandate({
		ownerUserId: 'user-1',
		subjectAgentId: 'agent-1',
		maxAtomics: '10000000',
		perCallAtomics: '1000000',
		networks: ['eip155:8453'],
		ttlSec: 3600,
		...overrides,
	});
	return jws;
}

describe('POST /api/agents/a2a-call', () => {
	beforeEach(() => {
		authState.session = null;
		authState.bearer = null;
		rlState.success = true;
		clientState.quote = quoteWith('1000000');
		clientState.submit = completed;
		process.env.A2A_PAYER_PRIVATE_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
		_resetMemoryStore();
	});

	it('returns 401 when unauthenticated', async () => {
		const { status, body } = await invoke(a2aCallHandler, {
			method: 'POST',
			url: '/api/agents/a2a-call',
			body: { endpoint: 'https://peer.example/skill', mandate: await freshMandate() },
		});
		expect(status).toBe(401);
		expect(body.error).toBe('unauthorized');
	});

	it('rejects a mandate issued to a different user', async () => {
		authState.session = { id: 'user-1' };
		const otherMandate = await freshMandate({ ownerUserId: 'user-2' });
		const { status, body } = await invoke(a2aCallHandler, {
			method: 'POST',
			url: '/api/agents/a2a-call',
			body: { endpoint: 'https://peer.example/skill', mandate: otherMandate },
		});
		expect(status).toBe(403);
		expect(body.error).toBe('mandate_not_yours');
	});

	it('pays a peer end-to-end under a valid mandate', async () => {
		authState.session = { id: 'user-1' };
		const { status, body } = await invoke(a2aCallHandler, {
			method: 'POST',
			url: '/api/agents/a2a-call',
			body: { endpoint: 'https://peer.example/skill', mandate: await freshMandate(), text: 'inspect' },
		});
		expect(status).toBe(200);
		expect(body.ok).toBe(true);
		expect(body.amount).toBe('1000000');
		expect(body.network).toBe('eip155:8453');
		expect(body.receipts[0].transaction).toBe('0xtx');
		expect(body.artifacts).toHaveLength(1);
		expect(body.spent).toBe(1_000_000);
	});

	it('blocks a payment over the per-call cap', async () => {
		authState.session = { id: 'user-1' };
		clientState.quote = quoteWith('5000000'); // $5 > $1 per-call cap
		const { status, body } = await invoke(a2aCallHandler, {
			method: 'POST',
			url: '/api/agents/a2a-call',
			body: { endpoint: 'https://peer.example/skill', mandate: await freshMandate() },
		});
		expect(status).toBe(402);
		expect(body.error).toBe('amount_over_per_call');
	});

	it('enforces the total budget across calls', async () => {
		authState.session = { id: 'user-1' };
		// Budget == per-call == $1, so the first call exhausts it.
		const mandate = await freshMandate({ maxAtomics: '1000000', perCallAtomics: '1000000' });
		const first = await invoke(a2aCallHandler, {
			method: 'POST',
			url: '/api/agents/a2a-call',
			body: { endpoint: 'https://peer.example/skill', mandate },
		});
		expect(first.status).toBe(200);
		const second = await invoke(a2aCallHandler, {
			method: 'POST',
			url: '/api/agents/a2a-call',
			body: { endpoint: 'https://peer.example/skill', mandate },
		});
		expect(second.status).toBe(402);
		expect(second.body.error).toBe('budget_exceeded');
	});

	it('returns 501 when the payer wallet is not configured', async () => {
		authState.session = { id: 'user-1' };
		delete process.env.A2A_PAYER_PRIVATE_KEY;
		const { status, body } = await invoke(a2aCallHandler, {
			method: 'POST',
			url: '/api/agents/a2a-call',
			body: { endpoint: 'https://peer.example/skill', mandate: await freshMandate() },
		});
		expect(status).toBe(501);
		expect(body.error).toBe('payer_not_configured');
	});

	it('releases the budget reservation when settlement fails', async () => {
		authState.session = { id: 'user-1' };
		clientState.submit = { state: 'failed', receipts: [{ success: false, errorReason: 'insufficient funds' }] };
		const mandate = await freshMandate();
		const failed = await invoke(a2aCallHandler, {
			method: 'POST',
			url: '/api/agents/a2a-call',
			body: { endpoint: 'https://peer.example/skill', mandate },
		});
		expect(failed.status).toBe(502);
		expect(failed.body.error).toBe('payment_failed');

		// The failed reservation must have been released, so a retry that settles
		// succeeds rather than hitting a phantom budget ceiling.
		clientState.submit = completed;
		const retry = await invoke(a2aCallHandler, {
			method: 'POST',
			url: '/api/agents/a2a-call',
			body: { endpoint: 'https://peer.example/skill', mandate },
		});
		expect(retry.status).toBe(200);
		expect(retry.body.spent).toBe(1_000_000);
	});

	it('returns 429 when rate limited', async () => {
		authState.session = { id: 'user-1' };
		rlState.success = false;
		const { status, body } = await invoke(a2aCallHandler, {
			method: 'POST',
			url: '/api/agents/a2a-call',
			body: { endpoint: 'https://peer.example/skill', mandate: await freshMandate() },
		});
		expect(status).toBe(429);
		expect(body.error).toBe('rate_limited');
	});
});
