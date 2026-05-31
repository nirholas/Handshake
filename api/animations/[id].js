// GET    /api/animations/clips/:id  — fetch a clip (baked clip + editor_doc)
// PATCH  /api/animations/clips/:id  — update metadata (owner only)
// DELETE /api/animations/clips/:id  — soft-delete (owner only)
//
// Mirrors api/mocap/[id].js. The baked clip resolves from R2 when offloaded
// (storage_key set); the editor_doc is returned so the studio can reopen the
// animation for lossless re-editing.

import { getSessionUser, authenticateBearer, extractBearer, hasScope } from '../_lib/auth.js';
import { sql } from '../_lib/db.js';
import { cors, json, method, readJson, wrap, error } from '../_lib/http.js';
import { getObjectBuffer, publicUrl } from '../_lib/r2.js';
import { z } from 'zod';

const patchSchema = z.object({
	name: z.string().trim().min(1).max(120).optional(),
	description: z.string().trim().max(2000).optional(),
	tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
	visibility: z.enum(['private', 'unlisted', 'public']).optional(),
	kind: z.enum(['animation', 'loop', 'sequence']).optional(),
	loop: z.boolean().optional(),
	avatar_id: z.string().uuid().nullable().optional(),
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
		       duration_ms, frame_count, fps, loop, clip, storage_key, editor_doc,
		       thumbnail_key, tags, visibility, price_amount, price_currency,
		       listed, play_count, purchase_count, created_at, updated_at
		from animation_clips
		where id = ${id} and deleted_at is null
		limit 1
	`;
	if (!row) return error(res, 404, 'not_found', 'animation not found');
	const ownerView = auth?.userId === row.owner_id;
	if (!ownerView && row.visibility === 'private') {
		return error(res, 404, 'not_found', 'animation not found');
	}

	// Resolve the baked clip body from R2 when it was offloaded.
	let clip = row.clip || null;
	if (!clip && row.storage_key) {
		try {
			const buf = await getObjectBuffer(row.storage_key);
			clip = JSON.parse(buf.toString('utf8'));
		} catch (err) {
			console.error('[animations/get] R2 resolve failed', err?.message || err);
			return error(res, 502, 'storage_error', 'Failed to load clip payload');
		}
	}

	// Bump play_count only when a non-owner fetches with ?play=1 (real playback,
	// not editor opens or scrubbing). Fire-and-forget.
	const isPlay = new URL(req.url, 'http://x').searchParams.get('play') === '1';
	if (!ownerView && isPlay) {
		queueMicrotask(async () => {
			try {
				await sql`update animation_clips set play_count = play_count + 1 where id = ${id}`;
			} catch (err) {
				console.warn('[animations] play_count update failed', err?.message);
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
			fps: row.fps,
			loop: row.loop,
			clip, // baked THREE.AnimationClip.toJSON()
			editor_doc: ownerView ? row.editor_doc || null : null, // editing source is owner-only
			editable: ownerView && !!row.editor_doc,
			tags: row.tags || [],
			visibility: row.visibility,
			avatar_id: row.avatar_id,
			thumbnail_url: row.thumbnail_key ? publicUrl(row.thumbnail_key) : null,
			play_count: Number(row.play_count || 0),
			purchase_count: Number(row.purchase_count || 0),
			listed: !!row.listed,
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
	if (patch.kind !== undefined) sets.push(sql`kind = ${patch.kind}`);
	if (patch.loop !== undefined) sets.push(sql`loop = ${patch.loop}`);
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
	if (sets.length === 0) return error(res, 400, 'invalid_request', 'no patchable fields supplied');
	const setClause = sets.reduce((acc, s, i) => (i === 0 ? sql`set ${s}` : sql`${acc}, ${s}`), sql``);

	const [row] = await sql`
		update animation_clips
		${setClause}
		where id = ${id} and owner_id = ${auth.userId} and deleted_at is null
		returning id, slug, name, description, kind, format, duration_ms, frame_count,
		          fps, loop, tags, visibility, avatar_id, price_amount, price_currency,
		          listed, created_at, updated_at
	`;
	if (!row) return error(res, 404, 'not_found', 'animation not found or not yours');
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
		update animation_clips
		set deleted_at = now()
		where id = ${id} and owner_id = ${auth.userId} and deleted_at is null
		returning id
	`;
	if (!row) return error(res, 404, 'not_found', 'animation not found or not yours');
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
