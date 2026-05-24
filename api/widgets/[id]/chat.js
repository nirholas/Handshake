// Route entry for /api/widgets/:id/chat — Vercel resolves to this file
// via the rewrite in vercel.json. Delegates to the action dispatcher so all
// chat logic lives in one place ([action].js → handleChat).

import dispatcher from './[action].js';

export default function handler(req, res) {
	req.query = { ...(req.query || {}), action: 'chat' };
	return dispatcher(req, res);
}
