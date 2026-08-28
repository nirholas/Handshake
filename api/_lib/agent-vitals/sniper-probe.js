// @ts-check
/**
 * Live readings for the sniper vitals chart.
 *
 * Everything here talks to a real system: the strategies table, the position
 * ledger, a Solana RPC, the launch feed, the model chain, and the deployed
 * worker image. Nothing is sampled or simulated.
 *
 * The gathering is fleet-wide on purpose. The readings that cost something
 * (feed freshness, model-chain reachability, RPC liveness, image age) are
 * identical for every arm on a network, so they are taken ONCE and shared. Only
 * the per-arm wallet balance is read per arm, and those go out concurrently.
 * Attesting twelve arms therefore costs one feed read, one model probe and one
 * image read, not twelve of each: the difference between a report an operator
 * runs casually and one they avoid.
 */

import { sql } from '../db.js';
import { solanaConnection } from '../agent-pumpfun.js';
import { recentPumpLaunches } from '../pump-launch-feed.js';
import { providerChain, llmComplete } from '../llm.js';
import { getGcpAccessToken, gcpAuthConfigured } from '../gcp-auth.js';
import { sniperChart, entryActivity, contradiction } from './sniper-chart.js';

/** Cloud Run service that executes every sniper arm. */
export const SNIPER_SERVICE = 'agent-sniper';

const asIso = (v) => (v ? new Date(v).toISOString() : null);

/**
 * Is a model chain actually reachable? Sends the smallest possible completion
 * through the real provider chain and reports which rung answered.
 *
 * This is the probe that would have caught the outage directly: the chain was
 * configured, keyed, and answering 404/402/403 on every rung while the worker
 * logged a cheerful "chain exhausted" and carried on.
 *
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<{ ok: boolean|null, detail: string }>}
 */
export async function probeCognition(opts = {}) {
	const timeoutMs = opts.timeoutMs ?? 15_000;
	let chain;
	try {
		chain = providerChain({});
	} catch (err) {
		return { ok: null, detail: `provider chain would not build: ${err?.message || 'error'}` };
	}
	if (!Array.isArray(chain) || chain.length === 0) {
		return { ok: false, detail: 'no model providers are configured' };
	}

	try {
		const answer = await llmComplete({
			system: 'Reply with the single word OK.',
			user: 'ping',
			maxTokens: 8,
			timeoutMs,
		});
		const who = answer?.provider || answer?.model || 'a provider';
		return { ok: true, detail: `${who} answered across ${chain.length} configured rung(s)` };
	} catch (err) {
		const message = String(err?.message || 'error').slice(0, 200);
		// Exhaustion is the definitive case and it does NOT arrive as a named
		// error: llmComplete rethrows the LAST provider's own error (an HTTP 401
		// from one rung, say) with the full `attempts` array attached. Matching on
		// the error type alone read a total chain outage as merely unreadable,
		// which is the difference between "your agents cannot think" and "we could
		// not check". The attempts array is the real signal.
		const attempts = Array.isArray(err?.attempts) ? err.attempts : [];
		if (attempts.length) {
			const tried = attempts.map((a) => `${a.provider}=${a.skipped || a.error}`).join(' | ');
			return {
				ok: false,
				detail: `every rung failed (${attempts.length} tried): ${tried}`.slice(0, 400),
			};
		}
		if (err?.name === 'LlmUnavailableError') {
			return { ok: false, detail: 'no model provider is reachable' };
		}
		return { ok: null, detail: `model probe inconclusive: ${message}` };
	}
}

/**
 * Is a Solana RPC answering? Reads the current slot, the cheapest call that
 * proves the endpoint is both reachable and synced enough to quote against.
 *
 * @param {string} network
 * @returns {Promise<{ ok: boolean|null, detail: string }>}
 */
export async function probeRpc(network = 'mainnet') {
	try {
		const slot = await solanaConnection(network).getSlot('confirmed');
		return Number.isFinite(slot) && slot > 0
			? { ok: true, detail: `slot ${slot}` }
			: { ok: false, detail: 'RPC returned no slot' };
	} catch (err) {
		// Unreachable is genuinely undecidable from here: the endpoint may be fine
		// and this machine's egress may not be.
		return { ok: null, detail: `RPC unreachable: ${String(err?.message || 'error').slice(0, 120)}` };
	}
}

/**
 * When did the launch feed last produce a candidate? Read from the live feed
 * rather than a cursor table so a stalled ingest cannot look fresh.
 *
 * @param {string} network
 * @returns {Promise<string|null>}
 */
export async function probeFeedFreshness(network = 'mainnet') {
	// The feed quotes created_at as a NUMERIC epoch in ms. Date.parse() on a
	// number stringifies it first and returns NaN, which silently reported a
	// perfectly live feed as unread.
	const asEpoch = (v) => {
		if (typeof v === 'number') return Number.isFinite(v) ? v : null;
		if (typeof v === 'string' && v) {
			const parsed = Date.parse(v);
			return Number.isFinite(parsed) ? parsed : null;
		}
		return null;
	};
	try {
		const launches = await recentPumpLaunches({ network, limit: 10 });
		let newest = 0;
		for (const launch of launches || []) {
			const t = asEpoch(launch?.created_at ?? launch?.createdAt ?? launch?.timestamp);
			if (t !== null && t > newest) newest = t;
		}
		return newest ? new Date(newest).toISOString() : null;
	} catch {
		return null;
	}
}

/**
 * Build time of the image the worker is actually running.
 *
 * This is the reading nothing else on the platform takes, and it is the one
 * that closed the case: the code fix was seventeen days old in git and sixteen
 * days newer than the running image. Uptime, readiness and revision checks all
 * reported green because the container was, in fact, running perfectly. It was
 * running the wrong code.
 *
 * Uses the Artifact Registry REST API through the repo's own token helper
 * (api/_lib/gcp-auth.js), which mints from the metadata server or a service
 * account without pulling in google-auth-library. No credential returns null
 * (unread), never a false verdict.
 *
 * @param {{ project?: string, location?: string, repository?: string, image?: string }} [opts]
 * @returns {Promise<string|null>}
 */
export async function probeDeployedImageAge(opts = {}) {
	const project = opts.project || process.env.GOOGLE_CLOUD_PROJECT || 'aerial-vehicle-466722-p5';
	const location = opts.location || 'us-central1';
	const repository = opts.repository || 'workers';
	const image = opts.image || SNIPER_SERVICE;

	if (!gcpAuthConfigured()) return null;
	let token = null;
	try {
		token = await getGcpAccessToken();
	} catch {
		return null;
	}
	if (!token) return null;

	try {
		const url = `https://artifactregistry.googleapis.com/v1/projects/${project}/locations/${location}` +
			`/repositories/${repository}/packages/${image}/versions?orderBy=createTime%20desc&pageSize=1`;
		const res = await fetch(url, {
			headers: { authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(15_000),
		});
		if (!res.ok) return null;
		const body = await res.json();
		return body?.versions?.[0]?.createTime || null;
	} catch {
		return null;
	}
}

/**
 * Every armed arm on a network, with the per-arm ledger facts the chart needs.
 * @param {string} network
 * @returns {Promise<object[]>}
 */
export async function loadArms(network = 'mainnet') {
	return sql`
		SELECT s.*, i.name AS agent_name,
		       (SELECT max(p.opened_at) FROM agent_sniper_positions p WHERE p.strategy_id = s.id) AS last_entry_at,
		       (SELECT p.wallet FROM agent_sniper_positions p
		         WHERE p.strategy_id = s.id AND p.wallet IS NOT NULL AND p.wallet <> 'pending'
		         ORDER BY p.opened_at DESC LIMIT 1) AS wallet
		  FROM agent_sniper_strategies s
		  LEFT JOIN agent_identities i ON i.id = s.agent_id
		 WHERE s.network = ${network} AND s.enabled = true
		 ORDER BY i.name NULLS LAST`;
}

/**
 * Live SOL balances for a set of addresses, concurrently. An address that
 * cannot be read maps to null so the solvency probe reports `unknown` instead
 * of inventing a zero.
 *
 * @param {string[]} addresses
 * @param {string} network
 * @returns {Promise<Map<string, number|null>>}
 */
export async function loadBalances(addresses, network = 'mainnet') {
	const unique = [...new Set(addresses.filter(Boolean))];
	/** @type {Map<string, number|null>} */
	const out = new Map();
	if (!unique.length) return out;

	const connection = solanaConnection(network);
	const { PublicKey } = await import('@solana/web3.js');
	await Promise.all(unique.map(async (address) => {
		try {
			const lamports = await connection.getBalance(new PublicKey(address), 'confirmed');
			out.set(address, lamports / 1e9);
		} catch {
			out.set(address, null);
		}
	}));
	return out;
}

/**
 * @typedef {object} ArmAttestation
 * @property {string} agentId
 * @property {string} name
 * @property {string|null} label
 * @property {string|null} wallet
 * @property {boolean} stalled
 * @property {string} activity
 * @property {string|null} contradiction  set when the ledger disproves the verdict
 * @property {import('../../../packages/agent-vitals/src/index.js').Verdict} verdict
 */

/**
 * Attest every armed arm on a network against live systems.
 *
 * `imageBuiltAt` may be supplied by the caller. The in-process probe reads
 * Artifact Registry over HTTP with a platform credential, which a developer
 * machine authenticated only through the gcloud CLI does not have; an operator
 * tool can read it from gcloud and pass it in rather than lose the reading that
 * matters most.
 *
 * @param {{ network?: string, now?: number, includeCognition?: boolean,
 *           includeImage?: boolean, imageBuiltAt?: string|null }} [opts]
 * @returns {Promise<{ network: string, at: string, shared: object, arms: ArmAttestation[] }>}
 */
export async function attestFleet(opts = {}) {
	const network = opts.network || 'mainnet';
	const now = opts.now ?? Date.now();

	const arms = await loadArms(network);
	const balances = await loadBalances(arms.map((a) => a.wallet), network);

	// The shared readings: taken once for the whole fleet, in parallel.
	const [rpc, feedFreshAt, cognition, imageBuiltAt] = await Promise.all([
		probeRpc(network),
		probeFeedFreshness(network),
		opts.includeCognition === false
			? Promise.resolve({ ok: null, detail: 'model probe skipped' })
			: probeCognition(),
		opts.imageBuiltAt !== undefined
			? Promise.resolve(opts.imageBuiltAt)
			: opts.includeImage === false ? Promise.resolve(null) : probeDeployedImageAge(),
	]);

	const attestations = await Promise.all(arms.map(async (strategy) => {
		const wallet = strategy.wallet || null;
		const activity = entryActivity(strategy.last_entry_at, { now });
		const verdict = await sniperChart({
			strategy,
			wallet,
			balanceSol: wallet ? balances.get(wallet) ?? null : null,
			lastEntryAt: strategy.last_entry_at,
			feedFreshAt,
			imageBuiltAt,
			cognition,
			rpc,
		}, { now }).attest();

		return {
			agentId: strategy.agent_id,
			name: strategy.agent_name || strategy.agent_id,
			label: strategy.label || null,
			wallet,
			stalled: activity.stalled,
			activity: activity.detail,
			contradiction: contradiction(verdict.can.enter, strategy.last_entry_at, { now }),
			verdict,
		};
	}));

	return {
		network,
		at: new Date(now).toISOString(),
		shared: {
			rpc,
			cognition,
			feed_fresh_at: asIso(feedFreshAt),
			image_built_at: asIso(imageBuiltAt),
		},
		arms: attestations,
	};
}

/**
 * The fleet's headline: how many arms can act, and the deduplicated work queue
 * of root causes across all of them. One stale deployment blocking twelve arms
 * is one item here, not twelve.
 *
 * @param {ArmAttestation[]} arms
 * A cause keeps every affected arm and every DISTINCT remedy, because a shared
 * cause does not imply a shared fix: one stale image is one redeploy, but five
 * starved wallets are five different transfers to five different addresses.
 * Collapsing those to a single representative remedy prints one arm's wallet as
 * the fix for the other four.
 *
 * @returns {{ total: number, ready: number, unable: number, unknown: number,
 *            canExit: number, stalledButCapable: string[], contradictions: string[],
 *            rootCauses: Array<{ id: string, arms: string[], remedies: string[], details: string[] }> }}
 */
export function summarizeFleet(arms) {
	let ready = 0;
	let unable = 0;
	let unknown = 0;
	let canExit = 0;
	/** @type {string[]} */
	const stalledButCapable = [];
	/** @type {string[]} */
	const contradictions = [];
	/** @type {Map<string, { id: string, arms: string[], remedies: string[], details: string[] }>} */
	const causes = new Map();

	for (const arm of arms) {
		const enter = arm.verdict.can.enter;
		if (enter === true) ready += 1;
		else if (enter === false) unable += 1;
		else unknown += 1;
		if (arm.verdict.can.exit === true) canExit += 1;

		// An arm that is fully capable and still silent is the genuinely
		// interesting case: nothing is broken, so its entry filters are the answer.
		if (enter === true && arm.stalled) stalledButCapable.push(arm.name);
		if (arm.contradiction) contradictions.push(`${arm.name}: ${arm.contradiction}`);

		for (const root of arm.verdict.rootCauses) {
			let cause = causes.get(root.id);
			if (!cause) {
				cause = { id: root.id, arms: [], remedies: [], details: [] };
				causes.set(root.id, cause);
			}
			cause.arms.push(arm.name);
			if (root.remedy && !cause.remedies.includes(root.remedy)) cause.remedies.push(root.remedy);
			if (root.detail && !cause.details.includes(root.detail)) cause.details.push(root.detail);
		}
	}

	return {
		total: arms.length,
		ready,
		unable,
		unknown,
		canExit,
		stalledButCapable,
		contradictions,
		rootCauses: [...causes.values()].sort((a, b) => b.arms.length - a.arms.length || a.id.localeCompare(b.id)),
	};
}
