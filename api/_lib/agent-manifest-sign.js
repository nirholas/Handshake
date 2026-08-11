// Signed agent manifests — the pure core of "this agent's behavior is provable".
//
// An agent's system prompt is the whole of its behavior. Kept only in our
// database it is a claim: users have to trust that the prompt they were shown is
// the prompt that actually runs, and a buyer of a forked agent has no way to know
// what they bought. This module turns the prompt (plus the body, voice, skills,
// and on-chain identity that surround it) into a canonical document, digests it,
// and signs the digest with the platform's ed25519 attester identity — the same
// Solana key behind 3D provenance credentials and event attestations. Pin the
// signed envelope to IPFS and the CID is a permanent, portable, independently
// checkable record of exactly how the agent was configured at that moment.
//
// Deliberately pure: node crypto for sha256, @noble ed25519 for signatures,
// bs58 for encoding. No DB, no fetch, no chain — so the sign/verify/diff logic is
// unit-tested directly and is exactly what an outside verifier runs offline.
// The DB, attester-key, and pinning I/O live in agent-manifest-publish.js.
//
// Spec: specs/AGENT_MANIFEST.md (§ Signed envelope).

import { createHash } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import bs58 from 'bs58';

/** Envelope wire version. Bump on any breaking change to the signed bytes. */
export const AGENT_MANIFEST_ENVELOPE_VERSION = 'threews.agent.manifest.v1';

/** Manifest body profile emitted by this module (see specs/AGENT_MANIFEST.md). */
export const AGENT_MANIFEST_SPEC = 'agent-manifest/0.3';

// Deterministic JSON: keys sorted recursively and undefined dropped, so the
// signed bytes are byte-identical on the signing and verifying side regardless
// of property insertion order or JS engine.
function canonicalize(value) {
	if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
	if (value && typeof value === 'object') {
		const keys = Object.keys(value)
			.filter((k) => value[k] !== undefined)
			.sort();
		return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
	}
	return JSON.stringify(value === undefined ? null : value);
}

/** sha256 of a string or buffer as lowercase hex. */
export function sha256Hex(input) {
	const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
	return createHash('sha256').update(buf).digest('hex');
}

function str(v, fallback = '') {
	return typeof v === 'string' ? v : v == null ? fallback : String(v);
}

function cleanList(v) {
	return Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : [];
}

/**
 * Build the canonical manifest body for an agent.
 *
 * Only fields that describe how the agent behaves or is embodied are included.
 * Volatile operational state (view counts, last-seen, balances) is excluded on
 * purpose: re-signing on every heartbeat would make the CID meaningless, and a
 * manifest is a statement about configuration, not about traffic.
 *
 * @param {object} a
 * @param {string} a.agentId
 * @param {string} a.name
 * @param {string} [a.description]
 * @param {string[]} [a.tags]
 * @param {string} [a.image]
 * @param {string} a.systemPrompt   the compiled persona prompt — the behavior itself
 * @param {string[]} [a.toneTags]
 * @param {object} [a.traits]       trait key → 0..1
 * @param {string} [a.greeting]
 * @param {{uri:string, format?:string}} [a.body]
 * @param {{provider?:string, voiceId?:string}} [a.voice]
 * @param {string[]} [a.skills]
 * @param {{chainId?:number|string, registry?:string, agentId?:string}} [a.registration]
 * @param {string} [a.homeUrl]
 * @param {string} [a.createdAt]    ISO
 * @param {string} [a.updatedAt]    ISO — when the persona last changed
 * @returns {object} the manifest body
 */
export function buildAgentManifest(a) {
	if (!a || !a.agentId) throw new Error('buildAgentManifest: agentId is required');
	const systemPrompt = str(a.systemPrompt);
	if (!systemPrompt.trim()) {
		throw new Error('buildAgentManifest: systemPrompt is required — an unconfigured agent has nothing to attest');
	}

	const traits = {};
	if (a.traits && typeof a.traits === 'object') {
		for (const key of Object.keys(a.traits).sort()) {
			const n = Number(a.traits[key]);
			if (Number.isFinite(n)) traits[key] = n;
		}
	}

	const manifest = {
		$schema: 'https://three.ws/schemas/agent-manifest/0.3.json',
		spec: AGENT_MANIFEST_SPEC,
		id: { agentId: String(a.agentId), platform: 'three.ws' },
		name: str(a.name, 'Agent'),
		description: str(a.description),
		tags: cleanList(a.tags),
		brain: {
			// The hosted failover chain (api/_lib/llm.js), not a single vendor: the
			// manifest attests the instructions, which are what determine behavior.
			provider: 'threews',
			instructions: {
				format: 'text/markdown',
				sha256: sha256Hex(systemPrompt),
				text: systemPrompt,
			},
			toneTags: cleanList(a.toneTags),
			traits,
		},
		createdAt: str(a.createdAt) || null,
		updatedAt: str(a.updatedAt) || null,
	};

	if (a.image) manifest.image = String(a.image);
	if (a.greeting) manifest.greeting = String(a.greeting);
	if (a.homeUrl) manifest.homeUrl = String(a.homeUrl);
	if (a.body?.uri) {
		manifest.body = { uri: String(a.body.uri), format: str(a.body.format, 'gltf-binary') };
	}
	if (a.voice?.provider || a.voice?.voiceId) {
		manifest.voice = {
			tts: {
				provider: str(a.voice.provider, 'browser'),
				...(a.voice.voiceId ? { voiceId: String(a.voice.voiceId) } : {}),
			},
		};
	}
	const skills = cleanList(a.skills);
	if (skills.length) manifest.skills = skills;
	if (a.registration?.chainId && a.registration?.agentId) {
		manifest.registrations = [
			{
				agentRegistry: `eip155:${a.registration.chainId}:${str(a.registration.registry)}`,
				agentId: String(a.registration.agentId),
			},
		];
	}

	return manifest;
}

/**
 * The exact bytes that get hashed. Covers the manifest AND the issuer/timestamp,
 * so neither the content nor the authorship claim can be edited after signing.
 *
 * @param {{manifest:object, issuer:string, signedAt:string}} statement
 * @returns {Buffer}
 */
export function statementBytes({ manifest, issuer, signedAt }) {
	return Buffer.from(
		canonicalize({
			v: AGENT_MANIFEST_ENVELOPE_VERSION,
			manifest,
			issuer: str(issuer),
			signedAt: str(signedAt),
		}),
		'utf8',
	);
}

/** sha256 (hex) of the signed statement — the envelope's `digest`. */
export function statementDigest(statement) {
	return sha256Hex(statementBytes(statement));
}

/**
 * sha256 (hex) of the manifest body alone, ignoring issuer and timestamp. Stable
 * across re-signs of identical configuration, so callers can tell "the agent
 * actually changed" from "someone hit save again" without pinning a duplicate.
 */
export function manifestBodyDigest(manifest) {
	return sha256Hex(canonicalize(manifest));
}

/**
 * The message actually run through ed25519. Domain-separating the digest keeps a
 * manifest signature from ever being replayable as some other three.ws signature.
 */
export function signingMessage(digest) {
	return Buffer.from(`${AGENT_MANIFEST_ENVELOPE_VERSION}:${digest}`, 'utf8');
}

/**
 * Sign a manifest with an ed25519 secret key (a Solana Keypair's 64-byte
 * secretKey or a raw 32-byte seed). Pure crypto — no DB, no network.
 *
 * @param {object} manifest    from buildAgentManifest
 * @param {Uint8Array} secretKey
 * @param {{signedAt?:string}} [opts]
 * @returns {object} the signed envelope
 */
export function signAgentManifest(manifest, secretKey, { signedAt } = {}) {
	const seed = secretKey.slice(0, 32);
	const issuer = bs58.encode(ed25519.getPublicKey(seed));
	const at = signedAt || new Date().toISOString();
	const digest = statementDigest({ manifest, issuer, signedAt: at });
	const signature = bs58.encode(ed25519.sign(signingMessage(digest), seed));

	return {
		spec: AGENT_MANIFEST_ENVELOPE_VERSION,
		manifest,
		issuer,
		signedAt: at,
		digest,
		algorithm: 'ed25519',
		signature,
	};
}

/** Canonical bytes of a whole envelope — exactly what gets pinned to IPFS. */
export function envelopeBytes(envelope) {
	return Buffer.from(JSON.stringify(envelope, null, 2), 'utf8');
}

/**
 * Verify a signed envelope. Pure and offline: this is the function an outside
 * party runs on bytes fetched from an IPFS gateway.
 *
 * @param {object} envelope
 * @param {{issuer?:string}} [expect] optionally pin the accepted issuer pubkey
 * @returns {{valid:boolean, reason:string, digest:string|null, issuer:string|null}}
 */
export function verifyAgentManifest(envelope, { issuer: expectedIssuer } = {}) {
	if (!envelope || typeof envelope !== 'object' || !envelope.manifest) {
		return { valid: false, reason: 'not_an_envelope', digest: null, issuer: null };
	}
	if (envelope.spec !== AGENT_MANIFEST_ENVELOPE_VERSION) {
		return { valid: false, reason: 'unsupported_envelope_version', digest: null, issuer: envelope.issuer || null };
	}
	if (envelope.algorithm && envelope.algorithm !== 'ed25519') {
		return { valid: false, reason: 'unsupported_algorithm', digest: null, issuer: envelope.issuer || null };
	}
	if (!envelope.issuer || !envelope.signature || !envelope.signedAt) {
		return { valid: false, reason: 'unsigned', digest: null, issuer: envelope.issuer || null };
	}

	const digest = statementDigest({
		manifest: envelope.manifest,
		issuer: envelope.issuer,
		signedAt: envelope.signedAt,
	});
	if (envelope.digest && envelope.digest.toLowerCase() !== digest) {
		return { valid: false, reason: 'digest_mismatch', digest, issuer: envelope.issuer };
	}
	if (expectedIssuer && expectedIssuer !== envelope.issuer) {
		return { valid: false, reason: 'issuer_mismatch', digest, issuer: envelope.issuer };
	}

	let ok = false;
	try {
		ok = ed25519.verify(bs58.decode(envelope.signature), signingMessage(digest), bs58.decode(envelope.issuer));
	} catch {
		return { valid: false, reason: 'malformed_signature', digest, issuer: envelope.issuer };
	}

	// The instructions carry their own hash so a reader can spot a swapped prompt
	// without recomputing the whole envelope. A mismatch means the document is
	// internally inconsistent even if the outer signature checks out.
	const instructions = envelope.manifest?.brain?.instructions;
	if (ok && instructions && typeof instructions.text === 'string' && instructions.sha256) {
		if (sha256Hex(instructions.text) !== String(instructions.sha256).toLowerCase()) {
			return { valid: false, reason: 'instructions_hash_mismatch', digest, issuer: envelope.issuer };
		}
	}

	return {
		valid: ok,
		reason: ok ? 'ok' : 'signature_invalid',
		digest,
		issuer: envelope.issuer,
	};
}

// Fields compared when diffing a pinned manifest against live agent config.
// Nested paths are resolved with a plain dotted walk.
const DIFF_FIELDS = [
	'name',
	'description',
	'greeting',
	'image',
	'homeUrl',
	'brain.instructions.text',
	'brain.instructions.sha256',
	'brain.provider',
	'body.uri',
	'body.format',
	'voice.tts.provider',
	'voice.tts.voiceId',
];

const DIFF_LISTS = ['tags', 'skills', 'brain.toneTags'];

function at(obj, path) {
	return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function sameList(a, b) {
	const x = cleanList(a);
	const y = cleanList(b);
	return x.length === y.length && x.every((v, i) => v === y[i]);
}

/**
 * Diff a pinned manifest against the agent's live configuration. This is the
 * "is the running agent still the agent you verified?" check: identical means
 * the pinned CID describes production exactly; drift lists precisely what moved.
 *
 * @param {object} pinned  a manifest body (envelope.manifest)
 * @param {object} live    a manifest body built from current DB state
 * @returns {{identical:boolean, changed:Array<{field:string, pinned:*, live:*}>}}
 */
export function diffAgentManifest(pinned, live) {
	const changed = [];
	for (const field of DIFF_FIELDS) {
		const p = at(pinned, field);
		const l = at(live, field);
		if ((p ?? null) !== (l ?? null)) changed.push({ field, pinned: p ?? null, live: l ?? null });
	}
	for (const field of DIFF_LISTS) {
		const p = at(pinned, field);
		const l = at(live, field);
		if (!sameList(p, l)) changed.push({ field, pinned: cleanList(p), live: cleanList(l) });
	}

	const pTraits = pinned?.brain?.traits || {};
	const lTraits = live?.brain?.traits || {};
	for (const key of new Set([...Object.keys(pTraits), ...Object.keys(lTraits)])) {
		if (Number(pTraits[key] ?? NaN) !== Number(lTraits[key] ?? NaN)) {
			changed.push({
				field: `brain.traits.${key}`,
				pinned: pTraits[key] ?? null,
				live: lTraits[key] ?? null,
			});
		}
	}

	changed.sort((a, b) => a.field.localeCompare(b.field));
	return { identical: changed.length === 0, changed };
}
