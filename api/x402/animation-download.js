// GET /api/x402/animation-download?id=<uuid>
//
// Paid download for a creator-listed animation clip from the three.ws Animation
// Studio (/pose). A creator prices a clip + uploads a self-contained animated
// GLB (api/animations/sell.js, listed = true). Buyers pay once in USDC (Base or
// Solana) to unlock the GLB; every later download from the same wallet is free
// via Sign-In-With-X (CAIP-122). Free listings (no price) skip the paywall and
// return the file directly.
//
// The response is JSON with a short-lived presigned R2 URL — the client fetches
// the GLB directly from R2 (proxying real GLBs would blow the function
// response-size limit). Mirrors api/x402/asset-download.js.

import { paidEndpoint } from '../_lib/x402-paid-endpoint.js';
import { buildBazaarSchema, paymentRequirements, send402 } from '../_lib/x402-spec.js';
import { priceFor } from '../_lib/x402-prices.js';
import { withService } from '../_lib/x402/bazaar-helpers.js';
import { sql } from '../_lib/db.js';
import { presignGet } from '../_lib/r2.js';
import { error, json } from '../_lib/http.js';
import { env } from '../_lib/env.js';
import animationDownloadListing from '../_lib/service-catalog/services/animation-download.js';

const ROUTE = '/api/x402/animation-download';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRESIGN_TTL_SECONDS = 60;

// Single source of truth:
// api/_lib/service-catalog/services/animation-download.js is the storefront
// listing copy — importing it here keeps the live 402 challenge from drifting
// from what /.well-known/x402.json and the OKX projection advertise (same
// pattern as forge.js → forge-listing.js).
const DESCRIPTION = animationDownloadListing.description;

const INPUT_EXAMPLE = { id: '00000000-0000-0000-0000-000000000000' };

const INPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['id'],
	properties: {
		id: {
			type: 'string',
			format: 'uuid',
			description: 'Animation clip id from the marketplace animations feed.',
		},
	},
};

const OUTPUT_EXAMPLE = {
	ok: true,
	id: '00000000-0000-0000-0000-000000000000',
	slug: 'spin-kick-combo',
	name: 'Spin Kick Combo',
	mimeType: 'model/gltf-binary',
	sizeBytes: 248_400,
	expiresAt: '2026-06-15T18:48:09.000Z',
	downloadUrl: 'https://three.ws/cdn/u/.../spin-kick-combo.glb?X-Amz-Algorithm=...',
};

const OUTPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['ok', 'id', 'name', 'mimeType', 'downloadUrl', 'expiresAt'],
	properties: {
		ok: { type: 'boolean', const: true },
		id: { type: 'string', format: 'uuid' },
		slug: { type: 'string' },
		name: { type: 'string' },
		mimeType: { type: 'string' },
		sizeBytes: { type: 'integer', minimum: 0 },
		expiresAt: { type: 'string', format: 'date-time' },
		downloadUrl: { type: 'string', format: 'uri' },
	},
};

const BAZAAR = {
	discoverable: true,
	info: {
		input: { type: 'http', method: 'GET', queryParams: INPUT_EXAMPLE },
		output: { type: 'json', example: OUTPUT_EXAMPLE },
	},
	schema: buildBazaarSchema({ method: 'GET', queryParamsSchema: INPUT_SCHEMA, outputSchema: OUTPUT_SCHEMA }),
};

async function loadListing(id) {
	const rows = await sql`
		select id, slug, name, listed, price_amount, price_currency, artifact_key,
		       artifact_mime, artifact_bytes, creator_payto_base,
		       creator_payto_solana, creator_payto_bsc
		from animation_clips
		where id = ${id} and deleted_at is null
		limit 1
	`;
	return rows[0] || null;
}

// USDC atomic units (6 decimals) from the stored human amount.
function priceAtomics(amount) {
	return String(Math.round(Number(amount) * 1_000_000));
}

// EIP-4361 statements are single-line and restricted to RFC 3986 chars — strip
// anything illegal so browser wallets render a signable message.
const SIWE_STATEMENT_DISALLOWED = /[^A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;= ]+/g;
function buildSiwxStatement(name) {
	const clean = String(name || '').replace(SIWE_STATEMENT_DISALLOWED, '').replace(/\s+/g, ' ').trim();
	return clean
		? `Sign in to re-download ${clean} without re-paying.`
		: 'Sign in to re-download this animation without re-paying.';
}

function buildPayToOverride(row) {
	const out = {};
	if (row.creator_payto_base) out.base = row.creator_payto_base;
	if (row.creator_payto_solana) out.solana = row.creator_payto_solana;
	if (row.creator_payto_bsc) out.bsc = row.creator_payto_bsc;
	return Object.keys(out).length ? out : undefined;
}

async function presignPayload(row) {
	const url = await presignGet({ key: row.artifact_key, expiresIn: PRESIGN_TTL_SECONDS });
	return {
		ok: true,
		id: row.id,
		slug: row.slug,
		name: row.name,
		mimeType: row.artifact_mime || 'model/gltf-binary',
		sizeBytes: row.artifact_bytes != null ? Number(row.artifact_bytes) : 0,
		expiresAt: new Date(Date.now() + PRESIGN_TTL_SECONDS * 1000).toISOString(),
		downloadUrl: url,
	};
}

// Discovery probes (x402scan registration, Bazaar validators) hit the bare route
// with placeholder or missing query params and expect a valid 402 challenge, not
// a 400/404 — the x402 discovery spec treats runtime 402 behavior as the source
// of truth, so request validation must not reject the probe before the payment
// middleware runs. This advertises the endpoint at a representative default price
// (env-overridable via X402_PRICE_ANIMATION_DOWNLOAD) with the full bazaar
// schema. No money can settle against it: a paid retry still needs a real clip
// uuid (the paymentPresent branches below keep their 400/404), and an X-PAYMENT
// envelope is only an authorization — USDC moves at settle, which this path never
// reaches. Mirrors asset-download.js sendDiscoveryChallenge.
function sendDiscoveryChallenge(res, errText) {
	const resourceUrl = `${env.APP_ORIGIN}${ROUTE}`;
	return send402(res, {
		resourceUrl,
		accepts: paymentRequirements(resourceUrl, {
			amount: priceFor('animation-download', '10000'),
		}),
		description: DESCRIPTION,
		bazaar: BAZAAR,
		error: errText,
		serviceName: 'three.ws Animation Bazaar',
		tags: ['3d', 'animation', 'glb', 'avatar', 'motion', 'download'],
	});
}

// Exported for contract tests (price/statement/payout logic) without a live DB.
export const __test__ = { priceAtomics, buildSiwxStatement, buildPayToOverride, UUID_RE };

export default async function handler(req, res) {
	const paymentPresent = Boolean(req.headers['x-payment'] || req.headers['payment-signature']);

	const id = req.query?.id ? String(req.query.id).trim() : '';
	if (!UUID_RE.test(id)) {
		if (paymentPresent) {
			return error(res, 400, 'id_required', 'query parameter "id" must be a clip uuid');
		}
		return sendDiscoveryChallenge(
			res,
			'query parameter "id" must be a clip uuid — retry with ?id=<uuid> from the marketplace animations feed for that clip’s exact price',
		);
	}

	let row;
	try {
		row = await loadListing(id);
	} catch (err) {
		return error(res, 502, 'animation_lookup_failed', err.message);
	}
	if (!row || !row.listed || !row.artifact_key) {
		if (paymentPresent) {
			return error(res, 404, 'animation_not_found', `no listed animation with id "${id}"`);
		}
		return sendDiscoveryChallenge(
			res,
			`no listed animation with id "${id}" — browse /api/marketplace/animations for available clip ids`,
		);
	}

	// Free listing — no paywall, hand back the presigned URL directly.
	if (!row.price_amount || Number(row.price_amount) <= 0) {
		try {
			res.setHeader('Cache-Control', 'no-store');
			return json(res, 200, await presignPayload(row));
		} catch (err) {
			return error(res, 502, 'presign_failed', err.message);
		}
	}

	const inner = paidEndpoint({
		route: ROUTE,
		method: 'GET',
		priceAtomics: priceAtomics(row.price_amount),
		networks: ['base', 'solana'],
		description: `${DESCRIPTION} — currently delivering: ${row.name}.`,
		mimeType: 'application/json',
		bazaar: BAZAAR,
		service: withService({
			serviceName: 'three.ws Animation Bazaar',
			tags: ['3d', 'animation', 'glb', 'avatar', 'motion', 'download'],
		}),
		payTo: buildPayToOverride(row),
		// Per-clip SIWX grant: bake the id into the resource URL so paying for
		// one clip can't unlock another via signature (the grant row is keyed on
		// (resource, address)). The 402 challenge advertises the same URL.
		resourceUrlBuilder: () => `${env.APP_ORIGIN}${ROUTE}?id=${encodeURIComponent(row.id)}`,
		siwx: {
			statement: buildSiwxStatement(row.name),
			ttlSeconds: null, // permanent per (clip, wallet) once paid
			expirationSeconds: 300,
		},
		async handler(ctx) {
			// Count only fresh paid settlements. `requirement` is set solely on
			// the verified-payment path — the free SIWX re-download path (which
			// also carries `payer`) and auth-hints bypass leave it null, so this
			// never inflates the count on repeat downloads.
			if (ctx?.requirement && ctx?.payer) {
				queueMicrotask(async () => {
					try {
						await sql`update animation_clips set purchase_count = purchase_count + 1 where id = ${row.id}`;
					} catch (err) {
						console.warn('[animation-download] purchase_count bump failed', err?.message);
					}
				});
			}
			return presignPayload(row);
		},
	});

	return inner(req, res);
}
