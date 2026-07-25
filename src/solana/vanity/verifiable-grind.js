/**
 * Verifiable, provably-fair vanity grinding — the protocol primitive.
 *
 * Every other vanity service asks you to trust the operator: trust that the key
 * was generated with real randomness, that no copy was kept, that they didn't
 * grind 10,000 candidates and hand you the one whose key they secretly logged.
 * This module makes all three claims *provable* after the fact, with nothing but
 * the receipt and open-source crypto.
 *
 * ── Protocol `three-vanity/v1` (commit–reveal seed mixing) ───────────────────
 *
 * 1. COMMIT. Before grinding, the server draws a uniformly random 32-byte
 *    `serverSeed` and publishes `commitment = SHA-256("three-vanity/seed-commit/v1"
 *    ‖ serverSeed)`. The commitment is bound into the signed receipt, so the
 *    server is locked to that seed *before* it knows which candidate will win —
 *    it cannot have precomputed a rainbow table keyed to the buyer's pattern.
 *
 * 2. MIX. Neither party alone may control the output. The two seeds plus the
 *    request nonce are folded into a single master seed:
 *
 *      masterSeed = HKDF-SHA256(
 *        ikm   = serverSeed ‖ clientSeed ‖ requestNonce,
 *        salt  = SHA-256("three-vanity/mix-salt/v1"),
 *        info  = "three-vanity/master/v1",
 *        len   = 32)
 *
 *    `clientSeed` is buyer-supplied (or a fresh random one we reveal); the buyer
 *    therefore contributes entropy the server could not predict at commit time.
 *
 * 3. DERIVE. Candidate `i` (a 0-based counter) has a fully deterministic Ed25519
 *    secret seed:
 *
 *      seed_i = HMAC-SHA256(key = masterSeed,
 *                           msg = "three-vanity/candidate/v1" ‖ uint64_be(i))
 *
 *    The 32-byte `seed_i` is the Ed25519 private scalar seed; its public key is
 *    the Solana address. The grinder walks i = 0,1,2,… until the address matches
 *    the pattern; the winning index is recorded as `winningIndex`.
 *
 * 4. SEAL + SIGN. The secret is sealed to the buyer (ECIES, sealed-envelope.js)
 *    so plaintext never touches the wire, and the server signs the receipt with
 *    its long-lived Ed25519 identity key (published at /.well-known/three-vanity.json).
 *
 * ── Verification (verifyVanityReceipt) reproduces, never trusts ──────────────
 *
 *   • SHA-256(serverSeed) === commitment            (server didn't swap the seed)
 *   • re-derive masterSeed and seed_{winningIndex}   (mixing was honest)
 *   • that seed's public key === receipt.address     (address ↔ key bind)
 *   • address satisfies the claimed pattern          (pattern honesty)
 *   • Ed25519 verify(signature, receipt, serviceKey) (it's really our service)
 *   • optionally: opened secret === re-derived secret (the sealed key is THE key)
 *
 * Determinism is the whole point, so this file hand-derives every candidate in
 * JS (noble Ed25519) rather than the WASM grinder — the verifier must reproduce
 * the exact stream. It is isomorphic: @noble/curves + @noble/hashes give pure-JS
 * Ed25519/HMAC/HKDF/SHA-256 that run identically in Node serverless and the
 * browser. Behaviour is pinned by fixed vectors in
 * tests/vanity-verifiable-grind.test.js (including a tamper/negative test).
 */

import bs58 from 'bs58';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha256';
import { hmac } from '@noble/hashes/hmac';
import { hkdf } from '@noble/hashes/hkdf';
import { bytesToHex, hexToBytes, concatBytes } from '@noble/hashes/utils';

import {
	validatePattern,
	BASE58_ALPHABET,
	expectedAttempts,
	difficultyModel,
	DIFFICULTY_MODEL,
	DIFFICULTY_MODEL_V1,
} from './validation.js';

export const PROTOCOL_VERSION = 'three-vanity/v1';
export const RECEIPT_TYPE = 'three-vanity-receipt';
export const SIGNATURE_SCHEME = 'ed25519';

const enc = new TextEncoder();

// Domain-separation tags. Distinct prefixes guarantee a hash computed for one
// purpose can never collide with one computed for another.
const TAG_SEED_COMMIT = enc.encode('three-vanity/seed-commit/v1');
const TAG_MIX_SALT = sha256(enc.encode('three-vanity/mix-salt/v1'));
const TAG_MASTER_INFO = enc.encode('three-vanity/master/v1');
const TAG_CANDIDATE = enc.encode('three-vanity/candidate/v1');
const TAG_RECEIPT = enc.encode('three-vanity/receipt/v1');

const SEED_BYTES = 32;

function asBytes(value, label) {
	if (value instanceof Uint8Array) return value;
	if (typeof value === 'string') {
		const s = value.trim();
		if (/^[0-9a-fA-F]+$/.test(s) && s.length % 2 === 0) return hexToBytes(s);
		try {
			return bs58.decode(s);
		} catch {
			throw new Error(`${label} is not valid hex or Base58`);
		}
	}
	throw new Error(`${label} must be a Uint8Array, hex, or Base58 string`);
}

/** 32 cryptographically-random bytes (WebCrypto, works in Node + browser). */
export function randomSeed() {
	const b = new Uint8Array(SEED_BYTES);
	globalThis.crypto.getRandomValues(b);
	return b;
}

/** uint64 big-endian encoding of a non-negative integer counter. */
function uint64be(n) {
	const out = new Uint8Array(8);
	let v = BigInt(n);
	for (let i = 7; i >= 0; i--) {
		out[i] = Number(v & 0xffn);
		v >>= 8n;
	}
	return out;
}

/**
 * Commitment the server publishes before grinding.
 * @param {Uint8Array|string} serverSeed - 32-byte seed (hex/Base58 accepted).
 * @returns {string} lowercase hex SHA-256 commitment.
 */
export function commitToSeed(serverSeed) {
	const seed = asBytes(serverSeed, 'serverSeed');
	if (seed.length !== SEED_BYTES) throw new Error('serverSeed must be 32 bytes');
	return bytesToHex(sha256(concatBytes(TAG_SEED_COMMIT, seed)));
}

/**
 * Fold serverSeed + clientSeed + requestNonce into the 32-byte master seed that
 * drives candidate derivation. Order is fixed and domain-separated.
 * @param {object} p
 * @param {Uint8Array|string} p.serverSeed
 * @param {Uint8Array|string} p.clientSeed
 * @param {Uint8Array|string} p.requestNonce
 * @returns {Uint8Array} 32-byte master seed.
 */
export function deriveMasterSeed({ serverSeed, clientSeed, requestNonce }) {
	const ikm = concatBytes(
		asBytes(serverSeed, 'serverSeed'),
		asBytes(clientSeed, 'clientSeed'),
		asBytes(requestNonce, 'requestNonce'),
	);
	return hkdf(sha256, ikm, TAG_MIX_SALT, TAG_MASTER_INFO, SEED_BYTES);
}

/**
 * Deterministic Ed25519 secret seed for candidate `index` under a master seed.
 * @param {Uint8Array} masterSeed - 32-byte output of deriveMasterSeed.
 * @param {number} index - non-negative candidate counter.
 * @returns {Uint8Array} 32-byte Ed25519 private seed.
 */
export function candidateSeed(masterSeed, index) {
	return hmac(sha256, masterSeed, concatBytes(TAG_CANDIDATE, uint64be(index)));
}

/**
 * Base58 Solana address for a candidate index — the public key of seed_index.
 * @param {Uint8Array} masterSeed
 * @param {number} index
 * @returns {{ address: string, seed: Uint8Array, publicKey: Uint8Array }}
 */
export function candidateAddress(masterSeed, index) {
	const seed = candidateSeed(masterSeed, index);
	const publicKey = ed25519.getPublicKey(seed);
	return { address: bs58.encode(publicKey), seed, publicKey };
}

/**
 * Assemble a Solana 64-byte secret key (seed ‖ public key) from a 32-byte seed,
 * matching `Keypair.fromSecretKey()` / Phantom import format.
 * @param {Uint8Array} seed - 32-byte Ed25519 private seed.
 * @returns {Uint8Array} 64-byte secret key.
 */
export function secretKeyFromSeed(seed) {
	const pub = ed25519.getPublicKey(seed);
	const sk = new Uint8Array(64);
	sk.set(seed, 0);
	sk.set(pub, 32);
	return sk;
}

/**
 * Does a Base58 address satisfy a prefix/suffix pattern?
 * Mirrors the WASM grinder's matcher exactly so the difficulty model is honest.
 * @param {string} address
 * @param {object} p
 * @param {string} [p.prefix]
 * @param {string} [p.suffix]
 * @param {boolean} [p.ignoreCase=false]
 * @returns {boolean}
 */
export function addressMatchesPattern(address, { prefix = '', suffix = '', ignoreCase = false } = {}) {
	let addr = address;
	let pre = prefix || '';
	let suf = suffix || '';
	if (ignoreCase) {
		addr = addr.toLowerCase();
		pre = pre.toLowerCase();
		suf = suf.toLowerCase();
	}
	if (pre && !addr.startsWith(pre)) return false;
	if (suf && !addr.endsWith(suf)) return false;
	return true;
}

/**
 * Grind deterministically: walk candidate indices until the address matches.
 * Bounded by attempt + time budgets. Returns the winning index + key material.
 *
 * @param {object} opts
 * @param {Uint8Array} opts.masterSeed
 * @param {string} [opts.prefix]
 * @param {string} [opts.suffix]
 * @param {boolean} [opts.ignoreCase=false]
 * @param {number} [opts.maxAttempts=Infinity]
 * @param {number} [opts.timeBudgetMs=Infinity]
 * @param {number} [opts.startIndex=0]
 * @returns {{ found:boolean, index:number, address:string, seed:Uint8Array,
 *   secretKey:Uint8Array, attempts:number, durationMs:number }}
 */
export function grindDeterministic({
	masterSeed,
	prefix = '',
	suffix = '',
	ignoreCase = false,
	maxAttempts = Infinity,
	timeBudgetMs = Infinity,
	startIndex = 0,
}) {
	const startedAt = performance.now();
	const pattern = { prefix, suffix, ignoreCase };
	let index = startIndex;
	let attempts = 0;
	for (; attempts < maxAttempts; index++, attempts++) {
		if (attempts % 1024 === 0 && performance.now() - startedAt >= timeBudgetMs) break;
		const { address, seed } = candidateAddress(masterSeed, index);
		if (addressMatchesPattern(address, pattern)) {
			return {
				found: true,
				index,
				address,
				seed,
				secretKey: secretKeyFromSeed(seed),
				attempts: attempts + 1,
				durationMs: performance.now() - startedAt,
			};
		}
	}
	return {
		found: false,
		index: -1,
		address: '',
		seed: new Uint8Array(0),
		secretKey: new Uint8Array(0),
		attempts,
		durationMs: performance.now() - startedAt,
	};
}

// The EXACT set of fields covered by the service signature, in no particular
// order (canonicalization sorts them). The delivery payload (sealedSecret /
// secretKey / seed) and navigation hints (explorerUrl / verifyUrl) are NOT
// signed — they're derivable or recipient-specific — so the verifier projects a
// receipt down to exactly these keys before hashing. This makes the signature
// stable regardless of what extra fields a response or a UI round-trips.
export const SIGNED_FIELDS = Object.freeze([
	'protocol',
	'receiptType',
	'address',
	'pattern',
	'commitment',
	'serverSeed',
	'clientSeed',
	'requestNonce',
	'winningIndex',
	'attempts',
	'durationMs',
	'difficulty',
	'sealed',
	'sealedScheme',
	'sealedRecipient',
	'sealedEpk',
	'network',
	'ts',
]);

/** Project an object down to exactly the signed fields (present ones only). */
export function projectSignedCore(obj) {
	const core = {};
	for (const k of SIGNED_FIELDS) {
		if (obj[k] !== undefined) core[k] = obj[k];
	}
	return core;
}

/**
 * Canonical byte serialization of a receipt's signable core. Sorting keys and
 * fixing the encoding make the signature reproducible on any platform — the
 * verifier hashes the exact same bytes. The input is projected to SIGNED_FIELDS
 * first, so extra response/UI fields never perturb the signature.
 * @param {object} core
 * @returns {Uint8Array}
 */
export function canonicalReceiptBytes(core) {
	const stable = stableStringify(projectSignedCore(core));
	return concatBytes(TAG_RECEIPT, enc.encode(stable));
}

// Deterministic JSON: object keys sorted recursively, no whitespace. Numbers and
// strings serialize as standard JSON. Used only for the signable core, whose
// values are all primitives/strings.
function stableStringify(value) {
	if (value === null || typeof value !== 'object') return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
	const keys = Object.keys(value).sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/**
 * Build + sign a receipt. The signing key is the service's long-lived Ed25519
 * identity secret (32-byte seed). Returns the full receipt object the buyer keeps.
 *
 * @param {object} p
 * @param {object} p.core - signable fields (commitment, clientSeed, requestNonce,
 *   pattern, address, difficulty, attempts, winningIndex, durationMs,
 *   sealedRecipient, sealedEpk, serverSeed, ts, …).
 * @param {Uint8Array|string} p.signingSeed - 32-byte service Ed25519 secret seed.
 * @returns {object} receipt with `signature` (hex) + `servicePublicKey` (Base58).
 */
export function signReceipt({ core, signingSeed }) {
	const seed = asBytes(signingSeed, 'signingSeed');
	if (seed.length !== SEED_BYTES) throw new Error('signingSeed must be 32 bytes');
	const msg = canonicalReceiptBytes(core);
	const signature = ed25519.sign(msg, seed);
	const publicKey = ed25519.getPublicKey(seed);
	return {
		...core,
		signature: bytesToHex(signature),
		servicePublicKey: bs58.encode(publicKey),
		signatureScheme: SIGNATURE_SCHEME,
	};
}

/**
 * Verify a receipt's service signature against a pinned/known public key.
 * @param {object} receipt
 * @param {Uint8Array|string} servicePublicKey - 32-byte Ed25519 public key.
 * @returns {boolean}
 */
export function verifyReceiptSignature(receipt, servicePublicKey) {
	if (!receipt?.signature) return false;
	const { signature, servicePublicKey: _spk, signatureScheme: _ss, ...core } = receipt;
	let sig;
	let pub;
	try {
		sig = hexToBytes(signature);
		pub = asBytes(servicePublicKey, 'servicePublicKey');
	} catch {
		return false;
	}
	try {
		return ed25519.verify(sig, canonicalReceiptBytes(core), pub);
	} catch {
		return false;
	}
}

/**
 * @typedef {object} VerifyCheck
 * @property {string} id
 * @property {string} label
 * @property {boolean} pass
 * @property {string} detail
 */

/**
 * Independently verify a vanity receipt. Runs every protocol check and returns a
 * per-check audit so a UI/CLI can render exactly what passed and what failed.
 * Trusts nothing in the receipt — it recomputes each claim from first principles.
 *
 * @param {object} receipt - the signed receipt.
 * @param {object} [opts]
 * @param {Uint8Array|string} [opts.servicePublicKey] - pinned service key. When
 *   omitted, the signature is checked against the receipt's own
 *   `servicePublicKey` and a separate `serviceKeyPinned` check reports that no
 *   pin was supplied (so an attacker self-signing is caught when a pin IS given).
 * @param {Uint8Array} [opts.openedSecretSeed] - the 32-byte Ed25519 seed the
 *   buyer recovered from the sealed envelope. When present, we confirm it equals
 *   the seed the protocol re-derives — i.e. the key you hold is THE ground key.
 * @returns {{ valid:boolean, checks:VerifyCheck[], address:string }}
 */
export function verifyVanityReceipt(receipt, opts = {}) {
	const checks = [];
	const add = (id, label, pass, detail) => checks.push({ id, label, pass, detail });

	if (!receipt || typeof receipt !== 'object') {
		add('shape', 'Receipt is well-formed', false, 'receipt is missing or not an object');
		return { valid: false, checks, address: '' };
	}
	if (receipt.protocol !== PROTOCOL_VERSION) {
		add(
			'protocol',
			'Protocol version is supported',
			false,
			`receipt protocol "${receipt.protocol}" ≠ "${PROTOCOL_VERSION}"`,
		);
		return { valid: false, checks, address: receipt.address || '' };
	}
	add('protocol', 'Protocol version is supported', true, PROTOCOL_VERSION);

	// 1. Commitment opens to the revealed serverSeed.
	let serverSeed;
	let computedCommitment = '';
	try {
		serverSeed = asBytes(receipt.serverSeed, 'serverSeed');
		computedCommitment = commitToSeed(serverSeed);
	} catch (e) {
		add('commitment', 'serverSeed opens the commitment', false, e.message);
	}
	if (computedCommitment) {
		const ok = timingSafeEqualHex(computedCommitment, String(receipt.commitment || ''));
		add(
			'commitment',
			'serverSeed opens the commitment',
			ok,
			ok
				? 'SHA-256(serverSeed) matches the committed value — the server could not have swapped seeds after seeing the result'
				: `SHA-256(serverSeed) = ${computedCommitment} ≠ committed ${receipt.commitment}`,
		);
	}

	// 2. Re-derive the master seed + winning candidate and bind it to the address.
	let derivedAddress = '';
	let derivedSeed = null;
	try {
		const masterSeed = deriveMasterSeed({
			serverSeed: receipt.serverSeed,
			clientSeed: receipt.clientSeed,
			requestNonce: receipt.requestNonce,
		});
		const cand = candidateAddress(masterSeed, receipt.winningIndex);
		derivedAddress = cand.address;
		derivedSeed = cand.seed;
		const ok = derivedAddress === receipt.address;
		add(
			'derivation',
			'Address derives from the mixed seed at the claimed index',
			ok,
			ok
				? `candidate #${receipt.winningIndex} re-derives to ${derivedAddress}`
				: `candidate #${receipt.winningIndex} re-derives to ${derivedAddress}, not the claimed ${receipt.address}`,
		);
	} catch (e) {
		add('derivation', 'Address derives from the mixed seed at the claimed index', false, e.message);
	}

	// 3. The address satisfies the requested pattern.
	{
		const pat = receipt.pattern || {};
		const ok = addressMatchesPattern(receipt.address || '', pat);
		const want = [pat.prefix && `prefix "${pat.prefix}"`, pat.suffix && `suffix "${pat.suffix}"`]
			.filter(Boolean)
			.join(' + ') || '(no pattern)';
		add(
			'pattern',
			'Address satisfies the requested pattern',
			ok,
			ok ? `${receipt.address} matches ${want}` : `${receipt.address} does NOT match ${want}`,
		);
	}

	// 4. Difficulty claim is the honest probability model, the one the receipt
	//    was ISSUED under, named in its own signed `difficulty.model`. Receipts
	//    predating the Base58 leading-character correction declare v1 and must
	//    keep verifying; an absent field means v1.
	{
		const pat = receipt.pattern || {};
		const model = receipt.difficulty?.model || DIFFICULTY_MODEL_V1;
		const expected = Math.round(difficultyModel(model)(pat.prefix || '', pat.suffix || '', !!pat.ignoreCase));
		const ok = Number(receipt.difficulty?.expectedAttempts) === expected;
		add(
			'difficulty',
			'Difficulty matches the honest model',
			ok,
			ok
				? `expectedAttempts = ${expected} under ${model}`
				: `receipt claims ${receipt.difficulty?.expectedAttempts}, ${model} model = ${expected}`,
		);
	}

	// 5. Service signature.
	{
		const pin = opts.servicePublicKey;
		const keyToCheck = pin ?? receipt.servicePublicKey;
		const sigOk = verifyReceiptSignature(receipt, keyToCheck);
		add(
			'signature',
			'Service Ed25519 signature is valid',
			sigOk,
			sigOk
				? `signed by ${receipt.servicePublicKey}`
				: 'signature does not verify against the service key',
		);
		const pinned = pin
			? sameKey(pin, receipt.servicePublicKey)
			: false;
		add(
			'serviceKeyPinned',
			'Signed by the pinned three.ws service key',
			pin ? pinned : false,
			pin
				? pinned
					? `receipt key ${receipt.servicePublicKey} matches the pinned key`
					: `receipt key ${receipt.servicePublicKey} ≠ pinned key — possible impostor`
				: 'no pinned key supplied — fetch /.well-known/three-vanity.json to pin and prove the signer is three.ws',
		);
	}

	// 6. (Optional) the opened secret is THE ground key.
	if (opts.openedSecretSeed) {
		let opened;
		try {
			opened = asBytes(opts.openedSecretSeed, 'openedSecretSeed');
			if (opened.length === 64) opened = opened.slice(0, 32);
		} catch (e) {
			opened = null;
			add('custody', 'Your recovered key is the ground key', false, e.message);
		}
		if (opened) {
			const ok =
				derivedSeed != null &&
				opened.length === 32 &&
				constantTimeBytesEqual(opened, derivedSeed);
			const pubOk = ok && bs58.encode(ed25519.getPublicKey(opened)) === receipt.address;
			add(
				'custody',
				'Your recovered key is the ground key',
				ok && pubOk,
				ok && pubOk
					? 'the secret you opened re-derives to the receipt address — you hold the one and only key'
					: 'the opened secret does NOT match the protocol-derived key for this receipt',
			);
		}
	}

	const required = checks.filter((c) => c.id !== 'serviceKeyPinned' || opts.servicePublicKey);
	const valid = required.every((c) => c.pass);
	return { valid, checks, address: receipt.address || '' };
}

function sameKey(a, b) {
	try {
		return constantTimeBytesEqual(asBytes(a, 'a'), asBytes(b, 'b'));
	} catch {
		return false;
	}
}

function constantTimeBytesEqual(a, b) {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
	return diff === 0;
}

function timingSafeEqualHex(a, b) {
	if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

export { BASE58_ALPHABET, validatePattern };
