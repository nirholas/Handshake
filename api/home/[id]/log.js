// GET /api/home/:id/log: what the platform did inside this house.
//
// This is not the general audit_log. It is higher volume, it carries the
// physical-action verdict, and an operator has to be able to answer "what did my
// agent do in my house last Tuesday" without a join across a shared table.
//
// Newest first, keyset-paginated on `created_at` rather than an offset: an offset
// page shifts under you when new rows land at the head, which for a log that is
// actively being written is every page. `?before=` takes the `created_at` of the
// last row you saw.
//
// Session only, no bearer. Reading the log is reading a record of when a person
// was home and which doors opened when, which is the most privacy-sensitive data
// this whole surface holds; an agent token that can act does not thereby get to
// read the history of everything that ever acted.

import { resolveHomeAccess } from '../../_lib/home/access.js';
import { listHomeActions } from '../../_lib/home/store.js';
import { cors, error, json, method, rateLimited, wrap } from '../../_lib/http.js';
import { limits } from '../../_lib/rate-limit.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const access = await resolveHomeAccess(req, res, req.query?.id, 'read');
	if (!access.ok) return error(res, access.status, access.code, access.message);
	const { caller, home } = access;

	if (caller.via !== 'session') {
		return error(res, 403, 'forbidden', 'The action log is readable from a signed-in session only.');
	}

	const rl = await limits.homeRead(caller.userId);
	if (!rl.success) return rateLimited(res, rl, 'too many home reads, slow down');

	const url = new URL(req.url, 'http://x');
	const limit = clamp(Number(url.searchParams.get('limit')) || DEFAULT_LIMIT, 1, MAX_LIMIT);

	const beforeRaw = url.searchParams.get('before');
	let before = null;
	if (beforeRaw) {
		const at = new Date(beforeRaw);
		if (Number.isNaN(at.getTime())) {
			return error(res, 400, 'validation_error', 'before must be an ISO timestamp from a previous page.');
		}
		before = at;
	}

	// One extra row answers "is there another page" without a second count query
	// over a table that only grows.
	const rows = await listHomeActions(home.id, { limit: limit + 1, before });
	const hasMore = rows.length > limit;
	const page = hasMore ? rows.slice(0, limit) : rows;

	return json(res, 200, {
		actions: page.map(shape),
		next_before: hasMore ? new Date(page[page.length - 1].created_at).toISOString() : null,
	});
});

function shape(row) {
	return {
		id: String(row.id),
		actor: row.actor,
		channel: row.channel,
		action: row.action,
		entity_ids: row.entity_ids || [],
		guarded: row.guarded,
		confirmed_by: row.confirmed_by,
		risk: row.risk,
		outcome: row.outcome,
		detail: row.detail ?? null,
		created_at: row.created_at,
	};
}

function clamp(value, min, max) {
	return Math.min(Math.max(Math.trunc(value) || min, min), max);
}
