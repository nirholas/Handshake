// Verifiable 3D provenance — the pure core of signed content credentials for
// AI-generated 3D. C2PA-style authenticity for GLBs: every asset three.ws
// generates can carry a signed credential (who made it, from what prompt, by
// which model, when, its full lineage, and the sha256 of the GLB bytes), whose
// hash is anchored on Solana so anyone can confirm the asset wasn't tampered with
// and genuinely originated here.
//
// This module is dependency-light (node crypto for sha256, @noble ed25519 for
// signatures) and side-effect-free — no fetch, no chain, no R2 — so the hashing,
// credential shape, and sign/verify logic are unit-tested in isolation and load
// unchanged in the api/ bundle and the free OpenAI track. It carries ZERO
// payment/wallet/coin surface: the FREE verify path uses only these primitives.
// Spec: specs/PROVENANCE_3D.md.

import { createHash } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import bs58 from 'bs58';

// The version new credentials are stamped with. v2 adds one optional field,
// `simReadiness` (specs/SIM_READINESS.md), to the v1 body and changes nothing
// else. The additive-field rule in specs/PROVENANCE_3D.md requires the new
// string anyway, because a verifier must select behaviour by version rather
// than by sniffing which fields happen to be present.
export const PROVENANCE_3D_VERSION = 'threews.provenance.3d.v2';

// Every version this verifier implements. v1 credentials were signed over their
// own canonical bytes and keep verifying unchanged, permanently: a credential is
// evidence, and evidence does not expire when the schema moves. A version NOT in
// this set is not a failure of the credential, it is a limit of this verifier:
// decideVerdict says so rather than guessing at a schema it does not implement.
export const PROVENANCE_3D_VERSIONS = Object.freeze([
	'threews.provenance.3d.v1',
	'threews.provenance.3d.v2',
]);

const KNOWN_VERSIONS = new Set(PROVENANCE_3D_VERSIONS);

/** sha256 of raw bytes → lowercase hex. The GLB content hash. */
export function sha256Hex(bytes) {
	return createHash('sha256').update(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)).digest('hex');
}

// Deterministic JSON: object keys sorted recursively so the signed bytes are
// identical on both the signing and verifying side regardless of key order.
function canonicalize(value) {
	if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
	if (value && typeof value === 'object') {
		const keys = Object.keys(value).sort();
		return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
	}
	return JSON.stringify(value === undefined ? null : value);
}

// The exact keys a signed grade may carry, per specs/SIM_READINESS.md. Anything
// else handed to buildCredential is dropped rather than signed: the canonical
// bytes are a contract, and an unexpected key in them is a credential no other
// implementation can reproduce.
const SIM_READINESS_KEYS = Object.freeze([
	'grader', 'verdict', 'blockers', 'volumeM3', 'longestAxisMeters', 'inertiaUnitDensity', 'convexityRatio',
]);

// Keep only the documented keys, and only when the grade actually says
// something. A grade without a grader version or a verdict is not a claim
// anyone can check later, so it is omitted instead of signed.
function normalizeSimReadiness(value) {
	if (!value || typeof value !== 'object') return null;
	if (typeof value.grader !== 'string' || typeof value.verdict !== 'string') return null;
	const out = {};
	for (const key of SIM_READINESS_KEYS) {
		if (value[key] !== undefined && value[key] !== null) out[key] = value[key];
	}
	return out;
}

/**
 * Build the unsigned credential body. Only the fields provided are included
 * (lineage/assetId are optional), and the shape is fixed so the canonical form is
 * stable. `glbSha256` and `createdAt` are required — a credential without the
 * content hash or a timestamp is meaningless.
 *
 * @param {{ glbSha256:string, createdAt:string, creator?:string, prompt?:string,
 *           model?:string, provider?:string, lineage?:Array, assetId?:string,
 *           simReadiness?:object }} f
 * @returns {object} the unsigned credential
 */
export function buildCredential(f) {
	if (!f || typeof f.glbSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(f.glbSha256)) {
		throw new Error('buildCredential: glbSha256 must be a 64-char hex sha256');
	}
	if (!f.createdAt) throw new Error('buildCredential: createdAt is required');
	const cred = {
		version: PROVENANCE_3D_VERSION,
		glbSha256: f.glbSha256,
		createdAt: f.createdAt,
	};
	if (f.assetId) cred.assetId = String(f.assetId);
	if (f.creator) cred.creator = String(f.creator);
	if (f.prompt) cred.prompt = String(f.prompt);
	if (f.model) cred.model = String(f.model);
	if (f.provider) cred.provider = String(f.provider);
	if (Array.isArray(f.lineage) && f.lineage.length) cred.lineage = f.lineage.map(String);
	// v2's one additive field: the physics grade for these exact bytes, signed so
	// it cannot be forged the way an unsigned report can. Absent when the asset
	// could not be graded. An omitted claim beats a fabricated one.
	const simReadiness = normalizeSimReadiness(f.simReadiness);
	if (simReadiness) cred.simReadiness = simReadiness;
	return cred;
}

/** The canonical bytes signed/verified for a credential body. */
export function credentialCanonicalBytes(credential) {
	return Buffer.from(canonicalize(credential), 'utf8');
}

/** sha256 (hex) of the canonical credential — its content address (R2 key + anchor payload). */
export function credentialHash(credential) {
	return sha256Hex(credentialCanonicalBytes(credential));
}

/**
 * Sign a credential body with an ed25519 secret key (a Solana Keypair's 64-byte
 * secretKey or a raw 32-byte seed). Returns the base58 signature + issuer pubkey.
 */
export function signCredential(credential, secretKey) {
	const seed = secretKey.length >= 64 ? secretKey.slice(0, 32) : secretKey.slice(0, 32);
	const msg = credentialCanonicalBytes(credential);
	const sig = ed25519.sign(msg, seed);
	const pub = ed25519.getPublicKey(seed);
	return { signature: bs58.encode(sig), issuer: bs58.encode(pub) };
}

/**
 * Verify a credential's signature against an issuer's base58 ed25519 public key.
 * Pure and offline — no chain read. Returns true iff the signature is valid over
 * the canonical credential bytes.
 */
export function verifyCredentialSignature(credential, signatureBs58, issuerBs58) {
	try {
		const msg = credentialCanonicalBytes(credential);
		const sig = bs58.decode(signatureBs58);
		const pub = bs58.decode(issuerBs58);
		return ed25519.verify(sig, msg, pub);
	} catch {
		return false;
	}
}

/**
 * The core verify decision, given the GLB's actual sha256 and a stored, signed
 * credential envelope. Pure — the caller fetches bytes and the credential; this
 * decides the verdict.
 *
 * Behaviour is selected by `credential.version`, which is what the version
 * string is for. Both implemented versions verify identically: the signature is
 * over the credential's own canonical bytes, so a v1 record signed before v2
 * existed still verifies byte for byte, permanently. What the version decides is
 * which fields this verifier is licensed to read back: only v2 may carry a
 * signed `simReadiness` grade. A version this build does not implement is
 * reported as unknown rather than guessed at, because stating a verdict over a
 * schema you do not implement is how a verifier starts lying.
 *
 * @param {string} glbSha256                 sha256 of the bytes actually served
 * @param {{ credential:object, signature:string, issuer:string }|null} envelope
 * @returns {{ status:'verified'|'tampered'|'unknown', reason:string,
 *             version?:string, simReadiness?:object|null }}
 */
export function decideVerdict(glbSha256, envelope) {
	if (!envelope || !envelope.credential) {
		return { status: 'unknown', reason: 'no provenance credential is on record for this asset' };
	}
	const { credential, signature, issuer } = envelope;
	const version = typeof credential.version === 'string' ? credential.version : '';
	if (!KNOWN_VERSIONS.has(version)) {
		return {
			status: 'unknown',
			reason: `this credential was issued under provenance version ${version || '(none)'}, which this verifier does not implement`,
			version,
		};
	}
	if (!verifyCredentialSignature(credential, signature, issuer)) {
		return { status: 'tampered', reason: 'the credential signature does not verify, so the record was altered', version };
	}
	if (credential.glbSha256 !== glbSha256) {
		return { status: 'tampered', reason: 'the model bytes do not match the signed content hash, so the asset was modified', version };
	}
	return {
		status: 'verified',
		reason: 'the model matches its signed credential',
		version,
		// v1 predates the field entirely, so a v1 record never carries a grade no
		// matter what a caller reads into it.
		simReadiness: version === 'threews.provenance.3d.v1' ? null : (credential.simReadiness ?? null),
	};
}

/** R2 object key a credential envelope is stored at, addressed by the GLB hash. */
export function provenanceKey(glbSha256) {
	return `provenance/${glbSha256}.json`;
}

/** A Solana explorer URL for an anchor transaction on a given cluster. */
export function explorerTxUrl(signature, cluster = 'devnet') {
	const c = cluster === 'mainnet' || cluster === 'mainnet-beta' ? '' : `?cluster=${cluster}`;
	return `https://explorer.solana.com/tx/${signature}${c}`;
}
