// `blender_convert`: import one 3D format, export another.
//
// Blender is the most complete format bridge available offline, so this is the
// tool that turns an FBX or USD a client sent into the GLB the three.ws
// pipeline consumes, and back again. Modifiers are applied by default so the
// exported geometry matches what the file looks like on screen.

import { z } from 'zod';

import { runJob } from '../lib/blender.js';
import { resolveInput, resolveOutput } from '../lib/paths.js';

export const def = {
	name: 'blender_convert',
	title: 'Convert a 3D file between formats',
	annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
	description:
		'Convert a 3D file from any format Blender can import to any format it can export, driven entirely by the ' +
		'file extensions: .glb, .gltf, .fbx, .obj, .stl, .ply, .dae, .abc, .usd/.usda/.usdc/.usdz, .x3d, and .blend ' +
		'on both sides. Modifiers are applied on export by default, and an optional uniform scale is baked in. ' +
		'Returns the output path, its size, the resulting geometry counts, and the world-space bounds. The input ' +
		'file is never modified; omit "output" and the result lands in the server workdir.',
	inputSchema: {
		input: z.string().min(1).describe('Path to the source 3D file.'),
		output: z
			.string()
			.optional()
			.describe('Destination path. Its extension selects the export format. Defaults to a .glb in the server workdir.'),
		apply_modifiers: z
			.boolean()
			.optional()
			.describe('Apply modifiers (subdivision, decimate, mirror) to the exported geometry. Default true.'),
		scale: z
			.number()
			.positive()
			.optional()
			.describe('Uniform scale factor baked into the export, e.g. 0.01 to convert centimetre units to metres.'),
	},
	async handler(args) {
		const input = await resolveInput(args?.input);
		const output = await resolveOutput(args?.output, input, '.glb');
		const payload = await runJob({
			op: 'convert',
			input,
			output,
			apply_modifiers: args?.apply_modifiers !== false,
			scale: args?.scale,
		});
		return { ...payload, ok: true };
	},
};
