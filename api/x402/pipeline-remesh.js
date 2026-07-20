// POST /api/x402/pipeline-remesh   { glb_url, remesh_mode?, operation?, target_faces?, texture_size? }
//
// 3D Asset Pipeline — Remesh stage. Pay $0.03 USDC and get back a cleaned,
// retopologized GLB: triangle/quad/low-poly remeshing, mesh repair, or decimation
// to a target face count, with the texture re-baked onto the new topology. This
// is the stage that turns a raw generated or scanned mesh into something with
// predictable topology and a bounded polygon budget. Input: a public GLB URL +
// options. Output: a durable first-party GLB URL. One payment, one finished mesh.
//
// Runs the same workers/remesh Cloud Run service the free /api/forge-remesh
// endpoint drives — this is its synchronous, pay-per-call twin: submit → poll to
// completion → validate output bytes → persist → return the URL, all inside the
// request. Any worker/env/validation failure throws BEFORE settlement, so a buyer
// is never charged for a stage that didn't produce a valid GLB.

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
import pipelineRemeshListing from '../_lib/service-catalog/services/pipeline-remesh.js';

const ROUTE = '/api/x402/pipeline-remesh';
const SLUG = 'pipeline-remesh';

const VALID_MODES = new Set(['triangle', 'quad', 'lowpoly']);
const VALID_OPERATIONS = new Set(['full', 'simplify', 'repair', 'convert']);
const VALID_TEXTURE_SIZES = new Set([512, 1024, 2048]);

// Single source of truth: api/_lib/service-catalog/services/pipeline-remesh.js
// is the storefront listing copy — importing it here keeps the live 402
// challenge from drifting from what /.well-known/x402.json and the OKX
// projection advertise (same pattern as forge.js → forge-listing.js).
const DESCRIPTION = pipelineRemeshListing.description;

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
		remesh_mode: {
			type: 'string',
			enum: [...VALID_MODES],
			default: 'triangle',
			description: 'triangle = clean triangulation; quad = QuadriFlow quad retopology; lowpoly = aggressive decimation.',
		},
		operation: {
			type: 'string',
			enum: [...VALID_OPERATIONS],
			default: 'full',
			description: 'triangle-mode only: full remesh, simplify (decimate), repair (fix holes/non-manifold), or convert.',
		},
		target_faces: {
			type: 'integer',
			minimum: 1_000,
			maximum: 500_000,
			default: 50_000,
			description: 'Target triangle count for the output mesh.',
		},
		texture_size: {
			type: 'integer',
			enum: [...VALID_TEXTURE_SIZES],
			default: 1_024,
			description: 'Resolution of the re-baked texture atlas.',
		},
	},
};

export const OUTPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['stage', 'input_url', 'output_url'],
	properties: {
		stage: { type: 'string', const: 'remesh' },
		input_url: { type: 'string', format: 'uri' },
		output_url: { type: 'string', format: 'uri', description: 'The retopologized GLB.' },
		bytes: { type: ['integer', 'null'] },
		persisted: { type: 'boolean', description: 'true when mirrored to first-party storage.' },
		remesh_mode: { type: 'string' },
		operation: { type: 'string' },
		face_count: { type: ['integer', 'null'] },
		quad_ratio: { type: ['number', 'null'] },
		textured: { type: ['boolean', 'null'] },
	},
};

export const BAZAAR = {
	discoverable: true,
	info: {
		input: { type: 'http', method: 'POST', bodyType: 'json', body: { glb_url: 'https://three.ws/avatars/mannequin.glb', remesh_mode: 'quad', target_faces: 20000 } },
		output: {
			type: 'json',
			example: {
				stage: 'remesh',
				input_url: 'https://three.ws/avatars/mannequin.glb',
				output_url: 'https://cdn.three.ws/x402-pipeline/remesh/abc123.glb',
				bytes: 812_044,
				persisted: true,
				remesh_mode: 'quad',
				operation: 'full',
				face_count: 20_000,
				quad_ratio: 0.98,
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
		serviceName: 'three.ws Pipeline - Remesh',
		tags: ['3d', 'remesh', 'retopology', 'glb', 'pipeline'],
	}),
	requiredScope: 'x402:bypass',
	accessControl: installAccessControl({ requiredScope: 'x402:bypass' }),

	async handler({ req }) {
		const body = await readJsonBody(req);
		const glbUrl = await validateAssetUrl(body?.glb_url, 'glb_url');
		await sniffRemoteAsset(glbUrl, 'glb');

		const remeshMode = VALID_MODES.has(body?.remesh_mode) ? body.remesh_mode : 'triangle';
		const operation = VALID_OPERATIONS.has(body?.operation) ? body.operation : 'full';
		const targetFaces = Math.max(1_000, Math.min(500_000, Math.round(Number(body?.target_faces) || 50_000)));
		const textureSize = VALID_TEXTURE_SIZES.has(Number(body?.texture_size)) ? Number(body.texture_size) : 1_024;

		const result = await runStageJob({
			mode: 'remesh',
			sourceUrl: glbUrl,
			params: {
				remesh_mode: remeshMode,
				operation,
				target_faces: targetFaces,
				texture_size: textureSize,
				output_format: 'glb',
			},
		});

		const key = await stageObjectKey({ stage: 'remesh', sourceUrl: glbUrl, ext: 'glb' });
		const out = await persistStageOutput({
			resultUrl: result.resultGlbUrl,
			key,
			contentType: 'model/gltf-binary',
			kind: 'glb',
		});

		return {
			stage: 'remesh',
			input_url: glbUrl,
			output_url: out.url,
			bytes: out.bytes,
			persisted: out.persisted,
			remesh_mode: remeshMode,
			operation,
			face_count: typeof result.faceCount === 'number' ? result.faceCount : null,
			quad_ratio: typeof result.quadRatio === 'number' ? result.quadRatio : null,
			textured: typeof result.textured === 'boolean' ? result.textured : null,
		};
	},
});
