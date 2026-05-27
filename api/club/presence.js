import { cors, json, error, method, readJson, wrap } from '../_lib/http.js';

const sessions = new Map();
const TTL_MS = 30_000;

function prune() {
	const now = Date.now();
	for (const [id, ts] of sessions) {
		if (now - ts > TTL_MS) sessions.delete(id);
	}
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS' })) return;
	if (!method(req, res, ['POST'])) return;

	const body = await readJson(req);
	const session = typeof body?.session === 'string' ? body.session.slice(0, 40) : '';
	if (!session) return error(res, 400, 'validation_error', 'session required');

	prune();
	sessions.set(session, Date.now());

	return json(res, 200, { count: sessions.size });
});
