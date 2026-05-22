// `viewer_url` — build a shareable three.ws viewer URL for any GLB plus
// optional embed snippet. Exposes the full set of viewer query params
// the three.ws web viewer respects: background, auto-rotate, camera
// preset OR explicit orbit string, AR mode, dimensions, pose, and
// accessory overlays.
//
// Supports an avatar sessionId (uses the session's GLB + accessories +
// pose as defaults) or a raw GLB URL. No fetch — pure URL composition
// plus an iframe snippet for sites that want to embed.

import { z } from 'zod';

import { VIEWER_BASE, THREE_WS_BASE } from '../config.js';
import { findAccessory, getSession } from '../lib/avatars.js';

function escAttr(s) {
	return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

export const def = {
	name: 'viewer_url',
	title: 'Build a three.ws viewer URL + embed snippet',
	description:
		'Build a shareable https://three.ws/viewer?... URL that opens any GLB in three.ws\'s WebGL viewer, plus a ready-to-paste iframe snippet. Supports background, auto-rotate, camera preset OR explicit camera orbit, AR mode (model-viewer), dimensions, pose, and accessory overlay. Accepts a raw glbUrl or a sessionId from spawn_avatar.',
	inputSchema: {
		glbUrl: z.string().url().optional().describe('Direct GLB URL. Required if sessionId is omitted.'),
		sessionId: z.string().optional().describe('Avatar sessionId returned by spawn_avatar. Overrides glbUrl.'),
		pose: z.string().optional().describe('Pose preset id (e.g. "wave", "tpose"). Call list_animations for the catalog.'),
		accessoryIds: z.array(z.string()).optional().describe('Accessory ids to attach in the viewer.'),
		background: z.string().optional()
			.describe('Background color or gradient (CSS), e.g. "#0a0a0a", "linear-gradient(...)", or "transparent".'),
		autoRotate: z.boolean().optional().describe('Auto-rotate the model. Default true on the web viewer.'),
		ar: z.boolean().optional().describe('Enable model-viewer AR buttons on iOS/Android.'),
		cameraPreset: z.enum(['front', 'three-quarter', 'side', 'back', 'top', 'closeup']).optional()
			.describe('Named camera framing preset.'),
		cameraOrbit: z.string().optional()
			.describe('Explicit camera orbit in model-viewer syntax, e.g. "0deg 80deg 2m". Overrides cameraPreset.'),
		cameraDistance: z.number().positive().optional().describe('Distance multiplier shorthand (1.0 = default). Used when cameraOrbit is absent.'),
		cameraAngleDeg: z.number().optional().describe('Yaw in degrees shorthand. Used when cameraOrbit is absent.'),
		width: z.number().int().min(64).max(4096).optional().describe('Viewer width in pixels (for the iframe snippet).'),
		height: z.number().int().min(64).max(4096).optional().describe('Viewer height in pixels.'),
		thumbnailUrl: z.string().url().optional().describe('Optional thumbnail to show in the iframe before the GLB loads.'),
	},
	async handler(args) {
		const {
			sessionId, glbUrl, pose, accessoryIds, background, autoRotate, ar,
			cameraPreset, cameraOrbit, cameraDistance, cameraAngleDeg,
			width, height, thumbnailUrl,
		} = args || {};

		let resolvedGlb = glbUrl;
		let resolvedAccessories = accessoryIds;
		let resolvedPose = pose;
		let session = null;
		if (sessionId) {
			session = getSession(sessionId);
			if (!session) return { ok: false, error: 'unknown_session', message: `No session ${sessionId}.` };
			resolvedGlb = session.avatar.glb;
			if (!resolvedAccessories) resolvedAccessories = session.accessories.map((a) => a.id);
			if (!resolvedPose) resolvedPose = session.pose;
		}
		if (!resolvedGlb) return { ok: false, error: 'invalid_input', message: 'Pass glbUrl or sessionId.' };

		const params = new URLSearchParams({ src: resolvedGlb });

		// Accessories — dedup + verify against the catalog.
		if (Array.isArray(resolvedAccessories) && resolvedAccessories.length) {
			const seen = new Set();
			const verified = [];
			for (const id of resolvedAccessories) {
				if (seen.has(id)) continue;
				seen.add(id);
				const acc = findAccessory(id);
				verified.push(acc ? acc.id : id);
			}
			params.set('accessories', verified.join(','));
		}
		if (resolvedPose && resolvedPose !== 'idle') params.set('pose', resolvedPose);

		// Camera — explicit orbit wins; fallback to preset; fallback to
		// the dist/yaw shorthand for backward compatibility.
		if (cameraOrbit) {
			params.set('camera', cameraOrbit);
		} else if (cameraPreset) {
			params.set('camera', cameraPreset);
		} else {
			if (typeof cameraDistance === 'number') params.set('camDist', String(cameraDistance));
			if (typeof cameraAngleDeg === 'number') params.set('camYaw', String(cameraAngleDeg));
		}

		if (background) params.set('background', background);
		if (autoRotate === false) params.set('auto_rotate', '0');
		if (autoRotate === true) params.set('auto_rotate', '1');
		if (ar) params.set('ar', '1');
		if (width) params.set('width', String(width));
		if (height) params.set('height', String(height));

		const viewerUrl = `${VIEWER_BASE}?${params.toString()}`;
		const iframeWidth = width || 800;
		const iframeHeight = height || 800;
		const iframeSnippet =
			`<iframe src="${escAttr(viewerUrl)}" width="${iframeWidth}" height="${iframeHeight}" ` +
			`style="border:0;border-radius:12px;background:#0a0a0a" allowfullscreen ` +
			`allow="autoplay;fullscreen;xr-spatial-tracking" loading="lazy"></iframe>`;

		return {
			ok: true,
			viewerUrl,
			iframeSnippet,
			glb: resolvedGlb,
			sessionId: session?.id || null,
			pose: resolvedPose || null,
			accessories: Array.isArray(resolvedAccessories) ? resolvedAccessories : null,
			cameraOrbit: cameraOrbit || (cameraPreset ? `preset:${cameraPreset}` : null),
			background: background || null,
			ar: !!ar,
			thumbnailUrl: thumbnailUrl || null,
			openGraph: {
				image: `${THREE_WS_BASE}/api/avatar-og?src=${encodeURIComponent(resolvedGlb)}`,
				url: viewerUrl,
			},
		};
	},
};
