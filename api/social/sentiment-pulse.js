// POST /api/social/sentiment-pulse
//
// One-call sentiment pulse for a Solana token. Pulls recent commentary
// from pump.fun's frontend-api-v3 comments endpoint (the same source the
// pump.fun coin page renders) and scores it with the in-repo lexicon
// scorer. Optionally accepts a list of additional text snippets to fold
// into the score (e.g. X posts the caller has already collected).
//
// This is the unauthenticated, no-key endpoint behind the paid
// `sentiment_pulse` MCP tool — it does no caching of its own (callers
// should hit /api/social/sentiment if they already have the texts).
//
// Body:
//   {
//     token:           string,           // Solana SPL or pump.fun mint pubkey
//     limit?:          number,           // max comments to fetch (default 100, max 200)
//     extraTexts?:     string[],         // additional snippets to score
//   }
//
// Response:
//   {
//     ok: true,
//     token,
//     overall: { score, posPct, negPct, neuPct, count, examples },
//     breakdown: { pumpfun: <result>, extra: <result> },
//     sources: { pumpfun: 'https://...', extra: <n> },
//     fetchedAt
//   }

import { z } from 'zod';
import { cors, error, json, method, readJson, wrap } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';

const PUMPFUN_BASE = 'https://frontend-api-v3.pump.fun';
const SOLANA_MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const bodySchema = z.object({
	token: z.string().regex(SOLANA_MINT_RE, 'token must be a base58 Solana mint pubkey'),
	limit: z.number().int().min(1).max(200).optional(),
	extraTexts: z.array(z.string().max(2000)).max(200).optional(),
});

async function fetchPumpFunComments(mint, limit) {
	// frontend-api-v3 returns the most recent comments first. The endpoint
	// supports limit + offset; we just take the most recent batch.
	const url = `${PUMPFUN_BASE}/replies/${mint}?limit=${limit}&offset=0`;
	let res;
	try {
		const controller = new AbortController();
		const t = setTimeout(() => controller.abort(), 8000);
		try {
			res = await fetch(url, { signal: controller.signal });
		} finally {
			clearTimeout(t);
		}
	} catch (err) {
		return { error: err?.message || 'fetch failed', url };
	}
	if (!res.ok) return { error: `pump.fun returned ${res.status}`, url };
	const data = await res.json().catch(() => null);
	if (!data) return { error: 'invalid json from pump.fun', url };
	const replies = Array.isArray(data?.replies) ? data.replies : Array.isArray(data) ? data : [];
	const posts = replies
		.map((r) => ({
			id: r.id || r.signature || undefined,
			ts: r.timestamp ? new Date(r.timestamp).toISOString() : undefined,
			text: String(r.text || r.message || '').slice(0, 2000),
			author: r.user || r.username || undefined,
		}))
		.filter((p) => p.text);
	return { posts, url };
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: false })) return;
	if (!method(req, res, ['POST'])) return;

	const rl = await limits.mcpIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	let raw;
	try {
		raw = await readJson(req);
	} catch {
		return error(res, 400, 'invalid_json', 'invalid json');
	}
	const parsed = bodySchema.safeParse(raw);
	if (!parsed.success) {
		return error(res, 400, 'validation_error', parsed.error.issues[0]?.message ?? 'invalid body');
	}
	const { token, limit = 100, extraTexts = [] } = parsed.data;

	const { scoreSentiment } = await import('../../src/social/sentiment.js');

	const pumpfun = await fetchPumpFunComments(token, limit);
	const pumpfunPosts = pumpfun.error ? [] : pumpfun.posts;
	const extraPosts = extraTexts.map((t, i) => ({ id: `extra-${i}`, text: t }));

	const all = [...pumpfunPosts, ...extraPosts];
	const overall = scoreSentiment(all);
	const breakdown = {
		pumpfun: pumpfun.error
			? { error: pumpfun.error, count: 0 }
			: scoreSentiment(pumpfunPosts),
		extra: scoreSentiment(extraPosts),
	};

	return json(res, 200, {
		ok: true,
		token,
		overall,
		breakdown,
		sources: {
			pumpfun: pumpfun.error ? null : pumpfun.url,
			pumpfunCount: pumpfunPosts.length,
			extraCount: extraPosts.length,
		},
		fetchedAt: new Date().toISOString(),
	});
});
