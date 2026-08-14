// `export_scene`: merge an already-forged diorama into one exportable GLB.
//
// Wraps POST /api/diorama {action:'export'}. Takes a diorama that already has
// forged objects (glbUrl per object, from compose_scene + your own forging,
// or from a world fetched with get_scene) and merges it server-side into ONE
// glTF 2.0 binary: every object as a named node, plus a real ground disc and
// KHR_lights_punctual lighting tuned to the diorama's mood. The result opens
// cleanly in three.ws Scene Studio (or any glTF viewer) with every object
// individually selectable. Partial worlds export fine; unforged/failed
// objects are just skipped and reported back, never a hard failure.

import { z } from 'zod';

import { apiRequest } from '../lib/api.js';

const SCENE_STUDIO_BASE = 'https://three.ws/scene';

export const def = {
	name: 'export_scene',
	title: 'Export a forged diorama as one GLB scene',
	annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
	description:
		'Merge an already-forged diorama (objects with real glbUrl values, e.g. from your own forging after compose_scene, or fetched via get_scene) into ONE glTF 2.0 binary: every object becomes a named, selectable node, plus a real ground disc and mood-tuned lighting. Returns the merged GLB URL and a ready-to-open three.ws Scene Studio link. Objects that never forged are skipped and reported rather than treated as a failure; a partial world still exports. Requires the target deployment to have object storage configured (three.ws does).',
	inputSchema: {
		diorama: z
			.record(z.string(), z.any())
			.describe(
				'The diorama object to export, same shape returned by compose_scene/get_scene, with each object you want included carrying status:"ready" and a real glbUrl.',
			),
	},
	async handler(args) {
		const diorama = args?.diorama;
		if (!diorama || typeof diorama !== 'object') {
			throw Object.assign(new Error('diorama is required: pass the object returned by compose_scene or get_scene.'), {
				code: 'diorama_required',
			});
		}
		const data = await apiRequest('/api/diorama', {
			method: 'POST',
			body: { action: 'export', diorama },
			timeoutMs: 60_000, // re-fetches every object GLB + a real gltf-transform merge
		});
		return {
			ok: true,
			glb_url: data.glbUrl,
			scene_studio_url: data.sceneStudioUrl || `${SCENE_STUDIO_BASE}?model=${encodeURIComponent(data.glbUrl)}`,
			title: data.title,
			object_count: data.objectCount,
			exported_count: data.exportedCount,
			skipped: data.skipped || [],
		};
	},
};
