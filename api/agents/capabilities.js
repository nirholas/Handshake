// /api/agents/:id/capabilities — scoped session keys (least-privilege capabilities)
// for a custodial agent wallet. Dispatched from api/agents/[id].js with the
// remaining path segments. Owner-authenticated; every mutation is CSRF-gated.
//
// Routes:
//   GET    /capabilities                    list live + historical grants, settings, auto-suggestions
//   POST   /capabilities                    mint a scoped capability
//   PUT    /capabilities/settings           toggle require_capabilities (least-privilege mode)
//   POST   /capabilities/:cid/revoke        revoke one capability (immediate)
//   POST   /capabilities/revoke-all         revoke every live capability ("kill all")
//
// Capabilities strictly SUBTRACT authority and are enforced server-side on every
// autonomous spend by api/_lib/wallet-capabilities.js (composed into the shared
// guards). This endpoint is the issuance + lifecycle + owner-visibility surface.

import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { sql } from '../_lib/db.js';
import { cors, json, method, error, readJson, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { requireCsrf } from '../_lib/csrf.js';
import { isUuid } from '../_lib/validate.js';
import { solUsdPrice } from '../_lib/avatar-wallet.js';
import { getSpendLimits, setSpendLimits, SpendLimitError } from '../_lib/agent-trade-guards.js';
import {
	mintCapability, listCapabilities, revokeCapability, revokeAllCapabilities,
	getCapability, CAPABILITY_ACTIONS,
} from '../_lib/wallet-capabilities.js';

async function resolveAuth(req) {
	const session = await getSessionUser(req);
	if (session) return { userId: session.id };
	const bearer = await authenticateBearer(extractBearer(req));
	if (bearer) return { userId: bearer.userId };
	return null;
}

// Owner gate: authenticated AND owns the agent. Returns { auth, agent } or null
// (response already sent on failure). Capabilities are an owner-only surface — a
// read-only visitor never sees another wallet's leashes.
async function loadOwner(req, res, id) {
	const auth = await resolveAuth(req);
	if (!auth) { error(res, 401, 'unauthorized', 'sign in required'); return null; }
	const [agent] = await sql`SELECT id, user_id, name, meta FROM agent_identities WHERE id = ${id} AND deleted_at IS NULL`;
	if (!agent) { error(res, 404, 'not_found', 'agent not found'); return null; }
	if (agent.user_id !== auth.userId) { error(res, 403, 'forbidden', 'not your agent'); return null; }
	return { auth, agent };
}

function sendErr(res, e) {
	if (e instanceof SpendLimitError) {
		return error(res, e.status || 400, e.code || 'invalid', e.message, e.detail ? { detail: e.detail } : undefined);
	}
	if (e && e.status) return error(res, e.status, e.code || 'error', e.message);
	console.error('[capabilities] unexpected error', e?.message, e?.stack);
	return error(res, 500, 'server_error', 'something went wrong');
}

// ── GET: list + settings + auto-suggested least-privilege defaults ──────────────
async function handleList(req, res, id) {
	const caps = await listCapabilities(id, { includeRevoked: true });
	const [row] = await sql`SELECT meta FROM agent_identities WHERE id = ${id} AND deleted_at IS NULL`;
	const lim = getSpendLimits(row?.meta);
	const suggestions = await buildSuggestions(id, caps);
	return json(res, 200, {
		capabilities: caps,
		settings: { require_capabilities: lim.require_capabilities },
		actions: CAPABILITY_ACTIONS,
		suggestions,
	});
}

// Auto-suggest tight default capabilities so least-privilege is the default, not a
// chore. For every armed sniper strategy that has no live capability scoped to it,
// propose a snipe grant budgeted to (a touch above) the strategy's own daily SOL
// budget. The owner accepts it in one tap — the leash matches what the strategy
// can already spend, just made explicit + independently revocable.
async function buildSuggestions(agentId, caps) {
	const out = [];
	try {
		const strategies = await sql`
			SELECT id, network, enabled, daily_budget_lamports, per_trade_lamports
			FROM agent_sniper_strategies
			WHERE agent_id = ${agentId} AND enabled = true AND daily_budget_lamports > 0
		`;
		if (strategies.length === 0) return out;
		const liveByHolder = new Set(
			caps.filter((c) => c.status === 'active' && c.holder_ref).map((c) => c.holder_ref),
		);
		let solUsd = null;
		try { solUsd = await solUsdPrice(); } catch { solUsd = null; }
		for (const s of strategies) {
			if (liveByHolder.has(String(s.id))) continue; // already leashed
			const dailySol = Number(s.daily_budget_lamports) / 1e9;
			const perTradeSol = Number(s.per_trade_lamports) / 1e9;
			const aggregateUsd = solUsd ? Math.max(1, Math.ceil(dailySol * solUsd)) : null;
			const perUseUsd = solUsd && perTradeSol > 0 ? Math.max(1, Math.ceil(perTradeSol * solUsd * 1.05)) : null;
			out.push({
				kind: 'strategy',
				holder_ref: String(s.id),
				label: 'Sniper strategy',
				reason: `This strategy can spend up to ◎${dailySol.toFixed(3)}/day. A scoped key makes that explicit and revocable on its own.`,
				draft: {
					label: 'Sniper strategy',
					holder_kind: 'strategy',
					holder_ref: String(s.id),
					actions: ['snipe'],
					per_use_usd: perUseUsd,
					aggregate_usd: aggregateUsd,
					target_kind: 'any',
					targets: [],
					ttl_seconds: 24 * 60 * 60,
				},
			});
		}
	} catch (e) {
		console.warn('[capabilities] suggestions failed', e?.message);
	}
	return out;
}

// ── POST: mint ──────────────────────────────────────────────────────────────────
async function handleMint(req, res, id, userId) {
	let body;
	try { body = await readJson(req, 20_000); } catch { return error(res, 400, 'bad_request', 'invalid JSON body'); }
	const cap = await mintCapability({
		agentId: id,
		userId,
		label: body.label,
		holderKind: body.holder_kind,
		holderRef: body.holder_ref,
		actions: body.actions,
		perUseUsd: body.per_use_usd,
		aggregateUsd: body.aggregate_usd,
		targetKind: body.target_kind,
		targets: body.targets,
		expiresAt: body.expires_at,
		ttlSeconds: body.ttl_seconds,
		meta: body.meta && typeof body.meta === 'object' ? body.meta : {},
	});
	// Re-read through the list shaper so the response carries the same decorated
	// shape (status, spent_usd) the GET feed uses — one consistent capability object.
	const [shaped] = await listCapabilities(id, { includeRevoked: true }).then((rows) => rows.filter((r) => r.id === cap.id));
	return json(res, 201, { capability: shaped || cap });
}

// ── PUT settings: least-privilege mode toggle ───────────────────────────────────
async function handleSettings(req, res, id, userId) {
	let body;
	try { body = await readJson(req, 4_000); } catch { return error(res, 400, 'bad_request', 'invalid JSON body'); }
	if (typeof body.require_capabilities !== 'boolean') {
		return error(res, 400, 'validation_error', 'require_capabilities must be a boolean');
	}
	const next = await setSpendLimits(id, userId, { require_capabilities: body.require_capabilities }, { req });
	return json(res, 200, { settings: { require_capabilities: next.require_capabilities } });
}

// ── POST revoke / revoke-all ────────────────────────────────────────────────────
async function handleRevoke(req, res, id, userId, cid) {
	// The capability id is a uuid column; a malformed one reaches Postgres as
	// error 22P02 and would surface as a 500. An unknown grant is a 404 either way.
	if (!isUuid(cid)) return error(res, 404, 'not_found', 'capability not found');
	const existing = await getCapability(cid);
	if (!existing || String(existing.agent_id) !== String(id)) {
		return error(res, 404, 'not_found', 'capability not found');
	}
	const row = await revokeCapability(cid, { agentId: id, userId, reason: 'owner_revoked' });
	// Idempotent: revoking an already-revoked grant is success (it's already dead).
	return json(res, 200, { revoked: true, id: cid, already: !row });
}

async function handleRevokeAll(req, res, id, userId) {
	const count = await revokeAllCapabilities(id, userId, 'owner_revoked_all');
	return json(res, 200, { revoked: true, count });
}

export default async function handler(req, res, id, action, parts = []) {
	if (cors(req, res, { methods: 'GET,POST,PUT,OPTIONS', credentials: true })) return;

	// GET list — owner-gated, no CSRF.
	if (req.method === 'GET' && !action) {
		const owned = await loadOwner(req, res, id);
		if (!owned) return;
		const rl = await limits.walletRead(owned.auth.userId);
		if (!rl.success) return rateLimited(res, rl);
		try { return await handleList(req, res, id); } catch (e) { return sendErr(res, e); }
	}

	// All mutations: owner-gated + CSRF + a per-IP critical-action limit.
	if (req.method === 'POST' || req.method === 'PUT') {
		const owned = await loadOwner(req, res, id);
		if (!owned) return;
		const rl = await limits.authIp(clientIp(req));
		if (!rl.success) return rateLimited(res, rl);
		if (!(await requireCsrf(req, res, owned.auth.userId))) return;
		const userId = owned.auth.userId;
		try {
			if (req.method === 'POST' && !action) return await handleMint(req, res, id, userId);
			if (req.method === 'PUT' && action === 'settings') return await handleSettings(req, res, id, userId);
			if (req.method === 'POST' && action === 'revoke-all') return await handleRevokeAll(req, res, id, userId);
			// /capabilities/:cid/revoke — action = capability id, parts[5] = 'revoke'
			if (req.method === 'POST' && action && parts[5] === 'revoke') {
				return await handleRevoke(req, res, id, userId, action);
			}
		} catch (e) { return sendErr(res, e); }
	}

	return error(res, 405, 'method_not_allowed', 'unsupported method or route');
}
