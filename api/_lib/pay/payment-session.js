// Payment Session CRUD — lifecycle management for Agent Payment Sessions.
//
// Sessions are the funding envelope for platform-managed agent payments.
// A developer creates a session with a budget (drawn from their credits),
// hands the session token to an agent, and the agent calls paid x402
// endpoints via /api/pay/execute without needing its own private key.
//
// Token design:
//   - Generated as `pss_<sessionId>_<random32hex>`
//   - Never stored plaintext; only the HMAC-SHA256 hash is persisted
//   - Caller holds the token; server verifies it by hashing and comparing
//
// Budget accounting:
//   - budget_usdc is USDC atomic units (6 decimals), matching the x402 standard
//   - budget is drawn from the creator's credit balance at creation time
//   - a cancelled/expired session refunds the un-spent portion back to credits

import { randomUUID } from 'node:crypto';
import { sql } from '../db.js';
import { debitCredits, creditAccount } from '../credits.js';
import {
	generateSessionToken,
	hashToken,
	usdToAtomics,
	atomicsToUsd,
	normalizeHost,
} from './spend-governor.js';
import { SESSION_LIMITS } from './policy.js';

const {
	MAX_LABEL_LEN,
	MAX_ALLOWED_HOSTS,
	MIN_BUDGET_USD,
	MAX_BUDGET_USD,
	MIN_TTL_SECONDS,
	MAX_TTL_SECONDS,
} = SESSION_LIMITS;

function bad(message, code = 'bad_request') {
	return Object.assign(new Error(message), { status: 400, code });
}

function normalizeTtl(ttlSeconds) {
	const n = Number(ttlSeconds ?? 3600);
	if (!Number.isFinite(n) || n < MIN_TTL_SECONDS || n > MAX_TTL_SECONDS) {
		throw bad(
			`expiry_seconds must be between ${MIN_TTL_SECONDS} and ${MAX_TTL_SECONDS}`,
			'invalid_ttl',
		);
	}
	return Math.round(n);
}

function normalizeAllowedHosts(raw) {
	if (!raw) return [];
	const arr = Array.isArray(raw) ? raw : String(raw).split(/[\s,]+/);
	const hosts = arr.map(normalizeHost).filter(Boolean);
	if (hosts.length > MAX_ALLOWED_HOSTS)
		throw bad(`allowed_hosts may contain at most ${MAX_ALLOWED_HOSTS} entries`);
	return [...new Set(hosts)]; // deduplicate
}

function normalizeBudget(budgetUsd) {
	const n = Number(budgetUsd);
	if (!Number.isFinite(n) || n < MIN_BUDGET_USD || n > MAX_BUDGET_USD) {
		throw bad(
			`budget_usd must be between $${MIN_BUDGET_USD} and $${MAX_BUDGET_USD}`,
			'invalid_budget',
		);
	}
	return n;
}

function normalizeMaxPerTx(maxPerTxUsd) {
	if (maxPerTxUsd == null) return null;
	const n = Number(maxPerTxUsd);
	if (!Number.isFinite(n) || n < 0.000001) throw bad('max_per_tx_usd must be > $0.000001');
	return n;
}

/**
 * Create a new payment session.
 *
 * @param {object} opts
 * @param {string} opts.userId           - Creator's user ID
 * @param {string} [opts.agentId]        - Optional: agent authorized to use this session
 * @param {string} [opts.label]          - Human-readable label
 * @param {number} opts.budgetUsd        - Total budget in USD
 * @param {number} [opts.maxPerTxUsd]    - Per-payment ceiling in USD
 * @param {string[]} [opts.allowedHosts] - If set, only pay endpoints at these hosts
 * @param {string} [opts.network]        - 'solana' | 'base' (default: 'solana')
 * @param {number} [opts.expirySeconds]  - Session lifetime in seconds (default: 3600)
 * @param {object} [opts.metadata]       - Arbitrary caller metadata
 * @returns {Promise<{ session: object, token: string }>}
 */
export async function createPaymentSession({
	userId,
	agentId,
	label,
	budgetUsd,
	maxPerTxUsd,
	allowedHosts,
	network = 'solana',
	expirySeconds,
	metadata = {},
}) {
	if (!userId) throw bad('userId is required');

	const budgetN = normalizeBudget(budgetUsd);
	const budgetAtomics = usdToAtomics(budgetN);
	const maxPerTxAtomics = maxPerTxUsd != null ? usdToAtomics(normalizeMaxPerTx(maxPerTxUsd)) : null;
	const hosts = normalizeAllowedHosts(allowedHosts);
	const ttl = normalizeTtl(expirySeconds);
	const net = network === 'base' ? 'base' : 'solana';
	const cleanLabel = String(label ?? '').trim().slice(0, MAX_LABEL_LEN);

	// Debit the budget from the user's credit balance up-front.
	// If the balance is insufficient, this throws a 402 from credits.js.
	const idempotencyKey = `paysess_create_${randomUUID()}`;
	await debitCredits({
		userId,
		amountUsd: budgetN,
		action: 'payment_session_create',
		refType: 'payment_session',
		refId: null, // filled in after INSERT
		idempotencyKey,
	});

	// Generate the bearer token (never stored; only its hash is persisted)
	// We generate the UUID first so we can include it in the token.
	const sessionId = randomUUID();
	const token = generateSessionToken(sessionId);
	const tokenHash = hashToken(token);

	const expiresAt = new Date(Date.now() + ttl * 1000);

	const [row] = await sql`
		INSERT INTO payment_sessions
			(id, user_id, agent_id, label, budget_usdc, max_per_tx_usdc,
			 allowed_hosts, network, status, expires_at, token_hash, session_metadata)
		VALUES
			(${sessionId}, ${userId}, ${agentId ?? null},
			 ${cleanLabel}, ${budgetAtomics.toString()},
			 ${maxPerTxAtomics != null ? maxPerTxAtomics.toString() : null},
			 ${hosts}, ${net}, 'active', ${expiresAt.toISOString()},
			 ${tokenHash}, ${JSON.stringify(metadata)}::jsonb)
		RETURNING id, user_id, agent_id, label, budget_usdc, spent_usdc,
		          max_per_tx_usdc, allowed_hosts, network, status, expires_at,
		          session_metadata, created_at
	`;

	// Back-fill the ref_id now that we have the session ID
	await sql`
		UPDATE credit_ledger SET ref_id = ${sessionId}
		WHERE idempotency_key = ${idempotencyKey}
	`.catch(() => {});

	return {
		session: formatSession(row),
		token,
	};
}

/**
 * Get a session by ID. Returns null if not found or not owned by userId.
 */
export async function getPaymentSession(sessionId, userId) {
	const [row] = await sql`
		SELECT id, user_id, agent_id, label, budget_usdc, spent_usdc,
		       max_per_tx_usdc, allowed_hosts, network, status, expires_at,
		       session_metadata, created_at, updated_at
		FROM payment_sessions
		WHERE id = ${sessionId}
		  AND (${userId}::uuid IS NULL OR user_id = ${userId}::uuid)
		LIMIT 1
	`;
	return row ? formatSession(row) : null;
}

/**
 * List sessions for a user. Returns latest-first.
 */
export async function listPaymentSessions(userId, { status, limit = 20, cursor } = {}) {
	const lim = Math.min(Math.max(Math.floor(Number(limit)) || 20, 1), 100);
	const rows = await sql`
		SELECT id, user_id, agent_id, label, budget_usdc, spent_usdc,
		       max_per_tx_usdc, allowed_hosts, network, status, expires_at,
		       session_metadata, created_at, updated_at
		FROM payment_sessions
		WHERE user_id = ${userId}
		  AND (${status ?? null}::text IS NULL OR status = ${status ?? null})
		  AND (${cursor ?? null}::timestamptz IS NULL OR created_at < ${cursor ?? null}::timestamptz)
		ORDER BY created_at DESC
		LIMIT ${lim + 1}
	`;

	const hasMore = rows.length > lim;
	const items = rows.slice(0, lim).map(formatSession);
	return {
		items,
		next_cursor: hasMore ? items[items.length - 1].created_at : null,
	};
}

/**
 * Update mutable fields on an active session.
 * Only label, allowed_hosts, and max_per_tx_usd can be changed after creation.
 * Returns the updated session row or null if not found / not owned / not active.
 */
export async function updatePaymentSession(sessionId, userId, { label, allowedHosts, maxPerTxUsd } = {}) {
	const params = { id: sessionId, userId };

	if (label !== undefined) {
		params.label = String(label).trim().slice(0, MAX_LABEL_LEN);
	}
	if (allowedHosts !== undefined) {
		params.allowedHosts = normalizeAllowedHosts(allowedHosts);
	}
	if (maxPerTxUsd !== undefined) {
		params.maxPerTxAtomics = maxPerTxUsd != null ? usdToAtomics(normalizeMaxPerTx(maxPerTxUsd)).toString() : null;
	}

	const [row] = await sql`
		UPDATE payment_sessions
		SET
			label = CASE WHEN ${params.label !== undefined}::boolean THEN ${params.label ?? null} ELSE label END,
			allowed_hosts = CASE WHEN ${params.allowedHosts !== undefined}::boolean THEN ${params.allowedHosts ?? []} ELSE allowed_hosts END,
			max_per_tx_usdc = CASE WHEN ${params.maxPerTxAtomics !== undefined}::boolean THEN ${params.maxPerTxAtomics ?? null}::bigint ELSE max_per_tx_usdc END,
			updated_at = now()
		WHERE id = ${sessionId} AND user_id = ${userId} AND status = 'active'
		RETURNING id, user_id, agent_id, label, budget_usdc, spent_usdc,
		          max_per_tx_usdc, allowed_hosts, network, status, expires_at,
		          session_metadata, created_at, updated_at
	`;
	return row ? formatSession(row) : null;
}

/**
 * Cancel a session. Refunds un-spent budget to the user's credit balance.
 */
export async function cancelPaymentSession(sessionId, userId) {
	const [row] = await sql`
		UPDATE payment_sessions
		SET status = 'cancelled', updated_at = now()
		WHERE id = ${sessionId} AND user_id = ${userId}
		  AND status IN ('active', 'exhausted')
		RETURNING id, budget_usdc, spent_usdc, user_id
	`;
	if (!row) return null;

	// Refund the un-spent portion
	const refundAtomics = BigInt(row.budget_usdc) - BigInt(row.spent_usdc);
	if (refundAtomics > 0n) {
		const refundUsd = atomicsToUsd(refundAtomics);
		await creditAccount({
			userId: row.user_id,
			amountUsd: refundUsd,
			kind: 'refund',
			action: 'payment_session_cancel',
			refType: 'payment_session',
			refId: sessionId,
			idempotencyKey: `paysess_refund_${sessionId}`,
		}).catch(() => {});
	}

	return { id: sessionId, refunded_usd: atomicsToUsd(refundAtomics) };
}

/**
 * List executions for a session.
 */
export async function listSessionExecutions(sessionId, userId, { limit = 20, cursor } = {}) {
	const lim = Math.min(Math.max(Math.floor(Number(limit)) || 20, 1), 100);
	const rows = await sql`
		SELECT id, endpoint_url, endpoint_host, method, amount_usdc,
		       network, tx_hash, payer_address, payee_address,
		       status, error_code, duration_ms, created_at
		FROM payment_session_executions
		WHERE session_id = ${sessionId}
		  AND user_id = ${userId}
		  AND (${cursor ?? null}::timestamptz IS NULL OR created_at < ${cursor ?? null}::timestamptz)
		ORDER BY created_at DESC
		LIMIT ${lim + 1}
	`;

	const hasMore = rows.length > lim;
	const items = rows.slice(0, lim).map(formatExecution);
	return { items, next_cursor: hasMore ? items[items.length - 1].created_at : null };
}

/**
 * Aggregate spend stats across all sessions for a user.
 */
export async function getPaymentStats(userId) {
	const [stats] = await sql`
		SELECT
			count(*) FILTER (WHERE status = 'active') AS active_sessions,
			count(*) FILTER (WHERE status = 'exhausted') AS exhausted_sessions,
			count(*) FILTER (WHERE status = 'cancelled') AS cancelled_sessions,
			count(*) FILTER (WHERE status = 'expired') AS expired_sessions,
			coalesce(sum(budget_usdc), 0) AS total_budget_atomics,
			coalesce(sum(spent_usdc), 0) AS total_spent_atomics
		FROM payment_sessions
		WHERE user_id = ${userId}
	`;

	const [execStats] = await sql`
		SELECT
			count(*) FILTER (WHERE e.status = 'settled') AS settled_count,
			count(*) FILTER (WHERE e.status = 'failed') AS failed_count,
			coalesce(sum(e.amount_usdc) FILTER (WHERE e.status = 'settled'), 0) AS settled_atomics,
			count(DISTINCT e.endpoint_host) AS unique_endpoints
		FROM payment_session_executions e
		JOIN payment_sessions s ON s.id = e.session_id
		WHERE s.user_id = ${userId}
	`;

	return {
		sessions: {
			active: Number(stats?.active_sessions ?? 0),
			exhausted: Number(stats?.exhausted_sessions ?? 0),
			cancelled: Number(stats?.cancelled_sessions ?? 0),
			expired: Number(stats?.expired_sessions ?? 0),
			total_budget_usd: atomicsToUsd(stats?.total_budget_atomics ?? 0),
			total_spent_usd: atomicsToUsd(stats?.total_spent_atomics ?? 0),
		},
		executions: {
			settled: Number(execStats?.settled_count ?? 0),
			failed: Number(execStats?.failed_count ?? 0),
			settled_usd: atomicsToUsd(execStats?.settled_atomics ?? 0),
			unique_endpoints: Number(execStats?.unique_endpoints ?? 0),
		},
	};
}

function formatSession(row) {
	return {
		id: row.id,
		user_id: row.user_id,
		agent_id: row.agent_id ?? null,
		label: row.label ?? '',
		budget_usd: atomicsToUsd(row.budget_usdc),
		spent_usd: atomicsToUsd(row.spent_usdc),
		remaining_usd: atomicsToUsd(BigInt(row.budget_usdc) - BigInt(row.spent_usdc)),
		max_per_tx_usd: row.max_per_tx_usdc != null ? atomicsToUsd(row.max_per_tx_usdc) : null,
		allowed_hosts: row.allowed_hosts ?? [],
		network: row.network,
		status: row.status,
		expires_at: row.expires_at,
		metadata: row.session_metadata ?? {},
		created_at: row.created_at,
		updated_at: row.updated_at ?? null,
	};
}

function formatExecution(row) {
	return {
		id: row.id,
		endpoint_url: row.endpoint_url,
		endpoint_host: row.endpoint_host,
		method: row.method,
		amount_usd: atomicsToUsd(row.amount_usdc),
		network: row.network,
		tx_hash: row.tx_hash ?? null,
		payer_address: row.payer_address ?? null,
		payee_address: row.payee_address ?? null,
		status: row.status,
		error_code: row.error_code ?? null,
		duration_ms: row.duration_ms ?? null,
		created_at: row.created_at,
	};
}
