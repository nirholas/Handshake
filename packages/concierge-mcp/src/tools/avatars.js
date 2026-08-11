// `concierge_avatars`, list the 3D avatars a Concierge widget can wear, so an
// agent or user can pick one before generating an embed. Pure/offline.

import { z } from 'zod';

import { defineTool, defineExecutor, toMcpTools } from '../lib/tool-sdk/index.js';

import { AVATARS, DEFAULT_AVATAR_ID } from '../lib/catalog.js';

const DESCRIPTION =
	'List the rigged 3D avatars a three.ws Concierge widget can wear (id, name, personality tagline, style). ' +
	'Use the id with concierge_embed\'s "avatar" option, or omit it to let each visitor pick their own. Offline.';

const tool = defineTool({
	id: 'concierge-avatars',
	title: 'List available Concierge avatars',
	description: DESCRIPTION,
	version: '1.0.0',
	permissions: {},
	apis: [
		{
			name: 'concierge_avatars',
			title: 'List available Concierge avatars',
			description: DESCRIPTION,
			annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
			parameters: z.object({}),
		},
	],
});

const executor = defineExecutor(tool, {
	async concierge_avatars() {
		return {
			ok: true,
			default: DEFAULT_AVATAR_ID,
			count: AVATARS.length,
			avatars: AVATARS,
			note: 'You can also supply your own rigged GLB via concierge_embed\'s customAvatar option.',
		};
	},
});

export const def = toMcpTools(tool, executor)[0];
