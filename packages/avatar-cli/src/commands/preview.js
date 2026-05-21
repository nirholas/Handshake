import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertValid } from '@three-ws/avatar-schema';

const DEFAULT_VIEWER = 'https://three.ws';

/**
 * `three-ws-avatar preview <path>` — print an embeddable snippet for a validated manifest.
 *
 * Outputs both the <three-ws-avatar> custom-element snippet and a resolver URL
 * pointing at the three.ws viewer for the avatar's id.
 *
 * Flags:
 *   --viewer <origin>   Override the viewer host (default: https://three.ws)
 *   --json              Emit JSON instead of human-readable output
 */
export async function preview({ positional, flags }) {
	const [filePath] = positional;
	if (!filePath) {
		process.stderr.write('preview: missing <path> argument\n');
		return 1;
	}
	const full = resolve(process.cwd(), filePath);
	const manifest = JSON.parse(readFileSync(full, 'utf8'));
	assertValid(manifest);

	const viewer = (flags.viewer || DEFAULT_VIEWER).replace(/\/$/, '');
	const encodedId = encodeURIComponent(manifest.id);
	const resolverUrl = `${viewer}/a/${encodedId}`;
	const element = `<three-ws-avatar id="${manifest.id}" src="${manifest.mesh.uri}"></three-ws-avatar>`;
	const iframe = `<iframe src="${resolverUrl}" width="480" height="640" frameborder="0" allow="camera; microphone; xr-spatial-tracking"></iframe>`;

	if (flags.json) {
		console.log(
			JSON.stringify({
				id: manifest.id,
				resolverUrl,
				element,
				iframe,
				schemaVersion: manifest.schemaVersion,
			}),
		);
		return 0;
	}

	console.log(`# ${manifest.name} (${manifest.id})`);
	console.log('');
	console.log('# resolver url');
	console.log(resolverUrl);
	console.log('');
	console.log('# web component (requires @three-ws/avatar on the page)');
	console.log(element);
	console.log('');
	console.log('# iframe (zero-install)');
	console.log(iframe);
	return 0;
}
