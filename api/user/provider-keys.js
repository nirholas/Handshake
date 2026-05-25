// GET  /api/user/provider-keys  — returns which keys are set (never returns values)
// PATCH /api/user/provider-keys  — set or clear individual provider keys
//   body: { anthropic?: string | null, openai?: string | null }
//   null = delete that key; string = store encrypted

import { sql } from '../_lib/db.js';
import { getSessionUser } from '../_lib/auth.js';
import { cors, json, error, wrap, method, readJson } from '../_lib/http.js';
import { encryptProviderKey, BYOK_PROVIDERS } from '../_lib/provider-keys.js';
import { z } from 'zod';
import { parse } from '../_lib/validate.js';

const patchSchema = z.object({
	anthropic: z.string().min(1).max(512).nullable().optional(),
	openai:    z.string().min(1).max(512).nullable().optional(),
});

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,PATCH,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'PATCH'])) return;

	const session = await getSessionUser(req);
	if (!session) return error(res, 401, 'unauthorized', 'sign in required');

	if (req.method === 'GET') {
		const [row] = await sql`SELECT provider_keys FROM users WHERE id = ${session.id}`;
		const stored = row?.provider_keys || {};
		const status = {};
		for (const provider of Object.keys(BYOK_PROVIDERS)) {
			status[provider] = { set: !!stored[provider] };
		}
		return json(res, 200, { keys: status });
	}

	// PATCH
	const body = parse(patchSchema, await readJson(req));

	const [row] = await sql`SELECT provider_keys FROM users WHERE id = ${session.id}`;
	const current = { ...(row?.provider_keys || {}) };

	for (const [provider, value] of Object.entries(body)) {
		if (!(provider in BYOK_PROVIDERS)) continue;
		if (value === null || value === undefined) {
			delete current[provider];
		} else {
			current[provider] = await encryptProviderKey(value.trim());
		}
	}

	await sql`UPDATE users SET provider_keys = ${JSON.stringify(current)}::jsonb, updated_at = NOW() WHERE id = ${session.id}`;

	const status = {};
	for (const provider of Object.keys(BYOK_PROVIDERS)) {
		status[provider] = { set: !!current[provider] };
	}
	return json(res, 200, { keys: status });
});
