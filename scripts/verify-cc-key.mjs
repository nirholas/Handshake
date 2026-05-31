// Validate a CoinCommunities API key against the live API using the exact code
// path production uses (the @coin-communities/sdk node client + our cc() wiring).
// Prints the real TopCommunities shape so we can confirm toWorldCard maps it.
//   CC_API_KEY=cc_... node scripts/verify-cc-key.mjs
import { configureApi, api } from '@coin-communities/sdk/node';

const key = process.env.CC_API_KEY || '';
const baseUrl = (process.env.CC_BASE_URL || 'https://api.coin-communities.xyz').replace(/\/+$/, '');
if (!key) { console.error('CC_API_KEY not set'); process.exit(2); }

configureApi({ baseUrl, headers: { 'x-api-key': key } });

const { data, error } = await api.getTopCommunities();
if (error) {
	console.error('API ERROR:', error.message || error);
	process.exit(1);
}
const communities = data?.communities ?? [];
console.log(`baseUrl: ${baseUrl}`);
console.log(`top communities returned: ${communities.length}`);
const c = communities[0];
if (c) {
	// Show the exact upstream field names our toWorldCard() reads.
	console.log('first community (relevant fields):');
	console.log(JSON.stringify({
		tokenAddress: c.tokenAddress,
		tokenSymbol: c.tokenSymbol,
		tokenImageUrl: c.tokenImageUrl,
		tokenHighResImageUrl: c.tokenHighResImageUrl,
		chainId: c.chainId,
		memberCount: c.memberCount,
		postCount: c.postCount,
		totalLikes: c.totalLikes,
		latestPostAt: c.latestPostAt,
	}, null, 2));
	console.log('all keys on first community:', Object.keys(c).join(', '));
}
console.log(communities.length > 0 ? '\nKEY VALID — worlds available' : '\nKEY VALID — but zero communities returned');
process.exit(0);
