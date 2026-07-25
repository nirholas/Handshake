// GET /api/forged: the public feed behind the /forged gallery: 3D props the
// platform's autonomous agents BOUGHT with real on-chain USDC via x402, plus
// the receipts that prove it.
//
// Every row is a real paid generation: an agent wallet paid /api/x402/forge
// (settled by the self-hosted facilitator on Solana mainnet), the Forge
// produced a GLB, and the prop landed in forge_autonomous_props carrying the
// payment provenance (payer wallet, price, settlement signature). There are no
// synthetic entries: if the agents haven't bought anything yet, the feed is
// honestly empty. Written by api/_lib/x402/pipelines/forge-content.js.
//
// Views:
//   GET /api/forged                      : recent renderable props (status done)
//   GET /api/forged?category=crate       : filter by prop family
//   GET /api/forged?status=all           : include queued/failed rows (audit view)
//   GET /api/forged?limit=60             : page size (max 100)
//
// Response: { props: [...], stats: { total, done, queued, spent_usdc,
//             categories: {...}, latest_ts } }
// Each prop: { id, ts, prompt, category, tier, status, glb_url, novelty,
//              cluster_id, price_usdc, payer, payer_short, tx_sig, explorer_url,
//              viewer_url }

import { sql, isDbUnavailableError } from './_lib/db.js';
import { cors, json, method, serverError, rateLimited } from './_lib/http.js';
import { limits, clientIp } from './_lib/rate-limit.js';
import { cacheGet, cacheSet } from './_lib/cache.js';
import { explorerTxUrl } from './_lib/avatar-wallet.js';

const FEED_TTL_S = 20;
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;
const CATEGORIES = new Set(['crate', 'barrel', 'furniture', 'terrain']);

function shortAddr(a) {
	if (!a || typeof a !== 'string') return null;
	return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

function toProp(row) {
	const priceUsdc = row.amount_atomic != null ? Number(row.amount_atomic) / 1e6 : null;
	return {
		id: Number(row.id),
		ts: row.ts,
		prompt: row.prompt,
		category: row.category,
		tier: row.tier,
		status: row.status,
		glb_url: row.glb_url,
		novelty: row.novelty != null ? Number(row.novelty) : null,
		cluster_id: row.cluster_id,
		price_usdc: priceUsdc,
		payer: row.payer,
		payer_short: shortAddr(row.payer),
		tx_sig: row.tx_sig,
		explorer_url: row.tx_sig ? explorerTxUrl(row.tx_sig) : null,
		viewer_url: row.glb_url ? `/app?src=${encodeURIComponent(row.glb_url)}` : null,
	};
}

export default async function handler(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, 'http://localhost');
	const category = url.searchParams.get('category');
	const includeAll = url.searchParams.get('status') === 'all';
	const limit = Math.min(
		MAX_LIMIT,
		Math.max(1, Number(url.searchParams.get('limit')) || DEFAULT_LIMIT),
	);
	if (category && !CATEGORIES.has(category)) {
		return json(res, 400, {
			error: 'invalid_category',
			error_description: `category must be one of: ${[...CATEGORIES].join(', ')}`,
		});
	}

	const cacheKey = `forged:feed:${category || 'all'}:${includeAll ? 'all' : 'done'}:${limit}`;
	const cached = await cacheGet(cacheKey);
	if (cached) {
		return json(res, 200, cached, { 'cache-control': `public, max-age=${FEED_TTL_S}` });
	}

	try {
		const rows = await sql`
			SELECT id, ts, prompt, category, tier, status, glb_url, novelty,
			       cluster_id, tx_sig, payer, amount_atomic
			FROM forge_autonomous_props
			WHERE (${includeAll} OR (status = 'done' AND glb_url IS NOT NULL))
			  AND (${category || null}::text IS NULL OR category = ${category || null})
			ORDER BY ts DESC
			LIMIT ${limit}
		`;
		const [stats] = await sql`
			SELECT count(*)::int AS total,
			       count(*) FILTER (WHERE status = 'done' AND glb_url IS NOT NULL)::int AS done,
			       count(*) FILTER (WHERE status = 'queued')::int AS queued,
			       coalesce(sum(amount_atomic), 0)::bigint AS spent_atomic,
			       max(ts) AS latest_ts
			FROM forge_autonomous_props
		`;
		const perCategory = await sql`
			SELECT category, count(*)::int AS c FROM forge_autonomous_props
			WHERE status = 'done' AND glb_url IS NOT NULL
			GROUP BY category
		`;

		const payload = {
			props: rows.map(toProp),
			stats: {
				total: stats?.total ?? 0,
				done: stats?.done ?? 0,
				queued: stats?.queued ?? 0,
				spent_usdc: Number(stats?.spent_atomic ?? 0) / 1e6,
				categories: Object.fromEntries(perCategory.map((r) => [r.category, r.c])),
				latest_ts: stats?.latest_ts ?? null,
			},
		};
		await cacheSet(cacheKey, payload, FEED_TTL_S);
		return json(res, 200, payload, { 'cache-control': `public, max-age=${FEED_TTL_S}` });
	} catch (err) {
		if (isDbUnavailableError(err)) {
			return json(res, 503, {
				error: 'db_unavailable',
				error_description: 'The gallery database is briefly unavailable. Retry shortly.',
			}, { 'cache-control': 'no-store', 'retry-after': '5' });
		}
		return serverError(res, 500, 'forged_feed_error', err);
	}
}
