// Spend Governor — policy enforcement layer for Agent Payment Sessions.
//
// Design principle (from AWS AgentCore Payments architecture):
//   "The agent does not hold a wallet. It proposes spend. Governance enforces policy."
//
// This module is the single chokepoint every session-based payment must pass through.
// Five checks, in order:
//   1. Session exists and is active (not expired, cancelled, or exhausted)
//   2. Expiry time has not passed
//   3. URL is in the session's host allowlist (if set)
//   4. Amount does not exceed the per-transaction ceiling (if set)
//   5. Remaining budget is sufficient — atomically decrements spent_usdc
//
// The atomic budget decrement uses a SQL UPDATE ... RETURNING with a WHERE clause
// that checks (budget_usdc - spent_usdc >= amount), so concurrent payment requests
// can never collectively overspend a session. If two requests arrive simultaneously
// and both would fit individually but together would exceed the budget, exactly one
// wins the race; the other gets INSUFFICIENT_BUDGET.
//
// Governance errors throw SpendGovernorError with a machine-readable `code` so the
// API layer can return 402 vs 403 vs 429 appropriately. The caller must call
// rollbackReservation() if the downstream x402 payment fails after the budget has
// been reserved — otherwise the session bleeds budget on failed payments.

import { createHmac, randomBytes } from 'node:crypto';
import { sql } from '../db.js';
import { env } from '../env.js';
import {
	usdToAtomics,
	atomicsToUsd,
	normalizeHost,
	statusVerdict,
	expiryVerdict,
	allowlistVerdict,
	perTxVerdict,
	budgetVerdict,
} from './policy.js';

// The policy predicates below are shared with the dry-run simulator
// (api/pay/simulate.js) so a simulated verdict and an enforced one can never
// disagree. Re-exported here because this module was the original home of these
// helpers and several callers already import them from this path.
export { usdToAtomics, atomicsToUsd, normalizeHost };

export class SpendGovernorError extends Error {
	constructor(code, message, detail = {}) {
		super(message);
		this.name = 'SpendGovernorError';
		this.code = code;
		this.detail = detail;
		// Map each code to a sensible HTTP status
		this.status = {
			session_not_found: 404,
			session_inactive: 403,
			session_expired: 403,
			allowlist_blocked: 403,
			per_tx_exceeded: 402,
			insufficient_budget: 402,
			invalid_token: 401,
		}[code] ?? 403;
	}
}

// HMAC token signing. The token itself is never stored — only its SHA-256 HMAC.
// Format: `pss_<sessionId>_<random32hex>` — human-readable, prefix-scoped.
const TOKEN_PREFIX = 'pss_';

function hmacKey() {
	// env.PAYMENT_SESSION_SECRET already resolves the whole fallback chain
	// (PAYMENT_SESSION_SECRET -> WALLET_CAPABILITY_SECRET -> WALLET_ENCRYPTION_KEY
	// -> JWT_SECRET). Reading the raw process env here instead would silently ignore
	// a configured PAYMENT_SESSION_SECRET, which is exactly the bug this replaced.
	const k = env.PAYMENT_SESSION_SECRET;
	if (!k) throw new Error('PAYMENT_SESSION_SECRET is not configured');
	return k;
}

export function generateSessionToken(sessionId) {
	const rand = randomBytes(16).toString('hex');
	return `${TOKEN_PREFIX}${sessionId}_${rand}`;
}

export function hashToken(token) {
	return createHmac('sha256', hmacKey()).update(String(token)).digest('hex');
}

// Extract sessionId from a token without verifying it. Used for DB lookup before
// the constant-time hash comparison.
export function extractSessionId(token) {
	const s = String(token || '');
	if (!s.startsWith(TOKEN_PREFIX)) return null;
	const rest = s.slice(TOKEN_PREFIX.length);
	// Format after prefix: <uuid>_<random> — uuid is exactly 36 chars
	if (rest.length < 37 || rest[36] !== '_') return null;
	return rest.slice(0, 36);
}

/** Turn a policy rejection from policy.js into the thrown governance error. */
function throwVerdict(verdict) {
	if (verdict) throw new SpendGovernorError(verdict.code, verdict.message, verdict.detail);
}

/**
 * Verify a session token and return the session row.
 * Throws SpendGovernorError on any auth / state failure.
 */
export async function verifySessionToken(token) {
	const sessionId = extractSessionId(token);
	if (!sessionId) throw new SpendGovernorError('invalid_token', 'Invalid session token format');

	const hash = hashToken(token);
	const [row] = await sql`
		SELECT id, user_id, agent_id, label, budget_usdc, spent_usdc,
		       max_per_tx_usdc, allowed_hosts, network, connector_ref,
		       status, expires_at, session_metadata
		FROM payment_sessions
		WHERE id = ${sessionId} AND token_hash = ${hash}
		LIMIT 1
	`;

	if (!row) throw new SpendGovernorError('invalid_token', 'Session token not found or invalid');
	return row;
}

/**
 * Enforce governance policy and atomically reserve budget for a payment.
 *
 * @param {object} opts
 * @param {string} opts.token        - Session bearer token
 * @param {string} opts.url          - Target endpoint URL (for allowlist check)
 * @param {bigint} opts.amountAtomics - Payment amount in USDC atomics (6 decimals)
 * @returns {Promise<{ session: object, reservationId: string }>}
 * @throws {SpendGovernorError} on any policy violation
 */
export async function reserveSessionSpend({ token, url, amountAtomics }) {
	// Phase 1: token verification
	const session = await verifySessionToken(token);

	// Phase 2: status check
	throwVerdict(statusVerdict(session.status));

	// Phase 3: time expiry (belt-and-suspenders; DB sweep also marks expired rows)
	const now = new Date();
	const expired = expiryVerdict(session.expires_at, now);
	if (expired) {
		// Mark it expired so future checks skip the DB read
		await sql`
			UPDATE payment_sessions SET status = 'expired', updated_at = now()
			WHERE id = ${session.id} AND status = 'active'
		`.catch(() => {});
		throwVerdict(expired);
	}

	// Phase 4: URL allowlist enforcement
	throwVerdict(allowlistVerdict(url, session.allowed_hosts));

	// Phase 5: per-transaction ceiling
	throwVerdict(perTxVerdict(amountAtomics, session.max_per_tx_usdc));

	// Phase 6: atomic budget reservation
	// The WHERE clause ensures (budget_usdc - spent_usdc) >= amountAtomics before
	// incrementing — race-safe: two concurrent requests cannot both succeed if
	// only one fits in the remaining budget.
	const amount = BigInt(amountAtomics);
	const [updated] = await sql`
		UPDATE payment_sessions
		SET spent_usdc = spent_usdc + ${amount.toString()},
		    updated_at = now()
		WHERE id = ${session.id}
		  AND status = 'active'
		  AND (budget_usdc - spent_usdc) >= ${amount.toString()}
		RETURNING id, spent_usdc, budget_usdc
	`;

	if (!updated) {
		// Could be exhausted mid-race; check to give a precise error
		const [fresh] = await sql`
			SELECT budget_usdc, spent_usdc FROM payment_sessions WHERE id = ${session.id}
		`;
		const remaining = fresh ? BigInt(fresh.budget_usdc) - BigInt(fresh.spent_usdc) : 0n;
		// The SQL predicate already decided; budgetVerdict only phrases the failure,
		// using the same wording the simulator shows for a predicted shortfall.
		throwVerdict(
			budgetVerdict(amount, remaining) ?? {
				code: 'insufficient_budget',
				message: 'Session was not active when the payment was reserved',
				detail: { need_usd: atomicsToUsd(amount), remaining_usd: atomicsToUsd(remaining) },
			},
		);
	}

	// If the session is now fully consumed, mark it exhausted
	if (BigInt(updated.spent_usdc) >= BigInt(updated.budget_usdc)) {
		await sql`
			UPDATE payment_sessions SET status = 'exhausted', updated_at = now()
			WHERE id = ${session.id} AND status = 'active'
		`.catch(() => {});
	}

	const reservationId = `res_${session.id}_${Date.now()}`;
	return { session: { ...session, spent_usdc: updated.spent_usdc }, reservationId };
}

/**
 * Roll back a budget reservation after a failed payment.
 * Decrements spent_usdc by the reserved amount and restores 'active' if exhausted.
 */
export async function rollbackReservation(sessionId, amountAtomics) {
	const amount = BigInt(amountAtomics);
	await sql`
		UPDATE payment_sessions
		SET spent_usdc = greatest(0, spent_usdc - ${amount.toString()}),
		    status = CASE WHEN status = 'exhausted' THEN 'active' ELSE status END,
		    updated_at = now()
		WHERE id = ${sessionId}
		  AND status IN ('active', 'exhausted')
	`;
}

/**
 * Mark a session execution record and finalize its outcome.
 */
export async function recordExecution({
	sessionId,
	userId,
	endpointUrl,
	method,
	amountAtomics,
	network,
	txHash,
	payerAddress,
	payeeAddress,
	status,
	errorCode,
	errorMessage,
	responseBody,
	durationMs,
	idempotencyKey,
}) {
	const host = (() => {
		try { return new URL(endpointUrl).hostname; }
		catch { return ''; }
	})();

	await sql`
		INSERT INTO payment_session_executions
			(session_id, user_id, endpoint_url, endpoint_host, method,
			 amount_usdc, network, tx_hash, payer_address, payee_address,
			 status, error_code, error_message, response_body,
			 duration_ms, idempotency_key)
		VALUES
			(${sessionId}, ${userId}, ${endpointUrl}, ${host}, ${method ?? 'GET'},
			 ${amountAtomics.toString()}, ${network}, ${txHash ?? null},
			 ${payerAddress ?? null}, ${payeeAddress ?? null},
			 ${status}, ${errorCode ?? null}, ${errorMessage ?? null},
			 ${responseBody != null ? JSON.stringify(responseBody) : null},
			 ${durationMs ?? null}, ${idempotencyKey ?? null})
		ON CONFLICT (idempotency_key) DO NOTHING
	`;
}
