// /api/x402/did — dual-mode DID endpoint.
//
//   GET  → /.well-known/did.json — W3C DID Document for the x402 Offer & Receipt
//          signing key (USE-17). Free. Verifiers resolve our `kid` back to a
//          public key here when checking EIP-712 / JWS signatures on offers and
//          receipts. Per spec §4.5.1 the resolved key is "authorized to sign for
//          the service identified by the payload's resourceUrl", so listing the
//          signer address (eip712) or public JWK (jws) here is the binding
//          between our HTTPS origin and the signing material. Routed via
//          vercel.json: /.well-known/did.json → /api/x402/did.
//
//   POST → DID Verification Canary (USE-069). Paid $0.001 USDC. Resolves our
//          published DID document over the real public route an external
//          verifier would hit, validates it is a structurally correct W3C DID
//          document with our x402 service binding, and measures end-to-end
//          resolution latency. The verdict ({ verified, latency_ms }) is the
//          actionable signal: a malformed/unreachable document means any
//          counterparty verifying our offer/receipt signatures fails silently,
//          and a slow resolver degrades their settlement path. The autonomous
//          loop pays this canary on a schedule and records the verdict to
//          x402_autonomous_log so the status surface flags a broken or slow DID
//          subsystem before a partner does. Body:
//            { "did": "did:three:canary", "mode": "verify" }
//
// When no issuer is configured the GET path returns 404 — there's nothing to
// publish — and the POST canary truthfully reports verified:false (not_configured).

import { cors, json, error, readBody as readRawBody } from '../_lib/http.js';
import { env } from '../_lib/env.js';
import { getIssuer } from '../_lib/x402/offer-receipt-issuer.js';
import { paidEndpoint } from '../_lib/x402-paid-endpoint.js';
import { buildBazaarSchema } from '../_lib/x402-spec.js';
import { withService } from '../_lib/x402/bazaar-helpers.js';
import { installAccessControl } from '../_lib/x402/access-control.js';
import { sql } from '../_lib/db.js';
import { priceFor } from '../_lib/x402-prices.js';

const ROUTE = '/api/x402/did';

// W3C DID Core v1 context — a conformant DID document MUST list it first.
const DID_V1_CONTEXT = 'https://www.w3.org/ns/did/v1';

// The canary fails the latency leg above this. A DID document resolution that
// external verifiers experience should be well under a second; 1500ms leaves
// generous headroom for a cold serverless route + TLS while still catching a
// genuinely degraded resolver.
const MAX_LATENCY_MS = 1500;

// Resolve the origin we publish the DID document on. APP_ORIGIN is always a
// valid absolute origin (env normalizes it); SERVER_DOMAIN is the bare host.
function publicOrigin() {
	return env.APP_ORIGIN || (env.SERVER_DOMAIN ? `https://${env.SERVER_DOMAIN}` : 'https://three.ws');
}

// Build the W3C DID Document from the configured offer-receipt issuer. Returns
// null when no signing key is configured (caller emits 404). Shared by the GET
// publisher and — indirectly, via the public route — the POST canary, so both
// always agree on the document shape.
export async function buildDidDocument() {
	const built = await getIssuer();
	if (!built) return null;

	const domain = env.SERVER_DOMAIN;
	const id = `did:web:${domain}`;
	const verificationMethod = [];

	if (built.format === 'eip712') {
		// did:pkh authorization for EIP-712 verifiers. The recovered signer
		// address from any EIP-712 signature MUST match the address embedded in
		// this entry's blockchainAccountId for the offer/receipt to be accepted
		// as originating from this resource server.
		verificationMethod.push({
			id: built.kid,
			type: 'EcdsaSecp256k1RecoveryMethod2020',
			controller: id,
			blockchainAccountId: `eip155:1:${built.signerAddress}`,
		});
	} else if (built.format === 'jws' && built.publicKey) {
		verificationMethod.push({
			id: built.kid,
			type: 'JsonWebKey2020',
			controller: id,
			publicKeyJwk: {
				...built.publicKey.jwk,
				alg: built.publicKey.alg,
			},
		});
	}

	return {
		'@context': [
			DID_V1_CONTEXT,
			'https://w3id.org/security/suites/jws-2020/v1',
			'https://w3id.org/security/suites/secp256k1recovery-2020/v1',
		],
		id,
		verificationMethod,
		// The same key authorizes both offer and receipt signing — assertionMethod
		// is the W3C term that maps cleanly onto "this key signs claims about the
		// service". authentication is included so DID-aware clients can also use
		// the key for SIWX-style flows if we wire them up later.
		assertionMethod: [built.kid],
		authentication: [built.kid],
		service: [
			{
				id: `${id}#x402`,
				type: 'x402PaymentService',
				serviceEndpoint: env.APP_ORIGIN,
			},
		],
	};
}

// Structural validation of a resolved DID document against the subset of W3C
// DID Core our verifiers depend on, plus our x402 service binding. Returns a
// per-check breakdown so the canary's signal pinpoints what regressed.
export function validateDidDocument(doc) {
	const ctx = doc && doc['@context'];
	const ctxList = Array.isArray(ctx) ? ctx : ctx ? [ctx] : [];
	const vm = Array.isArray(doc?.verificationMethod) ? doc.verificationMethod : [];
	const assertion = Array.isArray(doc?.assertionMethod) ? doc.assertionMethod : [];
	const services = Array.isArray(doc?.service) ? doc.service : [];
	const vmIds = new Set(vm.map((m) => m && m.id).filter(Boolean));

	const checks = {
		is_object: !!doc && typeof doc === 'object' && !Array.isArray(doc),
		has_did_context: ctxList.includes(DID_V1_CONTEXT),
		has_did_id: typeof doc?.id === 'string' && /^did:/.test(doc.id),
		// Every verification method must carry the triple verifiers key off of.
		has_verification_method:
			vm.length > 0 &&
			vm.every((m) => m && typeof m.id === 'string' && typeof m.type === 'string' && typeof m.controller === 'string'),
		// assertionMethod must reference a real verification method (string ref or
		// embedded object) — the binding that authorizes the key to sign claims.
		assertion_resolves:
			assertion.length > 0 &&
			assertion.some((a) => (typeof a === 'string' ? vmIds.has(a) : !!a && vmIds.has(a.id))),
		// Our specific binding: the x402 payment service entry verifiers look for.
		has_x402_service: services.some(
			(s) => s && s.type === 'x402PaymentService' && typeof s.serviceEndpoint === 'string',
		),
	};
	checks.valid = Object.values(checks).every(Boolean);
	return checks;
}

// ── GET: publish the DID document (free) ─────────────────────────────────────
async function handleDidDocument(req, res) {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', origins: '*' })) return;

	let doc;
	try {
		doc = await buildDidDocument();
	} catch (err) {
		console.error('[x402/did] issuer error:', err?.message);
		return error(res, 500, 'issuer_misconfigured', 'signing key configuration error');
	}
	if (!doc) {
		return error(
			res,
			404,
			'not_configured',
			'no offer-receipt signing key is configured for this deployment',
		);
	}

	json(res, 200, doc, {
		'content-type': 'application/did+json; charset=utf-8',
		'cache-control': 'public, max-age=300',
	});
}

// ── POST: DID Verification Canary (paid $0.001 USDC) ─────────────────────────
const DESCRIPTION =
	'DID Verification Canary — pay $0.001 USDC to resolve three.ws\'s published ' +
	'W3C DID document over its real public route, structurally validate it, and ' +
	'measure end-to-end resolution latency. Returns { verified, latency_ms } plus ' +
	'a per-check breakdown. verified=false when the document is unreachable, ' +
	'malformed, or slower than 1500ms — the same failure an external x402 verifier ' +
	'would hit resolving our offer/receipt signing key.';

const INPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	properties: {
		did: {
			type: 'string',
			description: 'DID to verify (echoed for round-trip confirmation).',
			default: 'did:three:canary',
		},
		mode: {
			type: 'string',
			enum: ['verify'],
			description: 'Operation. Only "verify" is supported.',
			default: 'verify',
		},
	},
};

const OUTPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['verified', 'latency_ms', 'did', 'mode', 'ts'],
	properties: {
		verified: { type: 'boolean' },
		latency_ms: { type: 'integer' },
		did: { type: 'string' },
		mode: { type: 'string' },
		resolved_did: { type: ['string', 'null'] },
		http_status: { type: 'integer' },
		within_latency: { type: 'boolean' },
		malformed: { type: 'boolean' },
		configured: { type: 'boolean' },
		checks: { type: 'object' },
		ts: { type: 'string', format: 'date-time' },
	},
};

const BAZAAR = {
	description: DESCRIPTION,
	useCases: ['DID resolution health', 'offer/receipt signing-key verification', 'identity canary'],
	input: { type: 'json', example: { did: 'did:three:canary', mode: 'verify' }, schema: INPUT_SCHEMA },
	output: {
		type: 'json',
		example: {
			verified: true,
			latency_ms: 142,
			did: 'did:three:canary',
			mode: 'verify',
			resolved_did: 'did:web:three.ws',
			http_status: 200,
			within_latency: true,
			malformed: false,
			configured: true,
			checks: {
				is_object: true,
				has_did_context: true,
				has_did_id: true,
				has_verification_method: true,
				assertion_resolves: true,
				has_x402_service: true,
				valid: true,
			},
			ts: '2026-06-27T10:00:00Z',
		},
	},
	schema: buildBazaarSchema({ method: 'POST', bodySchema: INPUT_SCHEMA, outputSchema: OUTPUT_SCHEMA }),
};

async function readBody(req) {
	// req.body is pre-parsed by Vercel; fall back to manual stream read for
	// edge / test environments that hand a raw IncomingMessage.
	if (req.body && typeof req.body === 'object') return req.body;
	try {
		const chunks = [await readRawBody(req, 1_000_000)];
		const raw = Buffer.concat(chunks).toString('utf8');
		return raw ? JSON.parse(raw) : {};
	} catch {
		return {};
	}
}

// Turn one resolution attempt into the canary verdict. Pure (no I/O), so the
// verdict logic is unit-testable without a live resolver, same pattern as
// validateDidDocument above.
//
// `configured` answers "is a DID document published here", which only a real
// HTTP answer can settle: 404 proves no document, any other status proves one
// is being served. A transport failure (http_status 0: DNS, TLS, timeout)
// proves neither, so it reports false rather than claiming a document we never
// saw. `fetch_error` distinguishes that case from a genuine 404.
export function summarizeResolution({ httpStatus, doc, latency_ms, did, fetchError = null }) {
	const checks = validateDidDocument(doc);
	const configured = httpStatus > 0 && httpStatus !== 404;
	const malformed = httpStatus !== 200 || !checks.valid;
	const within_latency = latency_ms <= MAX_LATENCY_MS;

	return {
		verified: !malformed && within_latency,
		latency_ms,
		did,
		mode: 'verify',
		resolved_did: typeof doc?.id === 'string' ? doc.id : null,
		http_status: httpStatus,
		within_latency,
		malformed,
		configured,
		checks,
		...(fetchError ? { fetch_error: fetchError } : {}),
		ts: new Date().toISOString(),
	};
}

async function runVerify({ did }) {
	const url = `${publicOrigin()}/.well-known/did.json`;
	const t0 = Date.now();
	let httpStatus = 0;
	let doc = null;
	let fetchError = null;
	try {
		const r = await fetch(url, {
			headers: { accept: 'application/did+json, application/json', 'user-agent': 'threews-did-canary/1.0' },
			signal: AbortSignal.timeout(5000),
		});
		httpStatus = r.status;
		const text = await r.text();
		try { doc = JSON.parse(text); } catch { doc = null; }
	} catch (err) {
		fetchError = err?.message || 'fetch_failed';
	}

	return summarizeResolution({ httpStatus, doc, latency_ms: Date.now() - t0, did, fetchError });
}

// Sweep the N most recently created agent identities and check each for
// resolvable key material. An agent without wallet_address has no cryptographic
// material to build a DID from — it cannot sign claims or be verified by
// counterparties. failed_count > 0 is the alert signal.
async function runSweep({ limit }) {
	const rows = await sql`
		SELECT id, wallet_address, created_at
		FROM agent_identities
		WHERE deleted_at IS NULL
		ORDER BY created_at DESC
		LIMIT ${limit}
	`;

	const dids = rows.map((r) => {
		const resolvable = typeof r.wallet_address === 'string' && r.wallet_address.length > 0;
		const did = resolvable
			? `did:pkh:solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:${r.wallet_address}`
			: `did:web:three.ws/agents/${r.id}`;
		return {
			did,
			agent_id: r.id,
			resolvable,
			wallet_address: r.wallet_address || null,
			created_at: r.created_at ? new Date(r.created_at).toISOString() : null,
		};
	});

	const count = dids.length;
	const resolvable_count = dids.filter((d) => d.resolvable).length;
	const failed_count = count - resolvable_count;

	return {
		mode: 'sweep',
		count,
		resolvable_count,
		failed_count,
		dids,
		ts: new Date().toISOString(),
	};
}

const verifyCanary = paidEndpoint({
	route: ROUTE,
	method: 'POST',
	priceAtomics: priceFor('did_verify', '1000'), // $0.001 USDC
	networks: ['solana', 'base'],
	description: DESCRIPTION,
	bazaar: BAZAAR,
	service: withService({
		serviceName: 'three.ws DID Health',
		tags: ['did', 'identity', 'health', 'verification', 'registry', 'x402'],
	}),
	accessControl: installAccessControl({ requiredScope: 'x402:bypass' }),

	async handler({ req }) {
		const body = await readBody(req);
		const did = typeof body.did === 'string' && body.did.trim() ? body.did.trim().slice(0, 200) : 'did:three:canary';
		const mode = typeof body.mode === 'string' && body.mode.trim() ? body.mode.trim().slice(0, 32) : 'verify';
		const limit = Math.min(Math.max(Number(body.limit || 10), 1), 50);

		if (mode === 'sweep') return runSweep({ limit });
		return runVerify({ did });
	},
});

// ── Dispatch by method ───────────────────────────────────────────────────────
// Only the two documented verbs are served. Anything else used to fall through
// to the GET publisher, so a PUT or DELETE answered with the DID document,
// which reads to a client (and to any cache in front of us) as if the write
// succeeded. 405 says plainly that the resource is read-or-pay only.
export default function handler(req, res) {
	if (req.method === 'POST') return verifyCanary(req, res);
	if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
		return handleDidDocument(req, res);
	}
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', origins: '*' })) return;
	return error(res, 405, 'method_not_allowed', 'use GET for the DID document or POST for the verification canary');
}
