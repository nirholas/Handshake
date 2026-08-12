// GET /api/club/tips?limit=&dancer=
//
// Returns the most-recent tip events written by /api/x402/dance-tip. Powers
// the initial render of the /club "Live tips" widget on page boot; the SSE
// channel at /api/club/tips/stream takes over for live updates.

import { sql } from '../_lib/db.js';
import { cors, json, method, wrap } from '../_lib/http.js';

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const requested = Number(req.query?.limit);
	const limit = Number.isFinite(requested)
		? Math.min(Math.max(Math.trunc(requested), 1), MAX_LIMIT)
		: DEFAULT_LIMIT;

	const dancerRaw = typeof req.query?.dancer === 'string' ? req.query.dancer.trim() : '';
	const dancer = dancerRaw ? dancerRaw.slice(0, 4) : null;

	const rows = await (dancer
		? sql`
			select ticket_id, dancer, dance, clip, label, payer, network,
			       amount_atomics, asset, started_at, ends_at, created_at
			from club_tips
			where dancer = ${dancer}
			order by created_at desc
			limit ${limit}
		`
		: sql`
			select ticket_id, dancer, dance, clip, label, payer, network,
			       amount_atomics, asset, started_at, ends_at, created_at
			from club_tips
			order by created_at desc
			limit ${limit}
		`);

	return json(res, 200, { tips: rows });
});
