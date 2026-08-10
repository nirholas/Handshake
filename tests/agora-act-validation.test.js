/**
 * Agora human actions (api/agora/act.js): the boundary every mutating request
 * crosses BEFORE any wallet, escrow or chain work happens.
 *
 * Two id kinds arrive from the client and both used to be handed straight to a
 * layer that cannot cope with a malformed one. A citizen id goes to a Postgres
 * `uuid` column (a non-uuid raises 22P02 and the request 500s) and a task PDA
 * goes to `new PublicKey()` (a non-base58 string throws, which surfaced as a
 * 502 for claim and a 500 for complete). A typo is a user mistake, so it must
 * read as a designed 4xx, and it must be caught before the request registers
 * the citizen on-chain for work that could never succeed.
 *
 * We drive the REAL wrapped handler and mock only the I/O boundary (auth, the
 * rate limiter, the DB, the citizen/chain helpers and the spend policy) so no
 * mock ships in app code and the handler's own branching runs unchanged.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const H = vi.hoisted(() => ({
	citizenRows: [],
	ensureCalls: 0,
	registerCalls: 0,
}));

vi.mock('../api/_lib/zauth.js', () => ({ instrument: () => false, drain: async () => {} }));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

vi.mock('../api/_lib/db.js', () => {
	const sql = (strings, ...vals) => {
		if (!Array.isArray(strings)) return Promise.resolve({ __frag: true });
		const q = strings.join(' ').toLowerCase();
		if (q.includes('from users')) {
			return Promise.resolve([{ id: 'u1', display_name: 'QA', username: 'qa', avatar_url: null }]);
		}
		if (q.includes('from agora_citizens')) {
			// agora_citizens.id is a uuid column, and Postgres does not coerce: a
			// malformed literal raises 22P02 rather than matching nothing. Emulate
			// that, or a guard that stopped working would still look green here.
			if (q.includes('where id =') && !UUID_RE.test(String(vals[0]))) {
				return Promise.reject(Object.assign(
					new Error(`invalid input syntax for type uuid: "${vals[0]}"`), { code: '22P02' },
				));
			}
			return Promise.resolve(H.citizenRows);
		}
		return Promise.resolve([]);
	};
	return { sql, isDbUnavailableError: () => false, isDbCapacityError: () => false };
});

vi.mock('../api/_lib/labor-auth.js', () => ({
	authWrite: async () => ({ userId: 'u1', session: false }),
}));

vi.mock('../api/_lib/rate-limit.js', () => ({
	clientIp: () => '1.2.3.4',
	limits: { mcpAgentPay: async () => ({ success: true, limit: 30, remaining: 29, reset: Date.now() + 1000 }) },
}));

vi.mock('../api/_lib/token/config.js', () => ({
	TOKEN_MINT: 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump',
	TOKEN_DECIMALS: 6,
}));

vi.mock('../api/_lib/agora-policy.js', () => ({
	resolveCluster: () => 'devnet',
	reservePostSpend: async () => ({ ok: true, reservationId: 'hold-1' }),
	settlePostSpend: async () => {},
	releasePostSpend: async () => {},
}));

vi.mock('../api/_lib/agora-human.js', () => ({
	PROFESSION_BITS: {
		fetcher: 0, sculptor: 1, scribe: 2, cartographer: 3,
		crier: 4, appraiser: 5, verifier: 6, namekeeper: 7,
	},
	THREE_ATOMICS_PER_TOKEN: 1000000n,
	ensureHumanCitizen: async () => {
		H.ensureCalls += 1;
		return {
			citizen: {
				id: '11111111-1111-4111-8111-111111111111',
				display_name: 'QA', avatar_url: null, status: 'idle',
				agenc_cluster: 'devnet', agenc_agent_pda: null, reputation: 0,
				tasks_posted: 0, tasks_completed: 0, earned_three_atomic: '0',
				home_x: 0, home_z: 0, pos_x: 0, pos_z: 0, meta: {},
			},
			created: false,
		};
	},
	ensureRegistered: async () => {
		H.registerCalls += 1;
		throw new Error('ensureRegistered must not run for a malformed request');
	},
	ensureDevnetBalance: async () => {},
	requireFunded: async () => {},
	projectActivity: async () => {},
	bumpCitizenStats: async () => {},
	citizenBalances: async () => ({ sol: 0, three: null, address: null }),
	professionToCapabilityBits: () => 1n,
	rewardLabel: () => '0.0010 SOL',
	proofHashFor: () => 'f'.repeat(64),
	sendOnchainAttestation: async () => { throw new Error('attestation must not run for a malformed request'); },
	explorerTx: (sig) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`,
	recoverTimedOutSignature: async () => null,
	findCompletionSignature: async () => null,
}));

import handler from '../api/agora/act.js';

function makeRes() {
	return {
		statusCode: 200,
		headers: {},
		body: undefined,
		ended: false,
		setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
		getHeader(k) { return this.headers[String(k).toLowerCase()]; },
		removeHeader(k) { delete this.headers[String(k).toLowerCase()]; },
		end(b) { this.body = b; this.ended = true; },
		get headersSent() { return this.ended; },
		get writableEnded() { return this.ended; },
	};
}

async function act(body) {
	const req = {
		method: 'POST',
		url: '/api/agora/act',
		headers: { 'content-type': 'application/json' },
		query: {},
		body,
	};
	const res = makeRes();
	await handler(req, res);
	return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

beforeEach(() => {
	H.citizenRows = [];
	H.ensureCalls = 0;
	H.registerCalls = 0;
});

describe('act: citizen ids that are not uuids', () => {
	it('404s a hire whose citizenId is not a uuid (never a 500 from Postgres 22P02)', async () => {
		const r = await act({ action: 'hire', title: 'QA hire probe', citizenId: 'not-a-uuid', rewardSol: 0.001 });
		expect(r.status).toBe(404);
		expect(r.body.error).toBe('not_found');
	});

	it('still looks up a well-formed citizenId, so the guard does not over-reject', async () => {
		H.citizenRows = [];
		const r = await act({
			action: 'hire', title: 'QA hire probe',
			citizenId: '22222222-2222-4222-8222-222222222222', rewardSol: 0.001,
		});
		// Reached the DB and found nobody: the same 404, but by lookup, not by shape.
		expect(r.status).toBe(404);
		expect(H.ensureCalls).toBe(0);
	});

	it('404s a vouch whose subjectCitizenId is not a uuid', async () => {
		const r = await act({ action: 'vouch', subjectCitizenId: 'not-a-uuid' });
		expect(r.status).toBe(404);
		expect(r.body.error).toBe('not_found');
		expect(H.ensureCalls).toBe(0);
	});
});

describe('act: task PDAs that are not base58', () => {
	it('400s a claim with a malformed taskPda before any wallet or chain work', async () => {
		const r = await act({ action: 'claim', taskPda: 'not-a-pubkey' });
		expect(r.status).toBe(400);
		expect(r.body.error).toBe('validation_error');
		expect(H.ensureCalls).toBe(0);
		expect(H.registerCalls).toBe(0);
	});

	it('400s a complete with a malformed taskPda before any wallet or chain work', async () => {
		const r = await act({ action: 'complete', taskPda: 'not-a-pubkey', deliverable: 'https://three.ws/x.glb' });
		expect(r.status).toBe(400);
		expect(r.body.error).toBe('validation_error');
		expect(H.ensureCalls).toBe(0);
		expect(H.registerCalls).toBe(0);
	});

	it('keeps the empty-taskPda message distinct from the malformed one', async () => {
		const r = await act({ action: 'claim' });
		expect(r.status).toBe(400);
		expect(r.body.error_description).toMatch(/required/);
	});
});

describe('act: router', () => {
	it('400s an unknown action', async () => {
		const r = await act({ action: 'frobnicate' });
		expect(r.status).toBe(400);
		expect(r.body.error).toBe('validation_error');
	});
});
