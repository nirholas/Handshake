/**
 * Premium vanity inventory — unit + (DB-gated) integration tests.
 *
 * Covers the security-critical guarantees of the sell-from-stock tier:
 *   1. Vault seal/open round-trips, and the sealed blob is NOT plaintext.
 *   2. A sealed keypair actually derives its address (the delivered key works).
 *   3. The difficulty→price curve is monotonic and clamped to [$1,$50].
 *   4. The batch grinder produces addresses that match the requested pattern.
 *   5. (DB-gated) single-use reveal + delete-after-reveal: a key is delivered
 *      exactly once and its ciphertext is destroyed — a second reveal gets nothing.
 *
 * The store test only runs when DATABASE_URL points at a throwaway DB/branch;
 * it self-cleans and skips cleanly in CI without one.
 */

// secret-box reads these lazily at seal/open time; set before anything imports it.
process.env.WALLET_ENCRYPTION_KEY ||= 'vitest-ephemeral-wallet-key-000000000000000000';
process.env.JWT_SECRET ||= 'vitest-ephemeral-jwt-secret-00000000000000';

import { describe, it, expect } from 'vitest';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

import { sealSecret, openSecret, preferredScheme, SCHEME_SECRETBOX } from '../api/_lib/vanity-vault.js';
import { priceFromRarity, priceForPattern, MIN_PRICE_USD, MAX_PRICE_USD } from '../api/_lib/vanity-inventory-pricing.js';
import { computeRarity } from '../src/solana/vanity/rarity.js';
import { grindToCompletion } from '../workers/vanity-grinder/wasm-grind.mjs';
import { tryInstantFromInventory, priceAtomicsFor } from '../api/x402/vanity.js';
import { claimVanityMintFromInventory } from '../api/_lib/pump-launch.js';

describe('vanity-vault: seal/open', () => {
	it('round-trips a secret and never stores plaintext', async () => {
		const kp = Keypair.generate();
		const bundle = JSON.stringify({
			format: 'keypair',
			address: kp.publicKey.toBase58(),
			secretKeyBase58: bs58.encode(kp.secretKey),
			secretKey: Array.from(kp.secretKey),
		});
		const { ciphertext, scheme } = await sealSecret(bundle);

		// Without KMS configured, the default scheme is secret-box AES-256-GCM.
		expect(scheme).toBe(SCHEME_SECRETBOX);
		expect(preferredScheme()).toBe(SCHEME_SECRETBOX);
		// The ciphertext must not leak the key material.
		expect(ciphertext).not.toContain(bundle);
		expect(ciphertext).not.toContain(bs58.encode(kp.secretKey));
		expect(/secretKey/.test(ciphertext)).toBe(false);

		const opened = JSON.parse(await openSecret(ciphertext, scheme));
		expect(opened.address).toBe(kp.publicKey.toBase58());
		// The delivered key actually reconstructs the keypair for the address.
		const restored = Keypair.fromSecretKey(Uint8Array.from(opened.secretKey));
		expect(restored.publicKey.toBase58()).toBe(kp.publicKey.toBase58());
	});

	it('fails to open a corrupted ciphertext (authenticated encryption)', async () => {
		const { ciphertext, scheme } = await sealSecret('top-secret');
		const corrupted = ciphertext.slice(0, -4) + 'AAAA';
		await expect(openSecret(corrupted, scheme)).rejects.toBeTruthy();
	});
});

describe('vanity-inventory-pricing: difficulty → price curve', () => {
	it('clamps to [MIN, MAX] and rises with difficulty', () => {
		const p2 = priceForPattern({ prefix: 'ab' });          // ~2 chars
		const p4 = priceForPattern({ prefix: 'PUMP' });        // 4 chars
		const p5 = priceForPattern({ prefix: 'THREE' });       // 5 chars

		for (const p of [p2, p4, p5]) {
			expect(p.priceUsd).toBeGreaterThanOrEqual(MIN_PRICE_USD);
			expect(p.priceUsd).toBeLessThanOrEqual(MAX_PRICE_USD);
			expect(p.priceAtomics).toBe(Math.round(p.priceUsd * 1e6));
		}
		// Monotonic in difficulty.
		expect(p4.priceUsd).toBeGreaterThan(p2.priceUsd);
		expect(p5.priceUsd).toBeGreaterThanOrEqual(p4.priceUsd);
		// A hard 5-char pattern lands in the upper band.
		expect(p5.priceUsd).toBeGreaterThan(20);
	});

	it('never exceeds the ceiling even for an absurd pattern', () => {
		const rarity = computeRarity({ prefix: 'ABCDEFGH', suffix: 'ZYXW' });
		const { priceUsd } = priceFromRarity(rarity);
		expect(priceUsd).toBe(MAX_PRICE_USD);
	});
});

describe('batch grinder: produced addresses match the pattern', () => {
	it('grinds a 2-char prefix whose address starts with it', () => {
		const res = grindToCompletion({ prefix: 'ab', ignoreCase: true }, { maxAttempts: 5_000_000 });
		expect(res.status).toBe('found');
		expect(res.publicKey.toLowerCase().startsWith('ab')).toBe(true);
		// The secret key is a valid 64-byte Ed25519 key that derives the address.
		const kp = Keypair.fromSecretKey(res.secretKey);
		expect(kp.publicKey.toBase58()).toBe(res.publicKey);
	}, 30_000);

	it('gives up (exhausted) instead of hanging on an impossible cap', () => {
		// Tiny cap → returns exhausted rather than looping forever. Small batches
		// keep this a loop-contract test (multiple batches, then give up at the
		// cap) instead of a 50k-key CPU burn: at ~3s per 25k-key batch on a
		// contended CI host, the default batch size ran right into the 15s budget.
		const res = grindToCompletion({ prefix: 'zzzzz' }, { maxAttempts: 2_000, batchSize: 1_000 });
		expect(res.status).toBe('exhausted');
		expect(res.attempts).toBeGreaterThanOrEqual(2_000);
	}, 15_000);
});

// ── DB-gated: single-use reveal + delete-after-reveal ────────────────────────
const HAS_DB = Boolean(process.env.DATABASE_URL);
describe.skipIf(!HAS_DB)('vanity-inventory-store: single-use delivery (needs DATABASE_URL)', () => {
	it('delivers a key exactly once and destroys the ciphertext', async () => {
		const store = await import('../api/_lib/vanity-inventory-store.js');
		const kp = Keypair.generate();
		const address = kp.publicKey.toBase58();
		const { ciphertext, scheme } = await sealSecret(
			JSON.stringify({ format: 'keypair', address, secretKeyBase58: bs58.encode(kp.secretKey), secretKey: Array.from(kp.secretKey) }),
		);

		await store.upsertInventoryItem({
			address, patternLabel: 'TEST…', prefix: null, suffix: null,
			difficultyAttempts: 1000, rarityBits: 6, rarityTier: 'uncommon', rarityScore: 600,
			secretCiphertext: ciphertext, secretScheme: scheme, priceUsd: 1, retentionDays: 0,
		});

		const paymentId = 'test-pay-' + address.slice(0, 8);
		const reserved = await store.reserveForPurchase(address, { paymentId, purchaser: 'tester' });
		expect(reserved.ok).toBe(true);

		// First reveal returns the ciphertext and (retention 0) destroys it.
		const first = await store.reserveAndReveal(address, { paymentId });
		expect(first.ok).toBe(true);
		expect(first.destroyed).toBe(true);
		const opened = JSON.parse(await openSecret(first.ciphertext, first.scheme));
		expect(Keypair.fromSecretKey(Uint8Array.from(opened.secretKey)).publicKey.toBase58()).toBe(address);

		// Second reveal gets nothing — single use enforced server-side.
		const second = await store.reserveAndReveal(address, { paymentId });
		expect(second.ok).toBe(false);
		expect(second.reason).toBe('already_revealed');

		// The public item is now destroyed and holds no ciphertext.
		const pub = await store.getPublicItem(address);
		expect(pub.status).toBe('destroyed');
	});
});

// ── DB-gated: instant inventory — live-grind + pump-launch upsell ───────────
// Covers the wiring in api/x402/vanity.js (tryInstantFromInventory) and
// api/_lib/pump-launch.js (claimVanityMintFromInventory): an inventory hit is
// served instantly (no grinding) and consumed exactly once; a miss returns
// null so the caller falls straight through to its existing live-grind path,
// unchanged.
const BASE58_CHARS = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function randPrefix(n = 2) {
	let s = '';
	for (let i = 0; i < n; i++) s += BASE58_CHARS[Math.floor(Math.random() * BASE58_CHARS.length)];
	return s;
}

// Grinds a real keypair matching `prefix`, seals it, and inserts it as an
// available inventory item — the same shape workers/vanity-grinder produces.
async function seedInventoryItem(store, { prefix, ignoreCase = true, priceUsd = 0.01 }) {
	const g = grindToCompletion({ prefix, ignoreCase }, { maxAttempts: 5_000_000 });
	expect(g.status).toBe('found');
	const kp = Keypair.fromSecretKey(g.secretKey);
	const address = kp.publicKey.toBase58();
	const { ciphertext, scheme } = await sealSecret(
		JSON.stringify({ format: 'keypair', address, secretKeyBase58: bs58.encode(kp.secretKey), secretKey: Array.from(kp.secretKey) }),
	);
	await store.upsertInventoryItem({
		address, patternLabel: prefix, prefix, suffix: null, ignoreCase,
		difficultyAttempts: g.attempts, rarityBits: 6, rarityTier: 'uncommon', rarityScore: 600,
		secretCiphertext: ciphertext, secretScheme: scheme, priceUsd, retentionDays: 0,
	});
	return address;
}

describe.skipIf(!HAS_DB)('instant inventory: live-grind + pump-launch upsell (needs DATABASE_URL)', () => {
	it('claimMatchingPattern: an instant hit is consumed — a second claim of the same pattern gets no_match', async () => {
		const store = await import('../api/_lib/vanity-inventory-store.js');
		const prefix = randPrefix(2);
		const address = await seedInventoryItem(store, { prefix, priceUsd: 0.01 });

		const first = await store.claimMatchingPattern({
			prefix, ignoreCase: true, format: 'keypair', maxPriceUsd: 0.05, paymentId: 'claim-a-' + prefix, purchaser: 'tester',
		});
		expect(first.ok).toBe(true);
		expect(first.item.address).toBe(address);

		// Same pattern, different payment — the item is already reserved, so no
		// second buyer can claim (or ever be served) the same address.
		const second = await store.claimMatchingPattern({
			prefix, ignoreCase: true, format: 'keypair', maxPriceUsd: 0.05, paymentId: 'claim-b-' + prefix, purchaser: 'tester2',
		});
		expect(second.ok).toBe(false);
		expect(second.reason).toBe('no_match');

		// Finalize like the endpoint does after settle — reveal destroys it.
		const revealed = await store.reserveAndReveal(address, { paymentId: 'claim-a-' + prefix });
		expect(revealed.ok).toBe(true);
		expect(revealed.destroyed).toBe(true);
	});

	it('claimMatchingPattern: two concurrent claims for the last matching row — exactly one wins', async () => {
		const store = await import('../api/_lib/vanity-inventory-store.js');
		const prefix = randPrefix(2);
		const address = await seedInventoryItem(store, { prefix, priceUsd: 0.01 });

		const [a, b] = await Promise.all([
			store.claimMatchingPattern({ prefix, ignoreCase: true, format: 'keypair', paymentId: 'race-a-' + prefix, purchaser: 'a' }),
			store.claimMatchingPattern({ prefix, ignoreCase: true, format: 'keypair', paymentId: 'race-b-' + prefix, purchaser: 'b' }),
		]);
		const winners = [a, b].filter((r) => r.ok);
		const losers = [a, b].filter((r) => !r.ok);
		expect(winners).toHaveLength(1);
		expect(losers).toHaveLength(1);
		expect(winners[0].item.address).toBe(address);
		expect(losers[0].reason).toBe('no_match');

		// Clean up: finalize the winning reservation so no row is left stranded
		// in 'reserved' status.
		const winnerPaymentId = a.ok ? 'race-a-' + prefix : 'race-b-' + prefix;
		await store.reserveAndReveal(address, { paymentId: winnerPaymentId });
	});

	it('claimMatchingPattern: no matching item returns no_match without throwing (the grind-fallback signal)', async () => {
		const store = await import('../api/_lib/vanity-inventory-store.js');
		const miss = await store.claimMatchingPattern({
			prefix: randPrefix(4), ignoreCase: true, format: 'keypair', paymentId: 'miss-' + randPrefix(4),
		});
		expect(miss.ok).toBe(false);
		expect(miss.reason).toBe('no_match');
	});

	it('claimMatchingPattern: maxPriceUsd keeps a premium item out of the cheap live-grind tier', async () => {
		const store = await import('../api/_lib/vanity-inventory-store.js');
		const prefix = randPrefix(2);
		const address = await seedInventoryItem(store, { prefix, priceUsd: 10 });

		// The live-grind tier's ceiling for a 2-char pattern ($0.05) must not match
		// a $10 item — it stays reserved for the priced premium tier.
		const capped = await store.claimMatchingPattern({
			prefix, ignoreCase: true, format: 'keypair', maxPriceUsd: 0.05, paymentId: 'cap-' + prefix,
		});
		expect(capped.ok).toBe(false);
		expect(capped.reason).toBe('no_match');

		// Without (or above) the price ceiling, the same item is claimable.
		const uncapped = await store.claimMatchingPattern({
			prefix, ignoreCase: true, format: 'keypair', maxPriceUsd: 10, paymentId: 'uncap-' + prefix,
		});
		expect(uncapped.ok).toBe(true);
		expect(uncapped.item.address).toBe(address);

		// Clean up: finalize the reservation so no row is left stranded.
		await store.reserveAndReveal(address, { paymentId: 'uncap-' + prefix });
	});

	it('tryInstantFromInventory (api/x402/vanity.js): serves an inventory hit instantly with source=inventory, then consumes it', async () => {
		const store = await import('../api/_lib/vanity-inventory-store.js');
		const prefix = randPrefix(2);
		const address = await seedInventoryItem(store, { prefix, priceUsd: 0.01 });
		const pattern = { prefix, suffix: '', ignoreCase: true, format: 'keypair', combinedLength: prefix.length, sealTo: null };
		expect(priceAtomicsFor('keypair', prefix.length)).toBeGreaterThanOrEqual(10_000); // sanity: $0.01 item is within the tier's ceiling

		const hit = await tryInstantFromInventory(pattern, { paymentId: 'vinv-' + prefix, purchaser: 'tester' });
		expect(hit).toBeTruthy();
		expect(hit.result.source).toBe('inventory');
		expect(hit.result.address).toBe(address);
		expect(hit.result.secretKeyBase58).toBeTruthy();
		// The delivered secret key actually reconstructs the vanity address.
		const restored = Keypair.fromSecretKey(bs58.decode(hit.result.secretKeyBase58));
		expect(restored.publicKey.toBase58()).toBe(address);

		// Finalize (what the endpoint does after settle) — the item is now gone.
		await store.reserveAndReveal(address, { paymentId: 'vinv-' + prefix });
		const again = await tryInstantFromInventory(pattern, { paymentId: 'vinv2-' + prefix, purchaser: 'tester' });
		expect(again).toBeNull();
	});

	it('tryInstantFromInventory (api/x402/vanity.js): no match returns null so the caller falls through to grind', async () => {
		const pattern = { prefix: randPrefix(4), suffix: '', ignoreCase: true, format: 'keypair', combinedLength: 4, sealTo: null };
		const miss = await tryInstantFromInventory(pattern, { paymentId: 'vmiss-' + pattern.prefix, purchaser: 'tester' });
		expect(miss).toBeNull();
	});

	it('claimVanityMintFromInventory (api/_lib/pump-launch.js): delivers a usable mint keypair instantly, then consumes it', async () => {
		const store = await import('../api/_lib/vanity-inventory-store.js');
		const prefix = randPrefix(2);
		const address = await seedInventoryItem(store, { prefix, priceUsd: 0.01 });

		const claim = await claimVanityMintFromInventory({ prefix, ignoreCase: true, paymentId: 'pl-' + prefix, purchaser: 'tester' });
		expect(claim).toBeTruthy();
		expect(claim.address).toBe(address);
		expect(claim.mintKeypair.publicKey.toBase58()).toBe(address);

		// Simulates a successful on-chain launch: finalize the claim.
		await claim.reveal();
		const again = await claimVanityMintFromInventory({ prefix, ignoreCase: true, paymentId: 'pl2-' + prefix, purchaser: 'tester' });
		expect(again).toBeNull();
	});

	it('claimVanityMintFromInventory: release() puts a failed-launch claim back to available for reuse', async () => {
		const store = await import('../api/_lib/vanity-inventory-store.js');
		const prefix = randPrefix(2);
		const address = await seedInventoryItem(store, { prefix, priceUsd: 0.01 });

		const claim = await claimVanityMintFromInventory({ prefix, ignoreCase: true, paymentId: 'plr-' + prefix, purchaser: 'tester' });
		expect(claim).toBeTruthy();

		// Simulates a launch failure BEFORE the mint touched the chain.
		await claim.release();
		const pub = await store.getPublicItem(address);
		expect(pub.status).toBe('available');

		// Now claimable again.
		const retry = await claimVanityMintFromInventory({ prefix, ignoreCase: true, paymentId: 'plr2-' + prefix, purchaser: 'tester' });
		expect(retry).toBeTruthy();
		expect(retry.address).toBe(address);
		await retry.reveal();
	});
});

// ── Premium 4–5 char band: priced above the grind cap, inventory-only ───────
// GET /api/x402/vanity now OFFERS 4–5 char patterns, but — unlike the ≤3 char
// tiers — they are NEVER ground live (58^4-58^5 attempts is minutes-to-hours,
// far past the 45s budget). These cover the pricing curve and the read-only
// stock gate (hasAvailableMatch) the endpoint consults BEFORE quoting a 402,
// so a buyer is never asked to pay for a pattern that isn't in stock.
describe('vanity.js: premium 4–5 char tiers (inventory-only, priced above the grind cap)', () => {
	it('priceAtomicsFor: 4 and 5 char keypair patterns price at the premium tiers, well above the 3-char cap', () => {
		const p3 = priceAtomicsFor('keypair', 3);
		const p4 = priceAtomicsFor('keypair', 4);
		const p5 = priceAtomicsFor('keypair', 5);
		expect(p3).toBe(250_000); // $0.25 — unchanged grind-cap tier
		expect(p4).toBe(2_500_000); // $2.50 default
		expect(p5).toBe(10_000_000); // $10 default
		expect(p4).toBeGreaterThan(p3);
		expect(p5).toBeGreaterThan(p4);
	});

	it('priceAtomicsFor: mnemonic format is not extended into the premium band (stays capped at 2 chars)', () => {
		// Mnemonic has no inventory backing (the batch grinder only stocks raw
		// keypairs), so length 4 falls back to the format's own max-length price,
		// not a premium tier.
		expect(priceAtomicsFor('mnemonic', 4)).toBe(priceAtomicsFor('mnemonic', 2));
	});

	it('priceAtomicsFor: X402_PRICE_VANITY_4 / X402_PRICE_VANITY_5 env overrides are honored', () => {
		process.env.X402_PRICE_VANITY_4 = '3000000';
		process.env.X402_PRICE_VANITY_5 = '15000000';
		try {
			expect(priceAtomicsFor('keypair', 4)).toBe(3_000_000);
			expect(priceAtomicsFor('keypair', 5)).toBe(15_000_000);
		} finally {
			delete process.env.X402_PRICE_VANITY_4;
			delete process.env.X402_PRICE_VANITY_5;
		}
	});

	const HAS_DB2 = Boolean(process.env.DATABASE_URL);
	describe.skipIf(!HAS_DB2)('hasAvailableMatch: the pre-402 stock gate (needs DATABASE_URL)', () => {
		it('returns false for a 4-char pattern with no inventory match — the "not in stock" case', async () => {
			const store = await import('../api/_lib/vanity-inventory-store.js');
			const prefix = randPrefix(4);
			const inStock = await store.hasAvailableMatch({ prefix, ignoreCase: true, format: 'keypair' });
			expect(inStock).toBe(false);
		});

		it('returns true once a matching item is seeded, and never reserves it (read-only)', async () => {
			const store = await import('../api/_lib/vanity-inventory-store.js');
			const prefix = randPrefix(2); // 2 chars is fast to seed; the check itself is length-agnostic
			const address = await seedInventoryItem(store, { prefix, priceUsd: 2.5 });

			const inStock = await store.hasAvailableMatch({ prefix, ignoreCase: true, format: 'keypair' });
			expect(inStock).toBe(true);

			// Read-only: the item must still be claimable afterward (not reserved
			// by the stock check itself).
			const claim = await store.claimMatchingPattern({ prefix, ignoreCase: true, format: 'keypair', paymentId: 'stockcheck-' + prefix });
			expect(claim.ok).toBe(true);
			expect(claim.item.address).toBe(address);
			await store.reserveAndReveal(address, { paymentId: 'stockcheck-' + prefix });
		});
	});
});
