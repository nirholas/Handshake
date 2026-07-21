// agent-sniper, LLM-judged entries (decision_mode = 'llm').
//
// Some strategies deliberately carry NO rule shields: no market-cap band, no
// socials requirement, no oracle threshold. Instead, each new launch is put in
// front of a model (per-strategy, e.g. x-ai/grok-*, anthropic/claude-*, or
// openrouter/auto) which returns a buy/skip verdict with a confidence and a
// one-line thesis. This is an EXPERIMENT ARM to compare judgment against rules;
// the non-negotiable safety rails still apply at the executeBuy chokepoint for
// every mode: Mayhem exclusion, the trade firewall's real buy→sell round-trip,
// budgets, concurrency, SOL headroom, and the shared spend policy.
//
// Cost + latency control:
//   • One verdict per (mint, model), agents sharing a model share the call.
//   • A small global concurrency cap; when the firehose outruns it, launches
//     are skipped with a log line (never queued unboundedly).
//   • OpenRouter is the primary route (one key, every experiment model). When
//     it fails, the platform's free-first llmComplete chain is the backstop and
//     the verdict is tagged with the model that actually answered.

import { log } from './log.js';
import { sql } from '../../api/_lib/db.js';
import { llmComplete } from '../../api/_lib/llm.js';
import { assessMarketRealness } from '../../api/_lib/market-realness.js';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

const MAX_CONCURRENT = Math.max(1, Number(process.env.SNIPER_LLM_MAX_CONCURRENT || 3));
const TIMEOUT_MS = Math.max(2_000, Number(process.env.SNIPER_LLM_TIMEOUT_MS || 9_000));
const VERDICT_TTL_MS = 10 * 60_000;

let _active = 0;
const _verdicts = new Map(); // `${mint}:${model}` → { promise|value, ts }

const SYSTEM_PROMPT = [
	'You are the buy-side judge for an autonomous pump.fun sniper on Solana.',
	'You will be shown one brand-new token launch. Decide whether a small,',
	'time-boxed momentum position (held minutes, hard stop-loss) is worth taking.',
	'Weigh: name/ticker memetic quality, narrative timing, socials, the creator\'s',
	'launch history, the size of the dev\'s initial buy, and market cap.',
	'CRUCIAL: when market data is shown, judge the CHART like an experienced trader.',
	'A big opening candle that then stairsteps up on a handful of wallets with no',
	'sellers is a PAINTED chart meant to trap momentum bots, not real demand: skip',
	'it. Genuine momentum has a real two-sided market (many distinct buyers AND real',
	'sellers). A high market_realness score is a strong buy signal; a painted-pattern',
	'warning is a strong skip.',
	'Most launches are worthless; be selective, but you are the only judge, there',
	'are no other filters after you besides honeypot/safety checks.',
	'Respond with ONLY a JSON object, no prose, no code fences:',
	'{"buy": true|false, "confidence": <0..1>, "thesis": "<one short sentence>"}',
].join(' ');

function launchBrief(mint) {
	const fields = {
		symbol: mint.symbol || null,
		name: mint.name || null,
		description: mint.description || null,
		twitter: mint.twitter || null,
		telegram: mint.telegram || null,
		website: mint.website || null,
		market_cap_usd: mint.market_cap_usd != null ? Math.round(Number(mint.market_cap_usd)) : null,
		dev_initial_buy_sol: mint.initial_buy_sol != null ? Number(mint.initial_buy_sol) : null,
		creator_prior_launches: mint.creator_launches ?? null,
		creator_graduated_coins: mint.creator_graduated ?? null,
	};
	const lines = Object.entries(fields)
		.filter(([, v]) => v != null && v !== '')
		.map(([k, v]) => `${k}: ${v}`);

	// The market shape the operator reads off the chart, handed to the model as
	// data: buyer/seller diversity, concentration, timing. This is what separates a
	// real mover from a painted stairstep, and without it the model is judging a
	// coin blind on its name and socials the way a bot does.
	const sig = mint.signals || mint.intel_signals || null;
	if (sig) {
		const m = assessMarketRealness(sig);
		if (!m.flags.includes('insufficient_trades')) {
			lines.push(`market: ${m.read}`);
			lines.push(`market_realness: ${m.realness} (0=painted/one-sided, 1=genuine two-sided market)`);
			if (m.painted) lines.push('WARNING: this matches a painted-stairstep pattern (a rise with no real two-sided market), which historically wins far below the base rate.');
		}
	}
	return `New pump.fun launch:\n${lines.join('\n')}`;
}

// Parse the model's reply into a verdict. Tolerates fences/prose around the
// JSON but rejects anything without the three required fields.
export function parseVerdict(text) {
	if (!text) return null;
	const match = String(text).match(/\{[\s\S]*\}/);
	if (!match) return null;
	let obj;
	try {
		obj = JSON.parse(match[0]);
	} catch {
		return null;
	}
	if (typeof obj.buy !== 'boolean') return null;
	const confidence = Number(obj.confidence);
	if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;
	return { buy: obj.buy, confidence, thesis: String(obj.thesis || '').slice(0, 280) };
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
				'x-title': 'three.ws agent-sniper',
			},
			body: JSON.stringify({
				model,
				max_tokens: 200,
				temperature: 0.2,
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

async function judge(mint, model) {
	const user = launchBrief(mint);
	const t0 = Date.now();
	try {
		const text = await askOpenRouter({ model, user });
		const verdict = parseVerdict(text);
		if (verdict) return { ...verdict, model, answeredBy: model, latencyMs: Date.now() - t0 };
		throw new Error('unparseable verdict');
	} catch (err) {
		// Free-first platform chain as the backstop, the experiment arm keeps
		// running through an OpenRouter outage, honestly labeled.
		log.warn('llm judge openrouter failed, free-chain fallback', { mint: mint.mint, model, err: err?.message });
		const res = await llmComplete({ system: SYSTEM_PROMPT, user, maxTokens: 200, timeoutMs: TIMEOUT_MS });
		const verdict = parseVerdict(res?.text ?? res);
		if (!verdict) return null;
		return { ...verdict, model: `fallback:${res?.provider || 'free-chain'}`, answeredBy: res?.model || res?.provider || 'free-chain', latencyMs: Date.now() - t0 };
	}
}

// Persist a verdict into the judgment ledger, buys AND skips, so each model's
// calls can later be scored against pump_coin_outcomes (the counterfactuals a
// trade record can't capture). Fire-and-forget: a ledger hiccup never delays
// or blocks the buy path. Keyed by the REQUESTED model (the experiment arm's
// identity); answered_by records who actually replied when the chain fell back.
function recordVerdict({ mint, network, requestedModel, verdict }) {
	sql`
		insert into sniper_llm_verdicts (mint, network, model, buy, confidence, thesis, latency_ms, answered_by)
		values (${mint}, ${network}, ${requestedModel}, ${verdict.buy}, ${verdict.confidence},
		        ${verdict.thesis || null}, ${verdict.latencyMs ?? null}, ${verdict.answeredBy || null})
		on conflict (mint, network, model) do nothing
	`.catch((err) => log.warn('llm verdict record failed', { mint, model: requestedModel, err: err?.message }));
}

/**
 * Judge one launch for one strategy. Returns a verdict
 * `{ buy, confidence, thesis, model, latencyMs }` or null (saturated / failed,
 * null never buys). Verdicts are shared per (mint, model) and cached briefly so
 * a fleet of same-model strategies costs one call per launch.
 */
export async function judgeLaunch(mint, strat) {
	const model = strat.llm_model || 'openrouter/auto';
	const key = `${mint.mint}:${model}`;
	const cached = _verdicts.get(key);
	if (cached && Date.now() - cached.ts < VERDICT_TTL_MS) return cached.promise;

	if (_active >= MAX_CONCURRENT) {
		log.info('llm judge saturated, skipping launch', { mint: mint.mint, model, active: _active });
		return null;
	}
	_active++;
	const promise = judge(mint, model)
		.then((verdict) => {
			if (verdict) recordVerdict({ mint: mint.mint, network: strat.network || 'mainnet', requestedModel: model, verdict });
			return verdict;
		})
		.catch((err) => {
			log.warn('llm judge failed', { mint: mint.mint, model, err: err?.message });
			return null;
		})
		.finally(() => {
			_active--;
		});
	_verdicts.set(key, { promise, ts: Date.now() });
	if (_verdicts.size > 500) {
		const cutoff = Date.now() - VERDICT_TTL_MS;
		for (const [k, v] of _verdicts) if (v.ts < cutoff) _verdicts.delete(k);
	}
	return promise;
}

/** Test seam: reset shared state. */
export function _resetLlmJudge() {
	_verdicts.clear();
	_active = 0;
}
