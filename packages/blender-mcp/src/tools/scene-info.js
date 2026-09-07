// `blender_scene_info`: read a 3D file through Blender and describe it.
//
// Wraps the runner's scene_info op: open a .blend or import any supported
// format into an empty scene, then report evaluated geometry (modifiers
// applied), materials, armatures, animation actions, and world-space bounds.

import { z } from 'zod';

import { runJob } from '../lib/blender.js';
import { resolveInput } from '../lib/paths.js';

export const def = {
	name: 'blender_scene_info',
	title: 'Describe a 3D file with Blender',
	annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
	description:
		'Open a 3D file with Blender and report what is inside it: object list with types, parents, dimensions and ' +
		'modifiers; evaluated triangle and vertex counts; materials; armature bone names; animation actions with ' +
		'their frame ranges; and world-space bounds. Accepts .blend plus every format this Blender can import ' +
		'(.glb, .gltf, .fbx, .obj, .stl, .ply, .dae, .abc, .usd*, .x3d). Read-only: the file is never modified.',
	inputSchema: {
		input: z.string().min(1).describe('Path to the 3D file to inspect. Absolute, or relative to the server working directory.'),
		include_objects: z
			.boolean()
			.optional()
			.describe('Include the per-object breakdown. Set false on very large scenes to get totals only. Default true.'),
	},
	async handler(args) {
		const input = await resolveInput(args?.input);
		const payload = await runJob({
			op: 'scene_info',
			input,
			include_objects: args?.include_objects !== false,
		});
		return { ...payload, ok: true };
	},
};
