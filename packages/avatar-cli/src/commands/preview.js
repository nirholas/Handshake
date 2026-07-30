import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertValid } from '@three-ws/avatar-schema';
import { style, heading, failure, warn, hint } from '../style.js';

const DEFAULT_VIEWER = 'https://three.ws';

/**
 * `three-ws-avatar preview <path>` - print an embeddable snippet for a validated manifest.
 *
 * Outputs a resolver URL, an <agent-3d> custom-element snippet paired with the
 * loader that registers it, and a zero-install iframe.
 *
 * `agent-3d` is the element three.ws actually registers (src/element.js and
 * public/embed.js). A bare .glb/.gltf on `src` is treated as a body, so the
 * mesh URI can be passed straight through. The snippet is emitted with its
 * loader because the element does nothing until that script has run.
 *
 * Flags:
 *   --viewer <origin>   Override the viewer host (default: https://three.ws)
 *   --json              Emit JSON instead of human-readable output
 */
export async function preview({ positional, flags }) {
	const [filePath] = positional;
	if (!filePath) {
		failure('preview: missing <path> argument');
		return 1;
	}
	const full = resolve(process.cwd(), filePath);
	let manifest;
	try {
		manifest = JSON.parse(readFileSync(full, 'utf8'));
	} catch (err) {
		failure(`could not read manifest at ${filePath}`);
		process.stderr.write(`  ${style.dim(err.message)}\n`);
		return 1;
	}
	assertValid(manifest);

	const viewer = (flags.viewer || DEFAULT_VIEWER).replace(/\/$/, '');
	const encodedId = encodeURIComponent(manifest.id);
	const resolverUrl = `${viewer}/a/${encodedId}`;
	const meshUri = manifest.mesh.uri;
	const loader = `<script type="module" src="${viewer}/agent-3d/latest/agent-3d.js"></script>`;
	const element = `<agent-3d src="${meshUri}" style="width:400px;height:600px"></agent-3d>`;
	const iframe = `<iframe src="${resolverUrl}" width="480" height="640" frameborder="0" allow="camera; microphone; xr-spatial-tracking"></iframe>`;
	// A manifest scaffolded without --mesh-uri points at the local file, which no
	// browser will load cross-origin. Say so instead of printing a dead snippet.
	const meshIsLocal = /^file:\/\//i.test(meshUri);

	if (flags.json) {
		console.log(
			JSON.stringify({
				id: manifest.id,
				resolverUrl,
				loader,
				element,
				iframe,
				meshUri,
				meshIsLocal,
				schemaVersion: manifest.schemaVersion,
			}),
		);
		return 0;
	}

	console.log(`${style.bold(manifest.name)} ${style.dim(`(${manifest.id})`)}`);
	console.log('');
	console.log(heading('resolver url'));
	console.log(resolverUrl);
	console.log('');
	console.log(heading('web component (loader registers <agent-3d>)'));
	console.log(loader);
	console.log(element);
	console.log('');
	console.log(heading('iframe (zero-install)'));
	console.log(iframe);
	if (meshIsLocal) {
		process.stderr.write('\n');
		warn('mesh.uri is a local path, so the snippet above will not load in a browser.');
		hint('re-run init with --mesh-uri https://your-host/avatar.glb, or edit mesh.uri to a public URL');
	}
	return 0;
}
