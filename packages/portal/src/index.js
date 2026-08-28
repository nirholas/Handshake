// @three-ws/portal — any website as a walkable 3D world.
//
// Three things live here, and they are deliberately separable:
//
//   the layout       a pure function from a page's structure to a world
//                    (./layout.js). No network, no DOM, no three.js. It runs
//                    identically in a browser, in Node, in a worker, and on
//                    three.ws itself, which is why a shared link always opens
//                    the same city the sharer walked.
//   the client       thin wrappers over the public Portal API, which does the
//                    fetching, the robots.txt check and the caching for you.
//   the embed        one call that puts a live, walkable world in your page.
//
// Nothing here needs a key, an account, or a wallet.
//
//   import { fetchWorld, mountPortal } from '@three-ws/portal';
//   const { world } = await fetchWorld('example.com');
//   mountPortal(document.querySelector('#stage'), { url: 'example.com' });

export * from './layout.js';

/** The public Portal API. Point this at a self-hosted three.ws to use your own. */
export const PORTAL_API = 'https://three.ws/api/portal';
export const PORTAL_PAGE = 'https://three.ws/portal';

/** Everything the client throws, with the API's own machine-readable code. */
export class PortalError extends Error {
	constructor(code, message, status) {
		super(message);
		this.name = 'PortalError';
		this.code = code;
		this.status = status;
	}
}

function endpointFor(url, { endpoint = PORTAL_API, ...params } = {}) {
	const query = new URLSearchParams({ url: String(url || '') });
	for (const [k, v] of Object.entries(params)) {
		if (v !== undefined && v !== null && k !== 'fetch' && k !== 'signal') query.set(k, String(v));
	}
	return `${endpoint}?${query}`;
}

/**
 * Build (or read from cache) the world for a page.
 * @param {string} url any address: `example.com`, `https://example.com/docs`
 * @param {{ endpoint?: string, include?: 'world'|'outline'|'both', fetch?: typeof fetch, signal?: AbortSignal }} [opts]
 * @returns {Promise<{ world: object, outline?: object, cached: boolean, stale: boolean }>}
 */
export async function fetchWorld(url, opts = {}) {
	const impl = opts.fetch || globalThis.fetch;
	if (!impl) throw new PortalError('no_fetch', 'No fetch implementation available. Pass one as opts.fetch.', 0);
	const res = await impl(endpointFor(url, opts), {
		headers: { accept: 'application/json' },
		signal: opts.signal,
	});
	const body = await res.json().catch(() => null);
	if (!res.ok || !body?.world) {
		throw new PortalError(
			body?.error || `http_${res.status}`,
			body?.error_description || `Portal could not build a world from ${url}.`,
			res.status,
		);
	}
	return { world: body.world, outline: body.outline, cached: !!body.cached, stale: !!body.stale };
}

/**
 * The same world as a glTF binary, ready for Blender, Unity, AR, or any viewer.
 * @param {string} url
 * @param {{ endpoint?: string, fetch?: typeof fetch, signal?: AbortSignal }} [opts]
 * @returns {Promise<ArrayBuffer>}
 */
export async function fetchWorldGlb(url, opts = {}) {
	const impl = opts.fetch || globalThis.fetch;
	if (!impl) throw new PortalError('no_fetch', 'No fetch implementation available. Pass one as opts.fetch.', 0);
	const res = await impl(endpointFor(url, { ...opts, format: 'glb' }), { signal: opts.signal });
	if (!res.ok) {
		const body = await res.json().catch(() => null);
		throw new PortalError(body?.error || `http_${res.status}`, body?.error_description || 'Portal could not export that world.', res.status);
	}
	return res.arrayBuffer();
}

/** The iframe snippet that puts a walkable world on a page, as a string. */
export function embedSnippet(url, { height = 520, page = PORTAL_PAGE, title } = {}) {
	const src = `${page}?url=${encodeURIComponent(url)}&embed=1`;
	const label = title || `Walk ${url} in 3D`;
	return `<iframe src="${src}" width="100%" height="${height}" style="border:0;border-radius:14px" loading="lazy" title="${label}"></iframe>`;
}

/**
 * Mount a live, walkable world into an element.
 *
 * It embeds the hosted renderer rather than shipping a second copy of it: the
 * renderer is a WebGL app with an avatar, a clip library and a rig retargeter
 * behind it, and a stale duplicate of that inside an npm package would be worse
 * for everyone than an iframe that is always current.
 *
 * @param {Element} element where to mount
 * @param {{ url: string, height?: number|string, page?: string, title?: string }} opts
 * @returns {HTMLIFrameElement}
 */
export function mountPortal(element, { url, height = 520, page = PORTAL_PAGE, title } = {}) {
	if (!element || typeof element.append !== 'function') {
		throw new PortalError('bad_target', 'mountPortal needs an element to mount into.', 0);
	}
	if (!url) throw new PortalError('bad_url', 'mountPortal needs a url to explore.', 0);
	const doc = element.ownerDocument || globalThis.document;
	const frame = doc.createElement('iframe');
	frame.src = `${page}?url=${encodeURIComponent(url)}&embed=1`;
	frame.width = '100%';
	frame.height = String(height);
	frame.loading = 'lazy';
	frame.title = title || `Walk ${url} in 3D`;
	frame.style.border = '0';
	frame.style.borderRadius = '14px';
	frame.allow = 'fullscreen';
	element.append(frame);
	return frame;
}

/**
 * A compact, human-readable summary of a world: what the page turned into.
 * Used by the CLI and the MCP tool, and useful in any dashboard.
 * @param {object} world
 */
export function describeWorld(world) {
	const districts = world.buildings.map((b) => ({
		name: b.label,
		height: b.h,
		words: b.words,
		doors: world.doors.filter((d) => d.buildingId === b.id).length,
	}));
	return {
		host: world.meta.host,
		title: world.meta.title,
		sections: world.meta.sections,
		words: world.meta.words,
		doors: world.doors.length,
		internalDoors: world.doors.filter((d) => d.internal).length,
		billboards: world.props.filter((p) => p.kind === 'billboard').length,
		monoliths: world.props.filter((p) => p.kind === 'monolith').length,
		radius: world.ground.radius,
		palette: world.palette,
		tallest: districts.slice().sort((a, b) => b.height - a.height)[0] || null,
		districts,
	};
}
