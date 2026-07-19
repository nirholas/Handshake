// `build_assistant_widget`: turn a config into a paste-ready three.ws
// assistant widget: a floating 3D avatar chatbot for any website.
//
// This is a PURE function. It runs no network call and never changes state: the
// same config always yields the same embed. It validates and normalizes every
// field with the package's own validators (src/lib/config.js), so a hostile or
// malformed value falls back to a safe default rather than producing broken or
// injectable HTML. The result bundles four ready-to-use forms of the same
// widget: a script tag, a frame URL, a JS-API call, and the builder link.

import { z } from 'zod';

import { THREE_WS_BASE } from '../config.js';
import {
	normalizeConfig,
	buildSnippet,
	buildFrameUrl,
	buildJsApi,
	LIMITS,
} from '../lib/config.js';

export const def = {
	name: 'build_assistant_widget',
	title: 'Build a paste-ready three.ws assistant widget embed',
	// Pure and deterministic: no reads of external state, no writes, no network.
	annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false, destructiveHint: false },
	description:
		'Turn a config into a ready-to-embed three.ws assistant widget, a floating 3D avatar chatbot you can drop onto any website. Returns a paste-ready <script> tag (with only the non-default settings as data-* attributes), a standalone frame URL for <iframe> embedding, an equivalent ThreeAssistant.init({...}) JavaScript-API snippet, the visual builder link, and the fully-normalized config. Pure and offline: every field is validated and clamped locally, so a bad value falls back to a safe default and the generated HTML is always well-formed. Call list_assistant_options first to see every avatar, background, mode and attribute you can set.',
	inputSchema: {
		avatar: z
			.string()
			.max(LIMITS.avatar)
			.optional()
			.describe(
				'Which avatar to show: a three.ws avatar id, a "/avatars/*.glb" path (e.g. "/avatars/selfie-girl.glb"), or a full GLB URL. Omit for the default mannequin.',
			),
		agent: z
			.string()
			.max(LIMITS.agent)
			.optional()
			.describe('A three.ws agent id to drive the assistant, as an alternative to picking an avatar directly.'),
		background: z
			.string()
			.max(LIMITS.background)
			.optional()
			.describe(
				'Backdrop behind the avatar: "transparent" (default), a "#hex" color, a preset (ember, ocean, violet, forest, dusk, slate), or "gradient:#aabbcc,#112233,160". Anything else falls back to transparent.',
			),
		mode: z
			.enum(['chat', 'speak', 'both'])
			.default('both')
			.describe('Interaction mode: "chat" (text only), "speak" (voice only), or "both" (default).'),
		name: z.string().max(LIMITS.name).optional().describe('Display name for the assistant / widget header.'),
		greeting: z.string().max(LIMITS.greeting).optional().describe('Opening line the assistant shows on load.'),
		context: z
			.string()
			.max(LIMITS.context)
			.optional()
			.describe('What the assistant should know about the site (used as its grounding context in chat).'),
		accent: z
			.string()
			.max(LIMITS.accent)
			.optional()
			.describe('Accent "#hex" color for the widget UI. Default "#f97316". Non-hex values fall back to the default.'),
		position: z
			.enum(['right', 'left'])
			.default('right')
			.describe('Which corner the launcher sits in: "right" (default) or "left".'),
		voice: z.boolean().optional().describe('Start with voice on (true) or off (false). Defaults to on.'),
		badge: z.boolean().optional().describe('Show the small "three.ws" attribution badge. Defaults to on.'),
	},
	async handler(args) {
		const config = normalizeConfig(args || {});
		const base = THREE_WS_BASE;

		return {
			ok: true,
			snippet: buildSnippet(config, base),
			frame_url: buildFrameUrl(config, base),
			js_api: buildJsApi(config),
			builder_url: `${base}/assistant`,
			config,
			notes:
				'Chat runs on the free three.ws LLM chain by default (no key). Visitors can paste their own Groq or OpenRouter key in the widget settings for a private lane; that key stays in their browser.',
		};
	},
};
