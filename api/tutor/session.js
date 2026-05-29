// Tutor session ledger — FREE, read-only / close operations (no x402 charge).
//
//   GET  /api/tutor/session?sessionId=<id>   → current itemized tab (for resume)
//   POST /api/tutor/session  { sessionId, action: "end" } → close + signed invoice
//
// Answering questions is the paid action (POST /api/x402/tutor, $0.01 each).
// Viewing the running tab and closing the session are free: a learner must
// never be charged to see what they owe or to end the session.

import { cors, method, wrap, error, readJson, json } from '../_lib/http.js';
import { loadSession, closeSession, atomicsToUsd } from '../../agents/tutor/src/session.js';

function itemize(session) {
	return {
		sessionId: session.sessionId,
		createdAt: session.createdAt,
		status: session.status,
		questionCount: session.entries.length,
		lineItems: session.entries.map((e, i) => ({
			n: i + 1,
			question: e.question,
			level: e.level,
			outputTokens: e.outputTokens,
			costAtomics: e.costAtomics,
			costUsd: atomicsToUsd(e.costAtomics),
			at: e.at,
		})),
		totalAtomics: session.totalAtomics,
		totalUsd: atomicsToUsd(session.totalAtomics),
		...(session.invoice ? { invoice: session.invoice } : {}),
	};
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	if (req.method === 'GET') {
		const sessionId = new URL(req.url, 'http://x').searchParams.get('sessionId');
		if (!sessionId) return error(res, 400, 'missing_session', 'sessionId query param required');
		const session = await loadSession(sessionId.slice(0, 100));
		return json(res, 200, itemize(session));
	}

	// POST — close the session and return the signed invoice.
	const body = await readJson(req).catch(() => ({}));
	const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim().slice(0, 100) : '';
	if (!sessionId) return error(res, 400, 'missing_session', 'sessionId is required');
	if (body?.action && body.action !== 'end') {
		return error(res, 400, 'bad_action', 'only action "end" is supported');
	}
	const invoice = await closeSession(sessionId);
	return json(res, 200, invoice);
});
