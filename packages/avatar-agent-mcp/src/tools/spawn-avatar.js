// `spawn_avatar` — create an in-process avatar session, either from a
// curated default (default / cz) or from a custom GLB URL. Returns a
// session id that other tools reference (dress_avatar, viewer_url, etc.).

import { z } from 'zod';

import { createSession, findAvatar, viewerUrlFor } from '../lib/avatars.js';

export const def = {
	name: 'spawn_avatar',
	title: 'Spawn a 3D avatar session',
	description:
		'Spawn a 3D avatar from a curated default (preset="default" or "cz") or from a custom GLB URL. Returns a sessionId other tools (dress_avatar, viewer_url, speak) reference, plus the avatar GLB URL and a ready-to-open three.ws viewer link.',
	inputSchema: {
		preset: z.enum(['default', 'cz']).optional()
			.describe('Pick a curated default avatar.'),
		glbUrl: z.string().url().optional()
			.describe('Custom GLB URL — overrides preset.'),
		name: z.string().max(80).optional()
			.describe('Display name for the avatar persona.'),
		voice: z
			.enum(['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'])
			.optional()
			.describe('OpenAI TTS voice the speak tool should use for this session.'),
		persona: z.string().max(500).optional()
			.describe('Short persona/personality blurb (used by callers; not enforced server-side).'),
	},
	async handler(args) {
		const { preset, glbUrl, name, voice, persona } = args || {};
		if (!preset && !glbUrl) {
			return {
				ok: false,
				error: 'invalid_input',
				message: 'Provide either preset ("default" / "cz") or glbUrl.',
			};
		}
		let glb;
		if (glbUrl) {
			glb = glbUrl;
		} else {
			const a = findAvatar(preset);
			if (!a) {
				return { ok: false, error: 'unknown_preset', message: `No default avatar named "${preset}". Call list_avatars.` };
			}
			glb = a.glb;
		}
		const session = createSession({ glb, name, voice, persona });
		return {
			ok: true,
			sessionId: session.id,
			avatar: session.avatar,
			name: session.name,
			voice: session.voice,
			persona: session.persona,
			pose: session.pose,
			viewerUrl: viewerUrlFor(session),
			createdAt: session.createdAt,
		};
	},
};
