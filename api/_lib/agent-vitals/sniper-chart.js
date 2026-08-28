// @ts-check
/**
 * The three.ws sniper fleet expressed as an @three-ws/agent-vitals chart.
 *
 * This is the concrete answer to "why is this armed bot not trading", built
 * from the failure that motivated the whole library. On 2026-08-28 ten of
 * twelve armed arms had not attempted an entry in weeks while the worker
 * reported Ready:True with minScale 1, the launch feed was flowing, and every
 * strategy row said enabled = true. Three independent causes were stacked:
 *
 *   - the deployed worker image predated the commit that moved every free LLM
 *     rung onto models that still exist, so the whole chain answered 404/410;
 *   - the model providers behind the surviving rungs were out of credit (402)
 *     or on a billing hold (403);
 *   - several arm wallets could not fund a single entry.
 *
 * Every one of those was individually invisible, and a flat checklist would
 * have shown three red rows without saying which to chase. The `needs` edges
 * below encode the real causality: for an arm that needs a model, cognition
 * cannot be judged while the image is stale, and an entry cannot be judged
 * while cognition is down. Attesting this chart returns the deepest cause and
 * the command that fixes it.
 *
 * Every probe reads a real system: the strategies table, the position ledger,
 * a Solana RPC, the live launch feed, the deployed image digest. Nothing here
 * is sampled, cached or simulated.
 *
 * @example
 * import { sniperChart } from './api/_lib/agent-vitals/sniper-chart.js';
 * const verdict = await sniperChart({ strategy, balanceSol }).attest();
 * verdict.can.enter;      // false
 * verdict.explain();      // 'cannot enter because cognition is blocked, because ...'
 */

import { vitals } from '../../../packages/agent-vitals/src/index.js';
import { walletTradeState } from '../sniper-solvency.js';
import { fundTargetSol } from '../agent-funding-policy.js';

/** How long an armed arm may go without ATTEMPTING an entry before it is stalled. */
export const STALE_ENTRY_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How stale the launch feed may be before an arm has nothing to look at. The
 * pump.fun feed produces candidates continuously, so a gap this long is an
 * upstream outage, not a quiet market.
 */
export const STALE_FEED_MS = 30 * 60 * 1000;

/** A worker image older than this is a deploy-drift suspect, not a fresh rollout. */
export const STALE_IMAGE_MS = 7 * 24 * 60 * 60 * 1000;

const SUBMIT_WORKER =
	'gcloud builds submit --config workers/agent-sniper/cloudbuild.yaml --region us-central1 ' +
	'--project aerial-vehicle-466722-p5 --substitutions=SHORT_SHA=manual$(date +%s)';

const humanAge = (ms) => {
	if (!Number.isFinite(ms) || ms < 0) return 'unknown age';
	const days = Math.floor(ms / 86_400_000);
	if (days >= 1) return `${days} day${days === 1 ? '' : 's'}`;
	const hours = Math.floor(ms / 3_600_000);
	if (hours >= 1) return `${hours} hour${hours === 1 ? '' : 's'}`;
	return `${Math.max(1, Math.floor(ms / 60_000))} min`;
};

/**
 * @typedef {object} SniperArmInput
 * @property {object} strategy            a row from agent_sniper_strategies
 * @property {number|null} [balanceSol]   live wallet balance; null when unread
 * @property {string|null} [wallet]       the arm's trading wallet address
 * @property {Date|string|null} [lastEntryAt]  most recent entry ATTEMPT
 * @property {Date|string|null} [feedFreshAt]  most recent launch seen by the feed
 * @property {Date|string|null} [imageBuiltAt] build time of the running worker image
 * @property {{ ok: boolean|null, detail?: string }} [cognition] model-chain reachability
 * @property {{ ok: boolean|null, detail?: string }} [rpc]       RPC reachability
 */

const asTime = (v) => {
	if (!v) return null;
	const t = v instanceof Date ? v.getTime() : Date.parse(String(v));
	return Number.isFinite(t) ? t : null;
};

/**
 * Build the vitals chart for one sniper arm.
 *
 * Readings are injected rather than fetched here so the chart stays pure and
 * a caller sweeping a whole fleet pays for one RPC round and one feed read
 * instead of one per arm. `api/_lib/agent-vitals/sniper-probe.js` does that
 * gathering against the live systems.
 *
 * @param {SniperArmInput} input
 * @param {{ now?: number }} [opts]
 * @returns {import('../../../packages/agent-vitals/src/index.js').VitalsChart}
 */
export function sniperChart(input, opts = {}) {
	const now = opts.now ?? Date.now();
	const s = input.strategy || {};
	const perTradeSol = Number(s.per_trade_lamports || 0) / 1e9;
	const label = s.label || s.agent_name || s.agent_id || 'arm';

	const chart = vitals({ agent: String(label), timeoutMs: 8_000 });

	// ── Layer 0: the deployment itself ───────────────────────────────────────
	// First because it CAUSES the failures below it. An image that predates the
	// fix for a dead dependency will keep reproducing that dependency's failure
	// forever, and probing the dependency only rediscovers a known answer.
	chart.vital('deploy-fresh', {
		describe: 'the running worker image is recent enough to contain current config',
		remedy: SUBMIT_WORKER,
		probe: () => {
			const built = asTime(input.imageBuiltAt);
			if (built === null) return { ok: null, detail: 'image build time unread' };
			const age = now - built;
			return {
				ok: age <= STALE_IMAGE_MS,
				detail: `worker image is ${humanAge(age)} old`,
				data: { ageMs: age, builtAt: new Date(built).toISOString() },
			};
		},
	});

	// ── Layer 0: permission ──────────────────────────────────────────────────
	// Deliberately independent of the deployment: an owner who disarmed an arm
	// gets "off by choice", never a stack of infrastructure noise.
	chart.vital('armed', {
		describe: 'the owner has this arm enabled and not killed',
		remedy: 'enable the strategy (or clear its kill switch) from the agent page',
		probe: () => {
			if (s.kill_switch) return { ok: false, detail: 'kill switch engaged on the strategy' };
			if (!s.enabled) return { ok: false, detail: 'strategy is disabled' };
			return { ok: true };
		},
	});

	// ── Layer 0: money ───────────────────────────────────────────────────────
	// Asked of walletTradeState(), which calls the executor's own resolveEntrySize().
	// Re-deriving the threshold here is exactly how a report drifts into calling a
	// wallet tradeable that the executor sits out.
	chart.vital('solvency', {
		describe: 'the wallet can fund at least one entry at the executor\'s own sizing rule',
		remedy: ({ data }) => {
			const deficit = Number(data && typeof data === 'object' ? data.deficitSol : 0);
			const target = input.wallet || 'the arm wallet';
			return deficit > 0
				? `send ${deficit.toFixed(4)} SOL to ${target} (or let the auto-funder refill it)`
				: `fund ${target}`;
		},
		probe: () => {
			if (input.balanceSol == null || !Number.isFinite(Number(input.balanceSol))) {
				// An unread balance is not a balance of zero. Reporting it as down
				// would page an operator to a healthy fleet on one RPC blip.
				return { ok: null, detail: 'wallet balance unread' };
			}
			const balanceSol = Number(input.balanceSol);
			const state = walletTradeState(balanceSol, perTradeSol);
			const deficitSol = state === 'starved' ? Math.max(0, fundTargetSol({ perTradeSol }) - balanceSol) : 0;
			return {
				// 'shrunk' still trades, just below the configured size. Calling that
				// a failure would mark a working arm dead.
				ok: state !== 'starved',
				detail: `${balanceSol.toFixed(6)} SOL against a ${perTradeSol} SOL entry (${state})`,
				data: { state, balanceSol, perTradeSol, deficitSol },
			};
		},
	});

	// ── Layer 0: the outside world ───────────────────────────────────────────
	chart.vital('rpc', {
		describe: 'a Solana RPC is answering, so a quote and a broadcast are possible',
		remedy: 'check SOLANA_RPC_URL and the provider status; see docs/ops/solana-rpc-lanes.md',
		probe: () => input.rpc ?? { ok: null, detail: 'RPC not probed' },
	});

	chart.vital('feed', {
		describe: 'the launch feed is producing candidates to evaluate',
		remedy: 'check /api/cron/pumpfun-monitor and the upstream pump.fun feed',
		probe: () => {
			const fresh = asTime(input.feedFreshAt);
			if (fresh === null) return { ok: null, detail: 'feed freshness unread' };
			const age = now - fresh;
			return { ok: age <= STALE_FEED_MS, detail: `newest launch seen ${humanAge(age)} ago`, data: { ageMs: age } };
		},
	});

	// ── Layer 1: thinking, which a stale image can break ─────────────────────
	// The deploy-fresh edge exists ONLY for an arm that actually needs a model.
	// A stale image is a hypothesis about why a model chain died, not by itself a
	// reason an agent cannot act, and wiring it as a universal precondition said
	// so: it reported an arm that had entered a position two minutes earlier, on
	// that very image, as definitively unable. Live evidence beats a proxy every
	// time, so the proxy only applies where it can actually bite.
	const needsModel = s.decision_mode === 'llm';
	chart.vital('cognition', {
		describe: needsModel
			? 'the arm can reach a model and get a buy/skip decision'
			: 'this arm decides by rules and needs no model',
		needs: needsModel ? ['deploy-fresh'] : [],
		remedy: 'restore a working rung in api/_lib/llm.js: top up provider credits or clear the GCP billing hold',
		probe: () => {
			if (!needsModel) return { ok: true, detail: 'rules arm: no model required' };
			return input.cognition ?? { ok: null, detail: 'model chain not probed' };
		},
	});

	// ── Layer 2: the capabilities ────────────────────────────────────────────
	chart.capability('enter', {
		describe: 'open a new position if a qualifying launch appeared right now',
		needs: ['armed', 'solvency', 'rpc', 'feed', 'cognition'],
	});

	// Exiting deliberately needs neither the feed nor a model. A fleet that can
	// still close its open risk is not fully dead, and collapsing that distinction
	// is how an operator concludes the positions are stranded when they are not.
	chart.capability('exit', {
		describe: 'close an open position (needs no model and no launch feed)',
		needs: ['rpc'],
	});

	return chart;
}

/**
 * How recently an entry attempt still counts as proof the arm could act. Short
 * on purpose: it is evidence about the state of the world at that moment, and
 * the world moves.
 */
export const OBSERVED_ACTING_MS = 60 * 60 * 1000;

/**
 * Does the attestation contradict what the arm was observed doing?
 *
 * A capability model is a model, and models are wrong. This one was: an early
 * revision made every arm depend on deployment freshness, and confidently
 * reported an arm as unable to act while that arm was opening positions every
 * few minutes on the very image being complained about.
 *
 * A health tool that cannot notice it is wrong will be trusted right up until
 * it matters. So the ledger gets a vote: if the graph says `unable` and the arm
 * demonstrably acted inside the observation window, the graph is wrong and says
 * so, loudly, instead of quietly winning the argument against reality.
 *
 * @param {'ready'|'unable'|'unknown'|boolean|null} verdictStatus  can.enter, or a capability status
 * @param {Date|string|null|undefined} lastEntryAt
 * @param {{ now?: number }} [opts]
 * @returns {string|null} the contradiction, or null when the model and the ledger agree
 */
export function contradiction(verdictStatus, lastEntryAt, opts = {}) {
	const unable = verdictStatus === false || verdictStatus === 'unable';
	if (!unable) return null;
	const now = opts.now ?? Date.now();
	const last = asTime(lastEntryAt);
	if (last === null) return null;
	const ageMs = now - last;
	if (ageMs > OBSERVED_ACTING_MS) return null;
	return `attested UNABLE but this arm attempted an entry ${humanAge(ageMs)} ago: ` +
		'the vitals model is wrong, not the arm';
}

/**
 * Was this arm attempting entries recently? Kept beside the chart rather than
 * inside it because it is evidence, not a precondition: an arm can be perfectly
 * capable and simply have found nothing it liked. A stalled arm whose vitals are
 * all `up` is the interesting case, and it means the filters are the answer.
 *
 * @param {Date|string|null|undefined} lastEntryAt
 * @param {{ now?: number }} [opts]
 * @returns {{ stalled: boolean, ageMs: number|null, detail: string }}
 */
export function entryActivity(lastEntryAt, opts = {}) {
	const now = opts.now ?? Date.now();
	const last = asTime(lastEntryAt);
	if (last === null) return { stalled: true, ageMs: null, detail: 'never attempted an entry' };
	const ageMs = now - last;
	return {
		stalled: ageMs > STALE_ENTRY_MS,
		ageMs,
		detail: `last entry attempt ${humanAge(ageMs)} ago`,
	};
}
