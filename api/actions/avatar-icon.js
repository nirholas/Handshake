// Renders a posed + smiling 3D avatar GLB to a square PNG via headless chromium.
// Used as the `icon` URL in the Solana Blink ActionGetResponse so X renders
// a live three.ws avatar portrait in the Blink card instead of a flat image.
//
// GET /api/actions/avatar-icon
//   ?avatar=default|<avatarUuid>   (default: "default")
//   ?pose=<posePresetId>           (optional)
//   ?bg=<css-color>                (default: "#0a0a0a")

import { cors, wrap, error } from '../_lib/http.js';
import { env } from '../_lib/env.js';
import { renderClip } from '../_lib/render-clip.js';
import { getAvatar } from '../_lib/avatars.js';
import { isUuid } from '../_lib/validate.js';

export const maxDuration = 30;

// Every render boots chromium and pulls a GLB, so each param is checked against
// the shape it is actually allowed to take before any of that starts. `bg` in
// particular is embedded in the render page's script block: three.js accepts
// hex, rgb()/rgba(), hsl()/hsla(), and CSS named colors, and nothing outside
// that set is a color a caller could have legitimately meant.
const CSS_COLOR_RE =
	/^(?:#[0-9a-f]{3,8}|rgba?\([\d.,%\s/]{5,64}\)|hsla?\([\d.,%\s/a-z]{5,64}\)|[a-z]{3,20})$/i;
const POSE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (req.method !== 'GET' && req.method !== 'HEAD') {
		return error(res, 405, 'method_not_allowed', 'GET required');
	}

	const url = new URL(req.url, 'http://x');
	const avatarParam = url.searchParams.get('avatar') || 'default';
	const posePresetId = url.searchParams.get('pose') || null;
	const bg = url.searchParams.get('bg') || '#0a0a0a';

	if (avatarParam !== 'default' && !isUuid(avatarParam)) {
		return error(res, 400, 'bad_request', 'avatar must be "default" or an avatar id');
	}
	if (posePresetId !== null && !POSE_ID_RE.test(posePresetId)) {
		return error(res, 400, 'bad_request', 'pose must be a pose preset id');
	}
	if (bg !== 'transparent' && !CSS_COLOR_RE.test(bg)) {
		return error(res, 400, 'bad_request', 'bg must be a CSS color');
	}

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
		// renderClip tags its failures (400 unfetchable GLB, 413 oversized, 502
		// chromium/three.js error). Passing the tag through tells the caller
		// whether the avatar or the renderer is at fault.
		const status = Number(err?.status) >= 400 && Number(err?.status) < 600 ? Number(err.status) : 502;
		return error(res, status, err?.code || 'render_failed', err?.message || 'render failed');
	}

	res.statusCode = 200;
	res.setHeader('content-type', 'image/png');
	res.setHeader('content-length', String(result.png.length));
	res.setHeader(
		'cache-control',
		'public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400',
	);
	res.setHeader('access-control-allow-origin', '*');
	if (req.method === 'HEAD') return res.end();
	res.end(result.png);
});
