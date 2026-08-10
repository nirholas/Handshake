// Shared error responder for the /api/aixbt/* endpoints.
//
// Maps the typed errors thrown by api/_lib/aixbt.js onto stable JSON envelopes
// the frontend can branch on. The "not configured" case carries a setup hint so
// the UI can render an actionable empty state instead of a dead error.

import { error, serverError } from '../_lib/http.js';

const SETUP_HINT =
	'Set AIXBT_API_KEY (full aixbt.tech subscription or an x402 key pass from https://api.aixbt.tech/x402/v2/api-keys).';

export function respondAixbtError(res, err) {
	if (err?.code === 'aixbt_not_configured') {
		return error(res, 503, err.code, err.message, { setup: SETUP_HINT });
	}
	const status = Number(err?.status) || 502;
	// aixbt rejecting OUR server-side key is a deployment fault, never the
	// caller's: /api/aixbt/* takes no client credential, so relaying the raw
	// 401/403 would tell a client to authenticate against a door it holds no
	// key to (and a bare 401 with no WWW-Authenticate is malformed besides).
	// It is the same class of failure as a missing key, so it gets the same
	// 503 + actionable setup hint. The `aixbt_unauthorized` code is preserved
	// so existing clients keep their typed branch.
	if (status === 401 || status === 403) {
		return error(
			res,
			503,
			'aixbt_unauthorized',
			'aixbt rejected this deployment key (expired, revoked, or below the plan this read needs)',
			{ setup: SETUP_HINT },
		);
	}
	// 4xx and "upstream is the fault" (502/503/504/429) carry their descriptive
	// code + message; only genuine internal faults get the sanitized 5xx
	// treatment.
	if (err?.code && (status < 500 || status === 502 || status === 503 || status === 504)) {
		return error(res, status, err.code, err.message || 'aixbt request failed');
	}
	return serverError(res, 500, 'aixbt_error', err);
}
