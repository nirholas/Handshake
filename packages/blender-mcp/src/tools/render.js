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

import { readFile, rm } from 'node:fs/promises';

import { z } from 'zod';

import { runJob } from '../lib/blender.js';
import { INLINE_IMAGE_MAX_PX, INLINE_IMAGE_MAX_BYTES } from '../config.js';
import { resolveInput, resolveOutput } from '../lib/paths.js';

export const def = {
	name: 'blender_render',
	title: 'Render a preview image of a 3D file',
	annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
	description:
		'Render a still PNG of any 3D file Blender can open (.blend, .glb, .fbx, .obj, .usd and the rest). If the ' +
		'scene has no camera, one is created and framed to the model; if it has no light, a key light and a lit ' +
		'world are added, so a bare asset file renders as a usable preview with no setup. A scene that already has ' +
		'its own camera and lighting is rendered as authored. The rendered image is returned INLINE alongside the ' +
		'JSON, so you can actually look at the model in this one call without needing filesystem access, while the ' +
		'full-resolution PNG is written to disk. Use it to see a model, check a conversion, or produce a thumbnail.',
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
		inline_image: z
			.boolean()
			.optional()
			.describe('Return the image inline so you can see it, downscaled to fit the context. Default true.'),
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
			inline_max_px: args?.inline_image === false ? 0 : INLINE_IMAGE_MAX_PX,
		});
		return { ...payload, ok: true, inline_image: args?.inline_image !== false };
	},

	/**
	 * Hand the rendered image back as an MCP image block.
	 *
	 * The scaled copy is read and then deleted: it exists only to travel in this
	 * response, and leaving it beside the real output would be litter the caller
	 * has to reason about. An image too large to inline is reported in the JSON
	 * rather than silently dropped, so the caller knows to read the file.
	 */
	async attachments(result) {
		if (!result?.inline_image) return [];
		const path = result.preview || result.output;
		const bytes = result.preview ? result.preview_bytes : result.output_bytes;
		if (!path || !bytes) return [];
		if (bytes > INLINE_IMAGE_MAX_BYTES) {
			result.inline_image_skipped = `the image is ${bytes} bytes, over the ${INLINE_IMAGE_MAX_BYTES} inline limit; read it from ${result.output}`;
			if (result.preview) await rm(path, { force: true });
			return [];
		}
		const data = await readFile(path);
		if (result.preview) await rm(path, { force: true });
		return [{ type: 'image', data: data.toString('base64'), mimeType: 'image/png' }];
	},
};
