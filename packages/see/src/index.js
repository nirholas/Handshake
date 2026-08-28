// @three-ws/see: give an AI agent eyes for 3D.
//
// Every text-to-3D API answers with a URL to a binary file. A human clicks it.
// An agent cannot: a .glb is opaque to a language model, so the agent that
// generated the asset has no way to check its own work. That is why agentic 3D
// has been stuck at one shot and a shrug.
//
// This package closes the loop in one call: hand it a GLB URL, get back frames
// of the model rendered from several angles, ready to put in front of any
// multimodal model, plus the geometry facts and a plain reading of them.
//
//   import { see } from '@three-ws/see';
//   const look = await see('https://example.com/robot.glb');
//   look.views;   // [{ view:'three-quarter', imageUrl, theta, phi }, ...]
//   look.notes;   // ['12,400 triangles, a normal real-time budget...']
//
// No key, no account. The service is free.

const DEFAULT_BASE = 'https://three.ws';
const DEFAULT_TIMEOUT_MS = 120_000;

/** Every camera angle the renderer understands. */
export const VIEWS = Object.freeze(['front', 'three-quarter', 'side', 'back', 'top', 'bottom']);

export class SeeError extends Error {
	constructor(message, { code = 'see_failed', status = null, retryAfter = null } = {}) {
		super(message);
		this.name = 'SeeError';
		this.code = code;
		this.status = status;
		this.retryAfter = retryAfter;
	}
}

/**
 * Render a 3D model from several angles.
 *
 * @param {string} glbUrl Public https URL of a .glb.
 * @param {object} [opts]
 * @param {string[]} [opts.views] Angles to render; defaults to three-quarter, front, side, back.
 * @param {number} [opts.size] Square frame size in pixels, 128 to 1024. Default 512.
 * @param {boolean} [opts.stats] Include geometry stats. Default true.
 * @param {string} [opts.baseUrl] Point at another deployment.
 * @param {number} [opts.timeoutMs] Abort after this long. Default 120s.
 * @param {typeof fetch} [opts.fetch] Inject a fetch (tests, proxies, tracing).
 * @returns {Promise<{modelUrl:string,size:number,views:Array<{view:string,theta:number,phi:number,imageUrl:string}>,missingViews:Array<{view:string,error:string}>,stats:object|null,notes:string[],viewerUrl:string,arUrl:string}>}
 */
export async function see(glbUrl, opts = {}) {
	const url = String(glbUrl || '').trim();
	if (!/^https:\/\//i.test(url)) {
		throw new SeeError('glbUrl must be a public https URL to a .glb file', { code: 'invalid_url' });
	}
	const base = String(opts.baseUrl || DEFAULT_BASE).replace(/\/$/, '');
	const doFetch = opts.fetch || globalThis.fetch;
	if (typeof doFetch !== 'function') {
		throw new SeeError('no fetch implementation available; pass opts.fetch', { code: 'no_fetch' });
	}

	const body = { glb_url: url };
	if (Array.isArray(opts.views) && opts.views.length) body.views = opts.views;
	if (opts.size != null) body.size = opts.size;
	if (opts.stats === false) body.stats = false;

	let res;
	try {
		res = await doFetch(`${base}/api/3d/look`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', accept: 'application/json' },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(Number(opts.timeoutMs) || DEFAULT_TIMEOUT_MS),
		});
	} catch (err) {
		const aborted = err?.name === 'TimeoutError' || err?.name === 'AbortError';
		throw new SeeError(aborted ? 'rendering timed out' : `could not reach ${base}: ${err?.message || err}`, {
			code: aborted ? 'timeout' : 'unreachable',
		});
	}

	const payload = await res.json().catch(() => ({}));
	if (!res.ok) {
		throw new SeeError(payload?.message || `look failed with HTTP ${res.status}`, {
			code: payload?.error || 'see_failed',
			status: res.status,
			retryAfter: payload?.retry_after ?? null,
		});
	}

	return {
		modelUrl: payload.model_url ?? url,
		size: payload.size ?? null,
		views: (payload.views || []).map((v) => ({ view: v.view, theta: v.theta, phi: v.phi, imageUrl: v.image_url })),
		missingViews: payload.missing_views || [],
		stats: payload.stats ?? null,
		notes: payload.notes || [],
		viewerUrl: payload.viewer_url ?? null,
		arUrl: payload.ar_url ?? null,
	};
}

/**
 * The same look, shaped as multimodal chat content: one text block naming each
 * angle followed by the image itself. Drop it straight into an Anthropic or
 * OpenAI message and the model sees the model.
 *
 * Images are referenced by URL rather than inlined, so this stays cheap to
 * build; `fetchImages: true` downloads and base64-encodes them for APIs that
 * will not fetch a URL themselves.
 *
 * @param {Awaited<ReturnType<see>>} look
 * @param {object} [opts]
 * @param {boolean} [opts.fetchImages] Inline the bytes as base64 instead of URLs.
 * @param {typeof fetch} [opts.fetch]
 */
export async function toMessageContent(look, opts = {}) {
	const doFetch = opts.fetch || globalThis.fetch;
	const content = [];
	if (look.notes?.length) content.push({ type: 'text', text: `Geometry: ${look.notes.join(' ')}` });
	for (const v of look.views || []) {
		content.push({ type: 'text', text: `View: ${v.view}` });
		if (opts.fetchImages) {
			const res = await doFetch(v.imageUrl);
			const buf = Buffer.from(await res.arrayBuffer());
			content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: buf.toString('base64') } });
		} else {
			content.push({ type: 'image', source: { type: 'url', url: v.imageUrl } });
		}
	}
	return content;
}
