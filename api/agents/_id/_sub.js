// Private module: agent sub-resource handlers dispatched from [id].js.
// Not a Vercel function (underscore prefix). Handlers accept (req, res, id).

import { verifyMessage } from 'ethers';
import { Wallet } from 'ethers';
import { z } from 'zod';
import { sql } from '../../_lib/db.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../../_lib/auth.js';
import { cors, json, method, readJson, wrap, error } from '../../_lib/http.js';
import { limits, clientIp } from '../../_lib/rate-limit.js';
import { parse } from '../../_lib/validate.js';
import { recoverAgentKey } from '../../_lib/agent-wallet.js';
import { readEmbedPolicy, validateEmbedPolicy } from '../../_lib/embed-policy.js';
import { resolveAvatarUrl } from '../../_lib/avatars.js';

async function resolveAuth(req) {
	const session = await getSessionUser(req);
	if (session) return { userId: session.id };
	const bearer = await authenticateBearer(extractBearer(req));
	if (bearer) return { userId: bearer.userId };
	return null;
}

// ── actions ───────────────────────────────────────────────────────────────────

export const handleActions = wrap(async (req, res, id) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (req.method !== 'GET') return error(res, 405, 'method_not_allowed', 'GET only');

	const session = await getSessionUser(req);
	const bearer = session ? null : await authenticateBearer(extractBearer(req));
	const userId = session?.id ?? bearer?.userId;

	const [agent] = await sql`SELECT id, user_id, name, wallet_address FROM agent_identities WHERE id = ${id} AND deleted_at IS NULL`;
	if (!agent) return error(res, 404, 'not_found', 'agent not found');
	if (!userId || agent.user_id !== userId) return error(res, 403, 'forbidden', 'not authorized to view this agent');

	const url = new URL(req.url, 'http://x');
	const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 200);
	const cursor = url.searchParams.get('cursor');

	// Cursor format: `<iso_timestamp>|<id>`. The `|<id>` tiebreaker prevents
	// row skipping or duplication when multiple actions share the same
	// `created_at` (sub-millisecond bursts during high-volume logging
	// previously caused either silently-dropped rows or repeated rows across
	// page boundaries because `created_at < $cursor` is not a strict total
	// order). Old cursors without a `|` keep working via the timestamp-only
	// branch below; new cursors always include the id.
	let parsedCursorTs = null;
	let parsedCursorId = null;
	if (cursor) {
		const pipe = cursor.indexOf('|');
		if (pipe > 0) {
			parsedCursorTs = cursor.slice(0, pipe);
			parsedCursorId = cursor.slice(pipe + 1);
		} else {
			parsedCursorTs = cursor;
		}
	}

	let actions;
	if (parsedCursorTs && parsedCursorId) {
		actions = await sql`
			SELECT id, type, payload, source_skill, signature, signer_address, created_at
			FROM agent_actions
			WHERE agent_id = ${id}
			  AND (created_at < ${parsedCursorTs}
			       OR (created_at = ${parsedCursorTs} AND id < ${parsedCursorId}))
			ORDER BY created_at DESC, id DESC
			LIMIT ${limit + 1}
		`;
	} else if (parsedCursorTs) {
		actions = await sql`
			SELECT id, type, payload, source_skill, signature, signer_address, created_at
			FROM agent_actions
			WHERE agent_id = ${id} AND created_at < ${parsedCursorTs}
			ORDER BY created_at DESC, id DESC
			LIMIT ${limit + 1}
		`;
	} else {
		actions = await sql`
			SELECT id, type, payload, source_skill, signature, signer_address, created_at
			FROM agent_actions
			WHERE agent_id = ${id}
			ORDER BY created_at DESC, id DESC
			LIMIT ${limit + 1}
		`;
	}

	const hasMore = actions.length > limit;
	const trimmed = hasMore ? actions.slice(0, limit) : actions;

	const decorated = trimmed.map((row) => {
		let verified = null;
		if (row.signature && row.signer_address && row.payload) {
			try {
				const recovered = verifyMessage(JSON.stringify(row.payload) + row.created_at.toISOString(), row.signature);
				verified = recovered.toLowerCase() === row.signer_address.toLowerCase();
			} catch { verified = false; }
		}
		return { id: String(row.id), type: row.type, payload: row.payload, sourceSkill: row.source_skill, timestamp: row.created_at.toISOString(), signature: row.signature || null, signer: row.signer_address || null, verified };
	});

	res.setHeader('Cache-Control', 'private, max-age=10');
	const last = trimmed[trimmed.length - 1];
	return json(res, 200, {
		actions: decorated,
		nextCursor: hasMore && last ? `${last.created_at.toISOString()}|${last.id}` : null,
	});
});

// ── animations ────────────────────────────────────────────────────────────────

const animationEntrySchema = z.object({
	name: z.string().trim().min(1).max(60),
	url: z.string().trim().min(1).max(2048).refine((u) => /^(https?|ipfs|ar):\/\//.test(u) || u.startsWith('/') || /^u\//.test(u), 'url must be http, https, ipfs, ar, root-relative, or storage key'),
	loop: z.boolean().default(true),
	clipName: z.string().trim().max(120).optional(),
	source: z.enum(['mixamo', 'preset', 'custom']),
	addedAt: z.string().optional(),
});

// Animation state machine — optional graph stored alongside the flat clip
// list. The runtime AnimationStateMachine fills in defaults for any state
// not explicitly mapped here; the editor only persists overrides.
const animationStateSchema = z.object({
	clip:      z.string().trim().min(1).max(60).optional(),
	loop:      z.boolean().optional(),
	crossfade: z.number().min(0).max(5).optional(),
	oneShot:   z.boolean().optional(),
	returnTo:  z.string().trim().min(1).max(40).nullable().optional(),
}).strict();

const animationGraphSchema = z.object({
	states:      z.record(animationStateSchema).optional(),
	transitions: z.record(z.string().trim().min(1).max(40)).optional(),
	initial:     z.string().trim().min(1).max(40).optional(),
}).strict();

const animationsBodySchema = z.object({
	animations: z.array(animationEntrySchema).max(30),
	animationGraph: animationGraphSchema.optional(),
});

export const handleAnimations = wrap(async (req, res, id) => {
	if (cors(req, res, { methods: 'PUT,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['PUT'])) return;

	const auth = await resolveAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in required');

	const [existing] = await sql`SELECT id, user_id FROM agent_identities WHERE id = ${id} AND deleted_at IS NULL`;
	if (!existing) return error(res, 404, 'not_found', 'agent not found');
	if (existing.user_id !== auth.userId) return error(res, 403, 'forbidden', 'not your agent');

	const rawBody = await readJson(req);
	let parsed;
	try { parsed = animationsBodySchema.parse(rawBody); }
	catch (err) { if (err.name === 'ZodError') return error(res, 400, 'validation_error', err.errors[0]?.message || 'invalid body', { fields: err.errors }); throw err; }

	// Only touch meta.animationGraph when the request actually carries the
	// field, so saving the clip-array on its own doesn't clobber an existing
	// graph. `null` is a valid explicit "remove the graph" signal.
	const hasGraph = Object.prototype.hasOwnProperty.call(rawBody || {}, 'animationGraph');
	if (hasGraph) {
		await sql`
			UPDATE agent_identities
			SET meta = jsonb_set(
				jsonb_set(COALESCE(meta, '{}'::jsonb), '{animations}', ${JSON.stringify(parsed.animations)}::jsonb, true),
				'{animationGraph}',
				${parsed.animationGraph ? JSON.stringify(parsed.animationGraph) : 'null'}::jsonb,
				true
			)
			WHERE id = ${id}
		`;
	} else {
		await sql`
			UPDATE agent_identities
			SET meta = jsonb_set(COALESCE(meta, '{}'::jsonb), '{animations}', ${JSON.stringify(parsed.animations)}::jsonb, true)
			WHERE id = ${id}
		`;
	}

	// Read back the persisted graph so the response reflects what's actually stored.
	const [row] = await sql`SELECT meta->'animationGraph' AS graph FROM agent_identities WHERE id = ${id}`;
	return json(res, 200, {
		animations: parsed.animations,
		animationGraph: row?.graph ?? null,
	});
});

// ── embed-policy ──────────────────────────────────────────────────────────────

export const handleEmbedPolicy = wrap(async (req, res, id) => {
	if (cors(req, res, { methods: 'GET,PUT,DELETE,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'PUT', 'DELETE'])) return;

	if (req.method === 'GET') {
		// Embed clients fetch this on every page load to gate surface/origin.
		// Treat a missing agent the same as a missing policy (fail-open) so
		// public embed contexts don't log a 404 in the console on every boot.
		const policy = await readEmbedPolicy(id);
		return json(res, 200, { policy: policy ?? null });
	}

	const session = await getSessionUser(req);
	if (!session) return error(res, 401, 'unauthorized', 'sign in required');

	const [existing] = await sql`SELECT id, user_id FROM agent_identities WHERE id = ${id} AND deleted_at IS NULL`;
	if (!existing) return error(res, 404, 'not_found', 'agent not found');
	if (existing.user_id !== session.id) return error(res, 403, 'forbidden', 'not your agent');

	if (req.method === 'DELETE') {
		await sql`UPDATE agent_identities SET embed_policy = NULL WHERE id = ${id}`;
		return json(res, 200, { policy: null });
	}

	let normalized;
	try { normalized = validateEmbedPolicy(await readJson(req)); }
	catch (err) { if (err.name === 'ZodError') return error(res, 400, 'validation_error', err.errors[0]?.message || 'invalid policy', { fields: err.errors }); throw err; }

	const [updated] = await sql`UPDATE agent_identities SET embed_policy = ${JSON.stringify(normalized)}::jsonb WHERE id = ${id} RETURNING embed_policy`;
	return json(res, 200, { policy: updated.embed_policy });
});

// ── manifest ──────────────────────────────────────────────────────────────────

export const handleManifest = wrap(async (req, res, id) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: false })) return;
	if (!method(req, res, ['GET'])) return;

	if (!/^[0-9a-f-]{36}$/i.test(id)) return error(res, 400, 'invalid_request', 'agent id required');

	const [row] = await sql`select a.id, a.name, a.description, a.avatar_id, a.skills, a.meta, a.chain_id, a.erc8004_agent_id, a.erc8004_registry, a.registration_cid, a.created_at, a.voice_provider, a.voice_id, a.persona_prompt_hash, a.persona_tone_tags, a.persona_extracted_at, av.id as avatar_db_id, av.storage_key, av.content_type from agent_identities a left join avatars av on av.id = a.avatar_id and av.deleted_at is null where a.id = ${id} and a.deleted_at is null limit 1`;
	if (!row) return error(res, 404, 'not_found', 'agent not found');

	let bodyUri = '';
	if (row.avatar_db_id) {
		try { const urlInfo = await resolveAvatarUrl({ storage_key: row.storage_key, visibility: 'public' }); bodyUri = urlInfo?.url || ''; } catch {}
	}

	const proto = req.headers['x-forwarded-proto'] || 'https';
	const host = req.headers['x-forwarded-host'] || req.headers.host || 'three.ws';
	const origin = process.env.PUBLIC_APP_ORIGIN?.replace(/\/$/, '') || `${proto}://${host}`;

	const manifest = {
		$schema: 'https://3d-agent.io/schemas/manifest/0.1.json',
		spec: 'agent-manifest/0.1',
		id: row.id,
		name: row.name || 'Agent',
		description: row.description || '',
		image: '',
		tags: Array.isArray(row.meta?.tags) ? row.meta.tags : [],
		body: bodyUri ? { uri: bodyUri, format: row.content_type || 'gltf-binary' } : undefined,
		skills: Array.isArray(row.skills) ? row.skills : [],
		homeUrl: `${origin}/agent/${row.id}`,
		registrations: row.chain_id && row.erc8004_agent_id ? [{ agentRegistry: `eip155:${row.chain_id}:${row.erc8004_registry}`, agentId: row.erc8004_agent_id }] : [],
		voice: row.voice_id
			? { provider: row.voice_provider || 'elevenlabs', voice_id: row.voice_id }
			: { provider: 'browser' },
		persona: {
			has_persona: Boolean(row.persona_prompt_hash),
			tone_tags: row.persona_tone_tags || [],
			extracted_at: row.persona_extracted_at || null,
		},
		createdAt: row.created_at,
	};

	return json(res, 200, manifest, { 'cache-control': 'public, max-age=60, s-maxage=300, stale-while-revalidate=86400', 'access-control-allow-origin': '*' });
});

// ── sign ──────────────────────────────────────────────────────────────────────

const signBody = z.object({ message: z.string().min(1).max(8192), kind: z.enum(['personal']).default('personal') });

export const handleSign = wrap(async (req, res, id) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const auth = await resolveAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in required');

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many sign requests');

	const [row] = await sql`SELECT id, user_id, wallet_address, meta FROM agent_identities WHERE id = ${id} AND deleted_at IS NULL LIMIT 1`;
	if (!row) return error(res, 404, 'not_found', 'agent not found');
	if (row.user_id !== auth.userId) return error(res, 403, 'forbidden', 'not your agent');

	const encryptedKey = row.meta?.encrypted_wallet_key;
	if (!encryptedKey) return error(res, 409, 'no_wallet', 'agent has no server wallet');

	const body = parse(signBody, await readJson(req));

	let signature;
	try {
		const pkHex = await recoverAgentKey(encryptedKey);
		signature = await new Wallet(pkHex).signMessage(body.message);
	} catch (e) {
		console.error('[agents/sign] signing failed', e);
		return error(res, 500, 'sign_failed', 'could not sign message');
	}

	return json(res, 200, { address: row.wallet_address, signature });
});

// ── usage ─────────────────────────────────────────────────────────────────────

export const handleUsage = wrap(async (req, res, id) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const session = await getSessionUser(req);
	if (!session) return error(res, 401, 'unauthorized', 'sign in required');

	const [agent] = await sql`SELECT id FROM agent_identities WHERE id = ${id} AND user_id = ${session.id} AND deleted_at IS NULL`;
	if (!agent) return error(res, 404, 'not_found', 'agent not found');

	const policy = await readEmbedPolicy(id);
	const monthlyQuota = policy?.brain?.monthly_quota ?? null;

	const [monthRow] = await sql`SELECT COUNT(*)::int AS total FROM usage_events WHERE agent_id = ${id} AND kind = 'llm' AND created_at >= date_trunc('month', now())`;
	const dailyRows = await sql`SELECT date_trunc('day', created_at)::date AS day, COUNT(*)::int AS calls FROM usage_events WHERE agent_id = ${id} AND kind = 'llm' AND created_at >= now() - interval '30 days' GROUP BY 1 ORDER BY 1`;

	return json(res, 200, { agentId: id, monthlyQuota, currentMonthCalls: monthRow?.total ?? 0, dailyBreakdown: dailyRows.map((r) => ({ day: r.day, calls: r.calls })) });
});

// ── memories ──────────────────────────────────────────────────────────────────

const memoryBodySchema = z.object({
	type: z.enum(['user', 'feedback', 'project', 'reference']),
	content: z.string().trim().min(1).max(4000),
	tags: z.array(z.string().trim().max(100)).max(20).optional().default([]),
	salience: z.number().min(0).max(1).optional(),
	expiresAt: z.string().datetime().optional().nullable(),
});

export const handleMemories = wrap(async (req, res, id, memoryId) => {
	if (cors(req, res, { methods: 'GET,POST,DELETE,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'POST', 'DELETE'])) return;

	const session = await getSessionUser(req);
	const bearer = session ? null : await authenticateBearer(extractBearer(req));
	const userId = session?.id ?? bearer?.userId;

	// Public embeds hydrate on every page load. For anonymous GETs, return
	// an empty list rather than 401 to keep the console clean — only the
	// owner ever sees memory rows.
	if (req.method === 'GET' && !userId) return json(res, 200, { data: [] });
	if (!userId) return error(res, 401, 'unauthorized', 'sign in required');

	const [agent] = await sql`SELECT id FROM agent_identities WHERE id = ${id} AND user_id = ${userId} AND deleted_at IS NULL`;
	if (!agent) {
		if (req.method === 'GET') return json(res, 200, { data: [] });
		return error(res, 404, 'not_found', 'agent not found');
	}

	if (req.method === 'GET') {
		const rows = await sql`
			SELECT id, type, content, tags, salience, expires_at, created_at
			FROM agent_memories
			WHERE agent_id = ${id}
				AND (expires_at IS NULL OR expires_at > now())
			ORDER BY created_at DESC
			LIMIT 200
		`;
		return json(res, 200, { data: rows });
	}

	if (req.method === 'DELETE') {
		if (!memoryId) return error(res, 400, 'bad_request', 'memory id required');
		await sql`DELETE FROM agent_memories WHERE id = ${memoryId} AND agent_id = ${id}`;
		return json(res, 200, { deleted: true });
	}

	// POST
	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const body = parse(memoryBodySchema, await readJson(req));
	const [row] = await sql`
		INSERT INTO agent_memories (id, agent_id, type, content, tags, salience, expires_at)
		VALUES (gen_random_uuid(), ${id}, ${body.type}, ${body.content}, ${body.tags}, ${body.salience ?? 0.5}, ${body.expiresAt ?? null})
		RETURNING id
	`;
	return json(res, 201, { id: row.id });
});
