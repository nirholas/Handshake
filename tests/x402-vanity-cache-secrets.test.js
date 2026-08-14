// The x402 replay/idempotency cache must never hold spendable key material.
// Both vanity endpoints deliver a Solana secret exactly once in the live
// response; what they hand storeResponse() is a stripped copy. These pin that.
//
// The verifiable endpoint has a second, less obvious leak channel: its receipt
// is verifiable precisely BECAUSE serverSeed re-derives the key (masterSeed =
// HKDF(serverSeed || clientSeed || requestNonce), then candidate winningIndex).
// So serverSeed is key-equivalent and must be stripped even from a SEALED
// delivery, where the plaintext secret was never in the body to begin with.

import { describe, it, expect } from 'vitest';
import { cacheSafeBody as vanityCacheSafeBody } from '../api/x402/vanity.js';
import { cacheSafeBody as verifiableCacheSafeBody } from '../api/x402/vanity-verifiable.js';

const SECRET_B58 = '5JueXamPLEonLYnEvErAfUnDeDkEyMaTeRiAL111111111111111111111111111';
const SECRET_BYTES = Array.from({ length: 64 }, (_, i) => i);
const SERVER_SEED = 'a'.repeat(64);

function groundResult(extra = {}) {
	return {
		address: 'SoEXAMPLEdoNotUse1111111111111111111111111111',
		prefix: 'So',
		suffix: null,
		ignoreCase: false,
		format: 'keypair',
		secretKeyBase58: SECRET_B58,
		secretKey: SECRET_BYTES,
		mnemonic: null,
		attempts: 3042,
		network: 'solana',
		source: 'ground',
		certificate: { certId: 'cert_1', signature: 'ed25519:…' },
		...extra,
	};
}

function receipt(extra = {}) {
	return {
		protocol: 'three-vanity/v1',
		address: 'SoEXAMPLEdoNotUse1111111111111111111111111111',
		commitment: 'b'.repeat(64),
		serverSeed: SERVER_SEED,
		clientSeed: 'c'.repeat(64),
		requestNonce: 'd'.repeat(32),
		winningIndex: 3041,
		attempts: 3042,
		sealed: false,
		signature: 'e'.repeat(128),
		servicePublicKey: 'SoServiceKey1111111111111111111111111111111',
		secretKeyBase58: SECRET_B58,
		secretKey: SECRET_BYTES,
		seed: 'f'.repeat(64),
		...extra,
	};
}

describe('/api/x402/vanity cacheSafeBody', () => {
	it('strips the plaintext secret from an unsealed result and marks it', () => {
		const stored = JSON.parse(vanityCacheSafeBody(groundResult()));
		expect(stored.secretKeyBase58).toBeUndefined();
		expect(stored.secretKey).toBeUndefined();
		expect(stored).not.toHaveProperty('mnemonic');
		expect(stored.secret_omitted_from_cache).toBe(true);
		expect(stored.note).toMatch(/never stored/i);
	});

	it('keeps the public metadata a replayed payment still needs', () => {
		const stored = JSON.parse(vanityCacheSafeBody(groundResult()));
		expect(stored.address).toBe('SoEXAMPLEdoNotUse1111111111111111111111111111');
		expect(stored.attempts).toBe(3042);
		expect(stored.certificate.certId).toBe('cert_1');
	});

	it('strips a mnemonic delivery too (the phrase is key material)', () => {
		const stored = JSON.parse(
			vanityCacheSafeBody(
				groundResult({ format: 'mnemonic', mnemonic: 'legal winner thank year wave sausage worth useful legal winner thank yellow', wordCount: 12 }),
			),
		);
		expect(stored.mnemonic).toBeUndefined();
		expect(stored.wordCount).toBe(12);
	});

	it('caches a sealed delivery unchanged (ciphertext is safe at rest)', () => {
		const sealed = {
			address: 'SoEXAMPLEdoNotUse1111111111111111111111111111',
			sealed: true,
			sealedSecret: { scheme: 'x25519-hkdf-sha256-aes256gcm', ciphertext: 'AAAA', recipient: 'r' },
		};
		expect(JSON.parse(vanityCacheSafeBody(sealed))).toEqual(sealed);
	});

	it('never emits the secret in the serialized string', () => {
		expect(vanityCacheSafeBody(groundResult())).not.toContain(SECRET_B58);
	});
});

describe('/api/x402/vanity-verifiable cacheSafeBody', () => {
	it('strips the plaintext secret and the key-equivalent serverSeed', () => {
		const stored = JSON.parse(verifiableCacheSafeBody(receipt()));
		expect(stored.secretKeyBase58).toBeUndefined();
		expect(stored.secretKey).toBeUndefined();
		expect(stored.seed).toBeUndefined();
		expect(stored.serverSeed).toBeUndefined();
		expect(stored.secret_omitted_from_cache).toBe(true);
	});

	it('strips serverSeed from a SEALED receipt as well', () => {
		const sealedReceipt = receipt({
			sealed: true,
			sealedSecret: { scheme: 'x25519-hkdf-sha256-aes256gcm', ciphertext: 'AAAA', recipient: 'r' },
			secretKeyBase58: undefined,
			secretKey: undefined,
			seed: undefined,
		});
		const stored = JSON.parse(verifiableCacheSafeBody(sealedReceipt));
		expect(stored.serverSeed).toBeUndefined();
		// The buyer's own ciphertext stays: only their X25519 key opens it.
		expect(stored.sealedSecret.ciphertext).toBe('AAAA');
	});

	it('keeps the non-reconstructing receipt fields', () => {
		const stored = JSON.parse(verifiableCacheSafeBody(receipt()));
		expect(stored.commitment).toBe('b'.repeat(64));
		expect(stored.winningIndex).toBe(3041);
		expect(stored.signature).toBe('e'.repeat(128));
		expect(stored.address).toBe('SoEXAMPLEdoNotUse1111111111111111111111111111');
	});

	it('never emits the secret or the serverSeed in the serialized string', () => {
		const body = verifiableCacheSafeBody(receipt());
		expect(body).not.toContain(SECRET_B58);
		expect(body).not.toContain(SERVER_SEED);
	});
});
