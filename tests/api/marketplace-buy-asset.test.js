// Unit tests for /api/marketplace/buy-asset.
//
// Two guarantees, both about a buyer's money:
//
//   1. Confirm scales the atomic price by the MINT's decimals, not a hardcoded 6.
//      @solana/pay's validateTransfer compares a UI amount, so an asset priced in
//      a 9-decimal mint used to be compared against a figure 1000x too large: the
//      buyer paid exactly right, the check failed, and the purchase was filed as
//      'tipped' instead of granting the asset. The decimals are stamped onto the
//      purchase row at create time so a later price edit cannot re-scale a payment
//      already in flight; a row predating the stamp falls back to the listing.
//
//   2. A malformed item_id is a 400, not a 500. item_id is a uuid column, so bad
//      input reaching Postgres throws 22P02 and surfaces as an internal error.
//
// All I/O (DB, Solana RPC, notifications) is stubbed, so this runs offline with
// no DATABASE_URL and no RPC. Nothing here signs or broadcasts a transaction.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';

// ── Mock layer ──────────────────────────────────────────────────────────────

const authState = { session: { id: 'aaaa0000-0000-0000-0000-000000000001' } };
vi.mock('../../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => authState.session),
	authenticateBearer: vi.fn(async () => null),
	extractBearer: vi.fn(() => null),
}));

// CSRF has its own dedicated suite; isolate handler logic from the token check.
vi.mock('../../api/_lib/csrf.js', () => ({ requireCsrf: async () => true }));

const sqlQueue = [];
const sqlCalls = [];
vi.mock('../../api/_lib/db.js', () => ({
	sql: Object.assign(
		vi.fn(async (strings) => {
			sqlCalls.push(Array.isArray(strings) ? strings.join('?') : String(strings));
			return sqlQueue.length ? sqlQueue.shift() : [];
		}),
		{ transaction: vi.fn(async (fns) => { for (const f of fns) await f; }) },
	),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

const rlState = { success: true };
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		authIp: vi.fn(async () => rlState),
		widgetRead: vi.fn(async () => rlState),
		agentBuy: vi.fn(async () => rlState),
	},
	clientIp: vi.fn(() => '127.0.0.1'),
}));

vi.mock('../../api/_lib/notify.js', () => ({ insertNotification: vi.fn(async () => {}) }));

// The RPC fallback ring hands the callback a connection; there is no real node
// here, so hand it an empty object and let the @solana/pay stubs answer.
vi.mock('../../api/_lib/solana/rpc-fallback.js', () => ({
	rpcFallbackFromEnv: () => ({ withFallback: (fn) => fn({}) }),
}));
vi.mock('../../api/_lib/solana/connection.js', () => ({ solanaConnection: () => ({}) }));
vi.mock('../../api/_lib/solana/gasless-tx.js', () => ({ buildGaslessPurchaseTx: async () => null }));

const validateTransferArgs = [];
vi.mock('@solana/pay', () => ({
	findReference: vi.fn(async () => ({ signature: 'SettlementSignature111' })),
	validateTransfer: vi.fn(async (_conn, _sig, opts) => {
		validateTransferArgs.push(opts);
		return {};
	}),
}));

vi.mock('@solana/web3.js', () => {
	// Fixtures use readable synthetic ids rather than valid 32-byte base58 keys.
	function MockPublicKey(v) {
		this._v = String(v);
		this.toBase58 = () => this._v;
		this.toString = () => this._v;
	}
	return {
		PublicKey: MockPublicKey,
		Keypair: { generate: () => ({ publicKey: new MockPublicKey('GeneratedReference111') }) },
	};
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeReq(method, url, body) {
	const s = body ? Readable.from([Buffer.from(JSON.stringify(body))]) : Readable.from([]);
	s.method = method;
	s.url = url;
	s.headers = { host: 'localhost', 'content-type': 'application/json' };
	return s;
}

function makeRes() {
	return {
		statusCode: 200,
		headers: {},
		body: '',
		writableEnded: false,
		setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
		end(chunk) { if (chunk != null) this.body += chunk; this.writableEnded = true; },
	};
}

async function invoke(req, res) {
	const { default: handler } = await import('../../api/marketplace/buy-asset.js');
	await handler(req, res);
	let json = {};
	try { json = JSON.parse(res.body); } catch { /* non-JSON body is asserted on directly */ }
	return { res, json };
}

const USER_ID = 'aaaa0000-0000-0000-0000-000000000001';
const SELLER_ID = 'bbbb0000-0000-0000-0000-000000000001';
const ITEM_ID = '11111111-2222-3333-4444-555555555555';
const REFERENCE = 'ThreeWsSyntheticReference11111111111111111';
const MINT_9DP = 'THREEsynthetic1111111111111111111111111111A';

// 1.5 tokens of a 9-decimal mint, in atomic units.
const AMOUNT_9DP = '1500000000';

function pendingPurchase(overrides = {}) {
	return {
		id: 'purchase-1',
		buyer_user_id: USER_ID,
		item_type: 'avatar',
		item_id: ITEM_ID,
		seller_user_id: SELLER_ID,
		status: 'pending',
		amount: AMOUNT_9DP,
		currency_mint: MINT_9DP,
		chain: 'solana',
		tx_signature: null,
		expires_at: new Date(Date.now() + 600_000).toISOString(),
		reference: REFERENCE,
		payout_address: 'SellerPayoutWallet1111111111111111111111111',
		referrer_user_id: null,
		metadata: { mint_decimals: 9 },
		...overrides,
	};
}

function confirmReq() {
	return makeReq('POST', `/api/marketplace/buy-asset?reference=${REFERENCE}&op=confirm`, {});
}

beforeEach(() => {
	sqlQueue.length = 0;
	sqlCalls.length = 0;
	validateTransferArgs.length = 0;
	authState.session = { id: USER_ID };
	rlState.success = true;
});

// ── Confirm: decimals ────────────────────────────────────────────────────────

describe('POST /api/marketplace/buy-asset/:reference/confirm', () => {
	it('validates the transfer against the mint decimals stamped on the purchase', async () => {
		sqlQueue.push([pendingPurchase()]);   // load purchase
		sqlQueue.push([{ id: 'purchase-1' }]); // claim (UPDATE ... RETURNING)
		sqlQueue.push([]);                     // receipt insert

		const { res, json } = await invoke(confirmReq(), makeRes());

		expect(res.statusCode).toBe(200);
		expect(json.data.status).toBe('confirmed');
		expect(validateTransferArgs).toHaveLength(1);
		// 1500000000 atoms at 9 decimals is 1.5 tokens, not 1500.
		expect(validateTransferArgs[0].amount.toString()).toBe('1.5');
	});

	it('falls back to the live listing decimals for a row created before the stamp', async () => {
		const legacy = pendingPurchase({ metadata: {} });
		sqlQueue.push([legacy]);               // load purchase
		sqlQueue.push([{ mint_decimals: 9 }]); // asset_prices lookup
		sqlQueue.push([{ id: 'purchase-1' }]); // claim
		sqlQueue.push([]);                     // receipt insert

		const { res } = await invoke(confirmReq(), makeRes());

		expect(res.statusCode).toBe(200);
		expect(validateTransferArgs[0].amount.toString()).toBe('1.5');
	});

	it('falls back to USDC decimals when neither the row nor a listing says otherwise', async () => {
		sqlQueue.push([pendingPurchase({ metadata: {}, amount: '1500000' })]); // load purchase
		sqlQueue.push([]);                     // no asset_prices row (listing withdrawn)
		sqlQueue.push([{ id: 'purchase-1' }]); // claim
		sqlQueue.push([]);                     // receipt insert

		const { res } = await invoke(confirmReq(), makeRes());

		expect(res.statusCode).toBe(200);
		expect(validateTransferArgs[0].amount.toString()).toBe('1.5');
	});

	it('returns 404 for a reference the caller does not own', async () => {
		sqlQueue.push([]); // no matching purchase for this buyer
		const { res, json } = await invoke(confirmReq(), makeRes());
		expect(res.statusCode).toBe(404);
		expect(json.error).toBe('not_found');
	});

	it('rejects a malformed reference with 400 before any lookup', async () => {
		const { res, json } = await invoke(
			makeReq('POST', '/api/marketplace/buy-asset?reference=short&op=confirm', {}),
			makeRes(),
		);
		expect(res.statusCode).toBe(400);
		expect(json.error).toBe('validation_error');
		expect(sqlCalls).toHaveLength(0);
	});
});

// ── Create: input validation ─────────────────────────────────────────────────

describe('POST /api/marketplace/buy-asset', () => {
	it('rejects a non-uuid item_id with 400 instead of letting Postgres throw', async () => {
		const { res, json } = await invoke(
			makeReq('POST', '/api/marketplace/buy-asset', { item_type: 'avatar', item_id: 'not-a-uuid' }),
			makeRes(),
		);
		expect(res.statusCode).toBe(400);
		expect(json.error).toBe('validation_error');
		expect(json.error_description).toMatch(/uuid/);
		expect(sqlCalls).toHaveLength(0);
	});

	it('rejects an unknown item_type with 400', async () => {
		const { res, json } = await invoke(
			makeReq('POST', '/api/marketplace/buy-asset', { item_type: 'spaceship', item_id: ITEM_ID }),
			makeRes(),
		);
		expect(res.statusCode).toBe(400);
		expect(json.error).toBe('validation_error');
	});

	it('requires a signed-in caller', async () => {
		authState.session = null;
		const { res, json } = await invoke(
			makeReq('POST', '/api/marketplace/buy-asset', { item_type: 'avatar', item_id: ITEM_ID }),
			makeRes(),
		);
		expect(res.statusCode).toBe(401);
		expect(json.error).toBe('unauthorized');
	});

	it('stamps the listing decimals onto the pending row it creates', async () => {
		sqlQueue.push([{ amount: AMOUNT_9DP, currency_mint: MINT_9DP, chain: 'solana', mint_decimals: 9, owner_user_id: SELLER_ID }]); // price
		sqlQueue.push([{ user_id: SELLER_ID, name: 'Nova' }]);       // seller for item
		sqlQueue.push([{ address: 'SellerPayoutWallet1111111111111111111111111' }]); // payout
		sqlQueue.push([]);                                            // no confirmed purchase
		sqlQueue.push([]);                                            // no reusable pending row
		sqlQueue.push([]);                                            // referrer lookup (users.referred_by_id)
		sqlQueue.push([{
			reference: REFERENCE, amount: AMOUNT_9DP, currency_mint: MINT_9DP,
			chain: 'solana', expires_at: null, metadata: { mint_decimals: 9 },
		}]);                                                          // insert

		const { res, json } = await invoke(
			makeReq('POST', '/api/marketplace/buy-asset', { item_type: 'avatar', item_id: ITEM_ID }),
			makeRes(),
		);

		expect(res.statusCode).toBe(201);
		expect(json.data.mint_decimals).toBe(9);
		expect(json.data.reference).toBe(REFERENCE);
	});
});

// ── Method + routing surface ─────────────────────────────────────────────────

describe('/api/marketplace/buy-asset method handling', () => {
	it('answers a bare GET with 405', async () => {
		const { res, json } = await invoke(makeReq('GET', '/api/marketplace/buy-asset'), makeRes());
		expect(res.statusCode).toBe(405);
		expect(json.error).toBe('method_not_allowed');
	});

	it('rejects an unknown op with 404', async () => {
		const { res, json } = await invoke(
			makeReq('POST', `/api/marketplace/buy-asset?reference=${REFERENCE}&op=refund`, {}),
			makeRes(),
		);
		expect(res.statusCode).toBe(404);
		expect(json.error).toBe('not_found');
	});
});
