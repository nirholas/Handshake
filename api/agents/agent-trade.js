// POST /api/agents/:id/trade — discretionary, owner-authenticated pump.fun trade
// from the agent's OWN custodial wallet (server-signed).
//
// This is the discretionary sibling of the sniper: same instruction builders
// (PumpTradeClient buy/sell, AMM sell on graduation), same custodial key path
// (recoverSolanaAgentKeypair, audit-logged), and — critically — the SAME shared
// guardrail module (api/_lib/agent-trade-guards.js). The owner funds the agent
// wallet, then drives buys/sells through this endpoint; every trade is capped,
// budgeted, price-impact-broken, idempotent, and recorded into the custody
// ledger that backs the spend ceilings and the owner-facing audit feed.
//
// Routes (dispatched from api/agents/[id].js, sub === 'trade'):
//   POST /api/agents/:id/trade            execute a buy/sell
//   POST /api/agents/:id/trade/quote      preview: expected out, impact, fees, guards
//   GET  /api/agents/:id/trade/quote      same preview via query params
//   GET  /api/agents/:id/trade/limits     read the per-agent trade limits
//   PUT  /api/agents/:id/trade/limits     update the per-agent trade limits (owner)
//
// SNIPER_MODE=simulate or { simulate: true } runs the full real-quote path but
// skips the broadcast (paper mode) — an ops/test toggle, never the default.

import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { sql } from '../_lib/db.js';
import { cors, json, method, error, readJson, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { requireCsrf } from '../_lib/csrf.js';
import { ensureAgentWallet, recoverSolanaAgentKeypair } from '../_lib/agent-wallet.js';
import { getPumpTradeClient } from '../_lib/pump.js';
import { buildAmmSellInstructions, quoteAmmSell, buildAmmBuyInstructions, quoteAmmBuy } from '../../workers/agent-sniper/amm-exit.js';
import { logAudit } from '../_lib/audit.js';
import { explorerTxUrl } from '../_lib/avatar-wallet.js';
import { PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import {
	getAssociatedTokenAddressSync, getMint,
	TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { randomUUID } from 'node:crypto';
import {
	validateSolanaAddress, enforceSpendLimit, SpendLimitError, lamportsToUsd,
	getTradeLimits, setTradeLimits, getDailySpendLamports,
	updateCustodyEvent,
	checkKillSwitch, checkConcurrency, checkPerTradeCap, checkDailyBudgetLamports,
	checkSolHeadroom, checkPriceImpact, tradeGuardResponse,
	SOL_FEE_HEADROOM_LAMPORTS, TRADE_LIMIT_DEFAULTS,
} from '../_lib/agent-trade-guards.js';
import { assessTradeSafety, recordFirewallDecision, firewallGuardResponse } from '../_lib/trade-firewall.js';
import { submitProtected } from '../_lib/execution-engine.js';

const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const CONFIRM_TIMEOUT_MS = 45_000;

function normNetwork(n) {
	return n === 'devnet' ? 'devnet' : 'mainnet';
}

async function resolveAuth(req) {
	const session = await getSessionUser(req);
	if (session) return { userId: session.id };
	const bearer = await authenticateBearer(extractBearer(req));
	if (bearer) return { userId: bearer.userId };
	return null;
}

// Owner gate shared by every route here. On any failure it writes the response
// and returns { error: true }; on success returns the owner + agent row + meta.
async function loadOwnedAgent(req, res, id) {
	const auth = await resolveAuth(req);
	if (!auth) { error(res, 401, 'unauthorized', 'sign in required'); return { error: true }; }

	const [row] = await sql`SELECT id, user_id, meta FROM agent_identities WHERE id = ${id} AND deleted_at IS NULL`;
	if (!row) { error(res, 404, 'not_found', 'agent not found'); return { error: true }; }
	if (row.user_id !== auth.userId) { error(res, 403, 'forbidden', 'not your agent'); return { error: true }; }

	return { auth, row, meta: { ...(row.meta || {}) } };
}

// Whole-token → base units, and SOL → lamports, without float drift on the
// integer part. amount is already validated finite + positive.
function toBaseUnits(amount, decimals) {
	const [whole, frac = ''] = String(amount).split('.');
	const fracPadded = (frac + '0'.repeat(decimals)).slice(0, decimals);
	return BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(fracPadded || '0');
}

function solToLamports(sol) {
	return toBaseUnits(sol, 9);
}

function lamportsToSol(l) {
	return Number(BigInt(l)) / 1e9;
}

// Resolve the agent's SPL holding for a mint: token program, decimals, ATA, and
// current base-unit balance. Throws a structured boundary error on any miss.
async function resolveHolding(conn, mintPk, ownerPk) {
	let mintAcc;
	try {
		mintAcc = await conn.getAccountInfo(mintPk);
	} catch {
		mintAcc = null;
	}
	if (!mintAcc) throw boundary(400, 'invalid_mint', 'token mint not found on this network');
	const tokenProgramId = mintAcc.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;

	let decimals;
	try {
		decimals = (await getMint(conn, mintPk, 'confirmed', tokenProgramId)).decimals;
	} catch {
		throw boundary(400, 'invalid_mint', 'could not read the token mint');
	}

	const ata = getAssociatedTokenAddressSync(mintPk, ownerPk, false, tokenProgramId, ASSOCIATED_TOKEN_PROGRAM_ID);
	let balanceRaw = 0n;
	try {
		balanceRaw = BigInt((await conn.getTokenAccountBalance(ata)).value.amount);
	} catch {
		balanceRaw = 0n; // no ATA → holds none
	}
	return { tokenProgramId, decimals, ata, balanceRaw };
}

function boundary(status, code, message, detail = {}) {
	return Object.assign(new Error(message), { status, code, detail, isBoundary: true });
}

function isGraduatedErr(err) {
	return err?.name === 'CoinGraduatedError' || err?.code === 'CoinGraduated';
}

// Price a buy or sell against live state. Returns everything the guards and the
// builder need. Throws boundary() errors for bad input / unpriceable / RPC.
async function quoteTrade({ ctx, side, mintPk, amount, isMax, slippagePct, network, ownerPk }) {
	const slippageBps = Math.round(slippagePct * 100);

	if (side === 'buy') {
		const lamports = solToLamports(amount);
		if (lamports <= 0n) throw boundary(400, 'invalid_amount', 'amount rounds to zero lamports');
		let q;
		try {
			q = await ctx.client.quoteForBuy({ mint: mintPk, quoteAmount: new ctx.BN(lamports.toString()), slippagePct });
		} catch (err) {
			if (isGraduatedErr(err)) {
				// Graduated → route the buy through the canonical AMM pool (mirrors the
				// graduated sell path below). Exact-SOL-in: expected tokens out, with the
				// SOL ceiling enforced on-chain via maxQuote inside the builder.
				const a = await quoteAmmBuy({ network, mint: mintPk.toBase58(), quoteAmount: new ctx.BN(lamports.toString()), slippagePct });
				const expectedBase = a.expectedBaseOut;
				if (expectedBase <= 0n) throw boundary(422, 'zero_out', 'this amount buys zero tokens — raise it');
				return {
					venue: 'amm',
					lamports, baseAmount: null, decimals: null,
					expectedOutRaw: expectedBase, minOutRaw: a.minBaseOut,
					priceImpactPct: Number(a.priceImpactPct ?? 0),
					usdValue: null, slippageBps,
				};
			}
			console.error('[agents/agent-trade] buy quote failed', err?.message);
			throw boundary(502, 'quote_failed', 'could not price the buy — try again');
		}
		requireSolQuote(ctx, q.quoteMint);
		const expectedBase = BigInt(q.expectedBaseTokens.toString());
		if (expectedBase <= 0n) throw boundary(422, 'zero_out', 'this amount buys zero tokens — raise it');
		const minOut = (expectedBase * BigInt(10000 - slippageBps)) / 10000n;
		return {
			venue: 'bonding_curve',
			lamports, baseAmount: null, decimals: null,
			expectedOutRaw: expectedBase, minOutRaw: minOut,
			priceImpactPct: Number(q.priceImpactPct ?? 0),
			usdValue: null, slippageBps,
		};
	}

	// sell
	const conn = ctx.connection;
	const { decimals, balanceRaw } = await resolveHolding(conn, mintPk, ownerPk);
	if (balanceRaw <= 0n) throw boundary(400, 'insufficient_token_balance', 'the agent holds none of this token');
	const baseAmount = isMax ? balanceRaw : toBaseUnits(amount, decimals);
	if (baseAmount <= 0n) throw boundary(400, 'invalid_amount', 'amount rounds to zero token units');
	if (baseAmount > balanceRaw) {
		throw boundary(400, 'insufficient_token_balance', 'amount exceeds the agent token balance', {
			balance_raw: balanceRaw.toString(), decimals,
		});
	}

	const baseBn = new ctx.BN(baseAmount.toString());
	let expectedSolOut;
	let priceImpactPct;
	let venue = 'bonding_curve';
	try {
		const q = await ctx.client.quoteForSell({ mint: mintPk, baseAmount: baseBn, slippagePct });
		requireSolQuote(ctx, q.quoteMint);
		expectedSolOut = BigInt(q.expectedQuoteOut.toString());
		priceImpactPct = Number(q.priceImpactPct ?? 0);
	} catch (err) {
		if (!isGraduatedErr(err)) {
			if (err?.isBoundary) throw err;
			console.error('[agents/agent-trade] sell quote failed', err?.message);
			throw boundary(502, 'quote_failed', 'could not price the sell — try again');
		}
		// Graduated: route the quote through the canonical AMM pool.
		const a = await quoteAmmSell({ network, mint: mintPk.toBase58(), baseAmount: baseBn, slippagePct });
		expectedSolOut = a.expectedQuoteOut;
		priceImpactPct = Number(a.priceImpactPct ?? 0);
		venue = 'amm';
	}
	const minOut = (expectedSolOut * BigInt(10000 - slippageBps)) / 10000n;
	return {
		venue,
		lamports: null, baseAmount, decimals,
		expectedOutRaw: expectedSolOut, minOutRaw: minOut,
		priceImpactPct, usdValue: null, slippageBps,
	};
}

function requireSolQuote(ctx, quoteMint) {
	if (!quoteMint) return;
	const isDefault = quoteMint.equals?.(ctx.web3.PublicKey.default);
	const b58 = quoteMint.toBase58?.();
	if (isDefault || b58 === WSOL_MINT) return;
	throw boundary(422, 'quote_not_sol', 'this coin is not SOL-quoted — the agent wallet trades in SOL on this path');
}

// Build the on-chain instructions for a prepared trade.
async function buildTradeInstructions({ ctx, side, venue, mintPk, ownerPk, lamports, baseAmount, slippagePct, network }) {
	if (side === 'buy') {
		if (venue === 'amm') {
			const built = await buildAmmBuyInstructions({ network, mint: mintPk.toBase58(), user: ownerPk, quoteAmount: new ctx.BN(lamports.toString()), slippagePct });
			return { instructions: built.instructions, expectedOutRaw: built.expectedBaseOut };
		}
		const built = await ctx.client.buildBuyInstructions({
			mint: mintPk, user: ownerPk, quoteAmount: new ctx.BN(lamports.toString()), slippagePct,
		});
		return { instructions: built.instructions, expectedOutRaw: BigInt(built.expectedBaseTokens.toString()) };
	}
	const baseBn = new ctx.BN(baseAmount.toString());
	if (venue === 'amm') {
		const built = await buildAmmSellInstructions({ network, mint: mintPk.toBase58(), user: ownerPk, baseAmount: baseBn, slippagePct });
		return { instructions: built.instructions, expectedOutRaw: built.expectedQuoteOut };
	}
	const built = await ctx.client.buildSellInstructions({ mint: mintPk, user: ownerPk, baseAmount: baseBn, slippagePct });
	return { instructions: built.instructions, expectedOutRaw: BigInt(built.expectedQuoteOut.toString()) };
}

// Run every guard for a prepared trade. Returns null if clear, or a 4xx response
// shape. Buys are gated on the lamport caps + USD ceiling + balance; sells only
// move SOL inward, so they skip the spend caps but still honor the kill switch,
// the price-impact breaker, and a fee-headroom floor.
async function runGuards({ id, side, tradeLimits, prep, walletLamports, network, meta, mintPk, ownerPk, userId }) {
	const killed = checkKillSwitch(tradeLimits.kill_switch);
	if (killed) return tradeGuardResponse(killed);

	const impact = checkPriceImpact(prep.priceImpactPct, tradeLimits.max_price_impact_pct);
	if (impact) return tradeGuardResponse(impact);

	if (side === 'buy') {
		const lamports = prep.lamports;
		const capLamports = tradeLimits.per_trade_sol == null ? null : solToLamports(tradeLimits.per_trade_sol);
		const cap = checkPerTradeCap(lamports, capLamports);
		if (cap) return tradeGuardResponse(cap);

		if (tradeLimits.max_concurrent != null) {
			const open = await countOpenTrades(id, network);
			const conc = checkConcurrency(open, tradeLimits.max_concurrent);
			if (conc) return tradeGuardResponse(conc);
		}

		const budgetLamports = tradeLimits.daily_budget_sol == null ? null : solToLamports(tradeLimits.daily_budget_sol);
		if (budgetLamports != null) {
			const spent = await getDailySpendLamports(id, network);
			const budget = checkDailyBudgetLamports(spent, lamports, budgetLamports);
			if (budget) return tradeGuardResponse(budget);
		}

		// Cross-path USD ceiling (shared with withdraw / x402 / snipe).
		try {
			await enforceSpendLimit({ agentId: id, meta, category: 'trade', usdValue: prep.usdValue, network });
		} catch (e) {
			if (e instanceof SpendLimitError) return { status: e.status, code: e.code, message: e.message, detail: e.detail };
			throw e;
		}

		const headroom = checkSolHeadroom(walletLamports, lamports, SOL_FEE_HEADROOM_LAMPORTS);
		if (headroom) return tradeGuardResponse(headroom);

		// Rug/honeypot firewall — a REAL on-chain simulated buy→sell round-trip +
		// authority audit. A 'block' verdict refuses the buy (server-signed funds
		// never move on a coin you can't sell). Never throws; degrades to 'warn'.
		if (mintPk) {
			const assessment = await assessTradeSafety({
				network, mint: mintPk, side: 'buy', payer: ownerPk,
				quoteAmount: lamports, priceImpactPct: prep.priceImpactPct,
			}).catch(() => null);
			if (assessment) {
				recordFirewallDecision({
					mint: mintPk.toBase58?.() || String(mintPk), network, side: 'buy',
					verdict: assessment.verdict, score: assessment.score, simulated: assessment.simulated,
					checks: assessment.checks, reasons: assessment.reasons,
					source: 'discretionary', agentId: id, userId: userId ?? null,
					quoteLamports: lamports, enforced: assessment.verdict === 'block',
				}).catch(() => {});
				if (assessment.verdict === 'block') return firewallGuardResponse(assessment);
			}
		}
	} else {
		// Sell: only needs enough SOL on hand to pay the network fee (and maybe
		// open a wSOL/quote ATA). Reuse the same headroom floor with zero spend.
		const headroom = checkSolHeadroom(walletLamports, 0n, SOL_FEE_HEADROOM_LAMPORTS);
		if (headroom) {
			return tradeGuardResponse({
				reason: 'insufficient_sol',
				detail: { wallet_lamports: BigInt(walletLamports).toString(), required_lamports: SOL_FEE_HEADROOM_LAMPORTS.toString() },
			});
		}
	}
	return null;
}

// Count the agent's open discretionary trades in the trailing window — buys that
// haven't been closed by a matching sell. A lightweight concurrency signal drawn
// from the unified custody ledger (only enforced when max_concurrent is set).
async function countOpenTrades(agentId, network) {
	const [r] = await sql`
		SELECT count(*)::int AS n FROM agent_custody_events
		WHERE agent_id = ${agentId} AND network = ${network}
		  AND event_type = 'spend' AND category = 'trade'
		  AND status IN ('pending', 'confirmed', 'ok')
		  AND (meta->>'side') = 'buy'
		  AND created_at > now() - interval '24 hours'
	`;
	return r?.n ?? 0;
}

// Parse + validate the trade request body into a normalized shape, or throw a
// boundary() error. Shared by execute + preview + the strategy runtime (which
// builds a synthetic body { side, mint, amount, slippageBps, network }).
export function parseTradeInput(body, tradeLimits) {
	const side = body.side === 'sell' ? 'sell' : body.side === 'buy' ? 'buy' : null;
	if (!side) throw boundary(400, 'invalid_side', 'side must be "buy" or "sell"');

	const mintCheck = validateSolanaAddress(body.mint);
	if (!mintCheck.valid) throw boundary(400, 'invalid_mint', `mint is not a valid Solana address (${mintCheck.reason})`);

	const denom = side === 'buy' ? 'sol' : 'token';
	const isMax = side === 'sell' && (body.amount === 'max' || body.amount === 'MAX' || body.amount === 'all');
	let amount = null;
	if (!isMax) {
		amount = Number(body.amount);
		if (!Number.isFinite(amount) || amount <= 0) {
			throw boundary(400, 'invalid_amount', side === 'buy' ? 'amount (SOL to spend) must be a positive number' : 'amount (tokens to sell) must be a positive number or "max"');
		}
	}

	const requestedBps = Number.isFinite(Number(body.slippageBps)) ? Math.round(Number(body.slippageBps)) : tradeLimits.max_slippage_bps;
	const slippageBps = Math.max(0, Math.min(tradeLimits.max_slippage_bps, requestedBps));

	return {
		side, denom, isMax, amount,
		mintPk: mintCheck.pubkey,
		mint: mintCheck.base58,
		slippageBps,
		slippagePct: slippageBps / 100,
		network: normNetwork(body.network),
		simulate: body.simulate === true || process.env.SNIPER_MODE === 'simulate',
		idempotencyKey: typeof body.idempotency_key === 'string' && body.idempotency_key.trim()
			? body.idempotency_key.trim().slice(0, 128)
			: null,
	};
}

// ── execute ─────────────────────────────────────────────────────────────────

async function handleExecute(req, res, id) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const owned = await loadOwnedAgent(req, res, id);
	if (owned.error) return;
	const { auth, meta } = owned;

	const rlUser = await limits.tradePerUser(auth.userId);
	if (!rlUser.success) return rateLimited(res, rlUser);
	const rlIp = await limits.authIp(clientIp(req));
	if (!rlIp.success) return rateLimited(res, rlIp);

	let body;
	try {
		body = await readJson(req);
	} catch (e) {
		return error(res, e?.status === 415 ? 415 : 400, 'bad_request', e?.message || 'invalid request body');
	}

	const tradeLimits = getTradeLimits(meta);
	let input;
	try {
		input = parseTradeInput(body, tradeLimits);
	} catch (e) {
		return boundaryError(res, e);
	}

	// CSRF on the real, fund-moving path only — `simulate` is a dry run that never
	// signs or records. Bearer/API-key callers (the primary consumers of this flat
	// trade endpoint) are exempt inside requireCsrf.
	if (!input.simulate && !(await requireCsrf(req, res, auth.userId))) return;

	let result;
	try {
		result = await executeAgentTrade({ id, userId: auth.userId, meta, input, req, source: 'discretionary' });
	} catch (e) {
		console.error('[agents/agent-trade] execute crashed', e?.message);
		return error(res, 500, 'internal_error', 'unexpected error executing the trade');
	}
	if (!result.ok) {
		return error(res, result.status || 500, result.code || 'error', result.message || 'trade failed', result.detail ? { detail: result.detail } : {});
	}
	return json(res, result.status || 200, { data: result.data });
}

/**
 * Programmatic trade execution core — the shared engine behind BOTH the HTTP
 * trade endpoint and the autonomous strategy runtime (task 10). The caller has
 * already loaded the owned agent (`meta`), parsed + bounded the request into
 * `input`, and — for the HTTP path — verified CSRF. This runs the SAME
 * quote → guard → build → custody-claim → sign → confirm pipeline for every
 * caller, so an autonomous strategy is held to the exact same spend policy,
 * rug/honeypot firewall, daily budget, kill switch, and custody audit trail as a
 * manual trade. A strategy can NEVER exceed the spend leash — the guards below do
 * not know or care who called them.
 *
 * `source` labels the custody ledger: 'discretionary' for the HTTP endpoint, or
 * 'strategy:<slug>' for a strategy-initiated trade (with `sourceMeta` carrying
 * { strategy, strategy_id, equip_id } stamped into the ledger row's meta).
 *
 * @returns {Promise<{ ok:true, status:number, data:object }
 *                  | { ok:false, status:number, code:string, message:string, detail?:object }>}
 */
export async function executeAgentTrade({ id, userId, meta, input, req = null, source = 'discretionary', sourceMeta = null }) {
	const { side, network, simulate, slippagePct } = input;
	const idempotencyKey = input.idempotencyKey || randomUUID();
	const tradeLimits = getTradeLimits(meta);
	const isStrategy = typeof source === 'string' && source.startsWith('strategy:');
	const custodyReason = isStrategy ? source.slice(0, 80) : `trade_${side}`;

	const fail = (status, code, message, detail = null) => ({ ok: false, status, code, message, detail });

	// Guarantee the wallet exists (lazy provision) so a funded-but-unprovisioned
	// agent can trade. ensureAgentWallet audits the provision and never returns
	// the secret.
	let address;
	try {
		address = (await ensureAgentWallet(id, userId, { reason: custodyReason })).address;
	} catch (e) {
		console.error('[agents/agent-trade] wallet prepare failed', e?.message);
		return fail(500, 'wallet_unavailable', 'could not prepare the agent wallet — try again');
	}
	const ownerPk = new PublicKey(address);

	// Fast-path idempotency: a retry of a finished/in-flight trade with the same key.
	{
		const [existing] = await sql`
			SELECT id, status, signature, meta FROM agent_custody_events
			WHERE agent_id = ${id} AND idempotency_key = ${idempotencyKey}
		`;
		if (existing) {
			if (existing.status === 'confirmed') {
				return { ok: true, status: 200, data: { replayed: true, signature: existing.signature, explorer: explorerTxUrl(existing.signature, network), network, ...(existing.meta || {}) } };
			}
			if (existing.status === 'pending') {
				return fail(409, 'trade_in_progress', 'a trade with this id is already in flight — check the audit log before retrying', { signature: existing.signature || null });
			}
			return fail(409, 'trade_failed', 'this trade id already failed — retry with a fresh idempotency key', { signature: existing.signature || null });
		}
	}

	let ctx;
	try {
		ctx = await getPumpTradeClient({ network });
	} catch (e) {
		console.error('[agents/agent-trade] trade RPC unavailable', e?.message);
		return fail(502, 'rpc_error', 'could not connect to the trade RPC — try again');
	}
	const conn = ctx.connection;

	let walletLamports;
	try {
		walletLamports = BigInt(await conn.getBalance(ownerPk, 'confirmed'));
	} catch {
		return fail(502, 'rpc_error', 'could not read the wallet balance — try again');
	}

	// Price the trade.
	let prep;
	try {
		prep = await quoteTrade({ ctx, side, mintPk: input.mintPk, amount: input.amount, isMax: input.isMax, slippagePct, network, ownerPk });
	} catch (e) {
		if (e?.isBoundary) return fail(e.status, e.code, e.message, e.detail && Object.keys(e.detail).length ? e.detail : null);
		return fail(500, 'internal_error', 'unexpected error preparing the trade');
	}
	if (side === 'buy' && prep.lamports != null) {
		try { prep.usdValue = await lamportsToUsd(prep.lamports); } catch { prep.usdValue = null; }
	}

	// Run the shared guardrails — identical for manual + strategy trades.
	let blocked;
	try {
		blocked = await runGuards({ id, side, tradeLimits, prep, walletLamports, network, meta, mintPk: input.mintPk, ownerPk, userId });
	} catch (e) {
		console.error('[agents/agent-trade] guard check failed', e?.message);
		return fail(502, 'guard_check_failed', 'could not verify the trade guardrails — try again');
	}
	if (blocked) return fail(blocked.status, blocked.code, blocked.message, blocked.detail);

	// Build the on-chain instructions (also the real graduation check for buys).
	let built;
	try {
		built = await buildTradeInstructions({ ctx, side, venue: prep.venue, mintPk: input.mintPk, ownerPk, lamports: prep.lamports, baseAmount: prep.baseAmount, slippagePct, network });
	} catch (e) {
		if (isGraduatedErr(e)) {
			return fail(409, 'graduated', 'This coin graduated mid-trade — refresh the quote and retry.');
		}
		console.error('[agents/agent-trade] build failed', e?.message);
		return fail(502, 'build_failed', 'could not build the trade — try again');
	}

	const ledgerMeta = {
		side, mint: input.mint, venue: prep.venue, slippage_bps: input.slippageBps,
		price_impact_pct: prep.priceImpactPct,
		expected_out: prep.expectedOutRaw.toString(),
		min_out: prep.minOutRaw.toString(),
		...(side === 'sell' ? { base_amount: prep.baseAmount.toString(), token_decimals: prep.decimals } : {}),
		...(isStrategy ? { source: 'strategy', strategy: sourceMeta?.strategy ?? null, strategy_id: sourceMeta?.strategy_id ?? null, equip_id: sourceMeta?.equip_id ?? null } : {}),
	};

	// Paper mode: simulate the real instructions, never sign, never record.
	if (simulate) {
		const message = new TransactionMessage({ payerKey: ownerPk, recentBlockhash: (await safeBlockhash(conn))?.blockhash || '11111111111111111111111111111111', instructions: built.instructions }).compileToV0Message();
		const vtx = new VersionedTransaction(message);
		let sim = null;
		try {
			sim = await conn.simulateTransaction(vtx, { sigVerify: false, replaceRecentBlockhash: true });
		} catch (e) {
			console.error('[agents/agent-trade] simulation failed', e?.message);
			return fail(502, 'simulation_failed', e?.message || 'simulation failed');
		}
		return {
			ok: true,
			status: 200,
			data: {
				simulated: true, side, mint: input.mint, network, venue: prep.venue,
				expected_out: prep.expectedOutRaw.toString(),
				min_out: prep.minOutRaw.toString(),
				price_impact_pct: prep.priceImpactPct,
				err: sim.value?.err ?? null,
				units_consumed: sim.value?.unitsConsumed ?? null,
			},
		};
	}

	// Claim the idempotency slot — this row is also the ledger/audit entry. Buys
	// count toward the SOL + USD budgets (amount_lamports + usd set); sells move
	// SOL inward, so they record for audit with null amounts (don't consume budget).
	// `reason` is the human-facing custody-trail label: 'strategy:<slug>' for a
	// strategy fill, 'trade_buy'/'trade_sell' for a manual one. Budget queries key
	// on event_type/amount/usd (never reason), so relabeling is safe.
	const claim = await sql`
		INSERT INTO agent_custody_events
			(agent_id, user_id, event_type, category, network, asset,
			 amount_lamports, amount_raw, usd, status, idempotency_key, reason, meta)
		VALUES (
			${id}, ${userId}, 'spend', 'trade', ${network},
			${side === 'buy' ? 'SOL' : input.mint},
			${side === 'buy' ? String(prep.lamports) : null},
			${side === 'sell' ? String(prep.baseAmount) : null},
			${side === 'buy' ? (prep.usdValue ?? null) : null},
			'pending', ${idempotencyKey}, ${custodyReason},
			${JSON.stringify(ledgerMeta)}::jsonb
		)
		ON CONFLICT (agent_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
		RETURNING id
	`;
	if (!claim.length) {
		return fail(409, 'trade_in_progress', 'a trade with this id is already in flight — check the audit log before retrying');
	}
	const claimId = claim[0].id;

	// Recover the custodial key (audit-logged) and sign.
	let keypair;
	try {
		keypair = await recoverSolanaAgentKeypair(meta.encrypted_solana_secret, {
			agentId: id, userId, reason: custodyReason,
			meta: { mint: input.mint, network, venue: prep.venue, custody_event_id: claimId, ...(isStrategy ? { strategy_id: sourceMeta?.strategy_id ?? null, equip_id: sourceMeta?.equip_id ?? null } : {}) },
		});
	} catch (e) {
		console.error('[agents/agent-trade] key recover failed', e?.message);
		await updateCustodyEvent(claimId, { status: 'failed', meta: { error: 'key_recover_failed' } }).catch(() => {});
		return fail(500, 'key_recover_failed', 'could not access the agent wallet key — no funds were moved');
	}

	// Submit + confirm through the protected execution engine.
	let result;
	try {
		result = await signSendConfirm(conn, keypair, built.instructions, network);
	} catch (e) {
		await updateCustodyEvent(claimId, { status: 'failed', meta: { error: e?.code || 'send_failed', message: e?.message?.slice(0, 200) } }).catch(() => {});
		logAudit({ userId, action: isStrategy ? 'custody.trade_strategy_failed' : 'custody.trade_failed', resourceId: id, meta: { side, mint: input.mint, reason: e?.code || 'send_failed', network, source }, req });
		return fail(502, 'send_failed', 'the trade could not be submitted and no funds were moved — try again');
	}

	if (!result.confirmed) {
		await updateCustodyEvent(claimId, { signature: result.signature, meta: { confirm: 'unconfirmed' } }).catch(() => {});
		logAudit({ userId, action: 'custody.trade_unconfirmed', resourceId: id, meta: { side, mint: input.mint, signature: result.signature, network, source }, req });
		return fail(202, 'trade_unconfirmed', 'the trade was submitted but not yet confirmed — check the explorer link before retrying', { signature: result.signature, explorer: explorerTxUrl(result.signature, network) });
	}

	await updateCustodyEvent(claimId, { status: 'confirmed', signature: result.signature, meta: result.exec ? { exec: result.exec } : undefined }).catch(() => {});
	logAudit({ userId, action: isStrategy ? 'custody.trade_strategy' : 'custody.trade', resourceId: id, meta: { side, mint: input.mint, venue: prep.venue, network, signature: result.signature, usd: prep.usdValue, exec_route: result.exec?.route, source }, req });

	// Re-read the SOL balance for the response.
	let newSol = null;
	try { newSol = (await conn.getBalance(ownerPk, 'confirmed')) / 1e9; } catch { /* best-effort */ }

	return {
		ok: true,
		status: 200,
		data: {
			replayed: false,
			custody_event_id: claimId,
			signature: result.signature,
			explorer: explorerTxUrl(result.signature, network),
			side, mint: input.mint, network, venue: prep.venue,
			slippage_bps: input.slippageBps,
			price_impact_pct: prep.priceImpactPct,
			...(side === 'buy'
				? { sol_spent: lamportsToSol(prep.lamports), tokens_received: prep.expectedOutRaw.toString(), expected_out_raw: prep.expectedOutRaw.toString() }
				: { tokens_sold: prep.baseAmount.toString(), sol_received: lamportsToSol(prep.expectedOutRaw), expected_out_raw: prep.expectedOutRaw.toString() }),
			min_out: prep.minOutRaw.toString(),
			new_balance_sol: newSol,
			execution: result.exec || null,
		},
	};
}

async function safeBlockhash(conn) {
	try { return await conn.getLatestBlockhash('confirmed'); } catch { return null; }
}

/**
 * Live SOL value (lamports) of selling `baseAmountRaw` base units of `mint` right
 * now — a zero-slippage quote used by the strategy runtime to mark open positions
 * to market for take-profit / stop-loss / trailing-stop decisions. Reuses the
 * exact bonding-curve + AMM quote path the real sell uses, so the valuation and
 * the eventual fill are priced the same way. Returns null if it can't be priced
 * (caller treats that as "skip this position this sweep", never as a loss).
 */
export async function quoteSellValueLamports({ network, mint, baseAmountRaw }) {
	const base = BigInt(baseAmountRaw || 0n);
	if (base <= 0n) return null;
	const net = normNetwork(network);
	let ctx;
	try { ctx = await getPumpTradeClient({ network: net }); } catch { return null; }
	const mintPk = new PublicKey(mint);
	const baseBn = new ctx.BN(base.toString());
	try {
		const q = await ctx.client.quoteForSell({ mint: mintPk, baseAmount: baseBn, slippagePct: 0 });
		return BigInt(q.expectedQuoteOut.toString());
	} catch (err) {
		if (!isGraduatedErr(err)) return null;
		try {
			const a = await quoteAmmSell({ network: net, mint, baseAmount: baseBn, slippagePct: 0 });
			return BigInt(a.expectedQuoteOut);
		} catch {
			return null;
		}
	}
}

// Broadcast + confirm through the MEV-aware execution engine: dynamic compute
// budget (real simulate + real priority-fee estimate) and bounded adaptive retry
// with an ambiguous-confirm re-check so a landed tx is never marked failed. The
// discretionary path has no per-strategy tip policy, so it uses the protected
// single-tx route (tipMode 'off' — no Jito tip) while still getting the data-driven
// fee + retry. Returns the execution telemetry for the response.
async function signSendConfirm(conn, payer, instructions, network) {
	let result;
	try {
		result = await submitProtected({
			network, connection: conn, payer, instructions,
			opts: { tipMode: 'off', confirmTimeoutMs: CONFIRM_TIMEOUT_MS },
		});
	} catch (e) {
		if (e?.code === 'TX_ERR') {
			// Landed but reverted on-chain — surfaced as confirmed:false so the caller
			// records the (failed) signature rather than retrying.
			return { signature: e.signature || null, confirmed: false, exec: null };
		}
		throw Object.assign(new Error(e?.message || 'send failed'), { code: 'send_failed' });
	}
	return {
		signature: result.signature,
		confirmed: true,
		exec: { route: result.route, priority_fee_microlamports: result.priorityFeeMicroLamports, landed_ms: result.landedMs, attempts: result.attempts },
	};
}

// ── preview / quote ───────────────────────────────────────────────────────────

async function handleQuote(req, res, id) {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	const owned = await loadOwnedAgent(req, res, id);
	if (owned.error) return;
	const { auth, meta } = owned;

	const rl = await limits.walletRead(auth.userId);
	if (!rl.success) return rateLimited(res, rl);

	let body = {};
	if (req.method === 'POST') {
		try { body = await readJson(req); } catch (e) { return error(res, 400, 'bad_request', e?.message || 'invalid request body'); }
	} else {
		const url = new URL(req.url, 'http://x');
		body = {
			side: url.searchParams.get('side'),
			mint: url.searchParams.get('mint'),
			amount: url.searchParams.get('amount'),
			slippageBps: url.searchParams.get('slippageBps'),
			network: url.searchParams.get('network'),
		};
	}

	const tradeLimits = getTradeLimits(meta);
	let input;
	try {
		input = parseTradeInput(body, tradeLimits);
	} catch (e) {
		return boundaryError(res, e);
	}
	const { side, network, slippagePct } = input;

	const address = meta.solana_address || null;
	if (!address) return error(res, 404, 'no_wallet', 'agent has no solana wallet yet — fund it to start trading');
	const ownerPk = new PublicKey(address);

	let ctx;
	try { ctx = await getPumpTradeClient({ network }); } catch { return error(res, 502, 'rpc_error', 'could not connect to the trade RPC — try again'); }
	const conn = ctx.connection;

	let walletLamports = 0n;
	try { walletLamports = BigInt(await conn.getBalance(ownerPk, 'confirmed')); } catch { /* preview tolerates */ }

	let prep;
	try {
		prep = await quoteTrade({ ctx, side, mintPk: input.mintPk, amount: input.amount, isMax: input.isMax, slippagePct, network, ownerPk });
	} catch (e) {
		return boundaryError(res, e);
	}
	if (side === 'buy' && prep.lamports != null) {
		try { prep.usdValue = await lamportsToUsd(prep.lamports); } catch { prep.usdValue = null; }
	}

	let blocked = null;
	try { blocked = await runGuards({ id, side, tradeLimits, prep, walletLamports, network, meta, mintPk: input.mintPk, ownerPk, userId: auth.userId }); } catch { blocked = null; }

	return json(res, 200, {
		data: {
			side, mint: input.mint, network, venue: prep.venue,
			slippage_bps: input.slippageBps,
			price_impact_pct: prep.priceImpactPct,
			...(side === 'buy'
				? { sol_in: lamportsToSol(prep.lamports), expected_tokens_out: prep.expectedOutRaw.toString() }
				: { tokens_in: prep.baseAmount.toString(), token_decimals: prep.decimals, expected_sol_out: lamportsToSol(prep.expectedOutRaw) }),
			min_out: prep.minOutRaw.toString(),
			wallet_balance_sol: Number(walletLamports) / 1e9,
			allowed: !blocked,
			blocked_reason: blocked ? { code: blocked.code, message: blocked.message, detail: blocked.detail } : null,
		},
	});
}

// ── limits (read / update) ──────────────────────────────────────────────────

async function handleLimits(req, res, id) {
	if (cors(req, res, { methods: 'GET,PUT,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'PUT'])) return;

	const owned = await loadOwnedAgent(req, res, id);
	if (owned.error) return;
	const { auth, meta } = owned;

	if (req.method === 'GET') {
		// Surface the live daily spend alongside the limits so the owner can see how
		// much of the daily budget the agent has already burned (mainnet — the
		// budget guard keys on the same window/network). Best-effort: a spend-query
		// hiccup must never block reading the limits themselves.
		const network = normNetwork(new URL(req.url, 'http://x').searchParams.get('network'));
		let spentLamports = 0n;
		try { spentLamports = await getDailySpendLamports(id, network); } catch { spentLamports = 0n; }
		let spentUsd = null;
		if (spentLamports > 0n) { try { spentUsd = await lamportsToUsd(spentLamports); } catch { spentUsd = null; } }
		return json(res, 200, {
			data: {
				limits: getTradeLimits(meta),
				defaults: TRADE_LIMIT_DEFAULTS,
				spent_today_sol: Number(spentLamports) / 1e9,
				spent_today_usd: spentUsd,
				network,
			},
		});
	}

	// Relaxing the trade guard rails (per-trade cap, daily budget, kill-switch)
	// is a state-changing owner action — match the same CSRF gate the withdraw
	// and spend-limit writes use. Bearer (machine) callers are exempt inside
	// requireCsrf, like every other write path.
	if (!(await requireCsrf(req, res, auth.userId))) return;

	const rl = await limits.tradePerUser(auth.userId);
	if (!rl.success) return rateLimited(res, rl);

	let body;
	try { body = await readJson(req); } catch (e) { return error(res, 400, 'bad_request', e?.message || 'invalid request body'); }

	const invalid = validateLimitsPatch(body);
	if (invalid) return error(res, 400, 'validation_error', invalid);

	try {
		const next = await setTradeLimits(id, auth.userId, body, { req });
		return json(res, 200, { data: { limits: next } });
	} catch (e) {
		if (e?.status) return error(res, e.status, e.code || 'error', e.message);
		return error(res, 500, 'limit_update_failed', 'could not update the trade limits — try again');
	}
}

// Reject a bad limits patch instead of letting it through. normalizeTradeLimits
// coerces anything it cannot read into "no cap" / the default, so an unvalidated
// `{"per_trade_sol": -1}` (or a typo, or a string) SILENTLY DELETES the owner's
// existing per-trade ceiling and answers 200 as if it had tightened it. A spend
// guardrail must never be relaxed by an input the server could not parse: the
// only way to clear a cap is to send it as an explicit null.
const LIMIT_RANGES = {
	per_trade_sol: { min: 0, max: 1e6, label: 'per_trade_sol must be a positive number of SOL, or null to clear the cap' },
	daily_budget_sol: { min: 0, max: 1e6, label: 'daily_budget_sol must be a positive number of SOL, or null to clear the budget' },
	max_price_impact_pct: { min: 0, max: 100, label: 'max_price_impact_pct must be a number between 0 and 100' },
	max_slippage_bps: { min: 0, max: 10000, label: 'max_slippage_bps must be a number between 0 and 10000' },
	max_concurrent: { min: 1, max: 10000, label: 'max_concurrent must be a whole number of at least 1, or null for no ceiling' },
};

function validateLimitsPatch(patch) {
	if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return 'body must be a JSON object of limit fields';
	for (const [key, range] of Object.entries(LIMIT_RANGES)) {
		if (!(key in patch)) continue;
		const v = patch[key];
		if (v === null) continue; // explicit clear
		const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
		if (!Number.isFinite(n) || n < range.min || n > range.max) return range.label;
	}
	if ('kill_switch' in patch && typeof patch.kill_switch !== 'boolean') {
		return 'kill_switch must be true or false';
	}
	return null;
}

function boundaryError(res, e) {
	if (e?.isBoundary) return error(res, e.status, e.code, e.message, e.detail && Object.keys(e.detail).length ? { detail: e.detail } : {});
	return error(res, 500, 'internal_error', 'unexpected error preparing the trade');
}

export default async function handler(req, res, id, action) {
	if (action === 'limits') return handleLimits(req, res, id);
	if (action === 'quote') return handleQuote(req, res, id);
	if (action) return error(res, 404, 'not_found', 'unknown trade sub-resource');
	return handleExecute(req, res, id);
}
