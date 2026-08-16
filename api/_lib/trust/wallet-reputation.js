// Wallet Reputation — the server-authoritative I/O layer for the agent financial
// reputation score.
//
// The pure, explainable scoring formula lives in
// src/shared/agent-financial-reputation.js (computeReputation) so it is identical
// on server and client and fully unit-tested. THIS module does the real reads —
// the custody ledger (agent_custody_events), the on-chain payment index
// (pump_agent_*), realized trading P&L (agent_sniper_positions), live reserves
// vs obligations (proof-of-reserves), fork lineage, signed Solana attestations,
// and the EVM ERC-8004 reputation registry — and resolves the owner's full wallet
// set so wash-tips and self-dealing between an owner's own agents are excluded
// from the computation, not flagged after the fact.
//
// computeReputation never fabricates: a source that errors degrades to its
// zero/neutral value and is reflected as `partial` by the caller.

import { sql } from '../db.js';
import { loadAgentReputation } from './solana-bouncer.js';
import { getSolvencyInputs } from './proof-of-reserves.js';
import { threeHoldingFor } from '../coin/three-holders.js';
import { getTokenPriceUsd } from '../token/price.js';
import { ATOMICS_PER_TOKEN } from '../token/config.js';
import {
	computeReputation,
	tierFor,
	PILLARS,
	TIERS,
	MAX_SCORE,
	REPUTATION_VERSION,
} from '../../../src/shared/agent-financial-reputation.js';

// Re-export the pure primitives so existing importers (and the unit tests) keep a
// single import surface.
export { computeReputation, tierFor, PILLARS, TIERS, MAX_SCORE, REPUTATION_VERSION };

const round1 = (n) => Math.round((Number(n) || 0) * 10) / 10;

/**
 * Gather every REAL reputation input for an agent. See computeReputation for the
 * meaning of each field. Pass `lite:true` to skip the optional EVM ERC-8004 RPC
 * read and the live-reserves RPC read (used for batch list rendering); those
 * contribute ≤20 of 100 and the full per-agent endpoint always includes them, so
 * a lite score stays honest.
 *
 * @param {string} agentId
 * @param {object} [opts]
 * @param {boolean} [opts.lite=false]
 * @returns {Promise<{ inputs: object, agent: object, evidence: object, partial: boolean }>}
 */
export async function loadReputationInputs(agentId, opts = {}) {
	const lite = opts.lite === true;
	let partial = false;
	const soft = async (p, fallback) => {
		try {
			return await p;
		} catch {
			partial = true;
			return fallback;
		}
	};

	const [agent] = await sql`
		select
			id, name, user_id, created_at, avatar_id, chain_id, erc8004_agent_id,
			skill_collection_mint,
			meta->>'solana_address' as solana_address,
			wallet_address
		from agent_identities
		where id = ${agentId} and deleted_at is null
		limit 1
	`;
	if (!agent) {
		const err = new Error('agent not found');
		err.status = 404;
		err.code = 'not_found';
		throw err;
	}

	const ownWallet = agent.solana_address || '__none__';
	const ageDays = agent.created_at ? (Date.now() - new Date(agent.created_at).getTime()) / 86_400_000 : 0;

	// The owner's full agent + wallet set — the basis for self-dealing detection.
	// A "wash-tip" is a tip whose sender is ANOTHER agent the same owner controls;
	// it carries no third-party trust and must be excluded, exactly like a self-tip.
	const ownedRows = await soft(
		sql`
			select id, meta->>'solana_address' as addr
			from agent_identities
			where user_id = ${agent.user_id} and deleted_at is null
		`,
		[],
	);
	const ownedAgentIds = ownedRows.map((r) => r.id);
	const ownedWallets = ownedRows.map((r) => r.addr).filter(Boolean);
	const ownedWalletsParam = ownedWallets.length ? ownedWallets : ['__none__'];

	// Ledger: tips received, volume, cadence, wash detection — all from the ledger.
	const [ledger] = await soft(
		sql`
			select
				count(*) filter (where event_type = 'tip' and status in ('confirmed','ok'))::int
					as tip_count,
				count(distinct case
					when event_type = 'tip' and status in ('confirmed','ok')
					 and meta->>'from' is not null and not (meta->>'from' = any(${ownedWalletsParam}))
					then meta->>'from' end)::int
					as distinct_tippers,
				count(*) filter (
					where event_type = 'tip' and meta->>'from' = ${ownWallet}
				)::int as self_tip_count,
				count(*) filter (
					where event_type = 'tip' and status in ('confirmed','ok')
					 and meta->>'from' is not null and meta->>'from' <> ${ownWallet}
					 and meta->>'from' = any(${ownedWalletsParam})
				)::int as wash_tip_count,
				coalesce(sum(case
					when event_type = 'tip' and status in ('confirmed','ok')
					 and meta->>'from' is not null and meta->>'from' <> ${ownWallet}
					 and meta->>'from' = any(${ownedWalletsParam})
					then usd else 0 end), 0)::float8 as wash_tip_usd,
				coalesce(sum(case
					when event_type = 'tip' and status in ('confirmed','ok')
					 and not (meta->>'from' = any(${ownedWalletsParam}))
					then usd else 0 end), 0)::float8 as external_tip_usd,
				coalesce(sum(case
					when status in ('confirmed','ok') and usd is not null
					 and not (coalesce(meta->>'from','') = any(${ownedWalletsParam}))
					then usd else 0 end), 0)::float8
					as settled_usd,
				count(distinct date_trunc('day', created_at)) filter (
					where created_at >= now() - interval '90 days'
				)::int as active_days_90
			from agent_custody_events
			where agent_id = ${agentId}
		`,
		[{}],
	);

	// Generosity: tips this wallet GAVE to OTHER owners' agents (wash-excluded).
	const [given] = await soft(
		sql`
			select
				count(*)::int as cnt,
				coalesce(sum(usd), 0)::float8 as usd
			from agent_custody_events
			where event_type = 'tip' and status in ('confirmed','ok')
			  and meta->>'from' = ${ownWallet}
			  and not (agent_id = any(${ownedAgentIds.length ? ownedAgentIds : ['00000000-0000-0000-0000-000000000000']}))
		`,
		[{ cnt: 0, usd: 0 }],
	);

	// Reciprocity: distinct external wallets that BOTH tipped this agent AND
	// received an outbound transfer from it — a real two-way relationship.
	const [recip] = await soft(
		sql`
			select count(*)::int as pairs from (
				select distinct meta->>'from' as w
				from agent_custody_events
				where agent_id = ${agentId} and event_type = 'tip' and status in ('confirmed','ok')
				  and meta->>'from' is not null and not (meta->>'from' = any(${ownedWalletsParam}))
			) tin
			join (
				select distinct destination as w
				from agent_custody_events
				where agent_id = ${agentId} and event_type in ('withdraw','spend') and destination is not null
			) tout using (w)
		`,
		[{ pairs: 0 }],
	);

	// Trading conduct: realized P&L over CLOSED positions (a real settlement).
	// Anti-gaming — round-trips on the trader's OWN launched coins are excluded, so
	// conduct can't be farmed by pumping a token you minted. This matches the
	// verifiable trader profile (api/_lib/trader-stats.js) exactly, so the wallet
	// chip's reputation and the trader page can never disagree.
	const [trades] = await soft(
		sql`
			select
				count(*) filter (where status = 'closed')::int as closed,
				count(*) filter (where status = 'closed' and realized_pnl_lamports > 0)::int as wins,
				coalesce(sum(realized_pnl_lamports) filter (where status = 'closed'), 0)::float8 as pnl_lamports
			from agent_sniper_positions
			where agent_id = ${agentId} and realized_pnl_lamports is not null
			  and mint not in (
				select mint from pump_agent_mints
				where user_id = (select user_id from agent_identities where id = ${agentId})
				union
				select meta->'token'->>'mint' from agent_identities
				where user_id = (select user_id from agent_identities where id = ${agentId})
				  and meta->'token'->>'mint' is not null
			  )
		`,
		[{ closed: 0, wins: 0, pnl_lamports: 0 }],
	);

	// Dumps on supporters: large sells of its OWN launched coin within 24h of the
	// launch — selling into the people who just bought in. Real, on-chain.
	const [dumps] = await soft(
		sql`
			select count(*)::int as n
			from pump_agent_trades t
			join pump_agent_mints m on m.id = t.mint_id
			where m.agent_id = ${agentId} and t.wallet = ${ownWallet} and t.direction = 'sell'
			  and t.created_at < m.created_at + interval '24 hours'
			  and t.sol_amount is not null and abs(t.sol_amount) > 1000000000
		`,
		[{ n: 0 }],
	);

	// Fork lineage.
	const [forks] = agent.avatar_id
		? await soft(
				sql`
					select count(*)::int as fork_count
					from avatars
					where parent_avatar_id = ${agent.avatar_id} and deleted_at is null
				`,
				[{ fork_count: 0 }],
		  )
		: [{ fork_count: 0 }];

	// $THREE conviction: real balance + continuous holding duration, read from the
	// cached holder snapshot (one indexed lookup — no per-agent RPC, even in lite
	// mode). Value needs a live price; if the price feed is momentarily down, the
	// duration component (which is price-independent and just as real) still counts
	// and the score is flagged `partial` rather than fabricating a value.
	const threeHold = await soft(threeHoldingFor(ownWallet), { balance: 0n, heldSince: null });
	const threeTokens = threeHold?.balance ? Number(threeHold.balance) / Number(ATOMICS_PER_TOKEN) : 0;
	const threeHoldDays =
		threeTokens > 0 && threeHold?.heldSince
			? Math.max(0, (Date.now() - new Date(threeHold.heldSince).getTime()) / 86_400_000)
			: 0;
	let threeUsd = 0;
	if (threeTokens > 0) {
		const price = await soft(getTokenPriceUsd().then((p) => p.priceUsd || 0), 0);
		threeUsd = threeTokens * (Number(price) || 0);
	}

	// On-chain payment / distribution / attestation record (already-real index).
	const solRep = await soft(loadAgentReputation(agentId), null);

	// Best-effort EVM ERC-8004 reputation registry read (skipped in lite mode).
	const registry = lite ? { average: 0, count: 0 } : await soft(readErc8004Registry(agent), { average: 0, count: 0 });

	// Live reserves vs obligations for solvency (skipped in lite mode — RPC heavy).
	const solvency = lite
		? { reserveUsd: 0, obligationsUsd: 0, reservesKnown: false }
		: await soft(getSolvencyInputs(agentId, { address: agent.solana_address, network: 'mainnet' }), {
				reserveUsd: 0,
				obligationsUsd: 0,
				reservesKnown: false,
		  });

	const inputs = {
		ageDays,
		activeDays90: ledger?.active_days_90 || 0,
		externalTipUsd: ledger?.external_tip_usd || 0,
		settledUsd: ledger?.settled_usd || 0,
		tipCount: ledger?.tip_count || 0,
		distinctTippers: ledger?.distinct_tippers || 0,
		selfTipCount: ledger?.self_tip_count || 0,
		washTipCount: ledger?.wash_tip_count || 0,
		washTipUsd: ledger?.wash_tip_usd || 0,
		confirmedPayments: solRep?.payments?.confirmed_count || 0,
		failedPayments: solRep?.payments?.failed_count || 0,
		distinctPayers: solRep?.payments?.distinct_payers || 0,
		distributionSuccess: solRep?.distributions?.success_rate || 0,
		tipsGivenUsd: given?.usd || 0,
		tipsGivenCount: given?.cnt || 0,
		reciprocalPairs: recip?.pairs || 0,
		closedTrades: trades?.closed || 0,
		winningTrades: trades?.wins || 0,
		realizedPnlSol: (Number(trades?.pnl_lamports) || 0) / 1e9,
		dumpEvents: dumps?.n || 0,
		threeUsd,
		threeTokens,
		threeHoldDays,
		reserveUsd: solvency?.reserveUsd || 0,
		obligationsUsd: solvency?.obligationsUsd || 0,
		reservesKnown: Boolean(solvency?.reservesKnown),
		forkCount: forks?.fork_count || 0,
		hasOnchainIdentity: Boolean(agent.erc8004_agent_id),
		registryAverage: registry?.average || 0,
		registryCount: registry?.count || 0,
		validationCount: solRep?.attestations?.validation_count || 0,
		feedbackCount: solRep?.attestations?.feedback_count || 0,
		hasSkillCollection: Boolean(agent.skill_collection_mint),
	};

	const evidence = buildEvidence(agent, { solRep, registry, holdsThree: threeTokens > 0 });
	return { inputs, agent, evidence, partial };
}

/**
 * Full reputation result for one agent: real inputs → pure score → evidence +
 * owner guidance. This is what the HTTP endpoint and discovery ranking call.
 */
export async function getAgentReputation(agentId, opts = {}) {
	const { inputs, agent, evidence, partial } = await loadReputationInputs(agentId, opts);
	const result = computeReputation(inputs);
	return {
		agent_id: agent.id,
		name: agent.name,
		...result,
		evidence,
		guidance: buildGuidance(result, inputs, agent),
		partial,
		computed_at: new Date().toISOString(),
	};
}

/**
 * Compact, best-effort reputation for a set of agents — used by discovery ranking
 * (trending, the trusted leaderboard) where many agents are scored at once.
 * Always lite, always resilient. Returns a Map id -> compact.
 */
export async function scoreAgentsLite(agentIds = [], { concurrency = 8 } = {}) {
	const ids = [...new Set(agentIds.filter(Boolean))];
	const out = new Map();
	for (let i = 0; i < ids.length; i += concurrency) {
		const chunk = ids.slice(i, i + concurrency);
		const settled = await Promise.allSettled(chunk.map((id) => getAgentReputation(id, { lite: true })));
		settled.forEach((r, idx) => {
			if (r.status === 'fulfilled' && r.value) {
				const v = r.value;
				out.set(chunk[idx], {
					score: v.score,
					tier: v.tier,
					tierLabel: v.tierLabel,
					accent: v.accent,
					isNew: v.isNew,
					totals: v.totals,
				});
			}
		});
	}
	return out;
}

async function readErc8004Registry(agent) {
	if (!agent.erc8004_agent_id || !agent.chain_id) return { average: 0, count: 0 };
	const { Contract } = await import('ethers');
	const { REGISTRY_DEPLOYMENTS, REPUTATION_REGISTRY_ABI } = await import('../../../src/erc8004/abi.js');
	const deployment = REGISTRY_DEPLOYMENTS[agent.chain_id];
	if (!deployment?.reputationRegistry) return { average: 0, count: 0 };
	// Shared EVM failover provider (override → Alchemy → curated public lanes) instead
	// of a single hardcoded llamarpc URL per chain — those sit behind a Cloudflare
	// bot-wall that 403s server-side reads, so the registry read always failed.
	const { evmFallbackProvider } = await import('../evm/rpc.js');
	const provider = await evmFallbackProvider(agent.chain_id);
	const contract = new Contract(deployment.reputationRegistry, REPUTATION_REGISTRY_ABI, provider);
	const [avgX100, count] = await contract.getReputation(BigInt(agent.erc8004_agent_id));
	const n = Number(count);
	return { average: n === 0 ? 0 : Number(avgX100) / 100, count: n };
}

function buildEvidence(agent, { solRep, registry, holdsThree }) {
	const ev = {};
	if (agent.solana_address) {
		ev.wallet = { label: 'Wallet activity', href: `https://solscan.io/account/${agent.solana_address}` };
		ev.ledger = { label: 'Custody ledger', href: `/agent/${agent.id}/wallet` };
	}
	if (holdsThree && agent.solana_address) {
		// $THREE conviction is provable on-chain — link to this wallet's token holdings.
		ev.three = { label: 'Holds $THREE', href: `https://solscan.io/account/${agent.solana_address}#portfolio` };
	}
	if (agent.avatar_id) {
		ev.lineage = { label: 'Fork lineage', href: `/avatars/${agent.avatar_id}` };
	}
	if (agent.erc8004_agent_id) {
		// The registered identity's public page is the discover detail route
		// (/discover/a/:chainId/:agentId). Without a chain the record predates the
		// unified deploy, so fall back to the agent profile, which mounts the
		// on-chain card. There is no /agent/:id/onchain route.
		ev.identity = {
			label: 'On-chain identity',
			href: agent.chain_id
				? `/discover/a/${agent.chain_id}/${agent.erc8004_agent_id}`
				: `/agent/${agent.id}`,
		};
	}
	if (registry?.count > 0) {
		ev.registry = { label: 'On-chain reviews', href: '/reputation' };
	}
	const mint = solRep?.mints?.[0]?.mint;
	if (mint) {
		ev.mint = { label: 'Launched coin', href: `https://solscan.io/token/${mint}` };
	}
	return ev;
}

// Owner-facing, actionable guidance tied to real available actions. Visitors do
// not see this — only the owner can act on it.
function buildGuidance(result, inputs, agent) {
	const tips = [];
	if (inputs.washTipCount > 0) {
		tips.push({
			action: 'stop_self_dealing',
			label: 'Stop tipping yourself between your own agents',
			detail: `${inputs.washTipCount} wash-tip${inputs.washTipCount === 1 ? '' : 's'} were ignored. Trust only grows from independent wallets.`,
			href: `/agent/${agent.id}/wallet`,
		});
	}
	if (inputs.reservesKnown && inputs.obligationsUsd > inputs.reserveUsd) {
		tips.push({
			action: 'top_up_reserves',
			label: 'Top up reserves to cover obligations',
			detail: `Your reserves ($${round1(inputs.reserveUsd)}) are below your outstanding obligations ($${round1(inputs.obligationsUsd)}).`,
			href: `/agent/${agent.id}/wallet#reserves`,
		});
	}
	if (inputs.dumpEvents > 0) {
		tips.push({
			action: 'protect_supporters',
			label: 'Stop dumping on your supporters',
			detail: 'Large sells right after your launch hurt early buyers and lower your trading conduct.',
			href: `/agent/${agent.id}/wallet`,
		});
	}
	if (inputs.threeTokens <= 0) {
		tips.push({
			action: 'hold_three',
			label: 'Hold $THREE to build conviction',
			detail: 'Holding the platform coin over time is a real, on-chain trust signal — and it unlocks holder-only worlds and cosmetics.',
			href: `/agent/${agent.id}/wallet`,
		});
	}
	if (!inputs.hasOnchainIdentity) {
		tips.push({
			action: 'verify_identity',
			label: 'Verify your on-chain identity',
			detail: 'Register an ERC-8004 identity to add provable trust.',
			// /deploy is the ERC-8004 registration wizard; ?avatar= prefills it from
			// this agent's saved avatar so the owner lands on a ready form.
			href: agent.avatar_id
				? `/deploy?avatar=${encodeURIComponent(agent.avatar_id)}`
				: '/deploy',
		});
	}
	if (inputs.distinctTippers < 3) {
		tips.push({
			action: 'grow_tips',
			label: 'Earn tips from real wallets',
			detail: 'Trust grows fastest from many distinct funded wallets choosing to tip you.',
			href: `/agent/${agent.id}/wallet`,
		});
	}
	if (inputs.tipsGivenUsd <= 0) {
		tips.push({
			action: 'give_back',
			label: 'Tip the agents you work with',
			detail: 'Reciprocity builds standing — supporting other agents raises your generosity factor.',
			href: `/agent/${agent.id}/wallet`,
		});
	}
	return tips.slice(0, 3);
}
