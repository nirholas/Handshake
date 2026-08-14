// `compose_scene`: turn one sentence into a placed 3D diorama plan.
//
// Wraps POST /api/diorama {action:'compose'}. The platform's free-first LLM
// chain decomposes the sentence into a mood/palette/ground plus a set of
// single-object forge prompts with positions, the same plan the three.ws
// diorama page then forges into meshes. Returns the plan; nothing is persisted.

import { z } from 'zod';

import { apiRequest } from '../lib/api.js';

const VIEWER = 'https://three.ws/diorama';

export const def = {
	name: 'compose_scene',
	title: 'Compose a 3D diorama plan from one sentence',
	// Not a pure read: it drives a server-side LLM completion. It mutates no
	// state, so it is not destructive, but annotation-aware clients should
	// still surface it rather than silently auto-running inference.
	annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
	description:
		'Compose a tiny 3D diorama from one short sentence. Returns a PLAN: an evocative title, a mood (dawn/day/dusk/night), ground + island type, a color palette, and 2-8 placed objects, each with a single-object forge prompt, position, scale and rotation. No meshes are generated yet and nothing is saved; feed the plan to the three.ws diorama page (or /api/forge per object) to build the world. Read-mostly but runs live LLM inference.',
	inputSchema: {
		prompt: z
			.string()
			.min(3, 'Describe your world in at least a few words.')
			.max(1024)
			.describe('One short sentence describing the world to build, e.g. "a lonely lighthouse on a stormy cliff".'),
	},
	async handler(args) {
		const prompt = String(args?.prompt ?? '').trim();
		const data = await apiRequest('/api/diorama', { method: 'POST', body: { action: 'compose', prompt } });
		const diorama = data?.diorama;
		if (!diorama) {
			throw Object.assign(new Error('The composer returned no diorama. Try a more concrete sentence.'), {
				code: 'compose_empty',
			});
		}
		return {
			ok: true,
			diorama,
			object_count: Array.isArray(diorama.objects) ? diorama.objects.length : 0,
			next: 'Forge each object via POST /api/forge, then POST /api/diorama {action:"save"} to get a shareable permalink.',
			viewer_base: VIEWER,
		};
	},
};
