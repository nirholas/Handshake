// GET /api/x402/asset-download?slug=<slug>
//
// Canonical "buy once, re-download forever" 3D-asset bazaar. A creator uploads
// a GLB / avatar / accessory to R2, prices it, and lists it in the paid_assets
// table. The first download is paid via x402 USDC (Base or Solana); every
// subsequent download from the same wallet is free via Sign-In-With-X (CAIP-122).
//
// The response is JSON with a short-lived presigned R2 URL — proxying the
// bytes through Vercel would blow past the function response-size limit on
// real GLBs. The client fetches the file directly from R2 with the URL.

import { paidEndpoint } from '../_lib/x402-paid-endpoint.js';
import { buildBazaarSchema, paymentRequirements, send402 } from '../_lib/x402-spec.js';
import { priceFor } from '../_lib/x402-prices.js';
import { withService } from '../_lib/x402/bazaar-helpers.js';
import { sql } from '../_lib/db.js';
import { presignGet } from '../_lib/r2.js';
import { error } from '../_lib/http.js';
import { env } from '../_lib/env.js';
import assetDownloadListing from '../_lib/service-catalog/services/asset-download.js';

const ROUTE = '/api/x402/asset-download';

// Single source of truth: api/_lib/service-catalog/services/asset-download.js
// is the storefront listing copy — importing it here keeps the live 402
// challenge from drifting from what /.well-known/x402.json and the OKX
// projection advertise (same pattern as forge.js → forge-listing.js).
const DESCRIPTION = assetDownloadListing.description;

const INPUT_EXAMPLE = { slug: 'pole-dancer-rumba' };

const INPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['slug'],
	properties: {
		slug: {
			type: 'string',
			description: 'Unique asset slug from the paid_assets catalog.',
			minLength: 1,
			maxLength: 128,
		},
	},
};

const OUTPUT_EXAMPLE = {
	ok: true,
	slug: 'pole-dancer-rumba',
	title: 'Pole Dancer (Rumba)',
	description: 'The default three.ws dancer rigged for the /club Rumba routine.',
	mimeType: 'model/gltf-binary',
	sizeBytes: 6_492_840,
	expiresAt: '2026-05-21T18:48:09.000Z',
	downloadUrl:
		'https://three-ws-public.r2.dev/assets/pole-dancer-rumba.glb?X-Amz-Algorithm=...',
};

const OUTPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['ok', 'slug', 'title', 'mimeType', 'sizeBytes', 'downloadUrl', 'expiresAt'],
	properties: {
		ok: { type: 'boolean', const: true },
		slug: { type: 'string' },
		title: { type: 'string' },
		description: { type: 'string' },
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
	schema: buildBazaarSchema({
		method: 'GET',
		queryParamsSchema: INPUT_SCHEMA,
		outputSchema: OUTPUT_SCHEMA,
	}),
};

// Presigned URL lifetime. Keep this short — once the buyer has the URL, R2
// will serve the file to anyone who holds it for the next N seconds. 60s is
// enough for any reasonable client to start the download; the URL becomes
// useless once the file finishes streaming.
const PRESIGN_TTL_SECONDS = 60;

async function loadAsset(slug) {
	const rows = await sql`
		SELECT id, slug, title, description, mime_type, size_bytes, r2_key,
		       price_atomics, creator_payto_base, creator_payto_solana,
		       creator_payto_bsc
		  FROM paid_assets
		 WHERE slug = ${slug}
		 LIMIT 1
	`;
	return rows[0] || null;
}

// Build the SIWX statement. EIP-4361 restricts the statement to a single line
// of RFC 3986 reserved/unreserved characters + space — double quotes, braces,
// backticks, etc. are illegal and make the official SIWX client (browser
// wallets and @x402/extensions alike) refuse to render a signable message. The
// asset title is catalog-controlled, so we strip anything outside that set and
// collapse whitespace rather than wrapping the title in quotes.
const SIWE_STATEMENT_DISALLOWED = /[^A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;= ]+/g;
function buildSiwxStatement(title) {
	const clean = String(title || '')
		.replace(SIWE_STATEMENT_DISALLOWED, '')
		.replace(/\s+/g, ' ')
		.trim();
	return clean
		? `Sign in to re-download ${clean} without re-paying.`
		: 'Sign in to re-download this asset without re-paying.';
}

function buildPayToOverride(asset) {
	const out = {};
	if (asset.creator_payto_base) out.base = asset.creator_payto_base;
	if (asset.creator_payto_solana) out.solana = asset.creator_payto_solana;
	if (asset.creator_payto_bsc) out.bsc = asset.creator_payto_bsc;
	return Object.keys(out).length ? out : undefined;
}

// Discovery probes (x402scan registration, Bazaar validators) hit the bare
// route with no ?slug= and expect a valid 402 challenge, not a 400. Without a
// slug there is no per-asset price, so this advertises the endpoint at a
// representative default (env-overridable via X402_PRICE_ASSET_DOWNLOAD) with
// the full bazaar schema. No money can settle against it: a paid retry still
// needs ?slug=<slug> (the paymentPresent branches below keep their 400/404),
// and an X-PAYMENT envelope is only an authorization — USDC moves at settle,
// which this path never reaches.
function sendDiscoveryChallenge(res, errText) {
	const resourceUrl = `${env.APP_ORIGIN}${ROUTE}`;
	return send402(res, {
		resourceUrl,
		accepts: paymentRequirements(resourceUrl, { amount: priceFor('asset-download', '1000000') }),
		description: DESCRIPTION,
		bazaar: BAZAAR,
		error: errText,
		serviceName: 'three.ws Asset Bazaar',
		tags: ['3d', 'asset', 'glb', 'avatar', 'download'],
	});
}

// Per-asset paidEndpoint built on the fly. The slug picks the row, which
// dictates price + payout overrides + R2 key — everything else is shared.
export default async function handler(req, res) {
	const slug = req.query?.slug ? String(req.query.slug).trim() : '';
	const paymentPresent = Boolean(req.headers['x-payment'] || req.headers['payment-signature']);
	if (!slug) {
		if (paymentPresent) {
			return error(res, 400, 'slug_required', 'query parameter "slug" is required');
		}
		return sendDiscoveryChallenge(
			res,
			'query parameter "slug" is required — retry with ?slug=<slug> from the paid_assets catalog for that asset’s exact price',
		);
	}

	let asset;
	try {
		asset = await loadAsset(slug);
	} catch (err) {
		return error(res, 502, 'paid_assets_lookup_failed', err.message);
	}
	if (!asset) {
		if (paymentPresent) {
			return error(res, 404, 'asset_not_found', `no paid_assets row with slug "${slug}"`);
		}
		return sendDiscoveryChallenge(
			res,
			`no paid_assets row with slug "${slug}" — browse /api/assets for available slugs`,
		);
	}

	const inner = paidEndpoint({
		route: ROUTE,
		method: 'GET',
		priceAtomics: String(asset.price_atomics),
		networks: ['base', 'solana'],
		description: `${DESCRIPTION} — currently delivering: ${asset.title}.`,
		mimeType: 'application/json',
		bazaar: BAZAAR,
		service: withService({
			serviceName: 'three.ws Asset Bazaar',
			tags: ['3d', 'asset', 'glb', 'avatar', 'download'],
		}),
		payTo: buildPayToOverride(asset),
		// Make the SIWX grant key per-asset by baking the slug into the
		// resource URL. Without this, paying for any one asset would unlock
		// every other asset via signature — the SIWX storage row is keyed on
		// (resource, address) only. The 402 challenge advertises the same URL
		// the client signs against, so verification stays consistent.
		resourceUrlBuilder: () =>
			`${env.APP_ORIGIN}${ROUTE}?slug=${encodeURIComponent(asset.slug)}`,
		siwx: {
			statement: buildSiwxStatement(asset.title),
			// Permanent grant per (asset, wallet) — once a wallet has paid for
			// this asset it can re-download forever by signing.
			ttlSeconds: null,
			expirationSeconds: 300,
		},
		async handler() {
			const url = await presignGet({
				key: asset.r2_key,
				expiresIn: PRESIGN_TTL_SECONDS,
			});
			return {
				ok: true,
				slug: asset.slug,
				title: asset.title,
				description: asset.description,
				mimeType: asset.mime_type,
				sizeBytes: Number(asset.size_bytes),
				expiresAt: new Date(Date.now() + PRESIGN_TTL_SECONDS * 1000).toISOString(),
				downloadUrl: url,
			};
		},
	});

	return inner(req, res);
}
