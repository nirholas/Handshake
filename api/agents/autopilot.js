/**
 * Treasury Autopilot API — owner-only control surface for the agent that funds
 * its own existence. Routed from api/agents/[id].js as /api/agents/:id/autopilot.
 *
 *   GET    /api/agents/:id/autopilot            → policy + compiled rules + runway view
 *   POST   /api/agents/:id/autopilot/compile    → plain-English policy → structured rules (preview only)
 *   PUT    /api/agents/:id/autopilot            → save / arm / disarm / kill / edit rules
 *   POST   /api/agents/:id/autopilot/run        → run one cycle now { dry_run }
 *                                                 (simulates unless dry_run is false)
 *
 * Every write is owner-only (server-side) and CSRF-protected. Executing paths act
 * ONLY on the agent's own wallet and are clamped to the agent's spend policy at
 * execution time. See api/_lib/treasury-autopilot.js for the engine.
 */

import { cors, json, method, error, readJson, rateLimited, serverError } from '../_lib/http.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { limits } from '../_lib/rate-limit.js';
import { requireCsrf } from '../_lib/csrf.js';
import { sql } from '../_lib/db.js';
import {
	getAutopilot,
	setAutopilot,
	compilePolicyFromText,
	runAutopilotCycle,
	computeRunway,
} from '../_lib/treasury-autopilot.js';
import { validateSolanaAddress, getSpendLimits } from '../_lib/agent-trade-guards.js';

async function resolveAuth(req) {
	const session = await getSessionUser(req);
	if (session) return { userId: session.id };
	const bearer = await authenticateBearer(extractBearer(req));
	if (bearer) return { userId: bearer.userId };
	return null;
}

// Owner gate → returns { auth, meta } or writes the response and returns { error: true }.
async function loadOwned(req, res, id) {
	const auth = await resolveAuth(req);
	if (!auth) {
		error(res, 401, 'unauthorized', 'sign in to manage this agent’s treasury autopilot');
		return { error: true };
	}
	const [row] = await sql`SELECT id, user_id, meta FROM agent_identities WHERE id = ${id} AND deleted_at IS NULL`;
	if (!row) {
		error(res, 404, 'not_found', 'agent not found');
		return { error: true };
	}
	if (row.user_id !== auth.userId) {
		error(res, 403, 'forbidden', 'only the owner can configure treasury autopilot');
		return { error: true };
	}
	return { auth, meta: { ...(row.meta || {}) } };
}

function netOf(req) {
	const url = new URL(req.url, 'http://x');
	return url.searchParams.get('network') === 'devnet' ? 'devnet' : 'mainnet';
}

export default async function handler(req, res, id, action) {
	if (cors(req, res, { methods: 'GET,POST,PUT,OPTIONS', credentials: true })) return;

	if (action === 'compile') return handleCompile(req, res, id);
	if (action === 'run') return handleRun(req, res, id);
	if (action) return error(res, 404, 'not_found', 'unknown autopilot sub-resource');

	if (req.method === 'GET') return handleGet(req, res, id);
	if (req.method === 'PUT') return handlePut(req, res, id);
	return method(req, res, ['GET', 'PUT']) ? error(res, 405, 'method_not_allowed', 'use GET or PUT') : undefined;
}

// GET — current policy + the real runway view.
async function handleGet(req, res, id) {
	if (!method(req, res, ['GET'])) return;
	const owned = await loadOwned(req, res, id);
	if (owned.error) return;
	const rl = await limits.walletRead(owned.auth.userId);
	if (!rl.success) return rateLimited(res, rl);

	const network = netOf(req);
	const policy = getAutopilot(owned.meta);
	// Surface the hard spend caps (daily/per-tx USD) read-only so the cockpit can
	// render the ceiling the autopilot can never exceed. Owner-only data already.
	const spendLimits = getSpendLimits(owned.meta);
	try {
		const runway = await computeRunway({ agentId: id, network, meta: owned.meta });
		return json(res, 200, { data: { policy, runway, spend_limits: spendLimits } });
	} catch (e) {
		return serverError(res, 500, 'runway_failed', e);
	}
}

// POST /compile — plain-English → structured rules. Preview only; never arms.
async function handleCompile(req, res, id) {
	if (!method(req, res, ['POST'])) return;
	const owned = await loadOwned(req, res, id);
	if (owned.error) return;
	if (!(await requireCsrf(req, res, owned.auth.userId))) return;
	const rl = await limits.walletRead(owned.auth.userId);
	if (!rl.success) return rateLimited(res, rl);

	let body;
	try {
		body = await readJson(req);
	} catch (e) {
		return error(res, e?.status === 415 ? 415 : 400, 'bad_request', e?.message || 'invalid request body');
	}
	const text = typeof body.text === 'string' ? body.text : '';
	const sweepDest = typeof body.sweep_destination === 'string' && validateSolanaAddress(body.sweep_destination).valid
		? validateSolanaAddress(body.sweep_destination).base58
		: getAutopilot(owned.meta).sweep_destination;

	try {
		const compiled = await compilePolicyFromText(text, {
			sweepDestination: sweepDest,
			track: { userId: owned.auth.userId, agentId: id, tool: 'autopilot_compile' },
		});
		if (!compiled.ok) return error(res, 400, compiled.error || 'compile_failed', compiled.message || 'could not compile policy');
		return json(res, 200, { data: compiled });
	} catch (e) {
		return serverError(res, 500, 'compile_failed', e);
	}
}

// PUT — persist a policy patch (save compiled rules, arm/disarm, kill, edit, pause).
async function handlePut(req, res, id) {
	const owned = await loadOwned(req, res, id);
	if (owned.error) return;
	if (!(await requireCsrf(req, res, owned.auth.userId))) return;

	let body;
	try {
		body = await readJson(req);
	} catch (e) {
		return error(res, e?.status === 415 ? 415 : 400, 'bad_request', e?.message || 'invalid request body');
	}

	const patch = {};
	if ('rules' in body) {
		if (!Array.isArray(body.rules)) return error(res, 400, 'bad_request', 'rules must be an array');
		patch.rules = body.rules;
	}
	if ('buffer_sol' in body) patch.buffer_sol = body.buffer_sol;
	if ('sweep_destination' in body) {
		const d = body.sweep_destination;
		if (d && !validateSolanaAddress(d).valid) return error(res, 400, 'invalid_address', 'sweep destination is not a valid Solana address');
		patch.sweep_destination = d || null;
	}
	if ('source_text' in body) patch.source_text = body.source_text;
	if ('armed' in body) patch.armed = body.armed === true;
	if ('kill_switch' in body) patch.kill_switch = body.kill_switch === true;

	// Arming is explicit consent — stamp approval + compile time server-side.
	const nowIso = new Date().toISOString();
	if (patch.armed === true) {
		patch.approved_at = nowIso;
		patch.compiled_at = nowIso;
	}

	try {
		const policy = await setAutopilot(id, owned.auth.userId, patch, { req });
		return json(res, 200, { data: { policy } });
	} catch (e) {
		if (e?.status) return error(res, e.status, e.code || 'error', e.message);
		return serverError(res, 500, 'save_failed', e);
	}
}

// POST /run — run one real autopilot cycle now (owner-initiated). Honors the kill
// switch, disarmed state, freeze, and the spend policy exactly like the scheduler.
async function handleRun(req, res, id) {
	if (!method(req, res, ['POST'])) return;
	const owned = await loadOwned(req, res, id);
	if (owned.error) return;
	if (!(await requireCsrf(req, res, owned.auth.userId))) return;
	const rl = await limits.walletRead(owned.auth.userId);
	if (!rl.success) return rateLimited(res, rl);

	const network = netOf(req);
	let body = {};
	try {
		body = await readJson(req);
	} catch {
		body = {};
	}
	// A missing dry_run simulates. This endpoint moves real funds, so the default
	// has to be the harmless one: a caller that forgot the flag, replayed a bare
	// POST, or hand-rolled the request gets a preview, never a spend. Matches the
	// sibling wallet-intents runner, which has always defaulted to simulation.
	// Spending is opt-in and explicit: dry_run must be literally false.
	const dryRun = body?.dry_run !== false;

	try {
		const result = await runAutopilotCycle({
			agentId: id,
			userId: owned.auth.userId,
			network,
			trigger: 'manual',
			dryRun,
		});
		return json(res, 200, { data: result });
	} catch (e) {
		return serverError(res, 500, 'run_failed', e);
	}
}
