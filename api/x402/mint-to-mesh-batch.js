// POST /api/x402/mint-to-mesh-batch
//   body: { mints: ["mint1", "mint2", ...] }   (1–10 mints)
//
// Paid endpoint cataloged by the CDP x402 Bazaar. For $0.05 USDC the server
// resolves Metaplex metadata for up to 10 Solana SPL mints in parallel,
// procedurally synthesizes a themed glTF cube per mint, and returns one
// JSON envelope with base64 GLB bytes for each. Useful for agents that need
// to render a row of token-themed objects (e.g. a portfolio carousel) in a
// single paid call instead of paying for N round-trips.
//
// Wire stack: plain Node handler + the shared paidEndpoint helper. Failed
// mints don't kill the batch — each entry reports ok:false with the error
// so the buyer always gets a useful response after paying.

import { paidEndpoint } from '../_lib/x402-paid-endpoint.js';
import { buildBazaarSchema } from '../_lib/x402-spec.js';
import { installAccessControl } from '../_lib/x402/access-control.js';
import { withService } from '../_lib/x402/bazaar-helpers.js';
import { readJson } from '../_lib/http.js';
import { createThemedGLB, colorFromMint } from '../_lib/glb-themer.js';
import { fetchTokenMeta } from '../_lib/solana-token-meta.js';
import { priceFor } from '../_lib/x402-prices.js';

const ROUTE = '/api/x402/mint-to-mesh-batch';

const DESCRIPTION =
	'three.ws Mint-to-Mesh (Batch) — resolve 1–10 Solana SPL mints to themed ' +
	'binary glTF cubes in a single paid call. Each mint is processed in parallel; ' +
	'per-mint failures (bad mint, RPC unreachable, off-chain metadata 404) report ' +
	'ok:false individually rather than failing the whole batch. Output is base64 ' +
	'JSON-safe GLB bytes ready for Three.js / Babylon.js / model-viewer.';

const INPUT_EXAMPLE = {
	mints: [
		'C3vQABCDEFGHJKLMNopqrstuvwxyZ12345abcdefghi',
		'F7kXZYXWVUTSRQPONMLKJIHGFEDCba9876543210xyz',
	],
};

const INPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['mints'],
	properties: {
		mints: {
			type: 'array',
			minItems: 1,
			maxItems: 10,
			items: { type: 'string', minLength: 32, maxLength: 44 },
		},
	},
};

const OUTPUT_EXAMPLE = {
	count: 2,
	results: [
		{
			ok: true,
			mint: 'C3vQABCDEFGHJKLMNopqrstuvwxyZ12345abcdefghi',
			theme: { name: 'Helios', symbol: 'HELIO', color: [220, 180, 80], hasImage: true },
			glb: { mimeType: 'model/gltf-binary', bytes: 18000, base64: 'Z2xUR...' },
		},
		{ ok: false, mint: 'F7kXZ...', error: 'meta_fetch_failed', error_description: 'RPC 429' },
	],
	indexed_at: '2026-05-14T17:00:00Z',
};

const OUTPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['count', 'results'],
	properties: {
		count: { type: 'integer' },
		results: { type: 'array', items: { type: 'object' } },
		indexed_at: { type: 'string', format: 'date-time' },
	},
};

const BAZAAR = {
	discoverable: true,
	info: {
		input: {
			type: 'http',
			method: 'POST',
			body: INPUT_EXAMPLE,
			bodyType: 'json',
		},
		output: { type: 'json', example: OUTPUT_EXAMPLE },
	},
	schema: buildBazaarSchema({
		method: 'POST',
		bodyType: 'json',
		bodySchema: INPUT_SCHEMA,
		outputSchema: OUTPUT_SCHEMA,
	}),
};

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

async function buildOne(mint) {
	if (!BASE58_RE.test(mint)) {
		return { ok: false, mint, error: 'invalid_mint', error_description: 'not a base58 SPL pubkey' };
	}
	let meta;
	try {
		meta = await fetchTokenMeta(mint);
	} catch (err) {
		return {
			ok: false,
			mint,
			error: err.code || 'meta_fetch_failed',
			error_description: err.message || 'failed to read on-chain metadata',
		};
	}
	const color = colorFromMint(mint);
	let glb;
	try {
		glb = await createThemedGLB({
			mint: meta.mint,
			name: meta.name,
			symbol: meta.symbol,
			image: meta.image?.bytes || null,
			imageMimeType: meta.image?.mimeType || null,
			color,
			extras: {
				description: meta.description || undefined,
				imageUrl: meta.imageUrl || undefined,
				externalUrl: meta.externalUrl || undefined,
				offchainUri: meta.uri || undefined,
			},
		});
	} catch (err) {
		return {
			ok: false,
			mint,
			error: 'glb_build_failed',
			error_description: err.message || 'failed to synthesize GLB',
		};
	}
	return {
		ok: true,
		mint: meta.mint,
		theme: {
			name: meta.name,
			symbol: meta.symbol,
			color,
			imageUrl: meta.imageUrl,
			hasImage: !!meta.image,
		},
		glb: {
			mimeType: 'model/gltf-binary',
			bytes: glb.byteLength,
			base64: Buffer.from(glb).toString('base64'),
		},
	};
}

export default paidEndpoint({
	route: ROUTE,
	method: 'POST',
	priceAtomics: priceFor('mint-to-mesh-batch', '50000'),
	networks: ['base', 'solana'],
	description: DESCRIPTION,
	bazaar: BAZAAR,
	service: withService({
		serviceName: 'three.ws Mint Mesh Batch',
		tags: ['3d', 'gltf', 'solana', 'batch', 'render'],
	}),
	requiredScope: 'x402:bypass',
	accessControl: installAccessControl({ requiredScope: 'x402:bypass' }),
	async handler({ req }) {
		let body;
		try {
			body = await readJson(req, 64_000);
		} catch (err) {
			const e = new Error(err.message || 'invalid JSON body');
			e.status = err.status || 400;
			e.code = 'invalid_body';
			throw e;
		}
		const mints = Array.isArray(body?.mints) ? body.mints.map(String).map((s) => s.trim()) : [];
		if (mints.length === 0) {
			const err = new Error('body.mints must be a non-empty array');
			err.status = 400;
			err.code = 'missing_mints';
			throw err;
		}
		if (mints.length > 10) {
			const err = new Error('body.mints supports at most 10 entries per call');
			err.status = 400;
			err.code = 'too_many_mints';
			throw err;
		}
		const results = await Promise.all(mints.map((m) => buildOne(m)));
		return {
			count: results.length,
			results,
			indexed_at: new Date().toISOString(),
		};
	},
});
