// GET    /api/mocap/clips/:id  — fetch a clip (frames included)
// PATCH  /api/mocap/clips/:id  — update metadata (name, description, tags, visibility, price)
// DELETE /api/mocap/clips/:id  — soft-delete (owner only)

import { getSessionUser, authenticateBearer, extractBearer, hasScope } from '../_lib/auth.js';
import { sql } from '../_lib/db.js';
import { cors, json, method, readJson, wrap, error } from '../_lib/http.js';
import { z } from 'zod';

const patchSchema = z.object({
	name: z.string().trim().min(1).max(120).optional(),
	description: z.string().trim().max(2000).optional(),
	tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
	visibility: z.enum(['private', 'unlisted', 'public']).optional(),
	avatar_id: z.string().uuid().nullable().optional(),
	price: z
		.object({
			amount: z.string().regex(/^\d+(\.\d{1,9})?$/),
			currency: z.string().min(2).max(10),
		})
		.nullable()
		.optional(),
});

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,PATCH,DELETE,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'PATCH', 'DELETE'])) return;

	const id =
		req.query?.id ||
		new URL(req.url, 'http://x').pathname.split('/').filter(Boolean).pop();
	if (!id || !/^[0-9a-f-]{8,}$/i.test(id)) {
		return error(res, 400, 'invalid_request', 'id required');
	}

	const auth = await resolveAuth(req);

	if (req.method === 'GET') return handleGet(req, res, auth, id);
	if (!auth) return error(res, 401, 'unauthorized', 'authentication required');
	if (req.method === 'PATCH') return handlePatch(req, res, auth, id);
	return handleDelete(req, res, auth, id);
});

async function handleGet(req, res, auth, id) {
	const [row] = await sql`
		select id, owner_id, avatar_id, slug, name, description, kind, format,
		       duration_ms, frame_count, frames, tags, visibility,
		       price_amount, price_currency, play_count,
		       created_at, updated_at
		from mocap_clips
		where id = ${id} and deleted_at is null
		limit 1
	`;
	if (!row) return error(res, 404, 'not_found', 'clip not found');
	const ownerView = auth?.userId === row.owner_id;
	if (!ownerView && row.visibility === 'private') {
		return error(res, 404, 'not_found', 'clip not found');
	}

	// Bump play_count only when someone other than the owner fetches a
	// playable clip — recording your own clip doesn't inflate counters.
	if (!ownerView) {
		// Fire-and-forget; failure must not block the response.
		queueMicrotask(async () => {
			try {
				await sql`update mocap_clips set play_count = play_count + 1 where id = ${id}`;
			} catch (err) {
				console.warn('[mocap] play_count update failed', err?.message);
			}
		});
	}

	res.setHeader(
		'Cache-Control',
		ownerView ? 'private, max-age=0' : 'public, s-maxage=60, stale-while-revalidate=300',
	);
	return json(res, 200, {
		clip: {
			id: row.id,
			slug: row.slug,
			name: row.name,
			description: row.description,
			kind: row.kind,
			format: row.format,
			duration_ms: row.duration_ms,
			duration: row.duration_ms / 1000,
			frame_count: row.frame_count,
			frames: row.frames || [],
			tags: row.tags || [],
			visibility: row.visibility,
			avatar_id: row.avatar_id,
			play_count: Number(row.play_count || 0),
			price: row.price_amount
				? { amount: String(row.price_amount), currency: row.price_currency }
				: null,
			owner: ownerView ? 'self' : 'other',
			created_at: row.created_at,
			updated_at: row.updated_at,
		},
	});
}

async function handlePatch(req, res, auth, id) {
	if (auth.source === 'oauth' || auth.source === 'apikey') {
		if (!hasScope(auth.scope, 'avatars:write'))
			return error(res, 403, 'insufficient_scope', 'avatars:write required');
	}
	const body = await readJson(req);
	const parsed = patchSchema.safeParse(body);
	if (!parsed.success) {
		return error(res, 400, 'validation_error', parsed.error.issues.map((i) => i.message).join('; '));
	}
	const patch = parsed.data;

	const sets = [];
	if (patch.name !== undefined) sets.push(sql`name = ${patch.name}`);
	if (patch.description !== undefined) sets.push(sql`description = ${patch.description}`);
	if (patch.tags !== undefined) sets.push(sql`tags = ${patch.tags}`);
	if (patch.visibility !== undefined) sets.push(sql`visibility = ${patch.visibility}`);
	if (patch.avatar_id !== undefined) {
		if (patch.avatar_id) {
			const ok = await sql`
				select 1 from avatars
				where id = ${patch.avatar_id} and owner_id = ${auth.userId} and deleted_at is null
				limit 1
			`;
			if (!ok[0]) return error(res, 404, 'not_found', 'avatar_id not owned by you');
		}
		sets.push(sql`avatar_id = ${patch.avatar_id}`);
	}
	if (patch.price !== undefined) {
		if (patch.price === null) {
			sets.push(sql`price_amount = null`);
			sets.push(sql`price_currency = null`);
		} else {
			sets.push(sql`price_amount = ${patch.price.amount}`);
			sets.push(sql`price_currency = ${patch.price.currency}`);
		}
	}
	if (sets.length === 0) return error(res, 400, 'invalid_request', 'no patchable fields supplied');
	const setClause = sets.reduce((acc, s, i) => (i === 0 ? sql`set ${s}` : sql`${acc}, ${s}`), sql``);

	const [row] = await sql`
		update mocap_clips
		${setClause}
		where id = ${id} and owner_id = ${auth.userId} and deleted_at is null
		returning id, slug, name, description, kind, format, duration_ms, frame_count,
		          tags, visibility, avatar_id, price_amount, price_currency,
		          created_at, updated_at
	`;
	if (!row) return error(res, 404, 'not_found', 'clip not found or not yours');
	return json(res, 200, {
		clip: {
			...row,
			price: row.price_amount
				? { amount: String(row.price_amount), currency: row.price_currency }
				: null,
		},
	});
}

async function handleDelete(req, res, auth, id) {
	if (auth.source === 'oauth' || auth.source === 'apikey') {
		if (!hasScope(auth.scope, 'avatars:delete'))
			return error(res, 403, 'insufficient_scope', 'avatars:delete required');
	}
	const [row] = await sql`
		update mocap_clips
		set deleted_at = now()
		where id = ${id} and owner_id = ${auth.userId} and deleted_at is null
		returning id
	`;
	if (!row) return error(res, 404, 'not_found', 'clip not found or not yours');
	return json(res, 200, { ok: true });
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
