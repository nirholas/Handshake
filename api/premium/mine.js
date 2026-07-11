// GET /api/premium/mine — the signed-in user's premium passes and keys.
//
// Session-cookie authed (the billing dashboard's data source). Returns passes
// purchased while signed in (user_id-linked) plus, when the account has a
// wallet_address that is a Solana key, passes bought by that wallet directly.

import { cors, json, wrap, method } from '../_lib/http.js';
import { sql } from '../_lib/db.js';
import { getSessionUser } from '../_lib/auth.js';
import { premiumPlan, PREMIUM_RESOURCES } from '../_lib/premium.js';

const SOLANA_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	let user;
	try {
		user = await getSessionUser(req);
	} catch {
		user = null;
	}
	if (!user) return json(res, 401, { error: 'unauthenticated' });

	const wallet = SOLANA_RE.test(user.wallet_address || '') ? user.wallet_address : null;
	const passes = await sql`
		select id, wallet, plan, asset, amount_atomics, usd_price, tx_signature,
		       api_subscription_id, started_at, expires_at, created_at
		from premium_passes
		where user_id = ${user.id} ${wallet ? sql`or wallet = ${wallet}` : sql``}
		order by created_at desc
		limit 50
	`;

	const subIds = [...new Set(passes.map((p) => p.api_subscription_id).filter(Boolean))];
	let keys = [];
	if (subIds.length) {
		keys = await sql`
			select s.id, s.name, s.key_prefix, s.rate_limit_per_minute, s.expires_at, s.revoked_at,
			       s.meta, u.granted, u.denied, u.last_seen
			from x402_subscriptions s
			left join lateral (
				select count(*) filter (where granted)     as granted,
				       count(*) filter (where not granted) as denied,
				       max(created_at)                     as last_seen
				from x402_access_log
				where caller_id = 'subscription:' || s.id
			) u on true
			where s.id = any(${subIds})
		`;
	}

	const now = Date.now();
	const active = passes.find((p) => new Date(p.expires_at).getTime() > now) || null;
	return json(
		res, 200,
		{
			plan: premiumPlan(),
			resources: PREMIUM_RESOURCES,
			active: active
				? { id: active.id, wallet: active.wallet, expires_at: active.expires_at, asset: active.asset }
				: null,
			passes,
			keys: keys.map((k) => ({
				id: k.id,
				name: k.name,
				key_prefix: k.key_prefix,
				rate_limit_per_minute: k.rate_limit_per_minute,
				expires_at: k.expires_at,
				status: k.revoked_at ? 'revoked' : 'active',
				wallet: k.meta?.wallet || null,
				usage: { granted: Number(k.granted || 0), denied: Number(k.denied || 0), last_seen: k.last_seen || null },
			})),
		},
		{ 'cache-control': 'no-store' },
	);
});
