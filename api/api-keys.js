import { randomToken, sha256 } from './_lib/crypto.js';
import { sql } from './_lib/db.js';
import { getSessionUser, authenticateBearer, extractBearer, hasScope } from './_lib/auth.js';
import { cors, json, error, wrap, method, readJson, rateLimited } from './_lib/http.js';
import { limits, clientIp } from './_lib/rate-limit.js';
import { requireCsrf } from './_lib/csrf.js';
import { parse } from './_lib/validate.js';
import { z } from 'zod';

const ALLOWED_SCOPES = new Set(['avatars:read', 'avatars:write', 'avatars:delete', 'profile', 'memory:read', 'memory:write', 'agents:read', 'agents:write', 'herald:announce']);

const createSchema = z.object({
	name: z.string().trim().min(1).max(80),
	scope: z
		.string()
		.optional()
		.default('avatars:read avatars:write')
		.transform((s) => s.trim()),
	expires_at: z.string().datetime().optional(),
});

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	const session = await getSessionUser(req);
	const bearer = session ? null : await authenticateBearer(extractBearer(req));
	if (!session && !bearer) return error(res, 401, 'unauthorized', 'sign in required');
	if (bearer && !hasScope(bearer.scope, 'profile'))
		return error(res, 403, 'insufficient_scope', 'requires profile scope');
	const userId = session?.id ?? bearer.userId;

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	if (req.method === 'GET') {
		const rows = await sql`
			select id, name, prefix, scope, last_used_at, expires_at, revoked_at, created_at
			from api_keys
			where user_id = ${userId} and revoked_at is null
			order by created_at desc
		`;
		return json(res, 200, { data: rows });
	}

	// POST — create. CSRF-guard the cookie-authenticated path so a logged-in
	// user can't be tricked into minting a key cross-site. requireCsrf is a
	// no-op for Bearer callers (the token itself is proof of intent).
	if (!(await requireCsrf(req, res, userId))) return;

	const body = parse(createSchema, await readJson(req));

	// Validate requested scopes are all known
	const requestedScopes = body.scope.split(/\s+/).filter(Boolean);
	const invalid = requestedScopes.filter((s) => !ALLOWED_SCOPES.has(s));
	if (invalid.length)
		return error(res, 400, 'validation_error', `unknown scopes: ${invalid.join(', ')}`);

	const token = `sk_live_${randomToken(32)}`;
	const prefix = token.slice(0, 14); // "sk_live_" + 6 chars
	const tokenHash = await sha256(token);

	const [row] = await sql`
		insert into api_keys (user_id, name, prefix, token_hash, scope, expires_at)
		values (
			${userId},
			${body.name},
			${prefix},
			${tokenHash},
			${requestedScopes.join(' ')},
			${body.expires_at ?? null}
		)
		returning id, name, prefix, scope, expires_at, created_at
	`;

	// token is returned only on creation — not stored in plaintext
	return json(res, 201, { data: { ...row, token } });
});
