// `blender_forge_import`: text prompt to a 3D model, open in Blender.
//
// Bridges the public three.ws Forge pipeline into the local Blender session: a
// prompt is generated on the free image lane (FLUX to TRELLIS), the resulting
// GLB is downloaded, and it is either kept as-is or converted into whatever the
// output extension asks for, .blend included. That closes the loop between "an
// agent needs an asset" and "the asset is in a scene it can edit".

import { z } from 'zod';

import path from 'node:path';

import { runJob } from '../lib/blender.js';
import { downloadGlb, submitTextTo3d, waitForGlb } from '../lib/forge.js';
import { resolveOutput } from '../lib/paths.js';
import { FORGE_TIMEOUT_MS } from '../config.js';

function slug(prompt) {
	return (
		prompt
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 40) || 'forge'
	);
}

export const def = {
	name: 'blender_forge_import',
	title: 'Generate a 3D model with three.ws and open it in Blender',
	annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
	description:
		'Generate a 3D model from a text prompt on the public three.ws Forge pipeline, then bring it into Blender. ' +
		'The default image lane (FLUX to TRELLIS) is free and needs no key, wallet, or account. The GLB is saved ' +
		'locally, and if the output path asks for another format (.blend, .fbx, .obj, .usd) Blender converts it on ' +
		'the way in. Returns the local path, the hosted GLB URL, and the geometry counts. Generation runs on a ' +
		'shared GPU lane and typically takes tens of seconds to a couple of minutes. Describe ONE subject per call.',
	inputSchema: {
		prompt: z.string().min(3).describe('What to generate. One subject, e.g. "a weathered brass diving helmet".'),
		output: z
			.string()
			.optional()
			.describe('Where to save it. The extension picks the format (.glb keeps the original bytes). Defaults to a .glb in the workdir.'),
		tier: z.enum(['draft', 'standard', 'high']).optional().describe('Generation quality. Default "standard".'),
		lane: z
			.enum(['image', 'geometry', 'sketch'])
			.optional()
			.describe('Pipeline lane. "image" (default) is free. "geometry" uses Meshy/Tripo and needs THREE_WS_FORGE_PROVIDER_KEY.'),
		backend: z.string().optional().describe('Pin a specific backend. Omit to let the deployment choose for the tier.'),
		aspect_ratio: z.enum(['1:1', '4:3', '3:4', '16:9', '9:16']).optional().describe('Reference image aspect ratio. Default "1:1".'),
	},
	async handler(args) {
		const prompt = String(args?.prompt ?? '').trim();
		const submitted = await submitTextTo3d({
			prompt,
			tier: args?.tier || 'standard',
			backend: args?.backend,
			aspect_ratio: args?.aspect_ratio || '1:1',
			lane: args?.lane || 'image',
		});
		const finished = await waitForGlb(submitted.job_id, { timeoutMs: FORGE_TIMEOUT_MS });

		const output = await resolveOutput(args?.output, slug(prompt), '.glb');
		const keepsOriginalBytes = output.toLowerCase().endsWith('.glb');
		// When the caller asked for another format, the untouched GLB is kept
		// beside it: conversion is lossy for some targets, and the original is
		// what the three.ws pipeline consumes downstream.
		const sourceGlb = path.join(path.dirname(output), `${path.basename(output, path.extname(output))}.source.glb`);
		const download = await downloadGlb(finished.glb_url, keepsOriginalBytes ? output : sourceGlb);

		const scene = keepsOriginalBytes
			? await runJob({ op: 'scene_info', input: download.path, include_objects: false })
			: await runJob({ op: 'convert', input: download.path, output });

		return {
			ok: true,
			prompt,
			job_id: submitted.job_id,
			backend: finished.backend || submitted.backend,
			glb_url: finished.glb_url,
			output: keepsOriginalBytes ? download.path : scene.output,
			output_bytes: keepsOriginalBytes ? download.bytes : scene.output_bytes,
			source_glb: keepsOriginalBytes ? null : download.path,
			generation_ms: finished.elapsed_ms,
			counts: scene.counts,
			bounds: scene.bounds,
			blender_version: scene.blender_version,
		};
	},
};
