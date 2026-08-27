// Verifiable randomness for the lottery draw.
//
// We use Drand "quicknet" (the unchained BLS12-381 chain) for two reasons:
// 1. Anyone can independently verify a published signature against the public
//    Drand public key, so our lottery is provably unbiased.
// 2. We commit to a future round number at draw-open time; that round's
//    randomness isn't known to anyone (including us) until the Drand network
//    publishes the BLS signature, which happens on a public 3-second cadence.
//    No one — including the server operator — can influence the outcome.
//
// Chain info (quicknet, frozen):
//   chain hash : 52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971
//   genesis    : 1692803367 (unix seconds)
//   period     : 3 seconds
//   public key : 83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a
//
// Verification is best-effort: if @noble/curves API surface drifts between
// minor versions we don't want to deadlock the draw. We always record the
// raw {round, randomness, signature} into coin_draws so a third party can
// audit after the fact even if we didn't verify in-process.

import { sha256 } from '@noble/hashes/sha256';
import { fetchUpstream } from '../upstream-fetch.js';

export const QUICKNET_CHAIN_HASH = '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971';
const QUICKNET_GENESIS = 1692803367;
const QUICKNET_PERIOD = 3;
const QUICKNET_PUBLIC_KEY_HEX =
	'83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c' +
	'8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb' +
	'5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a';

// Public drand relays, all serving quicknet. api.drand.sh is the League of
// Entropy's primary; the others are independent mirrors of the same beacon.
export const DRAND_RELAYS = [
	'https://api.drand.sh',
	'https://api2.drand.sh',
	'https://api3.drand.sh',
	'https://drand.cloudflare.com',
];
const DRAND_BASE = `${DRAND_RELAYS[0]}/${QUICKNET_CHAIN_HASH}/public`;

/**
 * Compute the Drand round number that will be live at or after the given unix
 * timestamp (seconds). Adds a `bufferRounds` lookahead so a freshly committed
 * draw can't accidentally target a past round.
 *
 * @param {number} unixSeconds
 * @param {number} bufferRounds  rounds of headroom (default 2 = +6 seconds)
 */
export function roundForTime(unixSeconds, bufferRounds = 2) {
	if (unixSeconds < QUICKNET_GENESIS) {
		throw new Error('roundForTime: timestamp predates quicknet genesis');
	}
	const elapsed = unixSeconds - QUICKNET_GENESIS;
	const r = Math.floor(elapsed / QUICKNET_PERIOD) + 1 + bufferRounds;
	return r;
}

/**
 * Unix timestamp at which the given Drand round becomes available.
 */
export function timeForRound(round) {
	return QUICKNET_GENESIS + (round - 1) * QUICKNET_PERIOD;
}

function uint64BE(n) {
	const buf = new Uint8Array(8);
	const big = BigInt(n);
	for (let i = 7; i >= 0; i--) {
		buf[i] = Number((big >> BigInt((7 - i) * 8)) & 0xffn);
	}
	return buf;
}

/**
 * The message hashed into the BLS signature for round `r` on quicknet
 * (unchained mode): m = sha256(uint64_be(r)).
 */
export function drandRoundMessage(round) {
	return sha256(uint64BE(round));
}

/**
 * Fetch the published randomness for a Drand quicknet round. Throws if the
 * round isn't available yet (404) or if Drand is unreachable.
 *
 * @returns {Promise<{ round: number, randomness: string, signature: string }>}
 */
export async function fetchDrandRound(round) {
	// Every relay serves the same signed beacon, so any one of them is
	// authoritative; the signature check below is what we trust, not the host.
	// A 404 is a real answer (the round has not been published yet) and must
	// not be retried on the next relay, so it short-circuits the chain.
	let data = null;
	let lastStatus = 0;
	for (const base of DRAND_RELAYS) {
		let resp;
		try {
			resp = await fetchUpstream(`${base}/${QUICKNET_CHAIN_HASH}/public/${round}`, { headers: { accept: 'application/json' } }, {
				name: `drand:${base}`,
				timeoutMs: 5_000,
				attempts: 2,
				okWhen: (r) => r.ok || r.status === 404,
			});
		} catch (err) {
			lastStatus = err?.status || 0;
			continue;
		}
		if (resp.status === 404) {
			throw new Error(`drand_round_unavailable:${round}`);
		}
		data = await resp.json().catch(() => null);
		if (data) break;
	}
	if (!data) {
		throw new Error(`drand_fetch_failed:${lastStatus || 'unreachable'}`);
	}
	if (!data || typeof data.round !== 'number' || !data.randomness || !data.signature) {
		throw new Error('drand_response_malformed');
	}
	// Sanity: randomness MUST equal sha256(signature) per the quicknet spec.
	const expected = Buffer.from(sha256(Buffer.from(data.signature, 'hex'))).toString('hex');
	if (data.randomness !== expected) {
		throw new Error('drand_randomness_mismatch');
	}
	return { round: data.round, randomness: data.randomness, signature: data.signature };
}

/**
 * Verify the BLS signature on a Drand quicknet round. Returns true on success;
 * returns false on any verification failure or library mismatch. Callers should
 * NOT use this as their only guard — always also persist the {round, randomness,
 * signature} tuple so an outside auditor can re-verify with their own tooling.
 *
 * Drand quicknet uses the "short signatures" BLS scheme: signatures on G1
 * (48 bytes compressed) and public keys on G2 (96 bytes compressed). The
 * message is the raw uint64-BE round number; @noble/curves' shortSignatures
 * scheme handles the hash-to-curve internally with the standard DST.
 *
 * @param {{ round: number, randomness: string, signature: string }} entry
 * @returns {Promise<boolean>}
 */
export async function verifyDrandSignature({ round, signature }) {
	try {
		const noble = await import('@noble/curves/bls12-381.js').catch(() => null);
		const short = noble?.bls12_381?.shortSignatures;
		if (!short?.verify || !short?.hash) return false;
		const sigBytes = Buffer.from(signature, 'hex');
		const pkBytes = Buffer.from(QUICKNET_PUBLIC_KEY_HEX, 'hex');
		// Drand quicknet (scheme "bls-unchained-g1-rfc9380") signs:
		//   m = sha256(uint64_be(round))
		// then hashed-to-curve on G1 with DST BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_.
		// @noble/curves' shortSignatures.verify wants the message PRE-hashed to
		// the curve, so we run short.hash() first.
		const msg = drandRoundMessage(round);
		const hashed = short.hash(msg);
		return short.verify(sigBytes, hashed, pkBytes);
	} catch {
		return false;
	}
}

/**
 * Compress randomness + a salt (the weights_hash) into a 32-byte PRNG seed.
 * The salt binds a particular drawing to a particular holder snapshot — even
 * if two draws target the same Drand round, distinct holder sets produce
 * distinct seeds.
 */
export function seedFor(randomnessHex, saltHex) {
	const buf = Buffer.concat([
		Buffer.from(randomnessHex, 'hex'),
		Buffer.from(saltHex, 'hex'),
	]);
	return sha256(buf);
}

/**
 * Deterministic xorshift-style PRNG over BigInt, seeded by a 32-byte seed.
 * Used to pick the lottery winner from the cumulative-weight array; same seed
 * → same winner, so audits are reproducible.
 */
export function bigintPRNG(seed) {
	if (seed.length < 16) throw new Error('seed too short');
	let s0 = 0n;
	let s1 = 0n;
	for (let i = 0; i < 16; i++) s0 |= BigInt(seed[i]) << BigInt(i * 8);
	for (let i = 0; i < 16; i++) s1 |= BigInt(seed[i + 16] ?? 0) << BigInt(i * 8);
	const MASK = (1n << 64n) - 1n;
	let a = s0 & MASK;
	let b = s1 & MASK;
	return {
		next() {
			// xorshift128+
			let x = a;
			const y = b;
			a = y;
			x ^= (x << 23n) & MASK;
			b = (x ^ y ^ (x >> 17n) ^ (y >> 26n)) & MASK;
			return (b + y) & MASK;
		},
	};
}

/**
 * Deterministic weighted-random pick. Returns the index of the chosen entry.
 * weights: array of BigInts; all must be >= 0, sum > 0.
 *
 * Algorithm: rejection sampling against the smallest power-of-two upper bound
 * for `total`. Generate enough random 64-bit chunks to cover that bit length,
 * mask to exact size, reject and resample if the value lands in the rejection
 * zone. This keeps the distribution provably uniform over [0, total).
 */
export function weightedPick(weights, seed) {
	let total = 0n;
	for (const w of weights) {
		if (w < 0n) throw new Error('negative weight');
		total += w;
	}
	if (total === 0n) throw new Error('empty weight set');

	// Bit length needed to represent values in [0, total).
	const bits = total === 1n ? 1 : (total - 1n).toString(2).length;
	const chunks = Math.ceil(bits / 64);
	const mask = bits >= 1 ? (1n << BigInt(bits)) - 1n : 0n;
	const prng = bigintPRNG(seed);

	let pick = 0n;
	let attempts = 0;
	while (attempts < 256) {
		pick = 0n;
		for (let i = 0; i < chunks; i++) {
			pick = (pick << 64n) | prng.next();
		}
		pick &= mask;
		if (pick < total) break;
		attempts++;
	}
	if (pick >= total) {
		// Rejection ratio is bounded by 50% per attempt (since `total` is at
		// least half of `2^bits`), so reaching 256 unsuccessful samples has
		// probability < 2^-256 — effectively impossible. Surface as an error
		// rather than silently bias toward the last weight.
		throw new Error('weightedPick: rejection sampling exhausted');
	}

	let acc = 0n;
	for (let i = 0; i < weights.length; i++) {
		acc += weights[i];
		if (pick < acc) return i;
	}
	throw new Error('weightedPick: walk fell off end (impossible if total > 0)');
}

/**
 * sha256 over the canonical (wallet, weight) tuple stream — used as the
 * weights_hash committed alongside the Drand round number.
 */
export function weightsHash(entries) {
	const sorted = [...entries].sort((a, b) => (a.wallet < b.wallet ? -1 : 1));
	const lines = sorted.map((e) => `${e.wallet}:${e.weight.toString()}`);
	const buf = Buffer.from(lines.join('\n'), 'utf-8');
	return Buffer.from(sha256(buf)).toString('hex');
}

export const DRAND = {
	chainHash: QUICKNET_CHAIN_HASH,
	genesis: QUICKNET_GENESIS,
	period: QUICKNET_PERIOD,
	publicKey: QUICKNET_PUBLIC_KEY_HEX,
};
