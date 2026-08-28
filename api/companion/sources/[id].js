// PATCH  /api/companion/sources/:id  → rename, enable/disable.
// DELETE /api/companion/sources/:id  → disconnect (credentials are dropped).
// POST   /api/companion/sources/:id  → poll it right now ("check now").

import { z } from 'zod';
import { getRequestUser } from '../../_lib/auth.js';
import { cors, json, method, wrap, error, readJson, rateLimited } from '../../_lib/http.js';
import { requireCsrf } from '../../_lib/csrf.js';
import { limits } from '../../_lib/rate-limit.js';
import { parse } from '../../_lib/validate.js';
import { getSource, updateSource, deleteSource } from '../../_lib/companion/store.js';
import { pollSource } from '../../_lib/companion/poll.js';

const patchBody = z.object({
	label: z.string().min(1).max(80).optional(),
	enabled: z.boolean().optional(),
});

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'PATCH,DELETE,POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['PATCH', 'DELETE', 'POST'])) return;

	const user = await getRequestUser(req, res);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');
	if (!(await requireCsrf(req, res, user.id))) return;

	const id = String(req.query?.id || '').trim();
	if (!/^[0-9a-f-]{36}$/i.test(id)) return error(res, 400, 'validation_error', 'invalid source id');

	if (req.method === 'DELETE') {
		const rl = await limits.companionWrite(user.id);
		if (!rl.success) return rateLimited(res, rl);
		const removed = await deleteSource(user.id, id);
		if (!removed) return error(res, 404, 'not_found', 'no such source');
		return json(res, 200, { deleted: true });
	}

	if (req.method === 'PATCH') {
		const rl = await limits.companionWrite(user.id);
		if (!rl.success) return rateLimited(res, rl);
		const patch = parse(patchBody, await readJson(req));
		const source = await updateSource(user.id, id, patch);
		if (!source) return error(res, 404, 'not_found', 'no such source');
		return json(res, 200, { source });
	}

	const rl = await limits.companionPoll(user.id);
	if (!rl.success) return rateLimited(res, rl);
	const source = await getSource(user.id, id);
	if (!source) return error(res, 404, 'not_found', 'no such source');
	const result = await pollSource(source);
	return json(res, result.ok ? 200 : 502, result);
});
