// Walk programmatic-control API — drive a *running* /walk page from outside.
//
// An external system (another agent, a CI bot, a webhook) creates a control
// session bound to an avatar it owns, then pushes commands — move the avatar to
// a world position, trigger a gesture, make it speak, swap the environment. The
// open walk page (src/walk.js, entered with ?control=<sessionId>&ck=<token>)
// short-polls this endpoint, drains the queued commands, applies them to the
// real scene, and reports its live position back so the controller's /state read
// reflects the actual avatar.
//
// Routed via Vercel's [action] file param — one bundle, native bracket routing,
// no rewrite config:
//
//   POST /api/walk/control/session   create a session (avatar OWNER auth via
//                                     cookie/bearer) → { sessionId, controlToken,
//                                     controlUrl, expiresAt }
//   POST /api/walk/control/move      { sessionId, x, z, speed?, key? }   enqueue
//   POST /api/walk/control/gesture   { sessionId, gesture, key? }        enqueue
//   POST /api/walk/control/say       { sessionId, text, voice?, key? }   enqueue
//   POST /api/walk/control/env       { sessionId, env, key? }            enqueue
//   GET  /api/walk/control/session?sessionId=…   walk client drains the queue
//   GET  /api/walk/control/poll?sessionId=…      alias of the GET above
//   GET  /api/walk/control/state?sessionId=…     live position/animation/env
//
// Two credentials. The CREATE call is authorized as the avatar owner (a signed-in
// session cookie or a Bearer access token / API key) — only the owner of an
// avatar may open a remote-control channel to it. Every other call carries the
// opaque `controlToken` (stored only as a SHA-256 hash) as `Authorization:
// Bearer <controlToken>` OR `?ck=<controlToken>` so the walk page — which loads
// it from the URL — can poll without a header.
//
// Delivery is exactly-once: a poll claims the session's undelivered commands in
// fifo order and stamps delivered_at in the same statement, so no command is ever
// replayed across polls. Idempotency: a controller may pass `key` per (session,
// kind) so a retried push collapses onto the same row instead of duplicating.
//
// Rate limits: a coarse per-IP flood guard (60/min) plus a precise per-session
// ceiling of 60 commands/min enforced against the command table itself.

import { z } from 'zod';
import { cors, method, readJson, error, json, wrap, rateLimited } from '../../_lib/http.js';
import { parse } from '../../_lib/validate.js';
import { limits, clientIp } from '../../_lib/rate-limit.js';
import { sql } from '../../_lib/db.js';
import { sha256, randomToken } from '../../_lib/crypto.js';
import {
	getSessionUser,
	extractBearer,
	authenticateBearer,
} from '../../_lib/auth.js';

export const maxDuration = 10;

// The avatar's gesture vocabulary — kept in lockstep with GESTURE_ORDER in
// src/walk-gestures.js (the client-side source of truth). Inlined here rather
// than imported so this serverless function never pulls the Three.js-backed
// gesture/animation modules into its bundle.
const GESTURE_ORDER = Object.freeze([
	'wave', 'dance', 'sit', 'point', 'cheer', 'agree', 'disagree', 'talking',
]);

// How long a freshly-created control session stays drivable. Re-extended on each
// successful command push and on each walk-client poll, so an actively-used
// channel never expires mid-session; an abandoned one reclaims itself.
const SESSION_TTL_SEC = 60 * 60; // 1 hour

// Per-session command ceiling — the spec's "60 commands/min per session". Enforced
// against the command table (count of rows created in the trailing minute) so it
// holds across serverless instances without a Redis bucket.
const SESSION_COMMANDS_PER_MIN = 60;

// World is a disc of radius GROUND_RADIUS (12m) in src/walk.js; clamp move targets
// to just inside it so a command can't strand the avatar past the playable ground.
const WORLD_RADIUS = 11.5;

const GESTURES = new Set(GESTURE_ORDER);

// ── validation schemas ───────────────────────────────────────────────────────
const createSchema = z
	.object({
		avatarId: z.string().uuid().optional().nullable(),
		env: z.string().trim().min(1).max(64).optional().nullable(),
		label: z.string().trim().min(1).max(120).optional().nullable(),
	})
	.strict();

const sessionIdSchema = z.string().uuid();

const moveSchema = z
	.object({
		sessionId: sessionIdSchema,
		x: z.number().finite(),
		z: z.number().finite(),
		speed: z.number().finite().min(0.1).max(1).optional().nullable(),
		key: z.string().trim().min(1).max(80).optional().nullable(),
	})
	.strict();

const gestureSchema = z
	.object({
		sessionId: sessionIdSchema,
		gesture: z.string().trim().min(1).max(40),
		key: z.string().trim().min(1).max(80).optional().nullable(),
	})
	.strict();

const saySchema = z
	.object({
		sessionId: sessionIdSchema,
		text: z.string().trim().min(1).max(280),
		voice: z.boolean().optional().default(false),
		key: z.string().trim().min(1).max(80).optional().nullable(),
	})
	.strict();

const envSchema = z
	.object({
		sessionId: sessionIdSchema,
		env: z.string().trim().min(1).max(64),
		key: z.string().trim().min(1).max(80).optional().nullable(),
	})
	.strict();

// Live state reported by the walk client when it polls. Every field is validated
// on its own and a field that fails is simply dropped: an all-or-nothing parse
// meant one unexpected value (a motion name a newer client reports, a NaN from a
// half-initialised frame) silently discarded the position in the same poll, and
// /state then served a stale avatar with no error anywhere to explain it.
const pollFieldSchemas = {
	x: z.number().finite(),
	z: z.number().finite(),
	facing: z.number().finite(),
	motion: z.enum(['idle', 'walk', 'run']),
	env: z.string().trim().min(1).max(64),
};

function parsePollState(raw) {
	const state = {};
	for (const [key, schema] of Object.entries(pollFieldSchemas)) {
		if (raw[key] === undefined) continue;
		const parsed = schema.safeParse(raw[key]);
		if (parsed.success) state[key] = parsed.data;
	}
	return state;
}

// ── auth helpers ─────────────────────────────────────────────────────────────

// Resolve the signed-in / bearer user for the privileged CREATE call.
async function resolveOwner(req) {
	const bearer = extractBearer(req);
	if (bearer) {
		const user = await authenticateBearer(bearer);
		if (user?.userId) return user.userId;
	}
	const sessionUser = await getSessionUser(req);
	return sessionUser?.id || null;
}

// Pull the controlToken from `Authorization: Bearer …` (controllers) or the
// `?ck=` query param (the walk page, which only has the URL). Returns null if
// neither carries one.
function extractControlToken(req, url) {
	const bearer = extractBearer(req);
	if (bearer) return bearer;
	const ck = url.searchParams.get('ck');
	return ck ? ck.trim() : null;
}

// Load the session a controlToken authorizes, or null. Expired sessions never
// resolve — and are reaped lazily here so the table self-cleans on access.
async function sessionForToken(token) {
	if (!token) return null;
	const hash = await sha256(token);
	const rows = await sql`
		select id, owner_id, avatar_id, env_id, pos_x, pos_z, facing, motion,
		       current_env, client_seen_at, created_at, expires_at
		from walk_control_sessions
		where token_hash = ${hash}
		limit 1
	`;
	const s = rows[0];
	if (!s) return null;
	if (new Date(s.expires_at) <= new Date()) {
		// Lazy reclaim of an expired channel; commands cascade-delete.
		await sql`delete from walk_control_sessions where id = ${s.id}`;
		return null;
	}
	return s;
}

// Bump a session's TTL whenever it is actively used (push or poll).
async function touchSession(sessionId) {
	await sql`
		update walk_control_sessions
		set expires_at = now() + ${`${SESSION_TTL_SEC} seconds`}::interval
		where id = ${sessionId}
	`;
}

// ── command enqueue ──────────────────────────────────────────────────────────

// Enqueue one command for a session, enforcing the per-session/min ceiling and
// the optional (session, kind, key) idempotency collapse. Returns the row.
async function enqueue(res, sessionId, kind, payload, dedupKey) {
	// Precise per-session rate limit: count rows created in the trailing minute.
	const [{ n }] = await sql`
		select count(*)::int as n
		from walk_control_commands
		where session_id = ${sessionId} and created_at > now() - interval '1 minute'
	`;
	if (n >= SESSION_COMMANDS_PER_MIN) {
		return rateLimited(
			res,
			{ limit: SESSION_COMMANDS_PER_MIN, remaining: 0, reset: Date.now() + 60_000 },
			`session command rate limit (${SESSION_COMMANDS_PER_MIN}/min) exceeded`,
		);
	}

	// Idempotent push: a retried call with the same (session, kind, key) returns
	// the original row instead of enqueuing a duplicate. seq is monotonic per
	// session via a max()+1 in the same insert.
	const rows = dedupKey
		? await sql`
			insert into walk_control_commands (session_id, seq, kind, payload, dedup_key)
			values (
				${sessionId},
				coalesce((select max(seq) from walk_control_commands where session_id = ${sessionId}), 0) + 1,
				${kind},
				${JSON.stringify(payload)}::jsonb,
				${dedupKey}
			)
			on conflict (session_id, kind, dedup_key) where dedup_key is not null
			do update set payload = excluded.payload
			returning id, seq, kind, created_at
		`
		: await sql`
			insert into walk_control_commands (session_id, seq, kind, payload)
			values (
				${sessionId},
				coalesce((select max(seq) from walk_control_commands where session_id = ${sessionId}), 0) + 1,
				${kind},
				${JSON.stringify(payload)}::jsonb
			)
			returning id, seq, kind, created_at
		`;
	await touchSession(sessionId);
	const cmd = rows[0];
	return json(res, 202, {
		ok: true,
		command: { id: String(cmd.id), seq: Number(cmd.seq), kind: cmd.kind },
	});
}

// Resolve the controlToken-authorized session for a write/read, or write a 401.
// Returns the session row, or null (response already sent).
async function requireSession(req, res, url) {
	const token = extractControlToken(req, url);
	const session = await sessionForToken(token);
	if (!session) {
		error(res, 401, 'invalid_control_token', 'missing, invalid, or expired control token');
		return null;
	}
	return session;
}

// ── handlers ─────────────────────────────────────────────────────────────────

async function handleCreate(req, res) {
	const ownerId = await resolveOwner(req);
	if (!ownerId) {
		return error(res, 401, 'unauthorized', 'sign in or present a bearer token to open a control session');
	}

	const raw = await readJson(req).catch(() => ({}));
	const body = parse(createSchema, raw || {});

	// If an avatarId is supplied it must belong to the caller — a control channel
	// may only be opened against an avatar the owner controls.
	let avatarId = null;
	if (body.avatarId) {
		const rows = await sql`
			select id from avatars
			where id = ${body.avatarId} and owner_id = ${ownerId} and deleted_at is null
			limit 1
		`;
		if (!rows[0]) {
			return error(res, 403, 'forbidden', 'avatar not found or not owned by you');
		}
		avatarId = rows[0].id;
	}

	const controlToken = randomToken(32);
	const tokenHash = await sha256(controlToken);
	const rows = await sql`
		insert into walk_control_sessions (owner_id, avatar_id, token_hash, label, env_id, expires_at)
		values (
			${ownerId}, ${avatarId}, ${tokenHash}, ${body.label || null}, ${body.env || null},
			now() + ${`${SESSION_TTL_SEC} seconds`}::interval
		)
		returning id, expires_at
	`;
	const session = rows[0];

	// The deep link the walk page opens to enter control mode. Relative so it
	// resolves against whatever host serves the API (prod or preview).
	const qs = new URLSearchParams({ control: session.id, ck: controlToken });
	if (avatarId) qs.set('avatar', avatarId);
	if (body.env) qs.set('env', body.env);
	const controlUrl = `/walk?${qs.toString()}`;

	return json(res, 201, {
		ok: true,
		sessionId: session.id,
		controlToken,
		controlUrl,
		expiresAt: session.expires_at,
		gestures: [...GESTURE_ORDER],
	});
}

async function handleMove(req, res, url) {
	const session = await requireSession(req, res, url);
	if (!session) return;
	const body = parse(moveSchema, await readJson(req));
	if (body.sessionId !== session.id) {
		return error(res, 403, 'session_mismatch', 'control token does not authorize this session');
	}
	// Clamp the target to the playable disc so a command can't push the avatar
	// off the ground (the client re-clamps too, but reject obviously-bad input).
	let { x, z } = body;
	const r = Math.hypot(x, z);
	if (r > WORLD_RADIUS) {
		const k = WORLD_RADIUS / r;
		x *= k;
		z *= k;
	}
	return enqueue(res, session.id, 'move', { x, z, speed: body.speed ?? null }, body.key || null);
}

async function handleGesture(req, res, url) {
	const session = await requireSession(req, res, url);
	if (!session) return;
	const body = parse(gestureSchema, await readJson(req));
	if (body.sessionId !== session.id) {
		return error(res, 403, 'session_mismatch', 'control token does not authorize this session');
	}
	const gesture = body.gesture.toLowerCase();
	if (!GESTURES.has(gesture)) {
		return error(res, 400, 'unknown_gesture', `gesture must be one of: ${[...GESTURE_ORDER].join(', ')}`, {
			gestures: [...GESTURE_ORDER],
		});
	}
	return enqueue(res, session.id, 'gesture', { gesture }, body.key || null);
}

async function handleSay(req, res, url) {
	const session = await requireSession(req, res, url);
	if (!session) return;
	const body = parse(saySchema, await readJson(req));
	if (body.sessionId !== session.id) {
		return error(res, 403, 'session_mismatch', 'control token does not authorize this session');
	}
	return enqueue(res, session.id, 'say', { text: body.text, voice: !!body.voice }, body.key || null);
}

async function handleEnv(req, res, url) {
	const session = await requireSession(req, res, url);
	if (!session) return;
	const body = parse(envSchema, await readJson(req));
	if (body.sessionId !== session.id) {
		return error(res, 403, 'session_mismatch', 'control token does not authorize this session');
	}
	return enqueue(res, session.id, 'env', { env: body.env }, body.key || null);
}

// GET /session (and its /poll alias): the walk client drains the queue. The same
// request may carry the client's live state in the query string (?x=&z=&…) so a
// single round-trip both reports position and pulls commands.
async function handlePoll(req, res, url) {
	const sessionId = url.searchParams.get('sessionId');
	if (!sessionId || !sessionIdSchema.safeParse(sessionId).success) {
		return error(res, 400, 'bad_request', 'sessionId query param (uuid) is required');
	}
	const session = await requireSession(req, res, url);
	if (!session) return;
	if (sessionId !== session.id) {
		return error(res, 403, 'session_mismatch', 'control token does not authorize this session');
	}

	// Optional live-state report folded into the poll.
	const stateRaw = {
		x: url.searchParams.has('x') ? Number(url.searchParams.get('x')) : undefined,
		z: url.searchParams.has('z') ? Number(url.searchParams.get('z')) : undefined,
		facing: url.searchParams.has('facing') ? Number(url.searchParams.get('facing')) : undefined,
		motion: url.searchParams.get('motion') || undefined,
		env: url.searchParams.get('cenv') || undefined,
	};
	const state = parsePollState(stateRaw);

	// Claim every undelivered command for this session in fifo order, stamping
	// delivered_at in the same statement so they are never handed out twice.
	const commands = await sql`
		update walk_control_commands
		set delivered_at = now()
		where id in (
			select id from walk_control_commands
			where session_id = ${session.id} and delivered_at is null
			order by seq asc
			limit 50
		)
		returning id, seq, kind, payload
	`;

	// Record the client's check-in + any reported state, and extend the TTL.
	await sql`
		update walk_control_sessions
		set client_seen_at = now(),
		    expires_at = now() + ${`${SESSION_TTL_SEC} seconds`}::interval,
		    pos_x = coalesce(${state.x ?? null}, pos_x),
		    pos_z = coalesce(${state.z ?? null}, pos_z),
		    facing = coalesce(${state.facing ?? null}, facing),
		    motion = coalesce(${state.motion ?? null}, motion),
		    current_env = coalesce(${state.env ?? null}, current_env)
		where id = ${session.id}
	`;

	return json(
		res,
		200,
		{
			ok: true,
			sessionId: session.id,
			commands: commands
				.sort((a, b) => Number(a.seq) - Number(b.seq))
				.map((c) => ({ id: String(c.id), seq: Number(c.seq), kind: c.kind, ...c.payload })),
		},
		{ 'cache-control': 'no-store' },
	);
}

// GET /state: the controller reads the avatar's live position/animation/env, as
// last reported by the walk client.
async function handleState(req, res, url) {
	const sessionId = url.searchParams.get('sessionId');
	if (!sessionId || !sessionIdSchema.safeParse(sessionId).success) {
		return error(res, 400, 'bad_request', 'sessionId query param (uuid) is required');
	}
	const session = await requireSession(req, res, url);
	if (!session) return;
	if (sessionId !== session.id) {
		return error(res, 403, 'session_mismatch', 'control token does not authorize this session');
	}

	const [{ pending }] = await sql`
		select count(*)::int as pending
		from walk_control_commands
		where session_id = ${session.id} and delivered_at is null
	`;

	const connected =
		!!session.client_seen_at &&
		Date.now() - new Date(session.client_seen_at).getTime() < 10_000;

	return json(
		res,
		200,
		{
			ok: true,
			sessionId: session.id,
			avatarId: session.avatar_id || null,
			connected,
			clientSeenAt: session.client_seen_at || null,
			expiresAt: session.expires_at,
			pendingCommands: pending,
			position: session.pos_x != null && session.pos_z != null
				? { x: session.pos_x, z: session.pos_z }
				: null,
			facing: session.facing,
			motion: session.motion || null,
			env: session.current_env || session.env_id || null,
		},
		{ 'cache-control': 'no-store' },
	);
}

// ── dispatch ─────────────────────────────────────────────────────────────────
const WRITE_ACTIONS = new Set(['move', 'gesture', 'say', 'env']);
const POLL_ACTIONS = new Set(['session', 'poll']);

export default wrap(async (req, res) => {
	// Controllers and the embedded walk page may call cross-origin, so open CORS.
	if (cors(req, res, { origins: '*', methods: 'GET,POST,OPTIONS' })) return;

	const url = new URL(req.url, 'http://x');
	const action = (req.query?.action || url.pathname.split('/').pop() || '').toLowerCase();

	// Coarse per-IP flood guard across every action (60/min).
	const ip = clientIp(req);
	const rl = await limits.irlInteractIp(ip);
	if (!rl.success) return rateLimited(res, rl, 'too many control requests from this IP');

	// CONTRACT — public, machine-readable description of the control surface so a
	// caller can discover routes, payload shapes, the gesture vocabulary, and the
	// auth model without out-of-band docs. GET only.
	if (action === 'contract') {
		if (!method(req, res, ['GET'])) return;
		return json(
			res,
			200,
			{
				name: 'walk-control',
				description:
					'Programmatically drive a running /walk avatar: create a session, push move/gesture/say/env commands, and read live state.',
				base: '/api/walk/control',
				auth: {
					create: 'avatar owner — session cookie OR Authorization: Bearer <accessToken|apiKey>',
					commands: 'control token — Authorization: Bearer <controlToken> OR ?ck=<controlToken>',
				},
				rateLimits: {
					perIp: '60 requests / minute',
					perSession: `${SESSION_COMMANDS_PER_MIN} commands / minute`,
				},
				sessionTtlSec: SESSION_TTL_SEC,
				gestures: [...GESTURE_ORDER],
				worldRadius: WORLD_RADIUS,
				endpoints: [
					{
						method: 'POST',
						path: '/session',
						auth: 'owner',
						body: { avatarId: 'uuid?', env: 'string?', label: 'string?' },
						returns: { sessionId: 'uuid', controlToken: 'string', controlUrl: 'string', expiresAt: 'iso8601' },
					},
					{
						method: 'POST',
						path: '/move',
						auth: 'control',
						body: { sessionId: 'uuid', x: 'number', z: 'number', speed: 'number(0.1-1)?', key: 'string?' },
					},
					{
						method: 'POST',
						path: '/gesture',
						auth: 'control',
						body: { sessionId: 'uuid', gesture: 'enum(gestures)', key: 'string?' },
					},
					{
						method: 'POST',
						path: '/say',
						auth: 'control',
						body: { sessionId: 'uuid', text: 'string(1-280)', voice: 'boolean?', key: 'string?' },
					},
					{
						method: 'POST',
						path: '/env',
						auth: 'control',
						body: { sessionId: 'uuid', env: 'string', key: 'string?' },
					},
					{
						method: 'GET',
						path: '/session?sessionId=…  (alias: /poll)',
						auth: 'control',
						description: 'Walk client drains queued commands; may fold live state via ?x=&z=&facing=&motion=&cenv=.',
						returns: { commands: '[{ id, seq, kind, ...payload }]' },
					},
					{
						method: 'GET',
						path: '/state?sessionId=…',
						auth: 'control',
						returns: { connected: 'boolean', position: '{x,z}|null', facing: 'number|null', motion: 'string|null', env: 'string|null', pendingCommands: 'int' },
					},
				],
				clientOptIn: '/walk?control=<sessionId>&ck=<controlToken>',
			},
			{ 'cache-control': 'public, max-age=300' },
		);
	}

	// CREATE — privileged owner auth, POST only.
	if (action === 'session' && req.method === 'POST') {
		return handleCreate(req, res);
	}

	// WRITE commands — POST only, controlToken auth.
	if (WRITE_ACTIONS.has(action)) {
		if (!method(req, res, ['POST'])) return;
		if (action === 'move') return handleMove(req, res, url);
		if (action === 'gesture') return handleGesture(req, res, url);
		if (action === 'say') return handleSay(req, res, url);
		if (action === 'env') return handleEnv(req, res, url);
	}

	// POLL / drain — GET only, controlToken auth.
	if (POLL_ACTIONS.has(action)) {
		if (!method(req, res, ['GET'])) return;
		return handlePoll(req, res, url);
	}

	// STATE — GET only, controlToken auth.
	if (action === 'state') {
		if (!method(req, res, ['GET'])) return;
		return handleState(req, res, url);
	}

	return error(res, 404, 'not_found', `unknown control action "${action}"`);
});
