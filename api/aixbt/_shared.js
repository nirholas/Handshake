// Shared error responder for the /api/aixbt/* endpoints.
//
// Maps the typed errors thrown by api/_lib/aixbt.js onto stable JSON envelopes
// the frontend can branch on. The "not configured" case carries a setup hint so
// the UI can render an actionable empty state instead of a dead error.

import { error, serverError } from '../_lib/http.js';
import { mapAixbtFailure } from '../_lib/aixbt.js';

export function respondAixbtError(res, err) {
	// The classification itself lives in api/_lib/aixbt.js so this door and the
	// /api/v1/market/* doors answer the same failure the same way.
	const mapped = mapAixbtFailure(err);
	if (!mapped) return serverError(res, 500, 'aixbt_error', err);
	return error(
		res,
		mapped.status,
		mapped.code,
		mapped.message,
		mapped.setup ? { setup: mapped.setup } : undefined,
	);
}
