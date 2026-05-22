// Renders a posed + smiling 3D avatar GLB to a square PNG via headless chromium.
// Used as the `icon` URL in the Solana Blink ActionGetResponse so X renders
// a live three.ws avatar portrait in the Blink card instead of a flat image.
//
// GET /api/actions/avatar-icon
//   ?avatar=default|<avatarId>   (default: "default")
//   ?pose=<posePresetId>         (optional)
//   ?bg=<css-color>              (default: "#0a0a0a")

import { cors, wrap, error } from '../_lib/http.js';
import { env } from '../_lib/env.js';
import { renderClip } from '../_lib/render-clip.js';
import { getAvatar } from '../_lib/avatars.js';

export const maxDuration = 30;

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;

	const url = new URL(req.url, 'http://x');
	const avatarParam = url.searchParams.get('avatar') || 'default';
	const posePresetId = url.searchParams.get('pose') || null;
	const bg = url.searchParams.get('bg') || '#0a0a0a';

	const origin = env.APP_ORIGIN;
	let glbUrl;

	if (avatarParam === 'default') {
		glbUrl = `${origin}/avatars/default.glb`;
	} else {
		const avatar = await getAvatar({ id: avatarParam }).catch(() => null);
		glbUrl = avatar?.model_url || `${origin}/avatars/default.glb`;
	}

	let result;
	try {
		result = await renderClip({
			glbUrl,
			width: 512,
			height: 512,
			background: bg,
			posePresetId,
			// Portrait framing: slight angle, camera from above-center
			cameraOrbit: { theta: 10, phi: 75, radius: null },
			// Subtle smile via ARKit morph targets
			expression: { mouthSmileLeft: 0.4, mouthSmileRight: 0.4 },
		});
	} catch (err) {
		return error(res, 502, 'render_failed', err?.message || 'render failed');
	}

	res.statusCode = 200;
	res.setHeader('content-type', 'image/png');
	res.setHeader('content-length', String(result.png.length));
	res.setHeader(
		'cache-control',
		'public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400',
	);
	res.setHeader('access-control-allow-origin', '*');
	res.end(result.png);
});
