// Cached X (Twitter) profile lookup for the KOL tracker — follower count + avatar
// only. Uses the same twitter-api-v2 app-only bearer client as api/seed/x.js.
//
// Honest degradation: when TWITTER_BEARER_TOKEN is unset, or the lookup fails
// (rate limit, unknown handle), resolves to null. The tracker renders a wallet
// row with no follower count rather than a fabricated one.
//
// Cached for 15 minutes per handle — the free X API tier's rate limit is tight
// (75 user lookups / 15 min) and follower counts don't move fast enough to need
// fresher reads than that.

import { cacheGet, cacheSet } from '../../api/_lib/cache.js';

const CACHE_TTL_S = 900;
const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;

export async function fetchXProfile(handle) {
	const clean = String(handle || '').replace(/^@/, '');
	if (!HANDLE_RE.test(clean)) return null;

	const cacheKey = `kol:xprofile:${clean.toLowerCase()}`;
	const cached = await cacheGet(cacheKey).catch(() => null);
	if (cached) return cached;

	const bearer = process.env.TWITTER_BEARER_TOKEN;
	if (!bearer) return null;

	try {
		const { TwitterApi } = await import('twitter-api-v2');
		const client = new TwitterApi(bearer).readOnly;
		const res = await client.v2.userByUsername(clean, {
			'user.fields': ['public_metrics', 'profile_image_url', 'verified'],
		});
		const user = res?.data;
		if (!user) return null;
		const profile = {
			handle: user.username,
			name: user.name || null,
			avatarUrl: user.profile_image_url || null,
			verified: !!user.verified,
			followerCount: user.public_metrics?.followers_count ?? null,
		};
		await cacheSet(cacheKey, profile, CACHE_TTL_S).catch(() => {});
		return profile;
	} catch (err) {
		console.warn(`[kol/x-profile] lookup failed for @${clean}: ${err?.message || err}`);
		return null;
	}
}
