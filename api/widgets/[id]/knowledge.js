// Route entry for /api/widgets/:id/knowledge — Vercel resolves to this file
// via the rewrite in vercel.json. Delegates to the action dispatcher so all
// knowledge logic lives in one place ([action].js → handleKnowledge).

import dispatcher from './[action].js';

export default function handler(req, res) {
	req.query = { ...(req.query || {}), action: 'knowledge' };
	return dispatcher(req, res);
}
