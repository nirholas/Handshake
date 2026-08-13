// Tests for POST /api/embed/gate-verify, the two-phase wallet proof that mints
// the access token api/embed/resolve.js accepts in place of a chain read.
//
// This endpoint is the whole security boundary of a token-gated embed: whoever
// gets a token past it sees the model. So what is pinned here is every way the
// proof can be forged or replayed, and the rule that a balance the caller
// claims counts for nothing.
//
// The signatures are real ed25519 signatures from a real keypair, verified by
// the real api/_lib/siws.js. Only the database rows and the chain read are
// stubbed: one because there is no Postgres in a unit test, the other because
// hitting mainnet from the suite would make the tests flaky and slow. The
// stubbed balance is the value a real RPC read returned, which is exactly the
// input the gate decision is defined over.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import bs58 from 'bs58';

beforeAll(() => {
	process.env.JWT_SECRET = 'test-jwt-secret-embed-gate-verify-0123456789';
});

const sqlMock = vi.fn();
vi.mock('../../api/_lib/db.js', () => ({
	sql: (...a) => sqlMock(...a),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		embedGateVerifyIp: vi.fn(async () => ({ success: true, limit: 30, remaining: 29, reset: 0 })),
		embedGateVerifyWallet: vi.fn(async () => ({ success: true, limit: 10, remaining: 9, reset: 0 })),
	},
	clientIp: () => '203.0.113.9',
}));

const balanceMock = vi.fn();
vi.mock('../../api/_lib/embed-gate.js', async (importOriginal) => {
	const actual = await importOriginal();
	return { ...actual, getSplTokenBalance: (...a) => balanceMock(...a) };
});

const handler = (await import('../../api/embed/gate-verify.js')).default;
const { verifyEmbedGateToken } = await import('../../api/_lib/embed-gate-token.js');
const { DEFAULT_GATE_MINT } = await import('../../api/_lib/embed-gate.js');

// A real keypair: the wallet address IS the public key, so a signature that
// verifies here is one a wallet could have produced.
const SECRET = ed25519.utils.randomSecretKey();
const PUBLIC = ed25519.getPublicKey(SECRET);
const WALLET = bs58.encode(PUBLIC);
const OTHER_SECRET = ed25519.utils.randomSecretKey();
const OTHER_WALLET = bs58.encode(ed25519.getPublicKey(OTHER_SECRET));

const ASSET = 'avatar:8e3f1c22-0000-4000-8000-0000000000c1';
const GATE_ID = 'gate_0000000000000042';
const NONCE = 'A1b2C3d4E5f6G7h8';

const gateRow = {
	id: GATE_ID,
	asset_id: ASSET,
	owner_user_id: 'user_1',
	chain: 'solana',
	mint: DEFAULT_GATE_MINT,
	min_amount: 5000,
};

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

function signedMessage(nonce = NONCE, wallet = WALLET, secret = SECRET) {
	const message = [
		'three.ws token-gated embed verification.',
		'',
		`Asset: ${ASSET}`,
		`Wallet: ${wallet}`,
		`Nonce: ${nonce}`,
		`Issued At: ${new Date().toISOString()}`,
	].join('\n');
	const signature = bs58.encode(ed25519.sign(new TextEncoder().encode(message), secret));
	return { message, signature };
}

/** Route each query by the statement it is, so the handler's read order stays
 *  an implementation detail. `burn` is the conditional update that consumes a
 *  nonce, and returning [] from it is a lost race with a concurrent caller. */
function stubDb({ gate = [gateRow], nonce = [nonceRow()], burn = [{ nonce: NONCE }], insert = [] } = {}) {
	sqlMock.mockImplementation((strings) => {
		const text = Array.isArray(strings) ? strings.join(' ') : String(strings);
		if (/insert into embed_gate_nonces/i.test(text)) return Promise.resolve(insert);
		if (/update embed_gate_nonces/i.test(text)) return Promise.resolve(burn);
		if (/from embed_gate_nonces/i.test(text)) return Promise.resolve(nonce);
		if (/from embed_gates/i.test(text)) return Promise.resolve(gate);
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

async function post(body) {
	const req = {
		method: 'POST',
		url: '/api/embed/gate-verify',
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

beforeEach(() => {
	sqlMock.mockReset();
	balanceMock.mockReset();
});

describe('phase 1: nonce issue', () => {
	it('returns a signable message carrying the gate terms', async () => {
		stubDb();
		const { res, json } = await post({ assetId: ASSET, walletAddress: WALLET });

		expect(res.statusCode).toBe(200);
		expect(json.message).toContain(`Asset: ${ASSET}`);
		expect(json.message).toMatch(/^Nonce: .+$/m);
		expect(json.gate).toEqual({ mint: DEFAULT_GATE_MINT, minAmount: 5000 });
		expect(json.chain).toBe('solana');
		// A nonce is one-time state, so nothing about this may be cached.
		expect(res.getHeader('cache-control')).toBe('no-store');
	});

	it('404s an asset that is not gated at all', async () => {
		stubDb({ gate: [] });
		const { res, json } = await post({ assetId: ASSET, walletAddress: WALLET });
		expect(res.statusCode).toBe(404);
		expect(json.error).toBe('not_found');
	});
});

describe('phase 2: proof of ownership', () => {
	it('mints an access token when a real signature clears the threshold', async () => {
		stubDb();
		balanceMock.mockResolvedValue(9000);
		const { message, signature } = signedMessage();

		const { res, json } = await post({ assetId: ASSET, walletAddress: WALLET, signature, message });

		expect(res.statusCode).toBe(200);
		expect(json.allowed).toBe(true);
		expect(json.amount).toBe(9000);
		// The token must be one resolve.js will actually accept for this gate.
		const claim = await verifyEmbedGateToken(json.accessToken, { assetId: ASSET, gateId: GATE_ID });
		expect(claim).toBeTruthy();
		expect(claim.wallet).toBe(WALLET);
		expect(claim.amount).toBe(9000);
	});

	it('refuses a wallet that does not hold enough, and mints nothing', async () => {
		stubDb();
		balanceMock.mockResolvedValue(10);
		const { message, signature } = signedMessage();

		const { res, json } = await post({ assetId: ASSET, walletAddress: WALLET, signature, message });

		expect(res.statusCode).toBe(200);
		expect(json.allowed).toBe(false);
		expect(json.accessToken).toBeUndefined();
		expect(json.reason).toMatch(/insufficient balance/i);
	});

	it('reads the balance on chain rather than believing the caller', async () => {
		stubDb();
		balanceMock.mockResolvedValue(0);
		const { message, signature } = signedMessage();

		const { json } = await post({
			assetId: ASSET,
			walletAddress: WALLET,
			signature,
			message,
			amount: 999999,
			balance: 999999,
		});

		expect(json.allowed).toBe(false);
		expect(balanceMock).toHaveBeenCalledWith(WALLET, DEFAULT_GATE_MINT);
	});

	it('rejects a signature made by a different key', async () => {
		stubDb();
		balanceMock.mockResolvedValue(9000);
		// Signed by the other keypair, presented as this wallet.
		const { message } = signedMessage();
		const forged = bs58.encode(ed25519.sign(new TextEncoder().encode(message), OTHER_SECRET));

		const { res, json } = await post({
			assetId: ASSET,
			walletAddress: WALLET,
			signature: forged,
			message,
		});

		expect(res.statusCode).toBe(401);
		expect(json.error).toBe('invalid_signature');
		expect(balanceMock).not.toHaveBeenCalled();
	});

	it('rejects a nonce issued to a different wallet', async () => {
		stubDb({ nonce: [nonceRow({ address: OTHER_WALLET })] });
		balanceMock.mockResolvedValue(9000);
		const { message, signature } = signedMessage();

		const { res, json } = await post({ assetId: ASSET, walletAddress: WALLET, signature, message });

		expect(res.statusCode).toBe(400);
		expect(json.error).toBe('invalid_nonce');
		expect(balanceMock).not.toHaveBeenCalled();
	});

	it('rejects a nonce that was already consumed', async () => {
		stubDb({ nonce: [nonceRow({ consumed_at: new Date().toISOString() })] });
		const { message, signature } = signedMessage();

		const { res, json } = await post({ assetId: ASSET, walletAddress: WALLET, signature, message });

		expect(res.statusCode).toBe(400);
		expect(json.error).toBe('nonce_reused');
	});

	it('rejects an expired nonce', async () => {
		stubDb({ nonce: [nonceRow({ expires_at: new Date(Date.now() - 1000).toISOString() })] });
		const { message, signature } = signedMessage();

		const { res, json } = await post({ assetId: ASSET, walletAddress: WALLET, signature, message });

		expect(res.statusCode).toBe(400);
		expect(json.error).toBe('nonce_expired');
	});

	it('loses the race rather than issuing two tokens for one nonce', async () => {
		// The conditional burn matched no row: a concurrent caller consumed it
		// between the read and the update.
		stubDb({ burn: [] });
		balanceMock.mockResolvedValue(9000);
		const { message, signature } = signedMessage();

		const { res, json } = await post({ assetId: ASSET, walletAddress: WALLET, signature, message });

		expect(res.statusCode).toBe(400);
		expect(json.error).toBe('nonce_reused');
		expect(balanceMock).not.toHaveBeenCalled();
	});

	it('rejects a message with no nonce in it', async () => {
		stubDb();
		const message = `three.ws token-gated embed verification.\n\nAsset: ${ASSET}\nWallet: ${WALLET}`;
		const signature = bs58.encode(ed25519.sign(new TextEncoder().encode(message), SECRET));

		const { res, json } = await post({ assetId: ASSET, walletAddress: WALLET, signature, message });

		expect(res.statusCode).toBe(400);
		expect(json.error).toBe('invalid_message');
	});

	it('answers a chain read that failed without granting access', async () => {
		stubDb();
		balanceMock.mockRejectedValue(new Error('rpc unavailable'));
		const { message, signature } = signedMessage();

		const { res, json } = await post({ assetId: ASSET, walletAddress: WALLET, signature, message });

		expect(res.statusCode).toBe(200);
		expect(json.allowed).toBe(false);
		expect(json.accessToken).toBeUndefined();
		expect(json.reason).toMatch(/rpc unavailable/i);
	});
});
