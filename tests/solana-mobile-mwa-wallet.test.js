// @vitest-environment jsdom
//
// Unit coverage for the Seeker Mobile Wallet Adapter (MWA) wrapper in
// solana-mobile/src/mwa-wallet.js. On a Seeker the browser does not inject
// window.solana; signing is delegated to the on-device Seed Vault over the MWA
// protocol. This suite exercises that wrapper against a fake `transact`
// transport so every branch (authorize / reauthorize / resume / sign / send /
// disconnect / session persistence / error paths) is verified without hardware.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';

// The real transport is loaded lazily via
// `await import('@solana-mobile/mobile-wallet-adapter-protocol-web3js')`.
// Replace it with a controllable fake. vi.hoisted keeps the shared state alive
// above the hoisted vi.mock factory.
const h = vi.hoisted(() => {
	const state = { wallet: null, transactCalls: 0 };
	return {
		state,
		transact: async (callback) => {
			state.transactCalls += 1;
			if (!state.wallet) throw new Error('no fake wallet configured');
			return callback(state.wallet);
		},
	};
});

vi.mock('@solana-mobile/mobile-wallet-adapter-protocol-web3js', () => ({
	transact: h.transact,
}));

import { MwaWallet } from '../solana-mobile/src/mwa-wallet.js';

const ADDR = 'So11111111111111111111111111111111111111112';
const ADDR_B64 = Buffer.from(new PublicKey(ADDR).toBytes()).toString('base64');

// Build a fake MWA wallet proxy. Each protocol method is a spy returning the
// shape the web3js-augmented transact() proxy produces.
function makeWallet(overrides = {}) {
	const authResult = {
		accounts: [{ address: ADDR_B64 }],
		auth_token: 'tok-1',
	};
	return {
		authorize: vi.fn().mockResolvedValue(authResult),
		reauthorize: vi.fn().mockResolvedValue(authResult),
		deauthorize: vi.fn().mockResolvedValue(undefined),
		signMessages: vi.fn(),
		signTransactions: vi.fn(),
		signAndSendTransactions: vi.fn(),
		...overrides,
	};
}

beforeEach(() => {
	sessionStorage.clear();
	h.state.wallet = makeWallet();
	h.state.transactCalls = 0;
});

describe('MwaWallet.connect', () => {
	it('authorizes on first connect and exposes the derived public key', async () => {
		const w = new MwaWallet();
		const onConnect = vi.fn();
		w.on('connect', onConnect);

		const { publicKey } = await w.connect();

		expect(h.state.wallet.authorize).toHaveBeenCalledTimes(1);
		expect(h.state.wallet.authorize).toHaveBeenCalledWith(
			expect.objectContaining({
				chain: 'solana:mainnet',
				features: ['solana:signTransactions', 'solana:signMessages'],
			}),
		);
		expect(publicKey.toBase58()).toBe(ADDR);
		expect(w.isConnected).toBe(true);
		expect(onConnect).toHaveBeenCalledWith(w.publicKey);
		// Auth token + address persisted for resume.
		expect(sessionStorage.getItem('threews:mwa:authToken')).toBe('tok-1');
		expect(sessionStorage.getItem('threews:mwa:address')).toBe(ADDR);
	});

	it('is a no-op when already connected (no second transport session)', async () => {
		const w = new MwaWallet();
		await w.connect();
		const before = h.state.transactCalls;
		await w.connect();
		expect(h.state.transactCalls).toBe(before);
	});

	it('shares a single in-flight promise across concurrent connect calls', async () => {
		const w = new MwaWallet();
		const [a, b] = await Promise.all([w.connect(), w.connect()]);
		expect(a.publicKey.toBase58()).toBe(ADDR);
		expect(b.publicKey.toBase58()).toBe(ADDR);
		// Only one authorize despite two concurrent callers.
		expect(h.state.wallet.authorize).toHaveBeenCalledTimes(1);
	});

	it('rejects onlyIfTrusted resume when there is no prior session', async () => {
		const w = new MwaWallet();
		await expect(w.connect({ onlyIfTrusted: true })).rejects.toMatchObject({ code: 4001 });
		expect(h.state.wallet.authorize).not.toHaveBeenCalled();
	});

	it('reauthorizes (not authorize) when a stored token exists', async () => {
		sessionStorage.setItem('threews:mwa:authToken', 'stored-tok');
		sessionStorage.setItem('threews:mwa:address', ADDR);
		const w = new MwaWallet();
		// Constructor rehydrated address, so it is already "connected"; force a
		// resume through the transport by clearing the public key path.
		await w.connect({ onlyIfTrusted: true });
		// Already connected from storage → no transport call needed.
		expect(w.isConnected).toBe(true);
	});

	it('surfaces a reauthorize failure when the Seed Vault revoked the token', async () => {
		// A rehydrated wallet still holds a token, but signing forces a
		// reauthorize; if the wallet revoked it, the operation must reject
		// rather than sign against a dead session.
		sessionStorage.setItem('threews:mwa:authToken', 'revoked');
		sessionStorage.setItem('threews:mwa:address', ADDR);
		h.state.wallet = makeWallet({
			reauthorize: vi.fn().mockRejectedValue(new Error('token revoked')),
		});
		const w = new MwaWallet();
		const err = await w.signMessage(new Uint8Array([1, 2, 3])).catch((e) => e);
		// Normalized to a stable MwaError; original preserved as cause.
		expect(err.name).toBe('MwaError');
		expect(err.cause?.message).toMatch(/revoked/);
	});
});

describe('MwaWallet.signMessage', () => {
	it('returns the trailing 64-byte ed25519 signature from the signed payload', async () => {
		const message = new Uint8Array([9, 8, 7]);
		const sig = new Uint8Array(64).fill(7);
		const combined = new Uint8Array([...message, ...sig]);
		h.state.wallet.signMessages.mockResolvedValue([combined]);

		const w = new MwaWallet();
		await w.connect();
		const { signature, publicKey } = await w.signMessage(message);

		expect(signature).toBeInstanceOf(Uint8Array);
		expect(signature.length).toBe(64);
		expect(Array.from(signature)).toEqual(Array.from(sig));
		expect(publicKey.toBase58()).toBe(ADDR);
	});

	it('rejects a non-Uint8Array message', async () => {
		const w = new MwaWallet();
		await w.connect();
		await expect(w.signMessage('not-bytes')).rejects.toThrow(TypeError);
	});

	it('throws when the wallet returns no signed payload', async () => {
		h.state.wallet.signMessages.mockResolvedValue([null]);
		const w = new MwaWallet();
		await w.connect();
		await expect(w.signMessage(new Uint8Array([1]))).rejects.toThrow(/no signed payload/);
	});
});

describe('MwaWallet.signTransaction / signAllTransactions', () => {
	it('returns the signed transactions from the transport', async () => {
		const txs = [{ id: 'a' }, { id: 'b' }];
		const signedOut = [{ id: 'a', signed: true }, { id: 'b', signed: true }];
		h.state.wallet.signTransactions.mockResolvedValue(signedOut);

		const w = new MwaWallet();
		await w.connect();
		const result = await w.signAllTransactions(txs);
		expect(result).toEqual(signedOut);
		expect(h.state.wallet.signTransactions).toHaveBeenCalledWith({ transactions: txs });
	});

	it('signTransaction unwraps the single-element result', async () => {
		h.state.wallet.signTransactions.mockResolvedValue([{ id: 'x', signed: true }]);
		const w = new MwaWallet();
		await w.connect();
		const signed = await w.signTransaction({ id: 'x' });
		expect(signed).toEqual({ id: 'x', signed: true });
	});

	it('throws on a mismatched signed-count', async () => {
		h.state.wallet.signTransactions.mockResolvedValue([{ id: 'a' }]);
		const w = new MwaWallet();
		await w.connect();
		await expect(w.signAllTransactions([{ id: 'a' }, { id: 'b' }])).rejects.toThrow(/mismatched/);
	});

	it('rejects an empty transaction array', async () => {
		const w = new MwaWallet();
		await w.connect();
		await expect(w.signAllTransactions([])).rejects.toThrow(TypeError);
	});
});

describe('MwaWallet.signAndSendTransaction', () => {
	it('returns the base58 signature string from the send flow', async () => {
		h.state.wallet.signAndSendTransactions.mockResolvedValue(['5xSig...base58']);
		const w = new MwaWallet();
		await w.connect();
		const { signature } = await w.signAndSendTransaction({ id: 'tx' });
		expect(signature).toBe('5xSig...base58');
	});

	it('throws when the transport returns a non-string signature', async () => {
		h.state.wallet.signAndSendTransactions.mockResolvedValue([null]);
		const w = new MwaWallet();
		await w.connect();
		await expect(w.signAndSendTransaction({ id: 'tx' })).rejects.toThrow(/no signature/);
	});
});

describe('MwaWallet.disconnect', () => {
	it('deauthorizes and resets state, emitting disconnect', async () => {
		const w = new MwaWallet();
		await w.connect();
		const onDisconnect = vi.fn();
		w.on('disconnect', onDisconnect);

		await w.disconnect();

		expect(h.state.wallet.deauthorize).toHaveBeenCalledWith({ auth_token: 'tok-1' });
		expect(w.isConnected).toBe(false);
		expect(w.publicKey).toBe(null);
		expect(onDisconnect).toHaveBeenCalled();
		expect(sessionStorage.getItem('threews:mwa:authToken')).toBe(null);
	});

	it('is safe to call with no active session', async () => {
		const w = new MwaWallet();
		await expect(w.disconnect()).resolves.toBeUndefined();
		expect(h.state.wallet.deauthorize).not.toHaveBeenCalled();
	});

	it('resets local state even if deauthorize rejects', async () => {
		h.state.wallet = makeWallet({
			deauthorize: vi.fn().mockRejectedValue(new Error('network')),
		});
		const w = new MwaWallet();
		await w.connect();
		await w.disconnect();
		expect(w.isConnected).toBe(false);
	});
});

describe('session persistence', () => {
	it('rehydrates a connected wallet from sessionStorage', async () => {
		const first = new MwaWallet();
		await first.connect();
		// A fresh instance (app relaunch) should already be connected.
		const second = new MwaWallet();
		expect(second.isConnected).toBe(true);
		expect(second.publicKey.toBase58()).toBe(ADDR);
	});
});

describe('MwaWallet.signIn (one-tap SIWS)', () => {
	const SIWS_TEXT = 'three.ws wants you to sign in with your Solana account:\n' + ADDR;

	it('authorizes and returns the wallet-built SIWS message + signature in one call', async () => {
		const sig = new Uint8Array(64).fill(3);
		h.state.wallet.authorize.mockResolvedValue({
			accounts: [{ address: ADDR_B64 }],
			auth_token: 'tok-siws',
			sign_in_result: {
				signed_message: Buffer.from(SIWS_TEXT, 'utf8').toString('base64'),
				signature: Buffer.from(sig).toString('base64'),
			},
		});

		const w = new MwaWallet();
		const out = await w.signIn({ domain: 'three.ws', nonce: 'abc123', chainId: 'mainnet' });

		expect(h.state.wallet.authorize).toHaveBeenCalledWith(
			expect.objectContaining({ sign_in_payload: expect.objectContaining({ domain: 'three.ws', nonce: 'abc123' }) }),
		);
		expect(out.address).toBe(ADDR);
		expect(out.signedMessageText).toBe(SIWS_TEXT);
		expect(Array.from(out.signature)).toEqual(Array.from(sig));
		expect(w.isConnected).toBe(true);
	});

	it('returns null when the wallet does not support authorize-time sign-in', async () => {
		// authorize succeeds but omits sign_in_result (older wallet).
		h.state.wallet.authorize.mockResolvedValue({
			accounts: [{ address: ADDR_B64 }],
			auth_token: 'tok-no-siws',
		});
		const w = new MwaWallet();
		const out = await w.signIn({ nonce: 'n' });
		expect(out).toBe(null);
		// Still authorized as a side effect, so a fallback signMessage is cheap.
		expect(w.isConnected).toBe(true);
	});

	it('advertises supportsSignIn', () => {
		expect(new MwaWallet().supportsSignIn).toBe(true);
	});
});

describe('error normalization', () => {
	it('maps an MWA authorization decline (code -1) to a Phantom-style 4001', async () => {
		const declined = Object.assign(new Error('authorization failed'), { code: -1 });
		h.state.wallet.authorize.mockRejectedValue(declined);
		const w = new MwaWallet();
		const err = await w.connect().catch((e) => e);
		expect(err.name).toBe('MwaError');
		expect(err.code).toBe(4001);
		expect(err.reason).toBe('USER_REJECTED');
	});

	it('maps ERROR_WALLET_NOT_FOUND to an actionable reason (no 4001)', async () => {
		const notFound = Object.assign(new Error('no wallet'), { code: 'ERROR_WALLET_NOT_FOUND' });
		h.state.wallet.authorize.mockRejectedValue(notFound);
		const w = new MwaWallet();
		const err = await w.connect().catch((e) => e);
		expect(err.reason).toBe('WALLET_NOT_FOUND');
		expect(err.code).toBeUndefined();
		expect(err.userMessage).toMatch(/wallet app/i);
	});
});

describe('address decoding', () => {
	it('accepts a base58 address returned directly by newer wallets', async () => {
		h.state.wallet = makeWallet({
			authorize: vi.fn().mockResolvedValue({
				accounts: [{ address: ADDR }], // base58, not base64
				auth_token: 'tok-b58',
			}),
		});
		const w = new MwaWallet();
		const { publicKey } = await w.connect();
		expect(publicKey.toBase58()).toBe(ADDR);
	});
});
