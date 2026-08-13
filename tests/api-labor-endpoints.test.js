// HTTP-boundary tests for the Agent Labor Market write endpoints
// (api/labor/{award,deliver,settle,release,post}.js).
//
// tests/api-labor-lifecycle.test.js covers the settlement engine and
// tests/agent-labor-economics.test.js covers the pure math. What is covered
// HERE is the layer neither of those sees: what an endpoint does with an
// untrusted request body before it reaches Postgres or a wallet.
//
//   1. Every id these handlers hand to Postgres keys a uuid column. Award,
//      deliver, settle, release and post skipped the uuid guard their siblings
//      already used, so `{"jobId":"zzz"}` reached the driver and came back as
//      SQLSTATE 22P02: an opaque 500 on the read paths, and on the ownership
//      paths a 400 that echoed the raw Postgres message to the caller.
//   2. post.js parsed the reward with toBig()/threeToAtomics(), which throw a
//      SyntaxError on junk (500) or silently coerce it to zero (a "reward must
//      be greater than zero" answer for a value that was never a number), and
//      passed `deadline` straight into a timestamptz column.
//   3. deliver.js clamped an object deliverable's `output` to 8000 chars and
//      then spread the caller's original back over the clamp, so the cap did
//      nothing and any payload size reached the verifier prompt.

import { Readable } from 'node:stream';
import { describe, it, expect, beforeEach, vi } from 'vitest';

const OWNER = 'owner-1';
const STRANGER = 'owner-2';
const BOUNTY_ID = '11111111-1111-4111-8111-111111111111';
const BID_ID = '22222222-2222-4222-8222-222222222222';
const JOB_ID = '33333333-3333-4333-8333-333333333333';
const AGENT_ID = '44444444-4444-4444-8444-444444444444';
const WORKER_ID = '55555555-5555-4555-8555-555555555555';
const WALLET = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';

const authState = { session: { id: OWNER } };
const sqlState = { queue: [], calls: [] };
const laborState = {};
const escrowState = {};

vi.mock('../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => authState.session),
	authenticateBearer: vi.fn(async () => null),
	extractBearer: vi.fn(() => null),
}));
vi.mock('../api/_lib/csrf.js', () => ({ requireCsrf: vi.fn(async () => true) }));
vi.mock('../api/_lib/db.js', () => ({
	sql: vi.fn(async (...args) => {
		sqlState.calls.push(args);
		return sqlState.queue.length ? sqlState.queue.shift() : [];
	}),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));
vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: {
		laborPost: vi.fn(async () => ({ success: true })),
		laborBid: vi.fn(async () => ({ success: true })),
	},
	clientIp: vi.fn(() => '127.0.0.1'),
}));
vi.mock('../api/_lib/admin.js', () => ({
	requireAdmin: vi.fn(async () => ({ id: 'admin-1', wallet_address: WALLET })),
	isAdminRequest: vi.fn(async () => true),
}));

// agent-labor: real pure math (the parsers under test), spies for every DB leaf.
vi.mock('../api/_lib/agent-labor.js', async () => {
	const econ = await import('../api/_lib/labor-economics.js');
	return {
		atomicsToThree: econ.atomicsToThree,
		threeToAtomics: econ.threeToAtomics,
		parseAtomics: econ.parseAtomics,
		parseThree: econ.parseThree,
		_toBig: econ.toBig,
		getBounty: vi.fn(async () => laborState.bounty ?? null),
		getBid: vi.fn(async () => laborState.bid ?? null),
		listBidsForBounty: vi.fn(async () => laborState.bids ?? []),
		getJob: vi.fn(async () => laborState.job ?? null),
		getJobByBounty: vi.fn(async () => laborState.job ?? null),
		markJobDelivered: vi.fn(async (_id, deliverable) => {
			laborState.delivered = deliverable;
			return { ...laborState.job, status: 'delivered', deliverable };
		}),
		createBounty: vi.fn(async (input) => {
			laborState.created = input;
			return { id: BOUNTY_ID, ...input };
		}),
		setBountyEscrow: vi.fn(async () => ({ id: BOUNTY_ID })),
		setBountyStatus: vi.fn(async () => ({ id: BOUNTY_ID })),
	};
});
vi.mock('../api/_lib/labor-match.js', () => ({
	applyAward: vi.fn(async () => ({ job: { id: JOB_ID, status: 'working' } })),
	emitReasoning: vi.fn(async () => {}),
}));
vi.mock('../api/_lib/labor-settle.js', () => ({
	runAutopilot: vi.fn(async () => ({ bids: 0, awarded: true, settled: null, settledNow: false })),
	runSettlement: vi.fn(async () => ({ settled: true, status: 'settled' })),
}));
vi.mock('../api/_lib/labor-escrow.js', () => ({
	escrowConfigured: vi.fn(() => true),
	escrowAddressOrNull: vi.fn(() => 'ESCROWADDR'),
	fundEscrow: vi.fn(async () => 'FUNDSIG'),
	payFromEscrow: vi.fn(async () => 'PAYSIG'),
	ensureEscrowGas: vi.fn(async () => ({ topped: false })),
}));
vi.mock('../api/_lib/token/price.js', () => ({ getTokenPriceUsd: vi.fn(async () => ({ priceUsd: 0.01 })) }));
vi.mock('../api/_lib/agent-wallet.js', () => ({
	recoverSolanaAgentKeypair: vi.fn(async () => ({ publicKey: { toBase58: () => WALLET } })),
}));
vi.mock('../api/_lib/agent-trade-guards.js', () => ({
	SpendLimitError: class SpendLimitError extends Error {},
	reserveSpendUsd: vi.fn(async () => ({ reservationId: 'res-1' })),
	releaseSpendReservation: vi.fn(async () => {}),
	updateCustodyEvent: vi.fn(async () => {}),
}));

const award = (await import('../api/labor/award.js')).default;
const deliver = (await import('../api/labor/deliver.js')).default;
const settle = (await import('../api/labor/settle.js')).default;
const release = (await import('../api/labor/release.js')).default;
const post = (await import('../api/labor/post.js')).default;

function makeRes() {
	return {
		statusCode: 200,
		headers: {},
		body: '',
		writableEnded: false,
		setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
		end(chunk) { if (chunk !== undefined) this.body += chunk; this.writableEnded = true; },
	};
}

async function call(handler, path, body, method = 'POST') {
	const raw = body === undefined ? null : JSON.stringify(body);
	const req = Readable.from(raw == null ? [] : [Buffer.from(raw)]);
	req.method = method;
	req.url = path;
	req.headers = { host: 'localhost', ...(raw == null ? {} : { 'content-type': 'application/json' }) };
	const res = makeRes();
	await handler(req, res);
	return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

/** The agent row loadOwnedAgent reads, owned by `userId`. */
function primeAgent(userId = OWNER) {
	sqlState.queue.push([{
		id: AGENT_ID, user_id: userId, name: 'Poster',
		meta: { solana_address: WALLET, encrypted_solana_secret: 'enc' },
	}]);
}

beforeEach(() => {
	authState.session = { id: OWNER };
	sqlState.queue = [];
	sqlState.calls = [];
	for (const k of Object.keys(laborState)) delete laborState[k];
	for (const k of Object.keys(escrowState)) delete escrowState[k];
});

describe('labor endpoints: uuid boundary', () => {
	it('award refuses a malformed bountyId with 400 before any query', async () => {
		const { status, body } = await call(award, '/api/labor/award', { bountyId: 'zzz', bidId: BID_ID });
		expect(status).toBe(400);
		expect(body.error).toBe('validation_error');
		expect(body.error_description).toBe('bountyId must be a uuid');
		expect(sqlState.calls).toHaveLength(0);
	});

	it('award refuses a malformed bidId with 400', async () => {
		const { status, body } = await call(award, '/api/labor/award', { bountyId: BOUNTY_ID, bidId: 'nope' });
		expect(status).toBe(400);
		expect(body.error_description).toBe('bidId must be a uuid');
	});

	it('deliver refuses a malformed jobId with 400', async () => {
		const { status, body } = await call(deliver, '/api/labor/deliver', { jobId: 'zzz', deliverable: 'done' });
		expect(status).toBe(400);
		expect(body.error_description).toBe('jobId must be a uuid');
	});

	it('settle names the missing input instead of reporting a missing job', async () => {
		const { status, body } = await call(settle, '/api/labor/settle', {});
		expect(status).toBe(400);
		expect(body.error_description).toBe('jobId or bountyId is required');
	});

	it('settle refuses a malformed bountyId with 400', async () => {
		const { status, body } = await call(settle, '/api/labor/settle', { bountyId: 'zzz' });
		expect(status).toBe(400);
		expect(body.error_description).toBe('bountyId must be a uuid');
	});

	it('release refuses a malformed bountyId with 400', async () => {
		const { status, body } = await call(release, '/api/labor/release', { bountyId: 'zzz', action: 'refund' });
		expect(status).toBe(400);
		expect(body.error_description).toBe('bountyId must be a uuid');
	});

	it('post refuses a malformed posterAgentId with 400', async () => {
		const { status, body } = await call(post, '/api/labor/post', {
			posterAgentId: 'zzz', title: 'Title', spec: 'Spec', rewardThree: 1,
		});
		expect(status).toBe(400);
		expect(body.error_description).toBe('posterAgentId must be a uuid');
	});
});

describe('labor endpoints: ownership', () => {
	it('award answers 403 when the caller does not own the posting agent', async () => {
		laborState.bounty = { id: BOUNTY_ID, poster_agent_id: AGENT_ID, status: 'open' };
		primeAgent(STRANGER);
		const { status, body } = await call(award, '/api/labor/award', { bountyId: BOUNTY_ID, bidId: BID_ID });
		expect(status).toBe(403);
		expect(body.error).toBe('forbidden');
	});

	it('deliver rethrows an infrastructure fault instead of echoing it as a 400', async () => {
		laborState.job = { id: JOB_ID, worker_agent_id: WORKER_ID, status: 'working', bounty_id: BOUNTY_ID };
		const db = await import('../api/_lib/db.js');
		db.sql.mockImplementationOnce(async () => { throw new Error('connection terminated unexpectedly'); });
		const { status, body } = await call(deliver, '/api/labor/deliver', { jobId: JOB_ID, deliverable: 'done' });
		expect(status).toBe(500);
		expect(body.error_description).not.toContain('connection terminated');
	});

	it('award drives the autopilot and reports the job on the happy path', async () => {
		laborState.bounty = { id: BOUNTY_ID, poster_agent_id: AGENT_ID, status: 'open' };
		laborState.bid = { id: BID_ID, bounty_id: BOUNTY_ID, status: 'pending', worker_user_id: OWNER, price_atomics: '1000000' };
		laborState.bids = [{ id: BID_ID, worker_agent_id: WORKER_ID, worker_name: 'Worker', price_three: 1, score: 0.8 }];
		laborState.job = { id: JOB_ID, status: 'working' };
		primeAgent(OWNER);
		const { status, body } = await call(award, '/api/labor/award', { bountyId: BOUNTY_ID, bidId: BID_ID });
		expect(status).toBe(200);
		expect(body.award.job_id).toBe(JOB_ID);
		expect(body.award.rationale).not.toMatch(/[\u2013\u2014]/);
	});
});

describe('labor/deliver: deliverable clamping', () => {
	beforeEach(() => {
		laborState.job = { id: JOB_ID, worker_agent_id: AGENT_ID, status: 'working', bounty_id: BOUNTY_ID };
		laborState.bounty = { id: BOUNTY_ID, spec: 'Spec' };
	});

	it('clamps an object deliverable to 8000 chars and keeps its other keys', async () => {
		primeAgent(OWNER);
		const { status } = await call(deliver, '/api/labor/deliver', {
			jobId: JOB_ID,
			deliverable: { output: 'x'.repeat(20000), format: 'markdown' },
		});
		expect(status).toBe(200);
		expect(laborState.delivered.output).toHaveLength(8000);
		expect(laborState.delivered.format).toBe('markdown');
		expect(laborState.delivered.produced_at).toBeTruthy();
	});

	it('clamps a string deliverable the same way', async () => {
		primeAgent(OWNER);
		const { status } = await call(deliver, '/api/labor/deliver', { jobId: JOB_ID, deliverable: 'y'.repeat(9000) });
		expect(status).toBe(200);
		expect(laborState.delivered.output).toHaveLength(8000);
	});

	it('refuses an array deliverable rather than spreading its indexes', async () => {
		primeAgent(OWNER);
		const { status, body } = await call(deliver, '/api/labor/deliver', { jobId: JOB_ID, deliverable: ['a', 'b'] });
		expect(status).toBe(400);
		expect(body.error).toBe('validation_error');
	});
});

describe('labor/post: reward and deadline parsing', () => {
	const base = { posterAgentId: AGENT_ID, title: 'Ship the thing', spec: 'Do the work' };

	it('answers 400 for an unparseable rewardAtomics instead of throwing a 500', async () => {
		const { status, body } = await call(post, '/api/labor/post', { ...base, rewardAtomics: 'abc' });
		expect(status).toBe(400);
		expect(body.error_description).toBe('reward must be a non-negative amount of $THREE');
	});

	it('distinguishes a missing reward from a zero one', async () => {
		const { status, body } = await call(post, '/api/labor/post', base);
		expect(status).toBe(400);
		expect(body.error_description).toBe('rewardThree or rewardAtomics is required');
	});

	it('refuses a reward of zero', async () => {
		const { status, body } = await call(post, '/api/labor/post', { ...base, rewardThree: 0 });
		expect(status).toBe(400);
		expect(body.error_description).toBe('reward must be greater than zero');
	});

	it('refuses an unparseable deadline before writing the bounty row', async () => {
		const { status, body } = await call(post, '/api/labor/post', { ...base, rewardThree: 5, deadline: 'next tuesday-ish' });
		expect(status).toBe(400);
		expect(body.error_description).toBe('deadline must be an ISO 8601 timestamp');
	});

	it('normalizes a valid deadline to ISO 8601 and escrows the parsed reward', async () => {
		primeAgent(OWNER);
		sqlState.queue.push([{ id: BOUNTY_ID, title: base.title, status: 'open', reward_atomics: '5000000', bid_count: 0 }]);
		const { status, body } = await call(post, '/api/labor/post', {
			...base, rewardThree: 5, deadline: '2026-09-01T12:00:00Z',
		});
		expect(status).toBe(200);
		expect(body.ok).toBe(true);
		expect(laborState.created.deadline).toBe('2026-09-01T12:00:00.000Z');
		expect(String(laborState.created.rewardAtomics)).toBe('5000000');
	});
});
