// GET  /api/mocap/clips         — list (caller's own + ?include_public=true)
// POST /api/mocap/clips         — create from inline frames JSON
//
// The runtime-recorded format is the JSON object returned by FaceMocap
// .getRecording(): `{ format, duration, frames: [{ t, shapes, mat? }] }`.
// We store that whole object plus owner / visibility / tagging fields.

import { getSessionUser, authenticateBearer, extractBearer, hasScope } from '../_lib/auth.js';
import { sql } from '../_lib/db.js';
import { cors, json, method, readJson, wrap, error } from '../_lib/http.js';
import { limits } from '../_lib/rate-limit.js';
import { z } from 'zod';

const SUPPORTED_FORMATS = new Set([
	'three.ws.face-mocap.v1',
	'three.ws.pose-mocap.v1',
	'three.ws.hand-mocap.v1',
	'three.ws.vmc.v1',
]);
const FORMAT_KIND = {
	'three.ws.face-mocap.v1': 'face',
	'three.ws.pose-mocap.v1': 'pose',
	'three.ws.hand-mocap.v1': 'hand',
	'three.ws.vmc.v1': 'vmc',
};
const MAX_FRAMES_INLINE = 18_000; // 30s @ 600Hz upper bound — comfortably above realistic capture
const MAX_BYTES_INLINE = 2 * 1024 * 1024; // 2 MB JSONB inline cap

const slugRe = /^[a-z0-9][a-z0-9-]{0,79}$/;

const createSchema = z.object({
	name: z.string().trim().min(1).max(120),
	slug: z.string().trim().regex(slugRe).optional(),
	description: z.string().trim().max(2000).optional(),
	avatar_id: z.string().uuid().optional(),
	tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
	visibility: z.enum(['private', 'unlisted', 'public']).optional(),
	clip: z.object({
		format: z.string().min(1).max(64),
		duration: z.number().nonnegative().max(3600),
		frames: z.array(z.object({
			t: z.number().nonnegative(),
			shapes: z.record(z.string(), z.number()),
			mat: z.array(z.number()).length(16).optional().nullable(),
		})).max(MAX_FRAMES_INLINE),
	}),
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
	const includePublic = url.searchParams.get('include_public') === 'true';
	const onlyPublic = !auth;

	const conditions = [];
	if (onlyPublic) {
		conditions.push(sql`visibility = 'public'`);
	} else if (includePublic) {
		conditions.push(sql`(owner_id = ${auth.userId} OR visibility = 'public')`);
	} else {
		conditions.push(sql`owner_id = ${auth.userId}`);
	}
	if (kindFilter && /^[a-z]+$/.test(kindFilter)) {
		conditions.push(sql`kind = ${kindFilter}`);
	}
	if (cursor) {
		const decoded = decodeCursor(cursor);
		if (decoded) conditions.push(sql`created_at < ${decoded.createdAt}`);
	}

	const whereClause = conditions.reduce(
		(acc, c, i) => (i === 0 ? sql`where ${c}` : sql`${acc} and ${c}`),
		sql``,
	);

	const rows = await sql`
		select id, owner_id, slug, name, description, kind, format,
		       duration_ms, frame_count, tags, visibility,
		       price_amount, price_currency, play_count,
		       created_at, updated_at, avatar_id
		from mocap_clips
		${whereClause}
		and deleted_at is null
		order by created_at desc
		limit ${limit + 1}
	`;

	const hasMore = rows.length > limit;
	const items = (hasMore ? rows.slice(0, limit) : rows).map((row) => ({
		id: row.id,
		slug: row.slug,
		name: row.name,
		description: row.description,
		kind: row.kind,
		format: row.format,
		duration_ms: row.duration_ms,
		frame_count: row.frame_count,
		tags: row.tags || [],
		visibility: row.visibility,
		avatar_id: row.avatar_id,
		play_count: Number(row.play_count || 0),
		price: row.price_amount
			? { amount: String(row.price_amount), currency: row.price_currency }
			: null,
		owner: row.owner_id === auth?.userId ? 'self' : 'other',
		created_at: row.created_at,
		updated_at: row.updated_at,
	}));

	const nextCursor = hasMore
		? encodeCursor({ createdAt: rows[limit - 1].created_at })
		: null;

	res.setHeader('Cache-Control', auth ? 'private, max-age=0' : 'public, s-maxage=60, stale-while-revalidate=300');
	return json(res, 200, { items, next_cursor: nextCursor });
}

async function handleCreate(req, res, auth) {
	const rl = await limits.avatarPatch(auth.userId);
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many mocap saves');

	const body = await readJson(req);
	if (!body) return error(res, 400, 'invalid_request', 'body required');
	const parsed = createSchema.safeParse(body);
	if (!parsed.success) {
		return error(res, 400, 'validation_error', parsed.error.issues.map((i) => i.message).join('; '));
	}
	const input = parsed.data;
	const clip = input.clip;

	if (!SUPPORTED_FORMATS.has(clip.format)) {
		return error(res, 400, 'unsupported_format', `format ${clip.format} not supported`);
	}
	const kind = FORMAT_KIND[clip.format] || 'face';
	const frameJson = JSON.stringify(clip.frames);
	if (frameJson.length > MAX_BYTES_INLINE) {
		return error(
			res,
			413,
			'payload_too_large',
			`inline clip exceeds ${MAX_BYTES_INLINE} bytes; upload to R2 (not yet wired)`,
		);
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
	const dupCheck = await sql`
		select 1 from mocap_clips
		where owner_id = ${auth.userId} and slug = ${slug} and deleted_at is null
		limit 1
	`;
	if (dupCheck[0]) return error(res, 409, 'duplicate_slug', `slug "${slug}" already exists`);

	const durationMs = Math.round(clip.duration * 1000);
	const frameCount = clip.frames.length;
	const tags = input.tags || [];
	const visibility = input.visibility || 'private';

	const [row] = await sql`
		insert into mocap_clips (
			owner_id, avatar_id, slug, name, description, kind, format,
			duration_ms, frame_count, frames, tags, visibility
		) values (
			${auth.userId}, ${input.avatar_id || null}, ${slug}, ${input.name},
			${input.description || null}, ${kind}, ${clip.format},
			${durationMs}, ${frameCount}, ${frameJson}::jsonb, ${tags}, ${visibility}
		)
		returning id, slug, name, description, kind, format, duration_ms, frame_count,
		          tags, visibility, created_at, updated_at, avatar_id
	`;

	return json(res, 201, { clip: row });
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
		.slice(0, 60) || 'clip';
	// Short random suffix to dodge collisions (slug is unique per owner).
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
