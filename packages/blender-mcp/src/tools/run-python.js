// `blender_run_python`: run Python inside Blender against a scene.
//
// This is the escape hatch that makes the rest of the toolset composable:
// decimate a mesh, rename bones, bake an animation, join objects, strip
// materials. The script runs in Blender's own interpreter with `bpy` bound, so
// anything the Blender Python API can do is reachable, and an optional export
// writes the edited scene out in one call.
//
// The tool is powerful by design and therefore explicit about it: it is
// annotated destructive, and setting BLENDER_MCP_ALLOW_PYTHON=0 removes it from
// the advertised tool list entirely for unattended deployments.

import { z } from 'zod';

import { runJob } from '../lib/blender.js';
import { resolveInput, resolveOutput } from '../lib/paths.js';

export const def = {
	name: 'blender_run_python',
	title: 'Run a Python script inside Blender',
	annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
	description:
		'Execute a Python script inside Blender with the full bpy API available. Optionally open a 3D file first ' +
		'(any format Blender imports) and export the edited scene afterwards, chosen by the output extension. ' +
		'Anything printed is returned as stdout, and assigning a JSON-serializable value to a variable named ' +
		'`result` returns it as structured data. Use this for scene edits the other tools do not cover: decimating ' +
		'meshes, joining or renaming objects, editing armatures, baking animation, cleaning materials. The script ' +
		'runs with the permissions of this server and can read and write the local filesystem.',
	inputSchema: {
		code: z.string().min(1).describe('Python source to execute. `bpy`, `math`, and `Vector` are already imported.'),
		input: z
			.string()
			.optional()
			.describe('3D file to open before running the script. Omit to start from an empty scene.'),
		output: z
			.string()
			.optional()
			.describe('Export the scene here after the script runs; the extension selects the format. Omit to discard it.'),
		apply_modifiers: z.boolean().optional().describe('Apply modifiers when exporting. Default true.'),
	},
	async handler(args) {
		const job = {
			op: 'exec',
			code: String(args?.code ?? ''),
			apply_modifiers: args?.apply_modifiers !== false,
		};
		if (args?.input) job.input = await resolveInput(args.input);
		if (args?.output) job.output = await resolveOutput(args.output, job.input || 'scene', '.glb');
		const payload = await runJob(job);
		return { ...payload, ok: true };
	},
};
