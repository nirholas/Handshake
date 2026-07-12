// @ts-check
// The single authorization gate for the ops dashboard surfaces (/admin/ops and
// its APIs: /api/ops/health, /api/admin/ops-alerts). One helper so both use
// identical, auditable rules — no drift, no weaker second door.
//
// These surfaces expose internal state: endpoint/cron topology, wallet
// addresses, tx signatures, key-rotation hints, and stack traces. So the gate
// is strict and FAILS CLOSED in production. Two ways in:
//
//   1. A signed-in platform admin — session + admin wallet (the requireAdmin
//      model: wallet ∈ ADMIN_ADDRESSES, the built-in owner address, or
//      is_admin in the DB). The strongest path and the only one that yields a
//      real per-user identity for audit trails.
//
//   2. A dedicated OPS_SECRET presented as `x-ops-secret` (or `Authorization:
//      Bearer`). This is intentionally NOT CRON_SECRET: the ops dashboard must
//      never share a credential with the crons that move real funds, so a
//      leaked ops password can't be escalated into triggering a payment job.
//      Store OPS_SECRET in Secret Manager, high-entropy.
//
// With neither present the request is denied in production; it is allowed only
// off-production (local dev, where no secret is configured) so the dashboard is
// usable without secrets on a developer's machine.

import { constantTimeEquals } from './crypto.js';
import { getSessionUser } from './auth.js';
import { isAdminUser } from './admin.js';

// Read process.env directly, not the `env` façade: OPS_SECRET has no getter on
// `env`, so `env.OPS_SECRET` is always undefined (the pre-existing bug that made
// the old `env.OPS_SECRET || env.CRON_SECRET` silently fall through to
// CRON_SECRET). Evaluated per-call so a test or a runtime env change is honoured.
function isProd() {
	return process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production';
}

/**
 * @param {import('http').IncomingMessage & { headers: Record<string,string|undefined> }} req
 * @returns {Promise<{ ok: boolean, actor: string }>} actor identifies who was
 *   authorized (admin wallet, `ops-secret`, or `dev`) for attribution.
 */
export async function authorizeOps(req) {
	// 1. Signed-in platform admin — preferred, carries a real identity.
	try {
		const user = await getSessionUser(req);
		if (user && (await isAdminUser(user))) {
			return { ok: true, actor: user.wallet_address || `user:${user.id}` };
		}
	} catch {
		/* no / invalid session — fall through to the secret path */
	}

	// 2. Dedicated OPS_SECRET. Never CRON_SECRET.
	const secret = process.env.OPS_SECRET;
	if (secret) {
		const header =
			req.headers['x-ops-secret'] ||
			(typeof req.headers['authorization'] === 'string'
				? req.headers['authorization'].replace(/^Bearer\s+/i, '')
				: '');
		if (header && constantTimeEquals(header, secret)) return { ok: true, actor: 'ops-secret' };
		return { ok: false, actor: '' };
	}

	// 3. No secret configured: dev-only open, production denies.
	return { ok: !isProd(), actor: 'dev' };
}
