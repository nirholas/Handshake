/**
 * POST /api/feedback/report - what a visitor told the corner companion.
 *
 *   { body, transport?, route?, page_title?, build_sha?, viewport?, locale?,
 *     console_errors?: string[], failed_requests?: string[] }
 *
 * Open to anonymous visitors on purpose: the person best placed to tell us a
 * page is broken is usually the one who could not get past it to sign in. A
 * signed-in report is attributed to the account; an anonymous one is keyed to a
 * hashed browser key (never the raw value) so a follow-up can be threaded.
 *
 * The body is stored and queued. It is never executed, never handed to anything
 * with write access, and never treated as an instruction: see the security note
 * at the top of api/_lib/feedback/triage.js. Triage runs on a cron a moment
 * later, not inline, so a slow model never makes a visitor wait to be heard.
 */

import { cors, json, method, readJson, wrap, rateLimited, error } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { getSessionUser } from '../_lib/auth.js';
import { hashClient, insertReport, normalizeReport } from '../_lib/feedback/store.js';
import { isDbUnavailableError } from '../_lib/db.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS' })) return;
	if (!method(req, res, ['POST'])) return;

	const user = await getSessionUser(req, res).catch(() => null);
	const rawClient = req.headers['x-feedback-client'];
	const clientKey = hashClient(Array.isArray(rawClient) ? rawClient[0] : rawClient);

	// Keyed to the account when we have one, the browser key when we do not, and
	// the IP as the floor so a client that rotates its key still meets a ceiling.
	const rl = await limits.feedbackWrite(user?.id || clientKey || clientIp(req));
	if (!rl.success) return rateLimited(res, rl, 'You are sending feedback faster than we can read it. Try again shortly.');

	// A trace of 80 bounded events plus the environment fits comfortably here;
	// the store caps every field again on the way in, so this is only the outer
	// guard against a client that streams.
	const payload = await readJson(req, 96_000).catch(() => null);
	const report = normalizeReport(payload || {});
	if (!report.body) {
		return error(res, 400, 'empty_report', 'Tell us what happened and we will look into it.');
	}

	try {
		const row = await insertReport({
			userId: user?.id ?? null,
			clientKey,
			userAgent: req.headers['user-agent'] || null,
			report,
		});
		return json(res, 201, {
			ok: true,
			id: row?.id ?? null,
			received_at: row?.created_at ?? null,
			// Tell the page whether its session was replayable. The panel uses this
			// to say "we captured the steps" instead of a generic thank-you.
			replayable: !!report.trace,
		});
	} catch (err) {
		// A visitor took the trouble to report something. If our own store is the
		// thing that is down, say so plainly rather than swallowing it: the page
		// keeps the draft and offers to retry.
		if (isDbUnavailableError(err)) {
			return error(res, 503, 'store_unavailable', 'We could not file that just now. Your note is kept, try again in a moment.');
		}
		throw err;
	}
});
