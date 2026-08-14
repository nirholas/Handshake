import { describe, it, expect } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3';
import { computeAddress, Wallet } from 'ethers';
import {
	validatePattern,
	estimateAttempts,
	letterCount,
	eip55Checksum,
} from '../../src/eth/vanity/validation.js';

/**
 * The EOA grinder worker runs in a Web Worker that vitest can't spawn, so we
 * re-implement its hot loop here byte-for-byte and assert:
 *   • the derived address equals ethers (the canonical reference),
 *   • the incremental point-addition trick stays consistent with a fresh
 *     scalar multiply (the thing that could silently drift and hand a user a
 *     key that doesn't control the advertised address),
 *   • a real grind actually produces a key that controls its address,
 *   • the encrypted-keystore export path round-trips.
 */

const Point = secp256k1.Point;
const N = Point.Fn.ORDER;
const HEX = '0123456789abcdef';

function bytesToHex(b) {
	let s = '';
	for (let i = 0; i < b.length; i++) s += HEX[b[i] >> 4] + HEX[b[i] & 0xf];
	return s;
}
function scalarToBytes(k) {
	let hex = (((k % N) + N) % N).toString(16);
	if (hex.length < 64) hex = '0'.repeat(64 - hex.length) + hex;
	const out = new Uint8Array(32);
	for (let i = 0; i < 32; i++) out[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
	return out;
}
/** keccak256(pubkey[1:])[12:] → 40 lowercase hex chars. */
function addressOfPubkey(uncompressed) {
	return bytesToHex(keccak_256(uncompressed.subarray(1)).subarray(12));
}
function addressOfScalar(k) {
	return addressOfPubkey(Point.BASE.multiply(k).toBytes(false));
}

/** Mirror the worker hot loop: incremental walk from a base scalar. */
function grindInProcess({ prefix = '', suffix = '', caseSensitive = false, maxSteps = 5_000_000 }) {
	const wantP = caseSensitive ? prefix : prefix.toLowerCase();
	const wantS = caseSensitive ? suffix : suffix.toLowerCase();
	// Deterministic base so the test is reproducible (the real worker uses CSPRNG).
	let k0 = 0x9e3779b97f4a7c15n;
	let pt = Point.BASE.multiply(k0);
	for (let i = 0n; i < BigInt(maxSteps); i++) {
		const lowerHex = addressOfPubkey(pt.toBytes(false));
		const candidate = caseSensitive ? '0x' + eip55Checksum(lowerHex) : lowerHex;
		const cand = caseSensitive ? candidate.slice(2) : candidate;
		const headOk = !wantP || cand.startsWith(wantP);
		const tailOk = !wantS || cand.endsWith(wantS);
		if (headOk && tailOk) {
			const priv = scalarToBytes(k0 + i);
			return { address: '0x' + lowerHex, privateKey: '0x' + bytesToHex(priv), steps: Number(i) + 1 };
		}
		pt = pt.add(Point.BASE);
	}
	throw new Error('no match within maxSteps');
}

describe('evm eoa grinder · derivation parity', () => {
	it('matches ethers for the canonical privkey=1 / =2 vectors', () => {
		expect(addressOfScalar(1n)).toBe('7e5f4552091a69125d5dfcb7b8c2659029395bdf');
		expect('0x' + addressOfScalar(1n)).toBe(computeAddress('0x' + '00'.repeat(31) + '01').toLowerCase());
		expect('0x' + addressOfScalar(2n)).toBe(computeAddress('0x' + '00'.repeat(31) + '02').toLowerCase());
	});

	it('incremental point-add stays consistent with a fresh scalar multiply', () => {
		let k0 = 0x1234_5678_9abc_def0n;
		let pt = Point.BASE.multiply(k0);
		for (let i = 0n; i < 200n; i++) {
			// Running point must equal multiply(k0+i); the address must equal ethers'.
			expect(pt.toHex()).toBe(Point.BASE.multiply(k0 + i).toHex());
			const addr = '0x' + addressOfPubkey(pt.toBytes(false));
			const priv = '0x' + bytesToHex(scalarToBytes(k0 + i));
			expect(addr).toBe(computeAddress(priv).toLowerCase());
			pt = pt.add(Point.BASE);
		}
	});
});

describe('evm eoa grinder · self-verification invariant', () => {
	it('every reconstructed key controls its address via an independent path', () => {
		// The worker self-verifies with getPublicKey (fresh), not the running point.
		for (const k of [1n, 7n, 999_983n, N - 1n]) {
			const priv = scalarToBytes(k);
			const viaRunningPoint = addressOfScalar(k);
			const viaGetPublicKey = addressOfPubkey(secp256k1.getPublicKey(priv, false));
			expect(viaGetPublicKey).toBe(viaRunningPoint);
			expect('0x' + viaGetPublicKey).toBe(new Wallet('0x' + bytesToHex(priv)).address.toLowerCase());
		}
	});
});

describe('evm eoa grinder · end-to-end grind', () => {
	it('finds a 2-hex prefix and returns a key that owns the address', () => {
		const { address, privateKey, steps } = grindInProcess({ prefix: 'ee' });
		expect(address.slice(2).startsWith('ee')).toBe(true);
		// The single source of truth: ethers derives the SAME address from the key.
		expect(computeAddress(privateKey).toLowerCase()).toBe(address);
		expect(steps).toBeGreaterThan(0);
	});

	it('finds a prefix + suffix together', () => {
		const { address, privateKey } = grindInProcess({ prefix: 'a', suffix: 'b' });
		const body = address.slice(2);
		expect(body.startsWith('a')).toBe(true);
		expect(body.endsWith('b')).toBe(true);
		expect(computeAddress(privateKey).toLowerCase()).toBe(address);
	});

	it('honours an EIP-55 checksum (mixed-case) prefix', () => {
		const { address, privateKey } = grindInProcess({ prefix: 'A', caseSensitive: true });
		// The checksummed address must actually start with uppercase A.
		const checksummed = computeAddress(privateKey); // ethers returns EIP-55
		expect(checksummed).toBe('0x' + eip55Checksum(address.slice(2)));
		expect(checksummed.slice(2).startsWith('A')).toBe(true);
	});
});

describe('evm eoa grinder · pattern validation', () => {
	it('lowercase is case-insensitive, mixed case is checksum mode', () => {
		expect(validatePattern('beef')).toMatchObject({ valid: true, caseSensitive: false, normalized: 'beef' });
		expect(validatePattern('BeeF')).toMatchObject({ valid: true, caseSensitive: true, normalized: 'BeeF' });
	});
	it('rejects non-hex and over-length', () => {
		expect(validatePattern('xyz').valid).toBe(false);
		expect(validatePattern('abcdef01234').valid).toBe(false); // 11 > MAX 10
	});
	it('estimates checksum patterns as harder per letter', () => {
		const ci = estimateAttempts(4, letterCount('beef'), false);
		const cs = estimateAttempts(4, letterCount('beef'), true);
		expect(cs).toBe(ci * Math.pow(2, 4)); // 4 letters → 2^4 tax
	});
});

describe('evm eoa grinder · encrypted keystore export round-trip', () => {
	it('encrypt → fromEncryptedJson recovers the same key (the UI export path)', async () => {
		const { address, privateKey } = grindInProcess({ prefix: 'f' });
		const wallet = new Wallet(privateKey);
		const json = await wallet.encrypt('correct horse battery staple');
		const recovered = await Wallet.fromEncryptedJson(json, 'correct horse battery staple');
		expect(recovered.address.toLowerCase()).toBe(address);
		// Wrong password must fail — never silently return a different key.
		await expect(Wallet.fromEncryptedJson(json, 'wrong')).rejects.toThrow();
		// No per-test budget: this runs three real scrypt derivations at ethers'
		// default keystore cost (N=131072) - encrypt, decrypt, wrong-password
		// decrypt - which is ~31s on this box and slower under suite load. The
		// point of the test is the round trip at the cost the UI actually uses, so
		// it inherits the configured testTimeout rather than racing a stopwatch.
	});
});
