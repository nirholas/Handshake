// GET  /api/animations/clips   — list (caller's own + ?include_public=true)
// POST /api/animations/clips   — create from a baked THREE.AnimationClip.toJSON()
//
// The stored clip is the JSON-serialized output of THREE.AnimationClip.toJSON()
// (canonical Avaturn/Mixamo bone track names, e.g. "Hips.quaternion") — the
// exact format AnimationManager plays everywhere on three.ws. We also persist
// the editable keyframe document (`editor_doc`) so the studio can reopen a saved
// clip and continue editing losslessly.
//
// Mirrors api/mocap/clips.js for auth, ownership, slugs, visibility, pagination.

import { getSessionUser, authenticateBearer, extractBearer, hasScope } from '../_lib/auth.js';
import { sql } from '../_lib/db.js';
import { cors, json, method, readJson, wrap, error } from '../_lib/http.js';
import { putObject, publicUrl } from '../_lib/r2.js';
import { limits } from '../_lib/rate-limit.js';
import { z } from 'zod';

const FORMAT = 'three.ws.animation.v1';
const MAX_BYTES_INLINE = 1_500_000; // 1.5 MB JSONB inline cap; larger → R2 offload
const MAX_TRACKS = 512;

const slugRe = /^[a-z0-9][a-z0-9-]{0,79}$/;

// A baked THREE.AnimationClip.toJSON(): { name, duration, tracks: [{ name, type, times, values }] }.
const trackSchema = z.object({
	name: z.string().min(1).max(128),
	type: z.string().min(1).max(32),
	times: z.array(z.number()).max(200_000),
	values: z.array(z.number()).max(4_000_000),
});
const clipSchema = z.object({
	name: z.string().trim().min(1).max(120),
	duration: z.number().nonnegative().max(3600),
	tracks: z.array(trackSchema).min(1).max(MAX_TRACKS),
});

// The editable keyframe document the studio round-trips (src/pose-animation.js).
const editorDocSchema = z.object({
	name: z.string().max(120).optional(),
	duration: z.number().nonnegative().max(3600),
	fps: z.number().int().min(1).max(240).optional(),
	loop: z.boolean().optional(),
	keyframes: z.array(z.object({
		id: z.string().max(64).optional(),
		time: z.number().nonnegative(),
		easing: z.string().max(32).optional(),
		pose: z.object({
			bones: z.record(z.string(), z.array(z.number())),
			rootPosition: z.object({ x: z.number(), y: z.number(), z: z.number() }).partial().optional(),
		}),
	})).max(2000),
});

const createSchema = z.object({
	name: z.string().trim().min(1).max(120),
	slug: z.string().trim().regex(slugRe).optional(),
	description: z.string().trim().max(2000).optional(),
	avatar_id: z.string().uuid().optional(),
	tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
	visibility: z.enum(['private', 'unlisted', 'public']).optional(),
	kind: z.enum(['animation', 'loop', 'sequence']).optional(),
	fps: z.number().int().min(1).max(240).optional(),
	loop: z.boolean().optional(),
	clip: clipSchema,
	editor_doc: editorDocSchema.optional(),
});

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	const auth = await resolveAuth(req, req.method === 'GET' ? 'avatars:read' : 'avatars:write');
	if (req.method === 'POST' && !auth) {
		return error(res, 401, 'unauthorized', 'sign in or provide a valid bearer token');
	}

	if (req.method === 'GET') return handleList(req, res, auth);
	return handleCreate(req, res, auth);
});

async function handleList(req, res, auth) {
	const url = new URL(req.url, 'http://x');
	const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 100);
	const cursor = url.searchParams.get('cursor');
	const kindFilter = url.searchParams.get('kind');
	const tagFilter = url.searchParams.get('tag');
	const visFilter = url.searchParams.get('visibility');
	const includePublic = url.searchParams.get('include_public') === 'true';
	const onlyPublic = !auth;

	// Positional-parameter WHERE (the Neon client does not interpolate nested
	// sql`` fragments) — same pattern as api/mocap/clips.js / searchPublicAvatars.
	const params = [];
	const conds = ['deleted_at is null'];

	if (onlyPublic) {
		conds.push(`visibility = 'public'`);
	} else if (includePublic) {
		params.push(auth.userId);
		conds.push(`(owner_id = $${params.length} or visibility = 'public')`);
	} else {
		params.push(auth.userId);
		conds.push(`owner_id = $${params.length}`);
	}
	if (kindFilter && /^[a-z]+$/.test(kindFilter)) {
		params.push(kindFilter);
		conds.push(`kind = $${params.length}`);
	}
	if (visFilter && ['private', 'unlisted', 'public'].includes(visFilter)) {
		params.push(visFilter);
		conds.push(`visibility = $${params.length}`);
	}
	if (tagFilter) {
		params.push(tagFilter);
		conds.push(`$${params.length} = any(tags)`);
	}
	if (cursor) {
		const decoded = decodeCursor(cursor);
		if (decoded) {
			params.push(decoded.createdAt);
			conds.push(`created_at < $${params.length}`);
		}
	}
	params.push(limit + 1);

	let rows;
	try {
		rows = await sql(
			`select id, owner_id, slug, name, description, kind, format,
			        duration_ms, frame_count, fps, loop, tags, visibility,
			        thumbnail_key, price_amount, price_currency, listed,
			        play_count, purchase_count, created_at, updated_at, avatar_id
			 from animation_clips
			 where ${conds.join(' and ')}
			 order by created_at desc
			 limit $${params.length}`,
			params,
		);
	} catch (err) {
		console.error('[animations/clips/list]', err?.message || err);
		return error(res, 500, 'db_error', 'Failed to list animations');
	}

	const hasMore = rows.length > limit;
	const items = (hasMore ? rows.slice(0, limit) : rows).map((row) => listItem(row, auth));
	const nextCursor = hasMore ? encodeCursor({ createdAt: rows[limit - 1].created_at }) : null;

	res.setHeader(
		'Cache-Control',
		auth ? 'private, max-age=0' : 'public, s-maxage=60, stale-while-revalidate=300',
	);
	return json(res, 200, { items, next_cursor: nextCursor });
}

async function handleCreate(req, res, auth) {
	const rl = await limits.avatarPatch(auth.userId);
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many animation saves');

	const body = await readJson(req);
	if (!body) return error(res, 400, 'invalid_request', 'body required');
	const parsed = createSchema.safeParse(body);
	if (!parsed.success) {
		return error(res, 400, 'validation_error', parsed.error.issues.map((i) => i.message).join('; '));
	}
	const input = parsed.data;
	const clip = input.clip;

	// Every quaternion track must carry 4 floats per time sample, position 3.
	for (const t of clip.tracks) {
		const stride = /\.quaternion$/.test(t.name) ? 4 : t.name.endsWith('.position') || t.name.endsWith('.scale') ? 3 : 0;
		if (stride && t.times.length && t.values.length !== t.times.length * stride) {
			return error(res, 400, 'validation_error', `track ${t.name}: values length must be times×${stride}`);
		}
	}

	if (input.avatar_id) {
		const ok = await sql`
			select 1 from avatars
			where id = ${input.avatar_id} and owner_id = ${auth.userId} and deleted_at is null
			limit 1
		`;
		if (!ok[0]) return error(res, 404, 'not_found', 'avatar_id not owned by you');
	}

	const slug = input.slug || autoSlug(input.name);
	const dup = await sql`
		select 1 from animation_clips
		where owner_id = ${auth.userId} and slug = ${slug} and deleted_at is null
		limit 1
	`;
	if (dup[0]) return error(res, 409, 'duplicate_slug', `slug "${slug}" already exists`);

	const durationMs = Math.round(clip.duration * 1000);
	const frameCount = input.editor_doc?.keyframes?.length || clip.tracks[0]?.times?.length || 0;
	const fps = input.fps || input.editor_doc?.fps || null;
	const loop = input.loop ?? input.editor_doc?.loop ?? true;
	const kind = input.kind || (loop ? 'loop' : 'animation');
	const tags = input.tags || [];
	const visibility = input.visibility || 'private';
	const editorJson = input.editor_doc ? JSON.stringify(input.editor_doc) : null;

	// Inline small clips as JSONB; offload large ones to R2 and keep the pointer.
	const clipJson = JSON.stringify(clip);
	let inlineClip = clipJson;
	let storageKey = null;
	if (clipJson.length > MAX_BYTES_INLINE) {
		try {
			storageKey = `u/${auth.userId}/animations/clip-${slug}-${Date.now()}.json`;
			await putObject({ key: storageKey, body: clipJson, contentType: 'application/json' });
			inlineClip = null;
		} catch (err) {
			console.error('[animations/clips/create] R2 offload failed', err?.message || err);
			return error(res, 502, 'storage_error', 'Failed to store large clip');
		}
	}

	let row;
	try {
		[row] = await sql`
			insert into animation_clips (
				owner_id, avatar_id, slug, name, description, kind, format,
				duration_ms, frame_count, fps, loop, clip, storage_key, editor_doc,
				tags, visibility
			) values (
				${auth.userId}, ${input.avatar_id || null}, ${slug}, ${input.name},
				${input.description || null}, ${kind}, ${FORMAT},
				${durationMs}, ${frameCount}, ${fps}, ${loop},
				${inlineClip}::jsonb, ${storageKey}, ${editorJson}::jsonb,
				${tags}, ${visibility}
			)
			returning id, slug, name, description, kind, format, duration_ms,
			          frame_count, fps, loop, tags, visibility, avatar_id,
			          created_at, updated_at
		`;
	} catch (err) {
		console.error('[animations/clips/create]', err?.message || err);
		return error(res, 500, 'db_error', 'Failed to save animation');
	}

	return json(res, 201, { clip: row });
}

function listItem(row, auth) {
	return {
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
		owner: row.owner_id === auth?.userId ? 'self' : 'other',
		created_at: row.created_at,
		updated_at: row.updated_at,
	};
}

async function resolveAuth(req, requiredScope) {
	const session = await getSessionUser(req);
	if (session) return { userId: session.id, source: 'session' };
	const bearer = await authenticateBearer(extractBearer(req));
	if (!bearer) return null;
	if (!hasScope(bearer.scope, requiredScope)) return null;
	return bearer;
}

function autoSlug(name) {
	const base = String(name)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 60) || 'animation';
	const suffix = Math.random().toString(36).slice(2, 6);
	return `${base}-${suffix}`;
}

function encodeCursor({ createdAt }) {
	return Buffer.from(JSON.stringify({ c: createdAt })).toString('base64url');
}
function decodeCursor(cursor) {
	try {
		const obj = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
		return { createdAt: new Date(obj.c) };
	} catch {
		return null;
	}
}

// Exported for contract tests (validation/slug/cursor) without a live DB.
export const __test__ = { createSchema, clipSchema, editorDocSchema, autoSlug, encodeCursor, decodeCursor, listItem, MAX_BYTES_INLINE };
