// agent-orders — order reads + state transitions for the evaluation worker.
//
// Single-worker assumption (documented, mirrors agent-sniper): per-order state
// moves through an atomic claim (active|partial → firing) so a fire is owned by
// exactly one sweep. Across processes, the custody idempotency_key on each fill
// (order:<id>:slice:<n>) is the real double-spend backstop.

import { sql } from '../../api/_lib/db.js';

/**
 * Active/partial orders on this network: the sweep's work set, least-recently-seen
 * first.
 *
 * A price or conditional order has no next_fire_at, so ordering by that column
 * alone with NULLS LAST parked every one of them behind every scheduled order:
 * once the table held more than `limit` orders, the price side of the book would
 * never be evaluated again. COALESCE rotates the work set instead (last_eval_at
 * is stamped on every sweep), while a due slice still sorts ahead of an order
 * that was evaluated a moment ago.
 */
export async function getActiveOrders(network, limit = 500) {
	return sql`
		SELECT * FROM orders
		WHERE network = ${network}
		  AND status IN ('active', 'partial')
		ORDER BY COALESCE(next_fire_at, last_eval_at, created_at) ASC
		LIMIT ${limit}
	`;
}

/** Expire orders past their deadline (active/partial only). Returns count. */
export async function expireOrders(network) {
	const rows = await sql`
		UPDATE orders SET status = 'expired', updated_at = now()
		WHERE network = ${network}
		  AND status IN ('active', 'partial')
		  AND expires_at IS NOT NULL AND expires_at < now()
		RETURNING id
	`;
	return rows.length;
}

/** Reset orders stuck in 'firing' (a crash mid-fire) back to their prior state. */
export async function recoverStaleFiring(network, staleMs = 180_000) {
	const rows = await sql`
		UPDATE orders
		SET status = CASE WHEN fill_count > 0 THEN 'partial' ELSE 'active' END, updated_at = now()
		WHERE network = ${network} AND status = 'firing'
		  AND updated_at < now() - (${Math.round(staleMs / 1000)} || ' seconds')::interval
		RETURNING id
	`;
	return rows.length;
}

/**
 * Atomically claim an order for firing. Returns true iff this caller flipped it
 * active|partial → firing (so exactly one sweep fires it).
 */
export async function claimFire(orderId) {
	const rows = await sql`
		UPDATE orders SET status = 'firing', updated_at = now()
		WHERE id = ${orderId} AND status IN ('active', 'partial')
		RETURNING id
	`;
	return rows.length > 0;
}

/** Release a claimed order back to a non-firing state (e.g. fire aborted). */
export async function releaseFire(orderId, status, error = null) {
	await sql`
		UPDATE orders SET status = ${status}, last_error = ${error}, updated_at = now()
		WHERE id = ${orderId} AND status = 'firing'
	`;
}

/** Persist the per-sweep observation (last metric value + trailing high/low-water). */
export async function markEvaluated(orderId, { lastPrice = null, peak = null } = {}) {
	await sql`
		UPDATE orders
		SET last_eval_at = now(),
		    last_price = COALESCE(${lastPrice}, last_price),
		    peak_price = COALESCE(${peak}, peak_price)
		WHERE id = ${orderId}
	`;
}

/** Seed reference_price (first observation) so price_change_pct has a baseline. */
export async function seedReference(orderId, value) {
	await sql`UPDATE orders SET reference_price = ${value}, peak_price = COALESCE(peak_price, ${value}) WHERE id = ${orderId} AND reference_price IS NULL`;
}

/**
 * Record a fill and advance the order's lifecycle in one place.
 *
 * @param {object} o
 * @param {object} o.order            the order row
 * @param {object} o.fill             { sliceIndex, triggerReason, triggerPrice, solAmount, tokenAmount, priceImpactPct, venue, signature, custodyEventId, status, detail, meta }
 * @param {boolean} o.terminal        true → order is fully filled (price/conditional, or last slice)
 * @param {boolean} [o.terminalError] true → a FAILED fill that should halt the order to 'error'
 *                                    (a block that won't clear by retrying), not return to active
 * @param {string|null} o.nextFireAt  ISO for the next scheduled slice (dca/twap), or null
 */
export async function recordFillAndAdvance({ order, fill, terminal, terminalError = false, nextFireAt = null }) {
	const confirmedSol = fill.status === 'failed' ? 0 : Number(fill.solAmount || 0);
	const confirmedTok = fill.status === 'failed' ? 0 : Number(fill.tokenAmount || 0);

	await sql`
		INSERT INTO order_fills
			(order_id, agent_id, network, slice_index, side, trigger_reason, trigger_price,
			 sol_amount, token_amount, price_impact_pct, venue, signature, custody_event_id, status, detail, meta)
		VALUES (
			${order.id}, ${order.agent_id}, ${order.network}, ${fill.sliceIndex ?? null}, ${order.side},
			${fill.triggerReason || null}, ${fill.triggerPrice ?? null}, ${fill.solAmount ?? null},
			${fill.tokenAmount ?? null}, ${fill.priceImpactPct ?? null}, ${fill.venue || null},
			${fill.signature || null}, ${fill.custodyEventId ?? null}, ${fill.status || 'pending'},
			${fill.detail || null}, ${fill.meta ? JSON.stringify(fill.meta) : null}::jsonb)
	`;

	// A failed fill does not advance fills/budget and must not consume a slice. A
	// terminal failure (a block that won't clear by retrying) halts the order to
	// 'error'; an ordinary failure returns it to its prior state to retry next sweep.
	if (fill.status === 'failed') {
		const nextStatus = terminalError ? 'error' : (order.fill_count > 0 ? 'partial' : 'active');
		await sql`
			UPDATE orders SET status = ${nextStatus},
			    last_error = ${(fill.detail || 'fill_failed').slice(0, 280)}, updated_at = now()
			WHERE id = ${order.id} AND status = 'firing'
		`;
		return;
	}

	// Advance the schedule counter for dca/twap.
	let schedule = order.schedule || null;
	if (schedule && (order.type === 'dca' || order.type === 'twap')) {
		schedule = { ...schedule, filled_slices: (schedule.filled_slices || 0) + 1 };
	}
	const status = terminal ? 'filled' : 'partial';

	await sql`
		UPDATE orders SET
			status = ${status},
			filled_sol = filled_sol + ${confirmedSol},
			filled_tokens = filled_tokens + ${confirmedTok},
			fill_count = fill_count + 1,
			schedule = ${schedule ? JSON.stringify(schedule) : null}::jsonb,
			next_fire_at = ${terminal ? null : nextFireAt},
			last_error = NULL,
			updated_at = now()
		WHERE id = ${order.id} AND status = 'firing'
	`;
}

/** Load (and lightly cache) an agent's meta + user for the execution path. */
export async function loadAgent(agentId) {
	const [row] = await sql`SELECT id, user_id, meta FROM agent_identities WHERE id = ${agentId} AND deleted_at IS NULL`;
	if (!row) return null;
	return { id: row.id, userId: row.user_id, meta: { ...(row.meta || {}) } };
}
