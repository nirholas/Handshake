// Tutor session ledger: FREE, read-only / close operations (no x402 charge).
//
//   GET  /api/tutor/session?sessionId=<id>   -> current itemized tab (for resume)
//   POST /api/tutor/session  { sessionId, action: "end" } -> close + signed invoice
//
// Answering questions is the paid action (POST /api/x402/tutor, $0.01 each).
// Viewing the running tab and closing the session are free: a learner must
// never be charged to see what they owe or to end the session.
//
// The sessionId is the capability: it is minted client-side as a UUID and is
// the only thing that addresses a tab, so there is no account to authenticate
// against here. A store fault surfaces as a 5xx rather than an empty tab, so a
// learner is never shown "$0, no questions" for a session they are being
// billed for.

import { cors, method, wrap, error, readJson, json } from '../_lib/http.js';
import { loadSession, closeSession, atomicsToUsd } from '../../agents/tutor/src/session.js';

const MAX_SESSION_ID = 100;

function cleanSessionId(value) {
	return typeof value === 'string' ? value.trim().slice(0, MAX_SESSION_ID) : '';
}

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
		const sessionId = cleanSessionId(new URL(req.url, 'http://x').searchParams.get('sessionId'));
		if (!sessionId) return error(res, 400, 'missing_session', 'sessionId query param required');
		// An id with no stored tab is not an error: the /tutor page resumes by
		// asking for its locally-minted id on every load, and a fresh id
		// legitimately has nothing behind it yet.
		const session = await loadSession(sessionId);
		return json(res, 200, itemize(session));
	}

	// POST: close the session and return the signed invoice.
	const body = await readJson(req);
	const sessionId = cleanSessionId(body?.sessionId);
	if (!sessionId) return error(res, 400, 'missing_session', 'sessionId is required');
	if (body?.action && body.action !== 'end') {
		return error(res, 400, 'bad_action', 'only action "end" is supported');
	}
	const invoice = await closeSession(sessionId);
	return json(res, 200, invoice);
});
