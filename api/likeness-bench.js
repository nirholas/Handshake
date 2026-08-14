// GET /api/likeness-bench - the data behind the /likeness-bench internal board.
//
// Sibling of /api/quality-bench, and gated where that one is not. The realism
// bench reads committed JSON files about fixed synthetic prompts, so it is safe
// to serve to anyone. This one reads measurements of avatars built from real
// users' faces, so it goes through the same authorizeOps gate as /api/ops/*:
// a signed-in platform admin, or OPS_SECRET, and in production nothing else.
//
// GET /api/likeness-bench            -> { distribution, recent, scorer }
// GET /api/likeness-bench?days=7     -> the same over a 7-day window
// GET /api/likeness-bench?limit=100  -> more rows in the recent table

import { cors, error, json, method, wrap } from './_lib/http.js';
import { authorizeOps } from './_lib/ops-auth.js';
import { likenessDistribution, likenessStoreEnabled, recentLikenessScores } from './_lib/likeness-store.js';
import { SCORER_VERSION, SFACE_SAME_IDENTITY_COSINE, LIKENESS_VIEWS } from './_lib/likeness-score.js';
import { MODELS } from './_lib/face-embed.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const auth = await authorizeOps(req);
	if (!auth.ok) {
		return error(res, 401, 'unauthorized', 'likeness scores are internal: sign in as a platform admin or present x-ops-secret');
	}

	if (!likenessStoreEnabled()) {
		return error(res, 503, 'store_unavailable', 'likeness scores need DATABASE_URL');
	}

	const url = new URL(req.url, 'http://x');
	const days = Number(url.searchParams.get('days')) || 30;
	const limit = Number(url.searchParams.get('limit')) || 25;

	const [distribution, recent] = await Promise.all([
		likenessDistribution({ days }),
		recentLikenessScores({ limit }),
	]);

	// The scorer block travels with the data on purpose: a number on this board
	// is meaningless without the instrument that produced it, and the most
	// likely future confusion is comparing scores taken by two different model
	// versions as if they were the same measurement.
	return json(res, 200, {
		scorer: {
			version: SCORER_VERSION,
			detectModel: MODELS.detect.id,
			detectLicense: MODELS.detect.license,
			embedModel: MODELS.embed.id,
			embedLicense: MODELS.embed.license,
			sameIdentityCosine: SFACE_SAME_IDENTITY_COSINE,
			views: LIKENESS_VIEWS,
		},
		distribution,
		recent,
	}, { 'cache-control': 'private, no-store' });
});
