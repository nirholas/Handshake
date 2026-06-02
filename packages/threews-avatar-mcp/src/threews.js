// three.ws public avatar API client.
//
// A dependency-free wrapper over the real three.ws endpoints that resolve an
// avatar (by id, @handle, or a raw GLB url), render it to a PNG, and produce
// the embed/viewer URLs used across the platform. Every method hits a live
// three.ws endpoint — there is no mock or sample path. Public and unlisted
// avatars need no credentials.
//
// Override the host with THREEWS_BASE_URL (e.g. a preview deployment).

const DEFAULT_BASE = 'https://three.ws';

export class ThreewsError extends Error {
	constructor(message, { status } = {}) {
		super(message);
		this.name = 'ThreewsError';
		this.status = status;
	}
}

export function baseUrl(env = process.env) {
	return (env.THREEWS_BASE_URL?.trim() || DEFAULT_BASE).replace(/\/$/, '');
}

function timeoutMs(env = process.env) {
	return Number(env.THREEWS_TIMEOUT_MS) || 30_000;
}

async function fetchWithTimeout(url, init = {}) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs());
	try {
		return await fetch(url, { ...init, signal: controller.signal });
	} catch (err) {
		if (err.name === 'AbortError') throw new ThreewsError(`Request to ${url} timed out.`);
		throw new ThreewsError(`Network error calling ${url}: ${err.message}`);
	} finally {
		clearTimeout(timer);
	}
}

// Normalize the various avatar shapes the API returns into one flat record.
function normalizeAvatar(avatar, user) {
	if (!avatar || typeof avatar !== 'object') return null;
	const model_url = avatar.model_url || avatar.base_model_url || avatar.url || null;
	return {
		id: avatar.id || null,
		name: avatar.name || avatar.display_name || user?.display_name || user?.username || 'Avatar',
		slug: avatar.slug || null,
		model_url,
		thumbnail: avatar.thumbnail_url || avatar.thumbnail || avatar.poster || null,
		visibility: avatar.visibility || null,
		owner: user ? { username: user.username, display_name: user.display_name } : undefined,
	};
}

async function readJson(res, url) {
	if (res.status === 404) throw new ThreewsError(`No avatar found at ${url}.`, { status: 404 });
	if (!res.ok) throw new ThreewsError(`three.ws ${url} → HTTP ${res.status}`, { status: res.status });
	try {
		return await res.json();
	} catch {
		throw new ThreewsError(`three.ws ${url} returned a non-JSON response.`);
	}
}

/**
 * Resolve an avatar from one of three selectors:
 *   - { id }     → GET /api/avatars/:id
 *   - { handle } → GET /api/users/:handle/avatar
 *   - { model }  → a raw GLB url, used as-is (no API call)
 * Returns a normalized avatar record, or throws ThreewsError.
 */
export async function resolveAvatar({ id, handle, model }, env = process.env) {
	const base = baseUrl(env);

	if (model) {
		return { id: null, name: 'Avatar', slug: null, model_url: model, thumbnail: null, visibility: 'external' };
	}
	if (id) {
		const url = `${base}/api/avatars/${encodeURIComponent(id)}`;
		const data = await readJson(await fetchWithTimeout(url), url);
		const avatar = normalizeAvatar(data.avatar || data, data.user);
		if (!avatar?.model_url) throw new ThreewsError(`Avatar ${id} has no public model (it may be private).`);
		return avatar;
	}
	if (handle) {
		const h = handle.replace(/^@/, '');
		const url = `${base}/api/users/${encodeURIComponent(h)}/avatar`;
		const data = await readJson(await fetchWithTimeout(url), url);
		const avatar = normalizeAvatar(data.avatar || data, data.user);
		if (!avatar?.model_url) throw new ThreewsError(`@${h} has no public avatar model.`);
		return avatar;
	}
	throw new ThreewsError('Provide one of: id, handle, or model (GLB url).');
}

/**
 * Render an avatar to a PNG via /api/avatar/render and return it base64-encoded.
 * Only works for avatars that have an id (server-side render needs the record).
 */
export async function renderImage(
	{ id, scene = 'portrait', size = 640, background = 'transparent', format = 'png' },
	env = process.env,
) {
	const base = baseUrl(env);
	const params = new URLSearchParams({
		avatar: id,
		scene,
		size: String(size),
		bg: background,
		format,
	});
	const url = `${base}/api/avatar/render?${params}`;
	const res = await fetchWithTimeout(url, { headers: { accept: `image/${format}` } });
	if (!res.ok) throw new ThreewsError(`Avatar render ${url} → HTTP ${res.status}`, { status: res.status });
	const buf = Buffer.from(await res.arrayBuffer());
	return { base64: buf.toString('base64'), mimeType: `image/${format}`, bytes: buf.length };
}

// Build the live, embeddable avatar URL (the page three.ws embeds like a video).
export function embedUrl({ id, handle, model, background = 'transparent', idle = true, overlay = false, animation }, env = process.env) {
	const base = baseUrl(env);
	const params = new URLSearchParams();
	if (id) params.set('id', id);
	else if (handle) params.set('handle', handle.replace(/^@/, ''));
	else if (model) params.set('model', model);
	params.set('bg', background);
	params.set('idle', idle ? 'on' : 'off');
	if (overlay) params.set('overlay', '1');
	if (animation) params.set('animation', animation);
	return `${base}/avatar-embed.html?${params}`;
}

// Build the standalone viewer URL (full-page interactive viewer).
export function viewerUrl({ model_url, camera = 'three-quarter', background = 'transparent', autoRotate = true }, env = process.env) {
	const base = baseUrl(env);
	const params = new URLSearchParams({
		src: model_url,
		camera,
		background,
		auto_rotate: autoRotate ? '1' : '0',
	});
	return `${base}/viewer?${params}`;
}

// A ready-to-paste iframe that embeds the live avatar anywhere — the
// "embed a 3D avatar as easily as a YouTube video" snippet.
export function iframeSnippet(embed, { width = '100%', height = 480 } = {}) {
	const h = typeof height === 'number' ? `${height}` : height;
	return (
		`<iframe src="${embed}" width="${width}" height="${h}" ` +
		`style="border:0;border-radius:16px;overflow:hidden" ` +
		`allow="camera; microphone; xr-spatial-tracking; fullscreen" allowfullscreen ` +
		`title="three.ws avatar"></iframe>`
	);
}

// Self-contained HTML that renders the GLB as an interactive <model-viewer>.
// Returned as an MCP text/html resource so capable clients show a live,
// rotatable 3D avatar inline.
export function modelViewerHtml({ model_url, name = 'Avatar', background = 'transparent', height = 480, cameraOrbit = '0deg 80deg 2m', autoRotate = true }) {
	const bg = background === 'transparent' ? 'transparent' : background;
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(name)}</title>
<script type="module" src="https://ajax.googleapis.com/ajax/libs/model-viewer/4.0.0/model-viewer.min.js"></script>
<style>
  html,body { margin:0; height:100%; background:${bg}; }
  model-viewer { width:100%; height:${Number(height)}px; --progress-bar-color:#6a5cff; }
</style>
</head><body>
<model-viewer
  src="${escapeHtml(model_url)}"
  alt="${escapeHtml(name)}"
  camera-controls
  ${autoRotate ? 'auto-rotate' : ''}
  shadow-intensity="1"
  exposure="1"
  tone-mapping="aces"
  camera-orbit="${escapeHtml(cameraOrbit)}"
  ar ar-modes="webxr scene-viewer quick-look"
></model-viewer>
</body></html>`;
}

function escapeHtml(s) {
	return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
