// Route entry for /api/widgets/:id/stats — Vercel resolves to this file
// via the rewrite in vercel.json. Delegates to the action dispatcher so all
// stats logic lives in one place ([action].js → handleStats).

import dispatcher from './[action].js';

export default function handler(req, res) {
	req.query = { ...(req.query || {}), action: 'stats' };
	return dispatcher(req, res);
}
