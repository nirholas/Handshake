// Client helpers for the three.ws server-side render endpoints. The
// MCP doesn't ship a renderer itself — chromium is too heavy for an
// npm-installed local server. Instead we POST to three.ws's hosted
// headless-chromium pipeline (the same renderer that powers OG cards),
// stream the PNG back, and return it as a base64 data URL plus the
// upstream URL so callers can choose whichever they want.

import { THREE_WS_BASE } from '../config.js';

const DEFAULT_MAX_INLINE = 4 * 1024 * 1024;

async function postPng(path, body, { maxInlineBytes = DEFAULT_MAX_INLINE } = {}) {
	const url = `${THREE_WS_BASE}${path}`;
	const t0 = Date.now();
	const r = await fetch(url, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	});
	const durationMs = Date.now() - t0;
	if (!r.ok) {
		// Try to surface the JSON error envelope three.ws returns.
		let detail = null;
		try {
			detail = await r.json();
		} catch {
			detail = { error_description: await r.text().catch(() => '') };
		}
		return {
			ok: false,
			status: r.status,
			error: detail?.error || 'render_failed',
			message: detail?.error_description || `HTTP ${r.status}`,
			endpoint: url,
			durationMs,
		};
	}
	const buf = Buffer.from(await r.arrayBuffer());
	const meta = {
		width: Number(r.headers.get('x-render-width')) || null,
		height: Number(r.headers.get('x-render-height')) || null,
		background: r.headers.get('x-render-background') || null,
		pose: r.headers.get('x-render-pose') || null,
		poseLabel: r.headers.get('x-render-pose-label') || null,
	};
	const inline = buf.length <= maxInlineBytes;
	return {
		ok: true,
		status: r.status,
		endpoint: url,
		durationMs,
		sizeBytes: buf.length,
		mime: 'image/png',
		dataUrl: inline ? `data:image/png;base64,${buf.toString('base64')}` : null,
		omittedInline: !inline,
		meta,
	};
}

export async function renderGlbThumbnail({ glbUrl, width, height, background, maxInlineBytes }) {
	return postPng('/api/render/glb', { glbUrl, width, height, background }, { maxInlineBytes });
}

export async function renderAvatarClipRemote({ glbUrl, width, height, background, posePresetId, cameraOrbit, expression, maxInlineBytes }) {
	return postPng(
		'/api/render/avatar-clip',
		{ glbUrl, width, height, background, posePresetId, cameraOrbit, expression },
		{ maxInlineBytes },
	);
}

export async function fetchPoseCatalogRemote() {
	const r = await fetch(`${THREE_WS_BASE}/api/render/avatar-clip`, { method: 'GET' });
	if (!r.ok) throw new Error(`Pose catalog fetch failed: HTTP ${r.status}`);
	return r.json();
}
