// Recent public creations from the three.ws forge, read from the same feed the
// /forge gallery renders. Public, unauthenticated, read-only.

import { normalizeOrigin } from './studio.js';

/**
 * Normalise one gallery row into what the tree and the viewer need.
 * `web_glb_url` is the web-optimized copy (meshopt, smaller); prefer it and keep
 * the original as the download source when it is the only one present.
 */
export function normalizeCreation(row) {
	const glbUrl = row?.web_glb_url || row?.glb_url;
	if (typeof glbUrl !== 'string' || !/^https?:\/\//.test(glbUrl)) return null;
	return {
		id: String(row.id || ''),
		prompt: String(row.prompt || '').trim(),
		glbUrl,
		previewImageUrl: row.preview_image_url || null,
		category: row.model_category || null,
		tier: row.tier || null,
		backend: row.backend || null,
		createdAt: row.created_at || null,
	};
}

/**
 * List recent forge creations.
 * @param {string} origin
 * @param {{ limit?: number, signal?: AbortSignal }} [opts]
 * @returns {Promise<Array<ReturnType<typeof normalizeCreation>>>}
 */
export async function listCreations(origin, { limit = 40, signal } = {}) {
	const url = new URL('/api/forge-gallery', normalizeOrigin(origin));
	url.searchParams.set('limit', String(Math.min(Math.max(limit, 1), 100)));
	const controller = new AbortController();
	const onAbort = () => controller.abort();
	signal?.addEventListener('abort', onAbort, { once: true });
	const timer = setTimeout(() => controller.abort(), 20_000);
	let res;
	try {
		res = await fetch(url.href, {
			headers: { accept: 'application/json' },
			signal: controller.signal,
		});
	} catch (err) {
		throw new Error(`could not reach the forge gallery: ${err?.message || err}`);
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener('abort', onAbort);
	}
	if (!res.ok) throw new Error(`the forge gallery returned HTTP ${res.status}`);
	const body = await res.json().catch(() => null);
	if (body && body.enabled === false) {
		throw new Error('the forge gallery is turned off on this origin');
	}
	const rows = Array.isArray(body?.creations) ? body.creations : [];
	return rows.map(normalizeCreation).filter(Boolean);
}
