// Route entry for /api/widgets/:id/transcripts — Vercel resolves to this file
// via the rewrite in vercel.json. Delegates to the action dispatcher so all
// transcript logic lives in one place ([action].js → handleTranscripts).

import dispatcher from './[action].js';

export default function handler(req, res) {
	req.query = { ...(req.query || {}), action: 'transcripts' };
	return dispatcher(req, res);
}
