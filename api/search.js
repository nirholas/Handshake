// GET /api/search?q=<text>&type=<all|avatar|agent|model|world|coin>&limit=<n>
// ---------------------------------------------------------------------------
// The cross-entity discovery endpoint (prompts/user-value/05-discovery-search.md,
// wave 05). Every creation type on three.ws — avatars, on-chain/Solana agents,
// forged 3D models, saved worlds, and coins — had its own siloed browse
// surface (/discover, /gallery, /marketplace, /creations, /launches) with no
// single place to search "things like this" across all of them.
//
// Unify vs. federate: the underlying stores are genuinely heterogeneous —
// agents/avatars live in Postgres tables already served by api/explore.js,
// models in forge_creations, worlds in dioramas, and coins split between
// three.ws's own launch directory (pump_agent_mints, Postgres) and the wider
// pump.fun/Birdeye market (external HTTP APIs, no schema in common at all). A
// single SQL query spanning all five is not possible — two of the five
// sources aren't even in the same database. This endpoint FEDERATES: it fans
// out five independent, narrow queries in parallel (api/_lib/cross-search.js),
// normalizes each into one card shape, then merges and ranks server-side —
// so the CLIENT still only ever calls one endpoint and gets one ranked list,
// even though the backend fan-out is real. That's the honest middle ground:
// simpler than forcing a fake unified store, but not punting the merge to the
// browser either.
//
// Ranking: recency is the primary signal for every type except external
// (non-three.ws) coin matches, which have no verified timestamp. Real signals
// — follower count of a resolved creator profile (user_follows), remix count
// (forge_creations), view count (avatars/worlds) — nudge a result up by a
// capped amount; see rankItems() in cross-search.js for the exact formula. No
// signal is fabricated.
//
// Every avatar/agent/model/world/own-coin result carries a resolvable
// assetUrl (the live thing) and, whenever a creator is actually known, a
// creator.url (their three.ws profile). Where no platform profile exists
// (pure on-chain agent identities, anonymous model creations, external market
// coins) the creator field still points somewhere real (an explorer address,
// a lineage page, pump.fun) rather than being fabricated or omitted.
//
// Model results carry a `remix` block wired to the real, already-shipped paid
// remix flow (POST /api/x402/remix-asset) — the only type with a live remix
// rail today; other types don't get a fake Remix button.

import { cors, json, method, wrap, rateLimited } from './_lib/http.js';
import { limits, clientIp } from './_lib/rate-limit.js';
import { databaseConfigured } from './_lib/env.js';
import { forgeStoreEnabled } from './_lib/forge-store.js';
import { dioramaStoreEnabled } from './_lib/diorama-store.js';
import {
	searchAvatars,
	searchAgents,
	searchModels,
	searchWorlds,
	searchCoins,
	attachFollowerCounts,
	rankItems,
} from './_lib/cross-search.js';

const TYPES = new Set(['avatar', 'agent', 'model', 'world', 'coin']);

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, 'http://x');
	// Strip control characters before they reach an ILIKE query (same guard as
	// api/explore.js — a NUL byte throws invalid-UTF8 out of Postgres as an
	// unhandled 500 on a public endpoint).
	// eslint-disable-next-line no-control-regex
	const q = (url.searchParams.get('q') || '')
		.replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
		.trim()
		.slice(0, 80);
	const typeParam = (url.searchParams.get('type') || 'all').trim();
	const type = TYPES.has(typeParam) ? typeParam : 'all';
	const rawLimit = parseInt(url.searchParams.get('limit') || '18', 10);
	const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 4), 48) : 18;
	// Per-type fetch size: a mixed "all" query asks each source for a fraction
	// of the page so the merged, ranked result stays close to `limit` without
	// starving any one type; a scoped type search asks for the full limit.
	const perType = type === 'all' ? Math.max(6, Math.ceil(limit / 2)) : limit;

	const dbReady = databaseConfigured();
	if (!dbReady) {
		// Every source degrades to empty rather than throwing when storage isn't
		// configured (mirrors explore.js / forge-store.js / diorama-store.js) —
		// surface that as a designed "search is warming up" state, not a 500.
		return json(res, 200, { enabled: false, q, type, items: [] });
	}

	const wantsModels = forgeStoreEnabled() && (type === 'all' || type === 'model');
	const wantsWorlds = dioramaStoreEnabled() && (type === 'all' || type === 'world');

	const [avatarItems, agentItems, modelItems, worldItems, coinItems] = await Promise.all([
		type === 'all' || type === 'avatar' ? searchAvatars({ q: q || null, limit: perType }) : [],
		type === 'all' || type === 'agent' ? searchAgents({ q: q || null, limit: perType }) : [],
		wantsModels ? searchModels({ q: q || undefined, limit: perType }) : [],
		wantsWorlds ? searchWorlds({ q: q || undefined, limit: perType }) : [],
		// Coins require a query — there's no "browse all pump.fun tokens"
		// concept here (that's /launches / /trending's job), only search.
		q && (type === 'all' || type === 'coin') ? searchCoins({ q, limit: perType }) : [],
	]);

	let items = [...avatarItems, ...agentItems, ...modelItems, ...worldItems, ...coinItems];
	items = await attachFollowerCounts(items);
	items = rankItems(items).slice(0, limit);

	const counts = {
		avatar: avatarItems.length,
		agent: agentItems.length,
		model: modelItems.length,
		world: worldItems.length,
		coin: coinItems.length,
	};

	return json(
		res,
		200,
		{ enabled: true, q, type, items, counts, total: items.length },
		// Short public cache — search is near-real-time but not personalized, and
		// this endpoint fans out to 5 sources per miss, so a brief edge cache
		// meaningfully protects the DB + upstream market APIs from repeat keystrokes.
		{ 'cache-control': 'public, s-maxage=20, stale-while-revalidate=60' },
	);
});
