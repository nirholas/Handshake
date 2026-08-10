// GET /api/agents/check-name?name=<name>[&agent_id=<excludeId>]
// Returns { available: boolean, reason?: 'taken' | 'invalid' | 'denylisted' }

import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { sql } from '../_lib/db.js';
import { isUuid } from '../_lib/validate.js';
import { cors, json, method, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';

const NAME_RE = /^[a-zA-Z0-9_-]{3,32}$/;

const DENYLIST = new Set([
	'admin',
	'root',
	'system',
	'anthropic',
	'claude',
	'openai',
	'null',
	'undefined',
	'test',
]);

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const session = await getSessionUser(req);
	const bearer = session ? null : await authenticateBearer(extractBearer(req));
	if (!session && !bearer) return error(res, 401, 'unauthorized', 'sign in required');
	const userId = session?.id ?? bearer.userId;

	const rl = await limits.checkName(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, 'http://x');
	const name = (url.searchParams.get('name') || '').trim();
	// agent_id feeds a `WHERE id != $1` against a uuid column. A malformed value
	// otherwise surfaces Postgres 22P02 to the caller as a 500; reject it here.
	const agentId = (url.searchParams.get('agent_id') || '').trim() || null;
	if (agentId && !isUuid(agentId)) {
		return error(res, 400, 'validation_error', 'agent_id must be a uuid');
	}

	if (!name) return json(res, 200, { available: false, reason: 'invalid' });

	if (!NAME_RE.test(name)) return json(res, 200, { available: false, reason: 'invalid' });

	if (DENYLIST.has(name.toLowerCase()))
		return json(res, 200, { available: false, reason: 'denylisted' });

	// Exclude the agent being edited so renaming to the same name is always "available".
	const [conflict] = agentId
		? await sql`
			SELECT id FROM agent_identities
			WHERE user_id = ${userId}
			  AND lower(name) = lower(${name})
			  AND id != ${agentId}
			  AND deleted_at IS NULL
		`
		: await sql`
			SELECT id FROM agent_identities
			WHERE user_id = ${userId}
			  AND lower(name) = lower(${name})
			  AND deleted_at IS NULL
		`;

	if (conflict) return json(res, 200, { available: false, reason: 'taken' });
	return json(res, 200, { available: true });
});
