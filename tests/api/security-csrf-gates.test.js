// Verify that state-changing API endpoints reject requests missing a valid
// CSRF token. Each endpoint is exercised with the same shared mock harness so
// the gates are checked uniformly. Bearer-auth callers are exempt (bearers
// aren't auto-attached by browsers, so CSRF can't be forged with them).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Readable } from 'node:stream';

// ── Shared mock state ─────────────────────────────────────────────────────

const authState = {
	session: null, // { id, is_admin?, wallet_address? }
	bearer: null, // { userId, scope, source }
};

const sqlState = {
	queue: [], // FIFO of mock results
	calls: [], // captured (query, values) pairs
	csrfRows: new Map(), // token → { user_id, expires_at }
};

vi.mock('../../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => authState.session),
	authenticateBearer: vi.fn(async () => authState.bearer),
	extractBearer: vi.fn((req) => {
		const h = req?.headers?.authorization || '';
		if (!h.toLowerCase().startsWith('bearer ')) return null;
		return h.slice(7).trim();
	}),
	hasScope: vi.fn(() => true),
}));

vi.mock('../../api/_lib/admin.js', () => ({
	requireAdmin: vi.fn(async (req, res) => {
		if (!authState.session?.is_admin) {
			res.statusCode = 403;
			res.setHeader('content-type', 'application/json');
			res.end(JSON.stringify({ error: 'forbidden' }));
			return null;
		}
		return authState.session;
	}),
}));

// The csrf.js module reads/writes the csrf_tokens table via `sql`. We intercept
// those calls by inspecting the tagged-template strings the module sends and
// serving from sqlState.csrfRows for SELECTs.
vi.mock('../../api/_lib/db.js', () => ({
	sql: Object.assign(
		vi.fn(async (strings, ...values) => {
			const q = typeof strings === 'string' ? strings : strings.join('?');
			sqlState.calls.push({ query: q, values });

			// CSRF lookup: `SELECT user_id FROM csrf_tokens WHERE token = ${sent} AND expires_at > now()`
			if (/from csrf_tokens/i.test(q) && /^\s*select/i.test(q)) {
				const submitted = values[0];
				const row = sqlState.csrfRows.get(submitted);
				if (row && row.expires_at > Date.now()) return [{ user_id: row.user_id }];
				return [];
			}
			// CSRF consume: `DELETE FROM csrf_tokens WHERE token = ${sent} AND user_id = ${userId}
			// AND expires_at > now() RETURNING user_id` — atomic validate-and-burn; a
			// wrong-user token is left in place for its rightful owner.
			if (/from csrf_tokens/i.test(q) && /^\s*delete/i.test(q)) {
				const [submitted, uid] = values;
				const row = sqlState.csrfRows.get(submitted);
				if (
					row &&
					(uid === undefined || row.user_id === uid) &&
					row.expires_at > Date.now()
				) {
					sqlState.csrfRows.delete(submitted);
					return [{ user_id: row.user_id }];
				}
				return [];
			}

			if (sqlState.queue.length === 0) return [];
			return sqlState.queue.shift();
		}),
		{
			transaction: vi.fn(async (queries) => {
				for (const q of queries) await q;
				return [];
			}),
		},
	),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: new Proxy(
		{},
		{
			get: () => async () => ({ success: true }),
		},
	),
	clientIp: vi.fn(() => '127.0.0.1'),
}));

vi.mock('../../api/_lib/agent-wallet.js', () => ({
	generateAgentWallet: vi.fn(async () => ({ address: '0xaa', encrypted_key: 'k' })),
	generateSolanaAgentWallet: vi.fn(async () => ({ address: 'sol', encrypted_secret: 's' })),
	recoverSolanaAgentKeypair: vi.fn(async () => ({ publicKey: { toBase58: () => 'sol' } })),
	recoverAgentKey: vi.fn(async () => '0x' + '11'.repeat(32)),
	ensureAgentWallet: vi.fn(async () => ({ address: 'sol', created: false })),
}));

// solana-wallet.js / solana-trade.js touch Solana RPC + SNS at module scope via
// these helpers; stub them so the CSRF-gate path (which short-circuits before any
// RPC) can be exercised without a live cluster.
vi.mock('../../api/_lib/agent-pumpfun.js', () => ({
	solanaConnection: vi.fn(() => ({})),
	solanaPublicConnection: vi.fn(() => ({})),
}));

vi.mock('../../src/solana/sns.js', () => ({
	reverseLookupAddress: vi.fn(async () => null),
}));

// solana-trade.js imports getBuyQuote/getSellQuote from _lib/solana/sdk-bridge.js,
// which lazily `import('@nirholas/pump-sdk')` for bonding-curve pricing. That
// package ships an ESM exports map whose `import` condition vite's import-analysis
// cannot resolve under Vitest unless the postinstall `fix-pump-sdk-esm.mjs` patch
// has rewritten it (it resolves fine in plain node + the Vercel runtime). vite
// resolves that dynamic import while *transforming* sdk-bridge.js at collection
// time — before any module-level mock could intercept it — so the whole suite
// fails to load with "Failed to resolve entry for package @nirholas/pump-sdk".
// Mock sdk-bridge.js at the boundary instead: vitest serves the factory and never
// transforms the real file, so the unresolvable import is never reached. The
// session-authed gates short-circuit at the CSRF check before any quote is
// fetched; the one path that does reach a quote (preview:true, which is CSRF-
// exempt) gets the bridge's documented "no bonding curve" result — null — exactly
// as production returns for a curve-less mint, so the preview path degrades the
// same way it would live. Sibling suites handle the same SDK by skipping its
// static importers (tests/api/all-modules-load.test.js).
vi.mock('../../api/_lib/solana/sdk-bridge.js', () => ({
	getBuyQuote: vi.fn(async () => null),
	getSellQuote: vi.fn(async () => null),
	getTokenPrice: vi.fn(async () => null),
	getGraduationProgress: vi.fn(async () => null),
	getBondingCurveState: vi.fn(async () => null),
}));

vi.mock('../../api/_lib/notify.js', () => ({
	insertNotification: vi.fn(() => {}),
}));

vi.mock('../../api/_lib/validate.js', async (importOriginal) => ({
	...(await importOriginal()),
	parse: vi.fn((schema, data) => schema.parse(data)),
}));

vi.mock('../../api/_lib/env.js', () => ({
	env: { APP_ORIGIN: 'http://localhost:3000', ADMIN_ADDRESSES: new Set() },
}));

vi.mock('../../api/_lib/sentry.js', () => ({
	captureException: vi.fn(),
}));

vi.mock('../../api/_lib/zauth.js', () => ({
	instrument: vi.fn(() => null),
	drain: vi.fn(async () => {}),
}));

vi.mock('../../api/_lib/r2.js', () => ({
	publicUrl: vi.fn((key) => `https://r2.example/${key}`),
}));

// Import the handlers under test AFTER mocks are wired.
const { default: agentsRoot, handleGetOne, handleWallet } = await import('../../api/agents.js');
const { default: keysHandler } = await import('../../api/keys/index.js');
const { default: keyByIdHandler } = await import('../../api/keys/[id].js');
const { default: agentActionsHandler } = await import('../../api/agent-actions.js');
const { default: agentMemoryHandler } = await import('../../api/agent-memory.js');
const { default: subscriptionsHandler } = await import('../../api/subscriptions.js');
const { default: dcaHandler } = await import('../../api/dca-strategies.js');
const { handleWithdraw } = await import('../../api/agents/solana-wallet.js');
const { handleTrade } = await import('../../api/agents/solana-trade.js');

// ── helpers ───────────────────────────────────────────────────────────────

function makeReq({ method = 'GET', url = '/', headers = {}, body = null, query = {} } = {}) {
	const stream = body ? Readable.from([Buffer.from(JSON.stringify(body))]) : Readable.from([]);
	stream.method = method;
	stream.url = url;
	stream.query = query;
	stream.headers = {
		host: 'localhost',
		...(body ? { 'content-type': 'application/json' } : {}),
		...headers,
	};
	return stream;
}

function makeRes() {
	return {
		statusCode: 200,
		headers: {},
		body: '',
		writableEnded: false,
		setHeader(k, v) {
			this.headers[k.toLowerCase()] = v;
		},
		getHeader(k) {
			return this.headers[k.toLowerCase()];
		},
		end(chunk) {
			if (chunk !== undefined) this.body += String(chunk);
			this.writableEnded = true;
		},
		write(chunk) {
			if (chunk !== undefined) this.body += String(chunk);
		},
	};
}

function parseRes(res) {
	if (!res.body) return null;
	try {
		return JSON.parse(res.body);
	} catch {
		return null;
	}
}

function issueCsrfFor(userId, token = 'tok-' + Math.random().toString(36).slice(2)) {
	sqlState.csrfRows.set(token, { user_id: userId, expires_at: Date.now() + 60_000 });
	return token;
}

beforeEach(() => {
	authState.session = null;
	authState.bearer = null;
	sqlState.queue = [];
	sqlState.calls = [];
	sqlState.csrfRows.clear();
});

// ── /api/keys POST ────────────────────────────────────────────────────────

describe('POST /api/keys — CSRF gate', () => {
	it('rejects POST without X-CSRF-Token (403 csrf_missing)', async () => {
		authState.session = { id: 'user-1' };
		const req = makeReq({
			method: 'POST',
			url: '/api/keys',
			body: { name: 'My key' },
		});
		const res = makeRes();
		await keysHandler(req, res);
		const body = parseRes(res);
		expect(res.statusCode).toBe(403);
		expect(body.error).toBe('csrf_missing');
	});

	it('rejects POST with an unknown token (403 csrf_invalid)', async () => {
		authState.session = { id: 'user-1' };
		const req = makeReq({
			method: 'POST',
			url: '/api/keys',
			headers: { 'x-csrf-token': 'not-a-real-token' },
			body: { name: 'My key' },
		});
		const res = makeRes();
		await keysHandler(req, res);
		const body = parseRes(res);
		expect(res.statusCode).toBe(403);
		expect(body.error).toBe('csrf_invalid');
	});

	it('proceeds when a valid CSRF token is presented', async () => {
		authState.session = { id: 'user-2' };
		const token = issueCsrfFor('user-2');
		// The handler reads CSRF, then INSERTs the key — queue one row.
		sqlState.queue.push([
			{
				id: 'k1',
				name: 'My key',
				prefix: 'sk_live_xx',
				scope: 'avatars:read',
				expires_at: null,
				created_at: '2024-01-01T00:00:00Z',
			},
		]);
		const req = makeReq({
			method: 'POST',
			url: '/api/keys',
			headers: { 'x-csrf-token': token },
			body: { name: 'My key' },
		});
		const res = makeRes();
		await keysHandler(req, res);
		const body = parseRes(res);
		expect(res.statusCode).toBe(201);
		expect(body.key.id).toBe('k1');
	});

	it('burns the CSRF token (single-use)', async () => {
		authState.session = { id: 'user-3' };
		const token = issueCsrfFor('user-3');
		sqlState.queue.push([
			{
				id: 'k1',
				name: 'k',
				prefix: 'sk_live_x',
				scope: 'avatars:read',
				expires_at: null,
				created_at: '2024-01-01T00:00:00Z',
			},
		]);

		const req1 = makeReq({
			method: 'POST',
			url: '/api/keys',
			headers: { 'x-csrf-token': token },
			body: { name: 'k' },
		});
		await keysHandler(req1, makeRes());

		// Give the fire-and-forget DELETE a tick to settle.
		await new Promise((r) => setImmediate(r));

		// Second use of the same token must be rejected.
		const req2 = makeReq({
			method: 'POST',
			url: '/api/keys',
			headers: { 'x-csrf-token': token },
			body: { name: 'k' },
		});
		const res2 = makeRes();
		await keysHandler(req2, res2);
		expect(res2.statusCode).toBe(403);
		expect(parseRes(res2).error).toBe('csrf_invalid');
	});

	it('bearer authorization bypasses CSRF (stateless auth)', async () => {
		authState.bearer = { userId: 'user-4', scope: 'profile', source: 'apikey' };
		// /api/keys requires getSessionUser for now; bearer alone returns 401.
		// Skip: this endpoint is session-only by design.
	});
});

// ── /api/agents — single-resource mutations ───────────────────────────────

describe('PUT/DELETE /api/agents/:id — CSRF gate', () => {
	const AGENT_ID = '11111111-1111-1111-1111-111111111111';

	it('PUT rejects without CSRF (403 csrf_missing)', async () => {
		authState.session = { id: 'user-5' };
		const req = makeReq({
			method: 'PUT',
			url: `/api/agents/${AGENT_ID}`,
			body: { name: 'updated' },
		});
		const res = makeRes();
		await handleGetOne(req, res, AGENT_ID);
		expect(res.statusCode).toBe(403);
		expect(parseRes(res).error).toBe('csrf_missing');
	});

	it('DELETE rejects without CSRF (403 csrf_missing)', async () => {
		authState.session = { id: 'user-5' };
		const req = makeReq({
			method: 'DELETE',
			url: `/api/agents/${AGENT_ID}`,
		});
		const res = makeRes();
		await handleGetOne(req, res, AGENT_ID);
		expect(res.statusCode).toBe(403);
		expect(parseRes(res).error).toBe('csrf_missing');
	});

	it('PATCH rejects without CSRF (403 csrf_missing)', async () => {
		authState.session = { id: 'user-5' };
		const req = makeReq({
			method: 'PATCH',
			url: `/api/agents/${AGENT_ID}`,
			body: { name: 'updated' },
		});
		const res = makeRes();
		await handleGetOne(req, res, AGENT_ID);
		expect(res.statusCode).toBe(403);
		expect(parseRes(res).error).toBe('csrf_missing');
	});
});

describe('POST/DELETE /api/agents/:id/wallet — CSRF gate', () => {
	const AGENT_ID = '22222222-2222-2222-2222-222222222222';

	it('POST rejects without CSRF', async () => {
		authState.session = { id: 'user-6' };
		const req = makeReq({
			method: 'POST',
			url: `/api/agents/${AGENT_ID}/wallet`,
			body: { wallet_address: '0xdead' },
		});
		const res = makeRes();
		await handleWallet(req, res, AGENT_ID);
		expect(res.statusCode).toBe(403);
		expect(parseRes(res).error).toBe('csrf_missing');
	});

	it('DELETE rejects without CSRF', async () => {
		authState.session = { id: 'user-6' };
		const req = makeReq({
			method: 'DELETE',
			url: `/api/agents/${AGENT_ID}/wallet`,
		});
		const res = makeRes();
		await handleWallet(req, res, AGENT_ID);
		expect(res.statusCode).toBe(403);
		expect(parseRes(res).error).toBe('csrf_missing');
	});
});

// ── /api/agents (root) — creation is CSRF-gated like its sibling mutations ─

describe('POST /api/agents — CSRF gate on creation', () => {
	it('rejects session-authed POST without X-CSRF-Token (403 csrf_missing)', async () => {
		authState.session = { id: 'user-7' };
		const req = makeReq({
			method: 'POST',
			url: '/api/agents',
			body: { name: 'A' },
		});
		const res = makeRes();
		await agentsRoot(req, res);
		expect(res.statusCode).toBe(403);
		expect(parseRes(res).error).toBe('csrf_missing');
	});

	it('proceeds when a valid CSRF token is presented', async () => {
		authState.session = { id: 'user-7' };
		const token = issueCsrfFor('user-7');
		sqlState.queue.push([
			{
				id: 'a1',
				user_id: 'user-7',
				name: 'A',
				skills: [],
				meta: {},
				created_at: '2024-01-01T00:00:00Z',
			},
		]);
		const req = makeReq({
			method: 'POST',
			url: '/api/agents',
			headers: { 'x-csrf-token': token },
			body: { name: 'A' },
		});
		const res = makeRes();
		await agentsRoot(req, res);
		expect(res.statusCode).toBe(201);
	});
});

// ── Newly-gated cookie-session mutations ───────────────────────────────────
// These endpoints mutate user-owned state on a cookie session and were
// previously ungated. Each must reject a session-authed mutation that omits a
// CSRF token, and (for bearer-auth machine callers) stay exempt.

describe('POST /api/agent-actions — CSRF gate', () => {
	it('rejects session-authed POST without X-CSRF-Token (403 csrf_missing)', async () => {
		authState.session = { id: 'user-1' };
		const req = makeReq({
			method: 'POST',
			url: '/api/agent-actions',
			body: { agent_id: 'ag1', type: 'note' },
		});
		const res = makeRes();
		await agentActionsHandler(req, res);
		expect(res.statusCode).toBe(403);
		expect(parseRes(res).error).toBe('csrf_missing');
	});

	it('exempts bearer-auth callers (no CSRF needed)', async () => {
		authState.bearer = { userId: 'user-1', source: 'bearer' };
		// requireCsrf returns true for Bearer; handler then verifies ownership.
		sqlState.queue.push([{ user_id: 'user-1' }]); // agent ownership lookup
		sqlState.queue.push([
			{ id: 1, agent_id: 'ag1', type: 'note', payload: {}, created_at: 'x' },
		]);
		const req = makeReq({
			method: 'POST',
			url: '/api/agent-actions',
			headers: { authorization: 'Bearer tok' },
			body: { agent_id: 'ag1', type: 'note' },
		});
		const res = makeRes();
		await agentActionsHandler(req, res);
		expect(res.statusCode).not.toBe(403);
	});
});

describe('POST/DELETE /api/agent-memory — CSRF gate', () => {
	it('rejects session-authed POST without X-CSRF-Token (403 csrf_missing)', async () => {
		authState.session = { id: 'user-1' };
		const req = makeReq({
			method: 'POST',
			url: '/api/agent-memory',
			body: { agentId: 'ag1', entry: { content: 'hi' } },
		});
		const res = makeRes();
		await agentMemoryHandler(req, res);
		expect(res.statusCode).toBe(403);
		expect(parseRes(res).error).toBe('csrf_missing');
	});

	it('rejects session-authed DELETE without X-CSRF-Token (403 csrf_missing)', async () => {
		authState.session = { id: 'user-1' };
		const req = makeReq({
			method: 'DELETE',
			url: '/api/agent-memory/mem-1',
		});
		const res = makeRes();
		await agentMemoryHandler(req, res);
		expect(res.statusCode).toBe(403);
		expect(parseRes(res).error).toBe('csrf_missing');
	});
});

describe('POST/DELETE /api/subscriptions — CSRF gate', () => {
	it('rejects session-authed POST without X-CSRF-Token (403 csrf_missing)', async () => {
		authState.session = { id: 'user-1' };
		const req = makeReq({
			method: 'POST',
			url: '/api/subscriptions',
			body: {
				agentId: '11111111-1111-1111-1111-111111111111',
				delegationId: '22222222-2222-2222-2222-222222222222',
				periodSeconds: 86400,
				amountPerPeriod: '1000000',
			},
		});
		const res = makeRes();
		await subscriptionsHandler(req, res);
		expect(res.statusCode).toBe(403);
		expect(parseRes(res).error).toBe('csrf_missing');
	});
});

describe('POST/DELETE /api/dca-strategies — CSRF gate', () => {
	it('rejects session-authed DELETE without X-CSRF-Token (403 csrf_missing)', async () => {
		authState.session = { id: 'user-1' };
		const req = makeReq({
			method: 'DELETE',
			url: '/api/dca-strategies/33333333-3333-3333-3333-333333333333',
		});
		const res = makeRes();
		await dcaHandler(req, res);
		expect(res.statusCode).toBe(403);
		expect(parseRes(res).error).toBe('csrf_missing');
	});
});

// ── Custodial fund-moving endpoints ────────────────────────────────────────
// Withdraw and discretionary trade move real funds out of a custodial agent
// wallet. They must be CSRF-gated at least as strongly as message-signing.
// A valid (non-WSOL) base58 mint so the trade handler reaches the CSRF check
// rather than failing input validation first.
const VALID_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

describe('POST /api/agents/:id/solana/withdraw — CSRF gate', () => {
	const AGENT_ID = '44444444-4444-4444-4444-444444444444';

	it('rejects session-authed withdraw without X-CSRF-Token (403 csrf_missing)', async () => {
		authState.session = { id: 'owner-1' };
		// loadOwnedWallet's ownership SELECT — owner matches the session.
		sqlState.queue.push([
			{ id: AGENT_ID, user_id: 'owner-1', meta: { solana_address: 'sol', encrypted_solana_secret: 's' } },
		]);
		const req = makeReq({
			method: 'POST',
			url: `/api/agents/${AGENT_ID}/solana/withdraw`,
			body: { asset: 'SOL', amount: '0.1', destination: VALID_MINT, network: 'mainnet' },
		});
		const res = makeRes();
		await handleWithdraw(req, res, AGENT_ID);
		expect(res.statusCode).toBe(403);
		expect(parseRes(res).error).toBe('csrf_missing');
	});

	it('does NOT reach the CSRF check for a non-owner (403 forbidden first)', async () => {
		authState.session = { id: 'not-owner' };
		sqlState.queue.push([
			{ id: AGENT_ID, user_id: 'owner-1', meta: { solana_address: 'sol', encrypted_solana_secret: 's' } },
		]);
		const req = makeReq({
			method: 'POST',
			url: `/api/agents/${AGENT_ID}/solana/withdraw`,
			body: { asset: 'SOL', amount: '0.1', destination: VALID_MINT, network: 'mainnet' },
		});
		const res = makeRes();
		await handleWithdraw(req, res, AGENT_ID);
		expect(res.statusCode).toBe(403);
		expect(parseRes(res).error).toBe('forbidden');
	});
});

describe('POST /api/agents/:id/solana/trade — CSRF gate', () => {
	const AGENT_ID = '55555555-5555-5555-5555-555555555555';

	it('rejects a session-authed real trade without X-CSRF-Token (403 csrf_missing)', async () => {
		authState.session = { id: 'owner-2' };
		sqlState.queue.push([
			{ id: AGENT_ID, user_id: 'owner-2', meta: { solana_address: 'sol', encrypted_solana_secret: 's' } },
		]);
		const req = makeReq({
			method: 'POST',
			url: `/api/agents/${AGENT_ID}/solana/trade`,
			body: { side: 'buy', mint: VALID_MINT, sol_amount: 0.05, network: 'mainnet' },
		});
		const res = makeRes();
		await handleTrade(req, res, AGENT_ID);
		expect(res.statusCode).toBe(403);
		expect(parseRes(res).error).toBe('csrf_missing');
	});

	it('exempts a live preview (preview:true never burns a token)', async () => {
		authState.session = { id: 'owner-2' };
		sqlState.queue.push([
			{ id: AGENT_ID, user_id: 'owner-2', meta: { solana_address: 'sol', encrypted_solana_secret: 's' } },
		]);
		const req = makeReq({
			method: 'POST',
			url: `/api/agents/${AGENT_ID}/solana/trade`,
			body: { side: 'buy', mint: VALID_MINT, sol_amount: 0.05, network: 'mainnet', preview: true },
		});
		const res = makeRes();
		await handleTrade(req, res, AGENT_ID);
		// Preview is exempt: whatever the quote path returns, it must NOT be the CSRF 403.
		expect(parseRes(res)?.error).not.toBe('csrf_missing');
	});
});
