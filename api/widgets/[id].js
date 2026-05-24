/**
 * Widget by id — GET (public/private), PATCH (owner), DELETE (owner)
 * -------------------------------------------------------------------
 * GET    /api/widgets/:id   — public if is_public, else owner-only.
 *                              Joins avatar so caller has model_url + thumbnail
 *                              in a single round-trip (Studio + dashboard).
 * PATCH  /api/widgets/:id   — owner-only. Updates name/config/is_public/avatar_id.
 * DELETE /api/widgets/:id   — owner-only. Soft-delete via deleted_at.
 *
 * View counter: GET increments view_count when the caller is unauthenticated
 * OR not the owner. Owner previews shouldn't pollute their own analytics.
 */

import { z } from 'zod';

import { sql } from '../_lib/db.js';
import { getSessionUser, authenticateBearer, extractBearer, hasScope } from '../_lib/auth.js';
import { cors, json, method, readJson, wrap, error } from '../_lib/http.js';
import { parse } from '../_lib/validate.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { decorate } from './index.js';
import { isDemoWidgetId, getDemoWidget } from './_demo-fixtures.js';
import { WIDGET_TYPES } from '../_lib/widget-types.js';

const patchSchema = z.object({
	name: z.string().trim().min(1).max(120).optional(),
	config: z.record(z.any()).optional(),
	is_public: z.boolean().optional(),
	avatar_id: z.string().uuid().nullable().optional(),
	type: z.enum(WIDGET_TYPES).optional(),
});

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,PATCH,DELETE,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'PATCH', 'DELETE'])) return;

	const id = idFromReq(req);
	if (!id) return error(res, 400, 'invalid_request', 'id required');

	const auth = await resolveAuth(req);

	if (req.method === 'GET') {
		const rl = await limits.widgetRead(clientIp(req));
		if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

		// Public showcase fixtures — short-circuit DB lookup so the gallery
		// renders without seeded rows in any environment.
		if (isDemoWidgetId(id)) {
			const demo = getDemoWidget(id);
			if (!demo) return error(res, 404, 'not_found', 'widget not found');
			res.setHeader('cache-control', 'public, max-age=300, s-maxage=900');
			return json(res, 200, { widget: demo });
		}

		const rows = await sql`
			select w.id, w.user_id, w.avatar_id, w.type, w.name, w.config, w.is_public,
			       w.view_count, w.created_at, w.updated_at,
			       a.name as avatar_name, a.thumbnail_key as avatar_thumbnail_key,
			       a.storage_key as avatar_storage_key, a.visibility as avatar_visibility
			from widgets w
			left join avatars a on a.id = w.avatar_id and a.deleted_at is null
			where w.id = ${id} and w.deleted_at is null
			limit 1
		`;
		const row = rows[0];
		if (!row) return error(res, 404, 'not_found', 'widget not found');

		const isOwner = !!auth?.userId && auth.userId === row.user_id;
		if (!row.is_public && !isOwner) return error(res, 404, 'not_found', 'widget not found');

		// Owner viewing in dashboard/studio shouldn't bump counts.
		if (!isOwner) {
			sql`update widgets set view_count = view_count + 1 where id = ${id}`.catch(() => {});
		}

		return json(res, 200, { widget: decorate(row) });
	}

	if (!auth?.userId) return error(res, 401, 'unauthorized', 'authentication required');
	if (auth.source === 'oauth' || auth.source === 'apikey') {
		const need = req.method === 'DELETE' ? 'avatars:delete' : 'avatars:write';
		if (!hasScope(auth.scope, need))
			return error(res, 403, 'insufficient_scope', `${need} required`);
	}

	const rl = await limits.widgetWrite(auth.userId);
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	if (req.method === 'PATCH') {
		const patch = parse(patchSchema, await readJson(req));

		if (patch.avatar_id) {
			const allowed = await sql`
				select 1 from avatars
				where id = ${patch.avatar_id}
				  and deleted_at is null
				  and (owner_id = ${auth.userId} or visibility = 'public')
				limit 1
			`;
			if (!allowed[0])
				return error(
					res,
					400,
					'invalid_avatar',
					'avatar_id not found, not owned by caller, and not public',
				);
		}

		const [row] = await sql`
			update widgets set
				name       = coalesce(${patch.name ?? null}, name),
				config     = coalesce(${patch.config ? JSON.stringify(patch.config) : null}::jsonb, config),
				is_public  = coalesce(${patch.is_public ?? null}::boolean, is_public),
				avatar_id  = case when ${patch.avatar_id !== undefined} then ${patch.avatar_id ?? null}::uuid else avatar_id end,
				type       = coalesce(${patch.type ?? null}, type)
			where id = ${id} and user_id = ${auth.userId} and deleted_at is null
			returning id, user_id, avatar_id, type, name, config, is_public, view_count, created_at, updated_at
		`;
		if (!row) return error(res, 404, 'not_found', 'widget not found or not yours');
		return json(res, 200, { widget: decorate(row) });
	}

	// DELETE — soft delete so existing embeds get a clean 404 rather than orphan rows.
	const rows = await sql`
		update widgets set deleted_at = now()
		where id = ${id} and user_id = ${auth.userId} and deleted_at is null
		returning id
	`;
	if (!rows[0]) return error(res, 404, 'not_found', 'widget not found or not yours');
	return json(res, 200, { ok: true });
});

function idFromReq(req) {
	const fromQuery = req.query?.id;
	if (typeof fromQuery === 'string' && fromQuery) return fromQuery;
	const path = new URL(req.url, 'http://x').pathname;
	const m = path.match(/\/api\/widgets\/([^/]+)/);
	return m ? decodeURIComponent(m[1]) : null;
}

async function resolveAuth(req) {
	const session = await getSessionUser(req);
	if (session)
		return {
			userId: session.id,
			source: 'session',
			scope: 'avatars:read avatars:write avatars:delete',
		};
	return await authenticateBearer(extractBearer(req));
}
