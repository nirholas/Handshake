// Agent Trading Swarms — pooled custodial treasury, reputation-weighted consensus,
// and pro-rata on-chain profit settlement.
//
// A swarm is itself an agent-owned custodial wallet (the "treasury agent"),
// provisioned through the normal agent-wallet path. It carries a dedicated
// agent_sniper_strategies row that holds its trade policy (budget, per-trade cap,
// stop-loss/take-profit), so the existing sniper position sweep manages and exits
// its positions for free. The consensus engine (workers/agent-sniper/swarm.js)
// fires buys from the treasury only when reputation-weighted member agreement
// clears the swarm threshold; realized profit distributes pro-rata to members via
// real SOL transfers from the treasury, and a member can exit and redeem their
// share of current treasury value at any time.
//
// Every lamport moves on-chain and is reconciled to the treasury's live balance —
// there are no internal virtual balances. Contributions, distributions, and exits
// are all real transfers, spend-guarded and audited in agent_custody_events
// (category 'swarm_payout') plus the purpose-built swarm_payouts ledger.

import { sql } from './db.js';
import { ensureAgentWallet, getOrCreateAgentSolanaWallet, recoverSolanaAgentKeypair } from './agent-wallet.js';
import { transferNativeSol } from './solana-transfer.js';
import { solanaConnection } from './solana/connection.js';
import { recordCustodyEvent } from './agent-trade-guards.js';

const LAMPORTS_PER_SOL = 1_000_000_000;

// Keep a small SOL buffer in the treasury for transaction fees so distributions
// and exits can never strand the wallet below the cost of its own next trade/payout.
export const GAS_RESERVE_LAMPORTS = 15_000_000n; // 0.015 SOL

// Funding floor — a contribution below this isn't worth an on-chain tx + the fee.
export const MIN_CONTRIBUTION_LAMPORTS = 5_000_000n; // 0.005 SOL

// Floor weight so a member with no track record still counts a little, while
// verified reputable members dominate the vote.
const MIN_VOTE_WEIGHT = 5;

const BPS = 10000;

// ── policy ───────────────────────────────────────────────────────────────────

const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * Validate + normalize a swarm policy. Throws SwarmError on an out-of-range value
 * so a malformed policy never reaches the treasury strategy.
 */
export function normalizeSwarmPolicy(input = {}) {
	const p = input && typeof input === 'object' ? input : {};

	const minConsensus = clamp(num(p.min_consensus) ?? 0.6, 0.05, 1);
	const maxPerTrade = BigInt(Math.max(1_000_000, Math.round(num(p.max_per_trade_lamports) ?? 50_000_000)));
	const dailyBudget = BigInt(Math.max(Number(maxPerTrade), Math.round(num(p.daily_budget_lamports) ?? 500_000_000)));
	const creatorFeeBps = Math.round(clamp(num(p.creator_fee_bps) ?? 0, 0, 2000)); // ≤ 20%
	const maxMemberShareBps = Math.round(clamp(num(p.max_member_share_bps) ?? 5000, 1000, 10000)); // 10%..100%
	const stopLoss = clamp(num(p.stop_loss_pct) ?? 35, 1, 95);
	const takeProfit = num(p.take_profit_pct) != null ? clamp(num(p.take_profit_pct), 5, 100000) : 80;
	const trailing = num(p.trailing_stop_pct) != null ? clamp(num(p.trailing_stop_pct), 1, 95) : 25;
	const maxHold = Math.round(clamp(num(p.max_hold_seconds) ?? 3600, 60, 86400));
	const slippageBps = Math.round(clamp(num(p.slippage_bps) ?? 500, 50, 5000));
	const firewallLevel = ['block', 'warn', 'off'].includes(p.firewall_level) ? p.firewall_level : 'block';
	const requireSmartMoney = p.require_smart_money === true;
	const minSmartMoney = clamp(num(p.min_smart_money_score) ?? 0, 0, 100);
	const joinOpen = p.join_open !== false; // default open
	const killThresholdBps = Math.round(clamp(num(p.kill_threshold_bps) ?? 3000, 0, 10000)); // members holding ≥30% can kill
	const exitPolicy = p.exit_policy === 'wait_to_close' ? 'wait_to_close' : 'settle_at_mark';

	return {
		min_consensus: minConsensus,
		max_per_trade_lamports: maxPerTrade.toString(),
		daily_budget_lamports: dailyBudget.toString(),
		creator_fee_bps: creatorFeeBps,
		max_member_share_bps: maxMemberShareBps,
		require_smart_money: requireSmartMoney,
		min_smart_money_score: minSmartMoney,
		stop_loss_pct: stopLoss,
		take_profit_pct: takeProfit,
		trailing_stop_pct: trailing,
		max_hold_seconds: maxHold,
		slippage_bps: slippageBps,
		firewall_level: firewallLevel,
		join_open: joinOpen,
		kill_threshold_bps: killThresholdBps,
		exit_policy: exitPolicy,
	};
}

export class SwarmError extends Error {
	constructor(status, code, message) {
		super(message);
		this.status = status;
		this.code = code;
	}
}

/**
 * Parse a contribution amount from a request body into lamports. Accepts either
 * `lamports` (an integer count) or `sol` (a decimal), with `lamports` winning
 * when both are present.
 *
 * Every rejection is a 400 SwarmError, which the handler already renders as a
 * clean JSON error. That is the whole point: coercing straight to BigInt() the
 * way this used to means a caller typo (`lamports: "abc"`) or an overflowing
 * amount (`sol: 1e999`) throws a raw RangeError, which escapes as a 500
 * internal_error complete with a Sentry capture and an ops alert. Bad input from
 * a client is not a server fault and must never page anyone.
 *
 * @param {{ lamports?: unknown, sol?: unknown }} [body]
 * @returns {bigint}
 */
export function parseContributionLamports(body = {}) {
	const field = body?.lamports != null ? 'lamports' : body?.sol != null ? 'sol' : null;
	if (!field) throw new SwarmError(400, 'bad_amount', 'sol or lamports required');
	const raw = Number(body[field]);
	if (!Number.isFinite(raw)) throw new SwarmError(400, 'bad_amount', `${field} must be a number`);
	const value = Math.round(field === 'lamports' ? raw : raw * LAMPORTS_PER_SOL);
	// Beyond 2^53 a double no longer represents every integer, so the lamport
	// count a caller sent is not the one we would charge them.
	if (!Number.isSafeInteger(value)) throw new SwarmError(400, 'bad_amount', `${field} is out of range`);
	if (value <= 0) throw new SwarmError(400, 'bad_amount', 'sol or lamports required');
	return BigInt(value);
}

// ── on-chain treasury balance ─────────────────────────────────────────────────

/** Live treasury SOL balance in lamports (bigint). The single source of truth. */
export async function treasuryBalanceLamports(address, network = 'mainnet') {
	const { PublicKey } = await import('@solana/web3.js');
	const conn = solanaConnection({ network, commitment: 'confirmed' });
	const lamports = await conn.getBalance(new PublicKey(address), 'confirmed');
	return BigInt(lamports);
}

// ── ownership + loading ────────────────────────────────────────────────────────

/** Assert the user owns the agent; returns the agent row. */
async function requireOwnedAgent(userId, agentId) {
	const [agent] = await sql`
		select id, user_id, name, meta from agent_identities
		where id = ${agentId} and deleted_at is null limit 1
	`;
	if (!agent) throw new SwarmError(404, 'agent_not_found', 'agent not found');
	if (agent.user_id !== userId) throw new SwarmError(403, 'forbidden', 'not your agent');
	return agent;
}

export async function getSwarm(swarmId) {
	const [row] = await sql`select * from swarms where id = ${swarmId} limit 1`;
	return row || null;
}

async function loadTreasuryStrategy(swarm) {
	const [strat] = await sql`
		select * from agent_sniper_strategies where id = ${swarm.strategy_id} limit 1
	`;
	return strat || null;
}

// ── create ─────────────────────────────────────────────────────────────────────

/**
 * Create a swarm: provision a dedicated custodial treasury agent + its sniper
 * strategy (the trade policy), persist the swarm, and enroll the creator as the
 * first member. The treasury strategy is created disabled — the consensus engine,
 * not the new-mint feed, decides when it trades.
 */
export async function createSwarm({ userId, ownerAgentId, name, description = null, network = 'mainnet', policy = {} }) {
	if (!userId) throw new SwarmError(401, 'unauthorized', 'sign in required');
	const cleanName = String(name || '').trim();
	if (!cleanName || cleanName.length > 80) throw new SwarmError(400, 'bad_name', 'name must be 1–80 chars');
	const net = network === 'devnet' ? 'devnet' : 'mainnet';
	const pol = normalizeSwarmPolicy(policy);

	const owner = await requireOwnedAgent(userId, ownerAgentId);
	await ensureAgentWallet(owner.id, userId, { reason: 'swarm_owner' });

	// Provision the treasury as its own agent (its own custodial Solana wallet).
	const [treasury] = await sql`
		insert into agent_identities (user_id, name, description, skills, meta)
		values (
			${userId}, ${`Swarm Treasury · ${cleanName}`.slice(0, 120)},
			${`Pooled trading treasury for the “${cleanName}” swarm.`.slice(0, 500)},
			${['trade']}, ${JSON.stringify({ swarm_treasury: true })}::jsonb
		)
		returning id
	`;
	const treasuryWallet = await getOrCreateAgentSolanaWallet(treasury.id);

	// The treasury's sniper strategy: disabled (so the new-mint feed ignores it),
	// kill_switch off, with the swarm's budget + exit policy. The consensus engine
	// loads it explicitly and fires buys; the position sweep manages exits.
	const [strat] = await sql`
		insert into agent_sniper_strategies
			(agent_id, user_id, network, enabled, kill_switch, trigger,
			 daily_budget_lamports, per_trade_lamports, max_concurrent_positions,
			 slippage_bps, max_price_impact_pct, mev_tip_mode, firewall_level,
			 require_sol_quote, take_profit_pct, stop_loss_pct, trailing_stop_pct,
			 max_hold_seconds, min_smart_money_score, require_smart_money, updated_at)
		values
			(${treasury.id}, ${userId}, ${net}, false, false, 'new_mint',
			 ${pol.daily_budget_lamports}, ${pol.max_per_trade_lamports}, ${8},
			 ${pol.slippage_bps}, ${15}, 'economy', ${pol.firewall_level},
			 true, ${pol.take_profit_pct}, ${pol.stop_loss_pct}, ${pol.trailing_stop_pct},
			 ${pol.max_hold_seconds}, ${pol.min_smart_money_score}, ${pol.require_smart_money}, now())
		on conflict (agent_id, network) do update set updated_at = now()
		returning id
	`;

	const [swarm] = await sql`
		insert into swarms
			(owner_user_id, owner_agent_id, treasury_agent_id, strategy_id, name, description, network, status, policy)
		values
			(${userId}, ${owner.id}, ${treasury.id}, ${strat.id}, ${cleanName},
			 ${description ? String(description).slice(0, 1000) : null}, ${net}, 'open', ${JSON.stringify(pol)}::jsonb)
		returning *
	`;

	// Creator is the first member (zero contribution until they fund).
	await sql`
		insert into swarm_members (swarm_id, agent_id, user_id, is_creator, status)
		values (${swarm.id}, ${owner.id}, ${userId}, true, 'active')
		on conflict (swarm_id, agent_id) do nothing
	`;

	await recordCustodyEvent({
		agentId: treasury.id, userId, eventType: 'limit_change', category: 'swarm_payout',
		network: net, reason: 'swarm_created',
		meta: { swarm_id: swarm.id, name: cleanName, treasury: treasuryWallet.address, policy: pol },
	}).catch(() => {});

	return { ...swarm, treasury_address: treasuryWallet.address };
}

// ── join ─────────────────────────────────────────────────────────────────────

export async function joinSwarm({ userId, swarmId, agentId }) {
	const swarm = await getSwarm(swarmId);
	if (!swarm) throw new SwarmError(404, 'not_found', 'swarm not found');
	if (['killed', 'closed'].includes(swarm.status)) throw new SwarmError(409, 'closed', 'swarm is closed');
	const pol = normalizeSwarmPolicy(swarm.policy);
	if (!pol.join_open && swarm.owner_user_id !== userId) {
		throw new SwarmError(403, 'invite_only', 'this swarm is invite-only');
	}
	const agent = await requireOwnedAgent(userId, agentId);
	await ensureAgentWallet(agent.id, userId, { reason: 'swarm_join' });

	const [member] = await sql`
		insert into swarm_members (swarm_id, agent_id, user_id, status)
		values (${swarm.id}, ${agent.id}, ${userId}, 'active')
		on conflict (swarm_id, agent_id) do update set
			status = 'active', exited_at = null, updated_at = now()
		returning *
	`;
	return member;
}

// ── contribute (real SOL transfer member → treasury) ──────────────────────────

/**
 * Fund the treasury with real SOL from the member's custodial wallet. Verifies the
 * member can afford it (keeping a fee buffer), enforces the per-member share cap
 * BEFORE moving funds, transfers on-chain, then records the net contribution and
 * recomputes every member's share. Returns the signature + updated member.
 */
export async function contributeToSwarm({ userId, swarmId, agentId, lamports }) {
	const swarm = await getSwarm(swarmId);
	if (!swarm) throw new SwarmError(404, 'not_found', 'swarm not found');
	if (['killed', 'closed'].includes(swarm.status)) throw new SwarmError(409, 'closed', 'swarm is closed');
	const amount = BigInt(lamports || 0);
	if (amount < MIN_CONTRIBUTION_LAMPORTS) {
		throw new SwarmError(400, 'too_small', `minimum contribution is ${Number(MIN_CONTRIBUTION_LAMPORTS) / LAMPORTS_PER_SOL} SOL`);
	}

	const agent = await requireOwnedAgent(userId, agentId);
	const wallet = await ensureAgentWallet(agent.id, userId, { reason: 'swarm_contribute' });

	// Member must be enrolled (auto-join if open).
	let [member] = await sql`select * from swarm_members where swarm_id = ${swarm.id} and agent_id = ${agent.id} limit 1`;
	if (!member || member.status !== 'active') {
		member = await joinSwarm({ userId, swarmId: swarm.id, agentId: agent.id });
	}

	const pol = normalizeSwarmPolicy(swarm.policy);

	// Anti-abuse: reject a contribution that would push this member past the cap.
	const members = await sql`select id, agent_id, contribution_lamports, withdrawn_lamports, status from swarm_members where swarm_id = ${swarm.id} and status = 'active'`;
	let totalNet = 0n;
	let memberNet = 0n;
	for (const m of members) {
		const net = BigInt(m.contribution_lamports) - BigInt(m.withdrawn_lamports);
		totalNet += net > 0n ? net : 0n;
		if (m.agent_id === agent.id) memberNet = net > 0n ? net : 0n;
	}
	const prospectiveMember = memberNet + amount;
	const prospectiveTotal = totalNet + amount;
	const prospectiveBps = Number((prospectiveMember * BigInt(BPS)) / prospectiveTotal);
	if (prospectiveBps > pol.max_member_share_bps && members.length > 1) {
		throw new SwarmError(409, 'share_cap', `that contribution would exceed the per-member cap of ${(pol.max_member_share_bps / 100).toFixed(0)}%`);
	}

	// Verify on-chain funds (amount + a fee buffer) before signing.
	const bal = await treasuryBalanceLamports(wallet.address, swarm.network);
	if (bal < amount + GAS_RESERVE_LAMPORTS) {
		throw new SwarmError(402, 'insufficient_funds', 'wallet balance too low to fund this contribution');
	}

	const treasury = await getSwarmTreasuryAddress(swarm);
	const keypair = await recoverSolanaAgentKeypair(agent.meta?.encrypted_solana_secret, {
		agentId: agent.id, userId, reason: 'swarm_contribute', meta: { swarm_id: swarm.id },
	});

	const signature = await transferNativeSol({
		fromKeypair: keypair, toAddress: treasury, lamports: amount, network: swarm.network,
	});

	const [updated] = await sql`
		update swarm_members
		set contribution_lamports = contribution_lamports + ${amount.toString()},
		    last_fund_sig = ${signature}, updated_at = now()
		where id = ${member.id}
		returning *
	`;
	await recordCustodyEvent({
		agentId: agent.id, userId, eventType: 'spend', category: 'swarm_payout',
		network: swarm.network, asset: 'SOL', amountLamports: amount, destination: treasury,
		signature, reason: 'swarm_contribution', status: 'confirmed',
		idempotencyKey: `swarm_contrib:${member.id}:${signature}`,
		meta: { swarm_id: swarm.id },
	}).catch(() => {});

	const shares = await recomputeShares(swarm.id);
	// First real money in flips an 'open' swarm to 'active'.
	if (swarm.status === 'open') {
		await sql`update swarms set status = 'active', updated_at = now() where id = ${swarm.id} and status = 'open'`;
	}
	return { signature, member: updated, shares };
}

async function getSwarmTreasuryAddress(swarm) {
	const wallet = await getOrCreateAgentSolanaWallet(swarm.treasury_agent_id);
	return wallet.address;
}

// ── shares ─────────────────────────────────────────────────────────────────────

/**
 * Recompute every active member's share_bps from net contributions. Caps each
 * member at the policy's max_member_share_bps and redistributes the overflow
 * proportionally across the others, so no member can capture the treasury.
 */
export async function recomputeShares(swarmId) {
	const swarm = await getSwarm(swarmId);
	if (!swarm) return [];
	const pol = normalizeSwarmPolicy(swarm.policy);
	const members = await sql`
		select id, agent_id, contribution_lamports, withdrawn_lamports
		from swarm_members where swarm_id = ${swarmId} and status = 'active'
	`;
	const nets = members.map((m) => {
		const net = BigInt(m.contribution_lamports) - BigInt(m.withdrawn_lamports);
		return { id: m.id, net: net > 0n ? Number(net) : 0 };
	});
	const total = nets.reduce((a, b) => a + b.net, 0);
	let bps = {};
	if (total <= 0) {
		for (const m of nets) bps[m.id] = 0;
	} else {
		// Initial proportional split.
		for (const m of nets) bps[m.id] = Math.round((m.net / total) * BPS);
		// Enforce the cap with proportional redistribution of overflow.
		const cap = pol.max_member_share_bps;
		const capped = new Set();
		for (let iter = 0; iter < 8; iter++) {
			const over = nets.filter((m) => !capped.has(m.id) && bps[m.id] > cap);
			if (!over.length) break;
			let overflow = 0;
			for (const m of over) { overflow += bps[m.id] - cap; bps[m.id] = cap; capped.add(m.id); }
			const free = nets.filter((m) => !capped.has(m.id));
			const freeTotal = free.reduce((a, b) => a + bps[b.id], 0);
			if (freeTotal <= 0) break;
			for (const m of free) bps[m.id] += Math.round((bps[m.id] / freeTotal) * overflow);
		}
	}
	// Persist.
	for (const m of nets) {
		await sql`update swarm_members set share_bps = ${bps[m.id] || 0}, updated_at = now() where id = ${m.id}`;
	}
	return members.map((m) => ({ member_id: m.id, agent_id: m.agent_id, share_bps: bps[m.id] || 0 }));
}

// ── reputation (vote weights) ─────────────────────────────────────────────────

/**
 * Refresh each active member's cached verified-trader reputation (0..100). This is
 * the consensus vote weight. Best-effort per member — a member with no track record
 * keeps a null/zero reputation and votes at the floor weight.
 */
export async function refreshMemberReputations(swarmId, network) {
	const { fetchTraderPositions, computeTraderMetrics } = await import('./trader-stats.js');
	const members = await sql`select id, agent_id from swarm_members where swarm_id = ${swarmId} and status = 'active'`;
	const out = [];
	for (const m of members) {
		let score = 0;
		try {
			const positions = await fetchTraderPositions({ agentId: m.agent_id, network, window: 'all' });
			score = computeTraderMetrics(positions, { solUsd: null }).score || 0;
		} catch { /* no track record yet */ }
		await sql`update swarm_members set reputation = ${score}, reputation_at = now() where id = ${m.id}`;
		out.push({ member_id: m.id, agent_id: m.agent_id, reputation: score });
	}
	return out;
}

// ── consensus tally (pure) ─────────────────────────────────────────────────────

/**
 * Reputation-weighted consensus over a candidate mint. `members` is the active
 * member set (each with agent_id + reputation); `longAgentIds` is the set of
 * members currently holding a real position in the mint (their on-chain "yes"
 * vote). Returns the weighted agreement, the conviction used to size the trade,
 * and a per-member breakdown for the audit log.
 */
export function computeConsensus({ members, longAgentIds, smartMoneyScore = 0, policy }) {
	const longSet = longAgentIds instanceof Set ? longAgentIds : new Set(longAgentIds || []);
	const weightOf = (rep) => Math.max(MIN_VOTE_WEIGHT, Number(rep) || 0);
	let totalWeight = 0;
	let longWeight = 0;
	const breakdown = [];
	for (const m of members) {
		const w = weightOf(m.reputation);
		const long = longSet.has(m.agent_id);
		totalWeight += w;
		if (long) longWeight += w;
		breakdown.push({ agent_id: m.agent_id, name: m.name || null, reputation: Number(m.reputation) || 0, long, weight: w });
	}
	const consensus = totalWeight > 0 ? longWeight / totalWeight : 0;
	// Smart-money confirmation lifts conviction (0..0.25 bonus) but cannot manufacture
	// agreement on its own — it scales what the members already voted.
	const smBonus = clamp((Number(smartMoneyScore) || 0) / 100, 0, 1) * 0.25;
	const conviction = clamp(consensus * (1 + smBonus), 0, 1);
	return {
		consensus,
		conviction,
		members_long: breakdown.filter((b) => b.long).length,
		members_total: members.length,
		total_weight: totalWeight,
		long_weight: longWeight,
		breakdown,
	};
}

// ── kill switch ────────────────────────────────────────────────────────────────

/**
 * Trigger the swarm kill switch. The creator can always kill; any member (or set
 * of members) holding ≥ policy.kill_threshold_bps of the treasury can too. Halts
 * new consensus buys and flips kill_switch on the treasury strategy + every open
 * position so the sweep liquidates them.
 */
export async function killSwarm({ userId, swarmId, reason = null }) {
	const swarm = await getSwarm(swarmId);
	if (!swarm) throw new SwarmError(404, 'not_found', 'swarm not found');
	if (swarm.status === 'killed') return swarm;
	const pol = normalizeSwarmPolicy(swarm.policy);

	const isCreator = swarm.owner_user_id === userId;
	if (!isCreator) {
		const rows = await sql`
			select coalesce(sum(share_bps),0)::int as bps from swarm_members
			where swarm_id = ${swarm.id} and user_id = ${userId} and status = 'active'
		`;
		const callerBps = rows[0]?.bps || 0;
		if (callerBps < pol.kill_threshold_bps) {
			throw new SwarmError(403, 'below_threshold', `you hold ${(callerBps / 100).toFixed(1)}% — need ${(pol.kill_threshold_bps / 100).toFixed(0)}% to kill`);
		}
	}

	await sql`
		update swarms set status = 'killed', killed_at = now(), killed_by_user_id = ${userId},
			kill_reason = ${reason ? String(reason).slice(0, 280) : null}, updated_at = now()
		where id = ${swarm.id}
	`;
	if (swarm.strategy_id) {
		// Flipping the strategy kill_switch forces every open treasury position to
		// liquidate on the next sweep: getOpenPositions joins s.kill_switch onto each
		// position, and positions.js exits any position whose kill_switch is set.
		await sql`update agent_sniper_strategies set kill_switch = true, enabled = false, updated_at = now() where id = ${swarm.strategy_id}`;
	}

	await recordCustodyEvent({
		agentId: swarm.treasury_agent_id, userId, eventType: 'limit_change', category: 'swarm_payout',
		network: swarm.network, reason: 'swarm_killed', meta: { swarm_id: swarm.id, by: isCreator ? 'creator' : 'member', note: reason || null },
	}).catch(() => {});

	return await getSwarm(swarm.id);
}

// ── pause / resume ─────────────────────────────────────────────────────────────

export async function setSwarmPaused({ userId, swarmId, paused }) {
	const swarm = await getSwarm(swarmId);
	if (!swarm) throw new SwarmError(404, 'not_found', 'swarm not found');
	if (swarm.owner_user_id !== userId) throw new SwarmError(403, 'forbidden', 'only the creator can pause');
	if (swarm.status === 'killed') throw new SwarmError(409, 'killed', 'swarm is killed');
	const next = paused ? 'paused' : 'active';
	await sql`update swarms set status = ${next}, updated_at = now() where id = ${swarm.id}`;
	return await getSwarm(swarm.id);
}

// ── exit + redeem ──────────────────────────────────────────────────────────────

/**
 * Net asset value of the treasury in lamports: liquid SOL + the marked value of
 * its open positions (last quoted value). The basis for settle_at_mark exits.
 */
export async function treasuryNavLamports(swarm) {
	const treasury = await getSwarmTreasuryAddress(swarm);
	const liquid = await treasuryBalanceLamports(treasury, swarm.network);
	const [row] = await sql`
		select coalesce(sum(coalesce(last_value_lamports, entry_quote_lamports, 0)),0)::numeric as marked
		from agent_sniper_positions
		where agent_id = ${swarm.treasury_agent_id} and network = ${swarm.network} and status in ('open','opening','closing')
	`;
	const marked = BigInt(row?.marked ? String(row.marked).split('.')[0] : '0');
	return { liquid, marked, nav: liquid + marked, treasury };
}

/**
 * Exit a member and redeem their share to their own wallet via a real SOL transfer.
 *
 * Open-position policy (explicit):
 *   - settle_at_mark (default): redeem share_bps × treasury NAV (liquid SOL + marked
 *     open-position value), PAID from liquid SOL. If liquid can't cover the marked
 *     portion, the payout is capped to available liquid (minus the fee reserve) and
 *     flagged `capped` — the member is told plainly.
 *   - wait_to_close: exit is refused while the treasury holds open positions; the
 *     member kills or waits for positions to close, then redeems pure liquid SOL.
 */
export async function exitSwarm({ userId, swarmId, agentId }) {
	const swarm = await getSwarm(swarmId);
	if (!swarm) throw new SwarmError(404, 'not_found', 'swarm not found');
	const agent = await requireOwnedAgent(userId, agentId);
	const [member] = await sql`select * from swarm_members where swarm_id = ${swarm.id} and agent_id = ${agent.id} and status = 'active' limit 1`;
	if (!member) throw new SwarmError(404, 'not_member', 'not an active member of this swarm');

	const pol = normalizeSwarmPolicy(swarm.policy);
	const dest = await ensureAgentWallet(agent.id, userId, { reason: 'swarm_exit' });

	const openCount = (await sql`
		select count(*)::int as n from agent_sniper_positions
		where agent_id = ${swarm.treasury_agent_id} and network = ${swarm.network} and status in ('open','opening','closing')
	`)[0]?.n || 0;

	if (pol.exit_policy === 'wait_to_close' && openCount > 0 && swarm.status !== 'killed') {
		throw new SwarmError(409, 'positions_open', 'this swarm settles exits only when no positions are open — wait for them to close or trigger the kill switch');
	}

	const { liquid, nav, treasury } = await treasuryNavLamports(swarm);
	const shareBps = BigInt(member.share_bps || 0);
	const spendable = liquid > GAS_RESERVE_LAMPORTS ? liquid - GAS_RESERVE_LAMPORTS : 0n;

	// Entitlement: share of NAV (settle_at_mark) or share of liquid (wait_to_close).
	const basis = pol.exit_policy === 'wait_to_close' ? liquid : nav;
	let redeem = (basis * shareBps) / BigInt(BPS);
	let capped = false;
	if (redeem > spendable) { redeem = spendable; capped = true; }

	let signature = null;
	if (redeem > 0n) {
		const keypair = await recoverSolanaAgentKeypair(
			(await sql`select meta from agent_identities where id = ${swarm.treasury_agent_id} limit 1`)[0]?.meta?.encrypted_solana_secret,
			{ agentId: swarm.treasury_agent_id, userId, reason: 'swarm_exit_redeem', meta: { swarm_id: swarm.id, member_id: member.id } },
		);
		signature = await transferNativeSol({ fromKeypair: keypair, toAddress: dest.address, lamports: redeem, network: swarm.network });

		await sql`
			insert into swarm_payouts (swarm_id, member_id, agent_id, kind, amount_lamports, share_bps, destination, signature, status, idempotency_key, meta)
			values (${swarm.id}, ${member.id}, ${agent.id}, 'exit', ${redeem.toString()}, ${member.share_bps || 0}, ${dest.address}, ${signature}, 'confirmed',
				${`swarm_exit:${member.id}`}, ${JSON.stringify({ capped, exit_policy: pol.exit_policy })}::jsonb)
			on conflict (idempotency_key) do nothing
		`;
		await recordCustodyEvent({
			agentId: swarm.treasury_agent_id, userId, eventType: 'withdraw', category: 'swarm_payout',
			network: swarm.network, asset: 'SOL', amountLamports: redeem, destination: dest.address,
			signature, reason: 'swarm_exit_redeem', status: 'confirmed',
			idempotencyKey: `swarm_exit:${member.id}:${signature}`, meta: { swarm_id: swarm.id, member_id: member.id, capped },
		}).catch(() => {});
	}

	await sql`
		update swarm_members
		set status = 'exited', exited_at = now(), withdrawn_lamports = withdrawn_lamports + ${redeem.toString()}, share_bps = 0, updated_at = now()
		where id = ${member.id}
	`;
	await recomputeShares(swarm.id);

	return { redeemed_lamports: redeem.toString(), redeemed_sol: Number(redeem) / LAMPORTS_PER_SOL, signature, capped, exit_policy: pol.exit_policy };
}

// ── settlement: distribute realized profit on closed positions ─────────────────

/**
 * For one swarm, distribute the realized profit of any newly-closed treasury
 * positions pro-rata to members by share, minus the creator fee. Principal stays
 * in the treasury so it keeps trading; only positive realized PnL is paid out.
 * Idempotent: a position that has any 'profit' payout row is never re-scanned.
 * Losing/break-even closes write a single zero-amount marker row so they settle
 * once and don't re-scan forever.
 *
 * Returns the number of positions settled and total lamports distributed. Pass a
 * `transfer` override for tests; defaults to a real on-chain SOL transfer.
 */
export async function settleSwarm(swarmId, { transfer = transferNativeSol } = {}) {
	const swarm = await getSwarm(swarmId);
	if (!swarm) return { settled: 0, distributed: '0' };

	const pending = await sql`
		select p.id, p.mint, p.symbol, p.realized_pnl_lamports, p.exit_quote_lamports, p.entry_quote_lamports
		from agent_sniper_positions p
		where p.agent_id = ${swarm.treasury_agent_id} and p.network = ${swarm.network}
		  and p.status = 'closed' and p.realized_pnl_lamports is not null
		  and not exists (select 1 from swarm_payouts sp where sp.position_id = p.id and sp.kind = 'profit')
		order by p.closed_at asc
		limit 25
	`;
	if (!pending.length) return { settled: 0, distributed: '0' };

	const pol = normalizeSwarmPolicy(swarm.policy);
	let settled = 0;
	let distributedTotal = 0n;
	let treasuryKeypair = null;

	for (const pos of pending) {
		const profit = BigInt(pos.realized_pnl_lamports);
		// Loss / break-even — record a settled marker (no transfer) and move on.
		if (profit <= 0n) {
			await sql`
				insert into swarm_payouts (swarm_id, position_id, kind, amount_lamports, status, idempotency_key, meta)
				values (${swarm.id}, ${pos.id}, 'profit', 0, 'confirmed', ${`swarm_profit:${pos.id}:noop`},
					${JSON.stringify({ realized_pnl_lamports: pos.realized_pnl_lamports, loss: true, mint: pos.mint })}::jsonb)
				on conflict (idempotency_key) do nothing
			`;
			settled++;
			continue;
		}

		// Snapshot member shares at settlement time.
		const members = await sql`
			select id, agent_id, user_id, share_bps from swarm_members
			where swarm_id = ${swarm.id} and status = 'active' and share_bps > 0
		`;
		if (!members.length) {
			await sql`
				insert into swarm_payouts (swarm_id, position_id, kind, amount_lamports, status, idempotency_key, meta)
				values (${swarm.id}, ${pos.id}, 'profit', 0, 'confirmed', ${`swarm_profit:${pos.id}:noop`},
					${JSON.stringify({ note: 'no_active_members', profit: profit.toString() })}::jsonb)
				on conflict (idempotency_key) do nothing
			`;
			settled++;
			continue;
		}

		// Bound distribution to liquid SOL minus the fee reserve.
		const treasuryAddr = await getSwarmTreasuryAddress(swarm);
		const liquid = await treasuryBalanceLamports(treasuryAddr, swarm.network);
		const spendable = liquid > GAS_RESERVE_LAMPORTS ? liquid - GAS_RESERVE_LAMPORTS : 0n;
		if (spendable <= 0n) break; // nothing to pay with right now — retry next sweep

		let distributable = profit > spendable ? spendable : profit;
		const fee = (distributable * BigInt(pol.creator_fee_bps)) / BigInt(BPS);
		const netDistributable = distributable - fee;

		if (!treasuryKeypair) {
			const meta = (await sql`select meta from agent_identities where id = ${swarm.treasury_agent_id} limit 1`)[0]?.meta;
			treasuryKeypair = await recoverSolanaAgentKeypair(meta?.encrypted_solana_secret, {
				agentId: swarm.treasury_agent_id, userId: swarm.owner_user_id, reason: 'swarm_profit_settle', meta: { swarm_id: swarm.id },
			});
		}

		// Pro-rata member payouts.
		for (const m of members) {
			const amount = (netDistributable * BigInt(m.share_bps)) / BigInt(BPS);
			if (amount <= 0n) continue;
			await payoutMember({
				swarm, position: pos, member: m, amount, kind: 'profit',
				keypair: treasuryKeypair, transfer,
				idempotencyKey: `swarm_profit:${pos.id}:${m.id}`,
			});
			distributedTotal += amount;
		}

		// Creator fee → owner agent wallet.
		if (fee > 0n) {
			const ownerWallet = await ensureAgentWallet(swarm.owner_agent_id, swarm.owner_user_id, { reason: 'swarm_fee' });
			await payoutFee({ swarm, position: pos, amount: fee, destination: ownerWallet.address, keypair: treasuryKeypair, transfer });
		}
		settled++;
	}

	return { settled, distributed: distributedTotal.toString() };
}

async function payoutMember({ swarm, position, member, amount, keypair, transfer, idempotencyKey }) {
	// Reserve the row first (pending) so a crash mid-transfer is recoverable +
	// never double-pays (idempotency_key is unique).
	const inserted = await sql`
		insert into swarm_payouts (swarm_id, member_id, agent_id, position_id, kind, amount_lamports, share_bps, status, idempotency_key, meta)
		values (${swarm.id}, ${member.id}, ${member.agent_id}, ${position.id}, 'profit', ${amount.toString()}, ${member.share_bps},
			'pending', ${idempotencyKey}, ${JSON.stringify({ mint: position.mint, symbol: position.symbol })}::jsonb)
		on conflict (idempotency_key) do nothing
		returning id
	`;
	if (!inserted.length) return; // already paid

	const dest = (await sql`select meta from agent_identities where id = ${member.agent_id} limit 1`)[0]?.meta?.solana_address;
	if (!dest) {
		await sql`update swarm_payouts set status = 'failed', meta = meta || ${JSON.stringify({ error: 'member_no_wallet' })}::jsonb, updated_at = now() where id = ${inserted[0].id}`;
		return;
	}
	try {
		const signature = await transfer({ fromKeypair: keypair, toAddress: dest, lamports: amount, network: swarm.network });
		await sql`update swarm_payouts set status = 'confirmed', signature = ${signature}, destination = ${dest}, updated_at = now() where id = ${inserted[0].id}`;
		await recordCustodyEvent({
			agentId: swarm.treasury_agent_id, userId: member.user_id, eventType: 'spend', category: 'swarm_payout',
			network: swarm.network, asset: 'SOL', amountLamports: amount, destination: dest, signature,
			reason: 'swarm_profit_payout', status: 'confirmed', idempotencyKey: `${idempotencyKey}:${signature}`,
			meta: { swarm_id: swarm.id, position_id: position.id, mint: position.mint },
		}).catch(() => {});
	} catch (e) {
		await sql`update swarm_payouts set status = 'failed', meta = meta || ${JSON.stringify({ error: String(e?.message || e).slice(0, 200) })}::jsonb, updated_at = now() where id = ${inserted[0].id}`;
	}
}

async function payoutFee({ swarm, position, amount, destination, keypair, transfer }) {
	const inserted = await sql`
		insert into swarm_payouts (swarm_id, agent_id, position_id, kind, amount_lamports, status, idempotency_key, destination, meta)
		values (${swarm.id}, ${swarm.owner_agent_id}, ${position.id}, 'fee', ${amount.toString()}, 'pending', ${`swarm_fee:${position.id}`}, ${destination},
			${JSON.stringify({ mint: position.mint })}::jsonb)
		on conflict (idempotency_key) do nothing
		returning id
	`;
	if (!inserted.length) return;
	try {
		const signature = await transfer({ fromKeypair: keypair, toAddress: destination, lamports: amount, network: swarm.network });
		await sql`update swarm_payouts set status = 'confirmed', signature = ${signature}, updated_at = now() where id = ${inserted[0].id}`;
		await recordCustodyEvent({
			agentId: swarm.treasury_agent_id, userId: swarm.owner_user_id, eventType: 'spend', category: 'swarm_payout',
			network: swarm.network, asset: 'SOL', amountLamports: amount, destination, signature,
			reason: 'swarm_creator_fee', status: 'confirmed', idempotencyKey: `swarm_fee:${position.id}:${signature}`,
			meta: { swarm_id: swarm.id, position_id: position.id },
		}).catch(() => {});
	} catch (e) {
		await sql`update swarm_payouts set status = 'failed', meta = meta || ${JSON.stringify({ error: String(e?.message || e).slice(0, 200) })}::jsonb, updated_at = now() where id = ${inserted[0].id}`;
	}
}

// ── reads (directory + dashboard) ──────────────────────────────────────────────

/** Directory of open/active swarms with aggregate stats. */
export async function listSwarms({ network = 'mainnet', status = null, limit = 30, offset = 0 } = {}) {
	const net = network === 'devnet' ? 'devnet' : 'mainnet';
	const rows = status
		? await sql`
			select s.*, ${net} as _n from swarms s
			where s.network = ${net} and s.status = ${status}
			order by s.created_at desc limit ${limit} offset ${offset}`
		: await sql`
			select s.* from swarms s
			where s.network = ${net} and s.status in ('open','active','paused')
			order by (s.status = 'active') desc, s.created_at desc limit ${limit} offset ${offset}`;
	return summarizeSwarms(rows);
}

/** Every swarm the user owns or is (or was) a member of, any status — for "My swarms". */
export async function listSwarmsForUser(userId) {
	const rows = await sql`
		select distinct s.* from swarms s
		left join swarm_members m on m.swarm_id = s.id and m.user_id = ${userId}
		where s.owner_user_id = ${userId} or m.id is not null
		order by s.created_at desc
		limit 100
	`;
	return summarizeSwarms(rows);
}

/**
 * Summarize a batch of swarm rows for a directory listing. Aggregate stats for
 * every swarm are fetched in two grouped queries (not two-per-swarm) so a long
 * directory stays a fixed cost. A single member/position sub-query failure
 * degrades to zeroed stats for the whole batch rather than 500-ing the endpoint,
 * and a malformed individual row is skipped — a public directory must never die
 * on one bad record.
 */
async function summarizeSwarms(rows) {
	if (!rows.length) return [];
	const swarmIds = rows.map((s) => s.id);
	const treasuryIds = [...new Set(rows.map((s) => s.treasury_agent_id).filter(Boolean))];

	const [memberRows, tradeRows] = await Promise.all([
		sql`
			select swarm_id,
			       count(*) filter (where status = 'active')::int as members,
			       coalesce(sum(contribution_lamports) filter (where status = 'active'),0)::numeric as contributed,
			       coalesce(sum(withdrawn_lamports),0)::numeric as withdrawn
			from swarm_members where swarm_id = any(${swarmIds}) group by swarm_id
		`.catch(() => []),
		treasuryIds.length
			? sql`
				select agent_id, network,
				       count(*)::int as closed,
				       coalesce(sum(realized_pnl_lamports),0)::numeric as pnl,
				       count(*) filter (where realized_pnl_lamports > 0)::int as wins,
				       count(*) filter (where status in ('open','opening','closing'))::int as open
				from agent_sniper_positions where agent_id = any(${treasuryIds}) group by agent_id, network
			`.catch(() => [])
			: Promise.resolve([]),
	]);

	const memberBy = new Map(memberRows.map((r) => [r.swarm_id, r]));
	const tradeBy = new Map(tradeRows.map((r) => [`${r.agent_id}|${r.network}`, r]));

	const out = [];
	for (const s of rows) {
		try {
			out.push(summarizeSwarmRow(s, memberBy.get(s.id), tradeBy.get(`${s.treasury_agent_id}|${s.network}`)));
		} catch {
			// A malformed row (e.g. unparseable policy) must not sink the whole list.
		}
	}
	return out;
}

function summarizeSwarmRow(swarm, agg, trades) {
	const lamports = (v) => (v == null ? 0 : Number(String(v).split('.')[0]) / LAMPORTS_PER_SOL);
	const closed = Number(trades?.closed || 0);
	return {
		id: swarm.id,
		name: swarm.name,
		description: swarm.description,
		network: swarm.network,
		status: swarm.status,
		policy: normalizeSwarmPolicy(swarm.policy),
		members: Number(agg?.members || 0),
		contributed_sol: lamports(agg?.contributed),
		closed_trades: closed,
		open_positions: Number(trades?.open || 0),
		wins: Number(trades?.wins || 0),
		win_rate: closed > 0 ? Number(trades.wins) / closed : null,
		realized_pnl_sol: lamports(trades?.pnl),
		created_at: swarm.created_at,
	};
}

/** Full dashboard state for one swarm: treasury (on-chain), members, positions, votes, payouts. */
export async function getSwarmState(swarmId, { viewerUserId = null } = {}) {
	const swarm = await getSwarm(swarmId);
	if (!swarm) return null;
	const pol = normalizeSwarmPolicy(swarm.policy);
	const treasury = await getSwarmTreasuryAddress(swarm);

	const [balance, members, positions, votes, payouts] = await Promise.all([
		treasuryBalanceLamports(treasury, swarm.network).catch(() => null),
		sql`
			select sm.id, sm.agent_id, sm.user_id, sm.contribution_lamports, sm.withdrawn_lamports, sm.share_bps,
			       sm.reputation, sm.status, sm.is_creator, sm.joined_at, ai.name as agent_name, ai.profile_image_url, ai.avatar_url
			from swarm_members sm join agent_identities ai on ai.id = sm.agent_id
			where sm.swarm_id = ${swarmId} order by sm.share_bps desc, sm.joined_at asc`,
		sql`
			select id, mint, symbol, name, status, exit_reason, entry_quote_lamports, last_value_lamports,
			       realized_pnl_lamports, realized_pnl_pct, opened_at, closed_at, buy_sig, sell_sig
			from agent_sniper_positions where agent_id = ${swarm.treasury_agent_id} and network = ${swarm.network}
			order by coalesce(closed_at, opened_at) desc limit 50`,
		sql`select id, mint, decision, consensus, min_consensus, conviction, size_lamports, members_long, members_total, smart_money_score, breakdown, position_id, reason, created_at
			from swarm_votes where swarm_id = ${swarmId} order by created_at desc limit 40`,
		sql`select id, member_id, agent_id, position_id, kind, amount_lamports, share_bps, destination, signature, status, created_at
			from swarm_payouts where swarm_id = ${swarmId} order by created_at desc limit 60`,
	]);

	const sol = (v) => (v == null ? null : Number(String(v).split('.')[0]) / LAMPORTS_PER_SOL);
	const balLamports = balance == null ? null : balance;
	const contributed = members.filter((m) => m.status === 'active').reduce((a, m) => a + (Number(m.contribution_lamports) - Number(m.withdrawn_lamports)), 0);
	const closed = positions.filter((p) => p.status === 'closed');
	const wins = closed.filter((p) => Number(p.realized_pnl_lamports) > 0).length;
	const realizedPnl = closed.reduce((a, p) => a + Number(p.realized_pnl_lamports || 0), 0);

	const solscan = (sig) => (!sig || sig === 'SIMULATED' ? null : swarm.network === 'devnet' ? `https://solscan.io/tx/${sig}?cluster=devnet` : `https://solscan.io/tx/${sig}`);

	return {
		swarm: {
			id: swarm.id, name: swarm.name, description: swarm.description, network: swarm.network, status: swarm.status,
			owner_user_id: swarm.owner_user_id, owner_agent_id: swarm.owner_agent_id, created_at: swarm.created_at,
			kill_reason: swarm.kill_reason,
		},
		policy: pol,
		is_owner: viewerUserId != null && viewerUserId === swarm.owner_user_id,
		viewer_member: viewerUserId == null ? null : members.find((m) => m.user_id === viewerUserId && m.status === 'active') || null,
		treasury: {
			address: treasury,
			balance_lamports: balLamports == null ? null : balLamports.toString(),
			balance_sol: balLamports == null ? null : Number(balLamports) / LAMPORTS_PER_SOL,
			net_contributed_sol: contributed / LAMPORTS_PER_SOL,
			explorer: swarm.network === 'devnet' ? `https://solscan.io/account/${treasury}?cluster=devnet` : `https://solscan.io/account/${treasury}`,
		},
		track_record: {
			closed_trades: closed.length, wins, win_rate: closed.length ? wins / closed.length : null,
			realized_pnl_sol: realizedPnl / LAMPORTS_PER_SOL,
			open_positions: positions.filter((p) => ['open', 'opening', 'closing'].includes(p.status)).length,
		},
		members: (() => {
			// Vote weight is what consensus actually runs on: max(MIN_VOTE_WEIGHT, rep),
			// summed over ACTIVE members only (exited members carry none). Surfacing each
			// member's share of that total turns the abstract reputation score into the
			// literal "how much of this swarm's vote do you control" number — same formula
			// as computeConsensus, so the board can't drift from the engine.
			const voteWeight = (m) => (m.status === 'active' ? Math.max(MIN_VOTE_WEIGHT, Number(m.reputation) || 0) : 0);
			const totalVoteWeight = members.reduce((sum, m) => sum + voteWeight(m), 0);
			return members.map((m) => {
				const weight = voteWeight(m);
				return {
					id: m.id, agent_id: m.agent_id, name: m.agent_name,
					image: m.profile_image_url || m.avatar_url || null,
					contribution_sol: (Number(m.contribution_lamports) - Number(m.withdrawn_lamports)) / LAMPORTS_PER_SOL,
					share_bps: m.share_bps, reputation: m.reputation == null ? null : Number(m.reputation),
					vote_weight: weight, vote_power: totalVoteWeight > 0 ? weight / totalVoteWeight : 0,
					status: m.status, is_creator: m.is_creator, joined_at: m.joined_at,
				};
			});
		})(),
		positions: positions.map((p) => ({
			id: p.id, mint: p.mint, symbol: p.symbol, name: p.name, status: p.status, exit_reason: p.exit_reason,
			entry_sol: sol(p.entry_quote_lamports), current_sol: sol(p.last_value_lamports),
			pnl_sol: p.realized_pnl_lamports == null ? null : sol(p.realized_pnl_lamports), pnl_pct: p.realized_pnl_pct == null ? null : Number(p.realized_pnl_pct),
			opened_at: p.opened_at, closed_at: p.closed_at, buy_url: solscan(p.buy_sig), sell_url: solscan(p.sell_sig),
		})),
		votes: votes.map((v) => ({
			id: v.id, mint: v.mint, decision: v.decision, consensus: v.consensus, min_consensus: v.min_consensus,
			conviction: v.conviction, size_sol: sol(v.size_lamports), members_long: v.members_long, members_total: v.members_total,
			smart_money_score: v.smart_money_score, breakdown: v.breakdown, reason: v.reason, created_at: v.created_at,
		})),
		payouts: payouts.map((p) => ({
			id: p.id, kind: p.kind, amount_sol: sol(p.amount_lamports), share_bps: p.share_bps, status: p.status,
			agent_id: p.agent_id, destination: p.destination, tx_url: solscan(p.signature), created_at: p.created_at,
		})),
	};
}
