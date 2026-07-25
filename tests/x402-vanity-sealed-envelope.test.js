import { describe, it, expect } from 'vitest';
import bs58 from 'bs58';
import { x25519 } from '@noble/curves/ed25519.js';

import {
	sealToRecipient,
	openSealed,
	openSealedText,
	generateRecipientKeypair,
	parseX25519Key,
	SEALED_ENVELOPE_SCHEME,
} from '../src/solana/vanity/sealed-envelope.js';
import { grindVanityNode } from '../src/solana/vanity/grinder-node.js';
import { grindVanityMnemonic } from '../src/solana/vanity/mnemonic-grinder.js';
import { deriveSolanaKeypair } from '../src/solana/vanity/mnemonic.js';

function toBase64url(bytes) {
	return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Flip the first byte of a Base64url payload — a guaranteed-significant mutation
// (flipping a trailing char can be a no-op on the decoded bytes).
function flipFirstByte(b64u) {
	const buf = Buffer.from(b64u.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
	buf[0] ^= 0xff;
	return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

describe('sealed-envelope', () => {
	it('round-trips a string through seal → open with the matching key', async () => {
		const { publicKey, secretKey } = generateRecipientKeypair();
		const plaintext = JSON.stringify({ secret: 'top', n: 42 });
		const env = await sealToRecipient(plaintext, publicKey);

		expect(env.scheme).toBe(SEALED_ENVELOPE_SCHEME);
		expect(env.recipient).toBe(publicKey);
		expect(typeof env.epk).toBe('string');
		expect(typeof env.nonce).toBe('string');
		// The ciphertext must not leak the plaintext.
		expect(env.ciphertext).not.toContain('top');

		expect(await openSealedText(env, secretKey)).toBe(plaintext);
	});

	it('round-trips raw bytes', async () => {
		const { publicKey, secretKey } = generateRecipientKeypair();
		const bytes = new Uint8Array([0, 1, 2, 255, 128, 64]);
		const env = await sealToRecipient(bytes, publicKey);
		expect(Array.from(await openSealed(env, secretKey))).toEqual(Array.from(bytes));
	});

	it('rejects opening with the wrong private key', async () => {
		const { publicKey } = generateRecipientKeypair();
		const env = await sealToRecipient('secret', publicKey);
		const wrong = generateRecipientKeypair().secretKey;
		await expect(openSealed(env, wrong)).rejects.toThrow();
	});

	it('rejects a tampered ciphertext (AES-GCM tag)', async () => {
		const { publicKey, secretKey } = generateRecipientKeypair();
		const env = await sealToRecipient('secret', publicKey);
		const tampered = { ...env, ciphertext: flipFirstByte(env.ciphertext) };
		await expect(openSealed(tampered, secretKey)).rejects.toThrow();
	});

	it('rejects a swapped ephemeral public key (epk bound as AAD)', async () => {
		const { publicKey, secretKey } = generateRecipientKeypair();
		const env = await sealToRecipient('secret', publicKey);
		// Replace epk with a different valid X25519 public key.
		const otherEpk = generateRecipientKeypair().publicKey;
		await expect(openSealed({ ...env, epk: otherEpk }, secretKey)).rejects.toThrow();
	});

	it('rejects an unsupported scheme', async () => {
		const { publicKey, secretKey } = generateRecipientKeypair();
		const env = await sealToRecipient('secret', publicKey);
		await expect(openSealed({ ...env, scheme: 'rot13' }, secretKey)).rejects.toThrow(/scheme/);
	});

	it('accepts the recipient key as Base58, hex, or Base64url', async () => {
		const { publicKey, secretKey } = generateRecipientKeypair();
		const raw = parseX25519Key(publicKey);
		const hex = Buffer.from(raw).toString('hex');
		const b64 = toBase64url(raw);
		// Explicit prefixes are always unambiguous; bare forms are covered below.
		for (const form of [publicKey, hex, `base58:${publicKey}`, `hex:${hex}`, `base64url:${b64}`]) {
			const env = await sealToRecipient('ok', form);
			expect(await openSealedText(env, secretKey)).toBe('ok');
		}
	});

	it('generates recipient keys that are unambiguous on the wire', () => {
		// Base64url spends exactly 43 characters on 32 bytes and Base58's alphabet
		// is a subset of Base64url's, so a 43-character Base58 key is ALSO a valid
		// Base64url string for a different key. Generating only 44-character keys
		// means a bare `sealTo=` from our own SDK can never be misread.
		for (let i = 0; i < 200; i++) {
			const kp = generateRecipientKeypair();
			// Both halves: the secret travels through the same parser on open.
			expect(kp.publicKey).toHaveLength(44);
			expect(kp.secretKey).toHaveLength(44);
		}
	});

	it('never silently seals to the wrong key when an encoding is ambiguous', async () => {
		// A hand-rolled caller can still submit a 43-character key. The old parser
		// tried Base58 first whenever the string had no '-' or '_', which measured
		// at 1.5% of Base64url keys decoding to a valid-looking but WRONG key: the
		// buyer paid, got a sealed envelope, and could not open it. Refusing to
		// guess is the only outcome that cannot do that.
		let ambiguous = 0;
		for (let i = 0; i < 400 && ambiguous < 1; i++) {
			const secret = x25519.utils.randomSecretKey();
			const raw = x25519.getPublicKey(secret);
			const b58 = bs58.encode(raw);
			if (b58.length !== 43) continue; // only 43-char keys collide
			ambiguous++;
			// Bare form is refused with an actionable error...
			let err;
			try {
				parseX25519Key(b58);
			} catch (e) {
				err = e;
			}
			expect(err?.code).toBe('ambiguous_recipient_key');
			expect(err?.status).toBe(400);
			expect(err.message).toMatch(/base58:/);
			// ...and the prefix the message suggests actually resolves it.
			expect(Buffer.from(parseX25519Key(`base58:${b58}`))).toEqual(Buffer.from(raw));
		}
		expect(ambiguous, 'expected to draw at least one 43-char key in 400 tries').toBe(1);
	});

	it('rejects an unknown encoding prefix rather than guessing', () => {
		const { publicKey } = generateRecipientKeypair();
		expect(() => parseX25519Key(`base32:${publicKey}`)).toThrow(/not valid/i);
	});

	it('throws a 400-tagged error on a wrong-length recipient key', () => {
		try {
			parseX25519Key('deadbeef'); // 4 bytes, not 32
			throw new Error('should have thrown');
		} catch (e) {
			expect(e.code).toBe('invalid_recipient_key');
			expect(e.status).toBe(400);
		}
	});
});

describe('sealed vanity delivery (endpoint sealSecret path)', () => {
	// Mirrors api/x402/vanity.js: seal a JSON bundle of the secret, then a client
	// opens it with their X25519 private key. We exercise both output formats.
	it('seals a ground keypair so only the recipient can recover the secret', async () => {
		const { publicKey, secretKey } = generateRecipientKeypair();
		const g = grindVanityNode({ suffix: 'z', ignoreCase: true, timeBudgetMs: 15_000 });
		const bundle = {
			format: 'keypair',
			secretKeyBase58: bs58.encode(g.secretKey),
			secretKey: Array.from(g.secretKey),
		};
		const sealed = await sealToRecipient(JSON.stringify(bundle), publicKey);

		const opened = JSON.parse(await openSealedText(sealed, secretKey));
		expect(opened.secretKeyBase58).toBe(bundle.secretKeyBase58);
		// The recovered secret key must reproduce the ground address.
		const recovered = bs58.decode(opened.secretKeyBase58);
		expect(bs58.encode(recovered.slice(32))).toBe(g.publicKey);
	});

	it('seals a ground mnemonic that re-derives to the vanity address', async () => {
		const { publicKey, secretKey } = generateRecipientKeypair();
		const g = grindVanityMnemonic({ suffix: 'z', ignoreCase: true, timeBudgetMs: 20_000 });
		const bundle = {
			format: 'mnemonic',
			mnemonic: g.mnemonic,
			derivationPath: g.derivationPath,
		};
		const sealed = await sealToRecipient(JSON.stringify(bundle), publicKey);

		const opened = JSON.parse(await openSealedText(sealed, secretKey));
		// Recovering the phrase and deriving at the wallet path lands on the address.
		const derived = deriveSolanaKeypair(opened.mnemonic).keypair.publicKey.toBase58();
		expect(derived).toBe(g.publicKey);
	});
});
