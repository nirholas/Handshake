// /api/home/:id/log: what the platform actually did inside this house.
//
// This is the owner's record, not ours. It answers one question, "what did my
// agent do in my house, and what did it refuse to do", and it is the only place
// a refused unlock is visible. A refusal row matters more than a success row:
// it is the evidence that the gate fired when something asked to open a door.
//
// Read-only, session or bearer, newest first, cursor-paginated on the timestamp
// rather than an offset, because rows arrive while a person is reading and an
// offset would silently skip one.

import { publicHome, resolveHomeAccess } from '../../_lib/home/access.js';
import { HOME_ERR, homeError, homeFailure } from '../../_lib/home/errors.js';
import { listHomeActions } from '../../_lib/home/store.js';
import { cors, error, json, method, rateLimited, wrap } from '../../_lib/http.js';
import { limits } from '../../_lib/rate-limit.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const access = await resolveHomeAccess(req, res, req.query?.id);
	if (!access.ok) return error(res, access.status, access.code, access.message);

	const rl = await limits.homeRead(access.caller.userId);
	if (!rl.success) return rateLimited(res, rl, 'too many home reads, slow down');

	const url = new URL(req.url, 'http://x');

	const rawLimit = url.searchParams.get('limit');
	if (rawLimit != null && !/^\d{1,3}$/.test(rawLimit)) {
		return homeError(res, homeFailure(HOME_ERR.VALIDATION, 'limit must be a number.'));
	}
	const limit = Math.min(Number(rawLimit) || DEFAULT_LIMIT, MAX_LIMIT);

	const before = url.searchParams.get('before');
	if (before && !Number.isFinite(Date.parse(before))) {
		return homeError(res, homeFailure(HOME_ERR.VALIDATION, 'before must be an ISO 8601 timestamp.'));
	}

	const rows = await listHomeActions(access.home.id, { limit: limit + 1, before });
	const hasMore = rows.length > limit;
	const actions = hasMore ? rows.slice(0, limit) : rows;

	return json(res, 200, {
		home: publicHome(access.home),
		actions: actions.map(publicAction),
		// The cursor is the oldest row's timestamp, so the next page continues from
		// exactly where this one stopped even as new rows land at the top.
		next_before: hasMore ? isoOf(actions[actions.length - 1]?.created_at) : null,
	});
});

/**
 * `detail` is deliberately dropped from the list view. It is a small free-form
 * object written by the action path, and this endpoint renders straight into a
 * page: keeping it out means one less place for a house-controlled string to
 * reach a client that has no schema for it.
 */
function publicAction(row) {
	return {
		id: String(row.id),
		actor: row.actor,
		channel: row.channel,
		action: row.action,
		entity_ids: Array.isArray(row.entity_ids) ? row.entity_ids : [],
		guarded: Boolean(row.guarded),
		confirmed: Boolean(row.confirmed_by),
		risk: row.risk ?? null,
		outcome: row.outcome,
		created_at: isoOf(row.created_at),
	};
}

function isoOf(value) {
	if (!value) return null;
	const at = value instanceof Date ? value : new Date(value);
	return Number.isFinite(at.getTime()) ? at.toISOString() : null;
}
