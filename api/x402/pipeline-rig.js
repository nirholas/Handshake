// POST /api/x402/pipeline-rig   { glb_url, rig_type? }
//
// 3D Asset Pipeline — Rig stage. Pay $0.05 USDC and get back an animation-ready
// GLB: a humanoid skeleton is inferred and bound to a static mesh with skin
// weights, so the model can walk, wave, and emote. This is the stage that turns a
// generated or uploaded static character into a riggable asset — the capability
// no other x402 resource offers. Input: a public GLB URL. Output: a durable
// first-party rigged GLB URL. One payment, one rigged mesh.
//
// Drives the same avatar-pipeline-controller /rig endpoint (the `rerig` worker
// mode) that the platform's auto-rig lane uses. Synchronous pay-per-call twin:
// submit → poll to completion → validate output bytes → persist → return the URL.
// Any worker/env/validation failure throws BEFORE settlement, so a buyer is never
// charged for a rig that didn't produce a valid GLB.

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
import pipelineRigListing from '../_lib/service-catalog/services/pipeline-rig.js';

const ROUTE = '/api/x402/pipeline-rig';
const SLUG = 'pipeline-rig';

const VALID_RIG_TYPES = new Set(['biped', 'quadruped']);

// Single source of truth: api/_lib/service-catalog/services/pipeline-rig.js is
// the storefront listing copy — importing it here keeps the live 402 challenge
// from drifting from what /.well-known/x402.json and the OKX projection
// advertise (same pattern as forge.js → forge-listing.js).
const DESCRIPTION = pipelineRigListing.description;

export const INPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['glb_url'],
	properties: {
		glb_url: {
			type: 'string',
			format: 'uri',
			description: 'Public HTTPS URL of the static binary glTF (.glb) mesh to rig.',
		},
		rig_type: {
			type: 'string',
			enum: [...VALID_RIG_TYPES],
			default: 'biped',
			description: 'Skeleton template to fit — biped (humanoid) or quadruped.',
		},
	},
};

export const OUTPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['stage', 'input_url', 'output_url'],
	properties: {
		stage: { type: 'string', const: 'rig' },
		input_url: { type: 'string', format: 'uri' },
		output_url: { type: 'string', format: 'uri', description: 'The rigged, skinned GLB.' },
		bytes: { type: ['integer', 'null'] },
		persisted: { type: 'boolean' },
		rig_type: { type: 'string' },
	},
};

export const BAZAAR = {
	discoverable: true,
	info: {
		input: { type: 'http', method: 'POST', bodyType: 'json', body: { glb_url: 'https://three.ws/avatars/mannequin.glb', rig_type: 'biped' } },
		output: {
			type: 'json',
			example: {
				stage: 'rig',
				input_url: 'https://three.ws/avatars/mannequin.glb',
				output_url: 'https://three.ws/cdn/x402-pipeline/rig/abc123.glb',
				bytes: 1_940_112,
				persisted: true,
				rig_type: 'biped',
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
	priceAtomics: priceFor(SLUG, '50000'), // $0.05 USDC
	networks: ['solana', 'base'],
	description: DESCRIPTION,
	bazaar: BAZAAR,
	service: withService({
		serviceName: 'three.ws Pipeline - Rig',
		tags: ['3d', 'rigging', 'skeleton', 'glb', 'pipeline'],
	}),
	requiredScope: 'x402:bypass',
	accessControl: installAccessControl({ requiredScope: 'x402:bypass' }),

	async handler({ req }) {
		const body = await readJsonBody(req);
		const glbUrl = await validateAssetUrl(body?.glb_url, 'glb_url');
		await sniffRemoteAsset(glbUrl, 'glb');

		const rigType = VALID_RIG_TYPES.has(body?.rig_type) ? body.rig_type : 'biped';

		const result = await runStageJob({
			mode: 'rerig',
			sourceUrl: glbUrl,
			params: { rig_type: rigType },
		});

		const key = await stageObjectKey({ stage: 'rig', sourceUrl: glbUrl, ext: 'glb' });
		const out = await persistStageOutput({
			resultUrl: result.resultGlbUrl,
			key,
			contentType: 'model/gltf-binary',
			kind: 'glb',
		});

		return {
			stage: 'rig',
			input_url: glbUrl,
			output_url: out.url,
			bytes: out.bytes,
			persisted: out.persisted,
			rig_type: rigType,
		};
	},
});
