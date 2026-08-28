/**
 * GET /api/feedback/repro?id=<report id>
 *
 * The report, as a runnable Playwright spec.
 *
 * This is the endpoint that changes what a bug report IS. A maintainer does not
 * read this output, they run it: it is red while the reported bug is present
 * and green once it is fixed, so "is it fixed" stops being a judgement call and
 * the report becomes a regression test the moment it was filed.
 *
 *   curl -s 'https://three.ws/api/feedback/repro?id=<id>' \
 *     -H "cookie: $SESSION" > tests/repros/export-does-nothing.spec.js
 *   npx playwright test tests/repros/export-does-nothing.spec.js
 *
 * `?format=json` returns the spec alongside the narrated steps and the replay
 * confidence, which is what the /feedback queue renders.
 *
 * Admin-only: a trace names internal routes and the shape of a failure, and the
 * generated file is meant for the people who can act on it.
 */

import { cors, json, text, method, wrap, rateLimited, error } from '../_lib/http.js';
import { limits } from '../_lib/rate-limit.js';
import { requireAdmin } from '../_lib/admin.js';
import { isUuid } from '../_lib/validate.js';
import { reportWithTrace } from '../_lib/feedback/store.js';
import { compileToPlaywright, narrate, replayConfidence } from '../../packages/witness/src/compile.js';

const BASE_URL = process.env.WITNESS_REPRO_BASE_URL || 'https://three.ws';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	const admin = await requireAdmin(req, res);
	if (!admin) return;

	const rl = await limits.feedbackRead(admin.id || 'admin');
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, 'http://localhost');
	const id = url.searchParams.get('id') || '';
	if (!isUuid(id)) return error(res, 400, 'invalid_id', 'Pass the report id as ?id=<uuid>.');

	const report = await reportWithTrace(id);
	if (!report) return error(res, 404, 'not_found', 'No feedback report with that id.');
	if (!report.trace) {
		return error(
			res,
			409,
			'no_trace',
			'That report has no recorded session, so there is nothing to replay. Reports filed before the recorder shipped, or from a browser that opted out, arrive without one.',
		);
	}

	const compiled = compileToPlaywright(report.trace, {
		title: report.summary || report.body || 'reported issue',
		baseUrl: url.searchParams.get('base') || BASE_URL,
		reportId: report.id,
	});

	if (url.searchParams.get('format') === 'json') {
		return json(res, 200, {
			ok: true,
			id: report.id,
			filename: compiled.filename,
			source: compiled.source,
			steps: narrate(report.trace),
			confidence: replayConfidence(report.trace),
			recorded_at: report.created_at,
		});
	}

	// Served as a file so `curl > tests/repros/<name>.spec.js` is the whole
	// workflow. text/plain rather than application/javascript keeps a browser
	// from trying to execute what is, to it, an untrusted script.
	return text(res, 200, compiled.source, {
		'content-disposition': `inline; filename="${compiled.filename}"`,
		'cache-control': 'private, no-store',
	});
});
