// GET /api/launcher/trends — public cultural-intelligence feed for the autonomous
// coin launcher (the "Memetic Launcher"). Built for AGENTS first: any agent can
// poll this to learn which narratives are rising across the internet right now —
// ranked, momentum-scored, and cross-source-confirmed — plus the coins three.ws
// has autonomously launched on those waves. Real signal only; no auth required.
//
//   GET /api/launcher/trends                    → ranked narratives + recent launches
//   GET /api/launcher/trends?network=devnet     → devnet view
//   GET /api/launcher/trends?limit=30           → up to 50 narrative terms
//   GET /api/launcher/trends?launches=0         → narratives only (skip the launch feed)
//   GET /api/launcher/trends?sources=knowyourmeme,googletrends
//                                               → restrict to specific providers
//                                                 (subset of PROVIDER_IDS; empty ⇒ defaults)
//
// Themes only — never a specific non-$THREE ticker recommendation. The terms are
// cultural currents (memes, topics), and the launches are three.ws's own runtime
// launch records. Cached 60s so a swarm of agents can poll without load.

import { sql } from '../_lib/db.js';
import { cors, json, method, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { cacheGet, cacheSet } from '../_lib/cache.js';
import { rankNarratives, PROVIDER_IDS } from '../_lib/launcher-trends.js';

const TTL_S = 60;
const PROVIDER_SET = new Set(PROVIDER_IDS);

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const params = new URL(req.url, 'http://x').searchParams;
	const network = params.get('network') === 'devnet' ? 'devnet' : 'mainnet';
	const limit = clampInt(params.get('limit'), 20, 1, 50);
	const wantLaunches = params.get('launches') !== '0' && params.get('launches') !== 'false';
	// Optional source filter — only real providers, sorted for a stable cache key.
	const sources = (params.get('sources') || '')
		.split(',')
		.map((s) => s.trim().toLowerCase())
		.filter((s) => PROVIDER_SET.has(s))
		.sort();

	const cacheKey = `launcher:trends:${network}:${limit}:${wantLaunches ? 1 : 0}:${sources.join('+') || 'default'}`;
	const cached = await cacheGet(cacheKey).catch(() => null);
	if (cached) {
		return json(res, 200, cached, { 'cache-control': 'public, max-age=30, s-maxage=60' });
	}

	const [ranked, launches] = await Promise.all([
		rankNarratives({ network, limit, sources: sources.length ? sources : undefined }).catch(() => null),
		wantLaunches ? recentLaunches(network).catch(() => []) : Promise.resolve([]),
	]);

	const terms = (ranked?.terms || []).slice(0, limit).map((t) => ({
		term: t.term,
		score: round(t.score, 4),
		momentum: t.sources?.length || 0,
		sources: t.sources || [],
		kind: t.kind || null,
	}));

	const body = {
		network,
		generated_at: new Date().toISOString(),
		narratives: {
			top: terms[0] || null,
			count: terms.length,
			providers: ranked?.providers || [],
			terms,
		},
		launches,
		// A small honest note so consumers understand the contract.
		about: 'Ranked cultural narratives the autonomous launcher rides, plus three.ws launches on those waves. Themes, not ticker calls.',
	};

	// Only cache a response that actually carries signal. A ranking failure or an
	// empty provider sweep must not be frozen for a minute and served to every
	// polling agent as if it were the real state of the world.
	if (terms.length) await cacheSet(cacheKey, body, TTL_S).catch(() => {});
	return json(res, 200, body, { 'cache-control': 'public, max-age=30, s-maxage=60' });
});

// Recent autonomous launches (confirmed on-chain) from the global launcher, newest
// first — the real coins minted on the trending waves. Empty when the table is
// absent or the launcher has not run.
async function recentLaunches(network) {
	const rows = await sql`
		select name, symbol, mint, kind, trigger_source, trigger_detail, created_at
		from launcher_runs
		where scope = 'global' and network = ${network}
		  and status in ('launched', 'confirmed') and mint is not null
		order by created_at desc
		limit 20
	`;
	return rows.map((r) => ({
		name: r.name,
		symbol: r.symbol,
		mint: r.mint,
		kind: r.kind,
		rode: topNarrative(r.trigger_detail) || r.trigger_source || null,
		created_at: r.created_at,
	}));
}

// trigger_detail is jsonb; depending on the driver it arrives as an object or as
// the raw JSON string. Read both so the narrative a coin rode never silently
// degrades to the bare provider id.
function topNarrative(detail) {
	let d = detail;
	if (typeof d === 'string') { try { d = JSON.parse(d); } catch { return null; } }
	return d && typeof d === 'object' ? d.top_narrative || null : null;
}

function clampInt(v, dflt, lo, hi) {
	if (v == null || v === '') return dflt; // absent param → default (Number(null) is 0, not NaN)
	const n = Math.floor(Number(v));
	if (!Number.isFinite(n)) return dflt;
	return Math.min(hi, Math.max(lo, n));
}
function round(n, d) { const p = 10 ** d; return Math.round(Number(n) * p) / p; }
