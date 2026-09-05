// The one place this CLI talks to three.ws.
//
// Everything goes through GET /api/catalog, the public asset catalog: no API
// key, no account, no payment. The base origin is overridable so the same CLI
// drives a local dev server (`--api http://localhost:3000`) or a preview
// deployment without a rebuild.

export const DEFAULT_API = 'https://three.ws';

/** Resolve the API origin from a flag, then the environment, then the default. */
export function resolveApi(flags = {}) {
	const raw = typeof flags.api === 'string' ? flags.api : process.env.THREE_WS_API;
	const origin = String(raw || DEFAULT_API).trim().replace(/\/+$/, '');
	if (!/^https?:\/\//.test(origin)) {
		throw new Error(`--api must be an http(s) origin, got "${origin}"`);
	}
	return origin;
}

// A network hiccup on a 15 KB JSON read is worth one retry; a 404 or a 400 is
// the caller's answer and is returned as-is for the command to explain.
async function getJson(url, { timeoutMs = 15_000, attempts = 2 } = {}) {
	let lastErr;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const res = await fetch(url, {
				headers: { accept: 'application/json' },
				signal: controller.signal,
			});
			const body = await res.json().catch(() => null);
			return { ok: res.ok, status: res.status, body };
		} catch (err) {
			lastErr = err;
		} finally {
			clearTimeout(timer);
		}
	}
	throw new Error(`could not reach the catalog: ${lastErr?.message || lastErr}`);
}

/** Search the catalog. Returns the parsed response body. */
export async function searchCatalog(origin, { q, kind, category, tag, limit, offset } = {}) {
	const url = new URL('/api/catalog', origin);
	if (q) url.searchParams.set('q', q);
	if (kind) url.searchParams.set('kind', kind);
	if (category) url.searchParams.set('category', category);
	if (tag) url.searchParams.set('tag', tag);
	if (limit) url.searchParams.set('limit', String(limit));
	if (offset) url.searchParams.set('offset', String(offset));
	const { ok, status, body } = await getJson(url.href);
	if (!ok) throw new Error(body?.message || `catalog search failed (HTTP ${status})`);
	return body;
}

/** One item plus its links, related items, and every source snippet. */
export async function fetchItem(origin, id) {
	const url = new URL('/api/catalog', origin);
	url.searchParams.set('id', id);
	const { ok, status, body } = await getJson(url.href);
	if (status === 404) {
		const err = new Error(`no catalog item with id "${id}"`);
		err.notFound = true;
		throw err;
	}
	if (!ok) throw new Error(body?.message || `catalog lookup failed (HTTP ${status})`);
	return body;
}

/**
 * Download one asset's bytes. Assets are served straight off the CDN with open
 * CORS, so this never proxies through the API.
 *
 * @returns {Promise<Buffer>}
 */
export async function downloadAsset(url, { timeoutMs = 120_000 } = {}) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(url, { signal: controller.signal });
		if (!res.ok) throw new Error(`download failed (HTTP ${res.status}) for ${url}`);
		return Buffer.from(await res.arrayBuffer());
	} catch (err) {
		if (err.name === 'AbortError') {
			throw new Error(`download timed out after ${timeoutMs}ms`, { cause: err });
		}
		throw err;
	} finally {
		clearTimeout(timer);
	}
}
