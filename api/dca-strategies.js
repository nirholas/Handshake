// POST/GET/DELETE /api/dca-strategies
// Manages DCA strategy records. Strategies are executed by api/cron/run-dca.js.

import { z } from 'zod';
import { sql } from './_lib/db.js';
import { getSessionUser } from './_lib/auth.js';
import { cors, json, error, wrap, readJson, method, rateLimited } from './_lib/http.js';
import { requireCsrf } from './_lib/csrf.js';
import { parse } from './_lib/validate.js';
import { limits, clientIp } from './_lib/rate-limit.js';

// Whitelisted token-out symbols — runtime operator config, never hardcoded
// tickers. DCA_ALLOWED_TOKEN_OUT is a comma-separated symbol list; when unset
// or empty, strategy creation is rejected until the operator configures it.
function allowedTokenOutSymbols() {
	return new Set(
		(process.env.DCA_ALLOWED_TOKEN_OUT || '')
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean),
	);
}

// Default chain for new strategies — operator config (DCA_CHAIN_ID), never a
// hardcoded network. Required when the request body omits chain_id.
function defaultChainId() {
	const parsed = parseInt(process.env.DCA_CHAIN_ID || '', 10);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

// Max slippage enforced server-side in addition to the UI cap
const MAX_SLIPPAGE_BPS = 500;

const weiString = z.string().regex(/^\d+$/, 'must be a decimal integer string');
const ethAddress = z
	.string()
	.regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 0x-prefixed 40-character hex address');

const createSchema = z.object({
	agent_id: z.string().uuid(),
	delegation_id: z.string().uuid(),
	chain_id: z.number().int().positive().optional(),
	token_in: ethAddress,
	token_out: ethAddress,
	token_out_symbol: z.string().min(1).max(10),
	amount_per_execution: weiString,
	period_seconds: z
		.number()
		.int()
		.refine((v) => v === 86400 || v === 604800, {
			message: 'period_seconds must be 86400 (daily) or 604800 (weekly)',
		}),
	slippage_bps: z.number().int().min(1).max(MAX_SLIPPAGE_BPS).default(50),
});

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,DELETE,OPTIONS', credentials: true })) return;

	const session = await getSessionUser(req);
	if (!session) return error(res, 401, 'unauthorized', 'sign in required');

	// State-changing methods on a cookie session require a CSRF token. These
	// strategies move real funds on a schedule, so a forged create/cancel is
	// high-impact — gate every non-GET method.
	if (req.method !== 'GET' && !(await requireCsrf(req, res, session.id))) return;

	const url = new URL(req.url, 'http://x');

	// ── DELETE /api/dca-strategies/:id ─────────────────────────────────────────
	if (req.method === 'DELETE') {
		const strategyId = url.pathname.split('/').pop();
		if (!strategyId || strategyId === 'dca-strategies') {
			return error(res, 400, 'missing_param', 'strategy id required in path');
		}
		if (!z.string().uuid().safeParse(strategyId).success) {
			return error(res, 400, 'validation_error', 'strategy id must be a uuid');
		}

		const ip = clientIp(req);
		const rl = await limits.authIp(ip);
		if (!rl.success) return rateLimited(res, rl);

		// Verify ownership via agent_id → user_id chain
		const [row] = await sql`
			SELECT s.id
			FROM dca_strategies s
			JOIN agent_identities a ON a.id = s.agent_id
			WHERE s.id = ${strategyId}
			  AND a.user_id = ${session.id}
			  AND s.status = 'active'
			LIMIT 1
		`;
		if (!row) return error(res, 404, 'not_found', 'strategy not found or already cancelled');

		await sql`
			UPDATE dca_strategies
			SET status = 'cancelled', cancelled_at = NOW()
			WHERE id = ${strategyId}
		`;
		return json(res, 200, { ok: true });
	}

	// ── GET /api/dca-strategies?agent_id=… ────────────────────────────────────
	if (req.method === 'GET') {
		const agentId = url.searchParams.get('agent_id');
		if (!agentId) return error(res, 400, 'missing_param', 'agent_id is required');
		if (!z.string().uuid().safeParse(agentId).success) {
			return error(res, 400, 'validation_error', 'agent_id must be a uuid');
		}

		const ip = clientIp(req);
		const rl = await limits.authedReadIp(ip);
		if (!rl.success) return rateLimited(res, rl);

		// Confirm session user owns this agent
		const [agent] = await sql`
			SELECT id FROM agent_identities
			WHERE id = ${agentId} AND user_id = ${session.id} AND deleted_at IS NULL
			LIMIT 1
		`;
		if (!agent) return error(res, 404, 'not_found', 'agent not found');

		const strategies = await sql`
			SELECT
				s.id, s.chain_id, s.token_in, s.token_out, s.token_out_symbol,
				s.amount_per_execution, s.period_seconds, s.slippage_bps,
				s.status, s.next_execution_at, s.last_execution_at, s.created_at,
				(
					SELECT json_build_object(
						'tx_hash', e.tx_hash,
						'amount_in', e.amount_in,
						'amount_out', e.amount_out,
						'status', e.status,
						'executed_at', e.executed_at
					)
					FROM dca_executions e
					WHERE e.strategy_id = s.id
					ORDER BY e.executed_at DESC
					LIMIT 1
				) AS last_execution
			FROM dca_strategies s
			WHERE s.agent_id = ${agentId}
			ORDER BY s.created_at DESC
		`;
		return json(res, 200, { ok: true, data: strategies });
	}

	// ── POST /api/dca-strategies ───────────────────────────────────────────────
	if (!method(req, res, ['POST'])) return;

	const ip = clientIp(req);
	const rl = await limits.authIp(ip);
	if (!rl.success) return rateLimited(res, rl);

	let body;
	try {
		body = parse(createSchema, await readJson(req));
	} catch (err) {
		return error(res, err.status || 400, err.code || 'validation_error', err.message);
	}

	const allowedTokenOut = allowedTokenOutSymbols();
	if (allowedTokenOut.size === 0) {
		return error(
			res,
			400,
			'not_configured',
			'DCA token-out whitelist is not configured — set DCA_ALLOWED_TOKEN_OUT (comma-separated symbols)',
		);
	}
	if (!allowedTokenOut.has(body.token_out_symbol)) {
		return error(
			res,
			400,
			'validation_error',
			`token_out_symbol must be one of: ${[...allowedTokenOut].join(', ')}`,
		);
	}

	const chainId = body.chain_id ?? defaultChainId();
	if (!chainId) {
		return error(
			res,
			400,
			'not_configured',
			'chain_id is required — pass it in the body or set DCA_CHAIN_ID',
		);
	}

	// Confirm session user owns the agent
	const [agent] = await sql`
		SELECT id FROM agent_identities
		WHERE id = ${body.agent_id} AND user_id = ${session.id} AND deleted_at IS NULL
		LIMIT 1
	`;
	if (!agent) return error(res, 404, 'not_found', 'agent not found');

	// Confirm delegation exists and is active, and belongs to this agent
	const [delegation] = await sql`
		SELECT id, status, expires_at
		FROM agent_delegations
		WHERE id = ${body.delegation_id}
		  AND agent_id = ${body.agent_id}
		  AND status = 'active'
		LIMIT 1
	`;
	if (!delegation) {
		return error(res, 404, 'not_found', 'active delegation not found for this agent');
	}
	if (new Date(delegation.expires_at) <= new Date()) {
		return error(res, 409, 'delegation_expired', 'delegation has already expired');
	}

	// Prevent duplicate active strategies for the same agent + token pair
	const [existing] = await sql`
		SELECT id FROM dca_strategies
		WHERE agent_id = ${body.agent_id}
		  AND token_in = ${body.token_in}
		  AND token_out = ${body.token_out}
		  AND status = 'active'
		LIMIT 1
	`;
	if (existing) {
		return error(
			res,
			409,
			'conflict',
			'an active strategy already exists for this token pair — cancel it first',
		);
	}

	const nextExecAt = new Date(Date.now() + body.period_seconds * 1000).toISOString();

	const [created] = await sql`
		INSERT INTO dca_strategies (
			agent_id, delegation_id, chain_id,
			token_in, token_out, token_out_symbol,
			amount_per_execution, period_seconds, slippage_bps,
			next_execution_at
		) VALUES (
			${body.agent_id}, ${body.delegation_id}, ${chainId},
			${body.token_in}, ${body.token_out}, ${body.token_out_symbol},
			${body.amount_per_execution}, ${body.period_seconds}, ${body.slippage_bps},
			${nextExecAt}
		)
		RETURNING id, status, next_execution_at, created_at
	`;

	return json(res, 201, { ok: true, ...created });
});
