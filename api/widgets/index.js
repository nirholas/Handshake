/**
 * Widget CRUD — list + create
 * ---------------------------
 * GET  /api/widgets       — list current user's widgets
 * POST /api/widgets       — create a new widget for current user
 *
 * Auth: session cookie or bearer (avatars:read for list, avatars:write for create).
 * Widget IDs: 'wdgt_' + 12 url-safe random chars (crypto.randomBytes(9).base64url).
 */

import crypto from 'node:crypto';
import { z } from 'zod';

import { sql } from '../_lib/db.js';
import { getSessionUser, authenticateBearer, extractBearer, hasScope } from '../_lib/auth.js';
import { cors, json, method, readJson, wrap, error } from '../_lib/http.js';
import { parse } from '../_lib/validate.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { publicUrl } from '../_lib/r2.js';
import { WIDGET_TYPES } from '../_lib/widget-types.js';

const createBody = z.object({
	type: z.enum(WIDGET_TYPES),
	name: z.string().trim().min(1).max(120),
	avatar_id: z.string().uuid().nullable().optional(),
	config: z.record(z.any()).default({}),
	is_public: z.boolean().default(true),
});

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	const auth = await resolveAuth(req, req.method === 'POST' ? 'avatars:write' : 'avatars:read');
	if (!auth) return error(res, 401, 'unauthorized', 'sign in or provide a valid bearer token');

	if (req.method === 'GET') {
		const rl = await limits.widgetRead(clientIp(req));
		if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

		const rows = await sql`
			select w.id, w.user_id, w.avatar_id, w.type, w.name, w.config, w.is_public,
			       w.view_count, w.created_at, w.updated_at,
			       a.name as avatar_name, a.thumbnail_key as avatar_thumbnail_key,
			       a.storage_key as avatar_storage_key, a.visibility as avatar_visibility
			from widgets w
			left join avatars a on a.id = w.avatar_id and a.deleted_at is null
			where w.user_id = ${auth.userId} and w.deleted_at is null
			order by w.updated_at desc
			limit 500
		`;
		return json(res, 200, { widgets: rows.map(decorate) });
	}

	// POST
	const rl = await limits.widgetWrite(auth.userId);
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const body = parse(createBody, await readJson(req));

	if (body.avatar_id) {
		const allowed = await sql`
			select 1 from avatars
			where id = ${body.avatar_id}
			  and deleted_at is null
			  and (owner_id = ${auth.userId} or visibility = 'public')
			limit 1
		`;
		if (!allowed[0])
			return error(res, 400, 'invalid_avatar', 'avatar_id not found, not owned by caller, and not public');
	}

	const id = newWidgetId();
	const [row] = await sql`
		insert into widgets (id, user_id, avatar_id, type, name, config, is_public)
		values (${id}, ${auth.userId}, ${body.avatar_id ?? null}, ${body.type}, ${body.name},
		        ${JSON.stringify(body.config)}::jsonb, ${body.is_public})
		returning id, user_id, avatar_id, type, name, config, is_public, view_count, created_at, updated_at
	`;
	return json(res, 201, { widget: decorate(row) });
});

async function resolveAuth(req, requiredScope) {
	const session = await getSessionUser(req);
	if (session) return { userId: session.id, source: 'session' };
	const bearer = await authenticateBearer(extractBearer(req));
	if (!bearer) return null;
	if (!hasScope(bearer.scope, requiredScope)) return null;
	return bearer;
}

function newWidgetId() {
	return 'wdgt_' + crypto.randomBytes(9).toString('base64url');
}

export function decorate(row) {
	const out = {
		id: row.id,
		user_id: row.user_id,
		avatar_id: row.avatar_id,
		type: row.type,
		name: row.name,
		config: row.config || {},
		is_public: row.is_public,
		view_count: Number(row.view_count || 0),
		created_at: row.created_at,
		updated_at: row.updated_at,
	};
	if (row.avatar_name !== undefined) {
		out.avatar = row.avatar_id
			? {
					id: row.avatar_id,
					name: row.avatar_name,
					thumbnail_url: safePublicUrl(row.avatar_thumbnail_key),
					model_url:
						row.avatar_visibility === 'public' || row.avatar_visibility === 'unlisted'
							? safePublicUrl(row.avatar_storage_key)
							: null,
					visibility: row.avatar_visibility,
				}
			: null;
	}
	return out;
}

function safePublicUrl(key) {
	if (!key) return null;
	try {
		return publicUrl(key);
	} catch {
		return null;
	}
}
