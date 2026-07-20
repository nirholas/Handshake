// POST /api/x402/pipeline-gameready   { glb_url, topology?, poly_budget?, texture_size? }
//
// 3D Asset Pipeline — Game-Ready stage. Pay $0.03 USDC and get back an
// engine-ready GLB: the mesh is retopologized to a fixed polygon budget (quad
// QuadriFlow or silhouette-preserving low-poly) and its PBR texture re-baked onto
// the new topology, so it drops straight into a real-time engine without blowing
// the frame budget. Input: a public GLB URL + a poly budget. Output: a durable
// first-party GLB URL. One payment, one game-ready mesh.
//
// Opinionated preset over the same workers/remesh Cloud Run service the free
// /api/forge-gameready endpoint drives (topology → retopo mode, poly_budget →
// target faces). Synchronous pay-per-call twin: submit → poll → validate → persist
// → return the URL. Any worker/env/validation failure throws BEFORE settlement, so
// a buyer is never charged for a stage that didn't produce a valid GLB.

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
import pipelineGameReadyListing from '../_lib/service-catalog/services/pipeline-gameready.js';

const ROUTE = '/api/x402/pipeline-gameready';
const SLUG = 'pipeline-gameready';

const VALID_TOPOLOGIES = new Set(['quad', 'tri']);
const VALID_TEXTURE_SIZES = new Set([1024, 2048]);
// quad → field-aligned QuadriFlow retopology; tri → silhouette-preserving
// quadric low-poly with UV re-unwrap + texture re-bake. Both are real worker
// pipelines (workers/remesh); neither is faked here.
const TOPOLOGY_TO_MODE = { quad: 'quad', tri: 'lowpoly' };
const POLY_MIN = 1_000;
const POLY_MAX = 500_000;

// Single source of truth:
// api/_lib/service-catalog/services/pipeline-gameready.js is the storefront
// listing copy — importing it here keeps the live 402 challenge from drifting
// from what /.well-known/x402.json and the OKX projection advertise (same
// pattern as forge.js → forge-listing.js).
const DESCRIPTION = pipelineGameReadyListing.description;

export const INPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['glb_url'],
	properties: {
		glb_url: {
			type: 'string',
			format: 'uri',
			description: 'Public HTTPS URL of the source binary glTF (.glb) mesh.',
		},
		topology: {
			type: 'string',
			enum: [...VALID_TOPOLOGIES],
			default: 'quad',
			description: 'quad = QuadriFlow field-aligned retopo; tri = silhouette-preserving low-poly.',
		},
		poly_budget: {
			type: 'integer',
			minimum: POLY_MIN,
			maximum: POLY_MAX,
			default: 15_000,
			description: 'Target triangle budget for the engine-ready output.',
		},
		texture_size: {
			type: 'integer',
			enum: [...VALID_TEXTURE_SIZES],
			default: 1_024,
			description: 'Resolution of the re-baked PBR texture atlas.',
		},
	},
};

export const OUTPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['stage', 'input_url', 'output_url'],
	properties: {
		stage: { type: 'string', const: 'gameready' },
		input_url: { type: 'string', format: 'uri' },
		output_url: { type: 'string', format: 'uri', description: 'The engine-ready GLB.' },
		bytes: { type: ['integer', 'null'] },
		persisted: { type: 'boolean' },
		topology: { type: 'string' },
		poly_budget: { type: 'integer' },
		face_count: { type: ['integer', 'null'] },
		quad_ratio: { type: ['number', 'null'] },
		textured: { type: ['boolean', 'null'] },
	},
};

export const BAZAAR = {
	discoverable: true,
	info: {
		input: { type: 'http', method: 'POST', bodyType: 'json', body: { glb_url: 'https://three.ws/avatars/mannequin.glb', topology: 'quad', poly_budget: 12000 } },
		output: {
			type: 'json',
			example: {
				stage: 'gameready',
				input_url: 'https://three.ws/avatars/mannequin.glb',
				output_url: 'https://cdn.three.ws/x402-pipeline/gameready/abc123.glb',
				bytes: 640_220,
				persisted: true,
				topology: 'quad',
				poly_budget: 12_000,
				face_count: 12_000,
				quad_ratio: 0.97,
				textured: true,
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
	priceAtomics: priceFor(SLUG, '30000'), // $0.03 USDC
	networks: ['solana', 'base'],
	description: DESCRIPTION,
	bazaar: BAZAAR,
	service: withService({
		serviceName: 'three.ws Pipeline - Game-Ready',
		tags: ['3d', 'gameready', 'retopology', 'glb', 'pipeline'],
	}),
	requiredScope: 'x402:bypass',
	accessControl: installAccessControl({ requiredScope: 'x402:bypass' }),

	async handler({ req }) {
		const body = await readJsonBody(req);
		const glbUrl = await validateAssetUrl(body?.glb_url, 'glb_url');
		await sniffRemoteAsset(glbUrl, 'glb');

		const topology = VALID_TOPOLOGIES.has(body?.topology) ? body.topology : 'quad';
		const mode = TOPOLOGY_TO_MODE[topology];
		const polyBudget = Math.max(POLY_MIN, Math.min(POLY_MAX, Math.round(Number(body?.poly_budget) || 15_000)));
		const textureSize = VALID_TEXTURE_SIZES.has(Number(body?.texture_size)) ? Number(body.texture_size) : 1_024;

		const result = await runStageJob({
			mode: 'remesh',
			sourceUrl: glbUrl,
			params: {
				remesh_mode: mode,
				operation: 'full',
				target_faces: polyBudget,
				texture_size: textureSize,
				output_format: 'glb',
			},
		});

		const key = await stageObjectKey({ stage: 'gameready', sourceUrl: glbUrl, ext: 'glb' });
		const out = await persistStageOutput({
			resultUrl: result.resultGlbUrl,
			key,
			contentType: 'model/gltf-binary',
			kind: 'glb',
		});

		return {
			stage: 'gameready',
			input_url: glbUrl,
			output_url: out.url,
			bytes: out.bytes,
			persisted: out.persisted,
			topology,
			poly_budget: polyBudget,
			face_count: typeof result.faceCount === 'number' ? result.faceCount : null,
			quad_ratio: typeof result.quadRatio === 'number' ? result.quadRatio : null,
			textured: typeof result.textured === 'boolean' ? result.textured : null,
		};
	},
});
