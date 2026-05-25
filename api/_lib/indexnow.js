// IndexNow client — push fresh URLs to Bing / Yandex / Seznam / Naver the
// moment they exist so they're indexed in minutes instead of waiting for the
// next crawl. Free, no auth beyond the key file at /<key>.txt.
//
// Google does NOT participate in IndexNow (use Search Console's Indexing API
// for that — separate workflow), but Bing's share + Yandex coverage is real
// enough that this is worth the ~free API call.
//
// Usage:
//   import { pingIndexNow } from '../_lib/indexnow.js';
//   await pingIndexNow([`https://three.ws/agent/${agentId}`]);
//
// Fire-and-forget — IndexNow is best-effort and must never block the
// user-facing response that triggered it.

const KEY = '1a34d91143f6e085eedef0f9669c93be';
const HOST = 'three.ws';
const KEY_LOCATION = `https://${HOST}/${KEY}.txt`;

/**
 * Notify IndexNow of one or more URL changes.
 * @param {string|string[]} urls
 * @returns {Promise<{ok: boolean, status?: number, error?: string}>}
 */
export async function pingIndexNow(urls) {
	const list = Array.isArray(urls) ? urls : [urls];
	const filtered = list
		.filter(Boolean)
		.map((u) => String(u).trim())
		.filter((u) => u.startsWith(`https://${HOST}/`));

	if (filtered.length === 0) return { ok: false, error: 'no eligible urls' };

	try {
		const r = await fetch('https://api.indexnow.org/IndexNow', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				host: HOST,
				key: KEY,
				keyLocation: KEY_LOCATION,
				urlList: filtered,
			}),
			// IndexNow occasionally takes a beat; cap so we don't hang behind it.
			signal: AbortSignal.timeout(5_000),
		});
		// 200 = accepted, 202 = accepted but won't reprocess yet (rate limited).
		// Both are fine; we don't retry.
		return { ok: r.status === 200 || r.status === 202, status: r.status };
	} catch (err) {
		return { ok: false, error: err?.message || 'indexnow failed' };
	}
}
