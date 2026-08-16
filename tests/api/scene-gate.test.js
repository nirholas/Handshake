// Tests for the token-gated scene share pair: POST /api/scene/gate-create (the
// creator turning a scene into a holder-only share) and POST /api/scene/gate-check
// (the visitor proving the holding). Together they are the security boundary of a
// gated scene, so what is pinned here is every way the proof can be forged or
// replayed, plus the two failure modes that used to be indistinguishable:
//
//   - a gate stored with a chain/kind pair that can never verify (solana/erc20),
//     which produced a share link that denied everyone forever;
//   - an RPC outage answering the visitor with "insufficient balance", which both
//     lied and leaked the upstream error text to an unauthenticated caller.
//
// The Solana signatures are real ed25519 signatures from a real keypair and the
// EVM ones are real personal_sign signatures from a real ethers wallet, verified
// by the real api/_lib/siws.js and ethers. Only the database rows and the chain
// reads are stubbed: there is no Postgres in a unit test, and hitting mainnet from
// the suite would make it slow and flaky. The stubbed balance is exactly the value
// a real RPC read returns, which is the input the gate decision is defined over.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import bs58 from 'bs58';
import { Wallet, AbiCoder } from 'ethers';

beforeAll(() => {
	process.env.JWT_SECRET = 'test-jwt-secret-scene-gate-0123456789';
	process.env.APP_ORIGIN = 'https://three.ws';
});

const sqlMock = vi.fn();
vi.mock('../../api/_lib/db.js', () => ({
	sql: (...a) => sqlMock(...a),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

const getSessionUserMock = vi.fn();
vi.mock('../../api/_lib/auth.js', () => ({
	getSessionUser: (...a) => getSessionUserMock(...a),
	authenticateBearer: vi.fn(async () => null),
	extractBearer: vi.fn(() => null),
	hasScope: vi.fn(() => true),
}));

vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		authIp: vi.fn(async () => ({ success: true, limit: 30, remaining: 29, reset: 0 })),
		sceneGateCheckIp: vi.fn(async () => ({ success: true, limit: 30, remaining: 29, reset: 0 })),
		sceneGateCheckWallet: vi.fn(async () => ({ success: true, limit: 10, remaining: 9, reset: 0 })),
	},
	clientIp: () => '203.0.113.21',
}));

const splBalanceMock = vi.fn();
vi.mock('../../api/_lib/embed-gate.js', async (importOriginal) => {
	const actual = await importOriginal();
	return { ...actual, getSplTokenBalance: (...a) => splBalanceMock(...a) };
});

const dasRpcUrlMock = vi.fn(() => 'https://mainnet.helius-rpc.com/?api-key=test');
const dasSearchAssetsMock = vi.fn();
vi.mock('../../api/_lib/nft-gate.js', async (importOriginal) => {
	const actual = await importOriginal();
	return {
		...actual,
		dasRpcUrl: (...a) => dasRpcUrlMock(...a),
		dasSearchAssets: (...a) => dasSearchAssetsMock(...a),
	};
});

const evmCallMock = vi.fn();
vi.mock('../../api/_lib/evm/rpc.js', async (importOriginal) => {
	const actual = await importOriginal();
	return { ...actual, evmFallbackProvider: async () => ({ call: (...a) => evmCallMock(...a) }) };
});

const createHandler = (await import('../../api/scene/gate-create.js')).default;
const checkHandler = (await import('../../api/scene/gate-check.js')).default;

// A real keypair: the wallet address IS the public key, so a signature that
// verifies here is one a Solana wallet could have produced.
const SECRET = ed25519.utils.randomSecretKey();
const WALLET = bs58.encode(ed25519.getPublicKey(SECRET));
const OTHER_SECRET = ed25519.utils.randomSecretKey();

const EVM_WALLET = Wallet.createRandom();

const MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
const COLLECTION = 'THREEsynthetic1111111111111111111111111111';
const ERC20 = '0x1111111111111111111111111111111111111111';
const GATE_ID = 'g1h2i3j4k5l6';
const NONCE = 'A1b2C3d4E5f6G7h8';

const solanaGate = { id: GATE_ID, chain: 'solana', kind: 'spl', address: MINT, min_balance: '5000' };

function gateMessage(wallet, nonce = NONCE, gateId = GATE_ID) {
	return [
		'three.ws scene gate verification.',
		'',
		`Gate ID: ${gateId}`,
		`Wallet: ${wallet}`,
		`Nonce: ${nonce}`,
		'Issued At: 2026-08-16T00:00:00.000Z',
	].join('\n');
}

function signSolana(message, secret = SECRET) {
	return bs58.encode(ed25519.sign(new TextEncoder().encode(message), secret));
}

function nonceRow(overrides = {}) {
	return {
		nonce: NONCE,
		gate_id: GATE_ID,
		address: WALLET,
		expires_at: new Date(Date.now() + 60_000).toISOString(),
		consumed_at: null,
		...overrides,
	};
}

/** The two handlers read scene_gates and gate_nonces; both are stubbed by the
 *  statement text so a query the code did not make cannot silently pass. */
function stubDb({ gate = solanaGate, nonce = nonceRow(), burned = [{ nonce: NONCE }] } = {}) {
	sqlMock.mockImplementation((strings) => {
		const text = Array.isArray(strings) ? strings.join(' ') : String(strings);
		if (/insert into scene_gates/i.test(text)) return Promise.resolve([]);
		if (/insert into gate_nonces/i.test(text)) return Promise.resolve([]);
		if (/update gate_nonces/i.test(text)) return Promise.resolve(burned);
		if (/from gate_nonces/i.test(text)) return Promise.resolve(nonce ? [nonce] : []);
		if (/from scene_gates/i.test(text)) return Promise.resolve(gate ? [gate] : []);
		return Promise.resolve([]);
	});
}

function mkRes() {
	return {
		statusCode: 200,
		headers: {},
		body: '',
		setHeader(k, v) {
			this.headers[k.toLowerCase()] = v;
		},
		getHeader(k) {
			return this.headers[k.toLowerCase()];
		},
		end(chunk) {
			if (chunk) this.body += chunk;
		},
	};
}

async function post(handler, url, body) {
	const req = {
		method: 'POST',
		url,
		headers: { 'content-type': 'application/json' },
		rawBody: Buffer.from(JSON.stringify(body)),
		body,
		on(event, cb) {
			if (event === 'data') {
				queueMicrotask(() => {
					cb(Buffer.from(JSON.stringify(body)));
					this._endCb?.();
				});
			} else if (event === 'end') {
				this._endCb = cb;
			}
		},
		destroy() {},
	};
	const res = mkRes();
	await handler(req, res);
	return { res, json: res.body ? JSON.parse(res.body) : null };
}

const create = (body) => post(createHandler, '/api/scene/gate-create', body);
const check = (body) => post(checkHandler, '/api/scene/gate-check', body);

beforeEach(() => {
	sqlMock.mockReset();
	getSessionUserMock.mockReset();
	splBalanceMock.mockReset();
	dasSearchAssetsMock.mockReset();
	evmCallMock.mockReset();
	dasRpcUrlMock.mockReturnValue('https://mainnet.helius-rpc.com/?api-key=test');
});

describe('POST /api/scene/gate-create', () => {
	it('401s a caller with no session and no bearer token', async () => {
		getSessionUserMock.mockResolvedValue(null);
		stubDb();
		const { res, json } = await create({
			sceneRef: 'abc123',
			gate: { chain: 'solana', kind: 'spl', address: MINT, minBalance: 1 },
		});

		expect(res.statusCode).toBe(401);
		expect(json.error).toBe('unauthorized');
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('creates the gate and returns a share URL carrying the gate id', async () => {
		getSessionUserMock.mockResolvedValue({ id: 'user_creator_1' });
		stubDb();
		const { res, json } = await create({
			sceneRef: 'abc123',
			gate: { chain: 'solana', kind: 'spl', address: MINT, minBalance: 2500 },
		});

		expect(res.statusCode).toBe(201);
		expect(json.gateId).toMatch(/^[A-Za-z0-9]{12}$/);
		expect(json.shareUrl).toBe(`https://three.ws/chat?sl=abc123&gate=${json.gateId}`);
		expect(res.getHeader('cache-control')).toBe('no-store');
	});

	it('encodes a long inline scene blob into the ?s= form instead of ?sl=', async () => {
		getSessionUserMock.mockResolvedValue({ id: 'user_creator_1' });
		stubDb();
		const blob = 'x'.repeat(64);
		const { json } = await create({
			sceneRef: blob,
			gate: { chain: 'evm', kind: 'erc20', address: ERC20, minBalance: 1 },
		});

		expect(json.shareUrl).toBe(`https://three.ws/chat?s=${blob}&gate=${json.gateId}`);
	});

	it('rejects a chain/kind pair that could never verify', async () => {
		getSessionUserMock.mockResolvedValue({ id: 'user_creator_1' });
		stubDb();
		const { res, json } = await create({
			sceneRef: 'abc123',
			gate: { chain: 'solana', kind: 'erc20', address: MINT, minBalance: 1 },
		});

		expect(res.statusCode).toBe(400);
		expect(json.error).toBe('validation_error');
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('rejects an address that is not valid for the gate chain', async () => {
		getSessionUserMock.mockResolvedValue({ id: 'user_creator_1' });
		stubDb();
		const { res, json } = await create({
			sceneRef: 'abc123',
			gate: { chain: 'evm', kind: 'erc20', address: MINT, minBalance: 1 },
		});

		expect(res.statusCode).toBe(400);
		expect(json.error).toBe('validation_error');
		expect(sqlMock).not.toHaveBeenCalled();
	});
});

describe('POST /api/scene/gate-check phase 1', () => {
	it('issues a signable message carrying a fresh nonce', async () => {
		stubDb();
		const { res, json } = await check({ gateId: GATE_ID, walletAddress: WALLET });

		expect(res.statusCode).toBe(200);
		expect(json.chain).toBe('solana');
		expect(json.message).toContain(`Gate ID: ${GATE_ID}`);
		expect(json.message).toMatch(/^Nonce: [A-Za-z0-9]{16}$/m);
		expect(res.getHeader('cache-control')).toBe('no-store');
	});

	it('404s an unknown gate without writing a nonce', async () => {
		stubDb({ gate: null });
		const { res, json } = await check({ gateId: 'nosuchgate', walletAddress: WALLET });

		expect(res.statusCode).toBe(404);
		expect(json.error).toBe('not_found');
		const statements = sqlMock.mock.calls.map(([s]) => s.join(' '));
		expect(statements.some((s) => /insert into gate_nonces/i.test(s))).toBe(false);
	});

	it('400s a wallet address the gate chain cannot verify', async () => {
		stubDb();
		const { res, json } = await check({ gateId: GATE_ID, walletAddress: EVM_WALLET.address });

		expect(res.statusCode).toBe(400);
		expect(json.error).toBe('validation_error');
	});
});

describe('POST /api/scene/gate-check phase 2 signature and nonce rules', () => {
	it('401s a signature from a different wallet', async () => {
		stubDb();
		const message = gateMessage(WALLET);
		const { res, json } = await check({
			gateId: GATE_ID,
			walletAddress: WALLET,
			message,
			signature: signSolana(message, OTHER_SECRET),
		});

		expect(res.statusCode).toBe(401);
		expect(json.error).toBe('invalid_signature');
		expect(splBalanceMock).not.toHaveBeenCalled();
	});

	it('400s a replayed nonce', async () => {
		stubDb({ nonce: nonceRow({ consumed_at: new Date().toISOString() }) });
		const message = gateMessage(WALLET);
		const { res, json } = await check({
			gateId: GATE_ID,
			walletAddress: WALLET,
			message,
			signature: signSolana(message),
		});

		expect(res.statusCode).toBe(400);
		expect(json.error).toBe('nonce_reused');
		expect(splBalanceMock).not.toHaveBeenCalled();
	});

	it('400s an expired nonce', async () => {
		stubDb({ nonce: nonceRow({ expires_at: new Date(Date.now() - 1000).toISOString() }) });
		const message = gateMessage(WALLET);
		const { res, json } = await check({
			gateId: GATE_ID,
			walletAddress: WALLET,
			message,
			signature: signSolana(message),
		});

		expect(res.statusCode).toBe(400);
		expect(json.error).toBe('nonce_expired');
	});

	it('400s a nonce issued for a different gate', async () => {
		stubDb({ nonce: nonceRow({ gate_id: 'someothergate' }) });
		const message = gateMessage(WALLET);
		const { res, json } = await check({
			gateId: GATE_ID,
			walletAddress: WALLET,
			message,
			signature: signSolana(message),
		});

		expect(res.statusCode).toBe(400);
		expect(json.error).toBe('invalid_nonce');
	});
});

describe('POST /api/scene/gate-check phase 2 balance decision', () => {
	it('allows a wallet holding at least the minimum SPL balance', async () => {
		stubDb();
		splBalanceMock.mockResolvedValue(6000);
		const message = gateMessage(WALLET);
		const { res, json } = await check({
			gateId: GATE_ID,
			walletAddress: WALLET,
			message,
			signature: signSolana(message),
		});

		expect(res.statusCode).toBe(200);
		expect(json).toEqual({ allowed: true });
		expect(splBalanceMock).toHaveBeenCalledWith(WALLET, MINT);
	});

	it('denies a wallet below the minimum and says by how much', async () => {
		stubDb();
		splBalanceMock.mockResolvedValue(12);
		const message = gateMessage(WALLET);
		const { res, json } = await check({
			gateId: GATE_ID,
			walletAddress: WALLET,
			message,
			signature: signSolana(message),
		});

		expect(res.statusCode).toBe(200);
		expect(json.allowed).toBe(false);
		expect(json.reason).toBe('Insufficient balance: need 5000, have 12');
	});

	it('counts collection NFTs only as far as the threshold', async () => {
		stubDb({ gate: { id: GATE_ID, chain: 'solana', kind: 'collection', address: COLLECTION, min_balance: '2' } });
		dasSearchAssetsMock.mockResolvedValue({ items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] });
		const message = gateMessage(WALLET);
		const { res, json } = await check({
			gateId: GATE_ID,
			walletAddress: WALLET,
			message,
			signature: signSolana(message),
		});

		expect(res.statusCode).toBe(200);
		expect(json).toEqual({ allowed: true });
		expect(dasSearchAssetsMock).toHaveBeenCalledTimes(1);
		expect(dasSearchAssetsMock.mock.calls[0][0]).toMatchObject({
			ownerAddress: WALLET,
			grouping: ['collection', COLLECTION],
			burnt: false,
		});
	});

	it('reads an ERC-20 balance at the contract decimals', async () => {
		stubDb({
			gate: { id: GATE_ID, chain: 'evm', kind: 'erc20', address: ERC20, min_balance: '10' },
			nonce: nonceRow({ address: EVM_WALLET.address }),
		});
		const coder = AbiCoder.defaultAbiCoder();
		evmCallMock.mockImplementation(async (tx) =>
			tx.data.startsWith('0x313ce567')
				? coder.encode(['uint8'], [6])
				: coder.encode(['uint256'], [25_000_000n]),
		);
		const message = gateMessage(EVM_WALLET.address);
		const { res, json } = await check({
			gateId: GATE_ID,
			walletAddress: EVM_WALLET.address,
			message,
			signature: await EVM_WALLET.signMessage(message),
		});

		expect(res.statusCode).toBe(200);
		expect(json).toEqual({ allowed: true });
	});

	it('502s an RPC failure instead of reporting it as a denial', async () => {
		stubDb();
		splBalanceMock.mockRejectedValue(new Error('all solana rpc endpoints failed'));
		const message = gateMessage(WALLET);
		const { res, json } = await check({
			gateId: GATE_ID,
			walletAddress: WALLET,
			message,
			signature: signSolana(message),
		});

		expect(res.statusCode).toBe(502);
		expect(json.error).toBe('gate_check_unavailable');
		expect(json.error_description).not.toContain('solana rpc');
		expect(json.allowed).toBeUndefined();
	});

	it('503s a collection gate when no DAS provider is configured', async () => {
		stubDb({ gate: { id: GATE_ID, chain: 'solana', kind: 'collection', address: COLLECTION, min_balance: '1' } });
		dasRpcUrlMock.mockReturnValue(null);
		const message = gateMessage(WALLET);
		const { res, json } = await check({
			gateId: GATE_ID,
			walletAddress: WALLET,
			message,
			signature: signSolana(message),
		});

		expect(res.statusCode).toBe(503);
		expect(json.error).toBe('not_configured');
		expect(json.error_description).not.toContain('HELIUS_API_KEY');
		expect(dasSearchAssetsMock).not.toHaveBeenCalled();
	});
});
