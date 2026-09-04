// agent-sniper — the only module that signs and broadcasts.
//
// executeBuy / executeSell own every guardrail, the idempotency lock, the trade
// build, the broadcast, and the agent_sniper_positions writes. In `simulate`
// mode the full path runs against REAL on-chain quotes but the broadcast is
// skipped (sig = 'SIMULATED') — an ops safety toggle, never the default.

import { sql } from '../../api/_lib/db.js';
import { log } from './log.js';
import { loadAgentKeypair } from './keys.js';
import { mayhemGate } from './mayhem-gate.js';
import { reviewBuy, resolveRiskOfficerLevel } from './risk-officer.js';
import { marketCapBandReason } from './scorer.js';
import { recordJournal, journalEntry } from './journal.js';
import { getTradeCtx, signAndSend, submitProtectedTrade } from './trade-client.js';
import { countOpenPositions, getDailySpend, getRealizedNetLamports, effectiveDailyLossLimitLamports } from './strategy-store.js';
import { notifyBuy, notifySell } from '../../api/_lib/sniper/notify.js';
import { getPolicyRules } from '../../api/_lib/spend-policy-rules.js';
import {
	getSpendLimits, enforceSpendLimit, SpendLimitError, recordSpend, lamportsToUsd,
	checkConcurrency, checkDailyBudgetLamports, checkPriceImpact,
	checkDailyLoss, recordCustodyEvent, resolveEntrySize,
} from '../../api/_lib/agent-trade-guards.js';
import { shouldGiveUpReconcile, reconcileParkAnchor } from './exit-logic.js';
import { buildAmmSellInstructions, quoteAmmBuy, buildAmmBuyInstructions } from './amm-exit.js';
import { getWalletBaseBalance, reconcileVanishedBag } from './reconcile.js';
import { assessTradeSafety, recordFirewallDecision, criticalFirewallReason } from '../../api/_lib/trade-firewall.js';
import { recordDecision } from '../../api/_lib/reasoning-ledger.js';
import { screenPush } from './screen-push.js';

// Self-rated conviction for a snipe entry, 0..1. Lower price impact and a clean
// firewall verdict raise it; a warned verdict and heavy impact lower it. This is
// the prediction the Reasoning Ledger later scores for calibration — does an
// 80%-confidence snipe actually exit profitably 80% of the time?
function snipeConfidence({ priceImpactPct, maxImpactPct, firewallVerdict }) {
	const impactPenalty = Math.min(1, Math.max(0, priceImpactPct) / (maxImpactPct > 0 ? maxImpactPct : 10)) * 0.4;
	const fwBonus = firewallVerdict === 'allow' ? 0.1 : firewallVerdict === 'warn' ? -0.15 : 0;
	const c = 0.6 + fwBonus - impactPenalty;
	return Math.min(0.95, Math.max(0.05, c));
}

// Capture an opened snipe as a tamper-evident decision in the agent's reasoning
// ledger. Best-effort: the on-chain buy has already settled, so a ledger-write
// failure must never throw the trade away. Reconciled later against the closed
// position's realized P&L by api/cron/reconcile-decisions.js.
async function recordSnipeDecision({ strat, network, mint, posId, sig, mode, priceImpactPct, firewall, perTradeLamports, riskOfficer }) {
	try {
		const perTradeSol = Number(BigInt(perTradeLamports)) / 1e9;
		const confidence = snipeConfidence({
			priceImpactPct,
			maxImpactPct: Number(strat.max_price_impact_pct) || 10,
			firewallVerdict: firewall?.verdict || null,
		});
		const trigger = mint.entry_trigger || 'new_mint';
		const rationale =
			`Sniped $${(mint.symbol || mint.mint.slice(0, 4)).toUpperCase()} on a ${trigger} trigger ` +
			`with ${priceImpactPct.toFixed(2)}% price impact` +
			(firewall ? `; firewall verdict ${firewall.verdict} (score ${firewall.score}).` : '.') +
			` Committed ${perTradeSol.toFixed(4)} SOL expecting a profitable exit.`;
		await recordDecision({
			agentId: strat.agent_id,
			kind: 'snipe',
			subjectRef: mint.mint,
			actionRef: String(posId),
			confidence,
			network,
			inputs: {
				entry_trigger: trigger,
				trigger_ref: mint.trigger_ref || null,
				price_impact_pct: Number(priceImpactPct.toFixed(4)),
				per_trade_sol: Number(perTradeSol.toFixed(6)),
				firewall: firewall ? { verdict: firewall.verdict, score: firewall.score } : null,
				position_id: posId,
				buy_sig: sig && sig !== 'SIMULATED' ? sig : null,
				mode,
				symbol: mint.symbol || null,
				llm: mint.llm ? { model: mint.llm.model, confidence: mint.llm.confidence, thesis: mint.llm.thesis } : null,
				// The adversarial second opinion, when one was ENFORCED on this trade.
				// A shadow-mode review is a counterfactual, not part of the decision,
				// so it lives in sniper_risk_reviews and never in the ledger's inputs.
				risk_officer: riskOfficer || null,
			},
			prediction: { direction: 'up', basis: 'snipe entry expects a profitable exit', metric: 'realized_pnl' },
			rationale,
		});
	} catch (err) {
		log.warn?.('ledger_record_failed', { agent: strat.agent_id, mint: mint.mint, message: err?.message });
	}
}

// How long a position may sit in reconcile_pending (bag provably gone, emptying
// tx not found) before the executor gives up, books it closed with unknown
// proceeds, and frees the arm's concurrency slot. Generous enough to cover RPC
// history lag by orders of magnitude — the observed lag is seconds to minutes,
// and anything still unresolved after this is not coming back.
const RECONCILE_GIVE_UP_MS = 6 * 60 * 60 * 1000;

// ── per-agent serialization ────────────────────────────────────────────────
// Single-worker assumption: a per-agent in-process lock makes the budget +
// concurrency checks race-free without a DB reservation. (Scaling to N workers
// would require an atomic spend reservation instead — documented in README.)
const _locks = new Map();
async function withAgentLock(agentId, fn) {
	const prev = _locks.get(agentId) || Promise.resolve();
	let release;
	const next = new Promise((r) => (release = r));
	_locks.set(agentId, prev.then(() => next));
	await prev;
	try {
		return await fn();
	} finally {
		release();
		if (_locks.get(agentId) === next) _locks.delete(agentId);
	}
}

function bn(ctx, v) {
	return new ctx.BN(BigInt(v).toString());
}

// ── shared per-agent spend policy ────────────────────────────────────────────
// Bridges the sniper to the same ceiling that governs withdraw / x402 / trade
// (api/_lib/agent-trade-guards.js). Returns { blocked, reason }. Never throws:
// the sniper's own lamports caps stay the hard backstop, so a pricing or DB
// hiccup here degrades to "allow" rather than stalling the trader.
async function enforceSharedSpendPolicy(agentId, network, perTradeLamports, { holderRef = null, target = null } = {}) {
	try {
		const [row] = await sql`SELECT meta FROM agent_identities WHERE id = ${agentId} AND deleted_at IS NULL`;
		const limits = getSpendLimits(row?.meta);
		const policy = getPolicyRules(row?.meta);
		// Gate when there's something to enforce: a USD ceiling, least-privilege mode
		// (require_capabilities), or any natural-language policy rule. Otherwise skip —
		// keep the hot path price-call- and query-free.
		const needGate = limits.require_capabilities || limits.daily_usd != null || limits.per_tx_usd != null || policy.rules.length > 0;
		if (!needGate) return { blocked: false };
		let usdValue = null;
		try {
			usdValue = await lamportsToUsd(perTradeLamports);
		} catch {
			// Can't price the SOL spend right now. If a capability is REQUIRED we still
			// enforce scope (action/target/expiry/revoked) with a null USD value — only
			// the per-use/aggregate USD metering is skipped. If capabilities aren't
			// required, the USD caps can't bite, so don't block (lamports caps hold).
			if (!limits.require_capabilities) return { blocked: false };
		}
		// Pass the strategy as the capability holder + the mint as the spend target so
		// a strategy-scoped, mint-restricted session key is resolved + enforced here.
		const res = await enforceSpendLimit({
			agentId, limits, policyRules: policy, category: 'snipe', usdValue, asset: 'SOL', network,
			capabilityHolderRef: holderRef, target,
		});
		return { blocked: false, capabilityId: res?.capabilityId || null };
	} catch (err) {
		if (err instanceof SpendLimitError) return { blocked: true, reason: err.code || 'spend_limit' };
		log.warn?.('spend_policy_check_failed', { agent: agentId, message: err?.message });
		return { blocked: false };
	}
}

// Record a confirmed/simulated snipe buy into the shared custody ledger so it
// counts toward the per-agent daily ceiling and shows in the audit trail.
// Awaited by the caller (not fire-and-forget): the on-chain buy has already
// settled, so a ledger-write failure must never throw the trade away — but we
// must finish the write before returning so a rapid next snipe sees this spend
// against the ceiling rather than racing an unwritten record. Prices the SOL
// spend best-effort; a pricing hiccup records lamports with a null USD value.
async function recordSnipeSpend({ agentId, userId, network, lamports, signature, mode, mint, capabilityId = null }) {
	try {
		let usd = null;
		try { usd = await lamportsToUsd(lamports); } catch { usd = null; }
		await recordSpend({
			agentId, userId, category: 'snipe', network, asset: 'SOL',
			amountLamports: lamports, usd, capabilityId,
			signature: signature && signature !== 'SIMULATED' ? signature : null,
			status: mode === 'live' ? 'confirmed' : 'ok',
			meta: { mint, mode },
		});
	} catch (err) {
		log.warn?.('snipe_spend_record_failed', { agent: agentId, message: err?.message });
	}
}

// Build the spend-guard hook the execution engine calls BEFORE appending a Jito
// tip. A tip is real SOL leaving the agent wallet, so it must obey the SAME
// ceilings as the trade itself: the kill switch (frozen wallet), the rolling
// daily SOL budget (tip + already-committed spend must fit the strategy's
// daily_budget_lamports), and the cross-path USD ceiling. On a breach the hook
// THROWS with code 'spend_guard' — the engine vetoes the tip and falls back to
// the protected route, so a tip can never bypass a limit. On allow it records the
// real tip outflow into agent_custody_events (category 'mev_tip') so it counts
// toward the daily ceiling and shows in the owner's audit trail.
function makeTipGuard({ strat, network, alreadyCommittedLamports, dailySpentLamports }) {
	return async function onTip(tipLamports, route) {
		const tip = BigInt(tipLamports);
		if (tip <= 0n) return;

		// Kill switch / wallet freeze — the same gate every autonomous spend honors.
		if (strat.kill_switch === true) {
			throw Object.assign(new Error('strategy kill switch is on'), { code: 'spend_guard' });
		}
		let limits;
		let policyDoc = null;
		try {
			const [row] = await sql`SELECT meta FROM agent_identities WHERE id = ${strat.agent_id} AND deleted_at IS NULL`;
			limits = getSpendLimits(row?.meta);
			policyDoc = getPolicyRules(row?.meta);
		} catch {
			limits = null;
		}
		if (limits?.frozen) {
			throw Object.assign(new Error('agent wallet is frozen'), { code: 'spend_guard' });
		}

		// Daily SOL budget — the tip stacks on the buy already committed this attempt
		// plus the day's prior spend. Keep the wallet inside the strategy budget.
		const budget = BigInt(strat.daily_budget_lamports);
		if (dailySpentLamports + alreadyCommittedLamports + tip > budget) {
			throw Object.assign(new Error('tip would exceed daily budget'), { code: 'spend_guard' });
		}

		// Cross-path USD ceiling (best-effort price; a pricing outage records lamports
		// without a USD value rather than blocking — the lamports budget above holds).
		let usd = null;
		try {
			usd = await lamportsToUsd(tip);
			await enforceSpendLimit({ agentId: strat.agent_id, limits, policyRules: policyDoc, category: 'snipe', usdValue: usd, asset: 'SOL', network });
		} catch (err) {
			if (err instanceof SpendLimitError) {
				throw Object.assign(new Error(err.message), { code: 'spend_guard' });
			}
			// pricing/RPC hiccup — fall through and record lamports only.
		}

		// Record the real tip outflow into the shared custody ledger.
		await recordCustodyEvent({
			agentId: strat.agent_id, userId: strat.user_id, eventType: 'spend',
			category: 'mev_tip', network, asset: 'SOL', amountLamports: tip, usd,
			status: 'confirmed', reason: 'jito_tip',
			meta: { mint: strat._tip_mint || null, route, mode: strat.mev_tip_mode || 'off' },
		}).catch((err) => log.warn?.('mev_tip_record_failed', { agent: strat.agent_id, message: err?.message }));
	};
}

/**
 * Attempt to snipe `mint` for `strat`. All checks short-circuit before any tx.
 * @returns {Promise<{ status: string, reason?: string, sig?: string }>}
 */
export async function executeBuy({ cfg, strat, mint, throttle }) {
	return withAgentLock(strat.agent_id, async () => {
		let perTrade = BigInt(strat.per_trade_lamports);
		const tag = { agent: strat.agent_id, mint: mint.mint, symbol: mint.symbol };

		// 0. Mayhem exclusion (owner rule) — NEVER buy pump.fun Mayhem tokens, only
		//    regular launches. First gate, so a Mayhem mint costs no throttle slot,
		//    no decrypt, and no position row. This is the chokepoint every trigger
		//    path (new_mint / intel / alpha / first_claim / radar / swarm) flows
		//    through, so the rule holds everywhere, not just the standalone fleet.
		const mayhem = await mayhemGate(mint.mint, cfg);
		if (!mayhem.pass) return skip(tag, mayhem.reason);

		// 0b. Market-cap band (owner rule: buy only $10k–$100k). Enforced HERE at the
		//     shared chokepoint — not just in scoreMint/scoreIntel — so alpha_hunt,
		//     first_claim, prelaunch_radar and swarm can't bypass the band the way
		//     they did before. FAIL CLOSED: a strategy that declares a band never buys
		//     a coin whose market cap we can't confirm is inside it. Paths that carry
		//     no mcap (e.g. pre-launch triggers) are correctly skipped when a band is
		//     set — you cannot buy "$10k–$100k" on a coin you can't price.
		const bandReason = marketCapBandReason(mint.market_cap_usd, strat);
		if (bandReason) return skip(tag, bandReason);

		// 1. global throttle (platform-wide backstop)
		if (!throttle.tryConsume()) return skip(tag, 'global_throttle');

		// 2. concurrency cap
		const open = await countOpenPositions(strat.agent_id, cfg.network);
		const concurrency = checkConcurrency(open, strat.max_concurrent_positions);
		if (concurrency) return skip(tag, concurrency.reason);

		// 3. daily budget cap — shrink to the day's remainder rather than sitting out.
		//    An arm whose configured size grew past its OWN daily budget (optimizer
		//    drift moves the two knobs independently) could never clear `spent + size
		//    <= budget` even on a fresh day with zero spend: permanently armed,
		//    permanently unable to buy, and silent about it. Two arms sat dead this way
		//    for a week. Shrinking honours the cap exactly — the day's total still
		//    cannot exceed `daily_budget_lamports` — and only ever lowers risk, the
		//    same shrink-don't-skip rule the wallet headroom below already applies.
		const spent = await getDailySpend(strat.agent_id, cfg.network);
		const dailyBudget = BigInt(strat.daily_budget_lamports);
		const budget = checkDailyBudgetLamports(spent, perTrade, dailyBudget);
		if (budget) {
			const remaining = dailyBudget - BigInt(spent);
			if (remaining < cfg.minTradeLamports) return skip(tag, budget.reason);
			log.info('trade size clamped to the day\'s remaining budget', {
				...tag, configured: perTrade.toString(), clamped: remaining.toString(),
			});
			perTrade = remaining;
		}

		// 3c. realized-loss circuit breaker (portfolio layer). The per-trade caps
		//     above (budget, headroom, impact) can't stop a fleet that bleeds one
		//     losing entry at a time — this does. Once the day's NET realized loss
		//     crosses the cap the agent stops opening positions AND the auto-funder
		//     stops refilling its wallet, so the master can't keep pouring SOL after
		//     a wallet that only loses. Priced only when a cap is configured (env
		//     SNIPER_MAX_DAILY_LOSS_SOL or per-strategy), so the hot path stays free
		//     otherwise. A DB hiccup never blocks — the lamports caps stay the backstop.
		const lossLimit = effectiveDailyLossLimitLamports(strat);
		if (lossLimit != null) {
			try {
				const netRealized = await getRealizedNetLamports(strat.agent_id, cfg.network);
				const loss = checkDailyLoss(netRealized, lossLimit);
				if (loss) return skip(tag, loss.reason);
			} catch (err) {
				log.warn('realized-loss check failed — allowing on lamports backstop', { ...tag, err: err?.message });
			}
		}

		// 3b. shared per-agent spend policy (the same ceiling that governs
		// withdraw / x402 / trade). Opt-in: only priced + enforced when the owner
		// has actually set a USD ceiling, so the hot snipe path stays price-call-
		// free otherwise. Pricing/DB hiccups never block — the lamports caps above
		// remain the hard backstop.
		const policy = await enforceSharedSpendPolicy(strat.agent_id, cfg.network, perTrade, {
			holderRef: String(strat.id), target: mint.mint,
		});
		if (policy.blocked) return skip(tag, policy.reason);
		const spendCapabilityId = policy.capabilityId || null;

		// 4. wallet + funds PRE-CHECK, before claiming a slot. An agent with no
		//    wallet or too little SOL can never fill the buy — skip it cleanly rather
		//    than write a 'failed' position row that only noises up the feeds. (These
		//    were the dominant 'failed' rows: every unfunded agent evaluating every
		//    mint left one behind.)
		let keypair;
		let address;
		let ctx;
		let preBalance;
		try {
			const loaded = await loadAgentKeypair(strat.agent_id, strat.user_id, 'sniper_buy');
			if (!loaded) return skip(tag, 'no_wallet');
			({ keypair, address } = loaded);
			ctx = await getTradeCtx(cfg.network);
			preBalance = BigInt(await ctx.connection.getBalance(keypair.publicKey, 'confirmed'));
		} catch (err) {
			log.warn('wallet precheck failed', { ...tag, err: err?.message });
			return skip(tag, 'wallet_precheck_failed');
		}
		// Learning > profit (owner directive): a wallet too poor for the strategy's
		// configured size still trades, shrunk to what it can actually afford. It
		// sits out only when even a shrunk buy could not clear the pre-broadcast
		// simulations. Safe to shrink: every check already passed above (budget,
		// spend policy) is a ceiling a smaller trade only clears more easily.
		const sized = resolveEntrySize(preBalance, perTrade, cfg.minTradeLamports);
		if (sized.skip) return skip(tag, sized.skip);
		perTrade = sized.sizeLamports;

		// 5. idempotency lock — claim the (agent,mint,network) slot BEFORE the tx.
		//    The wallet is known now, so it's written on the claim (no later UPDATE).
		const claimed = await sql`
			INSERT INTO agent_sniper_positions
				(strategy_id, agent_id, user_id, wallet, network, mint, symbol, name, status,
				 entry_trigger, trigger_ref)
			VALUES (${strat.id}, ${strat.agent_id}, ${strat.user_id}, ${address}, ${cfg.network},
			        ${mint.mint}, ${mint.symbol || null}, ${mint.name || null}, 'opening',
			        ${mint.entry_trigger || 'new_mint'}, ${mint.trigger_ref || null})
			ON CONFLICT (agent_id, mint, network) DO NOTHING
			RETURNING id
		`;
		if (!claimed.length) return skip(tag, 'already_held');
		const posId = claimed[0].id;

		try {
			const mintPk = new ctx.web3.PublicKey(mint.mint);
			const slippagePct = strat.slippage_bps / 100;

			// Venue: an 'amm' entry (graduation_ride) trades the post-migration pump
			// AMM pool; everything else prices the bonding curve. The AMM path
			// enforces a wSOL quote itself (amm_quote_not_sol), so the explicit
			// require_sol_quote check below only guards the curve branch.
			const ammEntry = mint.venue === 'amm';

			// 6. quote + price-impact circuit breaker. Priced through a helper so the
			//    trade can be re-quoted at a smaller size if the risk officer (6c)
			//    cuts it; the impact we RECORD must describe the trade we actually
			//    send, not the larger one that was refused.
			const quoteFor = async (size) => {
				if (ammEntry) {
					const ammQuote = await quoteAmmBuy({
						network: cfg.network, mint: mint.mint, quoteAmount: bn(ctx, size), slippagePct,
					});
					return { priceImpactPct: ammQuote.priceImpactPct };
				}
				const curveQuote = await ctx.client.quoteForBuy({ mint: mintPk, quoteAmount: bn(ctx, size), slippagePct });
				if (strat.require_sol_quote && !curveQuote.quoteMint.equals(ctx.web3.PublicKey.default) && curveQuote.quoteMint.toBase58() !== 'So11111111111111111111111111111111111111112') {
					return { rejected: 'quote_not_sol' };
				}
				return curveQuote;
			};
			let quote = await quoteFor(perTrade);
			if (quote.rejected) return await fail(posId, tag, quote.rejected);
			const impact = checkPriceImpact(Number(quote.priceImpactPct), Number(strat.max_price_impact_pct));
			if (impact) return await fail(posId, tag, impact.reason);

			// 6b. rug/honeypot firewall — a REAL on-chain simulated buy→sell
			// round-trip + authority audit, run after the quote and BEFORE any
			// broadcast. Per-strategy `firewall_level`: 'block' (default) aborts a
			// 'block' verdict; 'warn' logs the verdict but proceeds (raw speed);
			// 'off' skips the check. Never throws — the kernel degrades to 'warn'
			// when a data source is down, so a firewall hiccup can't stall the trader.
			const firewallLevel = ['warn', 'off'].includes(strat.firewall_level) ? strat.firewall_level : 'block';
			let firewallSnapshot = null; // captured for the reasoning ledger
			if (firewallLevel !== 'off') {
				const assessment = await assessTradeSafety({
					network: cfg.network,
					mint: mint.mint,
					side: 'buy',
					payer: keypair.publicKey,
					quoteAmount: perTrade,
					connection: ctx.connection,
					priceImpactPct: Number(quote.priceImpactPct),
					// The balance is already in hand from the step-4 precheck. Handing it to
					// the firewall lets the round-trip probe shrink to a size this wallet can
					// simulate, so a thin wallet reads as a thin wallet — not as a honeypot.
					payerBalanceLamports: preBalance,
				}).catch((err) => {
					log.warn?.('firewall_check_failed', { ...tag, message: err?.message });
					return null;
				});
				// FAIL CLOSED. Two ways this used to buy an unvetted rug and no longer does:
				//   1. assessment === null (the whole firewall threw) → a 'block'-level
				//      strategy must NOT broadcast a coin it never vetted.
				//   2. verdict === 'warn' but a CRITICAL check (round-trip sim couldn't
				//      run, mint/freeze authority active, authority unreadable) → the
				//      warning means "couldn't prove it's safe", not "safe". Block it.
				if (!assessment) {
					if (firewallLevel === 'block') {
						await sql`
							UPDATE agent_sniper_positions
							SET status = 'failed', error = 'firewall_block: firewall_unavailable', closed_at = now()
							WHERE id = ${posId}
						`;
						log.warn('buy blocked — firewall unavailable (fail-closed)', { ...tag });
						screenPush(`$${(mint.symbol || mint.mint.slice(0, 6)).toUpperCase()} blocked — safety check unavailable`, 'analysis');
						return { status: 'failed', reason: 'firewall_unavailable' };
					}
					// warn/off levels keep the raw-speed escape hatch: proceed without a vet.
				} else {
					const critical = criticalFirewallReason(assessment);
					const enforced = firewallLevel === 'block' && (assessment.verdict === 'block' || !!critical);
					recordFirewallDecision({
						mint: mint.mint, network: cfg.network, side: 'buy',
						verdict: assessment.verdict, score: assessment.score, simulated: assessment.simulated,
						checks: assessment.checks, reasons: assessment.reasons,
						source: 'sniper', agentId: strat.agent_id, userId: strat.user_id,
						quoteLamports: perTrade, enforced,
					}).catch(() => {});
					if (enforced) {
						const reason = critical || assessment.reasons?.[0] || 'firewall_blocked';
						await sql`
							UPDATE agent_sniper_positions
							SET status = 'failed', error = ${`firewall_block: ${reason}`.slice(0, 280)}, closed_at = now()
							WHERE id = ${posId}
						`;
						log.warn('buy blocked by firewall', { ...tag, score: assessment.score, critical: critical || null, reasons: assessment.reasons });
						screenPush(`$${(mint.symbol || mint.mint.slice(0, 6)).toUpperCase()} blocked by firewall: ${reason}`, 'analysis');
						return { status: 'failed', reason: 'firewall_block' };
					}
					if (assessment.verdict !== 'allow') {
						log.info('firewall warn (proceeding)', { ...tag, level: firewallLevel, verdict: assessment.verdict, score: assessment.score });
					}
					firewallSnapshot = { verdict: assessment.verdict, score: assessment.score };
				}
			}

			// 6c. adversarial Risk Officer: the independent second opinion. Every
			// gate above answers a question with a number; this one is handed the
			// proposed trade plus the agent's own thesis and told to find what the
			// agent missed. Runs LAST so it sees the real price impact and the real
			// firewall verdict. Default level is 'shadow': it records the veto it
			// WOULD have cast and changes nothing, because enforcement decides what
			// the live fleet buys with real SOL and arming that is an owner call.
			// Fails OPEN, unlike the firewall: it sits behind a safety proof that
			// already passed, so a reviewer outage must never halt the fleet.
			const officer = await reviewBuy({
				cfg, strat, mint, posId,
				perTradeLamports: perTrade,
				minTradeLamports: cfg.minTradeLamports,
				budgetLeftLamports: dailyBudget > BigInt(spent) ? dailyBudget - BigInt(spent) : 0n,
				slotsLeft: Math.max(0, Number(strat.max_concurrent_positions) - open),
				priceImpactPct: Number(quote.priceImpactPct),
				firewall: firewallSnapshot,
				agentReason: mint.llm?.thesis || null,
			});
			if (officer.blocked) {
				await sql`
					UPDATE agent_sniper_positions
					SET status = 'failed', error = ${`risk_officer_veto: ${officer.reason}`.slice(0, 280)}, closed_at = now()
					WHERE id = ${posId}
				`;
				log.warn('buy vetoed by the risk officer', { ...tag, reasons: officer.review?.reasons });
				screenPush(`$${(mint.symbol || mint.mint.slice(0, 6)).toUpperCase()} vetoed by risk review: ${officer.reason}`, 'analysis');
				return { status: 'failed', reason: 'risk_officer_veto' };
			}
			if (officer.resized) {
				log.info('trade size cut by the risk officer', {
					...tag, from: perTrade.toString(), to: officer.sizeLamports.toString(),
					reasons: officer.review?.reasons,
				});
				perTrade = officer.sizeLamports;
				// A smaller buy can only move the curve less, so the breaker above
				// cannot newly trip; re-quote purely so the recorded entry impact is
				// the one this trade actually pays.
				const reQuote = await quoteFor(perTrade).catch(() => null);
				if (reQuote && !reQuote.rejected) quote = reQuote;
			}
			const officerSnapshot = officer.review
				? {
					level: resolveRiskOfficerLevel(strat, cfg.riskOfficer),
					severity: officer.review.severity,
					reasons: officer.review.reasons,
					resized: officer.resized,
				}
				: null;

			// 7. build + (live) broadcast
			let built;
			if (ammEntry) {
				const ammBuilt = await buildAmmBuyInstructions({
					network: cfg.network, mint: mint.mint, user: keypair.publicKey,
					quoteAmount: bn(ctx, perTrade), slippagePct,
				});
				built = { instructions: ammBuilt.instructions, expectedBaseTokens: ammBuilt.expectedBaseOut };
			} else {
				built = await ctx.client.buildBuyInstructions({
					mint: mintPk, user: keypair.publicKey, quoteAmount: bn(ctx, perTrade), slippagePct,
				});
			}
			const baseAmount = BigInt(built.expectedBaseTokens.toString());
			if (baseAmount <= 0n) return await fail(posId, tag, 'zero_tokens');

			let sig = 'SIMULATED';
			// Execution telemetry — only set on a live broadcast; simulate keeps nulls
			// (except a 'simulated' route marker so the UI can label paper fills).
			let exec = { route: 'simulated', tipLamports: 0, priorityFeeMicroLamports: null, landedMs: null };
			screenPush(`Buying $${(mint.symbol || mint.mint.slice(0, 6)).toUpperCase()} — sending tx`, 'trade');
			if (cfg.mode === 'live') {
				const tipMode = ['economy', 'turbo'].includes(strat.mev_tip_mode) ? strat.mev_tip_mode : 'off';
				// The tip guard needs to know what's already committed today + this trade.
				strat._tip_mint = mint.mint;
				const onTip = makeTipGuard({
					strat, network: cfg.network,
					alreadyCommittedLamports: perTrade,
					dailySpentLamports: spent,
				});
				const result = await submitProtectedTrade(ctx, keypair, built.instructions, cfg.confirmTimeoutMs, {
					tipMode, onTip, preSimulated: firewallLevel !== 'off',
				});
				sig = result.signature;
				exec = {
					route: result.route,
					tipLamports: result.tipLamports,
					priorityFeeMicroLamports: result.priorityFeeMicroLamports,
					landedMs: result.landedMs,
				};
				log.trade('exec', { ...tag, route: result.route, tip: result.tipLamports, fee: result.priorityFeeMicroLamports, landed_ms: result.landedMs, attempts: result.attempts, fallback: result.fallbackReason || null });
			}

			const pricePerToken = Number(perTrade) / Number(baseAmount);
			// An AMM entry is born graduated: flag it exactly like a curve position
			// that graduated mid-hold, so the sweep re-quotes it off the AMM and
			// executeSell routes the exit there instead of the dead curve.
			await sql`
				UPDATE agent_sniper_positions SET
					status = 'open', buy_sig = ${sig},
					error = ${ammEntry ? 'graduated:amm_entry' : null},
					entry_quote_lamports = ${perTrade.toString()},
					base_amount = ${baseAmount.toString()},
					entry_price_lamports_per_token = ${pricePerToken},
					entry_price_impact_pct = ${Number(quote.priceImpactPct)},
					peak_value_lamports = ${perTrade.toString()},
					last_value_lamports = ${perTrade.toString()},
					exec_route = ${exec.route},
					tip_lamports = ${exec.tipLamports != null ? String(exec.tipLamports) : null},
					priority_fee_microlamports = ${exec.priorityFeeMicroLamports != null ? String(exec.priorityFeeMicroLamports) : null},
					landed_ms = ${exec.landedMs},
					last_quoted_at = now()
				WHERE id = ${posId}
			`;
			log.trade('buy', { ...tag, mode: cfg.mode, sig, sol: lamportsToSol(perTrade), base: baseAmount.toString(), impact: Number(quote.priceImpactPct).toFixed(2) });
			// Journal the entry WITH its reasoning — the learn-what-works surface.
			await journalEntry({
				cfg, strat, mint, posId, sig,
				score: mint.score ?? null,
				rationale: `Entered on ${mint.entry_trigger || 'new_mint'}${mint.market_cap_usd != null ? ` at ~$${Math.round(mint.market_cap_usd).toLocaleString()} mcap` : ''}${firewallSnapshot ? ` (firewall ${firewallSnapshot.verdict}, score ${firewallSnapshot.score})` : ''}; ${lamportsToSol(perTrade).toFixed(4)} SOL, impact ${Number(quote.priceImpactPct).toFixed(2)}%.${mint.llm ? ` LLM ${mint.llm.model} judged buy at ${Math.round(mint.llm.confidence * 100)}%: ${mint.llm.thesis}` : ''}`,
			});
			screenPush(`Bought $${(mint.symbol || mint.mint.slice(0, 6)).toUpperCase()} at ${lamportsToSol(perTrade).toFixed(4)} SOL — position open`, 'trade');
			notifyBuy({ agentName: strat.agent_name || strat.agent_id, symbol: mint.symbol, mint: mint.mint, solSpent: lamportsToSol(perTrade), mode: cfg.mode, sig, chatId: strat.telegram_chat_id || null });
			await recordSnipeSpend({ agentId: strat.agent_id, userId: strat.user_id, network: cfg.network, lamports: perTrade, signature: sig, mode: cfg.mode, mint: mint.mint, capabilityId: spendCapabilityId });
			await recordSnipeDecision({
				strat, network: cfg.network, mint, posId, sig, mode: cfg.mode,
				priceImpactPct: Number(quote.priceImpactPct), firewall: firewallSnapshot, perTradeLamports: perTrade,
				riskOfficer: officerSnapshot,
			});
			return { status: 'open', sig };
		} catch (err) {
			return await fail(posId, tag, errCode(err), err);
		}
	});
}

/**
 * Close `position` for `reason`. Re-quotes fresh for slippage, builds the sell,
 * broadcasts (live), records realized P&L.
 */
export async function executeSell({ cfg, position, reason, fraction = 1, recoversInitials = false, keepsMoonbag = false }) {
	return withAgentLock(position.agent_id, async () => {
		// Laddered exits sell only PART of the bag. Two different partials exist:
		//   recoversInitials: the take-initials leg; the position stays OPEN and the
		//                      moon bag keeps trading under the exit rules.
		//   keepsMoonbag:     a terminal exit that still refuses to sell the last
		//                      slice; the position CLOSES for accounting (its P&L is
		//                      booked and its concurrency slot is freed) while the
		//                      remaining tokens are retained and ride indefinitely.
		// Resolve the sell size in ppm of the current base amount so the remainder is
		// exact with no float drift.
		const f = Number(fraction);
		const fullBase = BigInt(position.base_amount);
		const ppm = f > 0 && f < 1 ? BigInt(Math.max(1, Math.min(999_999, Math.round(f * 1_000_000)))) : 1_000_000n;
		let sellBaseBig = ppm === 1_000_000n ? fullBase : (fullBase * ppm) / 1_000_000n;
		const partial = sellBaseBig > 0n && sellBaseBig < fullBase;
		if (sellBaseBig <= 0n) sellBaseBig = fullBase; // degenerate fraction → full exit
		// A partial that isn't a take-initials leg is a moon-bag close. If the
		// fraction degenerated to a full sell there is no bag left to keep, so the
		// flag drops with it rather than recording an empty bag.
		const retainsMoonbag = keepsMoonbag && partial && !recoversInitials;
		const tag = { agent: position.agent_id, mint: position.mint, symbol: position.symbol, reason, partial };
		await sql`UPDATE agent_sniper_positions SET status = 'closing' WHERE id = ${position.id} AND status = 'open'`;
		screenPush(`${partial ? (retainsMoonbag ? 'Banking profit, keeping a moon bag on' : 'Taking initials on') : 'Selling'} $${(position.symbol || position.mint.slice(0, 6)).toUpperCase()}: ${reason}`, 'trade');

		try {
			const loaded = await loadAgentKeypair(position.agent_id, position.user_id, 'sniper_sell');
			if (!loaded) return await fail(position.id, tag, 'no_wallet');
			const { keypair } = loaded;

			const ctx = await getTradeCtx(cfg.network);

			// Retry of a previously-failed sell → make the CHAIN the source of truth
			// before re-broadcasting. A sell whose confirmation timed out may have
			// landed anyway; retrying it then simulates a sell of tokens the wallet no
			// longer holds and fails forever (pump 6023 NotEnoughTokensToSell), burning
			// RPC every sweep. Balance 0 → find the landed tx and book its real
			// proceeds; balance short of the DB amount → sell what's actually there.
			if (position.error) {
				const realBalance = await getWalletBaseBalance(ctx, keypair.publicKey, position.mint);
				if (realBalance != null) {
					if (realBalance === 0n) {
						const reconciled = await reconcileVanishedBag({ ctx, position, reason });
						if (reconciled) return { status: 'closed', reason: 'reconciled_onchain' };
						// Emptying tx not found yet (history lag); hold for the next sweep
						// rather than re-broadcasting a sell that cannot succeed.
						//
						// Two guards, both learned from production. The status guard: this
						// UPDATE used to write status='open' unconditionally, which
						// resurrected positions closed concurrently (by a reconcile in
						// another sweep, or by an operator) — they kept sell_sig, closed_at
						// and realized P&L while reading 'open', so a settled trade counted
						// as live risk and held a concurrency slot. The time bound: the park
						// itself had none, so a bag whose emptying tx could never be found
						// re-parked every sweep forever and wedged that slot permanently.
						if (shouldGiveUpReconcile(reconcileParkAnchor(position), RECONCILE_GIVE_UP_MS)) {
							// The bag is provably gone but its proceeds are unknowable from
							// chain history. Book it closed so the slot frees, and leave
							// realized P&L NULL rather than inventing a number — every P&L
							// query filters NULL out, so an unknown exit skews no report.
							await sql`
								UPDATE agent_sniper_positions SET
									status = 'closed', exit_reason = 'error',
									error = 'reconcile_unresolved',
									reconcile_pending_since = NULL, closed_at = now()
								WHERE id = ${position.id} AND status <> 'closed'
							`;
							log.warn('reconcile gave up; bag gone, proceeds unknown', {
								...tag,
								pending_since: position.reconcile_pending_since,
								// The anchor actually measured, which differs from pending_since
								// on a row parked before that column existed.
								park_anchor: reconcileParkAnchor(position),
							});
							return { status: 'closed', reason: 'reconcile_unresolved' };
						}
						await sql`
							UPDATE agent_sniper_positions SET
								status = 'open', error = 'reconcile_pending',
								reconcile_pending_since = coalesce(reconcile_pending_since, now()),
								last_quoted_at = now()
							WHERE id = ${position.id} AND status <> 'closed'
						`;
						return { status: 'retry', reason: 'reconcile_pending' };
					}
					if (realBalance < sellBaseBig) {
						log.warn('sell clamped to real wallet balance', { ...tag, db_base: sellBaseBig.toString(), real_base: realBalance.toString() });
						sellBaseBig = realBalance;
					}
				}
			}

			const mintPk = new ctx.web3.PublicKey(position.mint);
			const baseAmount = bn(ctx, sellBaseBig);
			const slippagePct = (position.slippage_bps ?? 500) / 100;

			let expectedOut;
			let built;
			let venue = 'bonding_curve';

			// A position already flagged graduated skips the dead curve and goes
			// straight to the AMM — no point re-quoting a curve we know is complete.
			const preGraduated = typeof position.error === 'string' && position.error.startsWith('graduated');
			if (preGraduated) {
				built = await buildGraduatedSell({ cfg, position, keypair, baseAmount, slippagePct });
				expectedOut = built.expectedQuoteOut;
				venue = 'amm';
			} else {
				try {
					const quote = await ctx.client.quoteForSell({ mint: mintPk, baseAmount, slippagePct });
					expectedOut = BigInt(quote.expectedQuoteOut.toString());
					built = await ctx.client.buildSellInstructions({ mint: mintPk, user: keypair.publicKey, baseAmount, slippagePct });
				} catch (err) {
					// Graduation is the one "failure" that isn't one: the curve is
					// complete, so route the same exit through the AMM pool instead of
					// parking the bag. Any other error propagates to the retry handler.
					if (err?.name !== 'CoinGraduatedError') throw err;
					built = await buildGraduatedSell({ cfg, position, keypair, baseAmount, slippagePct });
					expectedOut = built.expectedQuoteOut;
					venue = 'amm';
				}
			}

			let sig = 'SIMULATED';
			if (cfg.mode === 'live') {
				sig = await signAndSend(ctx, keypair, built.instructions, cfg.confirmTimeoutMs);
			} else if (venue === 'bonding_curve') {
				expectedOut = BigInt(built.expectedQuoteOut.toString());
			}

			const entryFull = BigInt(position.entry_quote_lamports || '0');
			// Cost basis of the tokens sold on THIS leg (scaled by the sold ppm), so a
			// partial take-initials books the profit on just the half it sold and the
			// remainder keeps its own proportional basis.
			const soldCostBasis = partial ? (entryFull * ppm) / 1_000_000n : entryFull;
			const legPnl = expectedOut - soldCostBasis;
			const priorRealized = BigInt(position.realized_pnl_lamports || '0');
			const cumRealized = priorRealized + legPnl;

			if (partial && !retainsMoonbag) {
				// Take-initials: keep the position OPEN with the moon-bag remainder.
				// Scale the cost basis down with the tokens, flag initials recovered so
				// the ladder fires once, and RESET the trailing high-water to the
				// remaining bag's value — the pre-sale full-position peak would instantly
				// trip the trailing stop against the now-smaller moon bag.
				const remainingBase = fullBase - sellBaseBig;
				const remainingEntry = entryFull - soldCostBasis;
				const remainingValueEst = Math.round((Number(expectedOut) * Number(remainingBase)) / Number(sellBaseBig));
				await sql`
					UPDATE agent_sniper_positions SET
						status = 'open',
						base_amount = ${remainingBase.toString()},
						entry_quote_lamports = ${remainingEntry.toString()},
						initials_recovered = ${recoversInitials ? true : position.initials_recovered === true},
						peak_value_lamports = ${remainingValueEst},
						last_value_lamports = ${remainingValueEst},
						realized_pnl_lamports = ${cumRealized.toString()},
						error = ${null},
						last_quoted_at = now()
					WHERE id = ${position.id}
				`;
				const legSol = lamportsToSol(legPnl);
				log.trade('take-initials', { ...tag, venue, mode: cfg.mode, sig, sold_fraction: f, leg_pnl_sol: legSol, kept_moonbag_base: remainingBase.toString() });
				await recordJournal({ position, cfg, event: 'take_initials', reason, sig, venue, soldFraction: f, legPnlLamports: legPnl, remainingBase });
				screenPush(
					`Took initials on $${(position.symbol || position.mint.slice(0, 6)).toUpperCase()} — +${legSol.toFixed(4)} SOL back, moon bag riding`,
					'trade',
					{ phase: 'take_initials', mint: position.mint, symbol: position.symbol || null, solDelta: legSol, soldFraction: f },
				);
				return { status: 'partial', sig, sold_fraction: f, leg_pnl: legPnl.toString(), venue };
			}

			const pnl = legPnl;
			const pnlPct = entryFull > 0n ? (Number(cumRealized) / Number(entryFull)) * 100 : 0;
			// Tokens kept back on a moon-bag close, and the cost basis still sitting in
			// them. Once initials were recovered that basis is ~0, which is the whole
			// point: the bag is free, so a bag that goes to zero costs nothing and a
			// bag that runs is pure upside. The position still books CLOSED here so its
			// realized P&L lands in every existing report and its concurrency slot is
			// released; only the tokens stay behind.
			const keptBase = retainsMoonbag ? fullBase - sellBaseBig : 0n;
			const keptEntry = retainsMoonbag ? entryFull - soldCostBasis : 0n;
			const keptValueEst = retainsMoonbag && sellBaseBig > 0n
				? Math.round((Number(expectedOut) * Number(keptBase)) / Number(sellBaseBig))
				: 0;
			await sql`
				UPDATE agent_sniper_positions SET
					status = 'closed', exit_reason = ${reason}, sell_sig = ${sig},
					exit_quote_lamports = ${expectedOut.toString()},
					realized_pnl_lamports = ${cumRealized.toString()},
					realized_pnl_pct = ${pnlPct},
					moonbag_base_amount = ${keptBase.toString()},
					moonbag_entry_lamports = ${keptEntry.toString()},
					moonbag_last_value_lamports = ${keptValueEst},
					moonbag_opened_at = ${retainsMoonbag ? new Date().toISOString() : null},
					error = ${null},
					reconcile_pending_since = NULL,
					closed_at = now()
				WHERE id = ${position.id}
			`;
			await recordJournal({
				position, cfg, event: retainsMoonbag ? 'exit_moonbag' : 'exit', reason, sig, venue,
				soldFraction: retainsMoonbag ? f : 1, legPnlLamports: legPnl,
				...(retainsMoonbag ? { remainingBase: keptBase } : {}),
			});
			const pnlSol = lamportsToSol(cumRealized);
			log.trade(retainsMoonbag ? 'sell-keep-moonbag' : 'sell', {
				...tag, venue, mode: cfg.mode, sig, pnl_sol: pnlSol, pnl_pct: pnlPct.toFixed(1),
				...(retainsMoonbag ? { kept_moonbag_base: keptBase.toString(), sold_fraction: f } : {}),
			});
			// Price the realized SOL delta into USD best-effort for the live PnL
			// ticker. A pricing hiccup just omits realizedUsd — the viewer's ticker
			// falls back to SOL, which is the unit the sell actually returned.
			let realizedUsd = null;
			try {
				const solUsd = await lamportsToUsd(1_000_000_000n);
				if (Number.isFinite(solUsd)) realizedUsd = pnlSol * solUsd;
			} catch { /* pricing offline — SOL-only ticker */ }
			const sym = (position.symbol || position.mint.slice(0, 6)).toUpperCase();
			screenPush(
				retainsMoonbag
					? `Banked ${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL on $${sym} and kept a free moon bag riding`
					: `Sold $${sym}: ${pnlPct >= 0 ? 'profit' : 'loss'} ${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL`,
				'trade',
				{
					phase: retainsMoonbag ? 'exit_moonbag' : 'exit',
					mint: position.mint, symbol: position.symbol || null,
					solDelta: pnlSol, pct: pnlPct, realizedUsd,
					...(retainsMoonbag ? { moonbagBase: keptBase.toString() } : {}),
				},
			);
			notifySell({ agentName: position.agent_name || position.agent_id, symbol: position.symbol, mint: position.mint, pnlSol, pnlPct, exitReason: reason, mode: cfg.mode, sig, chatId: position.telegram_chat_id || null });
			return { status: 'closed', sig, pnl: pnl.toString(), venue, moonbagBase: keptBase.toString() };
		} catch (err) {
			// A failed sell must NOT terminate the position — leave it 'open' so the
			// next tick retries the exit rather than stranding the bag as 'failed'.
			// Preserve the graduated marker so the retry stays on the AMM path instead
			// of bouncing back through the dead curve to rediscover graduation.
			const wasGraduated = typeof position.error === 'string' && position.error.startsWith('graduated');
			const errState = wasGraduated ? `graduated:amm_exit_retry:${errCode(err)}` : errCode(err);
			await sql`UPDATE agent_sniper_positions SET status = 'open', error = ${errState}, last_quoted_at = now() WHERE id = ${position.id}`;
			log.warn('sell failed (will retry)', { ...tag, code: errCode(err), graduated: wasGraduated, err: err?.message });
			screenPush(`Error: sell $${(position.symbol || position.mint.slice(0, 6)).toUpperCase()} failed (${errCode(err)}) — retrying`, 'activity');
			return { status: 'retry', reason: errCode(err) };
		}
	});
}

// Build the AMM sell for a graduated position. Reuses the platform's pool
// resolution + PumpAmmSdk (api/pump/[action].js parity) so the exit prices off
// the live pool, with the slippage-derived min-out floor embedded on-chain. In
// `simulate` mode the instructions are still built (proving the path works) but
// never broadcast — expectedQuoteOut becomes the paper fill.
async function buildGraduatedSell({ cfg, position, keypair, baseAmount, slippagePct }) {
	const { instructions, expectedQuoteOut } = await buildAmmSellInstructions({
		network: cfg.network,
		mint: position.mint,
		user: keypair.publicKey,
		baseAmount,
		slippagePct,
	});
	return { instructions, expectedQuoteOut };
}

function skip(tag, reason) {
	log.info('skip', { ...tag, reason });
	return { status: 'skip', reason };
}

async function fail(posId, tag, reason, err) {
	await sql`UPDATE agent_sniper_positions SET status = 'failed', error = ${reason}, closed_at = now() WHERE id = ${posId}`;
	log.warn('buy aborted', { ...tag, reason, err: err?.message });
	return { status: 'failed', reason };
}

function errCode(err) {
	return err?.code || err?.name || 'error';
}

function lamportsToSol(l) {
	return Number(BigInt(l)) / 1e9;
}
