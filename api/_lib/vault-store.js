// @ts-check
// Back-an-Agent Vaults — the DB access layer.
//
// Every read/write against agent_vaults / vault_backers / vault_positions /
// vault_events goes through here, so the routes stay thin and the SQL stays in
// one auditable place. All money columns are numeric(40,0) USDC atomics and come
// back as strings — callers convert with vault-accounting.toBig() before doing
// any arithmetic. Nothing here moves funds or signs; that's vault-trade.js /
// vault-transfer.js. This module is purely the system of record.

import { sql } from './db.js';

// Columns safe to expose publicly (NEVER the encrypted_secret). Spread into a
// SELECT to guarantee the vault keypair ciphertext can't leak through a read.
const PUBLIC_COLS = sql`
	id, agent_id, owner_user_id, network, vault_address, status,
	performance_fee_bps, per_backer_cap_atomics, max_drawdown_bps,
	max_per_trade_atomics, daily_budget_atomics,
	total_shares, peak_share_price_e6, accrued_fee_atomics,
	halt_reason, paused_at, created_at, updated_at
`;

/** Create a vault row. The caller has already generated + encrypted the wallet. */
export async function createVault({
	agentId, ownerUserId, network, vaultAddress, encryptedSecret,
	performanceFeeBps, perBackerCapAtomics, maxDrawdownBps,
	maxPerTradeAtomics, dailyBudgetAtomics,
}) {
	const [row] = await sql`
		INSERT INTO agent_vaults
			(agent_id, owner_user_id, network, vault_address, encrypted_secret,
			 performance_fee_bps, per_backer_cap_atomics, max_drawdown_bps,
			 max_per_trade_atomics, daily_budget_atomics)
		VALUES (
			${agentId}, ${ownerUserId}, ${network}, ${vaultAddress}, ${encryptedSecret},
			${performanceFeeBps}, ${perBackerCapAtomics == null ? null : String(perBackerCapAtomics)},
			${maxDrawdownBps}, ${String(maxPerTradeAtomics)}, ${String(dailyBudgetAtomics)}
		)
		RETURNING ${PUBLIC_COLS}
	`;
	return row;
}

/** Public vault row by id (no secret). */
export async function getVault(id) {
	const [row] = await sql`SELECT ${PUBLIC_COLS} FROM agent_vaults WHERE id = ${id} LIMIT 1`;
	return row || null;
}

/** The active (non-closed) vault for an agent, if any. */
export async function getVaultByAgent(agentId) {
	const [row] = await sql`
		SELECT ${PUBLIC_COLS} FROM agent_vaults
		WHERE agent_id = ${agentId} AND status <> 'closed'
		ORDER BY created_at DESC LIMIT 1
	`;
	return row || null;
}

/**
 * Internal: the vault row WITH the encrypted secret. Only vault-trade.js /
 * vault-transfer.js call this, right before recovering the keypair to sign. Never
 * return this shape to an HTTP response.
 */
export async function getVaultWithSecret(id) {
	const [row] = await sql`
		SELECT ${PUBLIC_COLS}, encrypted_secret FROM agent_vaults WHERE id = ${id} LIMIT 1
	`;
	return row || null;
}

/**
 * Discovery feed: open/paused vaults with their owning agent's identity, ranked.
 * The ranking is computed by the caller against verified reputation; here we just
 * return the raw rows + agent facts and a deposited-backer count.
 */
export async function listVaults({ status = 'open', limit = 60 } = {}) {
	const lim = Math.max(1, Math.min(120, Number(limit) || 60));
	const rows = await sql`
		SELECT
			v.id, v.agent_id, v.network, v.vault_address, v.status,
			v.performance_fee_bps, v.per_backer_cap_atomics, v.max_drawdown_bps,
			v.max_per_trade_atomics, v.daily_budget_atomics,
			v.total_shares, v.peak_share_price_e6, v.created_at, v.updated_at,
			a.name AS agent_name,
			COALESCE(a.profile_image_url, a.avatar_url) AS agent_image,
			a.description AS agent_description,
			(SELECT COUNT(*) FROM vault_backers b WHERE b.vault_id = v.id AND b.shares > 0)::int AS backer_count,
			(SELECT COALESCE(SUM(b.deposited_atomics), 0) FROM vault_backers b WHERE b.vault_id = v.id) AS lifetime_deposited,
			(SELECT e.nav_atomics FROM vault_events e WHERE e.vault_id = v.id AND e.nav_atomics IS NOT NULL ORDER BY e.id DESC LIMIT 1) AS last_nav_atomics
		FROM agent_vaults v
		JOIN agent_identities a ON a.id = v.agent_id AND a.deleted_at IS NULL
		WHERE (${status === 'all'} OR v.status = ${status})
		  AND v.status <> 'closed'
		ORDER BY v.updated_at DESC
		LIMIT ${lim}
	`;
	return rows;
}

/** Vaults the user has backed (their portfolio). */
export async function listBackedVaults(userId, { limit = 60 } = {}) {
	const lim = Math.max(1, Math.min(120, Number(limit) || 60));
	const rows = await sql`
		SELECT
			b.shares, b.cost_basis_atomics, b.deposited_atomics, b.redeemed_atomics,
			b.realized_gain_atomics, b.fees_paid_atomics, b.backer_agent_id,
			v.id, v.agent_id, v.network, v.status, v.performance_fee_bps,
			v.max_drawdown_bps, v.total_shares, v.peak_share_price_e6,
			a.name AS agent_name, COALESCE(a.profile_image_url, a.avatar_url) AS agent_image
		FROM vault_backers b
		JOIN agent_vaults v ON v.id = b.vault_id
		JOIN agent_identities a ON a.id = v.agent_id
		WHERE b.user_id = ${userId} AND b.shares > 0
		ORDER BY b.updated_at DESC
		LIMIT ${lim}
	`;
	return rows;
}

/** A single backer's position in a vault (null if they hold none). */
export async function getBacker(vaultId, userId) {
	const [row] = await sql`
		SELECT * FROM vault_backers WHERE vault_id = ${vaultId} AND user_id = ${userId} LIMIT 1
	`;
	return row || null;
}

/** The list of backers in a vault (for the vault page roster). */
export async function listBackers(vaultId, { limit = 50 } = {}) {
	const lim = Math.max(1, Math.min(200, Number(limit) || 50));
	const rows = await sql`
		SELECT user_id, backer_agent_id, shares, cost_basis_atomics, deposited_atomics, updated_at
		FROM vault_backers
		WHERE vault_id = ${vaultId} AND shares > 0
		ORDER BY shares DESC
		LIMIT ${lim}
	`;
	return rows;
}

/** Open positions held by the vault (marked to market by the caller). */
export async function getOpenPositions(vaultId) {
	return sql`
		SELECT id, mint, token_decimals, amount_raw, cost_atomics, last_mark_atomics, opened_at
		FROM vault_positions WHERE vault_id = ${vaultId} AND status = 'open'
		ORDER BY opened_at ASC
	`;
}

/** Append an event to the immutable ledger. Returns the row id (or null on idem clash). */
export async function recordVaultEvent(e) {
	const rows = await sql`
		INSERT INTO vault_events
			(vault_id, type, user_id, backer_agent_id, shares_delta, atomics_delta,
			 nav_atomics, share_price_e6, signature, status, reason, idempotency_key, meta)
		VALUES (
			${e.vaultId}, ${e.type}, ${e.userId ?? null}, ${e.backerAgentId ?? null},
			${e.sharesDelta == null ? null : String(e.sharesDelta)},
			${e.atomicsDelta == null ? null : String(e.atomicsDelta)},
			${e.navAtomics == null ? null : String(e.navAtomics)},
			${e.sharePriceE6 == null ? null : String(e.sharePriceE6)},
			${e.signature ?? null}, ${e.status ?? 'ok'}, ${e.reason ?? null},
			${e.idempotencyKey ?? null}, ${JSON.stringify(e.meta ?? {})}::jsonb
		)
		ON CONFLICT (vault_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
		RETURNING id
	`;
	return rows.length ? Number(rows[0].id) : null;
}

/** Finalize a previously-recorded (pending) event: status/signature/nav/meta. */
export async function updateVaultEvent(id, patch) {
	await sql`
		UPDATE vault_events SET
			status = COALESCE(${patch.status ?? null}, status),
			signature = COALESCE(${patch.signature ?? null}, signature),
			nav_atomics = ${patch.navAtomics == null ? sql`nav_atomics` : String(patch.navAtomics)},
			share_price_e6 = ${patch.sharePriceE6 == null ? sql`share_price_e6` : String(patch.sharePriceE6)},
			atomics_delta = ${patch.atomicsDelta == null ? sql`atomics_delta` : String(patch.atomicsDelta)},
			meta = meta || ${JSON.stringify(patch.meta ?? {})}::jsonb
		WHERE id = ${id}
	`.catch(() => {});
}

/** Cursor-paginated event feed for the audit trail. */
export async function listVaultEvents(vaultId, { limit = 50, beforeId = null, type = null } = {}) {
	const lim = Math.max(1, Math.min(200, Number(limit) || 50));
	return sql`
		SELECT id, type, user_id, backer_agent_id, shares_delta, atomics_delta,
		       nav_atomics, share_price_e6, signature, status, reason, meta, created_at
		FROM vault_events
		WHERE vault_id = ${vaultId}
		  AND (${beforeId == null}::bool OR id < ${beforeId == null ? 0 : beforeId})
		  AND (${type == null}::bool OR type = ${type})
		ORDER BY id DESC
		LIMIT ${lim}
	`;
}

/**
 * Rolling 24h buy spend (USDC atomics) — the daily-budget denominator.
 *
 * Counts settled AND in-flight buys. A buy that has been claimed but not yet
 * confirmed on-chain has already committed the vault's capital, so leaving it out
 * (as this did until the 2026-08-06 review, L5) let two concurrent buys read the
 * same pre-spend total and both pass a budget only one of them fit in. The
 * authoritative gate is claimVaultBuyBudget below, which reserves under a lock;
 * this read is for display and for the pre-flight message.
 */
export async function getDailyTradeSpend(vaultId) {
	const [r] = await sql`
		SELECT COALESCE(SUM((meta->>'usdc_in')::numeric), 0) AS spent
		FROM vault_events
		WHERE vault_id = ${vaultId} AND type = 'trade' AND status IN ('ok', 'pending')
		  AND (meta->>'side') = 'buy'
		  AND created_at > now() - interval '24 hours'
	`;
	return r?.spent ?? '0';
}

/**
 * Atomically claim rolling-24h budget headroom for a buy AND reserve its pending
 * ledger row, under a per-vault advisory lock.
 *
 * Check-then-insert was two statements, so two owner buys racing on one vault
 * could both read the same pre-spend total, both clear the budget, and both
 * settle: a $X/day ceiling became $X + one trade. Here the sum and the insert are
 * one statement behind `pg_advisory_xact_lock`, mirroring reserveSpendUsd in
 * agent-trade-guards.js, so the second buy sees the first one's pending row.
 *
 * @returns {Promise<{ ok: true, claimId: number, spentBefore: string }
 *                  | { ok: false, reason: 'daily_budget'|'in_flight', spentBefore?: string }>}
 */
export async function claimVaultBuyBudget({
	vaultId, userId, idempotencyKey, usdcInAtomics, dailyBudgetAtomics, reason, meta,
}) {
	const amount = String(usdcInAtomics);
	// A non-positive budget means "no ceiling configured" (same reading as
	// tradeExceedsDailyBudget), so the claim only has to clear idempotency.
	const budget = String(dailyBudgetAtomics ?? 0);
	const rows = await sql`
		WITH locked AS (
			SELECT pg_advisory_xact_lock(hashtextextended(${String(vaultId)}, 0))
		),
		spent AS (
			SELECT COALESCE(SUM((meta->>'usdc_in')::numeric), 0) AS s
			FROM vault_events
			WHERE vault_id = ${vaultId} AND type = 'trade' AND status IN ('ok', 'pending')
			  AND (meta->>'side') = 'buy'
			  AND created_at > now() - interval '24 hours'
		)
		INSERT INTO vault_events
			(vault_id, type, user_id, atomics_delta, status, reason, idempotency_key, meta)
		SELECT ${vaultId}, 'trade', ${userId ?? null}, ${`-${amount}`}, 'pending', ${reason ?? null},
		       ${idempotencyKey ?? null}, ${JSON.stringify(meta ?? {})}::jsonb
		FROM spent, locked
		WHERE ${budget}::numeric <= 0
		   OR spent.s + ${amount}::numeric <= ${budget}::numeric
		ON CONFLICT (vault_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
		RETURNING id, (SELECT s FROM spent)::text AS spent_before
	`;
	if (rows.length) {
		return { ok: true, claimId: Number(rows[0].id), spentBefore: rows[0].spent_before ?? '0' };
	}
	// No row: either the budget rejected it or this idempotency key already claimed
	// one. Distinguish the two so the caller reports the real reason.
	if (idempotencyKey) {
		const [dupe] = await sql`
			SELECT id FROM vault_events
			WHERE vault_id = ${vaultId} AND idempotency_key = ${idempotencyKey} LIMIT 1
		`;
		if (dupe) return { ok: false, reason: 'in_flight' };
	}
	return { ok: false, reason: 'daily_budget', spentBefore: await getDailyTradeSpend(vaultId) };
}

/** Upsert a backer's position after a deposit (mint shares) or redemption (burn). */
export async function applyBackerDelta({ vaultId, userId, backerAgentId, sharesDelta, basisDelta, depositedDelta = 0n, redeemedDelta = 0n, realizedGainDelta = 0n, feesPaidDelta = 0n }) {
	const [row] = await sql`
		INSERT INTO vault_backers
			(vault_id, user_id, backer_agent_id, shares, cost_basis_atomics,
			 deposited_atomics, redeemed_atomics, realized_gain_atomics, fees_paid_atomics)
		VALUES (
			${vaultId}, ${userId}, ${backerAgentId},
			${String(sharesDelta)}, ${String(basisDelta < 0n ? 0n : basisDelta)},
			${String(depositedDelta)}, ${String(redeemedDelta)},
			${String(realizedGainDelta)}, ${String(feesPaidDelta)}
		)
		ON CONFLICT (vault_id, user_id) DO UPDATE SET
			shares = GREATEST(vault_backers.shares + ${String(sharesDelta)}, 0),
			cost_basis_atomics = GREATEST(vault_backers.cost_basis_atomics + ${String(basisDelta)}, 0),
			deposited_atomics = vault_backers.deposited_atomics + ${String(depositedDelta)},
			redeemed_atomics = vault_backers.redeemed_atomics + ${String(redeemedDelta)},
			realized_gain_atomics = vault_backers.realized_gain_atomics + ${String(realizedGainDelta)},
			fees_paid_atomics = vault_backers.fees_paid_atomics + ${String(feesPaidDelta)},
			backer_agent_id = ${backerAgentId},
			updated_at = now()
		RETURNING *
	`;
	return row;
}

/** Move total_shares by a signed delta and ratchet the high-water share-price peak. */
export async function applyVaultShareDelta(vaultId, sharesDelta, peakSharePriceE6 = null) {
	const [row] = await sql`
		UPDATE agent_vaults SET
			total_shares = GREATEST(total_shares + ${String(sharesDelta)}, 0),
			peak_share_price_e6 = ${peakSharePriceE6 == null ? sql`peak_share_price_e6` : sql`GREATEST(peak_share_price_e6, ${String(peakSharePriceE6)})`},
			updated_at = now()
		WHERE id = ${vaultId}
		RETURNING ${PUBLIC_COLS}
	`;
	return row || null;
}

/** Accrue (delta>0) or claim (delta<0) owner performance fees. */
export async function applyAccruedFee(vaultId, deltaAtomics) {
	const [row] = await sql`
		UPDATE agent_vaults SET
			accrued_fee_atomics = GREATEST(accrued_fee_atomics + ${String(deltaAtomics)}, 0),
			updated_at = now()
		WHERE id = ${vaultId}
		RETURNING accrued_fee_atomics
	`;
	return row?.accrued_fee_atomics ?? '0';
}

/** Set vault status (pause/resume/halt/close), recording the reason. */
export async function setVaultStatus(vaultId, status, { haltReason = null } = {}) {
	const [row] = await sql`
		UPDATE agent_vaults SET
			status = ${status},
			halt_reason = ${haltReason},
			paused_at = ${status === 'paused' ? sql`now()` : sql`NULL`},
			updated_at = now()
		WHERE id = ${vaultId}
		RETURNING ${PUBLIC_COLS}
	`;
	return row || null;
}

/** Update disclosed terms (owner-only; caller enforces ownership + safety bounds). */
export async function updateVaultTerms(vaultId, patch) {
	const [row] = await sql`
		UPDATE agent_vaults SET
			performance_fee_bps = COALESCE(${patch.performanceFeeBps ?? null}, performance_fee_bps),
			per_backer_cap_atomics = ${patch.perBackerCapAtomics === undefined ? sql`per_backer_cap_atomics` : (patch.perBackerCapAtomics == null ? null : String(patch.perBackerCapAtomics))},
			max_drawdown_bps = COALESCE(${patch.maxDrawdownBps ?? null}, max_drawdown_bps),
			max_per_trade_atomics = COALESCE(${patch.maxPerTradeAtomics == null ? null : String(patch.maxPerTradeAtomics)}, max_per_trade_atomics),
			daily_budget_atomics = COALESCE(${patch.dailyBudgetAtomics == null ? null : String(patch.dailyBudgetAtomics)}, daily_budget_atomics),
			updated_at = now()
		WHERE id = ${vaultId}
		RETURNING ${PUBLIC_COLS}
	`;
	return row || null;
}

/** Add to / open a token position after a buy. */
export async function upsertPosition({ vaultId, mint, tokenDecimals, amountRawDelta, costDelta, markAtomics = null }) {
	const [row] = await sql`
		INSERT INTO vault_positions (vault_id, mint, token_decimals, amount_raw, cost_atomics, last_mark_atomics, status)
		VALUES (${vaultId}, ${mint}, ${tokenDecimals}, ${String(amountRawDelta)}, ${String(costDelta)}, ${markAtomics == null ? null : String(markAtomics)}, 'open')
		ON CONFLICT (vault_id, mint) WHERE status = 'open' DO UPDATE SET
			amount_raw = vault_positions.amount_raw + ${String(amountRawDelta)},
			cost_atomics = vault_positions.cost_atomics + ${String(costDelta)},
			token_decimals = ${tokenDecimals},
			last_mark_atomics = ${markAtomics == null ? sql`vault_positions.last_mark_atomics` : String(markAtomics)},
			updated_at = now()
		RETURNING *
	`;
	return row;
}

/** Reduce a position after a sell; closes it when the balance hits zero. */
export async function reducePosition({ vaultId, mint, amountRawDelta, proceedsAtomics, costRemovedAtomics }) {
	const [pos] = await sql`SELECT * FROM vault_positions WHERE vault_id = ${vaultId} AND mint = ${mint} AND status = 'open' LIMIT 1`;
	if (!pos) return null;
	const remaining = BigInt(pos.amount_raw) - BigInt(amountRawDelta);
	const realized = BigInt(proceedsAtomics) - BigInt(costRemovedAtomics);
	if (remaining <= 0n) {
		const [row] = await sql`
			UPDATE vault_positions SET
				amount_raw = 0, cost_atomics = 0,
				realized_pnl_atomics = realized_pnl_atomics + ${String(realized)},
				status = 'closed', closed_at = now(), updated_at = now()
			WHERE id = ${pos.id} RETURNING *
		`;
		return row;
	}
	const [row] = await sql`
		UPDATE vault_positions SET
			amount_raw = ${String(remaining)},
			cost_atomics = GREATEST(cost_atomics - ${String(costRemovedAtomics)}, 0),
			realized_pnl_atomics = realized_pnl_atomics + ${String(realized)},
			updated_at = now()
		WHERE id = ${pos.id} RETURNING *
	`;
	return row;
}

/** Mark an open position's last NAV contribution (cosmetic cache for the feed). */
export async function markPosition(positionId, markAtomics) {
	await sql`UPDATE vault_positions SET last_mark_atomics = ${String(markAtomics)}, updated_at = now() WHERE id = ${positionId}`.catch(() => {});
}
