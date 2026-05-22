// `list_avatars` — enumerate the curated default avatars + accessories +
// pose presets shipped by three.ws. Free, no signer needed.

import { ACCESSORIES, DEFAULT_AVATARS, POSE_PRESETS } from '../lib/avatars.js';

export const def = {
	name: 'list_avatars',
	title: 'List three.ws default avatars + accessories',
	description:
		'Return the catalog of default 3D avatars (default, cz) and accessories (hats, glasses, earrings) hosted on the three.ws CDN. Each entry includes a public GLB URL ready to load in any glTF viewer or Three.js scene. Includes the supported pose preset names.',
	inputSchema: {},
	async handler() {
		return {
			avatars: DEFAULT_AVATARS,
			accessories: ACCESSORIES,
			poses: POSE_PRESETS,
			fetchedAt: new Date().toISOString(),
		};
	},
};
