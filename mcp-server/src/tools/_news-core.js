// Shared plumbing for the FREE crypto-news MCP tools (`crypto_news`,
// `crypto_news_digest`, `crypto_news_archive`). All three read the public
// three.ws news APIs — the same endpoints behind /markets/news, /markets/digest,
// and /markets/archive — which are key-less and CORS-open, so the tools need
// no payment, wallet, or credential.
//
// Environment (optional):
//   NEWS_API_BASE — three.ws origin override for self-hosted/staging installs.
//                   Default https://three.ws

import { toolError } from './_shared.js';

export const NEWS_API_BASE = (process.env.NEWS_API_BASE || 'https://three.ws').replace(/\/$/, '');

/**
 * GET a three.ws news API path and return parsed JSON, or a `toolError`
 * envelope the caller returns as-is. Upstream 4xx bodies carry
 * `{ error, message }` (e.g. bad_category with the valid list) — surface them
 * verbatim so the model can self-correct instead of guessing.
 */
export async function newsApiGet(path, params, { timeoutMs = 30_000 } = {}) {
	const qs = new URLSearchParams();
	for (const [k, v] of Object.entries(params || {})) {
		if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
	}
	const url = `${NEWS_API_BASE}${path}${qs.size ? `?${qs}` : ''}`;
	let resp;
	try {
		resp = await fetch(url, {
			headers: { accept: 'application/json', 'user-agent': 'three.ws-mcp-news/1.0' },
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (err) {
		return toolError('news_api_unreachable', `three.ws news API unreachable: ${err.message}`, { url });
	}
	const body = await resp.json().catch(() => null);
	if (!resp.ok) {
		return toolError(
			body?.error || `http_${resp.status}`,
			body?.message || `three.ws news API responded ${resp.status}`,
			// pass through any self-correction hints (valid categories, etc.)
			body && typeof body === 'object' ? { upstream: body } : undefined,
		);
	}
	if (!body || typeof body !== 'object') {
		return toolError('bad_upstream_payload', 'three.ws news API returned a non-JSON payload');
	}
	return body;
}

/** Slim a live/archive article for tool output — links intact, bytes bounded. */
export function slimArticle(a) {
	return {
		title: a.title,
		link: a.link,
		source: a.source,
		category: a.category,
		published: a.pub_date,
		description: a.description || undefined,
		tickers: a.tickers?.length ? a.tickers : undefined,
		sentiment: a.sentiment?.label,
		lang: a.lang,
	};
}
