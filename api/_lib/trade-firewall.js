// Rug/Honeypot Simulation Firewall — the shared pre-trade safety kernel.
//
// Every buy path on the platform (the autonomous sniper worker, both
// discretionary server-signed endpoints, and the public read-only API) calls
// `assessTradeSafety` BEFORE broadcasting. The differentiator over a heuristic
// "risk badge" is that this runs a REAL on-chain simulated buy→sell round-trip
// (connection.simulateTransaction, sigVerify:false) plus a live SPL authority
// audit — so a coin that can be bought but not sold (a honeypot) is BLOCKED, not
// merely flagged. The verdict is structured, scored 0..100, and every check
// carries a plain-language reason the UI renders verbatim.
//
// Honest degradation is the rule: a check whose data source is unavailable
// (RPC outage after failover, intel not yet computed) NEVER fabricates an
// `allow`. It degrades to `warn` with an explicit reason. No check throws past
// the boundary — `assessTradeSafety` always resolves to a verdict.
//
// $THREE is the only coin three.ws promotes. This kernel is coin-agnostic trade
// plumbing: it assesses whatever runtime mint a buy path hands it and never
// names, hardcodes, or recommends any token.

import { PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { unpackMint, NATIVE_MINT } from '@solana/spl-token';
import { sql } from './db.js';
import { getPumpTradeClient, getAmmPoolState, getConnection } from './pump.js';
import { checkPriceImpact } from './agent-trade-guards.js';
import { getSmartMoneyForMint } from './smart-money.js';

const WSOL_MINT = NATIVE_MINT.toBase58();

// Per-mint micro-cache for the cheap authority + curve reads only. The hot snipe
// path can hit the same fresh mint many times in a burst; an authority/curve
// snapshot is stable on the seconds timescale, so a brief cache shaves real RPC
// latency off block-0 without ever caching a stale verdict (the round-trip
// simulation is never cached — it re-runs against live reserves every call).
const MINT_CACHE_TTL_MS = 8_000;
const _mintCache = new Map(); // mint:network → { at, mintAccount, curve }

// ── scoring weights ───────────────────────────────────────────────────────────
// Each check contributes a penalty to a 0..100 score (100 = perfectly clean).
// A single fatal failure (sell leg dead, no venue) forces a `block` regardless of
// the residual score, so the score is a severity gradient, not the sole gate.
const PENALTY = Object.freeze({
	mint_authority_active: 22, // infinite-supply risk (dev can mint more)
	freeze_authority_active: 28, // dev can freeze your tokens — you can't sell
	sim_unavailable: 18, // couldn't prove the round-trip (degraded)
	buy_leg_reverted: 10, // the sim's BUY leg failed (balance/slippage): not a honeypot shape
	concentration: 16, // one wallet holds an outsized share
	dev_dumped: 14, // dev sold inside the observation window
	bundle: 12, // coordinated-launch likelihood
	price_impact: 10, // this size moves the market a lot
	sybil_cluster: 14, // buyers dominated by one funder cluster (manufactured demand)
});

const BLOCK_SCORE = 45; // at/under this composite → block on warnings alone
const WARN_SCORE = 70; // at/under this → warn

// Reasons that are too dangerous to buy through on a `warn` verdict. The composite
// score keeps these as `warn` (so a hiccup never halts a whole fleet), but for a
// caller that opted into fail-closed enforcement they are hard blocks: we did NOT
// prove the coin is safe. `criticalFirewallReason` lets such a caller (the sniper
// at firewall_level='block') refuse the buy instead of proceeding on a warn — the
// exact hole that was buying honeypots and infinite-mint rugs.
//   simulation_unavailable → the buy→sell round-trip couldn't run: sellability unproven
//   mint_authority_active  → dev can mint unlimited supply and dilute you to zero
//   freeze_authority_active→ dev can freeze your token so you can never sell
//   authority_read_failed  → couldn't read the mint's authorities at all
//   mint_not_found         → the mint account isn't there to vet
export const CRITICAL_FIREWALL_REASONS = Object.freeze(new Set([
	'simulation_unavailable',
	'mint_authority_active',
	'freeze_authority_active',
	'authority_read_failed',
	'mint_not_found',
]));

/**
 * First critical (unproven-safety) reason in an assessment, or null when none.
 * Pure — safe to unit-test. Used by fail-closed callers to block a `warn` verdict
 * whose warnings mean "couldn't verify", not "verified safe".
 * @param {{ checks?: Array<{status?:string, reason?:string}> }} assessment
 * @returns {string|null}
 */
export function criticalFirewallReason(assessment) {
	if (!assessment) return null;
	for (const c of assessment.checks || []) {
		if (c && c.status !== 'pass' && CRITICAL_FIREWALL_REASONS.has(c.reason)) return c.reason;
	}
	return null;
}

function clampScore(n) {
	return Math.max(0, Math.min(100, Math.round(n)));
}

function toPubkey(v) {
	return v instanceof PublicKey ? v : new PublicKey(v);
}

// A typed sub-result every named check returns. `status` drives the UI dot.
function result(name, status, reason, detail = {}) {
	return { name, status, reason, detail }; // status: 'pass' | 'warn' | 'fail' | 'skip'
}

// ── check 1: SPL mint authority audit ─────────────────────────────────────────
// A non-null mintAuthority means the creator can mint unlimited new supply and
// dilute holders to zero. A set freezeAuthority means the creator can freeze your
// token account so you can never sell — the cleanest honeypot primitive. Both are
// read directly off the SPL mint account, the authoritative on-chain source.
async function checkMintAuthority(connection, mintPk, cacheKey) {
	try {
		let mintAccount = readCache(cacheKey)?.mintAccount;
		if (mintAccount === undefined) {
			const info = await connection.getAccountInfo(mintPk, 'confirmed');
			if (!info) return result('mint_authority', 'warn', 'mint_not_found', {});
			mintAccount = unpackMint(mintPk, info, info.owner);
			writeCache(cacheKey, { mintAccount });
		}
		const mintActive = mintAccount.mintAuthority != null;
		const freezeActive = mintAccount.freezeAuthority != null;
		const detail = {
			mint_authority: mintAccount.mintAuthority ? mintAccount.mintAuthority.toBase58() : null,
			freeze_authority: mintAccount.freezeAuthority ? mintAccount.freezeAuthority.toBase58() : null,
		};
		if (freezeActive) {
			return result('mint_authority', 'fail', 'freeze_authority_active', detail);
		}
		if (mintActive) {
			return result('mint_authority', 'warn', 'mint_authority_active', detail);
		}
		return result('mint_authority', 'pass', 'authorities_renounced', detail);
	} catch (err) {
		return result('mint_authority', 'warn', 'authority_read_failed', { message: short(err) });
	}
}

// ── check 2: tradable venue + reserves ────────────────────────────────────────
// Pre-graduation: read the bonding-curve account — it must exist, not be marked
// `complete` mid-flight, and hold real virtual reserves. Post-graduation: resolve
// the canonical AMM pool and confirm non-trivial liquidity. No venue → BLOCK:
// there is nothing to sell back into.
async function checkVenue(network, mintPk, cacheKey) {
	try {
		const { getPumpSdkV2 } = await import('./pump.js');
		const v2 = await getPumpSdkV2({ network });
		const { onlineSdk } = v2;
		let curve = readCache(cacheKey)?.curve;
		if (curve === undefined) {
			try {
				curve = await onlineSdk.fetchBondingCurve(mintPk);
			} catch {
				curve = null;
			}
			writeCache(cacheKey, { curve });
		}

		if (curve && !curve.complete) {
			const vTok = bigOf(curve.virtualTokenReserves);
			const vQuote = bigOf(curve.virtualQuoteReserves);
			if (vTok <= 0n || vQuote <= 0n) {
				return result('venue', 'fail', 'curve_reserves_empty', {
					virtual_token_reserves: vTok.toString(),
					virtual_quote_reserves: vQuote.toString(),
				});
			}
			return result('venue', 'pass', 'live_bonding_curve', {
				stage: 'bonding_curve',
				virtual_quote_reserves: vQuote.toString(),
			});
		}

		// Graduated (or no curve): the coin must trade on the canonical AMM pool.
		try {
			const amm = await getAmmPoolState({ network, mint: mintPk });
			const baseRes = bigOf(amm.baseReserve);
			// Liquidity is judged on EFFECTIVE quote reserves (vault + virtual):
			// a boost pool can hold real quote-side depth in its virtual
			// reserves, and gating on the raw vault alone would fail a tradable
			// pool as `pool_reserves_empty`. The virtual leg is an i128 and can
			// be negative, so the `<= 0n` check below is also what correctly
			// rejects a pool whose effective depth has gone non-positive.
			const quoteRes = bigOf(amm.effectiveQuoteReserve);
			if (baseRes <= 0n || quoteRes <= 0n) {
				return result('venue', 'fail', 'pool_reserves_empty', {
					base_reserve: baseRes.toString(),
					quote_reserve: quoteRes.toString(),
				});
			}
			return result('venue', 'pass', 'live_amm_pool', {
				stage: 'amm',
				quote_reserve: quoteRes.toString(),
			});
		} catch (poolErr) {
			if (poolErr?.code === 'pool_not_found') {
				return result('venue', 'fail', 'no_tradable_venue', {});
			}
			return result('venue', 'warn', 'venue_read_failed', { message: short(poolErr) });
		}
	} catch (err) {
		return result('venue', 'warn', 'venue_read_failed', { message: short(err) });
	}
}

/**
 * Classify a reverted round-trip simulation by WHICH leg failed. The honeypot
 * shape is "you can buy but you cannot sell": only a SELL-leg failure has it,
 * and only it stays a fatal `roundtrip_reverted`. A BUY-leg revert says nothing
 * about sellability. On the pump.fun curve the sell path is the curve program
 * itself, so buy-leg reverts were pure false positives: most commonly the probe
 * payer not affording the simulated buy (system program error 0x1,
 * "insufficient lamports"), else the curve moving past the quote's slippage
 * mid-launch. Both would fail the real entry too, but neither is a trapped
 * exit. Pure — safe to unit-test.
 * @param {object|string} simErr `simulateTransaction().value.err`
 * @param {string[]} logs simulation logs
 * @param {number} buyIxCount instructions in the buy leg (sell ixs follow them)
 * @returns {{ leg:'buy'|'sell', status:'warn'|'fail', reason:string, err:string }}
 */
export function classifyRoundTripRevert(simErr, logs, buyIxCount) {
	const err = typeof simErr === 'object' ? JSON.stringify(simErr).slice(0, 200) : String(simErr);
	const ixIndex = Array.isArray(simErr?.InstructionError) ? Number(simErr.InstructionError[0]) : null;
	if (ixIndex != null && Number.isFinite(ixIndex) && ixIndex < buyIxCount) {
		const underfunded = (logs || []).some((l) => /insufficient lamports/i.test(String(l)));
		return { leg: 'buy', status: 'warn', reason: underfunded ? 'buy_leg_underfunded' : 'buy_leg_reverted', err };
	}
	// A funding failure is not always attributable to an instruction index: a payer
	// whose account does not exist, or cannot cover the fee, fails the whole message
	// (`AccountNotFound`, `InsufficientFundsForFee`, `InsufficientFundsForRent`) with
	// no `InstructionError` to read a leg off. That is the poorest possible wallet,
	// not the most dangerous possible coin, and reading it as a trapped exit is what
	// labelled a fleet's worth of ordinary bonding-curve launches "honeypot".
	if (FUNDING_SHAPED_ERR.test(err) || (logs || []).some((l) => FUNDING_SHAPED_ERR.test(String(l)))) {
		return { leg: 'buy', status: 'warn', reason: 'buy_leg_underfunded', err };
	}
	// Sell leg, or a genuinely unattributable failure: keep the fail-closed reading.
	return { leg: 'sell', status: 'fail', reason: 'roundtrip_reverted', err };
}

// ── check 3: simulated buy→sell round-trip (the honeypot detector) ────────────
// Build a real buy of `quoteAmount`, then a real sell of the tokens that buy
// would yield, pack BOTH legs into one v0 message, and simulate it on real RPC
// with sigVerify:false + replaceRecentBlockhash:true. If the simulation errors on
// the SELL leg — or the sell would return ~0 SOL — the coin cannot be exited: a
// honeypot. BLOCK. Only runs pre-graduation (the bonding-curve buy/sell builders);
// graduated coins are covered by the venue + authority checks (their AMM sell
// builders need full swap state we don't assemble on the hot path).
async function checkRoundTrip({ network, mintPk, payer, quoteAmount, connection }) {
	if (!payer) {
		return { res: result('round_trip', 'skip', 'no_payer_for_simulation', {}), simulated: false };
	}
	let payerPk;
	try {
		payerPk = toPubkey(payer);
	} catch {
		return { res: result('round_trip', 'skip', 'invalid_payer', {}), simulated: false };
	}

	let client;
	try {
		({ client } = await getPumpTradeClient({ network }));
	} catch (err) {
		return { res: result('round_trip', 'warn', 'simulation_unavailable', { message: short(err) }), simulated: false };
	}

	const BNmod = (await import('bn.js')).default;
	const quoteBn = new BNmod(BigInt(quoteAmount).toString());

	// Build the buy. A graduated/zero-out/curve-not-found error here is not a
	// honeypot signal — it means this simulation path doesn't apply, so skip
	// (the venue check already owns "is there a market").
	let buyBuilt;
	try {
		buyBuilt = await client.buildBuyInstructions({ mint: mintPk, user: payerPk, quoteAmount: quoteBn, slippagePct: 15 });
	} catch (err) {
		const code = err?.name || err?.code || '';
		if (code === 'CoinGraduatedError' || code === 'CoinNotFoundError') {
			return { res: result('round_trip', 'skip', 'simulation_not_applicable', { reason: code }), simulated: false };
		}
		if (code === 'InsufficientLiquidityError') {
			return { res: result('round_trip', 'fail', 'buy_yields_nothing', {}), simulated: false };
		}
		return { res: result('round_trip', 'warn', 'simulation_unavailable', { message: short(err) }), simulated: false };
	}

	const baseOut = bigOf(buyBuilt.expectedBaseTokens);
	if (baseOut <= 0n) {
		return { res: result('round_trip', 'fail', 'buy_yields_nothing', {}), simulated: false };
	}

	// Build the matching sell of exactly what the buy yields. A wide slippage on
	// the sim's sell leg keeps the min-out floor from tripping for a reason other
	// than a true honeypot — we want to learn whether the sell *executes at all*.
	let sellBuilt;
	try {
		sellBuilt = await client.buildSellInstructions({ mint: mintPk, user: payerPk, baseAmount: new BNmod(baseOut.toString()), slippagePct: 99 });
	} catch (err) {
		return { res: result('round_trip', 'warn', 'simulation_unavailable', { message: short(err) }), simulated: false };
	}

	const expectedSolBack = bigOf(sellBuilt.expectedQuoteOut);

	// Pack both legs into one message and simulate against real RPC.
	let sim;
	try {
		const bh = await connection.getLatestBlockhash('confirmed').catch(() => null);
		const message = new TransactionMessage({
			payerKey: payerPk,
			recentBlockhash: bh?.blockhash || '11111111111111111111111111111111',
			instructions: [...buyBuilt.instructions, ...sellBuilt.instructions],
		}).compileToV0Message();
		const vtx = new VersionedTransaction(message);
		sim = await connection.simulateTransaction(vtx, {
			sigVerify: false,
			replaceRecentBlockhash: true,
			commitment: 'confirmed',
		});
	} catch (err) {
		return { res: result('round_trip', 'warn', 'simulation_unavailable', { message: short(err) }), simulated: false };
	}

	const simErr = sim?.value?.err ?? null;
	const logs = Array.isArray(sim?.value?.logs) ? sim.value.logs : [];
	const unitsConsumed = sim?.value?.unitsConsumed ?? null;

	if (simErr) {
		const verdict = classifyRoundTripRevert(simErr, logs, buyBuilt.instructions.length);
		return {
			res: result('round_trip', verdict.status, verdict.reason, {
				leg: verdict.leg,
				err: verdict.err,
				log_tail: logs.slice(-4),
				units_consumed: unitsConsumed,
			}),
			simulated: true,
		};
	}

	if (expectedSolBack <= 0n) {
		return {
			res: result('round_trip', 'fail', 'sell_returns_nothing', { expected_sol_back: '0' }),
			simulated: true,
		};
	}

	return {
		res: result('round_trip', 'pass', 'roundtrip_simulated_ok', {
			expected_sol_back: expectedSolBack.toString(),
			expected_base_tokens: baseOut.toString(),
			units_consumed: unitsConsumed,
		}),
		simulated: true,
	};
}

// ── check 4: concentration / bundle / dev-dump (reuse computed intel) ─────────
// Reuse the Coin Intelligence Engine's already-computed structural signals
// instead of recomputing them. Missing intel (a brand-new mint observed for <90s)
// is a `skip`, not a fail — the round-trip + authority checks still gate it.
async function checkIntel(mint, network) {
	let row;
	try {
		const rows = await sql`
			SELECT bundle_score, concentration_top10, dev_sold, risk_flags, signals
			FROM pump_coin_intel
			WHERE mint = ${mint} AND network = ${network}
			LIMIT 1
		`;
		row = rows[0];
	} catch {
		return result('concentration', 'skip', 'intel_unavailable', {});
	}
	if (!row) return result('concentration', 'skip', 'no_intel_yet', {});

	const signals = row.signals && typeof row.signals === 'object' ? row.signals : {};
	const top1 = numOr(signals.concentration_top1);
	const top10 = numOr(row.concentration_top10);
	const bundle = numOr(row.bundle_score);
	const devDumped = row.dev_sold === true;
	const detail = {
		concentration_top1: top1,
		concentration_top10: top10,
		bundle_score: bundle,
		dev_dumped: devDumped,
		risk_flags: Array.isArray(row.risk_flags) ? row.risk_flags : [],
	};

	const fails = [];
	if (top1 != null && top1 >= 0.35) fails.push('concentration');
	if (devDumped) fails.push('dev_dumped');
	if (bundle != null && bundle >= 0.75) fails.push('bundle');

	if (fails.length) {
		return result('concentration', 'warn', fails.join('+'), detail);
	}
	return result('concentration', 'pass', 'structure_clean', detail);
}

// ── check 5: price-impact ceiling (shared guard math) ─────────────────────────
// Reuse the exact `checkPriceImpact` predicate the spend guards use so this
// firewall and the spend ceiling agree on what "too much impact" means. A null
// impact (couldn't compute) is a skip, not a warn.
function checkImpact(priceImpactPct) {
	if (priceImpactPct == null || !Number.isFinite(Number(priceImpactPct))) {
		return result('price_impact', 'skip', 'impact_unknown', {});
	}
	const breach = checkPriceImpact(Number(priceImpactPct), 20);
	if (breach) {
		return result('price_impact', 'warn', 'high_price_impact', { impact_pct: Number(priceImpactPct), max_pct: 20 });
	}
	return result('price_impact', 'pass', 'impact_ok', { impact_pct: Number(priceImpactPct) });
}

// ── check 5: smart-money sybil dominance (task 03 graph) ──────────────────────
// The buyers "in" this coin are scored against the wallet-reputation graph: when
// the net-buy flow is dominated by a single shared-funder cluster, the demand is
// likely manufactured (one entity across many wallets), so WARN. Pure additive
// signal — if the graph has no data or the DB is unreachable, this degrades to a
// silent skip and never blocks the trade.
async function checkSybil(mint, network) {
	try {
		const sm = await getSmartMoneyForMint(mint, network);
		if (!sm || sm.sybil_flag !== true) {
			return result('smart_money', sm && sm.count > 0 ? 'pass' : 'skip',
				sm && sm.count > 0 ? 'smart_money_clean' : 'no_smart_money_data',
				{ count: sm?.count ?? 0, smart_money_score: sm?.smart_money_score ?? null });
		}
		return result('smart_money', 'warn', 'sybil_cluster_dominant', {
			count: sm.count ?? 0,
			smart_money_score: sm.smart_money_score ?? null,
			dominant_cluster: sm.dominant_cluster ?? null,
		});
	} catch {
		return result('smart_money', 'skip', 'smart_money_unavailable', {});
	}
}

// ── verdict composition ───────────────────────────────────────────────────────
function compose(checks, simulated) {
	let score = 100;
	const reasons = [];
	let fatal = false;

	for (const c of checks) {
		if (c.status === 'pass' || c.status === 'skip') continue;

		switch (c.reason) {
			case 'freeze_authority_active':
				score -= PENALTY.freeze_authority_active;
				reasons.push('The creator can freeze your tokens — you may be unable to sell.');
				fatal = true;
				break;
			case 'mint_authority_active':
				score -= PENALTY.mint_authority_active;
				reasons.push('The mint authority is still active — supply can be inflated, diluting holders.');
				break;
			case 'roundtrip_reverted':
				score -= 60;
				reasons.push('A simulated buy→sell round-trip reverted on-chain — this behaves like a honeypot you cannot exit.');
				fatal = true;
				break;
			case 'sell_returns_nothing':
			case 'buy_yields_nothing':
				score -= 60;
				reasons.push('The simulated sell leg returns nothing — there is no working exit for this coin.');
				fatal = true;
				break;
			case 'no_tradable_venue':
			case 'curve_reserves_empty':
			case 'pool_reserves_empty':
				score -= 50;
				reasons.push('No tradable market with real liquidity was found — there is nowhere to sell back into.');
				fatal = true;
				break;
			case 'simulation_unavailable':
				score -= PENALTY.sim_unavailable;
				reasons.push('The round-trip simulation could not run (RPC unavailable) — safety could not be fully verified.');
				break;
			case 'buy_leg_underfunded':
				score -= PENALTY.buy_leg_reverted;
				reasons.push('The simulated buy leg could not be funded at this size, so the sell leg went unproven; this is a wallet-balance condition, not a honeypot signal.');
				break;
			case 'buy_leg_reverted':
				score -= PENALTY.buy_leg_reverted;
				reasons.push('The simulated buy leg reverted (the market likely moved past the quoted slippage), so the sell leg went unproven; the entry itself may fail at execution.');
				break;
			case 'high_price_impact':
				score -= PENALTY.price_impact;
				reasons.push(`Price impact is high (${Number(c.detail.impact_pct).toFixed(1)}%) — you may receive far less than market.`);
				break;
			case 'sybil_cluster_dominant':
				score -= PENALTY.sybil_cluster;
				reasons.push('Buying is dominated by one funder cluster — the demand looks manufactured by a single entity, not organic.');
				break;
			case 'venue_read_failed':
			case 'authority_read_failed':
			case 'mint_not_found':
				score -= PENALTY.sim_unavailable;
				reasons.push('Some on-chain data could not be read — safety could not be fully verified.');
				break;
			default: {
				// Composite intel reason like "concentration+dev_dumped+bundle".
				const parts = String(c.reason).split('+');
				if (parts.includes('concentration')) {
					score -= PENALTY.concentration;
					reasons.push('Holdings are highly concentrated in one wallet — a single seller can crater the price.');
				}
				if (parts.includes('dev_dumped')) {
					score -= PENALTY.dev_dumped;
					reasons.push('The creator already sold during the launch window — a classic exit signal.');
				}
				if (parts.includes('bundle')) {
					score -= PENALTY.bundle;
					reasons.push('The launch shows coordinated-bundle behavior — buys may be manufactured, not organic.');
				}
				break;
			}
		}
	}

	score = clampScore(score);

	let verdict;
	if (fatal || score <= BLOCK_SCORE) verdict = 'block';
	else if (score <= WARN_SCORE || reasons.length > 0) verdict = 'warn';
	else verdict = 'allow';

	if (verdict === 'allow' && !reasons.length) {
		reasons.push(simulated
			? 'Authorities are renounced and a simulated round-trip confirmed you can sell back out.'
			: 'On-chain authority and venue checks passed.');
	}

	return { verdict, score, reasons };
}

/**
 * The shared pre-trade safety kernel. Runs every check concurrently against real
 * on-chain state and composes a structured verdict. NEVER throws — a data-source
 * outage degrades the affected check to `warn` with a reason, never a fake allow.
 *
 * @param {object} o
 * @param {'mainnet'|'devnet'} [o.network='mainnet']
 * @param {string|PublicKey} o.mint              the coin being assessed (runtime input)
 * @param {'buy'} [o.side='buy']                 firewall guards buys (the risky direction)
 * @param {string|PublicKey} [o.payer]           wallet the round-trip is simulated against
 * @param {bigint|number|string} o.quoteAmount   lamports the buy would spend
 * @param {import('@solana/web3.js').Connection} [o.connection]  injected RPC (else resolved)
 * @param {number} [o.priceImpactPct]            pre-computed buy impact, if the caller has it
 * @returns {Promise<{ verdict:'allow'|'warn'|'block', score:number, checks:Array, simulated:boolean, reasons:string[] }>}
 */
export async function assessTradeSafety({
	network = 'mainnet',
	mint,
	side = 'buy',
	payer = null,
	quoteAmount,
	connection = null,
	priceImpactPct = null,
} = {}) {
	const net = network === 'devnet' ? 'devnet' : 'mainnet';

	let mintPk;
	try {
		mintPk = toPubkey(mint);
	} catch {
		return {
			verdict: 'block',
			score: 0,
			simulated: false,
			reasons: ['The coin address is not a valid Solana mint.'],
			checks: [result('input', 'fail', 'invalid_mint', {})],
		};
	}
	if (mintPk.toBase58() === WSOL_MINT) {
		return {
			verdict: 'block',
			score: 0,
			simulated: false,
			reasons: ['Wrapped SOL is not a tradable coin.'],
			checks: [result('input', 'fail', 'wsol_not_a_coin', {})],
		};
	}

	const lamports = (() => {
		try { return BigInt(quoteAmount ?? 0n); } catch { return 0n; }
	})();

	const conn = connection || getConnection({ network: net });
	const cacheKey = `${mintPk.toBase58()}:${net}`;

	// Run the independent checks concurrently — the kernel adds a few hundred ms,
	// not seconds, even on the hot snipe path.
	const [authorityRes, venueRes, roundTrip, intelRes, sybilRes] = await Promise.all([
		checkMintAuthority(conn, mintPk, cacheKey),
		checkVenue(net, mintPk, cacheKey),
		lamports > 0n
			? checkRoundTrip({ network: net, mintPk, payer, quoteAmount: lamports, connection: conn })
			: Promise.resolve({ res: result('round_trip', 'skip', 'no_quote_amount', {}), simulated: false }),
		checkIntel(mintPk.toBase58(), net),
		checkSybil(mintPk.toBase58(), net),
	]);

	const impactRes = checkImpact(priceImpactPct);

	const checks = [authorityRes, venueRes, roundTrip.res, intelRes, impactRes, sybilRes];
	const { verdict, score, reasons } = compose(checks, roundTrip.simulated);

	return { verdict, score, simulated: roundTrip.simulated, reasons, checks };
}

/**
 * Persist a firewall verdict to the audit trail. Fire-and-forget safe: callers in
 * a hot path should `.catch()`. Returns the new row id (or null on failure).
 */
export async function recordFirewallDecision({
	mint, network = 'mainnet', side = 'buy', verdict, score, simulated = false,
	checks = [], reasons = [], source = null, agentId = null, userId = null,
	quoteLamports = null, enforced = true,
}) {
	try {
		const [row] = await sql`
			INSERT INTO firewall_decisions
				(mint, network, side, verdict, score, simulated, checks, reasons,
				 source, agent_id, user_id, quote_lamports, enforced)
			VALUES (
				${mint}, ${network}, ${side}, ${verdict}, ${Math.round(score) || 0}, ${!!simulated},
				${JSON.stringify(checks ?? [])}::jsonb, ${reasons ?? []},
				${source}, ${agentId}, ${userId},
				${quoteLamports != null ? String(quoteLamports) : null}, ${!!enforced}
			)
			RETURNING id
		`;
		return row?.id ?? null;
	} catch (err) {
		console.warn('[trade-firewall] decision record failed', err?.message);
		return null;
	}
}

/**
 * Map a `block` verdict onto the platform's structured guard-response shape so the
 * discretionary endpoints can return it with the same envelope as a spend-limit
 * breach. Status 422 (unprocessable) — the request was well-formed but the trade
 * is refused on safety grounds.
 */
export function firewallGuardResponse(assessment) {
	const reason = assessment.reasons?.[0] || 'This trade was blocked by the safety firewall.';
	return {
		status: 422,
		code: 'firewall_blocked',
		message: reason,
		detail: {
			verdict: assessment.verdict,
			score: assessment.score,
			simulated: assessment.simulated,
			reasons: assessment.reasons,
			checks: assessment.checks,
		},
	};
}

// ── tiny internal helpers ─────────────────────────────────────────────────────
function readCache(key) {
	const e = _mintCache.get(key);
	if (!e) return undefined;
	if (Date.now() - e.at > MINT_CACHE_TTL_MS) {
		_mintCache.delete(key);
		return undefined;
	}
	return e;
}
function writeCache(key, patch) {
	const prev = _mintCache.get(key);
	const fresh = prev && Date.now() - prev.at <= MINT_CACHE_TTL_MS ? prev : { at: Date.now() };
	_mintCache.set(key, { ...fresh, ...patch, at: fresh.at });
}
function bigOf(v) {
	try {
		if (v == null) return 0n;
		if (typeof v === 'bigint') return v;
		return BigInt(v.toString());
	} catch {
		return 0n;
	}
}
function numOr(v, d = null) {
	if (v == null || v === '') return d;
	const n = Number(v);
	return Number.isFinite(n) ? n : d;
}
function short(err) {
	return String(err?.message || err || 'error').slice(0, 160);
}
