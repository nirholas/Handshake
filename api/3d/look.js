// POST /api/3d/look   +   GET /api/3d/look
//
// Let an agent SEE a 3D model. Give it a GLB URL; it renders the model from
// several angles, persists the frames, and answers with image URLs plus the
// geometry facts and a plain-language reading of them.
//
// Why this route exists: every text-to-3D API, ours included, has always
// answered with a link to a binary the caller cannot open. A human clicks it.
// An agent cannot. So an agent generating 3D has had no way to check its own
// work, which is why agentic 3D has been stuck at one shot and a shrug. Give
// the agent frames and the loop closes: generate, look, judge, refine.
//
// Free and keyless, like the rest of /api/3d. Rendering holds a headless
// browser for seconds, so it draws on the shared render bucket rather than
// adding unmetered capacity.
//
//   POST { glb_url, views?, size?, stats? }
//     → 200 { model_url, size, views:[{view,theta,phi,image_url}], missing_views?,
//             stats?, notes?, viewer_url, ar_url }
//     → 400 { error:'invalid_url' | 'invalid_request', message }
//     → 422 { error:'render_failed', message }   (the model could not be drawn)
//     → 429 { error:'rate_limited', message, retry_after }
//
//   GET  → the discovery doc: views, limits, and a runnable example.
//
// The MCP twin of this route (look_at_model, api/_mcp-studio/tools.js) returns
// the SAME frames as MCP image content blocks, which is what actually puts the
// picture in front of a vision-capable model rather than a link to one.

import { cors, wrap, json, readJson } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { renderTurntable, describeGeometry, VIEW_ANGLES, DEFAULT_VIEWS, MAX_VIEWS, MIN_SIZE, MAX_SIZE, DEFAULT_SIZE } from '../_lib/3d-vision.js';
import { persistImageBytes } from '../_lib/image-persist.js';
import { originFromReq, viewerUrl, arLaunchUrl } from '../_mcp-studio/gpt-forge-client.js';

const MAX_BODY_BYTES = 4_000;

// Geometry facts come from the free inspector rather than a second glTF parser
// here, so "what this model is" has exactly one implementation. It is
// best-effort: an inspector hiccup costs the caller its stats, never its
// frames, because the frames are the thing that could not be got any other way.
async function statsFor(base, glbUrl) {
	try {
		const res = await fetch(`${base}/api/3d/inspect?url=${encodeURIComponent(glbUrl)}`, {
			headers: { accept: 'application/json' },
			signal: AbortSignal.timeout(20_000),
		});
		if (!res.ok) return null;
		const body = await res.json();
		return body?.stats && typeof body.stats === 'object' ? body.stats : null;
	} catch {
		return null;
	}
}

function discovery(base) {
	return {
		route: '/api/3d/look',
		summary: 'Render a 3D model from several angles so an AI agent can see and judge it.',
		free: true,
		views: Object.fromEntries(Object.entries(VIEW_ANGLES).map(([k, v]) => [k, `theta ${v.theta}, phi ${v.phi}`])),
		defaults: { views: DEFAULT_VIEWS, size: DEFAULT_SIZE },
		limits: { max_views: MAX_VIEWS, min_size: MIN_SIZE, max_size: MAX_SIZE },
		example: {
			method: 'POST',
			body: { glb_url: 'https://example.com/model.glb', views: ['three-quarter', 'back'], size: 512 },
		},
		mcp_equivalent: {
			server: `${base}/api/mcp-studio`,
			tool: 'look_at_model',
			note: 'Returns the same frames as MCP image content blocks, viewable directly by a multimodal model.',
		},
		docs: `${base}/docs/3d-vision`,
	};
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', origins: '*' })) return;
	const base = originFromReq(req);

	if (req.method === 'GET' || req.method === 'HEAD') {
		return json(res, 200, discovery(base), { 'cache-control': 'public, max-age=300' });
	}
	if (req.method !== 'POST') {
		res.setHeader('allow', 'GET, POST');
		return json(res, 405, { error: 'method_not_allowed', message: 'Use POST with a glb_url, or GET for the discovery doc.' });
	}

	let body;
	try {
		body = await readJson(req, MAX_BODY_BYTES);
	} catch (err) {
		return json(res, err?.status === 413 ? 413 : 400, {
			error: 'invalid_request',
			message: err?.status === 413 ? 'Request body too large.' : 'Send a JSON body: { "glb_url": "https://..." }.',
		});
	}

	const glbUrl = typeof body?.glb_url === 'string' ? body.glb_url.trim() : '';
	if (!/^https:\/\//i.test(glbUrl)) {
		return json(res, 400, { error: 'invalid_url', message: '"glb_url" must be a public https URL to a .glb file.' });
	}

	const rl = await limits.renderIp(clientIp(req));
	if (!rl.success) {
		const retryAfter = Math.max(1, Math.ceil((rl.reset - Date.now()) / 1000));
		res.setHeader('retry-after', String(retryAfter));
		return json(res, 429, {
			error: 'rate_limited',
			message: 'Too many renders from this address; try again shortly.',
			retry_after: retryAfter,
		});
	}

	let turntable;
	try {
		turntable = await renderTurntable({ glbUrl, views: body?.views, size: body?.size });
	} catch (err) {
		// A caller-supplied URL that is unreachable, not a GLB, or points somewhere
		// private is the caller's problem to fix, not a server fault: say which.
		const code = err?.code === 'render_failed' ? 422 : 400;
		return json(res, code, {
			error: err?.code === 'render_failed' ? 'render_failed' : 'invalid_url',
			message: String(err?.message || 'could not render this model').slice(0, 300),
		});
	}

	const views = [];
	for (const frame of turntable.frames) {
		views.push({
			view: frame.view,
			theta: frame.theta,
			phi: frame.phi,
			image_url: await persistImageBytes(frame.png),
		});
	}

	const wantStats = body?.stats !== false;
	const stats = wantStats ? await statsFor(base, glbUrl) : null;

	return json(res, 200, {
		model_url: glbUrl,
		size: turntable.size,
		views,
		...(turntable.failed.length ? { missing_views: turntable.failed } : {}),
		...(stats ? { stats, notes: describeGeometry(stats) } : {}),
		viewer_url: viewerUrl(base, glbUrl),
		ar_url: arLaunchUrl(base, glbUrl),
	});
});

// Rendering several frames on one shared browser is seconds of work, not
// milliseconds; give it room rather than truncating a turntable mid-set.
export const config = { maxDuration: 120 };
