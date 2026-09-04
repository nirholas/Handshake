// agent-sniper: adversarial pre-trade Risk Officer.
//
// The executor already enforces a stack of MECHANICAL gates before any buy is
// broadcast: Mayhem exclusion, the market-cap band, throttle/concurrency/budget
// caps, the shared spend policy, wallet headroom, the price-impact breaker and
// the trade firewall's real on-chain buy→sell round-trip. Every one of those
// answers a question with a number. None of them asks the question a human risk
// desk asks last: "knowing everything we know, is this specific trade still a
// good idea?"
//
// This module is that second opinion, and it is deliberately ADVERSARIAL. It is
// not the buy-side judge (llm-judge.js) run twice: the judge is looking for a
// reason to buy, the officer is looking for the reason the judge missed. It sees
// the judge's own thesis and is told to assume the trade is bad until the facts
// prove otherwise. That asymmetry is the whole value; running the same optimistic
// prompt a second time would only launder the first answer.
//
// ENFORCEMENT IS OFF BY DEFAULT, ON PURPOSE. The officer decides what the live
// fleet buys with real SOL, so arming it is an owner call, not a deploy-time
// default. Three levels, per strategy (`agent_sniper_strategies.risk_officer_level`)
// with an env default (`SNIPER_RISK_OFFICER`):
//
//   'shadow'  (default): the review runs and is recorded, and NOTHING changes.
//                         Fire-and-forget, so it adds zero latency to the buy
//                         path. This is how the owner gets the evidence to arm
//                         it: `sniper_risk_reviews` accumulates the vetoes it
//                         WOULD have cast against the positions that actually
//                         opened, and their realized P&L answers whether the
//                         officer was right.
//   'enforce'           : awaited before the broadcast. A 'block' severity kills
//                         the buy; a smaller `size_adjustment` shrinks it. Never
//                         upsizes: an adversarial reviewer may only reduce risk.
//   'off'               : never called.
//
// FAIL OPEN, unlike the firewall. The firewall proves a coin is not a honeypot,
// so an unavailable firewall must block ('couldn't prove it's safe' is not
// 'safe'). The officer is a judgment layer sitting BEHIND that proof: if the
// model is down, timed out, or answered with garbage, every mechanical gate has
// already passed and the trade proceeds unchanged. A reviewer outage must never
// become a fleet-wide halt.

import { log } from './log.js';
import { sql } from '../../api/_lib/db.js';
import { llmComplete } from '../../api/_lib/llm.js';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

export const RISK_OFFICER_LEVELS = ['off', 'shadow', 'enforce'];

const LAMPORTS_PER_SOL = 1_000_000_000n;

// Short by design: this sits between a quote and a broadcast on a coin that is
// seconds old. An officer that answers late has already answered wrong.
const TIMEOUT_MS = Math.max(1_500, Number(process.env.SNIPER_RISK_OFFICER_TIMEOUT_MS || 6_000));
const MAX_CONCURRENT = Math.max(1, Number(process.env.SNIPER_RISK_OFFICER_MAX_CONCURRENT || 3));

// Which brain reviews. UNSET BY DEFAULT, and that default is deliberate: with no
// model named, the officer asks the platform's own free-first chain
// (`llmComplete`), which leads with Vertex Claude on GCP credits where that is
// enabled and falls through the free lanes otherwise. That satisfies the
// prefer-GCP-over-paid-third-parties rule, and it keeps the officer independent
// of the buy-side judge, which routes its own `strat.llm_model` through
// OpenRouter — a second opinion from the same weights is an echo, not a review.
//
// Naming a model here (env, or a strategy's `risk_officer_model`) routes the
// review through OpenRouter first and keeps the platform chain as the backstop.
// Only pay that hop when someone actually chose the model: OpenRouter answers a
// 402 in ~150ms when its credits are dry, and a guaranteed-failing first hop on
// a path that sits between a quote and a broadcast is latency for nothing.
const DEFAULT_MODEL = (process.env.SNIPER_RISK_OFFICER_MODEL || '').trim() || null;

let _active = 0;

const SYSTEM_PROMPT = [
	'You are an independent risk reviewer for an autonomous pump.fun trader on Solana.',
	'The trading agent wants to BUY. Your ONLY job is to catch what it missed.',
	'Assume the trade is bad until the facts prove otherwise.',
	'',
	'Veto (severity "block") ONLY for concrete, nameable danger: a creator with a rug',
	'history, extreme holder concentration, price impact that eats the edge, a failed',
	'or warned safety check, or a breach of the mandate. Default to NOT vetoing on a',
	'thin-but-clean setup, the agent already skipped the obvious junk, and a reviewer',
	'that blocks everything is the same as no reviewer at all.',
	'',
	'Prefer a smaller size over a full veto when the concern is size-shaped rather',
	'than existential: set "size_adjustment" to a SMALLER SOL amount than proposed.',
	'You may never suggest a LARGER size.',
	'',
	'Never write generic risk boilerplate ("crypto is volatile", "memecoins are risky").',
	'Every reason must cite a specific fact you were given. If you have no such fact,',
	'you have no veto.',
	'',
	'Respond with ONLY a JSON object, no prose, no code fences:',
	'{"veto": true|false, "severity": "none"|"caution"|"block",',
	' "reasons": ["specific, fact-based"], "size_adjustment": <SOL number>|null}',
].join('\n');

function n(v) {
	const x = Number(v);
	return Number.isFinite(x) ? x : null;
}

function lamportsToSol(l) {
	return Number(BigInt(l)) / 1e9;
}

/**
 * Which enforcement level applies to one strategy. A valid per-strategy column
 * wins; otherwise the env default; otherwise 'shadow'. An unrecognised value
 * (hand-edited row, stale deploy) degrades to 'shadow' rather than silently
 * enforcing something nobody armed.
 */
export function resolveRiskOfficerLevel(strat, envDefault = process.env.SNIPER_RISK_OFFICER) {
	const perStrategy = String(strat?.risk_officer_level || '').trim().toLowerCase();
	if (perStrategy) {
		// A value IS set on the row. If it is not one we recognise (hand-edited row,
		// a level from a newer deploy) it degrades to 'shadow' and stops here. It
		// must NOT fall through to an env default that might be 'enforce', because
		// then a typo in a strategy would silently arm the thing nobody armed.
		return RISK_OFFICER_LEVELS.includes(perStrategy) ? perStrategy : 'shadow';
	}
	const env = String(envDefault || '').trim().toLowerCase();
	if (RISK_OFFICER_LEVELS.includes(env)) return env;
	return 'shadow';
}

/**
 * Parse the model's answer into a normalized review, or null when it is not
 * usable. Null always fails open: an unparseable review never blocks a trade.
 *
 * Tolerates the two things models actually do wrong here: wrapping the JSON in
 * a ```json fence, and emitting `veto: true` with `severity: "caution"` (or the
 * reverse). Severity is the authority on enforcement; `veto` is normalized to
 * agree with it so a downstream reader can trust either field.
 */
export function parseReview(text) {
	if (!text) return null;
	const raw = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
	const start = raw.indexOf('{');
	const end = raw.lastIndexOf('}');
	if (start < 0 || end <= start) return null;
	let obj;
	try {
		obj = JSON.parse(raw.slice(start, end + 1));
	} catch {
		return null;
	}
	if (!obj || typeof obj !== 'object') return null;

	let severity = String(obj.severity || '').trim().toLowerCase();
	if (!['none', 'caution', 'block'].includes(severity)) {
		// No usable severity: infer it from the veto flag rather than discarding a
		// review that named real reasons.
		severity = obj.veto === true ? 'block' : 'none';
	}
	const reasons = (Array.isArray(obj.reasons) ? obj.reasons : [])
		.map((r) => String(r || '').trim())
		.filter(Boolean)
		.slice(0, 6)
		.map((r) => r.slice(0, 240));

	// A 'block' with nothing to point at is boilerplate, not a finding. Downgrade
	// it: the prompt is explicit that a veto must cite a fact.
	if (severity === 'block' && !reasons.length) severity = 'caution';

	const sizeSol = n(obj.size_adjustment);
	return {
		veto: severity === 'block',
		severity,
		reasons,
		sizeAdjustmentSol: sizeSol != null && sizeSol > 0 ? sizeSol : null,
	};
}

/**
 * Turn a review into the trade's actual outcome. PURE: the executor calls this
 * and acts on the result, and the tests call it with no network or DB.
 *
 * Contract:
 *   • Only 'enforce' can change anything. 'shadow'/'off' are always a no-op.
 *   • A missing/degraded review is always a no-op (fail open).
 *   • 'block' aborts. 'caution' never aborts on its own.
 *   • A size adjustment may only SHRINK the trade, and never below the network's
 *     minimum tradeable size: a suggestion under that floor clamps up to the
 *     floor rather than aborting, because the officer asked for less risk, not
 *     for no trade.
 */
export function applyReview({ review, level, perTradeLamports, minTradeLamports }) {
	const size = BigInt(perTradeLamports);
	const unchanged = { blocked: false, reason: null, sizeLamports: size, resized: false };
	if (level !== 'enforce') return unchanged;
	if (!review || review.degraded) return unchanged;

	if (review.severity === 'block') {
		return {
			blocked: true,
			reason: review.reasons[0] || 'risk_officer_veto',
			sizeLamports: size,
			resized: false,
		};
	}

	if (review.sizeAdjustmentSol == null) return unchanged;
	const suggested = BigInt(Math.floor(review.sizeAdjustmentSol * 1e9));
	if (suggested >= size) return unchanged; // never upsize
	const floor = BigInt(minTradeLamports ?? 0);
	const next = suggested < floor ? floor : suggested;
	if (next >= size) return unchanged; // the floor already equals the proposed size
	return { blocked: false, reason: null, sizeLamports: next, resized: true };
}

/**
 * The brief. Only facts the caller actually has: an omitted field is omitted,
 * never guessed, because a fabricated holder count is exactly the kind of thing
 * an adversarial reviewer would (correctly) veto on.
 */
export function reviewBrief({ mint, sizeSol, budgetLeftSol, slotsLeft, priceImpactPct, firewall, agentReason }) {
	const facts = {
		symbol: mint.symbol || null,
		name: mint.name || null,
		mint: mint.mint,
		market_cap_usd: mint.market_cap_usd != null ? Math.round(Number(mint.market_cap_usd)) : null,
		entry_trigger: mint.entry_trigger || 'new_mint',
		creator_prior_launches: mint.creator_launches ?? null,
		creator_graduated_coins: mint.creator_graduated ?? null,
		dev_initial_buy_sol: mint.initial_buy_sol != null ? Number(mint.initial_buy_sol) : null,
		twitter: mint.twitter || null,
		telegram: mint.telegram || null,
		website: mint.website || null,
		price_impact_pct: priceImpactPct != null ? Number(Number(priceImpactPct).toFixed(3)) : null,
		safety_firewall_verdict: firewall?.verdict || null,
		safety_firewall_score: firewall?.score ?? null,
	};
	const lines = Object.entries(facts)
		.filter(([, v]) => v != null && v !== '')
		.map(([k, v]) => `${k}: ${v}`);

	return [
		`PROPOSED: BUY ${Number(sizeSol).toFixed(4)} SOL of ${mint.symbol || mint.mint.slice(0, 6)}.`,
		agentReason ? `AGENT'S REASON: "${String(agentReason).slice(0, 400)}"` : 'AGENT\'S REASON: (rule-based entry, no stated thesis)',
		'',
		'FACTS (on-chain / feed data, do not invent any others):',
		...lines.map((l) => `- ${l}`),
		'',
		'MANDATE REMAINING:',
		`- daily budget left: ${Number(budgetLeftSol).toFixed(4)} SOL`,
		`- open position slots left: ${slotsLeft}`,
	].join('\n');
}

async function askOpenRouter({ model, user }) {
	const key = process.env.OPENROUTER_API_KEY;
	if (!key) throw new Error('OPENROUTER_API_KEY not configured');
	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
	try {
		const resp = await fetch(OPENROUTER_URL, {
			method: 'POST',
			signal: ac.signal,
			headers: {
				authorization: `Bearer ${key}`,
				'content-type': 'application/json',
				'x-title': 'three.ws agent-sniper risk officer',
			},
			body: JSON.stringify({
				model,
				max_tokens: 300,
				temperature: 0,
				messages: [
					{ role: 'system', content: SYSTEM_PROMPT },
					{ role: 'user', content: user },
				],
			}),
		});
		if (!resp.ok) {
			const body = await resp.text().catch(() => '');
			throw new Error(`openrouter ${resp.status}: ${body.slice(0, 160)}`);
		}
		const body = await resp.json();
		return body?.choices?.[0]?.message?.content || '';
	} finally {
		clearTimeout(timer);
	}
}

// One review per proposed trade. A named model routes through OpenRouter first;
// with no model named (the default) the platform chain answers directly. Either
// way the chain is the backstop, so an OpenRouter outage degrades to a different
// reviewer rather than to no reviewer, and `answeredBy` always records who
// actually replied rather than who was asked.
async function ask(user, model) {
	const t0 = Date.now();
	if (model) {
		try {
			const text = await askOpenRouter({ model, user });
			const review = parseReview(text);
			if (review) return { ...review, model, answeredBy: model, latencyMs: Date.now() - t0, degraded: false };
			throw new Error('unparseable review');
		} catch (err) {
			log.warn('risk officer openrouter failed, platform-chain fallback', { model, err: err?.message });
		}
	}
	const res = await llmComplete({ system: SYSTEM_PROMPT, user, maxTokens: 300, timeoutMs: TIMEOUT_MS });
	const review = parseReview(res?.text ?? res);
	if (!review) return null;
	return {
		...review,
		model: model || 'platform-chain',
		answeredBy: res?.model || res?.provider || 'platform-chain',
		latencyMs: Date.now() - t0,
		degraded: false,
	};
}

// Append-only review ledger. Fire-and-forget in every mode: the review's value
// is the evidence it accumulates, and a ledger hiccup must never cost a trade.
function recordReview(row) {
	sql`
		insert into sniper_risk_reviews
			(agent_id, strategy_id, position_id, network, mint, symbol, level, veto, severity,
			 reasons, proposed_lamports, adjusted_lamports, enforced, model, answered_by,
			 latency_ms, degraded, agent_reason)
		values
			(${row.agentId}, ${row.strategyId}, ${row.positionId ?? null}, ${row.network}, ${row.mint},
			 ${row.symbol || null}, ${row.level}, ${row.veto}, ${row.severity},
			 ${row.reasons || []}, ${row.proposedLamports}, ${row.adjustedLamports ?? null},
			 ${row.enforced}, ${row.model || null}, ${row.answeredBy || null},
			 ${row.latencyMs ?? null}, ${row.degraded}, ${row.agentReason || null})
	`.catch((err) => log.warn('risk review record failed', { mint: row.mint, err: err?.message }));
}

/**
 * Review one proposed buy.
 *
 * Returns `{ blocked, reason, sizeLamports, resized, review }`. In 'shadow' and
 * 'off' the returned decision is ALWAYS the caller's own proposal unchanged;
 * shadow additionally kicks the review off in the background so the ledger fills
 * without the buy path ever waiting on it.
 */
export async function reviewBuy({ cfg, strat, mint, posId, perTradeLamports, minTradeLamports, budgetLeftLamports, slotsLeft, priceImpactPct, firewall, agentReason }) {
	const size = BigInt(perTradeLamports);
	const passthrough = { blocked: false, reason: null, sizeLamports: size, resized: false, review: null };

	const level = resolveRiskOfficerLevel(strat, cfg?.riskOfficer);
	if (level === 'off') return passthrough;

	if (_active >= MAX_CONCURRENT) {
		// Saturated. Fail open: every mechanical gate has already passed.
		log.info('risk officer saturated, proceeding unreviewed', { agent: strat.agent_id, mint: mint.mint, active: _active });
		return passthrough;
	}

	const model = (strat.risk_officer_model || DEFAULT_MODEL) || null;
	const user = reviewBrief({
		mint,
		sizeSol: lamportsToSol(size),
		budgetLeftSol: lamportsToSol(budgetLeftLamports ?? 0n),
		slotsLeft,
		priceImpactPct,
		firewall,
		agentReason,
	});

	const base = {
		agentId: strat.agent_id,
		strategyId: strat.id,
		positionId: posId ?? null,
		network: cfg.network,
		mint: mint.mint,
		symbol: mint.symbol || null,
		level,
		proposedLamports: size.toString(),
		agentReason: agentReason || null,
	};

	_active++;
	const pending = ask(user, model)
		.catch((err) => {
			log.warn('risk officer unavailable, proceeding unreviewed', { agent: strat.agent_id, mint: mint.mint, err: err?.message });
			return null;
		})
		.finally(() => { _active--; });

	// Shadow: never awaited, so the live fleet pays no latency for evidence
	// collection. The verdict lands in the ledger next to the position that DID
	// open, which is exactly the comparison the owner needs to arm 'enforce'.
	if (level !== 'enforce') {
		pending.then((review) => {
			if (!review) {
				recordReview({ ...base, veto: false, severity: 'none', reasons: [], enforced: false, degraded: true });
				return;
			}
			const would = applyReview({ review, level: 'enforce', perTradeLamports: size, minTradeLamports });
			recordReview({
				...base,
				veto: review.veto,
				severity: review.severity,
				reasons: review.reasons,
				adjustedLamports: would.resized ? would.sizeLamports.toString() : null,
				enforced: false,
				model: review.model,
				answeredBy: review.answeredBy,
				latencyMs: review.latencyMs,
				degraded: false,
			});
			if (would.blocked || would.resized) {
				log.info('risk officer (shadow) would have acted', {
					agent: strat.agent_id, mint: mint.mint, severity: review.severity,
					wouldBlock: would.blocked, reasons: review.reasons,
				});
			}
		});
		return passthrough;
	}

	const review = await pending;
	if (!review) {
		recordReview({ ...base, veto: false, severity: 'none', reasons: [], enforced: false, degraded: true });
		return passthrough;
	}
	const decision = applyReview({ review, level, perTradeLamports: size, minTradeLamports });
	recordReview({
		...base,
		veto: review.veto,
		severity: review.severity,
		reasons: review.reasons,
		adjustedLamports: decision.resized ? decision.sizeLamports.toString() : null,
		enforced: decision.blocked || decision.resized,
		model: review.model,
		answeredBy: review.answeredBy,
		latencyMs: review.latencyMs,
		degraded: false,
	});
	return { ...decision, review };
}
