// GET    /api/home/privacy            → what we hold about your homes, in plain language
// GET    /api/home/privacy?export=1   → all of it, as JSON
// PATCH  /api/home/privacy            → { homeId, retentionDays, reason? }  set the action-log window
// DELETE /api/home/privacy            → { scope: 'home' | 'all', homeId? }  forget it
//
// The Home lane's privacy centre, built on the same shape as /api/irl/privacy:
// see it, control it, export it, delete it, without a support ticket. The
// platform has no account-wide export or deletion endpoint yet, so this lane
// carries its own rather than promising one; the module underneath
// (api/_lib/home/privacy.js) exposes `deleteAllHomeDataForUser` as the function
// a platform-wide path calls when it lands.
//
// Two things this endpoint deliberately does not do:
//
//   * It never returns a home's access token, in any form, including in the
//     export. A key to somebody's front door does not belong in a file that
//     lands in a downloads folder. The export carries the token's fingerprint,
//     which proves which token is stored without being usable.
//   * It never renders a room, device or scene name, because none is stored.
//     If a future reader finds one here, the promise in docs/home-privacy.md has
//     been broken somewhere upstream and this endpoint is where it shows.
//
// Deletion here is the real thing, not the soft revoke. `POST /api/home/:id`'s
// disconnect scrubs the credential and keeps the row so the owner's action log
// keeps its lineage; this removes the row and everything pointing at it.

import { getSessionUser } from '../_lib/auth.js';
import { requireCsrf } from '../_lib/csrf.js';
import { cors, error, json, method, rateLimited, readJson, wrap } from '../_lib/http.js';
import { limits } from '../_lib/rate-limit.js';
import {
	DEFAULT_ACTION_LOG_RETENTION_DAYS,
	MAX_ACTION_LOG_RETENTION_DAYS,
	MIN_ACTION_LOG_RETENTION_DAYS,
	deleteAllHomeDataForUser,
	deleteHome,
	exportHomeData,
	setActionLogRetention,
	summarizeHomeData,
} from '../_lib/home/privacy.js';
import { DISCLOSURES } from '../_lib/home/disclosure.js';

const SCOPES = new Set(['home', 'all']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,PATCH,DELETE,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'PATCH', 'DELETE'])) return;

	// Every row this endpoint touches is keyed to an account. There is no
	// anonymous arm, unlike /api/irl/privacy: a home belongs to a signed-in owner
	// and to nobody else.
	const session = await getSessionUser(req);
	if (!session) return error(res, 401, 'unauthorized', 'sign in required');

	if (req.method === 'GET') {
		const wantsExport = req.query?.export === '1' || req.query?.export === 'true';
		// The summary is a page load; the export assembles every home, grant and
		// action-log row this account has. They do not belong in the same bucket.
		const rl = await (wantsExport ? limits.homePrivacy(session.id) : limits.homeRead(session.id));
		if (!rl.success) {
			return rateLimited(res, rl, wantsExport ? 'too many exports, try again shortly' : 'too many reads, slow down');
		}
		if (wantsExport) {
			const data = await exportHomeData(session.id);
			// A download, not a page: the browser saves it under a name the user
			// will recognise a year from now.
			return json(res, 200, data, {
				'Content-Disposition': `attachment; filename="three-ws-home-data-${new Date().toISOString().slice(0, 10)}.json"`,
			});
		}
		const summary = await summarizeHomeData(session.id, session.email ?? null);
		return json(res, 200, { ...summary, disclosures: DISCLOSURES });
	}

	// Both write verbs change privacy-relevant state from a cookie session, so
	// both carry the same CSRF requirement as the other session-auth writers.
	if (!(await requireCsrf(req, res, session.id))) return;

	// Both write verbs change or destroy data that cannot be regenerated, so both
	// are held to the tight bucket rather than the read one.
	const writeLimit = await limits.homePrivacy(session.id);
	if (!writeLimit.success) return rateLimited(res, writeLimit, 'too many privacy changes, try again shortly');

	const body = (await readJson(req)) ?? {};

	if (req.method === 'PATCH') {
		const homeId = String(body.homeId ?? '');
		if (!UUID_RE.test(homeId)) return error(res, 400, 'bad_home_id', 'homeId must be a home you own');

		const result = await setActionLogRetention({
			homeId,
			userId: session.id,
			days: body.retentionDays,
			reason: body.reason ?? null,
		});

		if (result.ok) return json(res, 200, result);
		if (result.code === 'not_found') return error(res, 404, 'not_found', 'no such home');
		if (result.code === 'retention_over_plan') {
			return error(
				res,
				402,
				'retention_over_plan',
				`Your plan keeps the action log for up to ${result.limit} days and you asked for ${result.requested}. ` +
					'Upgrade at three.ws/pricing to keep it longer. Nothing already recorded is affected: a plan never shortens a log you have already kept.',
				{ code: 'retention_over_plan', quota: { dimension: 'logRetentionDays', limit: result.limit, requested: result.requested, upgrade: '/pricing' } },
			);
		}
		if (result.code === 'reason_required') {
			return error(
				res,
				400,
				'reason_required',
				`Keeping the action log longer than ${DEFAULT_ACTION_LOG_RETENTION_DAYS} days needs a written reason.`,
			);
		}
		return error(
			res,
			400,
			'bad_retention_days',
			`retentionDays must be between ${MIN_ACTION_LOG_RETENTION_DAYS} and ${MAX_ACTION_LOG_RETENTION_DAYS}.`,
		);
	}

	// DELETE
	const scope = String(body.scope ?? '');
	if (!SCOPES.has(scope)) return error(res, 400, 'bad_scope', "scope must be 'home' or 'all'");

	if (scope === 'home') {
		const homeId = String(body.homeId ?? '');
		if (!UUID_RE.test(homeId)) return error(res, 400, 'bad_home_id', 'homeId must be a home you own');
		const result = await deleteHome(homeId, session.id);
		// A home that is not yours and a home that never existed answer
		// identically, so this cannot be used to test whether an id exists.
		if (!result.deleted) return error(res, 404, 'not_found', 'no such home');
		return json(res, 200, { deleted: true, ...result });
	}

	const result = await deleteAllHomeDataForUser(session.id, { email: session.email ?? null });
	return json(res, 200, { deleted: true, ...result });
});
