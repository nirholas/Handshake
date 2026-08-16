// GET /api/seed/farcaster?handle=<fname-or-fid>
//
// Public Farcaster footprint connector for the three.ws memory-seeding demo.
// Resolves a user by fname or fid and returns their profile plus the casts
// worth remembering, which is what /api/seed/synthesize turns into a memory
// seed.
//
// Reads through api/_lib/farcaster-client.js so this endpoint inherits the
// platform's two-rung failover: Neynar when NEYNAR_API_KEY is configured
// (indexed data, so engagement is known), and otherwise a public Farcaster hub
// over HTTP with no key at all. The connector therefore returns real data on a
// deployment with zero social credentials instead of a "not configured" card.
//
// `lane` in the response names the rung that answered, and every field the hub
// lane cannot know (follower counts, per-cast engagement) is reported as null
// rather than a zero the UI would render as fact.

import { cors, json, method, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import {
	FarcasterError,
	fetchRecentCasts,
	resolveFarcasterUser,
} from '../_lib/farcaster-client.js';
import { selectSeedCasts } from '../_lib/farcaster-seed.js';

// Farcaster fnames: lowercase alphanumerics, hyphens, and (for ENS-backed
// names) dots. Anything else cannot resolve, so reject it before the network.
const FNAME_RE = /^[a-z0-9][a-z0-9.-]{0,47}$/;

// Pulled wide, then ranked down: selectSeedCasts drops link-only and duplicate
// posts, so a raw 20 would often leave far fewer than 20 usable casts.
const CAST_FETCH_LIMIT = 100;
const CAST_RETURN_LIMIT = 20;

/**
 * Shape the client's normalized casts into the connector's wire format.
 * Exported for tests: this is the only place the endpoint decides what a
 * caller sees, and the null-vs-number engagement contract matters to the UI.
 */
export function shapeCasts(casts, limit = CAST_RETURN_LIMIT) {
	return selectSeedCasts(casts, { limit, includeReplies: false }).map((cast) => ({
		text: cast.text,
		timestamp: Number.isFinite(cast.timestamp) ? new Date(cast.timestamp).toISOString() : null,
		engagement: typeof cast.engagement === 'number' ? cast.engagement : null,
	}));
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, 'http://x');
	const raw = (url.searchParams.get('handle') || '').trim().replace(/^@/, '').toLowerCase();
	if (!raw) return error(res, 400, 'invalid_request', 'handle query param required');

	const numeric = /^\d+$/.test(raw) ? Number(raw) : null;
	if (numeric != null && (!Number.isSafeInteger(numeric) || numeric <= 0))
		return error(res, 400, 'invalid_handle', 'fid must be a positive integer');
	if (numeric == null && !FNAME_RE.test(raw))
		return error(res, 400, 'invalid_handle', 'Farcaster name has invalid characters');

	let user;
	let casts = [];
	let castLane = null;
	try {
		user = await resolveFarcasterUser(numeric != null ? { fid: numeric } : { fname: raw });
		const recent = await fetchRecentCasts(user.fid, CAST_FETCH_LIMIT);
		casts = shapeCasts(recent.casts);
		castLane = recent.lane;
	} catch (err) {
		if (err instanceof FarcasterError) {
			if (err.status === 404)
				return error(res, 404, 'not_found', `no Farcaster user "${raw}"`);
			// The profile is the primary signal. A cast-page failure after the
			// user resolved still has a payload worth returning.
			if (!user) {
				console.warn('[seed/farcaster] lookup failed', err.message);
				res.setHeader('cache-control', 'no-store');
				return json(res, 200, {
					ok: false,
					reason: 'Farcaster upstream error',
					detail: err.message,
				});
			}
			console.warn('[seed/farcaster] casts fetch failed', err.message);
		} else {
			throw err;
		}
	}

	res.setHeader('cache-control', 'public, s-maxage=300, stale-while-revalidate=600');
	return json(res, 200, {
		ok: true,
		lane: castLane || user.lane,
		handle: user.fname || String(user.fid),
		fid: user.fid,
		display_name: user.displayName || null,
		avatar_url: user.pfpUrl || null,
		bio: user.bio || '',
		follower_count: Number.isFinite(user.followerCount) ? user.followerCount : null,
		following_count: Number.isFinite(user.followingCount) ? user.followingCount : null,
		recent_casts: casts,
	});
});
