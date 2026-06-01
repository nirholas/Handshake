/**
 * Agent Identity API
 * ------------------
 * GET  /api/agents           — list caller's agents
 * GET  /api/agents/me        — get or auto-create the caller's default agent
 * POST /api/agents           — create a new agent identity
 * GET  /api/agents/:id       — get one agent (public fields if not owner)
 * PUT  /api/agents/:id       — update agent (owner only)
 * DELETE /api/agents/:id     — soft-delete agent (owner only)
 * POST /api/agents/:id/wallet — link / update wallet
 * DELETE /api/agents/:id/wallet — unlink wallet
 */

import { getSessionUser, authenticateBearer, extractBearer, hasScope } from './_lib/auth.js';
import { sql } from './_lib/db.js';
import { cors, json, method, readJson, wrap, error } from './_lib/http.js';
import { requireCsrf } from './_lib/csrf.js';
import { limits, clientIp } from './_lib/rate-limit.js';
import { generateAgentWallet, generateSolanaAgentWallet } from './_lib/agent-wallet.js';
import { publicUrl } from './_lib/r2.js';
import { pingIndexNow } from './_lib/indexnow.js';
import { env } from './_lib/env.js';
import { z } from 'zod';

const animationEntrySchema = z.object({
	name: z.string().trim().min(1).max(60),
	url: z
		.string()
		.trim()
		.min(1)
		.max(2048)
		.refine(
			(u) => /^(https?|ipfs|ar):\/\//.test(u) || u.startsWith('/'),
			'url must be http, https, ipfs, ar, or a root-relative path',
		),
	loop: z.boolean().default(true),
	clipName: z.string().trim().max(120).optional(),
	source: z.enum(['mixamo', 'preset', 'custom']),
	addedAt: z.string().optional(),
});

const animationsSchema = z.array(animationEntrySchema).max(30);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	if (req.method === 'GET') return handleList(req, res);
	return handleCreate(req, res);
});

// ── List ───────────────────────────────────────────────────────────────────

async function handleList(req, res) {
	const url = new URL(req.url, 'http://x');
	const isMe = url.pathname.endsWith('/me');
	const onchainOnly = url.searchParams.get('onchain') === 'true';

	// /me is the identity bootstrap endpoint hit on every page load, including
	// by anonymous visitors. Treat any auth-resolution failure (DB hiccup,
	// missing sessions table, JWT secret unset) the same as "no auth" so the
	// client falls back to local-only identity instead of seeing a 500.
	let auth;
	try {
		auth = await resolveAuth(req);
	} catch (err) {
		if (isMe) {
			console.error('[agents/me] auth_resolve_failed', err);
			return json(res, 200, { agent: null, warning: 'auth_resolve_failed' });
		}
		throw err;
	}

	if (!auth) {
		if (isMe) return json(res, 200, { agent: null });
		return error(res, 401, 'unauthorized', 'sign in or provide a bearer token');
	}

	if (isMe) return handleGetOrCreateMe(req, res, auth);

	const text = `
		SELECT i.*,
		       a.storage_key  AS avatar_storage_key,
		       a.thumbnail_key AS avatar_thumbnail_key,
		       a.visibility   AS avatar_visibility
		  FROM agent_identities i
		  LEFT JOIN avatars a ON a.id = i.avatar_id AND a.deleted_at IS NULL
		 WHERE i.user_id = $1
		   AND i.deleted_at IS NULL
		   ${onchainOnly ? `AND (i.erc8004_agent_id IS NOT NULL OR i.meta->>'onchain' IS NOT NULL)` : ''}
		 ORDER BY i.created_at ASC
	`;
	const rows = await sql(text, [auth.userId]);
	return json(res, 200, { agents: rows.map((row) => decorate(row)) });
}

// ── Get-or-create default agent ───────────────────────────────────────────

async function handleGetOrCreateMe(req, res, auth) {
	try {
		let [agent] = await sql`
			SELECT i.*,
			       a.storage_key  AS avatar_storage_key,
			       a.thumbnail_key AS avatar_thumbnail_key,
			       a.visibility   AS avatar_visibility
			  FROM agent_identities i
			  LEFT JOIN avatars a ON a.id = i.avatar_id AND a.deleted_at IS NULL
			 WHERE i.user_id  = ${auth.userId}
			   AND i.deleted_at IS NULL
			 ORDER BY i.created_at ASC
			 LIMIT 1
		`;

		if (!agent) {
			const wallet = await generateAgentWallet();
			const sol = await generateSolanaAgentWallet();
			await sql`
				INSERT INTO agent_identities (user_id, name, skills, wallet_address, meta)
				SELECT
					${auth.userId},
					${'Agent'},
					${['greet', 'present-model', 'validate-model', 'remember', 'think']},
					${wallet.address},
					${JSON.stringify({
						encrypted_wallet_key: wallet.encrypted_key,
						solana_address: sol.address,
						encrypted_solana_secret: sol.encrypted_secret,
					})}::jsonb
				WHERE NOT EXISTS (
					SELECT 1 FROM agent_identities
					WHERE user_id = ${auth.userId} AND deleted_at IS NULL
				)
			`;
			// Re-select returns the oldest agent: if a concurrent request beat
			// us, that one wins; if both inserted (rare race during first visit),
			// the oldest is canonical and the extra row is harmless.
			[agent] = await sql`
				SELECT i.*,
				       a.storage_key  AS avatar_storage_key,
				       a.thumbnail_key AS avatar_thumbnail_key,
				       a.visibility   AS avatar_visibility
				  FROM agent_identities i
				  LEFT JOIN avatars a ON a.id = i.avatar_id AND a.deleted_at IS NULL
				 WHERE i.user_id = ${auth.userId} AND i.deleted_at IS NULL
				 ORDER BY i.created_at ASC LIMIT 1
			`;
		}

		await healStaleAvatarId(agent);
		return json(res, 200, { agent: decorate(agent) });
	} catch (err) {
		// Any failure here (missing table, wallet generation error, missing env var)
		// should not brick the client — surface null and let the UI fall back to
		// local-only identity.
		const code = err?.code || '';
		const msg = String(err?.message || '');
		const missing = code === '42P01' || /relation.*does not exist/i.test(msg);
		const warning = missing ? 'agents_table_missing' : 'agent_init_failed';
		console.error(`[agents/me] ${warning}`, err);
		return json(res, 200, { agent: null, warning });
	}
}

// ── Create ────────────────────────────────────────────────────────────────

async function handleCreate(req, res) {
	const auth = await resolveAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in or provide a bearer token');
	const scopeErr = requireScopeForMutation(auth, res, 'avatars:write');
	if (scopeErr) return scopeErr;

	const body = await readJson(req);
	const name = String(body.name || 'Agent')
		.trim()
		.slice(0, 100);

	if (!name) return error(res, 400, 'validation_error', 'name is required');

	let avatarId = null;
	if (body.avatar_id) {
		const raw = String(body.avatar_id);
		if (!UUID_RE.test(raw)) return error(res, 400, 'validation_error', 'avatar_id must be a UUID');
		const [av] = await sql`
			SELECT id FROM avatars
			 WHERE id = ${raw} AND owner_id = ${auth.userId} AND deleted_at IS NULL
			 LIMIT 1
		`;
		if (!av) return error(res, 404, 'not_found', 'avatar not found');
		avatarId = av.id;
	}

	const wallet = await generateAgentWallet();
	const sol = await generateSolanaAgentWallet();
	const meta = {
		...(body.meta || {}),
		encrypted_wallet_key: wallet.encrypted_key,
		solana_address: sol.address,
		encrypted_solana_secret: sol.encrypted_secret,
	};

	const [agent] = await sql`
		INSERT INTO agent_identities (user_id, name, description, skills, wallet_address, meta, avatar_id)
		VALUES (
			${auth.userId},
			${name},
			${body.description ? String(body.description).slice(0, 500) : null},
			${body.skills || ['greet', 'present-model', 'validate-model', 'remember', 'think']},
			${wallet.address},
			${JSON.stringify(meta)}::jsonb,
			${avatarId}
		)
		RETURNING *
	`;

	// Push the new agent's URL to IndexNow so Bing / Yandex discover it within
	// minutes instead of waiting for the next crawl. Fire-and-forget — IndexNow
	// failures must never block agent creation.
	pingIndexNow(`${env.APP_ORIGIN}/agent/${agent.id}`).catch(() => {});

	return json(res, 201, { agent: decorate(agent) });
}

// ── Get One ───────────────────────────────────────────────────────────────

export async function handleGetOne(req, res, id) {
	if (cors(req, res, { methods: 'GET,PUT,PATCH,DELETE,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'PUT', 'PATCH', 'DELETE'])) return;

	if (!UUID_RE.test(String(id || ''))) return error(res, 404, 'not_found', 'agent not found');

	if (req.method === 'GET') {
		const rl = await limits.publicIp(clientIp(req));
		if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

		// Single roundtrip: pull skill_prices as a JSON-aggregated subquery
		// instead of a follow-up SELECT. Saves a second DB hop per GET on
		// /api/agents/:id (was the dominant cost on cached pages where
		// healStaleAvatarId is a no-op).
		const [row] = await sql`
			SELECT i.*,
			       u.display_name as author_name,
			       u.avatar_url   as author_avatar,
			       a.storage_key  AS avatar_storage_key,
			       a.thumbnail_key AS avatar_thumbnail_key,
			       a.visibility   AS avatar_visibility,
			       COALESCE(
			         (SELECT jsonb_object_agg(
			                   sp.skill,
			                   jsonb_build_object(
			                     'amount', sp.amount,
			                     'currency_mint', sp.currency_mint,
			                     'chain', sp.chain
			                   )
			                 )
			            FROM agent_skill_prices sp
			           WHERE sp.agent_id = i.id AND sp.is_active = true),
			         '{}'::jsonb
			       ) AS skill_prices
			FROM agent_identities i
			LEFT JOIN users u   ON i.user_id = u.id
			LEFT JOIN avatars a ON a.id = i.avatar_id AND a.deleted_at IS NULL
			WHERE i.id = ${id} AND i.deleted_at IS NULL
		`;
		if (!row) return error(res, 404, 'not_found', 'agent not found');

		await healStaleAvatarId(row);

		const [chatRow] = await sql`
			SELECT COUNT(*)::int AS total
			FROM usage_events
			WHERE agent_id = ${id} AND kind = 'llm'
		`;
		row.chat_count = chatRow?.total ?? 0;

		// Public fields if not owner; full record if owner. Auth on a public GET
		// is best-effort — anonymous viewers still get the public projection.
		const auth = await resolveAuth(req).catch(() => null);
		const isOwner = auth?.userId === row.user_id;
		return json(res, 200, { agent: decorate(row, isOwner) });
	}

	if (req.method === 'PUT') {
		const auth = await resolveAuth(req);
		if (!auth) return error(res, 401, 'unauthorized', 'sign in required');
		if (!(await requireCsrf(req, res, auth.userId))) return;
		return handleUpdate(req, res, id, auth);
	}

	if (req.method === 'PATCH') {
		const auth = await resolveAuth(req);
		if (!auth) return error(res, 401, 'unauthorized', 'sign in required');
		if (!(await requireCsrf(req, res, auth.userId))) return;
		return handlePatchEdits(req, res, id, auth);
	}

	if (req.method === 'DELETE') {
		const auth = await resolveAuth(req);
		if (!auth) return error(res, 401, 'unauthorized', 'sign in required');
		if (!(await requireCsrf(req, res, auth.userId))) return;
		return handleDelete(req, res, id, auth);
	}
}

// ── Update ────────────────────────────────────────────────────────────────

async function handleUpdate(req, res, id, auth) {
	const scopeErr = requireScopeForMutation(auth, res, 'avatars:write');
	if (scopeErr) return scopeErr;
	const [existing] = await sql`
		SELECT id, user_id FROM agent_identities WHERE id = ${id} AND deleted_at IS NULL
	`;
	if (!existing) return error(res, 404, 'not_found', 'agent not found');
	if (existing.user_id !== auth.userId) return error(res, 403, 'forbidden', 'not your agent');

	const body = await readJson(req);
	const [updated] = await sql`
		UPDATE agent_identities SET
			name         = COALESCE(${body.name || null}, name),
			description  = COALESCE(${body.description || null}, description),
			avatar_id    = COALESCE(${body.avatar_id || null}, avatar_id),
			skills       = COALESCE(${body.skills || null}, skills),
			meta         = COALESCE(${body.meta ? JSON.stringify(body.meta) : null}::jsonb, meta),
			home_url     = COALESCE(${body.home_url || null}, home_url)
		WHERE id = ${id}
		RETURNING *
	`;
	return json(res, 200, { agent: decorate(updated) });
}

// ── Patch (partial update) ────────────────────────────────────────────────

async function handlePatchEdits(req, res, id, auth) {
	return handleUpdate(req, res, id, auth);
}

// ── Delete ────────────────────────────────────────────────────────────────

async function handleDelete(req, res, id, auth) {
	const scopeErr = requireScopeForMutation(auth, res, 'avatars:delete');
	if (scopeErr) return scopeErr;
	const [existing] = await sql`
		SELECT id, user_id FROM agent_identities WHERE id = ${id} AND deleted_at IS NULL
	`;
	if (!existing) return error(res, 404, 'not_found', 'agent not found');
	if (existing.user_id !== auth.userId) return error(res, 403, 'forbidden', 'not your agent');

	// Soft-delete the agent and purge dependent records in a single transaction.
	// agent_actions / agent_memories have ON DELETE CASCADE FKs but the soft-delete
	// leaves the row in place, so we delete dependents explicitly.
	await sql.transaction([
		sql`UPDATE agent_identities SET deleted_at = now() WHERE id = ${id}`,
		sql`DELETE FROM agent_actions  WHERE agent_id = ${id}`,
		sql`DELETE FROM agent_memories WHERE agent_id = ${id}`,
	]);
	return json(res, 200, { ok: true });
}

// ── Wallet ────────────────────────────────────────────────────────────────

export async function handleWallet(req, res, id) {
	if (cors(req, res, { methods: 'POST,DELETE,OPTIONS', credentials: true })) return;

	const auth = await resolveAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in required');
	if (!(await requireCsrf(req, res, auth.userId))) return;

	const [existing] = await sql`
		SELECT id, user_id FROM agent_identities WHERE id = ${id} AND deleted_at IS NULL
	`;
	if (!existing) return error(res, 404, 'not_found', 'agent not found');
	if (existing.user_id !== auth.userId) return error(res, 403, 'forbidden', 'not your agent');

	if (req.method === 'DELETE') {
		await sql`
			UPDATE agent_identities
			SET wallet_address = null, chain_id = null, erc8004_agent_id = null
			WHERE id = ${id}
		`;
		return json(res, 200, { ok: true });
	}

	if (!method(req, res, ['POST'])) return;
	const body = await readJson(req);
	const address = String(body.wallet_address || '').trim();
	const chainId = Number(body.chain_id) || null;
	// Optional: post-mint, the client can patch in the minted ERC-8004 agent id.
	const erc8004 = body.erc8004_agent_id != null ? BigInt(body.erc8004_agent_id).toString() : null;
	if (!address) return error(res, 400, 'validation_error', 'wallet_address required');

	const [updated] = await sql`
		UPDATE agent_identities
		SET wallet_address   = ${address},
		    chain_id         = ${chainId},
		    erc8004_agent_id = COALESCE(${erc8004}::bigint, erc8004_agent_id)
		WHERE id = ${id}
		RETURNING *
	`;
	return json(res, 200, { agent: decorate(updated) });
}

// ── Helpers ────────────────────────────────────────────────────────────────

// If the agent row's avatar_id references a deleted/missing avatar, null it out
// in-place on the row and fire-and-forget a DB update so future reads are clean.
async function healStaleAvatarId(row) {
	if (!row?.avatar_id) return;
	const [av] = await sql`
		SELECT id FROM avatars WHERE id = ${row.avatar_id} AND deleted_at IS NULL LIMIT 1
	`;
	if (!av) {
		const staleId = row.avatar_id;
		row.avatar_id = null;
		sql`UPDATE agent_identities SET avatar_id = NULL WHERE id = ${row.id} AND avatar_id = ${staleId}`
			.catch((e) => console.error('[agents] healStaleAvatarId failed', e));
	}
}

async function resolveAuth(req) {
	const session = await getSessionUser(req);
	if (session) return { userId: session.id, source: 'session', scope: null };
	const bearer = await authenticateBearer(extractBearer(req));
	if (bearer) return { userId: bearer.userId, source: 'bearer', scope: bearer.scope || '' };
	return null;
}

// Bearer-token callers must hold the matching avatars:* scope before they can
// mutate an agent. Session callers (browser cookies) are not constrained by
// scope. Returns null when authorized, or an error response otherwise.
function requireScopeForMutation(auth, res, requiredScope) {
	if (!auth || auth.source !== 'bearer') return null;
	if (!hasScope(auth.scope, requiredScope)) {
		return error(res, 403, 'insufficient_scope', `${requiredScope} required`);
	}
	return null;
}

function decorate(row, isOwner = true) {
	// Strip encrypted secrets from meta — never expose to the client.
	const meta = { ...(row.meta || {}) };
	delete meta.encrypted_wallet_key;
	delete meta.encrypted_solana_secret;

	// Surface canonical blocks at the top level so the frontend doesn't need to
	// know they live under `meta`. Treat `meta.*` as the source of truth for
	// new code; legacy fields (chain_id, erc8004_agent_id) are still emitted
	// for backwards compat below.
	const onchain = meta.onchain || null;
	const token = meta.token || null;
	const payments = meta.payments
		? {
				// Public-safe view: the receiver address is intended to be public,
				// but anything secret (bot keys, configured webhook secrets, etc.)
				// must never leave the server. Whitelist explicitly.
				receiver: meta.payments.receiver,
				accepted_tokens: meta.payments.accepted_tokens || [],
				configured_at: meta.payments.configured_at,
			}
		: null;

	const avatarVisibility = row.avatar_visibility || null;
	const avatarPubliclyReadable =
		avatarVisibility === 'public' || avatarVisibility === 'unlisted';
	const avatarModelUrl =
		row.avatar_storage_key && avatarPubliclyReadable
			? publicUrl(row.avatar_storage_key)
			: null;
	const avatarThumbnailUrl = row.avatar_thumbnail_key
		? publicUrl(row.avatar_thumbnail_key)
		: null;

	const base = {
		id: row.id,
		name: row.name,
		description: row.description,
		author_name: row.author_name || null,
		author_avatar: row.author_avatar || null,
		chat_count: row.chat_count ?? 0,
		avatar_id: row.avatar_id,
		avatar_visibility: avatarVisibility,
		avatar_model_url: avatarModelUrl,
		avatar_thumbnail_url: avatarThumbnailUrl,
		home_url: row.home_url || `/agent/${row.id}`,
		skills: row.skills || [],
		skill_prices: row.skill_prices || {},
		meta,
		onchain,
		token,
		payments,
		is_registered: Boolean(row.erc8004_agent_id) || !!onchain,
		// Whether the requesting session owns this agent. Owner-only write paths
		// (action log, memory sync) gate on this so public viewers don't fire
		// requests the backend will reject with 403.
		is_owner: !!isOwner,
		created_at: row.created_at,
	};
	// Voice clone fields are public (voice_id is needed by the runtime to select TTS).
	base.voice_provider = row.voice_provider || 'browser';
	base.voice_id = row.voice_id || null;

	if (isOwner) {
		base.wallet_address = row.wallet_address;
		base.chain_id = row.chain_id;
		base.user_id = row.user_id;
		base.erc8004_agent_id = row.erc8004_agent_id;
		base.erc8004_registry = row.erc8004_registry;
		base.registration_cid = row.registration_cid;
		// Publish-time fields needed by the agent editor. Owner-only because the
		// system prompt is private IP.
		base.system_prompt = row.system_prompt || null;
		base.greeting = row.greeting || null;
		base.category = row.category || null;
		base.tags = row.tags || [];
		base.capabilities = row.capabilities || {};
		base.is_published = !!row.is_published;
	}
	return base;
}
