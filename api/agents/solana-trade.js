// /api/agents/:id/solana/trade — discretionary pump.fun trading from the agent's
// OWN custodial wallet, server-signed. Dispatched from api/agents/[id].js via the
// solana-wallet handler (action === 'trade' | 'trade-history').
//
// This is the discretionary sibling of the agent-sniper executor: same custodial
// signing, same shared spend guardrails (api/_lib/agent-trade-guards.js), same
// pump.fun SDK instruction builders, same idempotent custody ledger — but driven
// by the owner from the wallet hub instead of by an autonomous strategy.
//
//   POST /api/agents/:id/solana/trade          buy/sell (owner-only, server-signed)
//   POST /api/agents/:id/solana/trade  {preview:true}   live quote, never signs
//   GET  /api/agents/:id/solana/trade-history  unified discretionary + sniper feed
//
// Hard rules honoured: the key is decrypted only via recoverSolanaAgentKeypair,
// only after auth + ownership, always audit-logged; guard rejections are
// structured 4xx with an actionable reason (never a 500); a retried idempotency
// key never double-spends; balances/positions reflect only confirmed on-chain
// state. $THREE is the only coin three.ws promotes — this surface is coin-agnostic
// plumbing that trades whatever mint the owner supplies at runtime.

import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { sql } from '../_lib/db.js';
import { cors, json, method, error, readJson, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { requireCsrf } from '../_lib/csrf.js';
import { recoverSolanaAgentKeypair } from '../_lib/agent-wallet.js';
import { solanaConnection, solanaPublicConnection } from '../_lib/agent-pumpfun.js';
import { PublicKey } from '@solana/web3.js';
import { cacheSet } from '../_lib/cache.js';
import { logAudit } from '../_lib/audit.js';
import { explorerTxUrl } from '../_lib/avatar-wallet.js';
import {
	enforceSpendLimit, SpendLimitError, getSpendLimits, updateCustodyEvent, lamportsToUsd,
	getTradeLimits, getDailySpendLamports,
	checkKillSwitch, checkPerTradeCap, checkDailyBudgetLamports, checkSolHeadroom, checkPriceImpact,
	SOL_FEE_HEADROOM_LAMPORTS,
} from '../_lib/agent-trade-guards.js';
import {
	slippagePercentFromBps, resolveCustodialQuote, resolveTokenProgramForMintOwner,
	WSOL_MINT,
} from '../_lib/pump-trade-args.js';
import { getBuyQuote, getSellQuote } from '../_lib/solana/sdk-bridge.js';
import { getAmmPoolState } from '../_lib/pump.js';
import { assessTradeSafety, recordFirewallDecision } from '../_lib/trade-firewall.js';
import { submitProtected } from '../_lib/execution-engine.js';

const LAMPORTS_PER_SOL = 1_000_000_000;
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// The SOL fee/rent headroom, the price-impact breaker, the per-trade cap, the
// daily budget, and the kill switch all live in the shared guardrail module
// (api/_lib/agent-trade-guards.js) — the SAME predicates the sniper executor and
// the flat /api/agents/:id/trade endpoint call, so the "is this trade allowed"
// math has exactly one home and can't drift between paths. This handler resolves
// the per-agent limits from meta.trade_limits and hands the live numbers to those
// predicates; the breaker ceiling, per-trade cap, and daily budget are all
// owner-configurable there.
const DEFAULT_SLIPPAGE_BPS = 300; // 3% — discretionary default; owner can change

async function resolveAuth(req) {
	const session = await getSessionUser(req);
	if (session) return { userId: session.id };
	const bearer = await authenticateBearer(extractBearer(req));
	if (bearer) return { userId: bearer.userId };
	return null;
}

// Owner gate: auth → load agent → verify ownership → return custodial wallet.
// Returns { error: true } (response already sent) on any failure.
async function loadOwnedWallet(req, res, id) {
	const auth = await resolveAuth(req);
	if (!auth) { error(res, 401, 'unauthorized', 'sign in to trade from this wallet'); return { error: true }; }
	const [row] = await sql`SELECT id, user_id, meta FROM agent_identities WHERE id = ${id} AND deleted_at IS NULL`;
	if (!row) { error(res, 404, 'not_found', 'agent not found'); return { error: true }; }
	if (row.user_id !== auth.userId) { error(res, 403, 'forbidden', 'only the owner can trade from this wallet'); return { error: true }; }
	const meta = { ...(row.meta || {}) };
	return { auth, meta, address: meta.solana_address || null, encryptedSecret: meta.encrypted_solana_secret || null };
}

function netOf(v) {
	return v === 'devnet' ? 'devnet' : 'mainnet';
}

function lamportsToSol(l) {
	return Number(BigInt(l)) / LAMPORTS_PER_SOL;
}

// Apply a slippage floor: out * (10000 - bps) / 10000, in integer base units.
function applySlippageFloor(amountBase, slippageBps) {
	const a = BigInt(amountBase);
	const bps = BigInt(Math.max(0, Math.min(10_000, slippageBps)));
	return (a * (10_000n - bps)) / 10_000n;
}

// Read a mint's decimals from chain (parsed account). Pump.fun coins are 6dp;
// fall back to 6 only when the parse fails so display never divides by NaN.
async function resolveMintDecimals(conn, mintPk) {
	try {
		const info = await conn.getParsedAccountInfo(mintPk);
		const dec = info?.value?.data?.parsed?.info?.decimals;
		if (Number.isInteger(dec)) return dec;
	} catch { /* fall through */ }
	return 6;
}

// ── live quote ────────────────────────────────────────────────────────────────
// Pure read: expected output, price impact, slippage floor, fee context. Tries
// the bonding curve first (getBuy/SellQuote → price impact); on a graduated coin
// (no curve) it prices off the canonical AMM pool. Throws a typed error the
// handler maps to a clean 4xx.
export async function quoteTrade({ conn, side, mintPk, mintStr, network, solAmount, tokenAmountRaw, slippageBps }) {
	if (side === 'buy') {
		const lamportsIn = BigInt(Math.floor(Number(solAmount) * LAMPORTS_PER_SOL));
		if (lamportsIn <= 0n) throw typed(400, 'amount_too_small', 'enter a SOL amount greater than zero');

		// Bonding curve first.
		const curve = await getBuyQuote(conn, mintStr, lamportsIn.toString());
		if (curve && curve.tokens) {
			// Platform rule: agents never buy pump.fun mayhem-mode coins — only
			// regular coins. The mayhem flag is read straight off the bonding curve
			// (ungameable), so a mayhem coin is refused before any spend. Sells are
			// unaffected, so an agent already holding one can always exit.
			if (curve.isMayhemMode) throw typed(422, 'mayhem_blocked', 'this is a pump.fun mayhem-mode coin — agents only buy regular coins');
			const decimals = await resolveMintDecimals(conn, mintPk);
			const tokensOut = BigInt(curve.tokens.toString());
			if (tokensOut <= 0n) throw typed(400, 'amount_too_small', 'that SOL amount is too small to buy any tokens');
			return {
				venue: 'bonding_curve', graduated: false, quoteAsset: 'SOL',
				inAsset: 'SOL', inAmount: Number(solAmount), inAtomics: lamportsIn.toString(),
				outAsset: 'TOKEN', outAtomics: tokensOut.toString(),
				outUi: Number(tokensOut) / 10 ** decimals,
				minOutAtomics: applySlippageFloor(tokensOut, slippageBps).toString(),
				minOutUi: Number(applySlippageFloor(tokensOut, slippageBps)) / 10 ** decimals,
				decimals, priceImpactPct: clampImpact(curve.priceImpact),
			};
		}

		// Graduated → AMM pool.
		const amm = await loadAmm(network, mintPk);
		const sdk = await import('@pump-fun/pump-swap-sdk');
		// `virtualQuoteReserves` is added to `quoteReserve` by the SDK itself —
		// pass the raw reserve here; our own impact math uses the summed value.
		const r = sdk.buyQuoteInput({
			quote: new amm.BN(lamportsIn.toString()), slippage: slippagePercentFromBps(slippageBps),
			baseReserve: amm.baseReserve, quoteReserve: amm.quoteReserve,
			virtualQuoteReserves: amm.virtualQuoteReserves, globalConfig: amm.globalConfig,
			baseMintAccount: amm.baseMintAccount, baseMint: amm.pool.baseMint,
			coinCreator: amm.pool.coinCreator, creator: amm.pool.creator, feeConfig: amm.feeConfig,
		});
		const decimals = await resolveMintDecimals(conn, mintPk);
		const tokensOut = BigInt((r.base ?? 0).toString());
		if (tokensOut <= 0n) throw typed(400, 'amount_too_small', 'that SOL amount is too small to buy any tokens');
		return {
			venue: 'amm', graduated: true, quoteAsset: 'SOL', poolKey: amm.poolKey.toString(),
			inAsset: 'SOL', inAmount: Number(solAmount), inAtomics: lamportsIn.toString(),
			outAsset: 'TOKEN', outAtomics: tokensOut.toString(), outUi: Number(tokensOut) / 10 ** decimals,
			minOutAtomics: applySlippageFloor(tokensOut, slippageBps).toString(),
			minOutUi: Number(applySlippageFloor(tokensOut, slippageBps)) / 10 ** decimals,
			decimals, priceImpactPct: derivePriceImpact(amm.effectiveQuoteReserve, amm.baseReserve, lamportsIn, tokensOut),
		};
	}

	// SELL — amount is token base units.
	const baseUnits = BigInt(tokenAmountRaw);
	if (baseUnits <= 0n) throw typed(400, 'amount_too_small', 'enter a token amount greater than zero');
	const decimals = await resolveMintDecimals(conn, mintPk);

	const curve = await getSellQuote(conn, mintStr, baseUnits.toString());
	if (curve && curve.sol) {
		const lamportsOut = BigInt(curve.sol.toString());
		return {
			venue: 'bonding_curve', graduated: false, quoteAsset: 'SOL',
			inAsset: 'TOKEN', inAtomics: baseUnits.toString(), inUi: Number(baseUnits) / 10 ** decimals,
			outAsset: 'SOL', outAtomics: lamportsOut.toString(), outUi: lamportsToSol(lamportsOut),
			minOutAtomics: applySlippageFloor(lamportsOut, slippageBps).toString(),
			minOutUi: lamportsToSol(applySlippageFloor(lamportsOut, slippageBps)),
			decimals, priceImpactPct: clampImpact(curve.priceImpact),
		};
	}

	// Graduated → AMM pool.
	const amm = await loadAmm(network, mintPk);
	const sdk = await import('@pump-fun/pump-swap-sdk');
	const r = sdk.sellBaseInput({
		base: new amm.BN(baseUnits.toString()), slippage: slippagePercentFromBps(slippageBps),
		baseReserve: amm.baseReserve, quoteReserve: amm.quoteReserve,
		virtualQuoteReserves: amm.virtualQuoteReserves, globalConfig: amm.globalConfig,
		baseMintAccount: amm.baseMintAccount, baseMint: amm.pool.baseMint,
		coinCreator: amm.pool.coinCreator, creator: amm.pool.creator, feeConfig: amm.feeConfig,
	});
	const lamportsOut = BigInt((r.uiQuote ?? r.minQuote ?? 0).toString());
	const minLamportsOut = BigInt((r.minQuote ?? r.uiQuote ?? 0).toString());
	return {
		venue: 'amm', graduated: true, quoteAsset: 'SOL', poolKey: amm.poolKey.toString(),
		inAsset: 'TOKEN', inAtomics: baseUnits.toString(), inUi: Number(baseUnits) / 10 ** decimals,
		outAsset: 'SOL', outAtomics: lamportsOut.toString(), outUi: lamportsToSol(lamportsOut),
		minOutAtomics: minLamportsOut.toString(), minOutUi: lamportsToSol(minLamportsOut),
		decimals, priceImpactPct: derivePriceImpact(amm.baseReserve, amm.effectiveQuoteReserve, baseUnits, lamportsOut),
	};
}

// Resolve the canonical AMM pool + reserves for a (SOL-paired) graduated coin.
async function loadAmm(network, mintPk) {
	const amm = await getAmmPoolState({ network, mint: mintPk });
	const resolvedQuote = amm.pool.quoteMint?.toString?.() ?? WSOL_MINT;
	if (resolvedQuote !== WSOL_MINT) {
		throw typed(409, 'unsupported_quote', 'this coin trades against a non-SOL asset — trade it from its coin page instead');
	}
	return amm;
}

// Constant-product price impact (%) of swapping `inAmt` of the input reserve for
// `out` of the output reserve, vs the no-impact spot value. Clamped to [0,100].
function derivePriceImpact(inReserve, outReserve, inAmt, out) {
	const ir = Number(inReserve?.toString?.() ?? inReserve ?? 0);
	const or = Number(outReserve?.toString?.() ?? outReserve ?? 0);
	const a = Number(inAmt?.toString?.() ?? inAmt ?? 0);
	const o = Number(out ?? 0);
	if (!(ir > 0) || !(or > 0) || !(a > 0)) return 0;
	const spotOut = (a * or) / ir;
	if (!(spotOut > 0)) return 0;
	const impact = ((spotOut - o) / spotOut) * 100;
	return Number.isFinite(impact) ? Math.max(0, Math.min(100, impact)) : 0;
}

function clampImpact(v) {
	const n = Number(v);
	return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
}

function typed(status, code, message) {
	const e = new Error(message);
	e.status = status; e.code = code;
	return e;
}

// ── handler ────────────────────────────────────────────────────────────────────
export async function handleTrade(req, res, id) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const owned = await loadOwnedWallet(req, res, id);
	if (owned.error) return;
	const { auth, meta, address, encryptedSecret } = owned;

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	let body;
	try {
		body = await readJson(req);
	} catch (e) {
		return error(res, e?.status === 415 ? 415 : 400, 'bad_request', e?.message || 'invalid request body');
	}

	const side = body.side === 'sell' ? 'sell' : body.side === 'buy' ? 'buy' : null;
	if (!side) return error(res, 400, 'validation_error', 'side must be "buy" or "sell"');

	const mintStr = typeof body.mint === 'string' ? body.mint.trim() : '';
	if (!BASE58_RE.test(mintStr)) return error(res, 400, 'validation_error', 'mint must be a base58 Solana address');
	if (mintStr === WSOL_MINT) return error(res, 400, 'validation_error', 'cannot trade wrapped SOL as a token');
	let mintPk;
	try { mintPk = new PublicKey(mintStr); } catch { return error(res, 400, 'validation_error', 'mint is not a valid Solana address'); }

	const network = netOf(body.network);
	const preview = body.preview === true;

	// CSRF on the state-changing path only — a live preview/quote moves no funds and
	// would otherwise burn a single-use token on every keystroke. Bearer callers exempt.
	if (!preview && !(await requireCsrf(req, res, auth.userId))) return;

	let slippageBps = Number(body.slippage_bps ?? body.slippageBps);
	if (!Number.isFinite(slippageBps)) slippageBps = DEFAULT_SLIPPAGE_BPS;
	slippageBps = Math.max(0, Math.min(5_000, Math.round(slippageBps)));

	// Amount: buy spends SOL; sell sends token base units.
	let solAmount = null;
	let tokenAmountRaw = null;
	if (side === 'buy') {
		solAmount = Number(body.sol_amount ?? body.amount);
		if (!(solAmount > 0)) return error(res, 400, 'validation_error', 'sol_amount must be greater than zero');
		if (solAmount > 1000) return error(res, 400, 'validation_error', 'sol_amount exceeds the 1000 SOL ceiling');
	} else {
		const raw = body.token_amount_raw ?? body.amount_raw;
		if (raw == null || !/^\d+$/.test(String(raw)) || BigInt(String(raw)) <= 0n) {
			return error(res, 400, 'validation_error', 'token_amount_raw must be a positive base-unit integer');
		}
		tokenAmountRaw = String(raw);
	}

	if (!address) {
		return error(res, 409, 'wallet_preparing', 'this agent’s wallet is still being prepared — try again in a moment');
	}
	let ownerPk;
	try {
		ownerPk = new PublicKey(address);
	} catch {
		return error(res, 409, 'wallet_preparing', 'this agent’s wallet is still being prepared — try again in a moment');
	}

	const readConn = solanaConnection(network);

	// 1. Quote (always — preview and execute both need it).
	let quote;
	try {
		quote = await quoteTrade({ conn: readConn, side, mintPk, mintStr, network, solAmount, tokenAmountRaw, slippageBps });
	} catch (e) {
		if (e?.code === 'pool_not_found') {
			return error(res, 404, 'no_market', 'no bonding curve or AMM pool found for this mint on this network — it may not be a pump.fun coin');
		}
		if (e?.status) return error(res, e.status, e.code, e.message);
		console.error('[trade] quote failed', e?.message);
		return error(res, 502, 'quote_failed', 'could not price this trade right now — try again');
	}

	// USD value of the SOL leg (buys spend SOL; sells receive it). Best-effort.
	let usdValue = null;
	try {
		const lamports = side === 'buy' ? BigInt(quote.inAtomics) : BigInt(quote.outAtomics);
		usdValue = await lamportsToUsd(lamports);
	} catch { usdValue = null; }

	const limitsCfg = getSpendLimits(meta);
	const tradeLimits = getTradeLimits(meta);

	// 2. Guards — the SAME shared predicates the sniper + flat /trade endpoint use,
	//    fed the per-agent meta.trade_limits. Surfaced on preview (as a warning) and
	//    on execute (as a hard rejection). The kill switch + price-impact breaker
	//    apply both directions; the SOL caps gate only a BUY (a sell brings SOL in).
	//    Each carries its own 4xx status so the execute path returns the right code.
	let guardWarning = null;

	const killed = checkKillSwitch(tradeLimits.kill_switch);
	if (killed) {
		guardWarning = { status: 403, code: 'trading_paused', message: 'Trading is paused for this agent. Re-enable discretionary trading under Limits & Safety to continue.', detail: {} };
	}

	if (!guardWarning && side === 'buy') {
		const lamportsIn = BigInt(quote.inAtomics);

		// Per-trade SOL cap.
		const capLamports = tradeLimits.per_trade_sol == null ? null : BigInt(Math.floor(tradeLimits.per_trade_sol * LAMPORTS_PER_SOL));
		const cap = checkPerTradeCap(lamportsIn, capLamports);
		if (cap) {
			guardWarning = { status: 422, code: 'per_trade_cap', message: `This buy of ◎${lamportsToSol(lamportsIn).toFixed(4)} is over the per-trade cap of ◎${tradeLimits.per_trade_sol}. Lower it or raise the cap under Limits & Safety.`, detail: cap.detail };
		}

		// Rolling daily SOL budget (shared with the sniper — one wallet, one budget).
		if (!guardWarning && tradeLimits.daily_budget_sol != null) {
			const budgetLamports = BigInt(Math.floor(tradeLimits.daily_budget_sol * LAMPORTS_PER_SOL));
			const spent = await getDailySpendLamports(id, network);
			const budget = checkDailyBudgetLamports(spent, lamportsIn, budgetLamports);
			if (budget) {
				guardWarning = { status: 422, code: 'daily_budget', message: `This buy would bring today's spend to ◎${lamportsToSol(spent + lamportsIn).toFixed(4)}, over the ◎${tradeLimits.daily_budget_sol} daily budget.`, detail: budget.detail };
			}
		}

		// Cross-path USD ceiling (shared with withdraw / x402 / snipe).
		if (!guardWarning) {
			try {
				// ownerInitiated: the hub's discretionary Trade tab is the owner acting
				// in person (session + CSRF), not a delegated skill — so least-privilege
				// "require a capability" never blocks the owner's own trade (like withdraw).
				// `meta` carries the natural-language policy (meta.policy_rules) so the
				// owner's English rules govern this trade alongside the numeric caps.
				await enforceSpendLimit({ agentId: id, meta, limits: limitsCfg, category: 'trade', usdValue, asset: 'SOL', network, ownerInitiated: true });
			} catch (e) {
				if (e instanceof SpendLimitError) guardWarning = { status: e.status, code: e.code, message: e.message, detail: e.detail };
				else throw e;
			}
		}
	}

	// Price-impact circuit breaker — both directions, owner-configurable ceiling.
	if (!guardWarning) {
		const impact = checkPriceImpact(quote.priceImpactPct, tradeLimits.max_price_impact_pct);
		if (impact) {
			guardWarning = {
				status: 422,
				code: 'price_impact_too_high',
				message: `Price impact is ${quote.priceImpactPct.toFixed(1)}%, above the ${tradeLimits.max_price_impact_pct}% safety limit. Reduce the size or pick a deeper market.`,
				detail: { price_impact_pct: quote.priceImpactPct, max_price_impact_pct: tradeLimits.max_price_impact_pct },
			};
		}
	}

	// Rug/honeypot firewall — a REAL on-chain simulated buy→sell round-trip +
	// authority audit, gating BUYS only (a sell brings SOL inward, the safe
	// direction). A 'block' verdict refuses the buy with a structured 422 the UI
	// surfaces pre-trade. Never throws; degrades to 'warn' when a source is down.
	let quoteFirewall = null;
	if (!guardWarning && side === 'buy') {
		const assessment = await assessTradeSafety({
			network, mint: mintPk, side: 'buy', payer: ownerPk,
			quoteAmount: BigInt(quote.inAtomics), priceImpactPct: quote.priceImpactPct,
		}).catch(() => null);
		if (assessment) {
			recordFirewallDecision({
				mint: mintStr, network, side: 'buy',
				verdict: assessment.verdict, score: assessment.score, simulated: assessment.simulated,
				checks: assessment.checks, reasons: assessment.reasons,
				source: 'discretionary', agentId: id, userId: auth.userId,
				quoteLamports: BigInt(quote.inAtomics), enforced: assessment.verdict === 'block',
			}).catch(() => {});
			if (assessment.verdict === 'block') {
				guardWarning = {
					status: 422,
					code: 'firewall_blocked',
					message: assessment.reasons?.[0] || 'This trade was blocked by the safety firewall.',
					detail: { verdict: assessment.verdict, score: assessment.score, simulated: assessment.simulated, reasons: assessment.reasons, checks: assessment.checks },
				};
			} else {
				quoteFirewall = { verdict: assessment.verdict, score: assessment.score, simulated: assessment.simulated, reasons: assessment.reasons, checks: assessment.checks };
			}
		}
	}

	// SOL fee/headroom + balance check (real on-chain balance).
	let walletLamports = null;
	try {
		walletLamports = BigInt(await readConn.getBalance(ownerPk, 'confirmed'));
	} catch {
		try { walletLamports = BigInt(await solanaPublicConnection(network).getBalance(ownerPk, 'confirmed')); }
		catch { walletLamports = null; }
	}
	let fundsWarning = null;
	if (walletLamports != null) {
		const spendLamports = side === 'buy' ? BigInt(quote.inAtomics) : 0n;
		const head = checkSolHeadroom(walletLamports, spendLamports, SOL_FEE_HEADROOM_LAMPORTS);
		if (head) {
			const needed = spendLamports + SOL_FEE_HEADROOM_LAMPORTS;
			fundsWarning = {
				code: side === 'buy' ? 'insufficient_sol' : 'insufficient_sol_for_fees',
				message: side === 'buy'
					? `This buy needs ◎${lamportsToSol(needed).toFixed(4)} (incl. fees) but the wallet holds ◎${lamportsToSol(walletLamports).toFixed(4)}. Fund the wallet to continue.`
					: `Selling needs ~◎${lamportsToSol(SOL_FEE_HEADROOM_LAMPORTS).toFixed(4)} for network fees but the wallet holds ◎${lamportsToSol(walletLamports).toFixed(4)}.`,
				detail: { needed_lamports: needed.toString(), balance_lamports: walletLamports.toString() },
			};
		}
	}

	let feeBps = 0;
	try { feeBps = await (await import('../_lib/pump-platform-fee.js')).effectivePumpFeeBps(); } catch { feeBps = 0; }

	const quotePayload = {
		side, mint: mintStr, network, venue: quote.venue, graduated: quote.graduated,
		slippage_bps: slippageBps,
		in: { asset: quote.inAsset, amount: quote.inAmount ?? quote.inUi ?? null, atomics: quote.inAtomics },
		out: { asset: quote.outAsset, amount: quote.outUi, atomics: quote.outAtomics, decimals: quote.decimals },
		min_received: { amount: quote.minOutUi, atomics: quote.minOutAtomics },
		price_impact_pct: quote.priceImpactPct,
		platform_fee_bps: feeBps,
		usd: usdValue,
		wallet_balance_sol: walletLamports != null ? lamportsToSol(walletLamports) : null,
		guard: guardWarning,
		funds: fundsWarning,
		firewall: quoteFirewall,
	};

	// 3. PREVIEW — return the quote, never touch the key, never send.
	if (preview) {
		return json(res, 200, { data: { preview: true, ...quotePayload } });
	}

	// ── EXECUTE ──────────────────────────────────────────────────────────────
	// Hard-stop on any guard/funds breach before we go near the key.
	if (fundsWarning) {
		return error(res, 402, fundsWarning.code, fundsWarning.message, fundsWarning.detail);
	}
	if (guardWarning) {
		return error(res, guardWarning.status || 403, guardWarning.code, guardWarning.message, guardWarning.detail);
	}

	// Idempotency key — required for execute so a retry can't double-spend.
	const idem = typeof body.idempotency_key === 'string' && body.idempotency_key.trim()
		? body.idempotency_key.trim().slice(0, 128)
		: null;
	if (!idem) return error(res, 400, 'validation_error', 'idempotency_key is required to execute a trade');

	// Fast-path: a finished trade with this key replays its result (never re-sends).
	const [prior] = await sql`
		SELECT status, signature, meta FROM agent_custody_events
		WHERE agent_id = ${id} AND idempotency_key = ${idem} LIMIT 1
	`;
	if (prior) {
		if (prior.status === 'confirmed' && prior.signature) {
			return json(res, 200, {
				data: { replayed: true, signature: prior.signature, explorer: explorerTxUrl(prior.signature, network), ...quotePayload },
			});
		}
		if (prior.status === 'pending') {
			return error(res, 409, 'trade_in_progress', 'a trade with this id is already in flight — check your history before retrying', { signature: prior.signature || null });
		}
		return error(res, 409, 'trade_failed', 'this trade id already failed — retry with a fresh idempotency key');
	}

	// Claim the idempotency slot (also the spend-ledger row). For a buy this counts
	// toward the daily ceiling (usd set); a sell records usd=null so it never
	// inflates the spend total.
	const claim = await sql`
		INSERT INTO agent_custody_events
			(agent_id, user_id, event_type, category, network, asset,
			 amount_lamports, amount_raw, usd, status, idempotency_key, meta)
		VALUES (
			${id}, ${auth.userId}, 'spend', 'trade', ${network},
			${side === 'buy' ? 'SOL' : mintStr},
			${side === 'buy' ? quote.inAtomics : null},
			${side === 'sell' ? quote.inAtomics : null},
			${side === 'buy' ? usdValue ?? null : null},
			'pending', ${idem},
			${JSON.stringify({ side, mint: mintStr, venue: quote.venue, expected_out_atomics: quote.outAtomics, min_out_atomics: quote.minOutAtomics, slippage_bps: slippageBps, price_impact_pct: quote.priceImpactPct })}::jsonb
		)
		ON CONFLICT (agent_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
		RETURNING id
	`;
	if (!claim.length) {
		return error(res, 409, 'trade_in_progress', 'a trade with this id is already in flight — check your history before retrying');
	}
	const claimId = claim[0].id;

	// Recover the signing key (audit-logged) and build the instructions.
	let keypair;
	try {
		keypair = await recoverSolanaAgentKeypair(encryptedSecret, {
			agentId: id, userId: auth.userId, reason: `trade_${side}`,
			meta: { mint: mintStr, network, custody_event_id: claimId, venue: quote.venue },
		});
	} catch (e) {
		await updateCustodyEvent(claimId, { status: 'failed', meta: { error: 'key_recover_failed' } }).catch(() => {});
		console.error('[trade] key recovery failed', e?.message);
		return error(res, 500, 'key_recover_failed', 'could not access the agent wallet key — no funds were moved');
	}

	let instructions;
	try {
		instructions = await buildTradeInstructions({ side, conn: readConn, network, mintPk, ownerPk: keypair.publicKey, quote, slippageBps, solAmount, tokenAmountRaw });
	} catch (e) {
		await updateCustodyEvent(claimId, { status: 'failed', meta: { error: 'build_failed', message: (e?.message || '').slice(0, 200) } }).catch(() => {});
		if (e?.status) return error(res, e.status, e.code, e.message);
		console.error('[trade] build failed', e?.message);
		return error(res, 422, 'build_failed', 'could not build this trade — the market may have moved; try again');
	}

	// Broadcast + confirm through the MEV-aware execution engine: dynamic compute
	// budget (real simulate + real priority-fee estimate) + bounded adaptive retry,
	// with the same ambiguous-confirm re-check the withdraw path uses (never mark a
	// landed tx failed). The discretionary path has no per-strategy tip policy, so it
	// uses the protected single-tx route (tipMode 'off' — no Jito tip).
	const signConn = solanaConnection(network);
	let signature;
	let confirmed = true;
	let execTelemetry = null;
	try {
		const result = await submitProtected({
			network, connection: signConn, payer: keypair, instructions,
			opts: { tipMode: 'off', confirmTimeoutMs: 45_000 },
		});
		signature = result.signature;
		execTelemetry = { route: result.route, priority_fee_microlamports: result.priorityFeeMicroLamports, landed_ms: result.landedMs, attempts: result.attempts };
	} catch (e) {
		if (e?.code === 'TX_ERR') {
			// Landed but reverted on-chain — record the failed signature, don't re-send.
			signature = e.signature || null;
			confirmed = false;
		} else {
			await updateCustodyEvent(claimId, { status: 'failed', meta: { error: 'send_failed', message: (e?.message || '').slice(0, 200) } }).catch(() => {});
			logAudit({ userId: auth.userId, action: 'custody.trade_failed', resourceId: id, meta: { side, mint: mintStr, reason: 'send_failed' }, req });
			return error(res, 502, 'send_failed', 'the trade could not be submitted and no funds were moved — try again');
		}
	}

	if (!confirmed) {
		await updateCustodyEvent(claimId, { signature, meta: { confirm: 'unconfirmed' } }).catch(() => {});
		logAudit({ userId: auth.userId, action: 'custody.trade_unconfirmed', resourceId: id, meta: { side, mint: mintStr, signature }, req });
		return error(res, 202, 'trade_unconfirmed', 'the trade was submitted but not yet confirmed — check the explorer link before retrying', { signature, explorer: explorerTxUrl(signature, network) });
	}

	await updateCustodyEvent(claimId, { status: 'confirmed', signature, usd: side === 'buy' ? usdValue ?? null : null, meta: execTelemetry ? { exec: execTelemetry } : undefined }).catch(() => {});
	logAudit({ userId: auth.userId, action: 'custody.trade', resourceId: id, meta: { side, mint: mintStr, venue: quote.venue, usd: usdValue, signature, network, exec_route: execTelemetry?.route }, req });

	// Mirror into pump_agent_trades for cross-feature analytics when the mint is a
	// three.ws-launched coin (FK requires a pump_agent_mints row). Best-effort.
	indexTrade({ mintStr, network, userId: auth.userId, wallet: address, side, venue: quote.venue, quote, slippageBps, signature }).catch(() => {});

	// Invalidate the cached SOL balance so the hub reflects the trade at once.
	await cacheSet(`sol:bal:${address}:${network}`, null, 1).catch(() => {});

	// Re-read confirmed balances for the response.
	let newSol = null;
	try { newSol = (await signConn.getBalance(keypair.publicKey, 'confirmed')) / LAMPORTS_PER_SOL; } catch { /* best-effort */ }

	return json(res, 200, {
		data: {
			replayed: false, signature, explorer: explorerTxUrl(signature, network),
			...quotePayload,
			filled: { in: quotePayload.in, expected_out: quotePayload.out, min_received: quotePayload.min_received },
			new_balance_sol: newSol,
			execution: execTelemetry,
		},
	});
}

// Build the on-chain instructions for the resolved venue + side. Curve trades use
// the pump-sdk v2 builders; graduated trades use the pump-swap AMM SDK. Mirrors
// api/agents/pumpfun/[action].js so there is one instruction-building convention.
export async function buildTradeInstructions({ side, conn, network, mintPk, ownerPk, quote, slippageBps, solAmount, tokenAmountRaw }) {
	const BNmod = (await import('bn.js')).default;

	if (quote.venue === 'bonding_curve') {
		const { PumpSdk, OnlinePumpSdk, getBuyTokenAmountFromSolAmount, getSellSolAmountFromTokenAmount } =
			await import('@pump-fun/pump-sdk');
		const online = new OnlinePumpSdk(conn);
		const sdk = new PumpSdk();
		const mintInfo = await conn.getAccountInfo(mintPk);
		if (!mintInfo) throw typed(404, 'mint_not_found', 'mint not found on this network');
		const tokenProgram = resolveTokenProgramForMintOwner(mintInfo.owner);

		if (side === 'buy') {
			const [global, feeConfig, state] = await Promise.all([
				online.fetchGlobal(), online.fetchFeeConfig().catch(() => null),
				online.fetchBuyState(mintPk, ownerPk, tokenProgram),
			]);
			const qa = resolveCustodialQuote(state.bondingCurve?.quoteMint, network);
			if (!qa.isSol) throw typed(409, 'unsupported_quote', 'this coin trades against a non-SOL asset — trade it from its coin page instead');
			const quoteAtomics = new BNmod(Math.floor(Number(solAmount) * LAMPORTS_PER_SOL));
			const expected = getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply: state.bondingCurve.tokenTotalSupply, bondingCurve: state.bondingCurve, amount: quoteAtomics });
			if (!expected.gt(new BNmod(0))) throw typed(400, 'amount_too_small', 'that SOL amount is too small to buy any tokens');
			return sdk.buyV2Instructions({
				global, bondingCurveAccountInfo: state.bondingCurveAccountInfo, bondingCurve: state.bondingCurve,
				associatedUserAccountInfo: state.associatedUserAccountInfo, mint: mintPk, user: ownerPk,
				amount: expected, quoteAmount: quoteAtomics, slippage: slippagePercentFromBps(slippageBps), tokenProgram,
			});
		}
		// curve sell
		const [global, feeConfig, state] = await Promise.all([
			online.fetchGlobal(), online.fetchFeeConfig().catch(() => null),
			online.fetchSellState(mintPk, ownerPk, tokenProgram),
		]);
		const qa = resolveCustodialQuote(state.bondingCurve?.quoteMint, network);
		if (!qa.isSol) throw typed(409, 'unsupported_quote', 'this coin trades against a non-SOL asset — trade it from its coin page instead');
		const tokens = new BNmod(tokenAmountRaw);
		const expectedQuote = getSellSolAmountFromTokenAmount({ global, feeConfig, mintSupply: state.bondingCurve.tokenTotalSupply, bondingCurve: state.bondingCurve, amount: tokens });
		return sdk.sellV2Instructions({
			global, bondingCurveAccountInfo: state.bondingCurveAccountInfo, bondingCurve: state.bondingCurve,
			mint: mintPk, user: ownerPk, amount: tokens, quoteAmount: expectedQuote,
			slippage: slippagePercentFromBps(slippageBps), tokenProgram,
		});
	}

	// AMM (graduated).
	const { PumpAmmSdk, OnlinePumpAmmSdk, canonicalPumpPoolPda } = await import('@pump-fun/pump-swap-sdk');
	const amm = new PumpAmmSdk();
	const online = new OnlinePumpAmmSdk(conn);
	const poolKey = canonicalPumpPoolPda(mintPk);
	const swapState = await online.swapSolanaState(poolKey, ownerPk).catch(() => online.swapSolanaStateNoPool(poolKey, ownerPk));
	const slippage = slippagePercentFromBps(slippageBps);
	if (side === 'buy') {
		return amm.buyQuoteInput(swapState, new BNmod(BigInt(quote.inAtomics).toString()), slippage);
	}
	return amm.sellBaseInput(swapState, new BNmod(tokenAmountRaw), slippage);
}

// Best-effort analytics mirror into pump_agent_trades (FK → pump_agent_mints, so
// only three.ws-launched coins land here; discretionary trades on any other coin
// are still fully captured by the custody ledger).
async function indexTrade({ mintStr, network, userId, wallet, side, venue, quote, slippageBps, signature }) {
	const [m] = await sql`SELECT id FROM pump_agent_mints WHERE mint = ${mintStr} AND network = ${network} LIMIT 1`;
	if (!m) return;
	const solAmount = side === 'buy' ? quote.inAtomics : quote.outAtomics; // lamports
	const tokenAmount = side === 'buy' ? quote.outAtomics : quote.inAtomics; // base units
	await sql`
		INSERT INTO pump_agent_trades
			(mint_id, user_id, wallet, direction, route, sol_amount, token_amount, slippage_bps, tx_signature, network,
			 quote_mint, quote_symbol, quote_amount)
		VALUES
			(${m.id}, ${userId}, ${wallet}, ${side}, ${venue === 'amm' ? 'amm' : 'bonding_curve'},
			 ${solAmount}, ${tokenAmount}, ${slippageBps}, ${signature}, ${network},
			 ${WSOL_MINT}, 'SOL', ${solAmount})
		ON CONFLICT (tx_signature, network) DO NOTHING
	`;
}

// ── unified trade history ───────────────────────────────────────────────────────
// GET /api/agents/:id/solana/trade-history?network=&limit=
// Owner-authenticated. Merges discretionary trades (the custody ledger) with the
// sniper's closed positions into one reverse-chronological feed so the wallet hub
// shows every trade an agent has ever made, by whatever path.
export async function handleTradeHistory(req, res, id) {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const owned = await loadOwnedWallet(req, res, id);
	if (owned.error) return;
	const { auth } = owned;

	const rl = await limits.walletRead(auth.userId);
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, 'http://x');
	const network = netOf(url.searchParams.get('network'));
	const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') || '40', 10) || 40));

	// Discretionary trades from the custody ledger.
	const ledger = await sql`
		SELECT id, asset, amount_lamports, amount_raw, usd, signature, status, reason, created_at, meta
		FROM agent_custody_events
		WHERE agent_id = ${id} AND network = ${network} AND category = 'trade'
		ORDER BY id DESC
		LIMIT ${limit}
	`;
	const discretionary = ledger.map((e) => {
		const side = e.meta?.side || (e.asset === 'SOL' ? 'buy' : 'sell');
		return {
			source: 'trade',
			id: `t_${e.id}`,
			side,
			mint: e.meta?.mint || null,
			venue: e.meta?.venue || null,
			sol_amount: e.amount_lamports != null ? lamportsToSol(e.amount_lamports) : null,
			token_amount_raw: e.amount_raw != null ? String(e.amount_raw) : null,
			price_impact_pct: e.meta?.price_impact_pct ?? null,
			usd: e.usd != null ? Number(e.usd) : null,
			status: e.status,
			signature: e.signature,
			explorer: e.signature ? explorerTxUrl(e.signature, network) : null,
			at: e.created_at,
		};
	});

	// Sniper closed positions (best-effort — table may be absent on minimal DBs).
	let sniper = [];
	try {
		const rows = await sql`
			SELECT id, mint, symbol, name, exit_reason, entry_quote_lamports, exit_quote_lamports,
			       realized_pnl_lamports, realized_pnl_pct, buy_sig, sell_sig, opened_at, closed_at
			FROM agent_sniper_positions
			WHERE agent_id = ${id} AND network = ${network} AND status = 'closed'
			ORDER BY closed_at DESC
			LIMIT ${limit}
		`;
		sniper = rows.map((r) => ({
			source: 'sniper',
			id: `s_${r.id}`,
			side: 'round_trip',
			mint: r.mint,
			symbol: r.symbol || r.name || null,
			exit_reason: r.exit_reason,
			entry_sol: r.entry_quote_lamports != null ? lamportsToSol(r.entry_quote_lamports) : null,
			exit_sol: r.exit_quote_lamports != null ? lamportsToSol(r.exit_quote_lamports) : null,
			pnl_sol: r.realized_pnl_lamports != null ? lamportsToSol(r.realized_pnl_lamports) : null,
			pnl_pct: r.realized_pnl_pct != null ? Number(r.realized_pnl_pct) : null,
			buy_url: r.buy_sig && r.buy_sig !== 'SIMULATED' ? explorerTxUrl(r.buy_sig, network) : null,
			sell_url: r.sell_sig && r.sell_sig !== 'SIMULATED' ? explorerTxUrl(r.sell_sig, network) : null,
			status: 'closed',
			at: r.closed_at,
		}));
	} catch { sniper = []; }

	const items = [...discretionary, ...sniper]
		.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
		.slice(0, limit);

	return json(res, 200, { data: { items, network, total: items.length } });
}
