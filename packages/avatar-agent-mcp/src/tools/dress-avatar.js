// `dress_avatar` — apply or remove accessories on a spawned avatar session
// and optionally set the pose. Returns the updated session manifest and a
// refreshed viewer URL.

import { z } from 'zod';

import { ACCESSORIES, POSE_PRESETS, findAccessory, getSession, updateSession, viewerUrlFor } from '../lib/avatars.js';

export const def = {
	name: 'dress_avatar',
	title: 'Apply accessories + pose to a spawned avatar',
	description:
		'Apply (or replace) accessories on a spawned avatar session and optionally set a pose. Pass accessoryIds to set the full accessory list (empty array clears them). Pass pose to switch animations. Returns the updated viewer URL.',
	inputSchema: {
		sessionId: z.string().describe('Session id returned by spawn_avatar.'),
		accessoryIds: z.array(z.string()).optional()
			.describe(`Full list of accessory ids to wear. Allowed: ${ACCESSORIES.map((a) => a.id).join(', ')}. Empty array clears.`),
		pose: z.string().optional()
			.describe(`Pose preset. Allowed: ${POSE_PRESETS.join(', ')}.`),
	},
	async handler(args) {
		const { sessionId, accessoryIds, pose } = args || {};
		const session = getSession(sessionId);
		if (!session) {
			return { ok: false, error: 'unknown_session', message: `No session ${sessionId}. Call spawn_avatar first.` };
		}
		const patch = {};
		if (Array.isArray(accessoryIds)) {
			const resolved = [];
			const missing = [];
			for (const id of accessoryIds) {
				const acc = findAccessory(id);
				if (!acc) {
					missing.push(id);
					continue;
				}
				resolved.push(acc);
			}
			if (missing.length) {
				return { ok: false, error: 'unknown_accessory', missing, allowed: ACCESSORIES.map((a) => a.id) };
			}
			patch.accessories = resolved;
		}
		if (pose) {
			if (!POSE_PRESETS.includes(pose)) {
				return { ok: false, error: 'unknown_pose', pose, allowed: POSE_PRESETS };
			}
			patch.pose = pose;
		}
		const updated = updateSession(sessionId, patch);
		return {
			ok: true,
			sessionId: updated.id,
			avatar: updated.avatar,
			accessories: updated.accessories,
			pose: updated.pose,
			viewerUrl: viewerUrlFor(updated),
			lastUpdated: updated.lastUpdated,
		};
	},
};
