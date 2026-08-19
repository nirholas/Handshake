// Private module: agent sub-resource handlers dispatched from [id].js.
// Not a Vercel function (underscore prefix). Handlers accept (req, res, id).

import { verifyMessage } from 'ethers';
import { Wallet } from 'ethers';
import { z } from 'zod';
import { sql } from '../../_lib/db.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../../_lib/auth.js';
import { cors, json, method, readJson, wrap, error, rateLimited } from '../../_lib/http.js';
import { limits, clientIp } from '../../_lib/rate-limit.js';
import { requireCsrf } from '../../_lib/csrf.js';
import { parse } from '../../_lib/validate.js';
import { recoverAgentKey } from '../../_lib/agent-wallet.js';
import { readEmbedPolicy, validateEmbedPolicy } from '../../_lib/embed-policy.js';
import { resolveAvatarUrl } from '../../_lib/avatars.js';
import { buildAgentRegistrationMetadata } from '../../_lib/three-brand.js';
import { thumbnailUrl } from '../../_lib/r2.js';
// The one source of truth for the gesture slot vocabulary. Dependency-free, so
// importing the runtime module here keeps the API and the browser in agreement
// instead of restating the list.
import { SLOTS } from '../../../src/runtime/animation-slots.js';
// Same reasoning for gesture routines: the studio, the avatar runtime and this
// handler share one definition of a valid routine instead of three.
import { normalizeRoutines, MAX_ROUTINES } from '../../../src/runtime/choreography.js';

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

	const [agent] =
		await sql`SELECT id, user_id, name, wallet_address FROM agent_identities WHERE id = ${id} AND deleted_at IS NULL`;
	if (!agent) return error(res, 404, 'not_found', 'agent not found');
	if (!userId || agent.user_id !== userId)
		return error(res, 403, 'forbidden', 'not authorized to view this agent');

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
				const recovered = verifyMessage(
					JSON.stringify(row.payload) + row.created_at.toISOString(),
					row.signature,
				);
				verified = recovered.toLowerCase() === row.signer_address.toLowerCase();
			} catch {
				verified = false;
			}
		}
		return {
			id: String(row.id),
			type: row.type,
			payload: row.payload,
			sourceSkill: row.source_skill,
			timestamp: row.created_at.toISOString(),
			signature: row.signature || null,
			signer: row.signer_address || null,
			verified,
		};
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
	url: z
		.string()
		.trim()
		.min(1)
		.max(2048)
		.refine(
			(u) => /^(https?|ipfs|ar):\/\//.test(u) || u.startsWith('/') || /^u\//.test(u),
			'url must be http, https, ipfs, ar, root-relative, or storage key',
		),
	loop: z.boolean().default(true),
	clipName: z.string().trim().max(120).optional(),
	source: z.enum(['mixamo', 'preset', 'custom']),
	addedAt: z.string().optional(),
});

// Animation state machine — optional graph stored alongside the flat clip
// list. The runtime AnimationStateMachine fills in defaults for any state
// not explicitly mapped here; the editor only persists overrides.
const animationStateSchema = z
	.object({
		clip: z.string().trim().min(1).max(60).optional(),
		loop: z.boolean().optional(),
		crossfade: z.number().min(0).max(5).optional(),
		oneShot: z.boolean().optional(),
		returnTo: z.string().trim().min(1).max(40).nullable().optional(),
	})
	.strict();

const animationGraphSchema = z
	.object({
		states: z.record(animationStateSchema).optional(),
		transitions: z.record(z.string().trim().min(1).max(40)).optional(),
		initial: z.string().trim().min(1).max(40).optional(),
	})
	.strict();

// Gesture slot overrides: { slot: clipName }, persisted at meta.edits.animations,
// which is where src/agent-avatar.js reads an agent's per-slot bindings from.
// Keys are restricted to the fixed vocabulary (src/runtime/animation-slots.js) so
// a typo cannot create a slot nothing will ever play; values are clip names,
// deliberately not restricted to the platform manifest so an agent can point a
// slot at one of its own uploaded clips. An empty object clears every override.
const animationSlotsSchema = z
	.record(
		z.enum(/** @type {[string, ...string[]]} */ (SLOTS)),
		z
			.string()
			.trim()
			.min(1)
			.max(60)
			.regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'clip name must be alphanumeric with - or _'),
	)
	.refine((map) => Object.keys(map).length <= SLOTS.length, 'too many slot overrides');

// Choreographies: named, timed gesture routines, persisted at
// meta.choreographies and served to embeds in the public manifest. Validation
// is delegated to the same runtime module the studio and the avatar use
// (src/runtime/choreography.js) rather than restated in zod, so a routine the
// browser can build is exactly a routine the server will store. An empty array
// clears them.
const choreographiesSchema = z.array(z.unknown()).max(MAX_ROUTINES).transform((list, ctx) => {
	try {
		return normalizeRoutines(list);
	} catch (err) {
		ctx.addIssue({ code: z.ZodIssueCode.custom, message: err.message });
		return z.NEVER;
	}
});

// Every field is optional and every one follows the same rule: present means
// "replace this", absent means "leave it alone". `animations` used to be
// required, which meant a caller changing one gesture slot had to resend the
// agent's whole clip list, and sending `[]` (the obvious thing when you do not
// use the list) silently wiped it.
const animationsBodySchema = z
	.object({
		animations: z.array(animationEntrySchema).max(30).optional(),
		animationGraph: animationGraphSchema.optional(),
		animationSlots: animationSlotsSchema.optional(),
		choreographies: choreographiesSchema.optional(),
	})
	.refine(
		(b) =>
			b.animations !== undefined ||
			b.animationGraph !== undefined ||
			b.animationSlots !== undefined ||
			b.choreographies !== undefined,
		'send at least one of animations, animationGraph, animationSlots, choreographies',
	);

export const handleAnimations = wrap(async (req, res, id) => {
	if (cors(req, res, { methods: 'PUT,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['PUT'])) return;

	const auth = await resolveAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in required');

	// CSRF on state-changing session-cookie requests; bearer tokens are exempt.
	if (!(await requireCsrf(req, res, auth.userId))) return;

	const [existing] =
		await sql`SELECT id, user_id FROM agent_identities WHERE id = ${id} AND deleted_at IS NULL`;
	if (!existing) return error(res, 404, 'not_found', 'agent not found');
	if (existing.user_id !== auth.userId) return error(res, 403, 'forbidden', 'not your agent');

	const rawBody = await readJson(req);
	let parsed;
	try {
		parsed = animationsBodySchema.parse(rawBody);
	} catch (err) {
		if (err.name === 'ZodError')
			return error(res, 400, 'validation_error', err.errors[0]?.message || 'invalid body', {
				fields: err.errors,
			});
		throw err;
	}

	// Only touch meta.animationGraph when the request actually carries the
	// field, so saving the clip-array on its own doesn't clobber an existing
	// graph. `null` is a valid explicit "remove the graph" signal. Same rule for
	// the slot overrides at meta.edits.animations: absent means "leave alone",
	// `{}` means "clear them".
	const has = (key) => Object.prototype.hasOwnProperty.call(rawBody || {}, key);
	if (has('animations')) {
		await sql`
			UPDATE agent_identities
			SET meta = jsonb_set(COALESCE(meta, '{}'::jsonb), '{animations}', ${JSON.stringify(parsed.animations)}::jsonb, true)
			WHERE id = ${id}
		`;
	}
	if (has('animationGraph')) {
		await sql`
			UPDATE agent_identities
			SET meta = jsonb_set(COALESCE(meta, '{}'::jsonb), '{animationGraph}',
				${parsed.animationGraph ? JSON.stringify(parsed.animationGraph) : 'null'}::jsonb, true)
			WHERE id = ${id}
		`;
	}
	if (has('animationSlots')) {
		// jsonb_set cannot create the intermediate {edits} object, so seed it first
		// for agents that have never carried one.
		await sql`
			UPDATE agent_identities
			SET meta = jsonb_set(
				CASE WHEN COALESCE(meta, '{}'::jsonb) ? 'edits'
					THEN COALESCE(meta, '{}'::jsonb)
					ELSE jsonb_set(COALESCE(meta, '{}'::jsonb), '{edits}', '{}'::jsonb, true)
				END,
				'{edits,animations}', ${JSON.stringify(parsed.animationSlots ?? {})}::jsonb, true)
			WHERE id = ${id}
		`;
	}

	if (has('choreographies')) {
		await sql`
			UPDATE agent_identities
			SET meta = jsonb_set(COALESCE(meta, '{}'::jsonb), '{choreographies}',
				${JSON.stringify(parsed.choreographies ?? [])}::jsonb, true)
			WHERE id = ${id}
		`;
	}

	// Read back what is actually stored so the response cannot drift from the row,
	// and so a partial update still reports the fields it did not touch.
	const [row] = await sql`
		SELECT meta->'animations' AS animations,
		       meta->'animationGraph' AS graph,
		       meta->'edits'->'animations' AS slots,
		       meta->'choreographies' AS choreographies
		FROM agent_identities WHERE id = ${id}
	`;
	return json(res, 200, {
		animations: row?.animations ?? [],
		animationGraph: row?.graph ?? null,
		animationSlots: row?.slots ?? null,
		choreographies: row?.choreographies ?? [],
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

	// CSRF on state-changing session-cookie requests (PUT/DELETE reach here).
	if (!(await requireCsrf(req, res, session.id))) return;

	const [existing] =
		await sql`SELECT id, user_id FROM agent_identities WHERE id = ${id} AND deleted_at IS NULL`;
	if (!existing) return error(res, 404, 'not_found', 'agent not found');
	if (existing.user_id !== session.id) return error(res, 403, 'forbidden', 'not your agent');

	if (req.method === 'DELETE') {
		await sql`UPDATE agent_identities SET embed_policy = NULL WHERE id = ${id}`;
		return json(res, 200, { policy: null });
	}

	let normalized;
	try {
		normalized = validateEmbedPolicy(await readJson(req));
	} catch (err) {
		if (err.name === 'ZodError')
			return error(res, 400, 'validation_error', err.errors[0]?.message || 'invalid policy', {
				fields: err.errors,
			});
		throw err;
	}

	const [updated] =
		await sql`UPDATE agent_identities SET embed_policy = ${JSON.stringify(normalized)}::jsonb WHERE id = ${id} RETURNING embed_policy`;
	return json(res, 200, { policy: updated.embed_policy });
});

// ── manifest ──────────────────────────────────────────────────────────────────

export const handleManifest = wrap(async (req, res, id) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: false })) return;
	if (!method(req, res, ['GET'])) return;

	if (!/^[0-9a-f-]{36}$/i.test(id))
		return error(res, 400, 'invalid_request', 'agent id required');

	const [row] =
		await sql`select a.id, a.name, a.description, a.avatar_id, a.skills, a.meta, a.chain_id, a.erc8004_agent_id, a.erc8004_registry, a.registration_cid, a.created_at, a.voice_provider, a.voice_id, a.persona_prompt_hash, a.persona_tone_tags, a.persona_extracted_at, a.persona_traits, av.id as avatar_db_id, av.storage_key, av.content_type from agent_identities a left join avatars av on av.id = a.avatar_id and av.deleted_at is null where a.id = ${id} and a.deleted_at is null limit 1`;
	if (!row) return error(res, 404, 'not_found', 'agent not found');

	// Live signal: whether the agent has claimed its activation grant (funded +
	// on the Money Pulse). Lets other agents/SDKs prefer live counterparts. Cheap
	// indexed PK lookup; tolerant of the table not being migrated yet.
	let activated = false;
	let activatedAt = null;
	try {
		const [act] = await sql`select confirmed_at from agent_activations where agent_id = ${id} and status = 'confirmed' limit 1`;
		if (act) {
			activated = true;
			activatedAt = act.confirmed_at;
		}
	} catch (e) {
		if (e?.code !== '42P01') console.warn('[manifest] activation lookup failed', e?.message);
	}

	let bodyUri = '';
	if (row.avatar_db_id) {
		try {
			const urlInfo = await resolveAvatarUrl({
				storage_key: row.storage_key,
				visibility: 'public',
			});
			bodyUri = urlInfo?.url || '';
		} catch {}
	}

	const proto = req.headers['x-forwarded-proto'] || 'https';
	const host = req.headers['x-forwarded-host'] || req.headers.host || 'three.ws';
	const origin = process.env.PUBLIC_APP_ORIGIN?.replace(/\/$/, '') || `${proto}://${host}`;

	// Interview provenance counts. persona_traits.interview carries the full
	// record (including the owner's raw answers), but the public manifest only
	// ever reports the counts and the source, never the answers themselves.
	const interviewRaw =
		row.persona_traits && typeof row.persona_traits === 'object'
			? row.persona_traits.interview
			: null;
	const interview =
		interviewRaw && typeof interviewRaw === 'object'
			? {
					source: typeof interviewRaw.source === 'string' ? interviewRaw.source : null,
					questions_answered: Number.isFinite(interviewRaw.questions_answered)
						? interviewRaw.questions_answered
						: Array.isArray(interviewRaw.answers)
							? interviewRaw.answers.length
							: 0,
					questions_total: Number.isFinite(interviewRaw.questions_total)
						? interviewRaw.questions_total
						: null,
				}
			: null;

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
		homeUrl: `${origin}/agents/${row.id}`,
		registrations:
			row.chain_id && row.erc8004_agent_id
				? [
						{
							agentRegistry: `eip155:${row.chain_id}:${row.erc8004_registry}`,
							agentId: row.erc8004_agent_id,
						},
					]
				: [],
		voice: row.voice_id
			? { provider: row.voice_provider || 'elevenlabs', voice_id: row.voice_id }
			: { provider: 'browser' },
		persona: {
			has_persona: Boolean(row.persona_prompt_hash),
			tone_tags: row.persona_tone_tags || [],
			extracted_at: row.persona_extracted_at || null,
			// Present only when the agent's voice came from an onboarding
			// interview. Counts and source only; the answers stay private.
			...(interview ? { interview } : {}),
		},
		// Gesture slot overrides, so an embed plays this agent's own body language
		// rather than the platform defaults. Only present when the owner set some
		// (PUT /api/agents/:id/animations with animationSlots); consumers fall back
		// to DEFAULT_ANIMATION_MAP when it is absent.
		animationSlots:
			row.meta?.edits?.animations && Object.keys(row.meta.edits.animations).length
				? row.meta.edits.animations
				: undefined,
		// Named gesture routines (/choreograph). Shipped alongside the slot map so
		// an embed can play a whole performance by name — `el.playRoutine('welcome')`
		// — without a second round trip. Absent when the agent has none.
		choreographies: Array.isArray(row.meta?.choreographies) && row.meta.choreographies.length
			? row.meta.choreographies
			: undefined,
		// Live signal — funded + active on the Money Pulse via the activation grant.
		activated,
		activatedAt,
		createdAt: row.created_at,
	};

	return json(res, 200, manifest, {
		'cache-control': 'public, max-age=60, s-maxage=300, stale-while-revalidate=86400',
		'access-control-allow-origin': '*',
	});
});

// ── registration (Metaplex / EIP-8004 agent registry document) ─────────────────

// Public EIP-8004 registration-v1 document for the agent. This is the URI the
// agent's on-chain Agent Identity PDA (Metaplex Agent Registry) points at — the
// program has no instruction to change the URI after registration, so it must be
// a stable, MUTABLE endpoint: serving it live keeps `active`, services, the 3D
// model, and any future token link current without re-registering on-chain.
export const handleRegistration = wrap(async (req, res, id) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: false })) return;
	if (!method(req, res, ['GET'])) return;

	if (!/^[0-9a-f-]{36}$/i.test(id))
		return error(res, 400, 'invalid_request', 'agent id required');

	const [row] =
		await sql`select a.id, a.name, a.description, a.skills, a.deleted_at, a.chain_id, a.erc8004_agent_id, a.erc8004_registry, av.id as avatar_db_id, av.storage_key, av.thumbnail_key, av.content_type from agent_identities a left join avatars av on av.id = a.avatar_id and av.deleted_at is null where a.id = ${id} and a.deleted_at is null limit 1`;
	if (!row) return error(res, 404, 'not_found', 'agent not found');

	let modelUri = '';
	if (row.avatar_db_id) {
		try {
			const u = await resolveAvatarUrl({
				storage_key: row.storage_key,
				visibility: 'public',
			});
			modelUri = u?.url || '';
		} catch {}
	}
	// This document is what the agent's on-chain URI resolves to, so the image has
	// to survive forever: thumbnailUrl() drops a legacy origin-pointing `*_og.png`
	// key rather than publishing a URL that answers 404.
	const image = thumbnailUrl(row.thumbnail_key) || '';

	const proto = req.headers['x-forwarded-proto'] || 'https';
	const host = req.headers['x-forwarded-host'] || req.headers.host || 'three.ws';
	const origin = process.env.PUBLIC_APP_ORIGIN?.replace(/\/$/, '') || `${proto}://${host}`;

	const doc = buildAgentRegistrationMetadata({
		agentId: row.id,
		name: row.name || 'Agent',
		description: row.description || '',
		image,
		modelUri,
		modelFormat: row.content_type || 'gltf-binary',
		agentUrl: `${origin}/agents/${row.id}`,
		origin,
		skills: Array.isArray(row.skills) ? row.skills : [],
		erc8004:
			row.chain_id && row.erc8004_agent_id
				? {
						chainId: row.chain_id,
						agentId: row.erc8004_agent_id,
						registry: row.erc8004_registry,
					}
				: null,
	});

	return json(res, 200, doc, {
		'cache-control': 'public, max-age=60, s-maxage=300, stale-while-revalidate=86400',
		'access-control-allow-origin': '*',
	});
});

// ── sign ──────────────────────────────────────────────────────────────────────

const signBody = z.object({
	message: z.string().min(1).max(8192),
	kind: z.enum(['personal']).default('personal'),
});

export const handleSign = wrap(async (req, res, id) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const auth = await resolveAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in required');

	// CSRF on state-changing session-cookie requests; bearer tokens are exempt.
	if (!(await requireCsrf(req, res, auth.userId))) return;

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl, 'too many sign requests');

	const [row] =
		await sql`SELECT id, user_id, wallet_address, meta FROM agent_identities WHERE id = ${id} AND deleted_at IS NULL LIMIT 1`;
	if (!row) return error(res, 404, 'not_found', 'agent not found');
	if (row.user_id !== auth.userId) return error(res, 403, 'forbidden', 'not your agent');

	const encryptedKey = row.meta?.encrypted_wallet_key;
	if (!encryptedKey) return error(res, 409, 'no_wallet', 'agent has no server wallet');

	const body = parse(signBody, await readJson(req));

	let signature;
	try {
		const pkHex = await recoverAgentKey(encryptedKey, {
			agentId: row.id,
			userId: auth.userId,
			reason: 'sign_message',
		});
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

	const [agent] =
		await sql`SELECT id FROM agent_identities WHERE id = ${id} AND user_id = ${session.id} AND deleted_at IS NULL`;
	if (!agent) return error(res, 404, 'not_found', 'agent not found');

	const policy = await readEmbedPolicy(id);
	const monthlyQuota = policy?.brain?.monthly_quota ?? null;

	const [monthRow] =
		await sql`SELECT COUNT(*)::int AS total FROM usage_events WHERE agent_id = ${id} AND kind = 'llm' AND created_at >= date_trunc('month', now())`;
	const dailyRows =
		await sql`SELECT date_trunc('day', created_at)::date AS day, COUNT(*)::int AS calls FROM usage_events WHERE agent_id = ${id} AND kind = 'llm' AND created_at >= now() - interval '30 days' GROUP BY 1 ORDER BY 1`;

	return json(res, 200, {
		agentId: id,
		monthlyQuota,
		currentMonthCalls: monthRow?.total ?? 0,
		dailyBreakdown: dailyRows.map((r) => ({ day: r.day, calls: r.calls })),
	});
});

// ── memories ──────────────────────────────────────────────────────────────────

const memoryBodySchema = z.object({
	type: z.enum(['user', 'feedback', 'project', 'reference']),
	content: z.string().trim().min(1).max(4000),
	tags: z.array(z.string().trim().max(100)).max(20).optional().default([]),
	salience: z.number().min(0).max(1).optional(),
	expiresAt: z.string().datetime().optional().nullable(),
	isPublic: z.boolean().optional().default(false),
});

const memoryPatchSchema = z.object({
	isPublic: z.boolean(),
});

export const handleMemories = wrap(async (req, res, id, memoryId) => {
	if (cors(req, res, { methods: 'GET,POST,PATCH,DELETE,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'POST', 'PATCH', 'DELETE'])) return;

	const session = await getSessionUser(req);
	const bearer = session ? null : await authenticateBearer(extractBearer(req));
	const userId = session?.id ?? bearer?.userId;

	// Public embeds hydrate on every page load. For anonymous GETs, return
	// an empty list rather than 401 to keep the console clean — only the
	// owner ever sees memory rows.
	if (req.method === 'GET' && !userId) return json(res, 200, { data: [] });
	if (!userId) return error(res, 401, 'unauthorized', 'sign in required');

	const [agent] =
		await sql`SELECT id FROM agent_identities WHERE id = ${id} AND user_id = ${userId} AND deleted_at IS NULL`;
	if (!agent) {
		if (req.method === 'GET') return json(res, 200, { data: [] });
		return error(res, 404, 'not_found', 'agent not found');
	}

	if (req.method === 'GET') {
		const rows = await sql`
			SELECT id, type, content, tags, salience, expires_at, created_at, is_public
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

	// PATCH /memories/:id — toggle a single memory's public visibility. Scoped
	// to this agent so a caller can't flip a memory belonging to another agent.
	if (req.method === 'PATCH') {
		if (!memoryId) return error(res, 400, 'bad_request', 'memory id required');
		const body = parse(memoryPatchSchema, await readJson(req));
		const [row] = await sql`
			UPDATE agent_memories
			SET is_public = ${body.isPublic}
			WHERE id = ${memoryId} AND agent_id = ${id}
			RETURNING id, is_public
		`;
		if (!row) return error(res, 404, 'not_found', 'memory not found');
		return json(res, 200, { id: row.id, isPublic: row.is_public });
	}

	// POST
	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const body = parse(memoryBodySchema, await readJson(req));
	const [row] = await sql`
		INSERT INTO agent_memories (id, agent_id, type, content, tags, salience, expires_at, is_public)
		VALUES (gen_random_uuid(), ${id}, ${body.type}, ${body.content}, ${body.tags}, ${body.salience ?? 0.5}, ${body.expiresAt ?? null}, ${body.isPublic})
		RETURNING id
	`;
	return json(res, 201, { id: row.id });
});
