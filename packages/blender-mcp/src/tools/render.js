// `blender_render`: render a still preview of a 3D file.
//
// The point is a preview an agent can look at without a viewport, so the tool
// fills in what a bare asset file lacks: if the scene has no camera one is
// created and framed to the geometry's bounding sphere, and if it has no light
// a key light and a lit world are added. A scene that already carries its own
// camera and lighting is rendered exactly as authored.
//
// CYCLES is the default engine because it renders on CPU; EEVEE needs a real
// GPU context, which a headless container usually does not have.

import { z } from 'zod';

import { runJob } from '../lib/blender.js';
import { resolveInput, resolveOutput } from '../lib/paths.js';

export const def = {
	name: 'blender_render',
	title: 'Render a preview image of a 3D file',
	annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
	description:
		'Render a still PNG of any 3D file Blender can open (.blend, .glb, .fbx, .obj, .usd and the rest). If the ' +
		'scene has no camera, one is created and framed to the model; if it has no light, a key light and a lit ' +
		'world are added, so a bare asset file renders as a usable preview with no setup. A scene that already has ' +
		'its own camera and lighting is rendered as authored. Returns the image path, the engine used, and whether ' +
		'a camera or lights had to be added. Use it to see a model, check a conversion, or produce a thumbnail.',
	inputSchema: {
		input: z.string().min(1).describe('Path to the 3D file to render.'),
		output: z.string().optional().describe('Destination PNG path. Defaults to a .png in the server workdir.'),
		engine: z
			.enum(['auto', 'CYCLES', 'BLENDER_EEVEE', 'BLENDER_WORKBENCH'])
			.optional()
			.describe(
				'Render engine. "auto" (default) picks CYCLES, which renders on CPU. EEVEE is far faster but needs a GPU ' +
					'context. Call blender_info to see what this build offers.',
			),
		samples: z.number().int().min(1).max(4096).optional().describe('Sample count. Default 32: enough for a preview.'),
		resolution: z
			.array(z.number().int().min(16).max(8192))
			.length(2)
			.optional()
			.describe('Output size as [width, height]. Default [960, 960].'),
		transparent: z.boolean().optional().describe('Render with a transparent background instead of the world. Default false.'),
	},
	async handler(args) {
		const input = await resolveInput(args?.input);
		const output = await resolveOutput(args?.output, input, '.png');
		const payload = await runJob({
			op: 'render',
			input,
			output,
			engine: args?.engine || 'auto',
			samples: args?.samples ?? 32,
			resolution: args?.resolution ?? [960, 960],
			transparent: args?.transparent === true,
		});
		return { ...payload, ok: true };
	},
};
