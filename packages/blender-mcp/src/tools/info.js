// `blender_info`: report the Blender this server will actually drive.
//
// Every other tool depends on a working Blender, so this is the first call to
// make when something misbehaves: it resolves the executable, reports the
// version and bundled Python, and lists the render engines and file formats
// this specific build can handle. A distro package with a stripped add-on set
// shows up here rather than as a confusing failure three calls later.

import { runJob } from '../lib/blender.js';
import { ALLOW_PYTHON, WORKDIR } from '../config.js';

export const def = {
	name: 'blender_info',
	title: 'Inspect the local Blender install',
	annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
	description:
		'Report the local Blender this server drives: executable path, version, bundled Python, available render ' +
		'engines, and the import/export formats this build actually supports. Call it first when a tool fails, or ' +
		'to check that Blender is installed at all. Read-only: it opens no file and writes nothing.',
	inputSchema: {},
	async handler() {
		const payload = await runJob({ op: 'probe' }, { timeoutMs: 120000 });
		return {
			ok: true,
			blender: {
				path: payload.blender_path,
				version: payload.blender_version,
				python: payload.python_version,
				background: payload.background,
			},
			render_engines: payload.render_engines,
			import_formats: payload.import_formats,
			export_formats: payload.export_formats,
			workdir: WORKDIR,
			python_tool_enabled: ALLOW_PYTHON,
		};
	},
};
