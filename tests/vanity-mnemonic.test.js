import { describe, it, expect } from 'vitest';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

import {
	generateMnemonic,
	validateMnemonic,
	entropyToMnemonic,
	mnemonicToSeed,
	deriveSolanaKeypair,
	deriveEd25519PrivateKey,
	parseDerivationPath,
	STRENGTH_WORD_COUNTS,
	DEFAULT_DERIVATION_PATH,
} from '../src/solana/vanity/mnemonic.js';
import {
	grindVanityMnemonic,
	expectedMnemonicAttempts,
	MAX_MNEMONIC_PATTERN_LENGTH,
} from '../src/solana/vanity/mnemonic-grinder.js';
import { ENGLISH_WORDLIST } from '../src/solana/vanity/bip39-english.js';

// Canonical BIP-39 "all-zero entropy" mnemonic and its TREZOR-passphrase seed
// (the reference vectors at github.com/trezor/python-mnemonic test vectors).
const ZERO_MNEMONIC =
	'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const ZERO_SEED_TREZOR =
	'c55257c360c07c72029aebc1b53c05ed0362ada38ead3e3e9efa3708e53495531f09a6987599d18264c1e1c92f2cf141630c7a3c4ab7c81b2f001698e7463b04';
// Phantom / Solflare derive m/44'/501'/0'/0' for the first account; this is the
// well-known address for the all-zero mnemonic under that path.
const ZERO_PHANTOM_ADDRESS = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk';

describe('bip39 wordlist', () => {
	it('is exactly 2048 unique words', () => {
		expect(ENGLISH_WORDLIST).toHaveLength(2048);
		expect(new Set(ENGLISH_WORDLIST).size).toBe(2048);
	});
});

describe('mnemonic derivation — canonical vectors', () => {
	it('encodes all-zero entropy to the reference mnemonic', () => {
		expect(entropyToMnemonic(Buffer.alloc(16, 0))).toBe(ZERO_MNEMONIC);
	});

	it('derives the reference seed with the TREZOR passphrase', () => {
		expect(mnemonicToSeed(ZERO_MNEMONIC, 'TREZOR').toString('hex')).toBe(ZERO_SEED_TREZOR);
	});

	it('derives the Phantom address at m/44\'/501\'/0\'/0\'', () => {
		const { keypair, derivationPath } = deriveSolanaKeypair(ZERO_MNEMONIC);
		expect(derivationPath).toBe(DEFAULT_DERIVATION_PATH);
		expect(keypair.publicKey.toBase58()).toBe(ZERO_PHANTOM_ADDRESS);
	});
});

describe('generateMnemonic / validateMnemonic', () => {
	it('generates a valid 12-word mnemonic by default', () => {
		const m = generateMnemonic();
		expect(m.split(' ')).toHaveLength(12);
		expect(validateMnemonic(m)).toBe(true);
	});

	it('supports every standard strength', () => {
		for (const [bits, words] of Object.entries(STRENGTH_WORD_COUNTS)) {
			const m = generateMnemonic(Number(bits));
			expect(m.split(' ')).toHaveLength(words);
			expect(validateMnemonic(m)).toBe(true);
		}
	});

	// Fixed BIP-39 vectors, NOT a freshly generated mnemonic. The final word packs
	// the checksum bits (4 of its 11 bits at 12-word strength), so swapping it for
	// an arbitrary other word lands on a valid checksum 1 time in 16. Tampering a
	// random mnemonic therefore fails this assertion ~6% of runs — measured at
	// 118/2000. Deterministic vectors keep the check meaningful and reproducible.
	it('rejects a mnemonic with a tampered word (bad checksum)', () => {
		const valid = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
		expect(validateMnemonic(valid)).toBe(true);

		// last word carries the checksum → wrong checksum
		const tamperedLast = valid.replace(/about$/, 'abandon');
		expect(validateMnemonic(tamperedLast)).toBe(false);

		// an interior word changes the entropy the checksum was computed over
		const tamperedMiddle = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon zoo about';
		expect(validateMnemonic(tamperedMiddle)).toBe(false);
	});

	it('rejects an out-of-list word and a wrong word count', () => {
		expect(validateMnemonic('not in the bip39 list at all friend')).toBe(false);
		expect(validateMnemonic(generateMnemonic().split(' ').slice(0, 11).join(' '))).toBe(false);
	});

	it('is deterministic: a mnemonic always derives the same address', () => {
		const m = generateMnemonic();
		expect(deriveSolanaKeypair(m).keypair.publicKey.toBase58()).toBe(
			deriveSolanaKeypair(m).keypair.publicKey.toBase58(),
		);
	});

	it('varies the account index in the path', () => {
		const m = generateMnemonic();
		const a0 = deriveSolanaKeypair(m, { account: 0 });
		const a1 = deriveSolanaKeypair(m, { account: 1 });
		expect(a1.derivationPath).toBe("m/44'/501'/1'/0'");
		expect(a0.keypair.publicKey.toBase58()).not.toBe(a1.keypair.publicKey.toBase58());
	});
});

describe('parseDerivationPath / deriveEd25519PrivateKey', () => {
	it('parses a hardened path', () => {
		expect(parseDerivationPath("m/44'/501'/0'/0'")).toEqual([44, 501, 0, 0]);
	});

	it('rejects a non-hardened segment (ed25519 requires hardened)', () => {
		expect(() => parseDerivationPath('m/44/501/0/0')).toThrow();
	});

	it('returns a 32-byte private key', () => {
		const seed = mnemonicToSeed(ZERO_MNEMONIC);
		expect(deriveEd25519PrivateKey(seed, [44, 501, 0, 0])).toHaveLength(32);
	});
});

describe('grindVanityMnemonic', () => {
	it('grinds a 1-char prefix and returns an importable phrase', () => {
		const r = grindVanityMnemonic({ prefix: 'z', timeBudgetMs: 20_000 });
		expect(r.publicKey.startsWith('z')).toBe(true);
		expect(r.wordCount).toBe(12);
		expect(r.derivationPath).toBe(DEFAULT_DERIVATION_PATH);
		expect(r.attempts).toBeGreaterThan(0);

		// The phrase must re-derive to exactly the ground address...
		expect(validateMnemonic(r.mnemonic)).toBe(true);
		expect(deriveSolanaKeypair(r.mnemonic).keypair.publicKey.toBase58()).toBe(r.publicKey);
		// ...and the returned secret key must import to the same address.
		expect(Keypair.fromSecretKey(r.secretKey).publicKey.toBase58()).toBe(r.publicKey);
	});

	it('matches a suffix case-insensitively', () => {
		const r = grindVanityMnemonic({ suffix: 'A', ignoreCase: true, timeBudgetMs: 20_000 });
		expect(r.publicKey.slice(-1).toLowerCase()).toBe('a');
	});

	it('supports 24-word strength', () => {
		const r = grindVanityMnemonic({ prefix: 'a', ignoreCase: true, strength: 256, timeBudgetMs: 20_000 });
		expect(r.wordCount).toBe(24);
		expect(r.mnemonic.split(' ')).toHaveLength(24);
	});

	it('rejects a pattern longer than the mnemonic cap', () => {
		expect(() => grindVanityMnemonic({ prefix: 'abc' })).toThrow(/exceeds/i);
		expect(MAX_MNEMONIC_PATTERN_LENGTH).toBe(2);
	});

	it('throws GrindExhaustedError when the budget runs out', () => {
		// A 2-char pattern with a near-zero budget cannot be found in time.
		expect(() => grindVanityMnemonic({ prefix: 'zz', timeBudgetMs: 1 })).toThrow();
	});

	it('requires at least one of prefix/suffix', () => {
		expect(() => grindVanityMnemonic({})).toThrow(/required/i);
	});
});

describe('expectedMnemonicAttempts', () => {
	it('scales by ~58 per case-sensitive character', () => {
		const one = expectedMnemonicAttempts('a', '', false);
		const two = expectedMnemonicAttempts('ab', '', false);
		expect(Math.round(two / one)).toBe(58);
	});
});
