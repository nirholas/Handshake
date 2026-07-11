// POST /api/premium/keys — rotate or revoke the signed-in user's premium key.
//
// body: { action: 'rotate' | 'revoke', id: '<x402 subscription id>' }
//
// Session + CSRF authed. Only keys minted by a premium-pass purchase that is
// linked to this user (meta.source = 'premium-pass', meta.user_id = session
// user) can be managed here — partner/AWS keys live at
// /api/user/x402-subscriptions, and wallet-only purchases (no session at buy
// time) manage nothing here by design: the key follows the account that
// bought it.
//
// rotate returns the fresh plaintext exactly once and re-links the pass row
// so status/mine keep reporting the live key.

import { cors, json, error, wrap, method, readJson } from '../_lib/http.js';
import { sql } from '../_lib/db.js';
import { getSessionUser } from '../_lib/auth.js';
import { requireCsrf } from '../_lib/csrf.js';
import { createSubscription, revokeSubscription } from '../_lib/x402/api-keys.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	let user;
	try {
		user = await getSessionUser(req);
	} catch {
		user = null;
	}
	if (!user) return json(res, 401, { error: 'unauthenticated' });
	if (!(await requireCsrf(req, res, user.id))) return;

	const body = await readJson(req).catch(() => null);
	const action = String(body?.action || '');
	const id = String(body?.id || '').trim();
	if (!['rotate', 'revoke'].includes(action)) {
		return error(res, 400, 'bad_action', 'action must be rotate or revoke');
	}
	if (!id) return error(res, 400, 'bad_id', 'id is required');

	const [key] = await sql`
		select id, name, rate_limit_per_minute, expires_at, revoked_at, meta
		from x402_subscriptions
		where id = ${id}
		limit 1
	`;
	if (!key || key.meta?.source !== 'premium-pass' || key.meta?.user_id !== user.id) {
		return error(res, 404, 'key_not_found', 'no premium key with that id belongs to this account');
	}

	if (action === 'revoke') {
		await revokeSubscription(id);
		return json(res, 200, { revoked: true, id }, { 'cache-control': 'no-store' });
	}

	// rotate — revoke the old credential, mint a replacement with the same
	// expiry/limits/meta, and re-point the pass rows at the new key.
	if (key.revoked_at) return error(res, 409, 'key_revoked', 'key is revoked — buy or renew a pass to get a new one');
	await revokeSubscription(id);
	const fresh = await createSubscription({
		name: key.name,
		rateLimitPerMinute: key.rate_limit_per_minute,
		expiresAt: key.expires_at,
		meta: key.meta,
		createdBy: user.id,
	});
	await sql`
		update premium_passes set api_subscription_id = ${fresh.id}
		where api_subscription_id = ${id}
	`;
	return json(
		res, 200,
		{ rotated: true, id: fresh.id, key_prefix: fresh.key_prefix, api_key: fresh.token },
		{ 'cache-control': 'no-store' },
	);
});
