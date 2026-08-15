// Route entry for /api/widgets/:id/duplicate: Vercel resolves to this file
// via the rewrite in vercel.json. Delegates to the action dispatcher so all
// duplicate logic lives in one place ([action].js → handleDuplicate).
//
// This file used to carry its own copy of the clone query, and that copy
// omitted the `id` column. widgets.id is `text not null` with no default, so
// every authenticated Duplicate click died on a not-null violation and the
// dashboard surfaced a bare 500. Delegating removes the second copy entirely.

import dispatcher from './[action].js';

export default function handler(req, res) {
	req.query = { ...(req.query || {}), action: 'duplicate' };
	return dispatcher(req, res);
}
