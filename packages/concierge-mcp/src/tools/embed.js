// `concierge_embed`, generate copy-paste embed code that adds a three.ws
// Concierge (an AI chat widget with a 3D avatar) to a website. Pure/offline:
// it composes the snippet from the given config, hits no network.

import { z } from 'zod';

import { defineTool, defineExecutor, toMcpTools } from '../lib/tool-sdk/index.js';

import { buildEmbed } from '../lib/embed.js';
import { isKnownAvatar, AVATARS } from '../lib/catalog.js';

const AVATAR_IDS = AVATARS.map((a) => a.id);

const DESCRIPTION =
	'Generate ready-to-paste embed code for adding a three.ws Concierge (an AI chat widget with a talking 3D ' +
	'avatar) to a website. Returns every install flavor by default (flavor "all"): the one-tag <script> install, ' +
	'the <three-concierge> web component, the npm snippet, and the imperative mount() call; pass `flavor` to get ' +
	'just one. Configure the accent color, avatar, greeting, curated knowledge, suggested prompts, position and ' +
	'theme. Offline: this only composes the code, it installs nothing.';

const tool = defineTool({
	id: 'concierge-embed',
	title: 'Generate a Concierge embed snippet for a website',
	description: DESCRIPTION,
	version: '1.0.0',
	permissions: {}, // pure code generation, no network, no filesystem
	apis: [
		{
			name: 'concierge_embed',
			title: 'Generate a Concierge embed snippet for a website',
			description: DESCRIPTION,
			annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
			parameters: z.object({
				siteName: z.string().max(120).optional().describe('Name of the site/product, used in the greeting + grounding.'),
				flavor: z
					.enum(['script', 'web-component', 'npm', 'imperative', 'all'])
					.default('all')
					.describe('Which snippet(s) to return. "script" is the one-tag CDN install; "all" returns every flavor.'),
				accent: z.string().max(32).optional().describe('CSS color that restyles the whole widget, e.g. "#f97316".'),
				avatar: z
					.enum(AVATAR_IDS)
					.optional()
					.describe(`Initial avatar id: ${AVATAR_IDS.join(', ')}. Omit to let the visitor pick.`),
				customAvatar: z.string().url().optional().describe('URL of your own rigged GLB avatar (replaces the catalog).'),
				position: z.enum(['bottom-right', 'bottom-left']).optional().describe('Corner the launcher docks to.'),
				theme: z.enum(['auto', 'dark', 'light']).optional().describe('Color theme. "auto" follows the visitor\'s system/site.'),
				greeting: z.string().max(200).optional().describe('First line shown in the empty state and teaser bubble.'),
				persona: z.string().max(200).optional().describe('One-line tone instruction, e.g. "warm, playful, concise".'),
				knowledge: z.string().max(8000).optional().describe('Curated facts (FAQ, pricing, policies) the answers are grounded in.'),
				suggestions: z.array(z.string().max(80)).max(4).optional().describe('Up to 4 suggested prompt chips.'),
				endpoint: z.string().url().optional().describe('Custom answer endpoint. Omit to use the free hosted three.ws lane.'),
				muted: z.boolean().optional().describe('Start with voice output off.'),
				open: z.boolean().optional().describe('Start with the panel open.'),
				noPicker: z.boolean().optional().describe('Hide the avatar picker.'),
				noTeaser: z.boolean().optional().describe('Never show the proactive teaser bubble.'),
				lang: z.string().max(20).optional().describe('BCP-47 language hint for voice and replies.'),
			}),
		},
	],
});

const executor = defineExecutor(tool, {
	async concierge_embed(args) {
		const { flavor = 'all', ...config } = args;
		if (config.avatar && !isKnownAvatar(config.avatar)) {
			throw Object.assign(new Error(`unknown avatar "${config.avatar}" (expected one of: ${AVATAR_IDS.join(', ')})`), {
				code: 'bad_request',
			});
		}
		const { snippets, config: applied } = buildEmbed(config, flavor);
		return {
			ok: true,
			flavor,
			snippets,
			applied_config: applied,
			docs: 'https://three.ws/docs/concierge',
		};
	},
});

export const def = toMcpTools(tool, executor)[0];
