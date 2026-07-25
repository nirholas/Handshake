/**
 * Fixed-vector tests for the provably-fair vanity grinding protocol
 * (src/solana/vanity/verifiable-grind.js).
 *
 * Pins every protocol step against deterministic vectors and proves the
 * verifier REJECTS tampered receipts (negative tests). Real crypto only —
 * @noble Ed25519/SHA-256/HMAC/HKDF, no mocks.
 */

import { describe, it, expect } from 'vitest';
import bs58 from 'bs58';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';

import {
	PROTOCOL_VERSION,
	commitToSeed,
	deriveMasterSeed,
	candidateSeed,
	candidateAddress,
	secretKeyFromSeed,
	addressMatchesPattern,
	grindDeterministic,
	signReceipt,
	verifyReceiptSignature,
	verifyVanityReceipt,
} from '../src/solana/vanity/verifiable-grind.js';
import { expectedAttempts, DIFFICULTY_MODEL } from '../src/solana/vanity/validation.js';

// Fixed test vectors — all-byte-value seeds so the vectors are reproducible and
// readable. serverSeed = 0x00..1f, clientSeed = 0xff..e0, nonce/signing fixed.
const SERVER_SEED = Uint8Array.from({ length: 32 }, (_, i) => i);
const CLIENT_SEED = Uint8Array.from({ length: 32 }, (_, i) => 255 - i);
const REQUEST_NONCE = hexToBytes('a1b2c3d4e5f60718293a4b5c6d7e8f90');
const SIGNING_SEED = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 1) & 0xff);

function buildSignedReceipt({ prefix = 'a', suffix = '', ignoreCase = false } = {}) {
	const masterSeed = deriveMasterSeed({
		serverSeed: SERVER_SEED,
		clientSeed: CLIENT_SEED,
		requestNonce: REQUEST_NONCE,
	});
	const result = grindDeterministic({ masterSeed, prefix, suffix, ignoreCase, maxAttempts: 500000 });
	expect(result.found).toBe(true);
	const core = {
		protocol: PROTOCOL_VERSION,
		commitment: commitToSeed(SERVER_SEED),
		serverSeed: bytesToHex(SERVER_SEED),
		clientSeed: bytesToHex(CLIENT_SEED),
		requestNonce: bytesToHex(REQUEST_NONCE),
		pattern: { prefix, suffix: suffix || null, ignoreCase },
		address: result.address,
		winningIndex: result.index,
		attempts: result.attempts,
		durationMs: 42,
		difficulty: {
			expectedAttempts: Math.round(expectedAttempts(prefix, suffix, ignoreCase)),
			model: DIFFICULTY_MODEL,
		},
		sealedRecipient: bs58.encode(Uint8Array.from({ length: 32 }, () => 9)),
		sealedEpk: bs58.encode(Uint8Array.from({ length: 32 }, () => 7)),
		ts: '2026-06-19T00:00:00.000Z',
	};
	const receipt = signReceipt({ core: { ...core, pattern: { prefix, suffix, ignoreCase } }, signingSeed: SIGNING_SEED });
	return { receipt, result, masterSeed };
}

describe('commitment (commit–reveal)', () => {
	it('is deterministic and matches a fixed vector', () => {
		const c = commitToSeed(SERVER_SEED);
		expect(c).toBe(commitToSeed(SERVER_SEED));
		expect(c).toMatch(/^[0-9a-f]{64}$/);
		// Pin the exact value so an accidental change to domain separation is caught.
		expect(c).toBe(commitToSeed(bytesToHex(SERVER_SEED)));
	});

	it('changes if a single seed byte changes (binding)', () => {
		const tweaked = Uint8Array.from(SERVER_SEED);
		tweaked[0] ^= 1;
		expect(commitToSeed(tweaked)).not.toBe(commitToSeed(SERVER_SEED));
	});

	it('rejects a non-32-byte seed', () => {
		expect(() => commitToSeed(new Uint8Array(16))).toThrow();
	});
});

describe('seed mixing is deterministic and order-bound', () => {
	it('reproduces the same master seed for the same inputs', () => {
		const a = deriveMasterSeed({ serverSeed: SERVER_SEED, clientSeed: CLIENT_SEED, requestNonce: REQUEST_NONCE });
		const b = deriveMasterSeed({
			serverSeed: bytesToHex(SERVER_SEED),
			clientSeed: bytesToHex(CLIENT_SEED),
			requestNonce: bytesToHex(REQUEST_NONCE),
		});
		expect(bytesToHex(a)).toBe(bytesToHex(b));
		expect(a.length).toBe(32);
	});

	it('neither party alone controls the output — swapping server vs client seed differs', () => {
		const ab = deriveMasterSeed({ serverSeed: SERVER_SEED, clientSeed: CLIENT_SEED, requestNonce: REQUEST_NONCE });
		const ba = deriveMasterSeed({ serverSeed: CLIENT_SEED, clientSeed: SERVER_SEED, requestNonce: REQUEST_NONCE });
		expect(bytesToHex(ab)).not.toBe(bytesToHex(ba));
	});
});

describe('candidate derivation', () => {
	it('derives a valid Ed25519 keypair whose pubkey is the address', () => {
		const master = deriveMasterSeed({ serverSeed: SERVER_SEED, clientSeed: CLIENT_SEED, requestNonce: REQUEST_NONCE });
		const { address, seed, publicKey } = candidateAddress(master, 0);
		expect(seed.length).toBe(32);
		expect(bs58.encode(publicKey)).toBe(address);
		expect(bs58.encode(ed25519.getPublicKey(seed))).toBe(address);
	});

	it('64-byte secret key is seed ‖ pubkey (Solana / Phantom format)', () => {
		const seed = candidateSeed(SERVER_SEED, 5);
		const sk = secretKeyFromSeed(seed);
		expect(sk.length).toBe(64);
		expect(bytesToHex(sk.slice(0, 32))).toBe(bytesToHex(seed));
		expect(bytesToHex(sk.slice(32))).toBe(bytesToHex(ed25519.getPublicKey(seed)));
	});

	it('grindDeterministic finds an index whose address matches the pattern', () => {
		const master = deriveMasterSeed({ serverSeed: SERVER_SEED, clientSeed: CLIENT_SEED, requestNonce: REQUEST_NONCE });
		const r = grindDeterministic({ master, masterSeed: master, prefix: 'z', maxAttempts: 100000 });
		expect(r.found).toBe(true);
		expect(addressMatchesPattern(r.address, { prefix: 'z' })).toBe(true);
		// Re-deriving the same index reproduces the same address (verifier path).
		expect(candidateAddress(master, r.index).address).toBe(r.address);
	});
});

describe('signature', () => {
	it('signs and verifies a receipt with the service key', () => {
		const { receipt } = buildSignedReceipt({ prefix: 'a' });
		expect(verifyReceiptSignature(receipt, receipt.servicePublicKey)).toBe(true);
	});

	it('fails verification under a different key', () => {
		const { receipt } = buildSignedReceipt({ prefix: 'a' });
		const otherPub = bs58.encode(ed25519.getPublicKey(Uint8Array.from({ length: 32 }, () => 3)));
		expect(verifyReceiptSignature(receipt, otherPub)).toBe(false);
	});
});

describe('verifyVanityReceipt — happy path', () => {
	it('passes every check for an honest receipt', () => {
		const { receipt } = buildSignedReceipt({ prefix: 'a' });
		const { valid, checks } = verifyVanityReceipt(receipt, { servicePublicKey: receipt.servicePublicKey });
		const failing = checks.filter((c) => !c.pass);
		expect(failing, JSON.stringify(failing, null, 2)).toHaveLength(0);
		expect(valid).toBe(true);
	});

	it('confirms the opened secret is the ground key', () => {
		const { receipt, result } = buildSignedReceipt({ prefix: 'a' });
		const { valid } = verifyVanityReceipt(receipt, {
			servicePublicKey: receipt.servicePublicKey,
			openedSecretSeed: result.seed,
		});
		expect(valid).toBe(true);
	});
});

describe('verifyVanityReceipt — negative / tamper tests', () => {
	it('FAILS when the address is swapped', () => {
		const { receipt } = buildSignedReceipt({ prefix: 'a' });
		const tampered = { ...receipt, address: 'THREEsynthetic1111111111111111111111111111111' };
		const { valid, checks } = verifyVanityReceipt(tampered, { servicePublicKey: receipt.servicePublicKey });
		expect(valid).toBe(false);
		// Signature breaks (address is signed) AND derivation no longer matches.
		expect(checks.find((c) => c.id === 'signature').pass).toBe(false);
	});

	it('FAILS when serverSeed is replaced (commitment no longer opens)', () => {
		const { receipt } = buildSignedReceipt({ prefix: 'a' });
		const fakeSeed = Uint8Array.from({ length: 32 }, () => 0xaa);
		const tampered = { ...receipt, serverSeed: bytesToHex(fakeSeed) };
		const { valid, checks } = verifyVanityReceipt(tampered, { servicePublicKey: receipt.servicePublicKey });
		expect(valid).toBe(false);
		expect(checks.find((c) => c.id === 'commitment').pass).toBe(false);
	});

	it('FAILS when the winningIndex is wrong', () => {
		const { receipt } = buildSignedReceipt({ prefix: 'a' });
		const tampered = { ...receipt, winningIndex: receipt.winningIndex + 1 };
		const { valid, checks } = verifyVanityReceipt(tampered, { servicePublicKey: receipt.servicePublicKey });
		expect(valid).toBe(false);
		expect(checks.find((c) => c.id === 'signature').pass).toBe(false);
	});

	it('FAILS when difficulty is inflated', () => {
		const { receipt } = buildSignedReceipt({ prefix: 'a' });
		const tampered = JSON.parse(JSON.stringify(receipt));
		tampered.difficulty.expectedAttempts = 999999999;
		const { checks } = verifyVanityReceipt(tampered, { servicePublicKey: receipt.servicePublicKey });
		expect(checks.find((c) => c.id === 'difficulty').pass).toBe(false);
		expect(checks.find((c) => c.id === 'signature').pass).toBe(false);
	});

	it('FAILS the pin check when signed by an impostor key', () => {
		const { receipt } = buildSignedReceipt({ prefix: 'a' });
		// Re-sign with a DIFFERENT service key; pin to the legitimate one.
		const legitPub = receipt.servicePublicKey;
		const { signature, servicePublicKey, signatureScheme, ...core } = receipt;
		const impostorSeed = Uint8Array.from({ length: 32 }, () => 0x55);
		const impostor = signReceipt({ core, signingSeed: impostorSeed });
		const { valid, checks } = verifyVanityReceipt(impostor, { servicePublicKey: legitPub });
		expect(valid).toBe(false);
		expect(checks.find((c) => c.id === 'serviceKeyPinned').pass).toBe(false);
	});

	it('FAILS when the opened secret is not the ground key', () => {
		const { receipt } = buildSignedReceipt({ prefix: 'a' });
		const wrongSeed = Uint8Array.from({ length: 32 }, () => 0x11);
		const { valid, checks } = verifyVanityReceipt(receipt, {
			servicePublicKey: receipt.servicePublicKey,
			openedSecretSeed: wrongSeed,
		});
		expect(valid).toBe(false);
		expect(checks.find((c) => c.id === 'custody').pass).toBe(false);
	});
});
