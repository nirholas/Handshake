// GET /api/cron/companion-poll - the sweep that keeps every companion current.
//
// Polls the least recently checked sources across every account inside a
// wall-clock budget. Anything the budget does not reach keeps its old
// last_polled_at, so it sorts to the front of the next tick: a slow IMAP server
// can delay itself, never everyone else.

import { cors, json, method, wrapCron } from '../_lib/http.js';
import { requireCron } from '../_lib/cron-auth.js';
import { pollDue } from '../_lib/companion/poll.js';

export const maxDuration = 120;

const BATCH_LIMIT = Number(process.env.COMPANION_POLL_BATCH) || 40;
const TIME_BUDGET_MS = 100_000;

export default wrapCron(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;
	if (!requireCron(req, res)) return;

	const started = Date.now();
	const summary = await pollDue({ limit: BATCH_LIMIT, budgetMs: TIME_BUDGET_MS });
	return json(res, 200, { ok: true, ...summary, ms: Date.now() - started });
});
