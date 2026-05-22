// `render_avatar` — full posed avatar render with three.ws's render-clip
// pipeline: applies a pose preset's Euler-rotation map to the rig, sets
// the camera orbit (theta/phi/radius), optionally applies ARKit-52 morph
// targets for facial expression, and returns the PNG.
//
// Mirrors the experience of the three.ws customizer: same rig conventions
// (Avaturn), same pose library (PRESETS in /src/pose-presets.js), same
// lighting (three-light rig with ACES tone mapping). Works on any GLB
// that follows the standard rig — both curated defaults and uploaded
// avatars.

import { z } from 'zod';

import { renderAvatarClipRemote } from '../lib/render.js';
import { getSession } from '../lib/avatars.js';

export const def = {
	name: 'render_avatar',
	title: 'Render a posed avatar (pose + camera + expression)',
	description:
		'Render an avatar GLB with a three.ws pose preset, camera orbit, and optional ARKit-52 facial expression. Same pipeline as the three.ws customizer\'s save-snapshot flow. Returns PNG bytes as a base64 data URL. Accepts either glbUrl directly or sessionId from spawn_avatar.',
	inputSchema: {
		glbUrl: z.string().url().optional().describe('Avatar GLB URL. Required if sessionId is omitted.'),
		sessionId: z.string().optional().describe('Avatar session id from spawn_avatar. Overrides glbUrl.'),
		posePresetId: z.string().optional()
			.describe('Pose preset id (e.g. "tpose", "wave", "thinker"). Call list_animations for the full catalog.'),
		cameraOrbit: z.object({
			theta: z.number().optional().describe('Yaw in degrees, 0..360. Default 0 (front).'),
			phi: z.number().optional().describe('Pitch in degrees, 0..180 (from top). Default 80 (slightly above eye-level).'),
			radius: z.number().nullable().optional().describe('Distance in meters. null = auto-frame the bounding box.'),
		}).optional().describe('Camera orbit around the avatar.'),
		expression: z.record(z.number()).optional()
			.describe('ARKit-52 morph target map, e.g. { mouthSmileLeft: 0.6, mouthSmileRight: 0.6 }.'),
		width: z.number().int().min(64).max(2048).optional().describe('Output width (default 1024).'),
		height: z.number().int().min(64).max(2048).optional().describe('Output height (default 1024).'),
		background: z.string().optional().describe('CSS color or "transparent". Default "#0a0a0a".'),
	},
	async handler(args) {
		const { sessionId, glbUrl, posePresetId, cameraOrbit, expression, width, height, background } = args || {};
		let resolvedGlb = glbUrl;
		let sessionPose = null;
		if (sessionId) {
			const session = getSession(sessionId);
			if (!session) return { ok: false, error: 'unknown_session', message: `No session ${sessionId}.` };
			resolvedGlb = session.avatar.glb;
			sessionPose = session.pose && session.pose !== 'idle' ? session.pose : null;
		}
		if (!resolvedGlb) return { ok: false, error: 'invalid_input', message: 'Pass glbUrl or sessionId.' };
		const out = await renderAvatarClipRemote({
			glbUrl: resolvedGlb,
			posePresetId: posePresetId || sessionPose || null,
			cameraOrbit,
			expression,
			width,
			height,
			background,
		});
		return { ...out, glbUrl: resolvedGlb, sessionId: sessionId || null };
	},
};
