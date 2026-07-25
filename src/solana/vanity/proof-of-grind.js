/**
 * Proof-of-Grind certificate — the universal, verifiable provenance layer for
 * three.ws vanity wallets.
 *
 * Where `verifiable-grind.js` (`three-vanity/v1`) proves provenance by making the
 * grind *re-derivable* — a heavy commit–reveal protocol whose verifier replays
 * the exact candidate stream — this module issues a lighter, universal
 * **certificate** that can be attached to ANY grind output: the fast WASM
 * keypair grinder, the BIP-39 mnemonic grinder, and (Task 01) the zero-knowledge
 * split-key grinder. It does not re-run the grind; it is a signed attestation of
 * the facts a buyer cares about, every one of which is checkable offline from
 * public values alone:
 *
 *   • the requested pattern + options and the resulting public address;
 *   • the difficulty (honest 58ⁿ model) and a coordinated rarity score;
 *   • the timestamp, scheme/format, and attempt count;
 *   • a server-issued **freshness nonce** so the same address cannot be re-sold
 *     as "freshly ground" twice (the registry binds one canonical cert per
 *     address; a duplicate is detectable);
 *   • for split-key grinds, an explicit **non-custody assertion** that the
 *     verifier recomputes from public values only:
 *
 *         buyerPublicKey (P1)  +  serverComponent (a2·B)  ==  vanityAddress
 *
 *     i.e. the address is the sum of the buyer's partial public key and the
 *     server's added public point. The server's secret offset scalar `a2` is
 *     NEVER in the certificate (it is sealed to the buyer); only the public
 *     point a2·B is published, which proves three.ws could not reconstruct the
 *     full private key — it never held P1's discrete log.
 *
 * The certificate is signed by three.ws's long-lived Ed25519 attestation key
 * (the same identity published at /.well-known/three-vanity.json), is
 * rotation-aware (`keyId` + a verifier keyring), and is fully public — it
 * contains no secret and nothing that weakens the key. Verification
 * (`verifyProofOfGrind`) trusts nothing in the certificate: it recomputes every
 * claim and returns a per-check audit a UI/CLI can render.
 *
 * Pure + isomorphic: @noble/curves + @noble/hashes give identical Ed25519 / point
 * arithmetic / SHA-256 in Node serverless and the browser, so the same function
 * verifies on the server, in the /vanity/verify page, in the SDK, and in CI.
 * Behaviour is pinned by fixed vectors in tests/vanity-proof-of-grind.test.js
 * (tamper, freshness/replay, and split-key non-custody negative tests).
 */

import bs58 from 'bs58';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes, concatBytes } from '@noble/hashes/utils';

import {
	expectedAttempts,
	difficultyModel,
	validatePattern,
	BASE58_ALPHABET,
	DIFFICULTY_MODEL,
	DIFFICULTY_MODEL_V1,
} from './validation.js';
import { addressMatchesPattern } from './verifiable-grind.js';
import { computeRarity } from './rarity.js';

export const POG_PROTOCOL = 'three-pog/v1';
export const CERT_TYPE = 'proof-of-grind';
export const SIGNATURE_SCHEME = 'ed25519';

/** Format string ↔ derivation scheme the cert attests over. */
export const FORMAT_KEYPAIR = 'keypair';
export const FORMAT_MNEMONIC = 'mnemonic';
export const FORMAT_SPLIT_KEY = 'split-key';
export const SUPPORTED_FORMATS = Object.freeze([FORMAT_KEYPAIR, FORMAT_MNEMONIC, FORMAT_SPLIT_KEY]);

/** Non-custody proof scheme for split-key grinds (Task 01). */
export const SPLIT_KEY_SCHEME = 'ed25519-split-key/v1';

/** Default tolerance for a clock-skewed `issuedAt` that appears in the future. */
export const DEFAULT_FUTURE_SKEW_MS = 5 * 60 * 1000;

const enc = new TextEncoder();
const NONCE_BYTES = 32;
const Point = ed25519.Point;

// Domain-separation tag bound into every signed certificate. A distinct prefix
// guarantees a signature minted for a proof-of-grind cert can never be replayed
// as a `three-vanity/v1` receipt signature (or anything else this key signs).
const TAG_CERT = enc.encode('three-pog/cert/v1');

// The EXACT set of fields covered by the attestation signature, in canonical
// (sorted) order. Delivery payloads (the sealed secret, plaintext key) and
// navigation hints (verifyUrl/explorerUrl/serviceKeyUrl) are deliberately NOT
// signed — they are recipient-specific or derivable — so the verifier projects a
// certificate down to exactly these keys before hashing. Extra response/UI
// fields therefore never perturb the signature.
export const SIGNED_FIELDS = Object.freeze([
	'protocol',
	'certType',
	'certId',
	'address',
	'pattern',
	'format',
	'scheme',
	'attempts',
	'difficulty',
	'rarity',
	'freshness',
	'delivery',
	'nonCustody',
	'network',
	'keyId',
	'ts',
]);

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

/** 32 cryptographically-random bytes (WebCrypto — Node + browser). */
export function randomNonce() {
	const b = new Uint8Array(NONCE_BYTES);
	globalThis.crypto.getRandomValues(b);
	return bytesToHex(b);
}

/**
 * Stable certificate id: a content hash of the immutable provenance facts plus
 * the freshness nonce. Deterministic so the issuer and the registry agree on the
 * id without coordination, and collision-resistant so two distinct grinds never
 * share one. NOT a secret — derived only from public values.
 * @param {object} p
 * @returns {string} lowercase hex (first 32 bytes of SHA-256, 64 hex chars).
 */
export function deriveCertId({ address, pattern, format, nonce }) {
	const basis = stableStringify({
		address: String(address || ''),
		pattern: normalizePattern(pattern),
		format: String(format || ''),
		nonce: String(nonce || ''),
	});
	return bytesToHex(sha256(concatBytes(enc.encode('three-pog/cert-id/v1'), enc.encode(basis))));
}

function normalizePattern(pattern = {}) {
	return {
		prefix: pattern.prefix || null,
		suffix: pattern.suffix || null,
		ignoreCase: !!pattern.ignoreCase,
	};
}

/** Project an object down to exactly the signed fields (present ones only). */
export function projectSignedCore(obj) {
	const core = {};
	for (const k of SIGNED_FIELDS) {
		if (obj[k] !== undefined) core[k] = obj[k];
	}
	return core;
}

/**
 * Canonical byte serialization of a certificate's signable core. Sorting keys
 * and fixing the encoding make the signature reproducible on any platform — the
 * verifier hashes the exact same bytes. The input is projected to SIGNED_FIELDS
 * first so extra fields never change the signature.
 * @param {object} core
 * @returns {Uint8Array}
 */
export function canonicalCertBytes(core) {
	const stable = stableStringify(projectSignedCore(core));
	return concatBytes(TAG_CERT, enc.encode(stable));
}

// Deterministic JSON: object keys sorted recursively, no whitespace. Values are
// primitives/strings/nested plain objects — exactly what the signed core holds.
function stableStringify(value) {
	if (value === null || typeof value !== 'object') return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
	const keys = Object.keys(value).sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/**
 * Assemble the unsigned signable core of a proof-of-grind certificate.
 *
 * @param {object} p
 * @param {string} p.address - Base58 Solana public key the grind produced.
 * @param {object} p.pattern - { prefix, suffix, ignoreCase }.
 * @param {string} p.format - keypair | mnemonic | split-key.
 * @param {number} p.attempts - keypairs/candidates tried before the match.
 * @param {string} [p.scheme] - human derivation scheme description.
 * @param {string} [p.nonce] - 32-byte freshness nonce (hex). Generated if omitted.
 * @param {string} [p.issuedAt] - ISO timestamp. Caller-supplied for determinism.
 * @param {object} [p.delivery] - { sealed, sealedScheme, sealedRecipient }.
 * @param {object} [p.nonCustody] - split-key only: { scheme, buyerPublicKey, serverComponent }.
 * @param {string} [p.network='solana']
 * @param {string} [p.keyId] - attestation key id (set by signCertificate when omitted).
 * @returns {object} the signable core (no signature yet).
 */
export function buildCertificateCore({
	address,
	pattern,
	format,
	attempts,
	scheme,
	nonce,
	issuedAt,
	delivery,
	nonCustody,
	network = 'solana',
	keyId,
}) {
	if (!address || typeof address !== 'string') throw new Error('address is required');
	if (!SUPPORTED_FORMATS.includes(format)) throw new Error(`unsupported format '${format}'`);
	const pat = normalizePattern(pattern);
	const freshnessNonce = nonce || randomNonce();
	const ts = issuedAt || new Date().toISOString();
	const rarity = rarityCore(pat);

	const core = {
		protocol: POG_PROTOCOL,
		certType: CERT_TYPE,
		certId: deriveCertId({ address, pattern: pat, format, nonce: freshnessNonce }),
		address,
		pattern: pat,
		format,
		scheme: scheme || defaultScheme(format),
		attempts: Number.isFinite(attempts) ? Math.round(attempts) : null,
		difficulty: {
			expectedAttempts: Math.round(expectedAttempts(pat.prefix || '', pat.suffix || '', pat.ignoreCase)),
			model: DIFFICULTY_MODEL,
		},
		rarity,
		freshness: {
			nonce: freshnessNonce,
			issuedAt: ts,
		},
		network,
		ts,
	};
	if (delivery && (delivery.sealed || delivery.sealedScheme)) {
		core.delivery = {
			sealed: !!delivery.sealed,
			sealedScheme: delivery.sealedScheme || null,
			sealedRecipient: delivery.sealedRecipient || null,
		};
	}
	if (nonCustody) core.nonCustody = normalizeNonCustody(nonCustody);
	if (keyId) core.keyId = keyId;
	return core;
}

function defaultScheme(format) {
	if (format === FORMAT_MNEMONIC) return 'bip39/slip10-ed25519';
	if (format === FORMAT_SPLIT_KEY) return SPLIT_KEY_SCHEME;
	return 'ed25519';
}

// Compact, signed subset of the rarity breakdown — enough to render a badge and
// re-verify honesty without bloating the certificate with the full bonus list.
function rarityCore(pattern) {
	const r = computeRarity(pattern);
	return {
		score: r.rarityScore,
		bits: r.rarityBits,
		tier: r.tier,
		tierLabel: r.tierLabel,
	};
}

function normalizeNonCustody(nc) {
	return {
		scheme: nc.scheme || SPLIT_KEY_SCHEME,
		buyerPublicKey: String(nc.buyerPublicKey || ''),
		serverComponent: String(nc.serverComponent || ''),
	};
}

/**
 * Sign a certificate core with the service's long-lived Ed25519 attestation key.
 * @param {object} p
 * @param {object} p.core - output of buildCertificateCore (or compatible).
 * @param {Uint8Array|string} p.signingSeed - 32-byte Ed25519 secret seed.
 * @param {string} [p.keyId] - attestation key id stamped into the signed core.
 * @returns {object} the full certificate { ...core, signature, servicePublicKey, signatureScheme }.
 */
export function signCertificate({ core, signingSeed, keyId }) {
	const seed = asBytes(signingSeed, 'signingSeed');
	if (seed.length !== 32) throw new Error('signingSeed must be 32 bytes');
	const signedCore = keyId && !core.keyId ? { ...core, keyId } : core;
	const msg = canonicalCertBytes(signedCore);
	const signature = ed25519.sign(msg, seed);
	const publicKey = ed25519.getPublicKey(seed);
	return {
		...signedCore,
		signature: bytesToHex(signature),
		servicePublicKey: bs58.encode(publicKey),
		signatureScheme: SIGNATURE_SCHEME,
	};
}

/**
 * Verify a certificate's attestation signature against a known public key.
 * @param {object} cert
 * @param {Uint8Array|string} servicePublicKey - 32-byte Ed25519 public key.
 * @returns {boolean}
 */
export function verifyCertificateSignature(cert, servicePublicKey) {
	if (!cert?.signature) return false;
	const { signature, servicePublicKey: _spk, signatureScheme: _ss, ...core } = cert;
	let sig;
	let pub;
	try {
		sig = hexToBytes(signature);
		pub = asBytes(servicePublicKey, 'servicePublicKey');
	} catch {
		return false;
	}
	try {
		return ed25519.verify(sig, canonicalCertBytes(core), pub);
	} catch {
		return false;
	}
}

/**
 * Recompute the split-key non-custody assertion from public values ONLY.
 *
 * Verifies that the vanity address is the elliptic-curve sum of the buyer's
 * partial public key P1 and the server's added public component a2·B:
 *
 *     P1 + a2·B == address   (as Ed25519 points)
 *
 * Because three.ws only ever knew `a2` (never P1's discrete log, the buyer's
 * secret p1), it could not reconstruct the full secret key p1 + a2. A tampered
 * `serverComponent`, `buyerPublicKey`, or `address` makes the sum diverge and
 * the check fails. No secret is required or revealed.
 *
 * @param {object} cert
 * @returns {{ ok: boolean, detail: string }}
 */
export function verifyNonCustody(cert) {
	const nc = cert?.nonCustody;
	if (!nc) return { ok: false, detail: 'certificate has no non-custody assertion' };
	if (nc.scheme !== SPLIT_KEY_SCHEME) {
		return { ok: false, detail: `unsupported non-custody scheme "${nc.scheme}"` };
	}
	let P1;
	let a2B;
	let target;
	try {
		P1 = decodePoint(nc.buyerPublicKey, 'buyerPublicKey');
		a2B = decodePoint(nc.serverComponent, 'serverComponent');
		target = decodePoint(cert.address, 'address');
	} catch (e) {
		return { ok: false, detail: e.message };
	}
	let sum;
	try {
		sum = P1.add(a2B);
	} catch (e) {
		return { ok: false, detail: `point addition failed: ${e.message}` };
	}
	const ok = sum.equals(target);
	return {
		ok,
		detail: ok
			? 'P1 + a2·B equals the vanity address — three.ws never held the buyer secret p1, so it could not reconstruct the full key'
			: 'P1 + a2·B does NOT equal the address — the non-custody relationship is broken (tampered offset/address)',
	};
}

// Decode a Base58 (or hex) 32-byte Ed25519 public key into a curve point. Throws
// on a malformed or off-curve encoding so a forged component is rejected.
function decodePoint(value, label) {
	let bytes;
	try {
		bytes = asBytes(value, label);
	} catch {
		throw new Error(`${label} is not valid Base58/hex`);
	}
	if (bytes.length !== 32) throw new Error(`${label} must be a 32-byte Ed25519 public key`);
	try {
		return Point.fromBytes(bytes);
	} catch {
		throw new Error(`${label} is not a valid point on Ed25519`);
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
 * Independently verify a proof-of-grind certificate. Recomputes every claim from
 * first principles and returns a per-check audit. Trusts nothing in the cert.
 *
 * @param {object} cert
 * @param {object} [opts]
 * @param {Uint8Array|string} [opts.servicePublicKey] - pinned attestation key. When
 *   omitted, the signature is checked against the cert's own `servicePublicKey`
 *   and `serviceKeyPinned` reports that no pin was supplied (so a self-signed
 *   impostor is caught the moment a pin IS given).
 * @param {Array<{keyId?:string, publicKeyBase58:string}>} [opts.keyring] - the set
 *   of valid attestation keys from /.well-known (rotation-aware). When supplied,
 *   the cert's keyId/servicePublicKey must appear in it.
 * @param {{certId?:string, nonce?:string}} [opts.canonical] - the registry's
 *   canonical first certificate for this address. When supplied, the pasted cert
 *   must match it (id + nonce) or the freshness check flags a possible re-sale.
 * @param {number} [opts.freshnessWindowMs] - if set, certs older than this fail
 *   freshness (the "freshly ground" claim has expired).
 * @param {number} [opts.now=Date.now()] - injected clock for deterministic tests.
 * @param {number} [opts.futureSkewMs=DEFAULT_FUTURE_SKEW_MS]
 * @param {Uint8Array} [opts.openedSecretSeed] - the 32-byte Ed25519 seed the buyer
 *   recovered from the sealed envelope (keypair/mnemonic). When present we confirm
 *   its public key equals the certificate address — you hold the very key attested.
 * @returns {{ valid:boolean, checks:VerifyCheck[], address:string, certId:string }}
 */
export function verifyProofOfGrind(cert, opts = {}) {
	const checks = [];
	const add = (id, label, pass, detail) => checks.push({ id, label, pass, detail });
	const now = Number.isFinite(opts.now) ? opts.now : Date.now();
	const futureSkewMs = Number.isFinite(opts.futureSkewMs) ? opts.futureSkewMs : DEFAULT_FUTURE_SKEW_MS;

	if (!cert || typeof cert !== 'object') {
		add('shape', 'Certificate is well-formed', false, 'certificate is missing or not an object');
		return { valid: false, checks, address: '', certId: '' };
	}
	if (cert.protocol !== POG_PROTOCOL || cert.certType !== CERT_TYPE) {
		add(
			'protocol',
			'Protocol version is supported',
			false,
			`certificate is "${cert.protocol}/${cert.certType}", expected "${POG_PROTOCOL}/${CERT_TYPE}"`,
		);
		return { valid: false, checks, address: cert.address || '', certId: cert.certId || '' };
	}
	add('protocol', 'Protocol version is supported', true, `${POG_PROTOCOL} · ${cert.format} grind`);

	// 1. The address is a valid Ed25519 public key (well-formed Solana address).
	{
		let ok = false;
		let detail = '';
		try {
			const bytes = bs58.decode(String(cert.address || ''));
			ok = bytes.length === 32;
			detail = ok ? `${cert.address}` : `decodes to ${bytes.length} bytes, expected 32`;
		} catch {
			detail = 'address is not valid Base58';
		}
		add('address', 'Address is a valid Solana public key', ok, detail);
	}

	// 2. certId binds the immutable facts + freshness nonce (tamper-evident id).
	{
		const expected = deriveCertId({
			address: cert.address,
			pattern: cert.pattern,
			format: cert.format,
			nonce: cert.freshness?.nonce,
		});
		const ok = expected === cert.certId;
		add(
			'certId',
			'Certificate id binds its contents',
			ok,
			ok
				? `certId = hash(address, pattern, format, nonce)`
				: `certId ${cert.certId} ≠ recomputed ${expected} — a field was altered after issuance`,
		);
	}

	// 3. The address satisfies the requested pattern.
	{
		const pat = cert.pattern || {};
		const ok = addressMatchesPattern(cert.address || '', pat);
		const want = [pat.prefix && `prefix "${pat.prefix}"`, pat.suffix && `suffix "${pat.suffix}"`]
			.filter(Boolean)
			.join(' + ') || '(no pattern)';
		add(
			'pattern',
			'Address satisfies the requested pattern',
			ok,
			ok ? `${cert.address} matches ${want}` : `${cert.address} does NOT match ${want}`,
		);
	}

	// 4. Difficulty claim is the honest probability model.
	//
	// A certificate is checked against the model it was *issued* under, named in
	// its own signed `difficulty.model` field. Certificates predating the Base58
	// leading-character correction declare v1 and keep verifying; re-scoring them
	// under v2 would retroactively brand honestly-issued receipts as fraudulent.
	// Absent field ⇒ v1, since every certificate issued before the correction
	// carried the uniform model.
	const certModel = cert.difficulty?.model || DIFFICULTY_MODEL_V1;
	{
		const pat = cert.pattern || {};
		const expected = Math.round(difficultyModel(certModel)(pat.prefix || '', pat.suffix || '', !!pat.ignoreCase));
		const ok = Number(cert.difficulty?.expectedAttempts) === expected;
		const stale = certModel !== DIFFICULTY_MODEL;
		add(
			'difficulty',
			'Difficulty matches the honest model',
			ok,
			ok
				? `expectedAttempts = ${expected} under ${certModel}` +
					(stale ? ` (superseded by ${DIFFICULTY_MODEL}; the claim is honest for its era)` : '')
				: `certificate claims ${cert.difficulty?.expectedAttempts}, ${certModel} model = ${expected}`,
		);
	}

	// 5. Rarity claim recomputes from the pattern (coordinated with the gallery).
	if (cert.rarity) {
		const r = computeRarity({ ...(cert.pattern || {}), model: certModel });
		const ok = Number(cert.rarity.score) === r.rarityScore && cert.rarity.tier === r.tier;
		add(
			'rarity',
			'Rarity score is honest',
			ok,
			ok
				? `${cert.rarity.tierLabel} · score ${r.rarityScore}`
				: `certificate claims score ${cert.rarity.score}/${cert.rarity.tier}, honest model = ${r.rarityScore}/${r.tier}`,
		);
	}

	// 6. Freshness: nonce well-formed, timestamp sane, not stale, not a re-sale.
	{
		const nonce = cert.freshness?.nonce;
		const issuedAt = cert.freshness?.issuedAt;
		const nonceOk = typeof nonce === 'string' && /^[0-9a-f]{64}$/i.test(nonce);
		const tMs = Date.parse(issuedAt || '');
		const tsOk = Number.isFinite(tMs);
		const notFuture = tsOk && tMs <= now + futureSkewMs;
		const ageMs = tsOk ? now - tMs : NaN;
		const notStale =
			!Number.isFinite(opts.freshnessWindowMs) || (tsOk && ageMs <= opts.freshnessWindowMs);
		// Registry uniqueness: when the caller supplies the canonical first cert for
		// this address, the pasted cert must BE that one — otherwise it is a second
		// "fresh" proof minted for an already-sold address (a re-sale/double-mint).
		const canonical = opts.canonical;
		const canonicalOk =
			!canonical || (canonical.certId === cert.certId && (!canonical.nonce || canonical.nonce === nonce));

		const ok = nonceOk && tsOk && notFuture && notStale && canonicalOk;
		let detail;
		if (!nonceOk) detail = 'freshness nonce missing or malformed (need 32-byte hex)';
		else if (!tsOk) detail = 'issuedAt is not a valid timestamp';
		else if (!notFuture) detail = `issuedAt ${issuedAt} is in the future beyond clock skew`;
		else if (!notStale) detail = `issued ${Math.round(ageMs / 1000)}s ago — beyond the freshness window`;
		else if (!canonicalOk)
			detail = 'a DIFFERENT certificate is registered for this address — this proof may be a re-sale/duplicate';
		else
			detail = canonical
				? `unique freshly-ground proof (nonce ${nonce.slice(0, 8)}…), confirmed canonical by the registry`
				: `freshly-ground proof (nonce ${nonce.slice(0, 8)}…) issued ${issuedAt}`;
		add('freshness', 'Freshly ground (single, non-replayed proof)', ok, detail);
	}

	// 7. Split-key non-custody (only meaningful when present).
	if (cert.format === FORMAT_SPLIT_KEY || cert.nonCustody) {
		const r = verifyNonCustody(cert);
		add('nonCustody', 'Split-key non-custody holds (P1 + a2·B = address)', r.ok, r.detail);
	}

	// 8. Attestation signature.
	{
		const pin = opts.servicePublicKey;
		const keyToCheck = pin ?? cert.servicePublicKey;
		const sigOk = verifyCertificateSignature(cert, keyToCheck);
		add(
			'signature',
			'three.ws attestation signature is valid',
			sigOk,
			sigOk ? `signed by ${cert.servicePublicKey}${cert.keyId ? ` (key ${cert.keyId})` : ''}` : 'signature does not verify against the attestation key',
		);

		// Rotation-aware pinning: prefer a keyring (set of valid keys) when given,
		// else a single pinned key, else report unpinned.
		let pinned = false;
		let pinDetail;
		if (Array.isArray(opts.keyring) && opts.keyring.length) {
			const match = opts.keyring.find(
				(k) =>
					sameKey(k.publicKeyBase58, cert.servicePublicKey) &&
					(!cert.keyId || !k.keyId || k.keyId === cert.keyId),
			);
			pinned = !!match;
			pinDetail = pinned
				? `attestation key ${cert.servicePublicKey} is in the published three.ws keyring`
				: `attestation key ${cert.servicePublicKey} is NOT in the published keyring — possible impostor`;
		} else if (pin) {
			pinned = sameKey(pin, cert.servicePublicKey);
			pinDetail = pinned
				? `certificate key ${cert.servicePublicKey} matches the pinned key`
				: `certificate key ${cert.servicePublicKey} ≠ pinned key — possible impostor`;
		} else {
			pinDetail =
				'no pinned key/keyring supplied — fetch /.well-known/three-vanity.json to pin and prove the signer is three.ws';
		}
		add('serviceKeyPinned', 'Signed by a published three.ws attestation key', pin || opts.keyring ? pinned : false, pinDetail);
	}

	// 9. (Optional) the opened secret is THE attested key (keypair/mnemonic).
	if (opts.openedSecretSeed) {
		let opened;
		try {
			opened = asBytes(opts.openedSecretSeed, 'openedSecretSeed');
			if (opened.length === 64) opened = opened.slice(0, 32);
		} catch (e) {
			opened = null;
			add('custody', 'Your recovered key is the attested key', false, e.message);
		}
		if (opened) {
			let ok = false;
			let detail;
			try {
				ok = opened.length === 32 && bs58.encode(ed25519.getPublicKey(opened)) === cert.address;
				detail = ok
					? 'the secret you opened derives to the certificate address — you hold the attested key'
					: 'the opened secret does NOT derive to the certificate address';
			} catch (e) {
				detail = e.message;
			}
			add('custody', 'Your recovered key is the attested key', ok, detail);
		}
	}

	// `serviceKeyPinned` only counts toward validity when a pin/keyring was given;
	// without one we still surface every other check as a self-consistency pass.
	const pinProvided = !!(opts.servicePublicKey || (Array.isArray(opts.keyring) && opts.keyring.length));
	const required = checks.filter((c) => c.id !== 'serviceKeyPinned' || pinProvided);
	const valid = required.every((c) => c.pass);
	return { valid, checks, address: cert.address || '', certId: cert.certId || '' };
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

export { BASE58_ALPHABET, validatePattern };
