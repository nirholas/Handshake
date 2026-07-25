/**
 * Cross-implementation tests: a receipt signed by the SERVER protocol module
 * (src/solana/vanity/verifiable-grind.js) must verify under the SDK verifier
 * (solana-agent-sdk/src/vanity/verify.ts), and the SDK's sealed-envelope opener
 * must round-trip against the server's sealer. Both run real @noble crypto —
 * this proves the two independent implementations agree byte-for-byte.
 */

import { describe, it, expect } from 'vitest';
import bs58 from 'bs58';
import { bytesToHex } from '@noble/hashes/utils';

import {
	PROTOCOL_VERSION,
	commitToSeed,
	deriveMasterSeed,
	grindDeterministic,
	signReceipt,
	canonicalReceiptBytes,
	projectSignedCore,
} from '../src/solana/vanity/verifiable-grind.js';
import { expectedAttempts, DIFFICULTY_MODEL } from '../src/solana/vanity/validation.js';
import { sealToRecipient, generateRecipientKeypair } from '../src/solana/vanity/sealed-envelope.js';

// SDK source (TS via vitest's esbuild transform).
import {
	verifyVanityReceipt as sdkVerify,
	VANITY_PROTOCOL_VERSION,
} from '../solana-agent-sdk/src/vanity/verify.ts';
import { openSealedJson } from '../solana-agent-sdk/src/vanity/sealed.ts';

const SERVER_SEED = Uint8Array.from({ length: 32 }, (_, i) => (i * 3 + 5) & 0xff);
const CLIENT_SEED = Uint8Array.from({ length: 32 }, (_, i) => (i * 11 + 2) & 0xff);
const REQUEST_NONCE = Uint8Array.from({ length: 16 }, (_, i) => (i * 13 + 1) & 0xff);
const SIGNING_SEED = Uint8Array.from({ length: 32 }, (_, i) => (i * 5 + 9) & 0xff);

function serverReceipt({ prefix = 'a', sealTo = null } = {}) {
	const master = deriveMasterSeed({ serverSeed: SERVER_SEED, clientSeed: CLIENT_SEED, requestNonce: REQUEST_NONCE });
	const r = grindDeterministic({ masterSeed: master, prefix, maxAttempts: 500000 });
	const core = {
		protocol: PROTOCOL_VERSION,
		receiptType: 'three-vanity-receipt',
		address: r.address,
		pattern: { prefix, suffix: null, ignoreCase: false },
		commitment: commitToSeed(SERVER_SEED),
		serverSeed: bytesToHex(SERVER_SEED),
		clientSeed: bytesToHex(CLIENT_SEED),
		requestNonce: bytesToHex(REQUEST_NONCE),
		winningIndex: r.index,
		attempts: r.attempts,
		durationMs: 7,
		difficulty: { expectedAttempts: Math.round(expectedAttempts(prefix, '', false)), model: DIFFICULTY_MODEL },
		sealed: !!sealTo,
		sealedScheme: sealTo ? 'x25519-hkdf-sha256-aes256gcm/v1' : null,
		sealedRecipient: sealTo ? sealTo.recipient : null,
		sealedEpk: sealTo ? sealTo.epk : null,
		network: 'solana',
		ts: '2026-06-19T12:00:00.000Z',
	};
	return { receipt: signReceipt({ core, signingSeed: SIGNING_SEED }), result: r };
}

describe('server↔SDK protocol parity', () => {
	it('SDK and server agree on the protocol version constant', () => {
		expect(VANITY_PROTOCOL_VERSION).toBe(PROTOCOL_VERSION);
	});

	it('SDK verifies a server-signed receipt with all checks passing', () => {
		const { receipt } = serverReceipt({ prefix: 'a' });
		const { valid, checks } = sdkVerify(receipt, { servicePublicKey: receipt.servicePublicKey });
		const failed = checks.filter((c) => !c.pass);
		expect(failed, JSON.stringify(failed, null, 2)).toHaveLength(0);
		expect(valid).toBe(true);
	});

	it('extra response/UI fields do not perturb the signature (projection)', () => {
		const { receipt } = serverReceipt({ prefix: 'a' });
		const padded = {
			...receipt,
			explorerUrl: 'https://solscan.io/account/x',
			verifyUrl: 'https://three.ws/vanity/verify',
			sealedSecret: { scheme: 'x', epk: 'y', nonce: 'z', ciphertext: 'q' },
			secretKeyBase58: 'should-not-be-signed',
		};
		const { valid } = sdkVerify(padded, { servicePublicKey: receipt.servicePublicKey });
		expect(valid).toBe(true);
		// Projection drops the unsigned extras.
		const core = projectSignedCore(padded);
		expect(core.explorerUrl).toBeUndefined();
		expect(core.sealedSecret).toBeUndefined();
		expect(core.secretKeyBase58).toBeUndefined();
		expect(core.address).toBe(receipt.address);
	});

	it('SDK opens the server-sealed envelope and confirms custody', async () => {
		const recipient = generateRecipientKeypair();
		const { receipt, result } = serverReceipt({ prefix: 'a' });
		const sealed = await sealToRecipient(
			JSON.stringify({
				format: 'keypair',
				secretKeyBase58: bs58.encode(result.secretKey),
				secretKey: Array.from(result.secretKey),
				seed: bytesToHex(result.seed),
			}),
			recipient.publicKey,
		);
		const bundle = openSealedJson(sealed, recipient.secretKey);
		const openedSeed = Uint8Array.from(bundle.secretKey).slice(0, 32);
		expect(bytesToHex(openedSeed)).toBe(bytesToHex(result.seed));
		const { valid } = sdkVerify(receipt, {
			servicePublicKey: receipt.servicePublicKey,
			openedSecretSeed: openedSeed,
		});
		expect(valid).toBe(true);
	});

	it('SDK REJECTS a tampered server receipt', () => {
		const { receipt } = serverReceipt({ prefix: 'a' });
		const tampered = { ...receipt, winningIndex: receipt.winningIndex + 7 };
		const { valid } = sdkVerify(tampered, { servicePublicKey: receipt.servicePublicKey });
		expect(valid).toBe(false);
	});

	it('canonicalReceiptBytes is identical for a receipt and its padded variant', () => {
		const { receipt } = serverReceipt({ prefix: 'a' });
		const a = canonicalReceiptBytes(receipt);
		const b = canonicalReceiptBytes({ ...receipt, junk: 1, sealedSecret: { x: 1 } });
		expect(bytesToHex(a)).toBe(bytesToHex(b));
	});
});
