// @ts-check
// Agent index freshness — how far behind the chains the platform's own index is.
//
// The indexers are crons: erc8004-crawl walks EVM registry block ranges every
// 15 minutes, solana-attestations-crawl walks Solana account signatures every
// 10 minutes. When one of them stops (a dead RPC lane, a cron that quietly
// 404s, a scheduler job deleted in a console) nothing about the platform looks
// broken. /agents keeps rendering, every endpoint keeps answering 200, and the
// directory just silently stops learning about the world. That failure mode has
// no reachability signature at all, which is exactly why it belongs on the
// status surface as a NUMBER rather than a green dot.
//
// Everything here is a cheap read of cursor tables the crawls already maintain.
// No RPC calls: asking twenty chains for their head block on a public status
// endpoint would be both slow and a great way to get rate-limited.
//
// Solana leads: its lag is the one that decides the verdict when both legs are
// behind, and it is reported first.

import { sql } from '../db.js';
import { CHAINS } from '../erc8004-chains.js';
import { SOLANA_SWEEP_BATCH, SOLANA_SWEEP_PERIOD_MIN } from '../solana-agent-events.js';

/** Solana leg: worst per-agent cursor age tolerated before the index is stale. */
export const SOLANA_LAG_DEGRADED_MIN = 90;
export const SOLANA_LAG_DOWN_MIN = 360;
/** EVM leg: the crawl runs every 15 min across all chains, so it is slower. */
export const EVM_LAG_DEGRADED_MIN = 120;
export const EVM_LAG_DOWN_MIN = 480;

/**
 * Blocks behind head before an EVM chain counts as stale, and as broken.
 *
 * Cursor AGE was the only EVM signal until 2026-08-13, and it is the wrong one:
 * it proves the cron ran, not that the index caught up. A live measurement of
 * every configured chain's block production that day found five chains
 * (Arbitrum One, Arbitrum Sepolia, BNB Chain, BSC Testnet, Polygon) consuming
 * less chain time per tick than the tick itself, so their backlog grew forever
 * while their cursors stayed minutes old and the status surface said ok. These
 * thresholds are what makes that visible: roughly an hour of the fastest chain's
 * block production, and roughly half a day of it.
 */
export const EVM_BLOCKS_BEHIND_DEGRADED = 20_000;
export const EVM_BLOCKS_BEHIND_DOWN = 250_000;

/**
 * Share of Solana cursors carrying a crawl error before the leg is unhealthy.
 *
 * Cursor AGE alone could not see this class at all, because the sweep stamps
 * last_indexed_at on the FAILURE path too (deliberately, so one unreadable
 * account cannot hold the oldest-first queue head forever). The consequence is
 * that a wedged agent looks exactly as fresh as a healthy one. On 2026-09-02,
 * 1,101 of 1,604 Solana cursors were stuck on a single unresolvable-cursor
 * error, every one re-reporting it every tick, and this sensor still scored the
 * Solana leg `ok` on a 63-minute median. An error rate is the signal that makes
 * a silently non-indexing directory visible.
 */
export const SOLANA_ERROR_RATE_DEGRADED = 0.05;
export const SOLANA_ERROR_RATE_DOWN = 0.25;

const QUERY_TIMEOUT_MS = 4_000;

const minutesSince = (ts) => (ts ? Math.round((Date.now() - new Date(ts).getTime()) / 60_000) : null);

function withTimeout(promise, ms) {
	return Promise.race([
		promise,
		new Promise((_, reject) => setTimeout(() => reject(new Error('index lag query timed out')), ms)),
	]);
}

/**
 * Read the freshness of every indexer leg.
 *
 * @returns {Promise<{
 *   solana: { medianLagMin: number|null, worstLagMin: number|null, agents: number,
 *             uncrawled: number, errored: number, events: number,
 *             sweepCycleMin: number|null, batch: number },
 *   evm: { lagMin: number|null, chains: number, configuredChains: number,
 *          uncrawledChains: number, staleChains: number, worstBlocksBehind: number,
 *          behindChains: number, worstChainId: number|null, worstChainName: string|null,
 *          historyGapChains: number, historyGapBlocks: number, events: number },
 *   lastEventAt: string|null,
 *   lastIndexedAt: string|null,
 * }>}
 */
export async function readIndexLag() {
	const [solana, evm, totals] = await Promise.all([
		withTimeout(
			sql`
				SELECT
					count(*)::int AS agents,
					count(*) FILTER (WHERE cur.last_indexed_at IS NULL)::int AS uncrawled,
					count(*) FILTER (WHERE cur.error IS NOT NULL)::int AS errored,
					max(extract(epoch FROM now() - cur.last_indexed_at) / 60)::int AS worst_lag_min,
					percentile_disc(0.5) WITHIN GROUP (
						ORDER BY extract(epoch FROM now() - cur.last_indexed_at) / 60
					)::int AS median_lag_min
				FROM agent_event_cursor cur
				WHERE cur.chain = 'solana'
			`,
			QUERY_TIMEOUT_MS,
		),
		withTimeout(
			sql`
				SELECT
					count(*)::int AS chains,
					count(*) FILTER (
						WHERE updated_at < now() - (${EVM_LAG_DEGRADED_MIN} || ' minutes')::interval
					)::int AS stale_chains,
					count(*) FILTER (WHERE blocks_behind >= ${EVM_BLOCKS_BEHIND_DEGRADED})::int AS behind_chains,
					max(extract(epoch FROM now() - updated_at) / 60)::int AS lag_min,
					coalesce(max(blocks_behind), 0)::bigint AS worst_blocks_behind,
					count(*) FILTER (WHERE history_gap_blocks > 0)::int AS gap_chains,
					coalesce(sum(history_gap_blocks), 0)::bigint AS gap_blocks,
					(
						SELECT chain_id FROM erc8004_crawl_cursor
						ORDER BY blocks_behind DESC LIMIT 1
					)::int AS worst_chain_id
				FROM erc8004_crawl_cursor
			`,
			QUERY_TIMEOUT_MS,
		),
		withTimeout(
			sql`
				SELECT
					count(*) FILTER (WHERE chain = 'solana')::int AS solana_events,
					count(*) FILTER (WHERE chain = 'evm')::int AS evm_events,
					max(occurred_at) AS last_event_at,
					max(indexed_at) AS last_indexed_at
				FROM agent_onchain_events
			`,
			QUERY_TIMEOUT_MS,
		),
	]);

	const s = solana[0] || {};
	const e = evm[0] || {};
	const t = totals[0] || {};

	const worstChainId = e.worst_chain_id ?? null;

	return {
		solana: {
			medianLagMin: s.median_lag_min ?? null,
			worstLagMin: s.worst_lag_min ?? null,
			agents: s.agents ?? 0,
			uncrawled: s.uncrawled ?? 0,
			errored: s.errored ?? 0,
			events: t.solana_events ?? 0,
			batch: SOLANA_SWEEP_BATCH,
			sweepCycleMin: sweepCycleMin(s.agents ?? 0),
		},
		evm: {
			lagMin: e.lag_min ?? null,
			chains: e.chains ?? 0,
			// A chain with no cursor row at all contributes nothing and is invisible
			// to every aggregate above, so name it separately: 21 cursors against 22
			// configured chains means one chain has never been crawled once.
			configuredChains: CHAINS.length,
			uncrawledChains: Math.max(0, CHAINS.length - (e.chains ?? 0)),
			staleChains: e.stale_chains ?? 0,
			behindChains: e.behind_chains ?? 0,
			worstBlocksBehind: Number(e.worst_blocks_behind ?? 0),
			worstChainId,
			worstChainName: CHAINS.find((c) => c.id === worstChainId)?.name ?? null,
			// Blocks the crawl skipped past a provider that no longer serves them.
			// Reported, never scored: the gap is history that is already lost, so
			// letting it drive the verdict would keep the subsystem red forever
			// over something no tick can fix. It belongs on the surface anyway,
			// because skipping is what MAKES a chain report zero backlog again.
			historyGapChains: e.gap_chains ?? 0,
			historyGapBlocks: Number(e.gap_blocks ?? 0),
			events: t.evm_events ?? 0,
		},
		lastEventAt: t.last_event_at ? new Date(t.last_event_at).toISOString() : null,
		lastIndexedAt: t.last_indexed_at ? new Date(t.last_indexed_at).toISOString() : null,
	};
}

/**
 * How long one full pass over the Solana directory takes at the configured
 * sweep rate. This is the number that explains a median lag: a queue drained
 * oldest-first sits at half its cycle time, so a rising directory silently
 * raises the floor until someone measures the cycle.
 * @param {number} agents
 * @returns {number|null}
 */
export function sweepCycleMin(agents) {
	if (!agents) return null;
	return Math.ceil(agents / SOLANA_SWEEP_BATCH) * SOLANA_SWEEP_PERIOD_MIN;
}

/**
 * Roll index freshness into a subsystem verdict for /status and /api/healthz.
 * Never throws: an unreadable index reports `unknown`, like every other check.
 *
 * @returns {Promise<{ name: string, label: string, status: string, detail: string,
 *   hint?: string, metrics?: object }>}
 */
export async function gatherIndexLagHealth() {
	const base = { name: 'agent_index', label: 'Agent index freshness' };
	let lag;
	try {
		lag = await readIndexLag();
	} catch (err) {
		return { ...base, status: 'unknown', detail: err?.message || 'index lag unreadable' };
	}
	return { ...base, ...indexLagVerdict(lag), metrics: lag };
}

/**
 * Roll index freshness into a verdict. Pure: takes the shape readIndexLag()
 * returns and does no IO, so the thresholds can be exercised directly.
 *
 * @param {Awaited<ReturnType<typeof readIndexLag>>} lag
 * @returns {{ status: string, detail: string, hint?: string }}
 */
export function indexLagVerdict(lag) {
	// Nothing crawled yet is a warming-up state, not a fault: a fresh database
	// or a just-applied migration lands here before the first cron tick.
	if (lag.solana.agents === 0 && lag.evm.chains === 0) {
		return {
			status: 'unknown',
			detail: 'no crawl cursors yet — indexers have not run since the index was created',
			hint: 'Wait one cron tick (solana-attestations-crawl every 10 min, erc8004-crawl every 15 min).',
		};
	}

	const errorRate = lag.solana.agents > 0 ? lag.solana.errored / lag.solana.agents : 0;
	const solStatus = worst(
		legStatus(lag.solana.medianLagMin, SOLANA_LAG_DEGRADED_MIN, SOLANA_LAG_DOWN_MIN),
		worst(
			// A leg crawling every agent and indexing nothing is broken, not fresh.
			// That exact shape (1,576 cursors, 0 events) hid a crash in the Solana
			// crawler for two days behind a healthy-looking cursor age.
			lag.solana.agents > 0 && lag.solana.events === 0 ? 'down' : 'ok',
			legStatus(errorRate, SOLANA_ERROR_RATE_DEGRADED, SOLANA_ERROR_RATE_DOWN),
		),
	);
	const evmStatus = worst(
		legStatus(lag.evm.lagMin, EVM_LAG_DEGRADED_MIN, EVM_LAG_DOWN_MIN),
		legStatus(lag.evm.worstBlocksBehind, EVM_BLOCKS_BEHIND_DEGRADED, EVM_BLOCKS_BEHIND_DOWN),
	);

	// Solana leads, and here that is a correctness rule rather than a preference.
	// A user opening an agent profile reads the Solana index; a secondary-chain
	// cursor that is months behind changes nothing they can see. Letting the EVM
	// leg alone drive the whole subsystem to `down` reports an outage that no
	// user is experiencing, and it buries the Solana leg's real state: for weeks
	// the surface said `down` for a stale secondary cursor while the actual
	// Solana fault (two thirds of cursors wedged) was never scored at all. So an
	// EVM-only fault caps at `degraded`, with the reason stated in the detail.
	const evmOnlyFault = solStatus === 'ok' && evmStatus === 'down';
	const status = worst(solStatus, evmOnlyFault ? 'degraded' : evmStatus);

	const solPart =
		lag.solana.agents === 0
			? 'Solana: no agents queued'
			: `Solana: ${fmt(lag.solana.medianLagMin)} median lag across ${lag.solana.agents} agents` +
				(lag.solana.sweepCycleMin ? ` (${fmt(lag.solana.sweepCycleMin)} full sweep at ${lag.solana.batch}/tick)` : '') +
				(lag.solana.uncrawled ? `, ${lag.solana.uncrawled} never crawled` : '') +
				(lag.solana.errored ? `, ${lag.solana.errored} erroring (${pct(errorRate)})` : '') +
				`, ${lag.solana.events} events`;
	const evmPart =
		lag.evm.chains === 0
			? 'EVM: no chain cursors'
			: `EVM: ${fmt(lag.evm.lagMin)} worst cursor age across ${lag.evm.chains}/${lag.evm.configuredChains} chains` +
				`, worst backlog ${lag.evm.worstBlocksBehind.toLocaleString('en-US')} blocks` +
				(lag.evm.worstChainName ? ` (${lag.evm.worstChainName})` : '') +
				(lag.evm.behindChains ? `, ${lag.evm.behindChains} behind` : '') +
				(lag.evm.staleChains ? `, ${lag.evm.staleChains} stale` : '') +
				(lag.evm.uncrawledChains ? `, ${lag.evm.uncrawledChains} never crawled` : '') +
				(lag.evm.historyGapChains
					? `, ${lag.evm.historyGapChains} carrying a permanent ${lag.evm.historyGapBlocks.toLocaleString('en-US')}-block history gap`
					: '') +
				`, ${lag.evm.events} events`;

	const detail =
		`${solPart}. ${evmPart}.` +
		(evmOnlyFault ? ' Secondary-chain cursors only: the Solana index users read is fresh, so this is degraded, not down.' : '');

	const hint =
		status === 'ok'
			? undefined
			: lag.solana.agents > 0 && lag.solana.events === 0
				? 'The Solana crawl is reaching every agent and recording nothing: read the `error` column on agent_event_cursor, which the sweep stamps on failure.'
				: errorRate >= SOLANA_ERROR_RATE_DEGRADED
					? 'Solana cursors are erroring, not just lagging, and the sweep stamps last_indexed_at on the failure path so they still look fresh. Group them: select error, count(*) from agent_event_cursor where error is not null group by 1 order by 2 desc. See docs/ops/agent-index.md.'
					: lag.evm.worstBlocksBehind >= EVM_BLOCKS_BEHIND_DEGRADED
						? 'An EVM chain is behind head, not just stale: the crawl grows its block window while behind, so a backlog that keeps rising means the RPC is rejecting ranges (erc8004_crawl_cursor.last_error) or the cron is being cut short by its budget.'
						: 'Check the crawl crons: /api/cron/solana-attestations-crawl and /api/cron/erc8004-crawl. A stale cursor means the job is failing or no longer scheduled.';

	return { status, detail, ...(hint ? { hint } : {}) };
}

function legStatus(lagMin, degradedAt, downAt) {
	if (lagMin == null) return 'unknown';
	if (lagMin >= downAt) return 'down';
	if (lagMin >= degradedAt) return 'degraded';
	return 'ok';
}

const RANK = { down: 3, degraded: 2, unknown: 1, ok: 0 };
function worst(a, b) {
	return RANK[a] >= RANK[b] ? a : b;
}

function fmt(min) {
	if (min == null) return 'unknown';
	if (min < 60) return `${min}m`;
	const h = Math.floor(min / 60);
	const m = min % 60;
	return m ? `${h}h${m}m` : `${h}h`;
}

function pct(rate) {
	return `${(rate * 100).toFixed(1)}%`;
}
