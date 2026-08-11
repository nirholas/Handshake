// Per-agent spend guardrails + custody ledger — the single policy that governs
// every outbound movement of a custodial agent wallet's funds.
//
// One policy, enforced everywhere:
//   - withdraw  (api/agents/solana-wallet.js handleWithdraw)
//   - x402 pay  (api/x402-pay.js)
//   - snipe     (workers/agent-sniper/executor.js)
//   - trade     (the authenticated agent-wallet trade endpoint — calls these)
//
// Limits are stored on the agent row at meta.spend_limits and are opt-in: an
// unset ceiling (null) means "no global cap" so existing automated flows keep
// their own per-feature caps until an owner tightens the policy. Once an owner
// sets a ceiling it is a HARD limit applied uniformly across all four paths.
//
//   daily_usd          rolling-24h total USD-equivalent outflow ceiling
//   per_tx_usd         max USD-equivalent for any single outbound tx
//   per_counterparty_daily_usd  rolling-24h ceiling PER recipient/payee
//   withdraw_allowlist if non-empty, withdraws may only target these addresses
//
// Spends are recorded into agent_custody_events (the audit trail + ledger). The
// daily ceiling is enforced by summing the last 24h of priced spend rows. SOL
// and USDC are always priceable; an arbitrary SPL withdraw that we can't price
// is governed by the allowlist (+ the per-user withdraw rate limit) rather than
// the USD cap — withdraw is an owner-initiated recovery path, not an autonomous
// spend, so we never block the owner from sweeping their own funds out.

import { PublicKey } from '@solana/web3.js';
import { sql } from './db.js';
import { solUsdPrice } from './avatar-wallet.js';
import { logAudit } from './audit.js';
// The wallet's behavioral immune system — an additive anomaly predicate layered on
// top of the static caps in this file. See api/_lib/anomaly-events.js +
// api/_lib/wallet-anomaly.js. Only referenced inside function bodies, so the
// mutual import with that module resolves fine at call time.
import { guardOutboundAnomaly } from './anomaly-events.js';
// Natural-language spend policies: the LLM authors the rule document, this pure,
// total evaluator enforces it. Layered ON TOP of the numeric caps below — never
// weakening them. See api/_lib/spend-policy-rules.js.
import {
	getPolicyRules, normalizePolicyRules, evaluatePolicy, isDenied,
	referencedFields, describePolicyRules, diffPolicies,
} from './spend-policy-rules.js';
// Scoped session keys (least-privilege capabilities). Imported for the additive
// capability gate composed into enforceSpendLimit / reserveSpendUsd below. The
// import is circular (wallet-capabilities imports recordCustodyEvent from here);
// safe because both sides only touch the bindings at runtime, never at module eval.
import {
	evaluateCapabilityScope, capabilityError, capabilitySpentUsd, checkAggregate,
	resolveCapabilityForSpend, reserveCapabilitySpend,
} from './wallet-capabilities.js';

// Base58 alphabet, 32–44 chars covers every ed25519 pubkey. A cheap pre-filter
// before the (heavier) PublicKey parse + curve check.
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const MAX_ALLOWLIST = 50;

// Fee + rent headroom kept above a buy so it never fails for lack of lamports to
// pay the network fee / open the token ATA. The single source of truth for the
// SOL-headroom floor — both the sniper executor and the discretionary
// agent-wallet trade endpoint import this rather than redefining it.
export const SOL_FEE_HEADROOM_LAMPORTS = 3_000_000n; // ~0.003 SOL

// Rent-exempt minimum of the SPL token account a buy opens. Not optional and not
// recoverable until the position closes, so any floor that ignores it is wrong.
export const ATA_RENT_LAMPORTS = 2_039_280n;

// What an entry costs BESIDES the buy itself: fee headroom + the token ATA's rent
// + room for a priority fee and an MEV tip. A wallet holding only `size` cannot
// actually buy `size`.
export const ENTRY_HEADROOM_LAMPORTS = SOL_FEE_HEADROOM_LAMPORTS + ATA_RENT_LAMPORTS + 1_000_000n;

// The least SOL an agent wallet can hold and still complete ONE trade end to end:
// the entry overhead above, plus the firewall's round-trip probe reserve (it
// simulates a real buy AND sell from this wallet), plus a minimum entry. Below
// this a wallet looks funded and is operationally dead — every buy aborts at the
// safety simulation it cannot afford to run.
//
// This is the number every system that MOVES SOL OUT of a trading wallet must
// respect. It exists because two subsystems disagreed about it: the economy's
// idle-capital reclaim kept `per_trade × 2` (as little as 0.004 SOL) while the
// executor needed ~0.012 to place that same trade, so reclaim could strip an
// enabled arm to a balance that could never buy anything.
export const MIN_OPERATIONAL_WALLET_SOL = 0.012;

export const SPEND_LIMIT_DEFAULTS = Object.freeze({
	daily_usd: null,
	per_tx_usd: null,
	// Rolling-24h ceiling on what this agent may send to ONE counterparty (the
	// on-chain payee for a trade/x402/a2a payment, the recipient address for a
	// withdraw). The wallet-wide `daily_usd` cap bounds total damage; this one
	// bounds concentrated damage, which is the shape an autonomous agent actually
	// fails in: a peer that reprices upward every call, or a compromised endpoint
	// the agent keeps paying, drains the whole daily budget into one address while
	// every individual payment stays under `per_tx_usd`. Null means no per-payee
	// cap (unchanged behavior for wallets that never set one).
	per_counterparty_daily_usd: null,
	withdraw_allowlist: [],
	// Wallet freeze / kill switch. When true, every AUTONOMOUS outbound path
	// (trade, snipe, x402) is rejected immediately. The owner's own withdraw is
	// deliberately NOT blocked — a freeze must never trap the owner's funds; the
	// safe direction (sweeping out) stays open so a freeze can be used to lock down
	// a misbehaving agent while still evacuating its balance.
	frozen: false,
	// Least-privilege enforcement. When true, every AUTONOMOUS outbound path
	// (trade, snipe, x402) must present a valid, unexpired, unrevoked scoped
	// capability that covers the action — no covering capability ⇒ deny (fail
	// safe). When false (default), capabilities still STRICTLY NARROW any spend
	// that presents one, but an autonomous spend without a capability is governed
	// by the wallet-wide policy alone (preserves existing automated flows). See
	// api/_lib/wallet-capabilities.js. Owner withdraw is never a delegated
	// capability and is unaffected by this flag.
	require_capabilities: false,
});

// Per-agent discretionary-trade policy (lamports-denominated), stored at
// agent_identities.meta.trade_limits. Distinct from meta.spend_limits (the
// cross-path USD ceiling): these are the SOL-budget + circuit-breaker knobs that
// govern the agent's own buys, mirroring the sniper's per-strategy caps so the
// discretionary path is held to the same standard. All opt-in — a null cap means
// "no lamports ceiling" and the trade is still governed by the USD spend policy
// and the wallet balance.
//
//   per_trade_sol         max SOL spent on any single buy (null = uncapped)
//   daily_budget_sol      rolling-24h SOL buy budget across trade + snipe (null = uncapped)
//   max_price_impact_pct  circuit breaker — reject a buy/sell over this impact
//   max_slippage_bps      ceiling on the client-supplied slippage
//   max_concurrent        max open discretionary positions (null = unlimited)
//   kill_switch           when true, every discretionary trade is rejected
export const TRADE_LIMIT_DEFAULTS = Object.freeze({
	per_trade_sol: null,
	daily_budget_sol: null,
	max_price_impact_pct: 15,
	max_slippage_bps: 1000,
	max_concurrent: null,
	kill_switch: false,
});

/**
 * A spend-policy breach. Always a structured 4xx (never a 500) so the boundary
 * can surface the reason to the user verbatim. `.code` is machine-readable;
 * `.detail` carries the numbers behind the decision for the UI.
 */
export class SpendLimitError extends Error {
	constructor(code, message, detail = {}) {
		super(message);
		this.name = 'SpendLimitError';
		this.status = 403;
		this.code = code;
		this.detail = detail;
	}
}

/**
 * Validate a Solana destination address.
 * @returns {{ valid: boolean, reason?: string, base58?: string, pubkey?: PublicKey, onCurve?: boolean }}
 */
export function validateSolanaAddress(addr) {
	const s = typeof addr === 'string' ? addr.trim() : '';
	if (!s) return { valid: false, reason: 'empty' };
	if (!BASE58_RE.test(s)) return { valid: false, reason: 'not_base58' };
	let pubkey;
	try {
		pubkey = new PublicKey(s);
	} catch {
		return { valid: false, reason: 'not_pubkey' };
	}
	// Off-curve addresses are program-derived (PDAs) and usually cannot sign or
	// be swept again — sending custody funds there risks losing them. We surface
	// `onCurve` so the withdraw endpoint can refuse a PDA destination.
	let onCurve = false;
	try {
		onCurve = PublicKey.isOnCurve(pubkey.toBytes());
	} catch {
		onCurve = false;
	}
	return { valid: true, base58: pubkey.toBase58(), pubkey, onCurve };
}

function numOrNull(v) {
	if (v === null || v === undefined || v === '') return null;
	const n = Number(v);
	if (!Number.isFinite(n) || n < 0) return null;
	return n;
}

/** Coerce arbitrary input into a clean, bounded spend-limit object. */
export function normalizeSpendLimits(raw) {
	const r = raw && typeof raw === 'object' ? raw : {};
	const allow = (Array.isArray(r.withdraw_allowlist) ? r.withdraw_allowlist : [])
		.map((a) => (typeof a === 'string' ? a.trim() : ''))
		.map((a) => validateSolanaAddress(a))
		.filter((v) => v.valid)
		.map((v) => v.base58);
	// De-dupe while preserving order, cap the list so meta can't be bloated.
	const seen = new Set();
	const deduped = [];
	for (const a of allow) {
		if (!seen.has(a)) {
			seen.add(a);
			deduped.push(a);
		}
		if (deduped.length >= MAX_ALLOWLIST) break;
	}
	return {
		daily_usd: numOrNull(r.daily_usd),
		per_tx_usd: numOrNull(r.per_tx_usd),
		per_counterparty_daily_usd: numOrNull(r.per_counterparty_daily_usd),
		withdraw_allowlist: deduped,
		frozen: r.frozen === true,
		require_capabilities: r.require_capabilities === true,
		updated_at: typeof r.updated_at === 'string' ? r.updated_at : null,
	};
}

/** Read the effective spend limits off an agent's meta blob. */
export function getSpendLimits(meta) {
	return normalizeSpendLimits(meta?.spend_limits);
}

/**
 * Persist a spend-limit patch onto the agent (owner-only). Only the keys present
 * in `patch` are changed; the rest are preserved. Writes a custody audit event
 * and a platform audit-log row. Returns the new normalized limits.
 */
export async function setSpendLimits(agentId, userId, patch, { req = null } = {}) {
	const [row] = await sql`
		SELECT id, user_id, meta FROM agent_identities
		WHERE id = ${agentId} AND deleted_at IS NULL
	`;
	if (!row) throw Object.assign(new Error('agent not found'), { status: 404, code: 'not_found' });
	if (row.user_id !== userId) throw Object.assign(new Error('not your agent'), { status: 403, code: 'forbidden' });

	const prev = getSpendLimits(row.meta);
	const next = normalizeSpendLimits({
		daily_usd: 'daily_usd' in patch ? patch.daily_usd : prev.daily_usd,
		per_tx_usd: 'per_tx_usd' in patch ? patch.per_tx_usd : prev.per_tx_usd,
		per_counterparty_daily_usd:
			'per_counterparty_daily_usd' in patch
				? patch.per_counterparty_daily_usd
				: prev.per_counterparty_daily_usd,
		withdraw_allowlist:
			'withdraw_allowlist' in patch ? patch.withdraw_allowlist : prev.withdraw_allowlist,
		frozen: 'frozen' in patch ? patch.frozen === true : prev.frozen,
		require_capabilities:
			'require_capabilities' in patch ? patch.require_capabilities === true : prev.require_capabilities,
	});
	next.updated_at = new Date().toISOString();

	const meta = { ...(row.meta || {}), spend_limits: next };
	await sql`UPDATE agent_identities SET meta = ${JSON.stringify(meta)}::jsonb WHERE id = ${agentId}`;

	await recordCustodyEvent({
		agentId,
		userId,
		eventType: 'limit_change',
		reason: 'spend_limits_updated',
		meta: { prev, next },
	}).catch((e) => console.warn('[custody] limit_change record failed', e?.message));
	logAudit({ userId, action: 'custody.limit_change', resourceId: agentId, meta: { prev, next }, req });

	return next;
}

/** USD value of a lamports amount at the live SOL/USD price. Throws on price outage. */
export async function lamportsToUsd(lamports) {
	const price = await solUsdPrice();
	return (Number(lamports) / 1e9) * price;
}

// ── discretionary trade limits ────────────────────────────────────────────────

function clampNum(v, def, { min = 0, max = Infinity, round = false } = {}) {
	const n = Number(v);
	if (!Number.isFinite(n) || n < min) return def;
	const c = Math.min(max, n);
	return round ? Math.round(c) : c;
}

/** Coerce arbitrary input into a clean, bounded trade-limit object. */
export function normalizeTradeLimits(raw) {
	const r = raw && typeof raw === 'object' ? raw : {};
	return {
		per_trade_sol: numOrNull(r.per_trade_sol),
		daily_budget_sol: numOrNull(r.daily_budget_sol),
		max_price_impact_pct: clampNum(r.max_price_impact_pct, TRADE_LIMIT_DEFAULTS.max_price_impact_pct, { max: 100 }),
		max_slippage_bps: clampNum(r.max_slippage_bps, TRADE_LIMIT_DEFAULTS.max_slippage_bps, { max: 10000, round: true }),
		max_concurrent: r.max_concurrent == null ? null : clampNum(r.max_concurrent, null, { min: 1, max: 10000, round: true }),
		kill_switch: r.kill_switch === true,
		updated_at: typeof r.updated_at === 'string' ? r.updated_at : null,
	};
}

/** Read the effective discretionary trade limits off an agent's meta blob. */
export function getTradeLimits(meta) {
	return normalizeTradeLimits(meta?.trade_limits);
}

/**
 * Persist a trade-limit patch onto the agent (owner-only). Only the keys present
 * in `patch` change; the rest are preserved. Writes a custody audit event and a
 * platform audit-log row. Returns the new normalized limits.
 */
export async function setTradeLimits(agentId, userId, patch, { req = null } = {}) {
	const [row] = await sql`
		SELECT id, user_id, meta FROM agent_identities
		WHERE id = ${agentId} AND deleted_at IS NULL
	`;
	if (!row) throw Object.assign(new Error('agent not found'), { status: 404, code: 'not_found' });
	if (row.user_id !== userId) throw Object.assign(new Error('not your agent'), { status: 403, code: 'forbidden' });

	const prev = getTradeLimits(row.meta);
	const p = patch && typeof patch === 'object' ? patch : {};
	const next = normalizeTradeLimits({
		per_trade_sol: 'per_trade_sol' in p ? p.per_trade_sol : prev.per_trade_sol,
		daily_budget_sol: 'daily_budget_sol' in p ? p.daily_budget_sol : prev.daily_budget_sol,
		max_price_impact_pct: 'max_price_impact_pct' in p ? p.max_price_impact_pct : prev.max_price_impact_pct,
		max_slippage_bps: 'max_slippage_bps' in p ? p.max_slippage_bps : prev.max_slippage_bps,
		max_concurrent: 'max_concurrent' in p ? p.max_concurrent : prev.max_concurrent,
		kill_switch: 'kill_switch' in p ? p.kill_switch : prev.kill_switch,
	});
	next.updated_at = new Date().toISOString();

	const meta = { ...(row.meta || {}), trade_limits: next };
	await sql`UPDATE agent_identities SET meta = ${JSON.stringify(meta)}::jsonb WHERE id = ${agentId}`;

	await recordCustodyEvent({
		agentId,
		userId,
		eventType: 'limit_change',
		reason: 'trade_limits_updated',
		meta: { prev, next },
	}).catch((e) => console.warn('[custody] trade limit_change record failed', e?.message));
	logAudit({ userId, action: 'custody.trade_limit_change', resourceId: agentId, meta: { prev, next }, req });

	return next;
}

// ── trade guard predicates ────────────────────────────────────────────────────
// Each returns null when the trade is allowed, or a structured
// { reason, detail } when blocked. These are the single source of truth for the
// "is this trade allowed" comparisons — the sniper executor and the discretionary
// agent-wallet trade endpoint both call them instead of inlining the math, so a
// cap or breaker can never drift between the two paths. Pure + synchronous: the
// caller fetches the live numbers (open count, daily spend, wallet balance,
// quote) and hands them in.

/** Discretionary trading paused for this agent. */
export function checkKillSwitch(killed) {
	return killed ? { reason: 'kill_switch', detail: {} } : null;
}

/** Open-position concurrency ceiling. Blocked when openCount >= maxConcurrent. */
export function checkConcurrency(openCount, maxConcurrent) {
	if (maxConcurrent == null) return null;
	if (Number(openCount) >= Number(maxConcurrent)) {
		return { reason: 'max_positions', detail: { open: Number(openCount), max: Number(maxConcurrent) } };
	}
	return null;
}

/** Per-trade spend cap (lamports). Blocked when amount > cap. */
export function checkPerTradeCap(amountLamports, capLamports) {
	if (capLamports == null) return null;
	const amt = BigInt(amountLamports);
	const cap = BigInt(capLamports);
	if (amt > cap) {
		return { reason: 'per_trade_cap', detail: { amount_lamports: amt.toString(), cap_lamports: cap.toString() } };
	}
	return null;
}

/** Rolling daily budget (lamports). Blocked when spent + amount > budget. */
export function checkDailyBudgetLamports(spentLamports, amountLamports, budgetLamports) {
	if (budgetLamports == null) return null;
	const spent = BigInt(spentLamports);
	const amt = BigInt(amountLamports);
	const budget = BigInt(budgetLamports);
	if (spent + amt > budget) {
		return {
			reason: 'daily_budget',
			detail: { spent_lamports: spent.toString(), amount_lamports: amt.toString(), budget_lamports: budget.toString() },
		};
	}
	return null;
}

/**
 * Realized-loss circuit breaker. Blocked when an agent's NET realized P&L over
 * the trailing window is a loss deeper than `lossLimitLamports`.
 *
 * This is the portfolio-layer guard the per-trade caps (budget, headroom, price
 * impact) don't provide: a fleet armed with a valid band can still bleed out one
 * losing entry at a time. Once the day's realized loss crosses the limit the
 * agent stops opening new positions — and, critically, the auto-funder stops
 * refilling it (see workers/agent-sniper/auto-funder.js), so the master wallet
 * can't keep pouring SOL after a wallet that only loses. The exact shape of the
 * rug-buy + auto-refill incident.
 *
 * `netRealizedLamports` is SIGNED: negative = net loss, positive = net profit.
 * A profitable or break-even day never blocks. `null`/`0` limit disables it.
 *
 * @param {bigint|string|number} netRealizedLamports  signed net realized P&L
 * @param {bigint|string|number|null} lossLimitLamports  max tolerated loss (positive magnitude)
 * @returns {{ reason: string, detail: object }|null}
 */
export function checkDailyLoss(netRealizedLamports, lossLimitLamports) {
	if (lossLimitLamports == null) return null;
	const limit = BigInt(lossLimitLamports);
	if (limit <= 0n) return null;
	const net = BigInt(netRealizedLamports);
	const loss = net < 0n ? -net : 0n;
	if (loss >= limit) {
		return {
			reason: 'daily_loss_limit',
			detail: { loss_lamports: loss.toString(), limit_lamports: limit.toString() },
		};
	}
	return null;
}

/** Wallet must cover the spend plus a fee/rent headroom. Blocked when short. */
export function checkSolHeadroom(walletLamports, spendLamports, headroomLamports = SOL_FEE_HEADROOM_LAMPORTS) {
	const wallet = BigInt(walletLamports);
	const spend = BigInt(spendLamports);
	const head = BigInt(headroomLamports);
	if (wallet < spend + head) {
		return {
			reason: 'insufficient_sol',
			detail: { wallet_lamports: wallet.toString(), required_lamports: (spend + head).toString() },
		};
	}
	return null;
}

/**
 * Resolve the entry size a wallet can actually trade, or decide it must sit out.
 *
 * Pure. Two floors apply and they are NOT the same number:
 *   - `ENTRY_HEADROOM_LAMPORTS` covers the buy's own network fee + the token
 *     ATA's rent + priority-fee/tip room. It is what the buy itself costs.
 *   - `MIN_OPERATIONAL_WALLET_SOL` additionally covers the checks that run from
 *     this wallet BEFORE any broadcast: the firewall's buy→sell round-trip probe
 *     and the pre-broadcast compute-unit simulation.
 *
 * A balance above the first floor and below the second looks tradeable and is
 * operationally dead: every attempt aborts at a simulation the wallet cannot
 * afford to run, so an arm gated only on the first floor re-attempts every
 * candidate forever and books a failure each time. Honest behavior is to sit out
 * until the auto-funder tops the wallet back up.
 *
 * Returns `{ sizeLamports }` to trade (possibly shrunk below `wantLamports`), or
 * `{ skip: reason }` to sit this candidate out.
 *
 * @param {bigint|number|string} walletLamports current wallet balance
 * @param {bigint|number|string} wantLamports the strategy's configured size
 * @param {bigint|number|string} minTradeLamports smallest size worth placing
 * @returns {{sizeLamports: bigint, skip?: undefined}|{skip: string, sizeLamports?: undefined}}
 */
export function resolveEntrySize(walletLamports, wantLamports, minTradeLamports) {
	const wallet = BigInt(walletLamports);
	const want = BigInt(wantLamports);
	const minTrade = BigInt(minTradeLamports);
	const headroom = checkSolHeadroom(wallet, want, ENTRY_HEADROOM_LAMPORTS);
	if (!headroom) return { sizeLamports: want };
	// Short for the configured size. Shrinking is allowed (learning > profit), but
	// only from a wallet that can still run the pre-broadcast simulations.
	if (wallet < BigInt(Math.round(MIN_OPERATIONAL_WALLET_SOL * 1e9))) {
		return { skip: headroom.reason };
	}
	const dustCapable = wallet - ENTRY_HEADROOM_LAMPORTS;
	if (dustCapable < minTrade) return { skip: headroom.reason };
	return { sizeLamports: dustCapable };
}

/** Price-impact circuit breaker. Blocked when impact > max. */
export function checkPriceImpact(priceImpactPct, maxPct) {
	if (maxPct == null) return null;
	if (Number(priceImpactPct) > Number(maxPct)) {
		return { reason: 'price_impact', detail: { impact_pct: Number(priceImpactPct), max_pct: Number(maxPct) } };
	}
	return null;
}

/** Lamports spent (buys) by an agent over the trailing window — the trade +
 *  snipe SOL outflow that backs the discretionary daily budget. One wallet, one
 *  budget: a buy from the sniper and a buy from the trade endpoint both count. */
export async function getDailySpendLamports(agentId, network = 'mainnet', windowHours = 24) {
	const [row] = await sql`
		SELECT COALESCE(SUM(amount_lamports), 0)::text AS lamports
		FROM agent_custody_events
		WHERE agent_id = ${agentId}
		  AND network = ${network}
		  AND event_type = 'spend'
		  AND status IN ('ok', 'pending', 'confirmed')
		  AND amount_lamports IS NOT NULL
		  AND created_at > now() - (${windowHours} || ' hours')::interval
	`;
	return BigInt(row?.lamports ?? '0');
}

const LAMPORTS_PER_SOL = 1_000_000_000n;

function lamportsToSolStr(lamports, dp = 4) {
	const n = Number(BigInt(lamports)) / 1e9;
	return n.toFixed(dp).replace(/\.?0+$/, '') || '0';
}

// Map a guard-predicate reason → an HTTP status + a plain-language, actionable
// message for the boundary. A guard rejection is always a 4xx with the reason and
// the numbers behind it — never a 500, never an exception that escapes.
const GUARD_RESPONSE = {
	kill_switch: {
		status: 403,
		message: () => 'Trading is paused for this agent. Re-enable discretionary trading under Limits & Safety to continue.',
	},
	per_trade_cap: {
		status: 422,
		message: (d) => `This trade of ${lamportsToSolStr(d.amount_lamports)} SOL is over the per-trade cap of ${lamportsToSolStr(d.cap_lamports)} SOL. Lower the amount or raise the cap under Limits & Safety.`,
	},
	daily_budget: {
		status: 422,
		message: (d) => `This trade would bring today's spend to ${lamportsToSolStr(BigInt(d.spent_lamports) + BigInt(d.amount_lamports))} SOL, over the daily budget of ${lamportsToSolStr(d.budget_lamports)} SOL. Wait for the window to roll over or raise the budget.`,
	},
	max_positions: {
		status: 409,
		message: (d) => `This agent already holds ${d.open} open ${d.open === 1 ? 'trade' : 'trades'} (max ${d.max}). Close one before opening another.`,
	},
	insufficient_sol: {
		status: 400,
		message: (d) => `The agent wallet needs about ${lamportsToSolStr(d.required_lamports)} SOL (including network fees) but holds ${lamportsToSolStr(d.wallet_lamports)}. Fund the wallet and retry.`,
	},
	price_impact: {
		status: 422,
		message: (d) => `Price impact is ${Number(d.impact_pct).toFixed(2)}% — above the ${Number(d.max_pct).toFixed(2)}% safety breaker. Lower the trade size or raise the impact limit under Limits & Safety.`,
	},
};

/**
 * Turn a guard-predicate result into a boundary-ready 4xx response shape.
 * @param {{ reason: string, detail?: object }} blocked
 * @returns {{ status: number, code: string, message: string, detail: object }}
 */
export function tradeGuardResponse(blocked) {
	const entry = GUARD_RESPONSE[blocked.reason] || { status: 422, message: () => `Trade rejected: ${blocked.reason}` };
	return {
		status: entry.status,
		code: blocked.reason,
		message: entry.message(blocked.detail || {}),
		detail: blocked.detail || {},
	};
}

export { LAMPORTS_PER_SOL };
// Re-export the policy-rules reader so routes can treat agent-trade-guards as the
// single barrel for spend/policy helpers (solana-wallet.js imports it from here).
export { getPolicyRules };

/**
 * Sum the USD-equivalent of an agent's outbound spends over the trailing window.
 * Only priced rows (usd not null) count — see module header on unpriced SPL.
 */
export async function getDailySpendUsd(agentId, network = 'mainnet', windowHours = 24) {
	const [row] = await sql`
		SELECT COALESCE(SUM(usd), 0)::float8 AS usd
		FROM agent_custody_events
		WHERE agent_id = ${agentId}
		  AND network = ${network}
		  AND event_type = 'spend'
		  AND status IN ('ok', 'pending', 'confirmed')
		  AND usd IS NOT NULL
		  AND created_at > now() - (${windowHours} || ' hours')::interval
	`;
	return Number(row?.usd || 0);
}

/**
 * USD this agent has already sent to ONE counterparty over the trailing window.
 * Backs the `per_counterparty_daily_usd` ceiling. `destination` is whatever the
 * spending path recorded as the recipient: the on-chain payee for an x402 / a2a
 * payment, the withdraw recipient for a sweep. A null/empty destination has no
 * counterparty to meter, so it reports 0 and the cap cannot block it.
 */
export async function getCounterpartySpendUsd(
	agentId,
	destination,
	network = 'mainnet',
	windowHours = 24,
) {
	if (!destination) return 0;
	const [row] = await sql`
		SELECT COALESCE(SUM(usd), 0)::float8 AS usd
		FROM agent_custody_events
		WHERE agent_id = ${agentId}
		  AND network = ${network}
		  AND event_type = 'spend'
		  AND destination = ${destination}
		  AND status IN ('ok', 'pending', 'confirmed')
		  AND usd IS NOT NULL
		  AND created_at > now() - (${windowHours} || ' hours')::interval
	`;
	return Number(row?.usd || 0);
}

// ── natural-language policy enforcement ───────────────────────────────────────
// The owner-authored, code-enforced policy (meta.policy_rules) layered on top of
// the numeric caps. A block here returns the HUMAN rule that caught the spend.

/** Count how many times this agent has previously paid a given destination. Backs
 *  the `counterparty_seen_before` signal ("only pay services you've used before").
 *  Best-effort: any error reports "not seen", and the rule itself decides what that
 *  means (a `is false` rule then fires — fail-safe-to-block for that intent). */
async function countPriorSpendsTo(agentId, destination, network = 'mainnet') {
	if (!destination) return 0;
	const [row] = await sql`
		SELECT COUNT(*)::int AS n
		FROM agent_custody_events
		WHERE agent_id = ${agentId}
		  AND network = ${network}
		  AND event_type = 'spend'
		  AND destination = ${destination}
		  AND status IN ('ok', 'pending', 'confirmed')
	`;
	return Number(row?.n || 0);
}


/** Trip the wallet freeze switch from a `freeze` policy rule. Idempotent, audited,
 *  and never throws — a logging/DB hiccup must not turn the (correct) block into a
 *  pass. Owner withdraw stays open exactly as a manual freeze. */
async function freezeWalletFromPolicy(agentId, userId, rule, network) {
	try {
		await sql`
			UPDATE agent_identities
			SET meta = jsonb_set(
				jsonb_set(coalesce(meta, '{}'::jsonb), '{spend_limits}', coalesce(meta->'spend_limits', '{}'::jsonb)),
				'{spend_limits,frozen}', 'true'::jsonb
			)
			WHERE id = ${agentId} AND coalesce((meta->'spend_limits'->>'frozen')::boolean, false) = false
		`;
		await recordCustodyEvent({
			agentId, userId: userId ?? null, eventType: 'limit_change', network,
			reason: 'policy_freeze',
			meta: { trigger: 'policy_rule', rule_id: rule?.id || null, rule: rule?.label || null },
		});
		logAudit({ userId: userId ?? null, action: 'custody.policy_freeze', resourceId: agentId, meta: { rule_id: rule?.id || null } });
	} catch (e) {
		console.warn('[policy] auto-freeze failed', e?.message);
	}
}

/**
 * Evaluate the natural-language policy for one outbound spend and throw the human
 * rule that catches it. Total: any internal failure on an AUTONOMOUS path fails
 * safe to a block; the owner's own withdraw is never trapped by an internal error.
 *
 * @param {object} o
 * @param {string} o.agentId
 * @param {object} o.policy            normalized policy document
 * @param {string} o.category
 * @param {number|null} o.usdValue
 * @param {string} [o.asset]
 * @param {string} [o.destination]
 * @param {object} [o.limits]          resolved numeric limits (for destination_allowlisted)
 * @param {object} [o.policyContext]   extra live signals: token_age_hours, trade_pnl_pct, sol_reserve_after
 * @param {number} [o.userId]
 * @param {string} [o.network]
 * @throws {SpendLimitError} when the policy denies the spend
 */
async function enforcePolicyRules({ agentId, policy, category, usdValue, asset, destination, limits, policyContext = {}, userId, network = 'mainnet' }) {
	if (!policy || !Array.isArray(policy.rules) || !policy.rules.length) return;
	const autonomous = category !== 'withdraw';

	let ctx;
	try {
		const refs = referencedFields(policy);
		const hasUsd = typeof usdValue === 'number' && Number.isFinite(usdValue) && usdValue >= 0;
		const dest = typeof destination === 'string' ? destination.trim() : '';
		const allow = Array.isArray(limits?.withdraw_allowlist) ? limits.withdraw_allowlist : [];

		ctx = {
			category,
			asset: asset || undefined,
			counterparty: dest || undefined,
			amount_usd: hasUsd ? usdValue : undefined,
			time_of_day_utc: new Date().getUTCHours(),
			destination_allowlisted: dest ? allow.includes(dest) : undefined,
			// Live signals the trade/snipe paths can supply (token age, P&L, reserve).
			...sanitizePolicyContext(policyContext),
		};

		// Async signals — only fetched when a live rule references them.
		if ((refs.has('daily_spent_usd') || refs.has('daily_total_usd')) && hasUsd) {
			const spent = await getDailySpendUsd(agentId, network);
			ctx.daily_spent_usd = spent;
			ctx.daily_total_usd = spent + usdValue;
		}
		if (refs.has('counterparty_seen_before') && dest) {
			ctx.counterparty_seen_before = (await countPriorSpendsTo(agentId, dest, network)) > 0;
		}
	} catch (e) {
		// Building the context failed (DB outage, etc.). Fail safe: block an
		// autonomous spend; never trap the owner's withdraw.
		console.warn('[policy] context build failed', e?.message);
		if (!autonomous) return;
		throw new SpendLimitError('policy_unavailable', 'Couldn’t verify this spend against your safety rules right now. The spend was blocked to stay safe — try again in a moment.', { category });
	}

	const verdict = evaluatePolicy(policy, ctx);
	if (!isDenied(verdict.decision)) return;

	// Audit: every block records which rule fired (deliverable). A 'failed' spend
	// row is excluded from the daily-cap sum and the backtest history, so it never
	// inflates totals — it exists purely so the owner can see, on the live feed,
	// exactly which payment was stopped and by which rule. Fire-and-forget.
	recordCustodyEvent({
		agentId, userId: userId ?? null, eventType: 'spend', category, network,
		asset: asset || null, usd: (typeof usdValue === 'number' && Number.isFinite(usdValue)) ? usdValue : null,
		destination: destination || null, status: 'failed', reason: `policy_${verdict.decision}`,
		meta: { policy_block: true, rule_id: verdict.matched?.id || null, rule: verdict.message, rule_index: verdict.ruleIndex, decision: verdict.decision },
	}).catch((e) => console.warn('[policy] block-record failed', e?.message));

	// A `freeze` rule also trips the wallet kill-switch so everything else stops.
	if (verdict.decision === 'freeze') {
		await freezeWalletFromPolicy(agentId, userId, verdict.matched, network);
		throw new SpendLimitError(
			'policy_freeze',
			`Wallet frozen by your rule: ${verdict.message} All autonomous spending is now paused; unfreeze it under Limits & Safety.`,
			{ rule_id: verdict.matched?.id || null, rule: verdict.message, rule_index: verdict.ruleIndex, decision: 'freeze' },
		);
	}

	const code = verdict.decision === 'step_up' ? 'policy_step_up' : 'policy_blocked';
	const prefix = verdict.decision === 'step_up' ? 'This spend needs your approval' : 'Blocked by your rule';
	throw new SpendLimitError(
		code,
		`${prefix}: ${verdict.message}`,
		{ rule_id: verdict.matched?.id || null, rule: verdict.message, rule_index: verdict.ruleIndex, decision: verdict.decision },
	);
}

/** Keep only the numeric live signals the evaluator understands, coerced + finite. */
function sanitizePolicyContext(extra) {
	const out = {};
	if (!extra || typeof extra !== 'object') return out;
	for (const k of ['token_age_hours', 'trade_pnl_pct', 'sol_reserve_after']) {
		const n = Number(extra[k]);
		if (extra[k] != null && Number.isFinite(n)) out[k] = n;
	}
	return out;
}

/**
 * Persist a natural-language policy onto the agent (owner-only). The caller passes
 * the validated rule array (from the compiler) plus the original English. The
 * document is re-normalized here so the stored policy is always enforceable, a
 * `limit_change` custody event records the English + a diff vs the prior policy, and
 * a platform audit row is written. Returns the new normalized document.
 */
export async function setPolicyRules(agentId, userId, rules, { english = null, req = null } = {}) {
	const [row] = await sql`
		SELECT id, user_id, meta FROM agent_identities
		WHERE id = ${agentId} AND deleted_at IS NULL
	`;
	if (!row) throw Object.assign(new Error('agent not found'), { status: 404, code: 'not_found' });
	if (row.user_id !== userId) throw Object.assign(new Error('not your agent'), { status: 403, code: 'forbidden' });

	const prev = getPolicyRules(row.meta);
	const next = normalizePolicyRules({ rules, source_text: typeof english === 'string' ? english : prev.source_text });
	next.updated_at = new Date().toISOString();
	const diff = diffPolicies(prev, next);

	const meta = { ...(row.meta || {}), policy_rules: next };
	await sql`UPDATE agent_identities SET meta = ${JSON.stringify(meta)}::jsonb WHERE id = ${agentId}`;

	await recordCustodyEvent({
		agentId,
		userId,
		eventType: 'limit_change',
		reason: 'policy_updated',
		meta: { english: next.source_text, prev_rules: prev.rules, next_rules: next.rules, readback: describePolicyRules(next), diff },
	}).catch((e) => console.warn('[custody] policy limit_change record failed', e?.message));
	logAudit({ userId, action: 'custody.policy_change', resourceId: agentId, meta: { diff, rule_count: next.rules.length }, req });

	return next;
}

/**
 * Enforce the per-agent spend policy for one outbound movement.
 *
 * @param {object} o
 * @param {string} o.agentId
 * @param {object} [o.meta]            agent meta (limits + policy read from here if absent)
 * @param {object} [o.limits]          pre-resolved limits (skips the meta read)
 * @param {object} [o.policyRules]     pre-resolved NL policy document (skips the meta/DB read)
 * @param {'trade'|'snipe'|'x402'|'withdraw'} o.category
 * @param {number|null} o.usdValue     USD-equivalent of this tx (null = unpriceable)
 * @param {string} [o.asset]           'SOL' | 'USDC' | mint — for asset-scoped policy rules
 * @param {string} [o.destination]     base58 recipient (required for allowlist on withdraw)
 * @param {object} [o.policyContext]   live signals for policy rules (token_age_hours, trade_pnl_pct, sol_reserve_after)
 * @param {number} [o.userId]          actor (for policy-freeze audit)
 * @param {string} [o.network]
 * @returns {Promise<{ ok: true, limits: object, dailySpentUsd: number|null }>}
 * @throws {SpendLimitError} on any breach (always 4xx)
 */
// ── capability gate (scoped session keys) ──────────────────────────────────
// Resolve + scope-check the capability that authorizes an autonomous spend, if any.
// Composed additively into both shared guards. A capability STRICTLY NARROWS: the
// wallet-wide checks must pass AND this gate must pass. Autonomous categories only
// (trade/snipe/x402); an owner-initiated withdraw is never a delegated capability.
//
// A caller may pass a pre-resolved `capability`, or a `capabilityHolderRef`
// (skill/strategy/integration id) we resolve to the tightest live grant. When the
// wallet has require_capabilities on and no covering grant exists, the spend is
// DENIED (fail safe). Returns the resolved capability, or null when none applies
// and none is required (unchanged behavior for wallets not using capabilities).
async function resolveSpendCapability({ agentId, lim, category, usdValue, target, capability, capabilityHolderRef, ownerInitiated, now }) {
	if (category === 'withdraw') return null;
	// Owner-present actions (e.g. the hub's discretionary Trade tab) are not delegated
	// capabilities — the owner is the authority, exactly like withdraw. We still honor
	// an explicitly-presented capability, but never auto-resolve or require one here.
	if (ownerInitiated) {
		if (!capability) return null;
		const s = evaluateCapabilityScope({ cap: capability, action: category, target, usdValue, now });
		if (s) throw capabilityError(s.reason, s.detail);
		return capability;
	}
	let cap = capability || null;
	if (!cap && (lim.require_capabilities || capabilityHolderRef)) {
		cap = await resolveCapabilityForSpend({ agentId, action: category, holderRef: capabilityHolderRef ?? null, target, usdValue, now });
	}
	if (!cap) {
		if (lim.require_capabilities) throw capabilityError('capability_required', { category });
		return null;
	}
	const scope = evaluateCapabilityScope({ cap, action: category, target, usdValue, now });
	if (scope) throw capabilityError(scope.reason, scope.detail);
	return cap;
}

export async function enforceSpendLimit({
	agentId,
	meta,
	limits,
	policyRules,
	category,
	usdValue,
	asset,
	destination,
	policyContext,
	userId,
	capability,
	capabilityHolderRef,
	target,
	ownerInitiated,
	now,
	network = 'mainnet',
}) {
	const lim = limits || getSpendLimits(meta);

	// 0. Wallet freeze — blocks every autonomous path; owner withdraw stays open.
	if (lim.frozen && category !== 'withdraw') {
		throw new SpendLimitError(
			'wallet_frozen',
			'This wallet is frozen. Autonomous spending (trades, snipes, payments) is paused. Unfreeze it under Limits & Safety to resume.',
			{ category },
		);
	}

	// 1. Withdraw allowlist — destination gate.
	if (category === 'withdraw' && lim.withdraw_allowlist.length > 0) {
		const dest = typeof destination === 'string' ? destination.trim() : '';
		if (!dest || !lim.withdraw_allowlist.includes(dest)) {
			throw new SpendLimitError(
				'destination_not_allowed',
				'That destination is not on this agent’s withdraw allowlist. Add it under Limits & Safety, or send to an allowed address.',
				{ destination: dest || null, allowlist_size: lim.withdraw_allowlist.length },
			);
		}
	}

	// 2. Natural-language policy — the owner's English rules, deterministically
	// enforced. Resolved from the explicit `policyRules` arg or the `meta` blob —
	// both are free (no extra query). A caller that passes only pre-resolved `limits`
	// must pass `policyRules` to opt the path in; the autonomous trade/snipe/x402/
	// withdraw paths all do (or pass `meta`).
	const policy = policyRules || (meta ? getPolicyRules(meta) : null);
	await enforcePolicyRules({ agentId, policy, category, usdValue, asset, destination, limits: lim, policyContext, userId, network });

	const hasUsd = typeof usdValue === 'number' && Number.isFinite(usdValue) && usdValue >= 0;

	// 3. Per-transaction ceiling.
	if (lim.per_tx_usd != null && hasUsd && usdValue > lim.per_tx_usd + 1e-9) {
		throw new SpendLimitError(
			'per_tx_exceeded',
			`This ${category} is $${usdValue.toFixed(2)}, over the per-transaction limit of $${lim.per_tx_usd.toFixed(2)}.`,
			{ usd: usdValue, per_tx_usd: lim.per_tx_usd },
		);
	}

	// 4. Rolling daily ceiling.
	let dailySpentUsd = null;
	if (lim.daily_usd != null && hasUsd) {
		dailySpentUsd = await getDailySpendUsd(agentId, network);
		if (dailySpentUsd + usdValue > lim.daily_usd + 1e-9) {
			throw new SpendLimitError(
				'daily_exceeded',
				`This ${category} would bring today’s spend to $${(dailySpentUsd + usdValue).toFixed(2)}, over the daily limit of $${lim.daily_usd.toFixed(2)}.`,
				{ usd: usdValue, spent_usd: dailySpentUsd, daily_usd: lim.daily_usd },
			);
		}
	}

	// 4c. Per-counterparty rolling ceiling. Bounds concentration, not just total:
	// a wallet-wide daily cap still permits the entire day's budget to flow into
	// one payee.
	if (lim.per_counterparty_daily_usd != null && hasUsd && destination) {
		const cpSpent = await getCounterpartySpendUsd(agentId, destination, network);
		if (cpSpent + usdValue > lim.per_counterparty_daily_usd + 1e-9) {
			throw new SpendLimitError(
				'counterparty_daily_exceeded',
				`This ${category} would bring today’s spend to this counterparty to $${(cpSpent + usdValue).toFixed(2)}, over the per-counterparty limit of $${lim.per_counterparty_daily_usd.toFixed(2)}.`,
				{
					usd: usdValue,
					destination,
					counterparty_spent_usd: cpSpent,
					per_counterparty_daily_usd: lim.per_counterparty_daily_usd,
				},
			);
		}
	}

	// 5. Behavioral anomaly guard (the wallet's immune system). Scores this action
	// against the agent's learned normal; on a freeze verdict it has already frozen
	// the wallet + notified the owner, and we surface a SpendLimitError so the
	// triggering action is held. Self-contained fail-safe — never fails open here.
	const anomaly = await guardOutboundAnomaly({
		agentId, userId, meta, category, usdValue, destination, asset, network,
	});
	if (anomaly.decision === 'freeze') {
		throw new SpendLimitError('wallet_anomaly_frozen', anomaly.message, anomaly.detail || {});
	}

	// 4b. Capability gate (least-privilege). Scope (action/target/expiry/revoked/
	// per-use) + a non-atomic aggregate read-check, mirroring how this enforce path
	// already treats the daily cap non-atomically. The atomic aggregate reserve lives
	// in reserveSpendUsd → reserveCapabilitySpend.
	const _cap = await resolveSpendCapability({ agentId, lim, category, usdValue, target, capability, capabilityHolderRef, ownerInitiated, now });
	const capabilityId = _cap?.id || null;
	if (_cap && _cap.aggregate_usd != null && hasUsd) {
		const _spent = await capabilitySpentUsd(_cap.id);
		const _agg = checkAggregate(_spent, usdValue, _cap);
		if (_agg) throw capabilityError(_agg.reason, _agg.detail);
	}

	return { ok: true, limits: lim, dailySpentUsd, capabilityId, anomaly: anomaly.verdict || null };
}

/**
 * Atomically enforce the per-agent USD spend policy AND reserve a pending custody
 * row, under a per-agent advisory lock. This closes the TOCTOU that
 * `enforceSpendLimit` + a post-settle `recordSpend` leaves open: without the lock,
 * K concurrent calls all read the same pre-spend 24h total, all pass the daily
 * ceiling, and all settle — turning a $X/day cap into $X·K. Mirrors the proven
 * `reserveSpend` pattern in agent-spend-policy.js (which already protects the SOL
 * outflow path).
 *
 * Returns { ok: true, reservationId, dailySpentUsd } on success — finalize the
 * reservation with `updateCustodyEvent(reservationId, { status, signature })` after
 * settlement, or `releaseSpendReservation(reservationId)` if the spend never moved.
 * @throws {SpendLimitError} on per-tx breach, daily breach, or withdraw-allowlist miss.
 */
export async function reserveSpendUsd({
	agentId,
	userId,
	meta,
	limits,
	policyRules,
	category,
	usdValue,
	destination,
	policyContext,
	capability,
	capabilityHolderRef,
	target,
	ownerInitiated,
	now,
	network = 'mainnet',
	asset = 'USDC',
	rowMeta = {},
}) {
	const lim = limits || getSpendLimits(meta);

	// Wallet freeze — blocks every autonomous path; owner withdraw stays open.
	if (lim.frozen && category !== 'withdraw') {
		throw new SpendLimitError(
			'wallet_frozen',
			'This wallet is frozen. Autonomous spending (trades, snipes, payments) is paused. Unfreeze it under Limits & Safety to resume.',
			{ category },
		);
	}

	// Withdraw allowlist — destination gate (same as enforceSpendLimit).
	if (category === 'withdraw' && lim.withdraw_allowlist.length > 0) {
		const dest = typeof destination === 'string' ? destination.trim() : '';
		if (!dest || !lim.withdraw_allowlist.includes(dest)) {
			throw new SpendLimitError(
				'destination_not_allowed',
				'That destination is not on this agent’s withdraw allowlist. Add it under Limits & Safety, or send to an allowed address.',
				{ destination: dest || null, allowlist_size: lim.withdraw_allowlist.length },
			);
		}
	}

	// Natural-language policy — same deterministic evaluator as enforceSpendLimit,
	// run BEFORE the row is reserved so a policy block never claims daily headroom.
	const policy = policyRules || (meta ? getPolicyRules(meta) : null);
	await enforcePolicyRules({ agentId, policy, category, usdValue, asset, destination, limits: lim, policyContext, userId, network });

	const hasUsd = typeof usdValue === 'number' && Number.isFinite(usdValue) && usdValue >= 0;

	// Per-transaction ceiling (no lock needed — a single value vs a constant).
	if (lim.per_tx_usd != null && hasUsd && usdValue > lim.per_tx_usd + 1e-9) {
		throw new SpendLimitError(
			'per_tx_exceeded',
			`This ${category} is $${usdValue.toFixed(2)}, over the per-transaction limit of $${lim.per_tx_usd.toFixed(2)}.`,
			{ usd: usdValue, per_tx_usd: lim.per_tx_usd },
		);
	}

	// Capability gate (least-privilege). When a capability is in play (presented,
	// resolvable, or required for this wallet), delegate the reserve to
	// reserveCapabilitySpend: it atomically meters BOTH the capability aggregate
	// ceiling AND the wallet daily cap under advisory locks and tags the pending row
	// with capability_id. Return early so we never double-insert.
	if (category !== 'withdraw') {
		const _cap = await resolveSpendCapability({ agentId, lim, category, usdValue, target: target ?? destination, capability, capabilityHolderRef, ownerInitiated, now });
		if (_cap) {
			const _r = await reserveCapabilitySpend({
				capabilityId: _cap.id, agentId, userId, action: category,
				target: target ?? destination, usdValue, dailyUsd: lim.daily_usd,
				counterpartyDailyUsd: lim.per_counterparty_daily_usd,
				network, asset, destination, rowMeta, now,
			});
			return { ok: true, reservationId: _r.reservationId, dailySpentUsd: _r.spentBefore, capabilityId: _cap.id };
		}
	}

	const metaJson = JSON.stringify(rowMeta ?? {});

	// Behavioral anomaly guard for a just-reserved spend. The pending row already
	// exists (selfCounted: live velocity counts include it), so on a freeze verdict
	// we RELEASE the reservation — it must not hold daily headroom — before surfacing
	// the SpendLimitError. guardOutboundAnomaly has already frozen + notified.
	const runAnomaly = async (reservationId, dailySpentUsd) => {
		const anomaly = await guardOutboundAnomaly({
			agentId, userId, meta, category, usdValue, destination, asset, network,
			custodyEventId: reservationId, selfCounted: true,
		});
		if (anomaly.decision === 'freeze') {
			await releaseSpendReservation(reservationId, 'anomaly_frozen');
			throw new SpendLimitError('wallet_anomaly_frozen', anomaly.message, anomaly.detail || {});
		}
		return { ok: true, reservationId, dailySpentUsd, anomaly: anomaly.verdict || null };
	};

	// The per-counterparty ceiling only has something to meter when the spend names
	// a recipient. An unaddressed spend (no payee recorded) is governed by the
	// wallet-wide cap alone rather than silently passing a cap it cannot evaluate.
	const cpCap = destination ? lim.per_counterparty_daily_usd : null;
	const cpDestination = cpCap != null ? destination : null;

	// No metered ceiling, or an unpriceable spend: just reserve a pending row (it
	// can't gate a cap it has no number for) so the ledger still reflects it.
	if ((lim.daily_usd == null && cpCap == null) || !hasUsd) {
		const reservationId = await recordCustodyEvent({
			agentId, userId, eventType: 'spend', category, network, asset,
			usd: hasUsd ? usdValue : null, destination, status: 'pending', meta: rowMeta,
		});
		return runAnomaly(reservationId, null);
	}

	// Atomic cap reserve: the advisory xact lock serializes concurrent spends per
	// agent, and the INSERT…SELECT only materializes the pending row when BOTH the
	// rolling 24h wallet total and the rolling 24h total to this counterparty stay
	// within their ceilings — check + reserve are one statement, so two requests can
	// never both pass on the same stale total. A null ceiling drops out of the
	// predicate, so this one statement serves a wallet that sets either cap or both.
	const rows = await sql`
		WITH locked AS (
			SELECT pg_advisory_xact_lock(hashtextextended(${String(agentId)}, 0))
		),
		spent AS (
			SELECT COALESCE(SUM(usd), 0)::float8 AS s
			FROM agent_custody_events
			WHERE agent_id = ${agentId}
			  AND network = ${network}
			  AND event_type = 'spend'
			  AND status IN ('ok', 'pending', 'confirmed')
			  AND usd IS NOT NULL
			  AND created_at > now() - interval '24 hours'
		),
		cp AS (
			SELECT COALESCE(SUM(usd), 0)::float8 AS s
			FROM agent_custody_events
			WHERE agent_id = ${agentId}
			  AND network = ${network}
			  AND event_type = 'spend'
			  AND destination = ${cpDestination}
			  AND status IN ('ok', 'pending', 'confirmed')
			  AND usd IS NOT NULL
			  AND created_at > now() - interval '24 hours'
		)
		INSERT INTO agent_custody_events
			(agent_id, user_id, event_type, category, network, asset, usd, destination, status, meta)
		SELECT ${agentId}, ${userId ?? null}, 'spend', ${category}, ${network}, ${asset},
		       ${usdValue}, ${destination ?? null}, 'pending', ${metaJson}::jsonb
		FROM spent, cp, locked
		WHERE (${lim.daily_usd}::float8 IS NULL OR spent.s + ${usdValue}::float8 <= ${lim.daily_usd}::float8 + 1e-9)
		  AND (${cpCap}::float8 IS NULL OR cp.s + ${usdValue}::float8 <= ${cpCap}::float8 + 1e-9)
		RETURNING id, (SELECT s FROM spent) AS spent_before, (SELECT s FROM cp) AS cp_spent_before
	`;

	if (!rows.length) {
		// Re-read the totals for an accurate error message (outside the lock is fine)
		// and name the ceiling that actually rejected the spend — a caller told to
		// wait out a daily window it never hit would keep retrying forever.
		const cpSpentUsd = cpCap != null ? await getCounterpartySpendUsd(agentId, destination, network) : 0;
		if (cpCap != null && cpSpentUsd + usdValue > cpCap + 1e-9) {
			throw new SpendLimitError(
				'counterparty_daily_exceeded',
				`This ${category} would bring today’s spend to this counterparty to $${(cpSpentUsd + usdValue).toFixed(2)}, over the per-counterparty limit of $${cpCap.toFixed(2)}.`,
				{
					usd: usdValue,
					destination,
					counterparty_spent_usd: cpSpentUsd,
					per_counterparty_daily_usd: cpCap,
				},
			);
		}
		const dailySpentUsd = await getDailySpendUsd(agentId, network);
		throw new SpendLimitError(
			'daily_exceeded',
			`This ${category} would bring today’s spend to $${(dailySpentUsd + usdValue).toFixed(2)}, over the daily limit of $${Number(lim.daily_usd).toFixed(2)}.`,
			{ usd: usdValue, spent_usd: dailySpentUsd, daily_usd: lim.daily_usd },
		);
	}

	return runAnomaly(rows[0].id, Number(rows[0].spent_before || 0));
}

/**
 * Release a USD spend reservation that never resulted in a settled payment, so it
 * stops counting toward the daily cap. Marks the pending row 'failed' rather than
 * deleting it, preserving the audit trail.
 */
export async function releaseSpendReservation(reservationId, reason = 'spend_aborted') {
	if (!reservationId) return;
	await sql`
		UPDATE agent_custody_events
		SET status = 'failed', reason = ${reason}, updated_at = now()
		WHERE id = ${reservationId} AND status = 'pending'
	`;
}

const CUSTODY_COLUMNS = [
	'agent_id', 'user_id', 'event_type', 'category', 'network', 'asset',
	'amount_lamports', 'amount_raw', 'usd', 'destination', 'signature',
	'reason', 'status', 'idempotency_key', 'capability_id', 'meta',
];

/**
 * Write a row into the custody audit trail / spend ledger.
 * Returns the new row id. Callers in fire-and-forget contexts should `.catch()`.
 * `capabilityId` (optional) tags the row with the scoped session key that
 * authorized the spend, so the per-capability aggregate ceiling and the owner
 * Access UI read from the same ledger as the wallet daily cap.
 */
export async function recordCustodyEvent(e) {
	const [row] = await sql`
		INSERT INTO agent_custody_events
			(agent_id, user_id, event_type, category, network, asset,
			 amount_lamports, amount_raw, usd, destination, signature,
			 reason, status, idempotency_key, capability_id, meta)
		VALUES (
			${e.agentId},
			${e.userId ?? null},
			${e.eventType},
			${e.category ?? null},
			${e.network ?? 'mainnet'},
			${e.asset ?? null},
			${e.amountLamports != null ? String(e.amountLamports) : null},
			${e.amountRaw != null ? String(e.amountRaw) : null},
			${e.usd ?? null},
			${e.destination ?? null},
			${e.signature ?? null},
			${e.reason ?? null},
			${e.status ?? 'ok'},
			${e.idempotencyKey ?? null},
			${e.capabilityId ?? null},
			${JSON.stringify(e.meta ?? {})}::jsonb
		)
		RETURNING id
	`;
	return row?.id ?? null;
}

/** Update a custody row by id (e.g. flip a pending withdraw to confirmed/failed). */
export async function updateCustodyEvent(id, patch) {
	await sql`
		UPDATE agent_custody_events
		SET status = COALESCE(${patch.status ?? null}, status),
		    signature = COALESCE(${patch.signature ?? null}, signature),
		    usd = COALESCE(${patch.usd ?? null}, usd),
		    amount_lamports = COALESCE(${patch.amountLamports != null ? String(patch.amountLamports) : null}, amount_lamports),
		    meta = CASE WHEN ${patch.meta ? JSON.stringify(patch.meta) : null}::jsonb IS NULL
		                THEN meta ELSE meta || ${patch.meta ? JSON.stringify(patch.meta) : '{}'}::jsonb END,
		    updated_at = now()
		WHERE id = ${id}
	`;
}

/** Convenience wrapper for the common case: record one outbound 'spend'. */
export async function recordSpend(e) {
	return recordCustodyEvent({ ...e, eventType: 'spend' });
}

/**
 * Read the agent's recent custody events for the owner-facing audit feed.
 * Cursor is the `id` of the last row seen (descending, so strictly-less-than).
 */
export async function listCustodyEvents(
	agentId,
	{ limit = 50, beforeId = null, network = null, category = null } = {},
) {
	const lim = Math.min(200, Math.max(1, Number(limit) || 50));
	const rows = await sql`
		SELECT id, event_type, category, network, asset, amount_lamports, amount_raw,
		       usd, destination, signature, reason, status, created_at, meta
		FROM agent_custody_events
		WHERE agent_id = ${agentId}
		  AND (${network}::text IS NULL OR network = ${network})
		  AND (${category}::text IS NULL OR category = ${category})
		  AND (${beforeId}::bigint IS NULL OR id < ${beforeId})
		ORDER BY id DESC
		LIMIT ${lim}
	`;
	return rows;
}
