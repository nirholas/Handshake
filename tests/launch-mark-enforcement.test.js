// Integration tests: three.ws brand-mark enforcement in launch handlers.
//
// Proves at the API layer:
//   1. launch-prep, no mint supplied  → server grinds a 3ws mint
//   2. launch-prep, unmarked mint     → 400 unbranded_mint
//   3. launch-prep, marked mint       → 201, echoes that mint
//   4. THREE_WS_MARK_ENFORCE=0        → legacy path (no mark required)
//   5. launch-agent, no mint supplied → server grinds a 3ws mint
//   6. launch-agent, unmarked pair    → 400 unbranded_mint
//   7. launch-agent, cross-site POST  → 403, before any keypair or chain work
//   8. launch-agent, no session       → 401
//
// All network / Solana RPC calls are mocked. The vanity grinder is also mocked
// so tests are deterministic and fast (the real grind is covered by
// tests/three-ws-mark.test.js).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Readable } from 'node:stream';
import { hasThreeWsMark } from '../src/solana/vanity/brand.js';

// ── Auth ─────────────────────────────────────────────────────────────────────
const authState = { session: null, sameSite: true };
vi.mock('../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => authState.session),
	authenticateBearer: vi.fn(async () => null),
	extractBearer: vi.fn(() => null),
	isSameSiteOrigin: vi.fn(() => authState.sameSite),
}));

// ── SQL ──────────────────────────────────────────────────────────────────────
const sqlState = { queue: [], calls: [] };
vi.mock('../api/_lib/db.js', () => ({
	sql: vi.fn(async (strings, ...values) => {
		sqlState.calls.push({ query: strings.join('?'), values });
		if (sqlState.queue.length === 0) return [];
		return sqlState.queue.shift();
	}),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

// ── Rate limit ────────────────────────────────────────────────────────────────
vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: { authIp: vi.fn(async () => ({ success: true })) },
	clientIp: vi.fn(() => '127.0.0.1'),
}));

// ── Crypto ────────────────────────────────────────────────────────────────────
vi.mock('../api/_lib/crypto.js', () => ({
	randomToken: vi.fn(async (n) => 'a'.repeat((n || 16) * 2)),
}));

// ── Vanity grinder — fast deterministic stand-in ──────────────────────────────
// Returns a fixed 3ws-branded result; the real grind is tested in three-ws-mark.test.js.
// Convention: secretKey[0] === 0x09 means "branded grind result".
vi.mock('../src/solana/vanity/grinder-node.js', () => ({
	grindVanityNode: vi.fn(() => ({
		publicKey: '3wsGroundMint1111111111111111111111',
		secretKey: new Uint8Array(64).fill(0x09),
		attempts: 49_000,
		durationMs: 15,
	})),
	GrindExhaustedError: class GrindExhaustedError extends Error {
		constructor() {
			super('grind budget exhausted');
			this.name = 'GrindExhaustedError';
			this.code = 'grind_exhausted';
			this.status = 504;
		}
	},
}));

// ── @solana/web3.js — controlled Keypair + fake tx classes ────────────────────
// Keypair.fromSecretKey convention:
//   sk[0] === 0x09  →  '3wsGroundMint…'    (branded; matches grind mock above)
//   sk[0] === 0xAA  →  'SomeBadMint…'      (unbranded; used in bad-pair tests)
vi.mock('@solana/web3.js', async (importOriginal) => {
	const actual = await importOriginal();
	return {
		...actual,
		Keypair: {
			fromSecretKey: vi.fn((sk) => {
				const m = sk?.[0];
				const pub =
					m === 0x09
						? '3wsGroundMint1111111111111111111111'
						: m === 0xAA
						? 'SomeBadMint1111111111111111111111111'
						: 'UnknownMint111111111111111111111111';
				return {
					publicKey: { toBase58: () => pub, toString: () => pub },
					secretKey: sk || new Uint8Array(64),
				};
			}),
			generate: vi.fn(() => ({
				publicKey: {
					toBase58: () => 'RandomMint1111111111111111111111111',
					toString: () => 'RandomMint1111111111111111111111111',
				},
				secretKey: new Uint8Array(64).fill(0x05),
			})),
		},
		// Fake transaction classes — only needed for the launch-agent path
		TransactionMessage: class {
			constructor() {}
			compileToV0Message() { return {}; }
		},
		VersionedTransaction: class {
			constructor() {}
			sign() {}
			serialize() { return new Uint8Array(8); }
		},
	};
});

// The launch-agent path now sends via submitProtected (real signing + serialize),
// which is incompatible with the fake VersionedTransaction above (no real
// signatures). These tests verify the GROUND MINT carries the 3ws mark
// (response.mint), not the send mechanism, so mock the protected sender.
vi.mock('../api/_lib/execution-engine.js', () => ({
	submitProtected: vi.fn(async () => ({ signature: 'a'.repeat(88), slot: 1, route: 'protected' })),
}));

// ── pump.js SDK ───────────────────────────────────────────────────────────────
vi.mock('../api/_lib/pump.js', () => ({
	getConnection: vi.fn(() => ({})),
	solanaPubkey: vi.fn((s) => (s ? { toBase58: () => s, toString: () => s } : null)),
	getPumpSdk: vi.fn(async () => ({
		sdk: {
			fetchGlobal: async () => ({}),
			createV2Instruction: async () => ({ keys: [], data: Buffer.alloc(0) }),
			createV2AndBuyInstructions: async () => [{ keys: [], data: Buffer.alloc(0) }],
		},
		BN: function MockBN(v) { this.v = v; this.toString = () => String(v); },
		web3: { LAMPORTS_PER_SOL: 1_000_000_000 },
	})),
	getPumpAgentOffline: vi.fn(async () => ({
		offline: { create: vi.fn(async () => ({ keys: [], data: Buffer.alloc(0) })) },
		BN: function MockBN(v) { return { v, toString: () => String(v) }; },
		web3: {},
		agentPda: { toString: () => 'AgentPda' },
	})),
	buildUnsignedTxBase64: vi.fn(async () => 'BASE64TX'),
	verifySignature: vi.fn(async () => ({})),
}));

// ── @pump-fun/pump-sdk — prevent >45s cold-load on constrained hosts ──────────
// `buildLaunchInstructions` calls `await import('@pump-fun/pump-sdk')` on every
// launch path. On Codespace / CI the first ESM parse takes >45s and kills the
// test before the handler even reaches buildUnsignedTxBase64.
// We only need `isLegacyQuoteMint` on the SOL-paired, no-buy path exercised
// here; the rest are stubs to satisfy any future call-sites in the module.
vi.mock('@pump-fun/pump-sdk', () => ({
	isLegacyQuoteMint: () => true,             // treat all quotes as legacy SOL
	getBuyTokenAmountFromSolAmount: () => 0n,  // unused when solBuyIn === 0
	PUMP_SDK: {},
	OnlinePumpSdk: class {},
	feeSharingConfigPda: () => ({ toString: () => 'FeeSharingPda' }),
	socialFeePda: () => ({ toString: () => 'SocialFeePda' }),
	bondingCurvePda: () => ({ toString: () => 'BondingCurvePda' }),
	FEE_PROGRAM_GLOBAL_PDA: 'FeeGlobalPda',
}));

// ── agent-pumpfun — Solana connection + keypair loader ────────────────────────
const agentPumpfunState = { connection: null, loadResult: null, loadCalls: 0 };
vi.mock('../api/_lib/agent-pumpfun.js', () => ({
	solanaConnection: vi.fn(() => agentPumpfunState.connection),
	loadAgentForSigning: vi.fn(async () => {
		agentPumpfunState.loadCalls++;
		return agentPumpfunState.loadResult;
	}),
}));

// ── Request/response helpers (mirror tests/api/pump.test.js) ─────────────────
function makeReq({ method = 'GET', url = '/', headers = {}, body = null } = {}) {
	const base = body ? Readable.from([Buffer.from(JSON.stringify(body))]) : Readable.from([]);
	base.method = method;
	base.url = url;
	base.headers = {
		host: 'localhost',
		...(body ? { 'content-type': 'application/json' } : {}),
		...headers,
	};
	return base;
}
function makeRes() {
	return {
		statusCode: 200, headers: {}, body: '', writableEnded: false,
		setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
		end(chunk) { if (chunk !== undefined) this.body += chunk; this.writableEnded = true; },
	};
}
async function invoke(handler, opts) {
	const req = makeReq(opts);
	const res = makeRes();
	await handler(req, res);
	return { res, json: res.body ? JSON.parse(res.body) : null };
}

// Every /api/pump/<action> path is rewritten onto the consolidated dispatcher
// (api/pump/[action].js), which routes on req.query.action the way the
// filesystem router populates it. Binding one action here keeps each test
// naming its endpoint while running exactly the code production serves.
function pumpAction(action) {
	return async (req, res) => {
		req.query = { ...(req.query ?? {}), action };
		const { default: dispatcher } = await import('../api/pump/[action].js');
		return dispatcher(req, res);
	};
}

function resetAll() {
	authState.session = null;
	authState.sameSite = true;
	sqlState.queue = [];
	sqlState.calls = [];
	agentPumpfunState.connection = null;
	agentPumpfunState.loadResult = null;
	agentPumpfunState.loadCalls = 0;
}

// ── Shared fixtures ───────────────────────────────────────────────────────────
const walletB58 = 'WalletPubkey111111111111111111111111111';
const agentUUID = '00000000-0000-0000-0000-000000000001';
const basePrepBody = {
	agent_id: agentUUID,
	wallet_address: walletB58,
	name: 'MarkTest',
	symbol: 'MTEST',
	uri: 'https://three.ws/meta.json',
	network: 'devnet',
	buyback_bps: 0,
};
const baseAgentBody = {
	agent_id: agentUUID,
	name: 'MarkTest',
	symbol: 'MTEST',
	uri: 'https://three.ws/meta.json',
	network: 'devnet',
	buyback_bps: 0,
};

// ── launch-prep ───────────────────────────────────────────────────────────────

describe('POST /api/pump/launch-prep — brand-mark enforcement', () => {
	beforeEach(resetAll);

	it('no mint supplied → server grinds and returns a 3ws mint', async () => {
		authState.session = { id: 'user-1' };
		sqlState.queue = [
			[{ id: 'wallet-1' }],              // user_wallets
			[{ id: 'agent-1', name: 'Foo' }],  // agent_identities
			[],                                 // insert agent_registrations_pending
		];

		const { res, json } = await invoke(pumpAction('launch-prep'), {
			method: 'POST', url: '/api/pump/launch-prep',
			body: basePrepBody,
		});

		expect(res.statusCode).toBe(201);
		expect(json.mint).toBeDefined();
		expect(hasThreeWsMark(json.mint)).toBe(true);
	});

	it('unmarked mint supplied → 400 with error === "unbranded_mint"', async () => {
		authState.session = { id: 'user-1' };
		sqlState.queue = [
			[{ id: 'wallet-1' }],
			[{ id: 'agent-1', name: 'Foo' }],
		];

		const { res, json } = await invoke(pumpAction('launch-prep'), {
			method: 'POST', url: '/api/pump/launch-prep',
			body: { ...basePrepBody, mint_address: 'BadMintNoMark111111111111111111111' },
		});

		expect(res.statusCode).toBe(400);
		expect(json.error).toBe('unbranded_mint');
	});

	it('marked mint supplied → 201, echoes the client mint, no server secret', async () => {
		authState.session = { id: 'user-1' };
		sqlState.queue = [
			[{ id: 'wallet-1' }],
			[{ id: 'agent-1', name: 'Foo' }],
			[],
		];

		const clientMint = '3wsVanityMintFromClient111111111111';
		const { res, json } = await invoke(pumpAction('launch-prep'), {
			method: 'POST', url: '/api/pump/launch-prep',
			body: { ...basePrepBody, mint_address: clientMint },
		});

		expect(res.statusCode).toBe(201);
		expect(json.mint).toBe(clientMint);
		expect(json.mint_secret_key_b64).toBeNull();
		expect(json.client_supplied_mint).toBe(true);
		expect(hasThreeWsMark(json.mint)).toBe(true);
	});

	it('THREE_WS_MARK_ENFORCE=0 → legacy path (Keypair.generate), still 201', async () => {
		const saved = process.env.THREE_WS_MARK_ENFORCE;
		process.env.THREE_WS_MARK_ENFORCE = '0';
		try {
			authState.session = { id: 'user-1' };
			sqlState.queue = [
				[{ id: 'wallet-1' }],
				[{ id: 'agent-1', name: 'Foo' }],
				[],
			];

			const { res, json } = await invoke(pumpAction('launch-prep'), {
				method: 'POST', url: '/api/pump/launch-prep',
				body: basePrepBody,
			});

			expect(res.statusCode).toBe(201);
			// Keypair.generate() mock returns 'RandomMint…' — not branded.
			// Enforcement is off so this is the expected legacy result.
			expect(json.mint).toBeDefined();
			expect(hasThreeWsMark(json.mint)).toBe(false);
		} finally {
			if (saved === undefined) delete process.env.THREE_WS_MARK_ENFORCE;
			else process.env.THREE_WS_MARK_ENFORCE = saved;
		}
	});
});

// ── launch-agent ──────────────────────────────────────────────────────────────

describe('POST /api/pump/launch-agent — brand-mark enforcement', () => {
	beforeEach(() => {
		resetAll();

		// Funded mock Solana connection (sufficient for ~0.022 SOL launch cost)
		agentPumpfunState.connection = {
			getBalance: async () => 1_000_000_000,
			getLatestBlockhash: async () => ({ blockhash: 'testblockhash111111111111111111111', lastValidBlockHeight: 1000 }),
			// submitProtected estimates a priority fee + CU (simulate) before sending.
			simulateTransaction: async () => ({ value: { err: null, unitsConsumed: 50_000, logs: [] } }),
			getRecentPrioritizationFees: async () => [{ prioritizationFee: 1000 }],
			sendRawTransaction: async () => 'a'.repeat(88),
			confirmTransaction: async () => ({ value: { err: null }, context: { slot: 1 } }),
			getSignatureStatuses: vi.fn(async () => ({ value: [{ err: null, confirmationStatus: 'confirmed', slot: 1 }], context: { slot: 1 } })),
			getBlockHeight: vi.fn(async () => 1),
		};

		// Agent custodial keypair returned by the loadAgentForSigning mock
		agentPumpfunState.loadResult = {
			keypair: {
				publicKey: {
					toBase58: () => 'AgentPubkey1111111111111111111111111',
					toString: () => 'AgentPubkey1111111111111111111111111',
				},
				secretKey: new Uint8Array(64).fill(0x03),
			},
			agent: { id: 'agent-1', name: 'TestAgent', user_id: 'user-1' },
			meta: {},
		};
	});

	it('no mint supplied → server grinds a 3ws mint, response.mint passes hasThreeWsMark', async () => {
		authState.session = { id: 'user-1' };
		sqlState.queue = [
			[{ id: 'agent-1', name: 'Foo' }],  // resolveLaunchAgentId
			[],                                  // conflict check (empty = no existing mint)
			// insert pump_agent_mints → returning the registered row
			[{ id: 'row-1', mint: '3wsGroundMint1111111111111111111111', network: 'devnet', buyback_bps: 0, created_at: '2026-01-01T00:00:00Z' }],
			// agent_actions insert has .catch → empty queue returns [] safely
		];

		const { res, json } = await invoke(pumpAction('launch-agent'), {
			method: 'POST', url: '/api/pump/launch-agent',
			body: baseAgentBody,
		});

		expect(res.statusCode).toBe(201);
		expect(json.ok).toBe(true);
		expect(json.mint).toBeDefined();
		expect(hasThreeWsMark(json.mint)).toBe(true);
		// DB row mint also carries the mark
		expect(hasThreeWsMark(json.pump_agent_mint?.mint ?? json.mint)).toBe(true);
	});

	it('unmarked mint+secret supplied → 400 unbranded_mint', async () => {
		authState.session = { id: 'user-1' };
		sqlState.queue = [
			[{ id: 'agent-1', name: 'Foo' }],  // resolveLaunchAgentId
		];

		// Secret key starting with 0xAA → fromSecretKey mock maps pubkey to 'SomeBadMint…'
		const badSk = Buffer.alloc(64, 0xaa);
		const badMint = 'SomeBadMint1111111111111111111111111';

		const { res, json } = await invoke(pumpAction('launch-agent'), {
			method: 'POST', url: '/api/pump/launch-agent',
			body: {
				...baseAgentBody,
				mint_address: badMint,
				mint_secret_key_b64: badSk.toString('base64'),
			},
		});

		expect(res.statusCode).toBe(400);
		expect(json.error).toBe('unbranded_mint');
	});

	// launch-agent signs and broadcasts with the agent's CUSTODIAL keypair: the
	// caller supplies no signature, so a session cookie alone was enough to mint a
	// coin and spend the agent's SOL from any origin. The cookie path must prove
	// same-site intent before it reaches any of that.
	it('403s a cross-site POST before it touches the agent keypair or the chain', async () => {
		authState.session = { id: 'user-1' };
		authState.sameSite = false;
		sqlState.queue = [[{ id: 'agent-1', name: 'Foo' }]];

		const { res, json } = await invoke(pumpAction('launch-agent'), {
			method: 'POST', url: '/api/pump/launch-agent',
			body: baseAgentBody,
		});

		expect(res.statusCode).toBe(403);
		expect(json.error).toBe('forbidden');
		// Nothing was resolved, loaded, or queried on the caller's behalf.
		expect(sqlState.calls).toHaveLength(0);
		expect(agentPumpfunState.loadCalls).toBe(0);
	});

	it('still 401s an unauthenticated POST', async () => {
		authState.session = null;
		const { res, json } = await invoke(pumpAction('launch-agent'), {
			method: 'POST', url: '/api/pump/launch-agent',
			body: baseAgentBody,
		});
		expect(res.statusCode).toBe(401);
		expect(json.error).toBe('unauthorized');
	});
});
