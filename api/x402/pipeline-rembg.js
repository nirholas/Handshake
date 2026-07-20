// POST /api/x402/pipeline-rembg   { image_url, model? }
//
// 3D Asset Pipeline — Background Removal stage. Pay $0.01 USDC and get back the
// input image with its background removed (transparent PNG) — the clean reference
// view that image→3D reconstruction needs to avoid baking a room into the mesh.
// Input: a public image URL. Output: a durable first-party PNG URL. One payment,
// one cut-out image.
//
// Runs the same workers/rembg Cloud Run service the free /api/forge-rembg
// endpoint drives — its synchronous, pay-per-call twin: submit → poll → validate
// → persist → return the URL. Any worker/env/validation failure throws BEFORE
// settlement, so a buyer is never charged for a stage that didn't produce a valid
// image.

import { paidEndpoint } from '../_lib/x402-paid-endpoint.js';
import { buildBazaarSchema } from '../_lib/x402-spec.js';
import { withService } from '../_lib/x402/bazaar-helpers.js';
import { installAccessControl } from '../_lib/x402/access-control.js';
import { priceFor } from '../_lib/x402-prices.js';
import {
	readJsonBody,
	validateAssetUrl,
	sniffRemoteAsset,
	runStageJob,
	persistStageOutput,
	stageObjectKey,
} from '../_lib/pipeline-stage.js';
import pipelineRembgListing from '../_lib/service-catalog/services/pipeline-rembg.js';

const ROUTE = '/api/x402/pipeline-rembg';
const SLUG = 'pipeline-rembg';

const VALID_MODELS = new Set(['rmbg2', 'u2net', 'isnet', 'u2net_human_seg', 'silueta']);

// Single source of truth: api/_lib/service-catalog/services/pipeline-rembg.js is
// the storefront listing copy — importing it here keeps the live 402 challenge
// from drifting from what /.well-known/x402.json and the OKX projection
// advertise (same pattern as forge.js → forge-listing.js).
const DESCRIPTION = pipelineRembgListing.description;

export const INPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['image_url'],
	properties: {
		image_url: {
			type: 'string',
			format: 'uri',
			description: 'Public HTTPS URL of the source image (PNG, JPEG, WEBP, or GIF).',
		},
		model: {
			type: 'string',
			enum: [...VALID_MODELS],
			default: 'rmbg2',
			description: 'Segmentation model — rmbg2 (default, general), u2net_human_seg (people), isnet, u2net, silueta.',
		},
	},
};

export const OUTPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['stage', 'input_url', 'output_url'],
	properties: {
		stage: { type: 'string', const: 'rembg' },
		input_url: { type: 'string', format: 'uri' },
		output_url: { type: 'string', format: 'uri', description: 'The cut-out transparent PNG.' },
		bytes: { type: ['integer', 'null'] },
		persisted: { type: 'boolean' },
		model: { type: 'string' },
	},
};

export const BAZAAR = {
	discoverable: true,
	info: {
		input: { type: 'http', method: 'POST', bodyType: 'json', body: { image_url: 'https://three.ws/avatars/thumbs/default.png', model: 'rmbg2' } },
		output: {
			type: 'json',
			example: {
				stage: 'rembg',
				input_url: 'https://three.ws/avatars/thumbs/default.png',
				output_url: 'https://cdn.three.ws/x402-pipeline/rembg/abc123.png',
				bytes: 284_112,
				persisted: true,
				model: 'rmbg2',
			},
		},
	},
	schema: buildBazaarSchema({
		method: 'POST',
		bodyType: 'json',
		bodySchema: INPUT_SCHEMA,
		outputSchema: OUTPUT_SCHEMA,
	}),
};

export default paidEndpoint({
	route: ROUTE,
	method: 'POST',
	priceAtomics: priceFor(SLUG, '10000'), // $0.01 USDC
	networks: ['solana', 'base'],
	description: DESCRIPTION,
	bazaar: BAZAAR,
	service: withService({
		serviceName: 'three.ws Pipeline - RemBG',
		tags: ['image', 'rembg', 'cutout', 'segmentation', 'pipeline'],
	}),
	requiredScope: 'x402:bypass',
	accessControl: installAccessControl({ requiredScope: 'x402:bypass' }),

	async handler({ req }) {
		const body = await readJsonBody(req);
		const imageUrl = await validateAssetUrl(body?.image_url, 'image_url');
		await sniffRemoteAsset(imageUrl, 'image');

		const model = VALID_MODELS.has(body?.model) ? body.model : 'rmbg2';

		const result = await runStageJob({
			mode: 'rembg',
			sourceUrl: imageUrl,
			params: { model },
		});

		const key = await stageObjectKey({ stage: 'rembg', sourceUrl: imageUrl, ext: 'png' });
		const out = await persistStageOutput({
			resultUrl: result.resultImageUrl || result.resultGlbUrl,
			key,
			contentType: 'image/png',
			kind: 'image',
		});

		return {
			stage: 'rembg',
			input_url: imageUrl,
			output_url: out.url,
			bytes: out.bytes,
			persisted: out.persisted,
			model,
		};
	},
});
