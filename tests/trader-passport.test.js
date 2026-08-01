/**
 * Trader Passport: credential shaping and on-chain verification.
 *
 * The passport's whole value is that a third party can check it without trusting
 * three.ws, so the tests that matter are the ones that make verification FAIL:
 * a memo that commits a different wallet, a transaction someone else signed, a
 * payload with the wrong kind. Each of those has its own case below.
 *
 * The RPC is stubbed, not mocked-away: `verifyOnChain` is handed real
 * transaction-shaped objects (the same fields @solana/web3.js returns) and must
 * reach its verdict from those alone.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const getTransaction = vi.fn();

vi.mock('../api/_lib/solana/connection.js', () => ({
	solanaConnection: () => ({ getTransaction }),
}));

const {
	validateTradeScorePayload, shapeCredential, scoreDrift, ageInDays,
	verifyOnChain, explorerTx, explorerAddr, PassportError, TRADESCORE_KIND, MEMO_PROGRAM_ID_BASE58,
} = await import('../api/_lib/trader-passport.js');

const SUBJECT  = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const ATTESTER = 'GDfnEsia2WLAW5t8yx2X5j2mkfA74i5kwGdDuZHt7XmG';
const OTHER    = 'HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH';
const SIG      = '5xJ8mDpQ2vN3kRtYwZa1bC4dE6fG7hJ9kL2mN4pQ8rS5tU7vW9xY1zA3bC5dE7fG9hJ2kL4mN6pQ8rS';

/** The payload trader-score-attest.js actually writes. */
function payload(over = {}) {
	return {
		v: 1, kind: TRADESCORE_KIND, agent: SUBJECT, agent_id: 'b0a1c2d3-4e5f-6789-abcd-ef0123456789',
		window: 'all', day: '2026-06-14', network: 'mainnet', ts: 1_781_000_000,
		score: 78, verified: true, closed: 41, win_rate: 0.61, realized_pnl_sol: 12.5,
		max_drawdown_pct: 18.4, unique_coins: 33, snipe_hit_rate: 0.42, snipe_sample: 12,
		self_dealing_excluded: 2, source: 'threews.trader-stats',
	};
}

/** A confirmed-transaction shape carrying `p` as an SPL-Memo log. */
function txWith(p, { signer = ATTESTER, keys = null, err = null, programs = [MEMO_PROGRAM_ID_BASE58] } = {}) {
	const accountKeys = keys || [signer, SUBJECT, MEMO_PROGRAM_ID_BASE58];
	const json = JSON.stringify(p);
	return {
		slot: 300_123_456,
		blockTime: 1_781_000_100,
		meta: {
			err,
			logMessages: [
				'Program MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr invoke [1]',
				`Program log: Memo (len ${json.length}): "${json.replace(/"/g, '\\"')}"`,
			],
		},
		transaction: {
			message: {
				staticAccountKeys: accountKeys.map((k) => ({ toBase58: () => k })),
				compiledInstructions: programs.map((prog) => ({ programIdIndex: accountKeys.indexOf(prog) })),
			},
		},
	};
}

beforeEach(() => { getTransaction.mockReset(); });

describe('validateTradeScorePayload', () => {
	it('accepts the payload the attestor writes', () => {
		expect(validateTradeScorePayload(payload())).toEqual({ ok: true, reasons: [] });
	});

	it.each([
		['a different attestation kind', { kind: 'threews.feedback.v1' }, 'kind is not'],
		['a future payload version', { v: 2 }, 'unsupported payload version'],
		['a non-address subject', { agent: 'not-an-address' }, 'agent is not a Solana address'],
		['an unknown window', { window: '90d' }, 'window is not'],
		['a malformed day', { day: 'June 14' }, 'day is not an ISO calendar date'],
		['a missing score', { score: null }, 'score is not a number'],
		['a negative trade count', { closed: -1 }, 'closed is not a non-negative integer'],
	])('rejects %s', (_label, over, needle) => {
		const out = validateTradeScorePayload(payload(over));
		expect(out.ok).toBe(false);
		expect(out.reasons.join(' | ')).toContain(needle);
	});

	it('rejects a non-object without throwing', () => {
		expect(validateTradeScorePayload(null).ok).toBe(false);
		expect(validateTradeScorePayload('{}').ok).toBe(false);
	});
});

describe('shapeCredential', () => {
	const row = {
		signature: SIG, network: 'mainnet', slot: '300123456',
		block_time: '2026-06-14T09:00:00.000Z', agent_asset: SUBJECT,
		attester: ATTESTER, kind: TRADESCORE_KIND, payload: payload(), verified: true, revoked: false,
	};

	it('exposes the committed snapshot, the issuer and an explorer link', () => {
		const c = shapeCredential(row, 'mainnet');
		expect(c.subject).toBe(SUBJECT);
		expect(c.attester).toBe(ATTESTER);
		expect(c.day).toBe('2026-06-14');
		expect(c.slot).toBe(300123456);
		expect(c.well_formed).toBe(true);
		expect(c.snapshot).toMatchObject({ score: 78, closed: 41, win_rate: 0.61, realized_pnl_sol: 12.5 });
		expect(c.explorer_url).toBe(`https://solscan.io/tx/${SIG}`);
	});

	it('carries the anti-gaming provenance that was committed alongside the score', () => {
		const c = shapeCredential(row, 'mainnet');
		expect(c.snapshot.self_dealing_excluded).toBe(2);
		expect(c.snapshot.snipe_hit_rate).toBe(0.42);
	});

	it('flags a stored row whose payload does not satisfy the schema', () => {
		const c = shapeCredential({ ...row, payload: payload({ window: '90d' }) }, 'mainnet');
		expect(c.well_formed).toBe(false);
		expect(c.schema_problems.join(' ')).toContain('window');
	});

	it('marks revocation and points devnet links at the devnet cluster', () => {
		const c = shapeCredential({ ...row, revoked: true }, 'devnet');
		expect(c.revoked).toBe(true);
		expect(c.explorer_url).toContain('cluster=devnet');
	});

	it('does not invent numbers for fields the payload omitted', () => {
		const c = shapeCredential({ ...row, payload: { ...payload(), win_rate: undefined } }, 'mainnet');
		expect(c.snapshot.win_rate).toBeNull();
	});
});

describe('scoreDrift', () => {
	const snapshot = shapeCredential(
		{ signature: SIG, slot: 1, block_time: null, agent_asset: SUBJECT, attester: ATTESTER, kind: TRADESCORE_KIND, payload: payload(), revoked: false },
		'mainnet',
	).snapshot;

	it('reports every field as unchanged when the live record still matches', () => {
		const d = scoreDrift(
			{ score: 78, closed_count: 41, win_rate: 0.61, realized_pnl_sol: 12.5, max_drawdown_pct: 18.4, unique_coins: 33 },
			snapshot,
		);
		expect(d.moved).toBe(false);
		expect(d.fields.score).toEqual({ attested: 78, live: 78, delta: 0 });
	});

	it('measures how far the live record has moved since signing', () => {
		const d = scoreDrift(
			{ score: 81, closed_count: 44, win_rate: 0.58, realized_pnl_sol: 10.25, max_drawdown_pct: 22, unique_coins: 35 },
			snapshot,
		);
		expect(d.moved).toBe(true);
		expect(d.fields.score.delta).toBe(3);
		expect(d.fields.closed.delta).toBe(3);
		expect(d.fields.realized_pnl_sol.delta).toBeCloseTo(-2.25, 6);
	});

	it('returns a null delta rather than a fabricated zero when a side is missing', () => {
		const d = scoreDrift({ score: 78, closed_count: 41 }, snapshot);
		expect(d.fields.win_rate.delta).toBeNull();
		expect(d.fields.win_rate.live).toBeNull();
	});

	it('is null when there is nothing to compare', () => {
		expect(scoreDrift(null, snapshot)).toBeNull();
		expect(scoreDrift({ score: 1 }, null)).toBeNull();
	});
});

describe('ageInDays', () => {
	const now = Date.parse('2026-06-20T12:00:00.000Z');
	it('counts whole days since the credential was signed', () => {
		expect(ageInDays('2026-06-20T01:00:00.000Z', now)).toBe(0);
		expect(ageInDays('2026-06-14T09:00:00.000Z', now)).toBe(6);
	});
	it('never reports a negative age or throws on junk', () => {
		expect(ageInDays('2026-07-01T00:00:00.000Z', now)).toBe(0);
		expect(ageInDays('not a date', now)).toBeNull();
		expect(ageInDays(null, now)).toBeNull();
	});
});

describe('verifyOnChain', () => {
	it('verifies a well-formed attestation the issuer signed', async () => {
		getTransaction.mockResolvedValue(txWith(payload()));
		const v = await verifyOnChain({ signature: SIG, network: 'mainnet', expectSubject: SUBJECT, expectAttester: ATTESTER });
		expect(v).toMatchObject({ valid: true, found: true, attester: ATTESTER, subject: SUBJECT, slot: 300_123_456 });
		expect(v.reasons).toEqual([]);
		expect(v.payload.score).toBe(78);
		expect(v.block_time).toBe('2026-06-14T09:35:00.000Z');
	});

	it('rejects an attestation signed by someone other than the expected issuer', async () => {
		getTransaction.mockResolvedValue(txWith(payload(), { signer: OTHER }));
		const v = await verifyOnChain({ signature: SIG, network: 'mainnet', expectAttester: ATTESTER });
		expect(v.valid).toBe(false);
		expect(v.reasons.join(' ')).toContain('not the expected issuer');
	});

	it('rejects a memo that commits a wallet other than the one asked about', async () => {
		getTransaction.mockResolvedValue(txWith(payload({ agent: OTHER }), { keys: [ATTESTER, OTHER, MEMO_PROGRAM_ID_BASE58] }));
		const v = await verifyOnChain({ signature: SIG, network: 'mainnet', expectSubject: SUBJECT });
		expect(v.valid).toBe(false);
		expect(v.reasons.join(' ')).toContain('not the requested');
	});

	it('rejects a memo whose subject is not even an account of the transaction', async () => {
		getTransaction.mockResolvedValue(txWith(payload(), { keys: [ATTESTER, OTHER, MEMO_PROGRAM_ID_BASE58] }));
		const v = await verifyOnChain({ signature: SIG, network: 'mainnet' });
		expect(v.valid).toBe(false);
		expect(v.reasons.join(' ')).toContain('not an account of the attestation transaction');
	});

	it('rejects a transaction that carries no memo at all', async () => {
		const tx = txWith(payload());
		tx.meta.logMessages = ['Program 11111111111111111111111111111111 invoke [1]'];
		getTransaction.mockResolvedValue(tx);
		const v = await verifyOnChain({ signature: SIG, network: 'mainnet' });
		expect(v.valid).toBe(false);
		expect(v.reasons.join(' ')).toContain('no SPL-Memo payload');
	});

	it('rejects a memo of a different attestation kind', async () => {
		getTransaction.mockResolvedValue(txWith(payload({ kind: 'threews.feedback.v1' })));
		const v = await verifyOnChain({ signature: SIG, network: 'mainnet' });
		expect(v.valid).toBe(false);
		expect(v.reasons.join(' ')).toContain(TRADESCORE_KIND);
	});

	it('rejects a transaction that failed on-chain', async () => {
		getTransaction.mockResolvedValue(txWith(payload(), { err: { InstructionError: [0, 'Custom'] } }));
		const v = await verifyOnChain({ signature: SIG, network: 'mainnet' });
		expect(v.valid).toBe(false);
		expect(v.reasons).toContain('transaction failed on-chain');
	});

	it('rejects a transaction that never invoked the memo program', async () => {
		getTransaction.mockResolvedValue(txWith(payload(), { programs: [ATTESTER] }));
		const v = await verifyOnChain({ signature: SIG, network: 'mainnet' });
		expect(v.valid).toBe(false);
		expect(v.reasons.join(' ')).toContain('SPL Memo program');
	});

	it('reports a missing transaction as not-found rather than as verified', async () => {
		getTransaction.mockResolvedValue(null);
		const v = await verifyOnChain({ signature: SIG, network: 'mainnet' });
		expect(v).toMatchObject({ valid: false, found: false });
		expect(v.reasons.join(' ')).toContain('not found');
	});

	it('surfaces an RPC failure as an error, never as a negative verdict', async () => {
		getTransaction.mockRejectedValue(new Error('429 Too Many Requests'));
		await expect(verifyOnChain({ signature: SIG, network: 'mainnet' }))
			.rejects.toMatchObject({ code: 'rpc_failed', status: 502 });
	});

	it('refuses input that cannot be a signature or a supported network', async () => {
		await expect(verifyOnChain({ signature: 'nope', network: 'mainnet' }))
			.rejects.toBeInstanceOf(PassportError);
		await expect(verifyOnChain({ signature: SIG, network: 'ethereum' }))
			.rejects.toMatchObject({ code: 'unsupported_network' });
		expect(getTransaction).not.toHaveBeenCalled();
	});
});

describe('explorer links', () => {
	it('points at the right cluster per network', () => {
		expect(explorerTx(SIG, 'mainnet')).toBe(`https://solscan.io/tx/${SIG}`);
		expect(explorerTx(SIG, 'devnet')).toBe(`https://solscan.io/tx/${SIG}?cluster=devnet`);
		expect(explorerAddr(SUBJECT, 'devnet')).toBe(`https://solscan.io/account/${SUBJECT}?cluster=devnet`);
	});
});
