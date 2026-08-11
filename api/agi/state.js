// GET /api/agi/state: the live cognitive state of the platform's narrow AGI,
// a single, real, autonomous agent that is superhuman at exactly ONE thing
// (trading memecoins on pump.fun, Solana) and deliberately nothing else.
//
// Public, read-only. The "AGI" is always a real, designated agent, never sampled,
// never faked. It is resolved, in order:
//   1. ?agent=<uuid>          inspect any public agent through the AGI lens
//   2. AGI_AGENT_ID env var   the platform's anointed flagship, when set
//   3. auto                   the most-proven public pump.fun trader on the
//                             platform right now (most closed positions, then
//                             most recent), chosen deterministically from real
//                             on-chain track record (same spirit as
//                             api/agents/featured.js: real data, no hardcode)
//
// It then composes that agent's identity, its explainable Reasoning-Ledger
// reputation, its chain-proven trading performance, its open positions, and its
// most recent decisions, then derives a cognition vector (valence/arousal/
// conviction plus an emotional beat) so the 3D body on /agi can physically embody
// what the mind is doing. The doctrine block states the one domain it claims and
// affirms it makes no general-intelligence claim: the constraint IS the product.

import { cors, json, method, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { sql } from '../_lib/db.js';
import { getTraderStats } from '../_lib/trader-stats.js';
import { getReputationRecords, computeReputation, getDecisionsWithOutcomes } from '../_lib/reasoning-ledger.js';
import { isUuid, isValidSolanaAddress } from '../_lib/validate.js';

const NETWORKS = new Set(['mainnet', 'devnet']);

export const DOCTRINE = Object.freeze({
	// The one and only domain in which this agent claims superhuman competence.
	domain: 'memecoin trading on pump.fun · Solana',
	is_narrow: true,
	thesis:
		'Artificial general intelligence in a single domain. It reads new pump.fun ' +
		'launches, the wallet graph behind them, and the order flow faster and more ' +
		'consistently than any human, then sizes, enters, and exits on its own. ' +
		'Outside that domain it claims nothing.',
	// The refusals are the proof of focus: a narrow AGI that pretended to be general
	// would be lying. These are stated plainly so the boundary is the product.
	refusals: [
		'It will not give you financial, legal, or life advice.',
		'It does not trade equities, forex, majors, or any chain but Solana.',
		'It has no opinion outside the pump.fun order book, and says so.',
		'It cannot be talked past its spend caps, kill switch, or safety policy.',
	],
});

function solscanTx(sig, network) {
	if (!sig) return null;
	return network === 'devnet' ? `https://solscan.io/tx/${sig}?cluster=devnet` : `https://solscan.io/tx/${sig}`;
}

/**
 * Resolve which real agent IS the AGI, in priority order. `requestedId` is the
 * caller's already-validated ?agent= UUID, or an empty string. Returns
 * { id, via } or { id: null, via: 'none' } when the platform has no eligible
 * public trading agent yet (a designed "awakening" state on the page).
 */
async function resolveAgiAgent(requestedId, network) {
	if (requestedId) return { id: requestedId, via: 'query' };

	const envId = (process.env.AGI_AGENT_ID || '').trim();
	if (envId && isUuid(envId)) return { id: envId, via: 'env' };

	// Deterministic, real fallback: the public agent with the strongest on-chain
	// pump.fun track record (most closed positions, tie-broken by most recent
	// activity). A zero-trade platform collapses to "none", i.e. awakening state.
	const [row] = await sql`
		SELECT a.id,
		       COUNT(p.id) AS n,
		       MAX(COALESCE(p.closed_at, p.opened_at)) AS last_at
		FROM agent_identities a
		JOIN agent_sniper_positions p
		  ON p.agent_id = a.id AND p.network = ${network}
		WHERE a.deleted_at IS NULL AND a.is_public = true
		GROUP BY a.id
		ORDER BY n DESC, last_at DESC NULLS LAST
		LIMIT 1
	`;
	return row?.id ? { id: row.id, via: 'auto' } : { id: null, via: 'none' };
}

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

/**
 * Age of a timestamp in ms, or Infinity when it is missing or unparseable.
 * `new Date(null)` is the epoch, not an invalid date, so a null decided_at would
 * otherwise read as "56 years stale" and drop the agent into `dormant`. Unknown
 * must stay unknown: never fresh, never stale.
 */
function ageMs(ts, now) {
	if (!ts) return Infinity;
	const t = new Date(ts).getTime();
	return Number.isFinite(t) ? now - t : Infinity;
}

// Trading verbs, for decisions whose subject is not itself a coin (an exit keyed
// by a position id, say). Kept as a hint on top of the shape test below, never as
// the only signal, so a new verb still classifies correctly the moment its
// subject is a mint.
const TRADE_KINDS = new Set(['snipe', 'buy', 'sell', 'entry', 'exit', 'trade', 'scale', 'hold']);

export function shapeDecision(d, network) {
	const reconciled = d.outcome_status != null && d.was_correct != null;
	// `subject_ref` is a free-form pointer: a coin mint for a trading call, but an
	// internal id (a tuner arm, say) for an operational one. Publishing the latter
	// as `mint` sent the page to solscan.io/token/<uuid>, a link to nothing. Only a
	// real base58 address is a mint; everything else keeps its raw ref and is
	// classified as operations so a reader can tell the two apart.
	const subjectRef = d.subject_ref ?? null;
	const mint = isValidSolanaAddress(subjectRef) ? subjectRef : null;
	const kind = d.kind;
	return {
		id: d.id,
		seq: Number(d.seq),
		kind,
		subject_ref: subjectRef,
		mint,
		domain: mint || TRADE_KINDS.has(String(kind || '').toLowerCase()) ? 'trade' : 'operations',
		rationale: d.rationale,
		confidence: d.confidence != null ? Number(d.confidence) : null,
		prediction: d.prediction || {},
		decided_at: d.decided_at,
		outcome: reconciled
			? {
					status: 'reconciled',
					was_correct: d.was_correct,
					pnl_sol: d.pnl_sol != null ? Number(d.pnl_sol) : null,
					impact: d.impact != null ? Number(d.impact) : null,
					proof_url: solscanTx(d.observed?.sell_sig, network),
				}
			: { status: 'pending' },
	};
}

/**
 * Derive how the AGI "feels" right now from what it actually did. Pure: every
 * input is a real, measured number. Drives the 3D body on /agi via setMood +
 * expressEmotion. Valence ∈ [-1,1] (despair→elation), arousal ∈ [0,1] (calm→
 * activated), conviction ∈ [0,1] (latest stated confidence).
 */
export function deriveCognition({ reputation, perf, decisions, now }) {
	const hasHistory = !!perf && (perf.closed_count > 0 || perf.open_count > 0);
	if (!hasHistory && (!decisions || decisions.length === 0)) {
		return {
			state: 'awakening',
			label: 'Awakening',
			summary: 'No proven trades on record yet. Watching the feed.',
			valence: 0.1,
			arousal: 0.28,
			conviction: null,
			emotion: null,
		};
	}

	const unrealized = perf ? Number(perf.unrealized_pnl_sol || 0) : 0;
	const realized = perf ? Number(perf.realized_pnl_sol || 0) : 0;
	const repDev = reputation ? (reputation.score / 100 - 0.5) : 0; // -0.5..0.5

	// Valence: how it's doing, from live unrealized P&L momentum + standing reputation.
	const valence = clamp(Math.tanh(unrealized / 2) * 0.55 + repDev * 1.2, -1, 1);

	const latest = decisions?.[0] || null;
	const latestAgeMs = latest ? ageMs(latest.decided_at, now) : Infinity;
	const recent = Number.isFinite(latestAgeMs) && latestAgeMs < 5 * 60 * 1000;
	const veryRecent = Number.isFinite(latestAgeMs) && latestAgeMs < 90 * 1000;
	const openCount = perf ? Number(perf.open_count || 0) : 0;

	// Arousal: activity + risk on the table + freshness of the last call.
	const arousal = clamp(
		0.3 + Math.min(openCount, 5) / 5 * 0.35 + (veryRecent ? 0.35 : recent ? 0.18 : 0),
		0.12,
		1,
	);

	const conviction = latest?.confidence != null ? clamp(latest.confidence, 0, 1) : null;

	// The single most recent reconciled call sets the emotional beat.
	const lastReconciled = decisions?.find((d) => d.outcome?.status === 'reconciled') || null;
	const reconciledAgeMs = lastReconciled ? ageMs(lastReconciled.decided_at, now) : Infinity;
	const reconciledRecent = Number.isFinite(reconciledAgeMs) && reconciledAgeMs < 30 * 60 * 1000;

	let state = 'watching';
	let label = 'Watching the feed';
	let emotion = null;

	if (Number.isFinite(latestAgeMs) && latestAgeMs > 60 * 60 * 1000 && openCount === 0) {
		state = 'dormant';
		label = 'Quiet, no live conviction';
	} else if (reconciledRecent && lastReconciled.outcome.was_correct === true) {
		state = 'vindicated';
		label = 'A call just paid off';
		emotion = { trigger: 'celebration', intensity: clamp(0.6 + Math.abs(repDev), 0.5, 0.95) };
	} else if (reconciledRecent && lastReconciled.outcome.was_correct === false) {
		state = 'humbled';
		label = 'A call went against it';
		emotion = { trigger: 'concern', intensity: 0.7 };
	} else if (veryRecent) {
		state = 'conviction';
		label = 'Acting on a fresh read';
		emotion = { trigger: 'curiosity', intensity: clamp(conviction ?? 0.5, 0.4, 0.9) };
	} else if (openCount > 0) {
		state = 'holding';
		label = `Managing ${openCount} open ${openCount === 1 ? 'position' : 'positions'}`;
	} else {
		state = 'hunting';
		label = 'Hunting the next launch';
	}

	const pnlBit = unrealized !== 0
		? `${unrealized >= 0 ? '+' : ''}${unrealized.toFixed(3)} SOL unrealized`
		: realized !== 0 ? `${realized >= 0 ? '+' : ''}${realized.toFixed(3)} SOL realized` : 'flat';
	const summary = `${label}. ${pnlBit}.`;

	return { state, label, summary, valence: Number(valence.toFixed(3)), arousal: Number(arousal.toFixed(3)), conviction: conviction != null ? Number(conviction.toFixed(3)) : null, emotion };
}

const PUBLIC_CACHE = Object.freeze({ 'cache-control': 'public, s-maxage=15, stale-while-revalidate=60' });

/** The designed "no eligible agent" envelope: a real 200 with nothing invented. */
function awakeningEnvelope(res, network, now) {
	return json(res, 200, {
		agent: null,
		resolved_via: 'none',
		network,
		doctrine: DOCTRINE,
		cognition: deriveCognition({ reputation: null, perf: null, decisions: [], now }),
		reputation: null,
		performance: null,
		positions: [],
		decisions: [],
		generated_at: new Date(now).toISOString(),
	}, PUBLIC_CACHE);
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, `http://${req.headers.host || 'x'}`);
	const network = NETWORKS.has(url.searchParams.get('network')) ? url.searchParams.get('network') : 'mainnet';
	const now = Date.now();

	// A malformed ?agent= must never silently resolve to some OTHER agent: the
	// caller asked to inspect one specific mind, and answering with a different
	// one is worse than an error.
	const requested = (url.searchParams.get('agent') || url.searchParams.get('id') || '').trim();
	if (requested && !isUuid(requested)) {
		return error(res, 400, 'validation_error', 'agent must be an agent UUID');
	}

	const { id: agentId, via } = await resolveAgiAgent(requested, network);

	// No eligible agent yet: a valid, designed "awakening" envelope (never a 500).
	if (!agentId) return awakeningEnvelope(res, network, now);

	// Compose the live state from the real truth layers, in parallel. The two
	// enrichment layers degrade to empty rather than failing the page. The identity
	// layer does NOT: it carries the publicness flag every other section is gated
	// on, so a swallowed failure there would mean publishing a ledger we could not
	// verify was public. Let it throw and let wrap() answer 503 with a ref.
	const [stats, repRecords, rawDecisions] = await Promise.all([
		getTraderStats({ agentId, network, window: 'all', now }),
		getReputationRecords(agentId).catch(() => []),
		// Wide enough that a burst of operational self-tuning calls cannot push every
		// trading decision out of the window the page filters over.
		getDecisionsWithOutcomes(agentId, { limit: 40 }).catch(() => []),
	]);

	// A private or missing agent never gets published, whichever path selected it.
	// An explicit ?agent= says so with a 404; env/auto (which the caller did not
	// choose) collapse to the awakening envelope rather than leaking a private
	// agent's ledger or inventing an identity for an AGI_AGENT_ID that no longer
	// resolves. Past this line `stats.agent` is always a real, public agent.
	if (!stats || stats.agent.is_public === false) {
		if (via === 'query') return error(res, 404, 'not_found', 'No such agent, or it is not public.');
		return awakeningEnvelope(res, network, now);
	}

	const reputation = repRecords.length ? computeReputation(repRecords) : null;
	const decisions = (rawDecisions || []).map((d) => shapeDecision(d, network));

	const m = stats.metrics || null;
	const performance = m
		? {
				score: m.score,
				verified: m.verified,
				confidence: m.confidence,
				closed_count: m.closed_count,
				open_count: m.open_count,
				wins: m.wins,
				losses: m.losses,
				win_rate: m.win_rate,
				realized_pnl_sol: m.realized_pnl_sol,
				realized_pnl_usd: m.realized_pnl_usd,
				unrealized_pnl_sol: m.unrealized_pnl_sol,
				unrealized_pnl_usd: m.unrealized_pnl_usd,
				roi_pct: m.roi_pct,
				best_pnl_pct: m.best_pnl_pct,
				worst_pnl_pct: m.worst_pnl_pct,
				avg_hold_seconds: m.avg_hold_seconds,
				unique_coins: m.unique_coins,
				snipe_hit_rate: m.snipe_hit_rate,
				first_active_at: m.first_active_at,
				last_active_at: m.last_active_at,
			}
		: null;

	const cognition = deriveCognition({ reputation, perf: performance, decisions, now });

	return json(res, 200, {
		agent: {
			id: stats.agent.id,
			name: stats.agent.name,
			image: stats.agent.image,
			wallet: stats.agent.wallet,
			copiers: stats.agent.copiers,
			is_public: stats.agent.is_public,
		},
		resolved_via: via,
		network,
		doctrine: DOCTRINE,
		cognition,
		reputation,
		performance,
		positions: (stats.open || []).slice(0, 8),
		decisions,
		generated_at: new Date(now).toISOString(),
	}, PUBLIC_CACHE);
});
