// `list_assistant_options`: enumerate everything you can configure on the
// three.ws assistant widget. Read-only, offline, deterministic.
//
// This is the discovery companion to build_assistant_widget: it returns the full
// vocabulary (avatars, backgrounds, modes, chat lanes) plus a complete data-*
// attribute reference table, so an agent can present the options before it
// builds an embed. No network, no state, the vocabulary is defined locally.

import { z } from 'zod';

import { THREE_WS_BASE } from '../config.js';
import {
	BUILTIN_AVATARS,
	BACKGROUND_PRESETS,
	MODES,
	CHAT_LANES,
	DEFAULT_ACCENT,
	DEFAULT_BACKGROUND,
	DEFAULT_MODE,
	DEFAULT_POSITION,
} from '../lib/config.js';

const MODE_DESCRIPTIONS = {
	chat: 'Text chat only, a typed conversation, no speech.',
	speak: 'Voice only, the avatar speaks its replies aloud (TTS).',
	both: 'Text chat and voice together (default).',
};

// The full data-* reference, mirrored from build_assistant_widget's schema.
const ATTRIBUTES = [
	{
		attr: 'data-avatar',
		values: 'avatar id | "/avatars/*.glb" path | GLB URL',
		default: '(default mannequin)',
		description: 'Which 3D avatar the widget shows.',
	},
	{
		attr: 'data-agent',
		values: 'three.ws agent id',
		default: '(none)',
		description: 'Drive the assistant from an existing three.ws agent instead of a bare avatar.',
	},
	{
		attr: 'data-bg',
		values: 'transparent | #hex | ember/ocean/violet/forest/dusk/slate | gradient:#a,#b[,angle]',
		default: DEFAULT_BACKGROUND,
		description: 'Backdrop behind the avatar. (Input field name: "background"; wire attribute: data-bg.)',
	},
	{
		attr: 'data-mode',
		values: MODES.join(' | '),
		default: DEFAULT_MODE,
		description: 'Text chat, voice, or both.',
	},
	{ attr: 'data-name', values: 'string (<= 60 chars)', default: '(none)', description: 'Assistant / header name.' },
	{ attr: 'data-greeting', values: 'string (<= 200 chars)', default: '(none)', description: 'Opening line on load.' },
	{
		attr: 'data-context',
		values: 'string (<= 500 chars)',
		default: '(none)',
		description: 'What the assistant should know about the site.',
	},
	{ attr: 'data-accent', values: '#hex', default: DEFAULT_ACCENT, description: 'Accent color for the widget UI.' },
	{
		attr: 'data-position',
		values: 'right | left',
		default: DEFAULT_POSITION,
		description: 'Corner the launcher sits in.',
	},
	{ attr: 'data-voice', values: 'true | false', default: 'true', description: 'Start with voice on or off.' },
	{ attr: 'data-badge', values: 'true | false', default: 'true', description: 'Show the three.ws attribution badge.' },
];

export const def = {
	name: 'list_assistant_options',
	title: 'List every three.ws assistant widget option',
	annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
	description:
		'List everything you can configure on the three.ws assistant widget: the built-in avatars, background presets and grammar, interaction modes, chat lanes (free vs bring-your-own-key), and the full data-* attribute reference table. Call this before build_assistant_widget to know the vocabulary. Read-only and offline.',
	inputSchema: {
		filter: z
			.enum(['avatars', 'backgrounds', 'modes', 'chat_lanes', 'attributes'])
			.optional()
			.describe('Optionally return just one section. Omit to get everything.'),
	},
	async handler(args) {
		const base = THREE_WS_BASE;

		const sections = {
			avatars: {
				builtin: BUILTIN_AVATARS.map((a) => ({ ...a })),
				note: 'Any three.ws avatar id, a "/avatars/*.glb" path, or a full GLB URL also works.',
			},
			backgrounds: {
				presets: [...BACKGROUND_PRESETS],
				also: ['transparent', '#hex', 'gradient:#a,#b,angle'],
			},
			modes: MODES.map((id) => ({ id, description: MODE_DESCRIPTIONS[id] })),
			chat_lanes: CHAT_LANES.map((lane) => ({ ...lane })),
			attributes: ATTRIBUTES.map((a) => ({ ...a })),
		};

		const filter = args?.filter;
		const payload = filter ? { [filter]: sections[filter] } : sections;

		return {
			ok: true,
			...payload,
			docs_url: `${base}/docs/assistant-widget`,
		};
	},
};
