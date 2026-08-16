// POST /api/social/sentiment-pulse
//
// One-call sentiment pulse for a Solana token. Pulls the coin's live
// community commentary from pump.fun and scores it with the in-repo lexicon
// scorer. Optionally accepts a list of additional text snippets to fold into
// the score (e.g. X posts the caller has already collected).
//
// Source note: pump.fun retired the `/replies/:mint` comments route this
// endpoint used to read (it now 404s for every mint, including $THREE), so
// the pulse silently scored an empty set and reported a confident neutral
// reading. Coin commentary lives in "callouts" now, the feed the coin page
// renders via frontend-api-v3 `/callout/top/:mint`, where each entry carries
// the poster's thesis, handle and timestamp. That is the source below, read
// through the shared pump.fun fetch helper (identified user-agent, bounded
// timeout, one retry on a rate limit or 5xx).
//
// This is the unauthenticated, no-key endpoint behind the paid
// `sentiment_pulse` MCP tool. It does no caching of its own (callers should
// hit /api/social/sentiment if they already have the texts).
//
// Body:
//   {
//     token:           string,           // Solana SPL or pump.fun mint pubkey
//     limit?:          number,           // max callouts to score (default 100, max 200)
//     extraTexts?:     string[],         // additional snippets to score
//   }
//
// Response:
//   {
//     ok: true,
//     token,
//     overall: { score, posPct, negPct, neuPct, count, examples },
//     breakdown: { pumpfun: <result>, extra: <result> },
//     sources: { pumpfun: 'https://...', pumpfunStatus, pumpfunCount, extraCount },
//     fetchedAt
//   }
//
// A pump.fun outage with no caller-supplied texts answers 502
// `upstream_unavailable`, never a fabricated neutral score. A coin that is
// simply quiet (upstream fine, zero callouts) still answers 200 with
// `count: 0`, because an empty feed is data, not an outage.

import { z } from 'zod';
import { cors, error, json, method, readJson, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { PUMP_FRONTEND_BASE, pumpFetchJson } from '../_lib/pump-feed-fetch.js';

const SOLANA_MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const FETCH_TIMEOUT_MS = 8000;

const bodySchema = z.object({
	token: z.string().regex(SOLANA_MINT_RE, 'token must be a base58 Solana mint pubkey'),
	limit: z.number().int().min(1).max(200).optional(),
	extraTexts: z.array(z.string().max(2000)).max(200).optional(),
});

/**
 * Map raw pump.fun callout rows into the scorer's post shape, newest first.
 * Rows with no thesis carry no sentiment and are dropped rather than counted
 * as neutral, which would drag every score toward zero.
 *
 * @param {any[]} callouts
 * @param {number} limit
 * @returns {Array<{ id?: string, ts?: string, text: string, author?: string }>}
 */
export function calloutsToPosts(callouts, limit) {
	if (!Array.isArray(callouts)) return [];
	return callouts
		.map((c) => {
			const at = Number(c?.createdAt);
			const ms = Number.isFinite(at) && at > 0 ? at : null;
			return {
				id: c?.calloutId ? String(c.calloutId) : undefined,
				ts: ms ? new Date(ms).toISOString() : undefined,
				text: String(c?.thesis || '').trim().slice(0, 2000),
				author: c?.username ? String(c.username) : undefined,
				_at: ms ?? 0,
			};
		})
		.filter((p) => p.text)
		.sort((a, b) => b._at - a._at)
		.slice(0, limit)
		.map(({ _at, ...post }) => post);
}

/**
 * Fetch a coin's most recent pump.fun callouts. Never throws: an upstream
 * failure is reported as `{ error, url }` for the handler to surface.
 */
async function fetchPumpFunCallouts(mint, limit) {
	const url =
		`${PUMP_FRONTEND_BASE}/callout/top/${encodeURIComponent(mint)}` +
		`?limit=${limit}&sortBy=TIMESTAMP&sortOrder=DESC`;
	const { ok, status, body } = await pumpFetchJson(url, { timeoutMs: FETCH_TIMEOUT_MS });
	if (!ok) {
		return { error: status ? `pump.fun returned ${status}` : 'pump.fun unreachable', url };
	}
	const rows = Array.isArray(body?.callouts) ? body.callouts : Array.isArray(body) ? body : [];
	return { posts: calloutsToPosts(rows, limit), url };
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: false })) return;
	if (!method(req, res, ['POST'])) return;

	const rl = await limits.mcpIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	let raw;
	try {
		raw = await readJson(req);
	} catch {
		return error(res, 400, 'validation_error', 'invalid json');
	}
	const parsed = bodySchema.safeParse(raw);
	if (!parsed.success) {
		return error(res, 400, 'validation_error', parsed.error.issues[0]?.message ?? 'invalid body');
	}
	const { token, limit = 100, extraTexts = [] } = parsed.data;

	const { scoreSentiment } = await import('../../src/social/sentiment.js');

	const pumpfun = await fetchPumpFunCallouts(token, limit);
	const pumpfunPosts = pumpfun.error ? [] : pumpfun.posts;
	const extraPosts = extraTexts
		.map((t, i) => ({ id: `extra-${i}`, text: String(t).trim() }))
		.filter((p) => p.text);

	// With the only live source down and nothing supplied by the caller there
	// is nothing to score. Scoring the empty set would answer "neutral, 100%"
	// with the same confidence as a real reading, so report the outage.
	if (pumpfun.error && extraPosts.length === 0) {
		return error(res, 502, 'upstream_unavailable', pumpfun.error, {
			token,
			source: 'pump.fun',
		});
	}

	const all = [...pumpfunPosts, ...extraPosts];
	const overall = scoreSentiment(all);
	const breakdown = {
		pumpfun: pumpfun.error ? { error: pumpfun.error, count: 0 } : scoreSentiment(pumpfunPosts),
		extra: scoreSentiment(extraPosts),
	};

	return json(res, 200, {
		ok: true,
		token,
		overall,
		breakdown,
		sources: {
			pumpfun: pumpfun.error ? null : pumpfun.url,
			pumpfunStatus: pumpfun.error ? 'unavailable' : 'ok',
			pumpfunCount: pumpfunPosts.length,
			extraCount: extraPosts.length,
		},
		fetchedAt: new Date().toISOString(),
	});
});
