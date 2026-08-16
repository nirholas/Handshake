/**
 * Creator marketplace leaderboards (roadmap prompt 09): the "make discovery
 * feel alive" surface for the /creations gallery.
 *
 *   GET /api/creations-leaderboard
 *     → { enabled, topRemixedAssets: [...], topCreators: [...] }
 *
 * Two REAL, queried rankings, no synthetic scores:
 *   - topRemixedAssets: the most-remixed published forge_creations, platform-
 *     wide, a live count of child derivatives (api/_lib/forge-store.js
 *     listMostRemixed). Same data the /creations gallery's "Trending" sort
 *     reads from api/remix-feed.js?action=trending; this endpoint additionally
 *     bundles the creator leaderboard in one round trip for the gallery page.
 *   - topCreators: agents ranked by how much OTHER creators built on their
 *     minted 3D work, a real count of tokenized_3d_assets rows naming one of
 *     theirs as parent_mint, plus the real on-chain USDC royalty earned
 *     (api/_lib/tokenized-launches.js queryTopCreators). This is the only
 *     creator surface with a public, on-chain identity (agent_identities +
 *     its ERC-8004 registration) to link a leaderboard entry to: the
 *     forge_creations client_key is intentionally anonymous.
 *
 * Free, public, cached briefly at the edge. $THREE-policy clean: no coin
 * amounts, USDC royalty figures only.
 */

import { cors, json, method, wrap, rateLimited } from './_lib/http.js';
import { limits, clientIp } from './_lib/rate-limit.js';
import { forgeStoreEnabled, listMostRemixed } from './_lib/forge-store.js';
import { queryTopCreators } from './_lib/tokenized-launches.js';
import { databaseConfigured } from './_lib/env.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	if (!databaseConfigured()) {
		return json(res, 200, { enabled: false, topRemixedAssets: [], topCreators: [] });
	}

	const url = new URL(req.url, 'http://localhost');
	const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 8, 1), 20);

	const [assets, creators] = await Promise.all([
		forgeStoreEnabled() ? listMostRemixed({ limit }) : Promise.resolve([]),
		queryTopCreators({ limit }),
	]);

	const topRemixedAssets = assets.map((a) => ({
		id: a.id,
		prompt: a.prompt,
		glbUrl: a.glb_url,
		previewImageUrl: a.preview_image_url ?? null,
		viewerUrl: `https://three.ws/viewer?src=${encodeURIComponent(a.glb_url)}`,
		royaltyPercent: Math.round((a.royaltyBps / 100) * 10) / 10,
		royaltyPayable: a.royaltyPayable,
		remixable: a.remixable,
		remixCount: a.remixCount,
		category: a.model_category,
		createdAt: a.created_at,
	}));

	return json(
		res,
		200,
		{ enabled: true, topRemixedAssets, topCreators: creators },
		{ 'cache-control': 'public, s-maxage=60, stale-while-revalidate=300' },
	);
});
