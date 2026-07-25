// Pins the grind-bounty market protocol + escrow store behavior:
//   • pattern matching honesty (mirrors the grinder matcher)
//   • secret-blind claim verification (address match + seal addressed to requester)
//   • difficulty→price oracle band + monotonicity
//   • deterministic bounty id / claim digest vectors
//   • atomic single-winner claim (two-worker race) + exactly-once idempotency
//   • expiry refund mutual-exclusion with settlement
//
// Runs entirely on the in-memory store fallback (no Redis in CI) and real crypto
// (sealed-envelope ECIES, @noble Ed25519/X25519) — no mocks.

import { describe, it, expect, beforeEach } from 'vitest';

import {
	BOUNTY_PROTOCOL_VERSION,
	normalizeBountyPattern,
	addressMatchesPattern,
	suggestBountyAtomics,
	validateBountyAtomics,
	deriveBountyId,
	claimDigest,
	verifyClaimEnvelope,
	PRICING,
} from '../src/solana/vanity/bounty-protocol.js';
import {
	generateRecipientKeypair,
	sealToRecipient,
	openSealed,
	SEALED_ENVELOPE_SCHEME,
} from '../src/solana/vanity/sealed-envelope.js';
import {
	createBounty,
	claimBounty,
	markRefundable,
	getBountyRecord,
	queryBounties,
	__resetMemoryStore,
} from '../api/_lib/vanity-bounty-store.js';

// A real Solana address with a known prefix — derive one deterministically so the
// vectors are stable. ed25519 pubkey of a fixed seed, then we just assert the
// matcher against literal strings (matcher is pure string logic).
function addrWithPrefix(prefix) {
	// Build a synthetic 44-char Base58 address that starts with `prefix`. The
	// matcher is pure string logic, so a synthetic-but-well-formed address is a
	// valid test input (we are testing the matcher, not key derivation here).
	const filler = '1111111111111111111111111111111111111111111';
	return (prefix + filler).slice(0, 44);
}

describe('addressMatchesPattern', () => {
	it('honors prefix, suffix, and combined', () => {
		expect(addressMatchesPattern(addrWithPrefix('THREE'), { prefix: 'THREE' })).toBe(true);
		expect(addressMatchesPattern(addrWithPrefix('THREE'), { prefix: 'FOUR' })).toBe(false);
		const a = ('SoL' + '2'.repeat(38) + 'end').slice(0, 44);
		expect(addressMatchesPattern(a, { prefix: 'SoL', suffix: 'end' })).toBe(true);
		expect(addressMatchesPattern(a, { prefix: 'SoL', suffix: 'XXX' })).toBe(false);
	});

	it('respects ignoreCase', () => {
		const a = addrWithPrefix('Three');
		expect(addressMatchesPattern(a, { prefix: 'three' })).toBe(false);
		expect(addressMatchesPattern(a, { prefix: 'three', ignoreCase: true })).toBe(true);
	});

	it('rejects malformed (non-Base58) addresses', () => {
		expect(addressMatchesPattern('not an address', { prefix: 'no' })).toBe(false);
		expect(addressMatchesPattern('', { prefix: '' })).toBe(false);
	});
});

describe('normalizeBountyPattern', () => {
	it('requires at least one of prefix/suffix', () => {
		expect(() => normalizeBountyPattern({})).toThrow();
	});
	it('rejects non-Base58 characters', () => {
		expect(() => normalizeBountyPattern({ prefix: 'l0O' })).toThrow(); // 0,O,l are excluded
	});
	it('computes difficulty from the exact Base58 distribution', () => {
		const r = normalizeBountyPattern({ prefix: 'ab' });
		expect(r.prefix).toBe('ab');
		expect(r.combinedLength).toBe(2);
		// Not 58² = 3364. 'a' can only lead a 43-digit encoding (~5.9% of keys),
		// so it costs ~999 attempts, not 58, a bounty priced at 58² would
		// underfund the grinder it is meant to pay by ~17×.
		expect(r.expectedAttempts).toBe(57960);
		expect(r.expectedAttempts / (58 * 58)).toBeCloseTo(17.23, 1);
	});
});

describe('suggestBountyAtomics (difficulty→price oracle)', () => {
	it('stays inside the legal band', () => {
		const cheap = suggestBountyAtomics({ prefix: 'a' });
		expect(cheap.suggestedAtomics).toBeGreaterThanOrEqual(PRICING.floorAtomics);
		const huge = suggestBountyAtomics({ prefix: 'THREEws' });
		expect(huge.suggestedAtomics).toBeLessThanOrEqual(PRICING.maxAtomics);
	});
	it('is monotonic in difficulty (harder ⇒ ≥ price)', () => {
		const p3 = suggestBountyAtomics({ prefix: 'abc' }).suggestedAtomics;
		const p4 = suggestBountyAtomics({ prefix: 'abcd' }).suggestedAtomics;
		const p5 = suggestBountyAtomics({ prefix: 'abcde' }).suggestedAtomics;
		expect(p4).toBeGreaterThanOrEqual(p3);
		expect(p5).toBeGreaterThanOrEqual(p4);
	});
	it('generous tier exceeds suggested', () => {
		const o = suggestBountyAtomics({ prefix: 'abcd' });
		expect(o.generousAtomics).toBeGreaterThanOrEqual(o.suggestedAtomics);
	});
});

describe('validateBountyAtomics', () => {
	it('rejects below floor and above ceiling', () => {
		expect(() => validateBountyAtomics(1)).toThrow();
		expect(() => validateBountyAtomics(PRICING.maxAtomics + 1)).toThrow();
		expect(validateBountyAtomics(PRICING.floorAtomics)).toBe(PRICING.floorAtomics);
	});
});

describe('deriveBountyId / claimDigest determinism', () => {
	it('is deterministic + sensitive to every field', () => {
		const base = { recipient: 'Rec111', pattern: { prefix: 'ab', suffix: '', ignoreCase: false }, amountAtomics: 100000, nonce: 'deadbeef' };
		const id1 = deriveBountyId(base);
		const id2 = deriveBountyId({ ...base });
		expect(id1).toBe(id2);
		expect(id1).toMatch(/^[0-9a-f]{24}$/);
		expect(deriveBountyId({ ...base, nonce: 'cafe' })).not.toBe(id1);
		expect(deriveBountyId({ ...base, amountAtomics: 200000 })).not.toBe(id1);
		expect(deriveBountyId({ ...base, recipient: 'Other' })).not.toBe(id1);
	});

	it('claimDigest binds bountyId + address + ciphertext', () => {
		const env = { epk: 'E', nonce: 'N', ciphertext: 'C' };
		const d1 = claimDigest({ bountyId: 'b1', address: 'Addr', sealedSecret: env });
		expect(d1).toMatch(/^[0-9a-f]{32}$/);
		expect(claimDigest({ bountyId: 'b1', address: 'Addr', sealedSecret: env })).toBe(d1);
		expect(claimDigest({ bountyId: 'b2', address: 'Addr', sealedSecret: env })).not.toBe(d1);
		expect(claimDigest({ bountyId: 'b1', address: 'Other', sealedSecret: env })).not.toBe(d1);
		expect(claimDigest({ bountyId: 'b1', address: 'Addr', sealedSecret: { ...env, ciphertext: 'X' } })).not.toBe(d1);
	});
});

describe('verifyClaimEnvelope (secret-blind anti-cheat)', () => {
	let requester;
	let bounty;
	const matchingAddr = addrWithPrefix('THREE');

	beforeEach(() => {
		requester = generateRecipientKeypair(); // X25519 keypair (Base58)
		bounty = { pattern: { prefix: 'THREE', suffix: null, ignoreCase: false }, recipient: requester.publicKey };
	});

	it('accepts a matching address sealed to the requester', async () => {
		const sealed = await sealToRecipient(JSON.stringify({ secret: 'x' }), requester.publicKey);
		const r = verifyClaimEnvelope(bounty, { address: matchingAddr, sealedSecret: sealed });
		expect(r.ok).toBe(true);
		expect(sealed.scheme).toBe(SEALED_ENVELOPE_SCHEME);
	});

	it('REJECTS a non-matching address', async () => {
		const sealed = await sealToRecipient('x', requester.publicKey);
		const r = verifyClaimEnvelope(bounty, { address: addrWithPrefix('OTHER'), sealedSecret: sealed });
		expect(r.ok).toBe(false);
		expect(r.checks.find((c) => c.id === 'pattern').pass).toBe(false);
	});

	it('REJECTS an envelope sealed to someone else (worker cannot keep the key)', async () => {
		const attacker = generateRecipientKeypair();
		const sealedToAttacker = await sealToRecipient('x', attacker.publicKey);
		const r = verifyClaimEnvelope(bounty, { address: matchingAddr, sealedSecret: sealedToAttacker });
		expect(r.ok).toBe(false);
		expect(r.checks.find((c) => c.id === 'sealed-to-requester').pass).toBe(false);
	});

	it('REJECTS a malformed envelope', () => {
		const r = verifyClaimEnvelope(bounty, { address: matchingAddr, sealedSecret: { scheme: 'nope' } });
		expect(r.ok).toBe(false);
		expect(r.checks.find((c) => c.id === 'envelope').pass).toBe(false);
	});

	it('the requester (and ONLY the requester) can open the sealed key', async () => {
		const payload = JSON.stringify({ secretKeyBase58: 'theSecret' });
		const sealed = await sealToRecipient(payload, requester.publicKey);
		// Requester opens it.
		const opened = new TextDecoder().decode(await openSealed(sealed, requester.secretKey));
		expect(JSON.parse(opened).secretKeyBase58).toBe('theSecret');
		// A different key cannot.
		const attacker = generateRecipientKeypair();
		await expect(openSealed(sealed, attacker.secretKey)).rejects.toBeTruthy();
	});
});

describe('store: atomic single-winner claim + exactly-once', () => {
	const recipient = generateRecipientKeypair().publicKey;
	let id;
	let bountyRec;

	async function freshBounty(overrides = {}) {
		__resetMemoryStore();
		const now = Date.now();
		const rec = {
			id: deriveBountyId({ recipient, pattern: { prefix: 'THREE' }, amountAtomics: 500000, nonce: String(Math.random()) }),
			protocol: BOUNTY_PROTOCOL_VERSION,
			pattern: { prefix: 'THREE', suffix: null, ignoreCase: false },
			recipient,
			amountAtomics: 500000,
			asset: 'USDC',
			createdAt: now,
			expiresAt: now + 3600_000,
			...overrides,
		};
		await createBounty(rec);
		return rec;
	}

	beforeEach(async () => {
		bountyRec = await freshBounty();
		id = bountyRec.id;
	});

	it('exactly one of two different valid claims wins; the other loses', async () => {
		const sealedA = await sealToRecipient('A', recipient);
		const sealedB = await sealToRecipient('B', recipient);
		const addrA = addrWithPrefix('THREE');
		const addrB = addrWithPrefix('THREE');
		const digestA = claimDigest({ bountyId: id, address: addrA, sealedSecret: sealedA });
		const digestB = claimDigest({ bountyId: id, address: addrB, sealedSecret: sealedB });

		const r1 = await claimBounty({ id, claimDigest: digestA, winnerAddress: addrA, workerId: 'w1', sealedSecret: sealedA });
		const r2 = await claimBounty({ id, claimDigest: digestB, winnerAddress: addrB, workerId: 'w2', sealedSecret: sealedB });

		expect([r1, r2].sort()).toEqual(['lost', 'won']);
		const rec = await getBountyRecord(id);
		expect(rec.status).toBe('settled');
		// The winning claim's sealed envelope is recorded.
		expect(rec.sealedSecret).toBeTruthy();
	});

	it('re-submitting the SAME winning claim is idempotent (won, not double-pay)', async () => {
		const sealed = await sealToRecipient('A', recipient);
		const addr = addrWithPrefix('THREE');
		const digest = claimDigest({ bountyId: id, address: addr, sealedSecret: sealed });
		const first = await claimBounty({ id, claimDigest: digest, winnerAddress: addr, workerId: 'w1', sealedSecret: sealed });
		const again = await claimBounty({ id, claimDigest: digest, winnerAddress: addr, workerId: 'w1', sealedSecret: sealed });
		expect(first).toBe('won');
		expect(again).toBe('won'); // same digest ⇒ idempotent winner, NOT a second payout race
	});

	it('the settled bounty leaves the open board', async () => {
		const sealed = await sealToRecipient('A', recipient);
		const addr = addrWithPrefix('THREE');
		await claimBounty({ id, claimDigest: claimDigest({ bountyId: id, address: addr, sealedSecret: sealed }), winnerAddress: addr, workerId: 'w1', sealedSecret: sealed });
		const open = await queryBounties({ status: 'open' });
		expect(open.bounties.find((b) => b.id === id)).toBeUndefined();
	});

	it('refund is REJECTED on a settled bounty (settle XOR refund)', async () => {
		const sealed = await sealToRecipient('A', recipient);
		const addr = addrWithPrefix('THREE');
		await claimBounty({ id, claimDigest: claimDigest({ bountyId: id, address: addr, sealedSecret: sealed }), winnerAddress: addr, workerId: 'w1', sealedSecret: sealed });
		const elig = await markRefundable(id);
		expect(elig).toBe('ineligible');
	});

	it('refund is REJECTED on a still-live bounty, ALLOWED once expired', async () => {
		// Still-live.
		expect(await markRefundable(id)).toBe('ineligible');
		// Expired bounty.
		__resetMemoryStore();
		const past = Date.now() - 10_000;
		const expired = await freshBounty({ expiresAt: past, createdAt: past - 3600_000 });
		const e1 = await markRefundable(expired.id);
		const e2 = await markRefundable(expired.id); // idempotent
		expect(e1).toBe('refundable');
		expect(e2).toBe('refundable');
		const rec = await getBountyRecord(expired.id);
		expect(rec.status).toBe('refunded');
	});

	it('a claim on an EXPIRED bounty is closed, not won', async () => {
		__resetMemoryStore();
		const past = Date.now() - 10_000;
		const expired = await freshBounty({ expiresAt: past, createdAt: past - 3600_000 });
		const sealed = await sealToRecipient('A', recipient);
		const addr = addrWithPrefix('THREE');
		const outcome = await claimBounty({ id: expired.id, claimDigest: claimDigest({ bountyId: expired.id, address: addr, sealedSecret: sealed }), winnerAddress: addr, workerId: 'w1', sealedSecret: sealed });
		expect(outcome).toBe('closed');
	});

	it('a settled bounty cannot then be refunded, and a refunded one cannot be claimed', async () => {
		// settled → refund blocked (covered above). Now: refunded → claim blocked.
		__resetMemoryStore();
		const past = Date.now() - 10_000;
		const expired = await freshBounty({ expiresAt: past, createdAt: past - 3600_000 });
		await markRefundable(expired.id);
		const sealed = await sealToRecipient('A', recipient);
		const addr = addrWithPrefix('THREE');
		const outcome = await claimBounty({ id: expired.id, claimDigest: 'x', winnerAddress: addr, workerId: 'w1', sealedSecret: sealed });
		expect(outcome).toBe('closed');
	});
});

describe('protocol version is pinned', () => {
	it('matches the expected constant', () => {
		expect(BOUNTY_PROTOCOL_VERSION).toBe('three-vanity-bounty/v1');
	});
});
