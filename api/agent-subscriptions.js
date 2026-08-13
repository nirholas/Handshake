/**
 * /api/agent-subscriptions: the full lifecycle of a recurring on-chain payment.
 *
 * Distinct from /api/subscriptions (creator plan subscriptions over
 * creator_subscriptions); this endpoint tracks delegation-backed recurring
 * charges in agent_subscriptions, executed hourly by the run-subscriptions
 * cron in api/cron/[name].js.
 *
 * POST                          create a schedule (the delegation is already signed)
 * GET                           list the schedules the caller pays for
 * GET  ?view=incoming           list the schedules paying INTO agents the caller owns
 * GET  ?id=<uuid>               one schedule plus its charge history
 * PATCH ?id=<uuid> {action}     pause or resume a schedule
 * DELETE ?id=<uuid>             cancel a schedule (does NOT revoke the delegation)
 *
 * Both sides of the payment can read a schedule: the payer (agent_subscriptions
 * .user_id) and the creator being paid (agent_identities.user_id). Only the
 * payer can pause, resume or cancel, because only their signed delegation funds
 * it.
 */

import { sql } from './_lib/db.js';
import { getSessionUser, authenticateBearer, extractBearer } from './_lib/auth.js';
import { cors, json, method, wrap, error, readJson, rateLimited } from './_lib/http.js';
import { requireCsrf } from './_lib/csrf.js';
import { limits, clientIp } from './_lib/rate-limit.js';
import { z } from 'zod';
import { parse } from './_lib/validate.js';
import {
	MAX_CONSECUTIVE_FAILURES,
	describePeriod,
	formatUnits,
	planStatusChange,
	sumUnits,
} from './_lib/recurring.js';

const postSchema = z.object({
	agentId: z.string().uuid(),
	delegationId: z.string().uuid(),
	periodSeconds: z.number().int().positive(),
	amountPerPeriod: z
		.string()
		.regex(/^\d+$/, 'amountPerPeriod must be a base-unit integer string'),
});

const patchSchema = z.object({
	action: z.enum(['pause', 'resume']),
});

// How many charge attempts a detail view returns. Enough to show a month of
// daily charges without turning one row into an unbounded response.
const CHARGE_HISTORY_LIMIT = 40;

/**
 * Query params, whether the runtime pre-parsed them onto req.query (Vercel-style
 * handlers, the test harness) or left them on the URL (the Cloud Run server).
 */
function queryParam(req, name) {
	const fromQuery = req.query?.[name];
	if (fromQuery != null && fromQuery !== '') return String(fromQuery);
	try {
		return new URL(req.url, 'http://localhost').searchParams.get(name);
	} catch {
		return null;
	}
}

/** Shape one schedule row for the client, with everything the UI renders. */
function presentSchedule(row) {
	return {
		id: row.id,
		agent_id: row.agent_id,
		agent_name: row.agent_name ?? null,
		delegation_id: row.delegation_id,
		chain_id: row.chain_id ?? null,
		payer_address: row.payer_address ?? null,
		payee_address: row.payee_address ?? null,
		period_seconds: row.period_seconds,
		period_label: describePeriod(row.period_seconds),
		amount_per_period: row.amount_per_period,
		amount_display: formatUnits(row.amount_per_period),
		status: row.status,
		next_charge_at: row.next_charge_at,
		last_charge_at: row.last_charge_at,
		last_tx_hash: row.last_tx_hash ?? null,
		last_error: row.last_error ?? null,
		last_error_code: row.last_error_code ?? null,
		consecutive_failures: Number(row.consecutive_failures ?? 0),
		retries_left:
			row.status === 'active'
				? Math.max(0, MAX_CONSECUTIVE_FAILURES - Number(row.consecutive_failures ?? 0))
				: 0,
		delegation_status: row.delegation_status ?? null,
		delegation_expires_at: row.delegation_expires_at ?? null,
		charges_total: Number(row.charges_total ?? 0),
		charged_total: row.charged_total ?? '0',
		charged_total_display: formatUnits(row.charged_total ?? '0'),
		paused_at: row.paused_at ?? null,
		resumed_at: row.resumed_at ?? null,
		created_at: row.created_at,
		canceled_at: row.canceled_at ?? null,
	};
}

function presentCharge(row) {
	return {
		id: row.id,
		subscription_id: row.subscription_id,
		amount: row.amount,
		amount_display: formatUnits(row.amount),
		chain_id: row.chain_id,
		tx_hash: row.tx_hash,
		status: row.status,
		code: row.code,
		outcome: row.outcome,
		error: row.error,
		charged_at: row.charged_at,
	};
}

// Every list/detail query selects the same columns so presentSchedule always
// has what it needs. Built per call rather than held in a module constant so
// importing this handler never touches the DB client.
const scheduleColumns = () => sql`
	s.id, s.user_id, s.agent_id, s.delegation_id, s.period_seconds, s.amount_per_period,
	s.next_charge_at, s.last_charge_at, s.status, s.last_error, s.last_error_code,
	s.last_tx_hash, s.consecutive_failures, s.paused_at, s.resumed_at,
	s.created_at, s.canceled_at,
	ai.name            AS agent_name,
	ai.user_id         AS creator_user_id,
	ai.wallet_address  AS payee_address,
	d.chain_id         AS chain_id,
	d.delegator_address AS payer_address,
	d.status           AS delegation_status,
	d.expires_at       AS delegation_expires_at,
	COALESCE(c.charges_total, 0)  AS charges_total,
	COALESCE(c.charged_total, '0') AS charged_total
`;

// Successful-charge rollup per schedule. LEFT JOINed so a schedule that has
// never charged still lists, with zeroes rather than a missing row.
const chargeRollup = () => sql`
	LEFT JOIN (
		SELECT subscription_id,
		       COUNT(*)                     AS charges_total,
		       SUM(amount::numeric)::text   AS charged_total
		FROM subscription_charges
		WHERE status = 'success'
		GROUP BY subscription_id
	) c ON c.subscription_id = s.id
`;

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,PATCH,DELETE,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'POST', 'PATCH', 'DELETE'])) return;

	const session = await getSessionUser(req);
	const bearer = session ? null : await authenticateBearer(extractBearer(req));
	if (!session && !bearer) return error(res, 401, 'unauthorized', 'sign in required');
	const userId = session?.id ?? bearer.userId;

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	// State-changing methods on a cookie session require a CSRF token (bearer
	// callers are exempt inside requireCsrf). Without this, a cross-origin script
	// could pause or cancel a victim's schedules on their behalf.
	if (req.method !== 'GET' && !(await requireCsrf(req, res, userId))) return;

	// ── POST: create schedule ─────────────────────────────────────────────────

	if (req.method === 'POST') {
		let body;
		try {
			body = parse(postSchema, await readJson(req));
		} catch (err) {
			return error(res, err.status ?? 400, err.code ?? 'validation_error', err.message);
		}
		const { agentId, delegationId, periodSeconds, amountPerPeriod } = body;

		// Verify the agent belongs to this user. Delegations are owner-scoped
		// (api/permissions/grant refuses to record one for an agent you do not
		// own), so a schedule funded by a delegation you signed is always for
		// your own agent.
		const [agent] = await sql`
			SELECT id FROM agent_identities
			WHERE id = ${agentId} AND user_id = ${userId} AND deleted_at IS NULL
		`;
		if (!agent) return error(res, 403, 'forbidden', 'agent not found or not owned by you');

		// Verify the delegation is active and belongs to this agent.
		const [delegation] = await sql`
			SELECT id, expires_at FROM agent_delegations
			WHERE id = ${delegationId} AND agent_id = ${agentId} AND status = 'active'
		`;
		if (!delegation)
			return error(res, 400, 'validation_error', 'delegation not found or not active');
		if (delegation.expires_at && new Date(delegation.expires_at) <= new Date()) {
			return error(res, 409, 'delegation_expired', 'delegation has already expired');
		}

		// Idempotency: return existing active subscription rather than duplicating.
		const [existing] = await sql`
			SELECT id, status, next_charge_at
			FROM agent_subscriptions
			WHERE agent_id = ${agentId} AND delegation_id = ${delegationId} AND status = 'active'
		`;
		if (existing) return json(res, 200, { data: existing });

		const nextChargeAt = new Date(Date.now() + periodSeconds * 1000);
		const [row] = await sql`
			INSERT INTO agent_subscriptions
				(user_id, agent_id, delegation_id, period_seconds, amount_per_period, next_charge_at)
			VALUES
				(${userId}, ${agentId}, ${delegationId}, ${periodSeconds}, ${amountPerPeriod}, ${nextChargeAt.toISOString()})
			RETURNING id, status, next_charge_at, created_at
		`;
		return json(res, 201, { data: row });
	}

	// ── GET: detail, incoming view, or the caller's own schedules ─────────────

	if (req.method === 'GET') {
		const id = queryParam(req, 'id');
		const view = queryParam(req, 'view');
		const agentId = queryParam(req, 'agentId');

		if (id) {
			if (!z.string().uuid().safeParse(id).success) {
				return error(res, 400, 'validation_error', 'id must be a uuid');
			}
			const [row] = await sql`
				SELECT ${scheduleColumns()}
				FROM agent_subscriptions s
				JOIN agent_identities  ai ON ai.id = s.agent_id
				JOIN agent_delegations d  ON d.id  = s.delegation_id
				${chargeRollup()}
				WHERE s.id = ${id}
			`;
			// Both sides of the payment may read it; nobody else may learn it exists.
			if (!row || (row.user_id !== userId && row.creator_user_id !== userId)) {
				return error(res, 404, 'not_found', 'subscription not found');
			}
			const charges = await sql`
				SELECT id, subscription_id, amount, chain_id, tx_hash, status, code, outcome,
				       error, charged_at
				FROM subscription_charges
				WHERE subscription_id = ${id}
				ORDER BY charged_at DESC
				LIMIT ${CHARGE_HISTORY_LIMIT}
			`;
			return json(res, 200, {
				data: {
					...presentSchedule(row),
					role: row.user_id === userId ? 'payer' : 'creator',
					charges: charges.map(presentCharge),
				},
			});
		}

		if (agentId && !z.string().uuid().safeParse(agentId).success) {
			return error(res, 400, 'validation_error', 'agentId must be a uuid');
		}

		// ?view=incoming — what is being paid INTO the agents this user owns.
		// Scoped by agent_identities.user_id rather than agent_subscriptions
		// .user_id, so it stays correct the day a third party can fund an agent.
		if (view === 'incoming') {
			const rows = agentId
				? await sql`
					SELECT ${scheduleColumns()}
					FROM agent_subscriptions s
					JOIN agent_identities  ai ON ai.id = s.agent_id
					JOIN agent_delegations d  ON d.id  = s.delegation_id
					${chargeRollup()}
					WHERE ai.user_id = ${userId} AND ai.deleted_at IS NULL AND s.agent_id = ${agentId}
					ORDER BY s.created_at DESC
				`
				: await sql`
					SELECT ${scheduleColumns()}
					FROM agent_subscriptions s
					JOIN agent_identities  ai ON ai.id = s.agent_id
					JOIN agent_delegations d  ON d.id  = s.delegation_id
					${chargeRollup()}
					WHERE ai.user_id = ${userId} AND ai.deleted_at IS NULL
					ORDER BY s.created_at DESC
				`;

			const schedules = rows.map(presentSchedule);
			const active = schedules.filter((s) => s.status === 'active');
			return json(res, 200, {
				data: schedules,
				summary: {
					schedules: schedules.length,
					active: active.length,
					needs_attention: schedules.filter((s) => s.status === 'paused').length,
					received_total: sumUnits(schedules.map((s) => s.charged_total)),
					received_total_display: formatUnits(
						sumUnits(schedules.map((s) => s.charged_total)),
					),
					charges_total: schedules.reduce((n, s) => n + s.charges_total, 0),
					next_charge_at:
						active
							.map((s) => s.next_charge_at)
							.filter(Boolean)
							.sort()[0] ?? null,
				},
			});
		}

		const rows = agentId
			? await sql`
				SELECT ${scheduleColumns()}
				FROM agent_subscriptions s
				JOIN agent_identities  ai ON ai.id = s.agent_id
				JOIN agent_delegations d  ON d.id  = s.delegation_id
				${chargeRollup()}
				WHERE s.user_id = ${userId} AND s.agent_id = ${agentId}
				ORDER BY s.created_at DESC
			`
			: await sql`
				SELECT ${scheduleColumns()}
				FROM agent_subscriptions s
				JOIN agent_identities  ai ON ai.id = s.agent_id
				JOIN agent_delegations d  ON d.id  = s.delegation_id
				${chargeRollup()}
				WHERE s.user_id = ${userId}
				ORDER BY s.created_at DESC
			`;

		const schedules = rows.map(presentSchedule);
		const active = schedules.filter((s) => s.status === 'active');
		return json(res, 200, {
			data: schedules,
			summary: {
				schedules: schedules.length,
				active: active.length,
				needs_attention: schedules.filter((s) => s.status === 'paused').length,
				paid_total: sumUnits(schedules.map((s) => s.charged_total)),
				paid_total_display: formatUnits(sumUnits(schedules.map((s) => s.charged_total))),
				charges_total: schedules.reduce((n, s) => n + s.charges_total, 0),
				next_charge_at:
					active
						.map((s) => s.next_charge_at)
						.filter(Boolean)
						.sort()[0] ?? null,
			},
		});
	}

	// ── PATCH: pause / resume ─────────────────────────────────────────────────

	if (req.method === 'PATCH') {
		const id = queryParam(req, 'id');
		if (!id) return error(res, 400, 'validation_error', 'id query param is required');
		if (!z.string().uuid().safeParse(id).success) {
			return error(res, 400, 'validation_error', 'id must be a uuid');
		}

		let body;
		try {
			body = parse(patchSchema, await readJson(req));
		} catch (err) {
			return error(res, err.status ?? 400, err.code ?? 'validation_error', err.message);
		}

		// Only the payer controls the schedule: it spends their delegation.
		const [current] = await sql`
			SELECT s.status, s.next_charge_at, s.period_seconds,
			       d.status AS delegation_status, d.expires_at AS delegation_expires_at
			FROM agent_subscriptions s
			JOIN agent_delegations d ON d.id = s.delegation_id
			WHERE s.id = ${id} AND s.user_id = ${userId}
		`;
		if (!current) return error(res, 404, 'not_found', 'subscription not found');

		const plan = planStatusChange(body.action, current.status);
		if (!plan.ok) {
			return error(res, plan.code === 'conflict' ? 409 : 400, plan.code, plan.message);
		}

		if (body.action === 'resume') {
			// Resuming a schedule whose delegation is gone would just fail on the
			// next tick and re-pause it. Say so instead of pretending it worked.
			if (current.delegation_status !== 'active') {
				return error(
					res,
					409,
					'delegation_inactive',
					`the signed permission behind this schedule is ${current.delegation_status} — grant a new one to restart it`,
				);
			}
			if (
				current.delegation_expires_at &&
				new Date(current.delegation_expires_at) <= new Date()
			) {
				return error(
					res,
					409,
					'delegation_expired',
					'the signed permission behind this schedule has expired — grant a new one to restart it',
				);
			}

			// Charge from now on rather than back-filling every period missed while
			// paused: a resume must never fire a burst of catch-up charges.
			const nextChargeAt = new Date(
				Date.now() + Number(current.period_seconds) * 1000,
			).toISOString();
			const [row] = await sql`
				UPDATE agent_subscriptions
				SET status = 'active',
				    next_charge_at = ${nextChargeAt},
				    consecutive_failures = 0,
				    last_error = NULL,
				    last_error_code = NULL,
				    resumed_at = NOW()
				WHERE id = ${id} AND user_id = ${userId} AND status = 'paused'
				RETURNING id, status, next_charge_at, resumed_at
			`;
			if (!row) return error(res, 409, 'conflict', 'schedule changed while resuming');
			return json(res, 200, { data: row });
		}

		const [row] = await sql`
			UPDATE agent_subscriptions
			SET status = 'paused', paused_at = NOW()
			WHERE id = ${id} AND user_id = ${userId} AND status = 'active'
			RETURNING id, status, paused_at, next_charge_at
		`;
		if (!row) return error(res, 409, 'conflict', 'schedule changed while pausing');
		return json(res, 200, { data: row });
	}

	// ── DELETE: cancel ────────────────────────────────────────────────────────

	if (req.method === 'DELETE') {
		const id = queryParam(req, 'id');
		if (!id) return error(res, 400, 'validation_error', 'id query param is required');
		if (!z.string().uuid().safeParse(id).success) {
			return error(res, 400, 'validation_error', 'id must be a uuid');
		}

		const [row] = await sql`
			UPDATE agent_subscriptions
			SET status = 'canceled', canceled_at = NOW()
			WHERE id = ${id} AND user_id = ${userId} AND status != 'canceled'
			RETURNING id, status, canceled_at
		`;
		if (!row) return error(res, 404, 'not_found', 'subscription not found or already canceled');
		return json(res, 200, { data: row });
	}
});
