import { describe, it, expect, beforeAll, afterEach } from 'vitest';

// secret-box freezes IS_PROD at import time; keep the test env non-prod so the
// JWT_SECRET fallback path (the thing under test) is reachable. walletMasterSecret
// and env.JWT_SECRET are read live per call, so we can flip keys between calls
// without re-importing the module.
const JWT = 'test-jwt-secret-value-1234567890-abcdef_'; // >=32
const DEDICATED = 'dedicated-wallet-encryption-key-0987654321-XYZ'; // >=32, distinct

beforeAll(() => {
	process.env.NODE_ENV = 'test';
	delete process.env.VERCEL_ENV;
	process.env.JWT_SECRET = JWT;
});

afterEach(() => {
	delete process.env.WALLET_ENCRYPTION_KEY;
});

const load = () => import('../api/_lib/secret-box.js');

describe('secret-box encrypt/decrypt', () => {
	it('round-trips with a dedicated WALLET_ENCRYPTION_KEY', async () => {
		const { encryptSecret, decryptSecret } = await load();
		process.env.WALLET_ENCRYPTION_KEY = DEDICATED;
		const ct = await encryptSecret('super-secret-plaintext');
		expect(ct.startsWith('v2:')).toBe(true);
		expect(await decryptSecret(ct)).toBe('super-secret-plaintext');
	});

	it('decrypts a JWT_SECRET-keyed v2 record even after a dedicated key is introduced', async () => {
		const { encryptSecret, decryptSecret } = await load();
		// (1) Write while only JWT_SECRET exists — the record is keyed by JWT_SECRET.
		delete process.env.WALLET_ENCRYPTION_KEY;
		const legacyV2 = await encryptSecret('funds-behind-this-key');
		expect(legacyV2.startsWith('v2:')).toBe(true);
		// (2) A dedicated key is later introduced. The primary key no longer matches,
		//     but the fallback to JWT_SECRET must still recover the record.
		process.env.WALLET_ENCRYPTION_KEY = DEDICATED;
		expect(await decryptSecret(legacyV2)).toBe('funds-behind-this-key');
	});

	// Rotation survivability. Before WALLET_ENCRYPTION_KEY_PREVIOUS existed, changing
	// the key was a one-way door: the 2026-07 Vercel to Cloud Run rotation left 8
	// custodial wallets holding 0.49 SOL (0.35 of it customer money) permanently
	// unopenable, which is destroyed custody rather than a degraded mode.
	it('decrypts a record written under a retired key listed in WALLET_ENCRYPTION_KEY_PREVIOUS', async () => {
		const { encryptSecret, decryptSecret } = await load();
		const RETIRED = 'retired-wallet-key-from-the-old-host-11111'; // >=32, distinct
		process.env.WALLET_ENCRYPTION_KEY = RETIRED;
		const written = await encryptSecret('the-wallet-that-would-have-been-lost');

		// The rotation happens: a new key takes over and the old one is listed.
		process.env.WALLET_ENCRYPTION_KEY = DEDICATED;
		process.env.WALLET_ENCRYPTION_KEY_PREVIOUS = RETIRED;
		expect(await decryptSecret(written)).toBe('the-wallet-that-would-have-been-lost');

		// Drop the retired key and the same record is unopenable again, which is the
		// state this feature exists to prevent.
		delete process.env.WALLET_ENCRYPTION_KEY_PREVIOUS;
		await expect(decryptSecret(written)).rejects.toBeTruthy();
	});

	it('accepts several stacked rotations, newest first', async () => {
		const { encryptSecret, decryptSecret, secretBoxKeyCandidates } = await load();
		const OLD = 'oldest-wallet-key-two-rotations-ago-222222'; // >=32
		const MID = 'middle-wallet-key-one-rotation-ago-3333333'; // >=32
		process.env.WALLET_ENCRYPTION_KEY = OLD;
		const oldest = await encryptSecret('two-rotations-old');
		process.env.WALLET_ENCRYPTION_KEY = MID;
		const middle = await encryptSecret('one-rotation-old');

		process.env.WALLET_ENCRYPTION_KEY = DEDICATED;
		process.env.WALLET_ENCRYPTION_KEY_PREVIOUS = `${MID}, ${OLD}`;
		expect(await decryptSecret(middle)).toBe('one-rotation-old');
		expect(await decryptSecret(oldest)).toBe('two-rotations-old');
		expect(secretBoxKeyCandidates().slice(0, 3)).toEqual([DEDICATED, MID, OLD]);
		delete process.env.WALLET_ENCRYPTION_KEY_PREVIOUS;
	});

	it('never writes under a retired key: encryption always uses the current one', async () => {
		const { encryptSecret, decryptSecret } = await load();
		const RETIRED = 'retired-key-that-must-not-be-written-4444'; // >=32
		process.env.WALLET_ENCRYPTION_KEY = DEDICATED;
		process.env.WALLET_ENCRYPTION_KEY_PREVIOUS = RETIRED;
		const fresh = await encryptSecret('written-after-the-rotation');

		// Retiring the current key must not open a record written under it, which is
		// only true if the write used DEDICATED rather than any listed retired key.
		process.env.WALLET_ENCRYPTION_KEY = RETIRED;
		delete process.env.WALLET_ENCRYPTION_KEY_PREVIOUS;
		process.env.JWT_SECRET = 'a-jwt-that-does-not-match-either-55555555';
		await expect(decryptSecret(fresh)).rejects.toBeTruthy();
		process.env.JWT_SECRET = JWT;
	});

	it('throws (never returns garbage) when no candidate key matches', async () => {
		const { encryptSecret, decryptSecret } = await load();
		// Encrypt under an unrelated key, then present neither that key nor JWT_SECRET.
		process.env.WALLET_ENCRYPTION_KEY = 'unrelated-key-that-will-be-lost-0000000000';
		const ct = await encryptSecret('unrecoverable');
		process.env.WALLET_ENCRYPTION_KEY = DEDICATED; // primary mismatch
		process.env.JWT_SECRET = 'a-different-jwt-secret-value-000000000000'; // fallback mismatch
		await expect(decryptSecret(ct)).rejects.toBeTruthy();
		process.env.JWT_SECRET = JWT; // restore for other tests
	});
});
