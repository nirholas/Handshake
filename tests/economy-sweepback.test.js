// Guard-logic tests for the consolidation sweep (api/_lib/economy-sweepback.js)
// and its ledger rows (buildSweepbackRows in api/_lib/economy-ledger.js). Both
// planSweepback and buildSweepbackRows are pure, so the floors, dust guard,
// drain headroom, and the rising running balance are asserted without RPC, keys,
// or a database.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
	planSweepback,
	reclaimableSol,
	MIN_SWEEP_SOL,
	DRAIN_HEADROOM_LAMPORTS,
	planAgentReclaim,
	agentReclaimFloorSol,
	isPlatformOwnedAgent,
	PLATFORM_AGENT_OWNER_EMAIL,
	agentCandidateFromRow,
} from '../api/_lib/economy-sweepback.js';
import { MIN_OPERATIONAL_WALLET_SOL } from '../api/_lib/agent-trade-guards.js';
import { autoFundTargetSol } from '../api/_lib/agent-funding-policy.js';

// reclaimableSol: the emergency consolidation's sizing. The load-bearing property
// is anti-oscillation: it must NEVER leave an engine below minSol, or the topup
// (which funds anything below minSol) would immediately re-fund it and the two
// crons would ping-pong, burning fees forever.
test('reclaimableSol never leaves an engine below its floor', () => {
	for (const [current, min] of [
		[3, 1], [0.6, 0.2], [1.076, 1], [0.05, 0.02], [0.3, 0.03], [10, 0.05],
	]) {
		const r = reclaimableSol(current, min);
		assert.ok(current - r >= min, `left ${current - r} below floor ${min}`);
	}
});

test('reclaimableSol pulls the idle excess above the floor+buffer', () => {
	// launcher floored at 1 SOL sitting on 3 → reclaim ~1.9 (leaves 1.1 = min + 10%)
	assert.ok(Math.abs(reclaimableSol(3, 1) - 1.9) < 1e-6);
	// a2a floored at 0.02 on 0.035 → keep 0.025, reclaim 0.01 (== dust floor)
	assert.ok(reclaimableSol(0.035, 0.02) >= MIN_SWEEP_SOL - 1e-9);
});

test('reclaimableSol returns 0 when the engine is at or below its floor', () => {
	assert.equal(reclaimableSol(1, 1), 0);          // exactly at floor
	assert.equal(reclaimableSol(0.5, 1), 0);        // below floor
	assert.equal(reclaimableSol(1.05, 1), 0);       // within the buffer, not worth dust
});
import { ECONOMY_MASTER_ADDRESS } from '../api/_lib/economy-master.js';
import { buildSweepbackRows, buildAgentReclaimRows, hashEntry } from '../api/_lib/economy-ledger.js';
import { SOLANA_SIGNERS } from '../api/_lib/solana-signers.js';

test('defaults are the documented guard values', () => {
	assert.equal(MIN_SWEEP_SOL, 0.01);
	// Must stay above the ~890,880-lamport rent-exempt minimum: the runtime
	// rejects a transfer that leaves a system account above zero but below rent
	// exemption, so a smaller headroom would make every drain transaction fail.
	assert.equal(DRAIN_HEADROOM_LAMPORTS, 1_000_000);
	assert.ok(DRAIN_HEADROOM_LAMPORTS > 890_880);
});

test('excess mode: sweeps only what is above the float', () => {
	const { plan, totalSol } = planSweepback([
		{ name: 'a', pubkey: 'A', currentSol: 0.5, floorSol: 0.15 },
	]);
	assert.equal(plan.length, 1);
	assert.equal(plan[0].sol, 0.35);
	assert.equal(totalSol, 0.35);
});

test('excess mode: a signer at or below its float is never touched', () => {
	const { plan, skipped } = planSweepback([
		{ name: 'at-float', pubkey: 'A', currentSol: 0.15, floorSol: 0.15 },
		{ name: 'below-float', pubkey: 'B', currentSol: 0.05, floorSol: 0.15 },
	]);
	assert.equal(plan.length, 0);
	assert.deepEqual(
		skipped.map((s) => s.reason),
		['at_or_below_float', 'at_or_below_float'],
	);
});

test('excess mode: dust above the float is skipped (fee churn guard)', () => {
	const { plan, skipped } = planSweepback([
		{ name: 'dusty', pubkey: 'A', currentSol: 0.155, floorSol: 0.15 },
	]);
	assert.equal(plan.length, 0);
	assert.equal(skipped[0].reason, 'at_or_below_float');
});

test('drain mode: ignores the float, keeps only fee headroom', () => {
	const { plan } = planSweepback(
		[{ name: 'a', pubkey: 'A', currentSol: 0.15, floorSol: 0.15 }],
		{ mode: 'drain' },
	);
	assert.equal(plan.length, 1);
	assert.equal(plan[0].sol, 0.15 - DRAIN_HEADROOM_LAMPORTS / 1e9);
});

test('drain mode: an empty wallet is skipped, not overdrawn', () => {
	const { plan, skipped } = planSweepback(
		[{ name: 'empty', pubkey: 'A', currentSol: 0.000005, floorSol: 0.15 }],
		{ mode: 'drain' },
	);
	assert.equal(plan.length, 0);
	assert.equal(skipped[0].reason, 'below_dust_threshold');
});

test('minSweepSol override tightens the dust guard', () => {
	const { plan } = planSweepback(
		[{ name: 'a', pubkey: 'A', currentSol: 1.04, floorSol: 1 }],
		{ minSweepSol: 0.05 },
	);
	assert.equal(plan.length, 0);
});

test('registry: token-holding wallets are flagged so excess mode spares their tokens', () => {
	const flagged = SOLANA_SIGNERS.filter((s) => s.holdsTokens).map((s) => s.name);
	for (const name of ['three-buyback', 'club-treasury', 'platform-treasury', 'coin-treasury']) {
		assert.ok(flagged.includes(name), `${name} must keep its operational token float`);
	}
});

test('registry: the circulation treasury is funded and swept like any engine', () => {
	const spec = SOLANA_SIGNERS.find((s) => s.name === 'circulation-treasury');
	assert.ok(spec, 'circulation-treasury must be in the registry');
	assert.equal(spec.env, 'CIRCULATION_TREASURY_SECRET');
	assert.ok(spec.refillTo > spec.minSol);
});

test('ledger rows: inflows raise the running balance and the summary closes the batch', () => {
	const rows = buildSweepbackRows({
		masterPubkey: ECONOMY_MASTER_ADDRESS,
		result: {
			mode: 'excess',
			masterSolBefore: 10,
			masterSolAfter: 10.35,
			sweptSol: [
				{ name: 'a', pubkey: 'A', sol: 0.2, signature: 'sigA' },
				{ name: 'b', pubkey: 'B', sol: 0.15, signature: 'sigB' },
			],
			sweptTokens: [{ name: 'a', pubkey: 'A', mint: 'M', amount: '5', decimals: 6, signature: 'sigT' }],
			failed: [{ name: 'c', pubkey: 'C', sol: 0.1, reason: 'send_failed' }],
			skipped: [],
			receivedSol: 0.35,
		},
		solUsd: 100,
		now: 1_700_000_000_000,
	});
	assert.equal(rows.length, 5);
	assert.equal(rows[0].event, 'inflow');
	assert.equal(rows[0].master_sol_after, 10.2);
	assert.equal(rows[1].master_sol_after, 10.35);
	assert.equal(rows[1].usd_value, 15);
	assert.equal(rows[2].event, 'inflow_token');
	assert.deepEqual(rows[2].detail, { mint: 'M', amount: '5', decimals: 6 });
	assert.equal(rows[3].event, 'inflow_failed');
	assert.equal(rows[3].reason, 'send_failed');
	const summary = rows[4];
	assert.equal(summary.event, 'sweepback');
	assert.equal(summary.sol, 0.35);
	assert.equal(summary.master_sol_after, 10.35);
	assert.equal(summary.detail.sol_transfers, 2);
	assert.equal(summary.detail.token_transfers, 1);
});

test('ledger rows: a no-op sweep still writes the sweepback heartbeat', () => {
	const rows = buildSweepbackRows({
		masterPubkey: ECONOMY_MASTER_ADDRESS,
		result: { mode: 'excess', sweptSol: [], sweptTokens: [], failed: [], skipped: [], receivedSol: 0 },
		now: 1_700_000_000_000,
	});
	assert.equal(rows.length, 1);
	assert.equal(rows[0].event, 'sweepback');
	assert.equal(rows[0].sol, 0);
});

test('ledger rows: hash-chainable with the same hashEntry the topup uses', () => {
	const rows = buildSweepbackRows({
		masterPubkey: ECONOMY_MASTER_ADDRESS,
		result: {
			mode: 'excess',
			masterSolBefore: 1,
			sweptSol: [{ name: 'a', pubkey: 'A', sol: 0.2, signature: 'sig' }],
			sweptTokens: [],
			failed: [],
			skipped: [],
			receivedSol: 0.2,
		},
		now: 1_700_000_000_000,
	});
	let prev = '';
	for (const [i, r] of rows.entries()) {
		const row = { ...r, seq: i + 1 };
		const hash = hashEntry(prev, row);
		assert.equal(typeof hash, 'string');
		assert.equal(hash.length, 64);
		prev = hash;
	}
});

// ── platform agent reclaim ───────────────────────────────────────────────────
// The agent-wallet reclaim closes the one-way master → agent funding path that
// stranded 7.2 of the fleet's 7.53 SOL while the fee wallet sat under its settle
// floor. Its safety story is entirely in these pure functions: who may be swept,
// and how much must be left behind.

const PLATFORM = PLATFORM_AGENT_OWNER_EMAIL;
const BOT = 'atlas22@agents.three.ws';

test('isPlatformOwnedAgent accepts only house and bot accounts', () => {
	assert.equal(isPlatformOwnedAgent(PLATFORM), true);
	assert.equal(isPlatformOwnedAgent(BOT), true);
	assert.equal(isPlatformOwnedAgent('ASHA@Agents.Three.WS'), true); // case-insensitive
	// Customers, in every shape they appear in the users table.
	assert.equal(isPlatformOwnedAgent('sol-0000000000000000@wallet.local'), false);
	assert.equal(isPlatformOwnedAgent('someuser@users.three.ws.local'), false);
	assert.equal(isPlatformOwnedAgent('someone@example.com'), false);
	// Near-miss domains must not squeak through a suffix check.
	assert.equal(isPlatformOwnedAgent('evil@notagents.three.ws.attacker.com'), false);
	assert.equal(isPlatformOwnedAgent(null), false);
	assert.equal(isPlatformOwnedAgent(''), false);
	assert.equal(isPlatformOwnedAgent(undefined), false);
});

test('agentReclaimFloorSol leaves a working trader its trade capital', () => {
	// An enabled strategy keeps 2x its own per-trade size, so reclaim can never
	// starve an agent that is actively trading.
	assert.ok(agentReclaimFloorSol({ enabled: true, perTradeSol: 0.05 }) >= 0.1);
	assert.ok(agentReclaimFloorSol({ enabled: true, perTradeSol: 0.207 }) >= 0.414);
	// No enabled strategy → only fee headroom is retained.
	const idle = agentReclaimFloorSol({ enabled: false, perTradeSol: 0.5 });
	assert.ok(idle > 0 && idle < 0.05);
	// Malformed strategy rows fall back to the idle floor, never to zero.
	assert.ok(agentReclaimFloorSol({ enabled: true, perTradeSol: 0 }) > 0);
	assert.ok(agentReclaimFloorSol({ enabled: true, perTradeSol: NaN }) > 0);
	assert.ok(agentReclaimFloorSol({}) > 0);
});

test('agentReclaimFloorSol keeps a small-size arm able to actually trade', () => {
	// The state this closes: an enabled arm sized at 0.002 SOL/trade kept a floor of
	// 0.004 SOL, which cannot pay the token ATA's rent, the fee/tip headroom AND the
	// firewall's simulated round-trip — so every entry aborted at a safety check the
	// wallet could no longer afford to run. Funded on every dashboard, dead in fact.
	const tiny = agentReclaimFloorSol({ enabled: true, perTradeSol: 0.002 });
	assert.ok(tiny >= MIN_OPERATIONAL_WALLET_SOL, `floor ${tiny} must cover one complete trade`);
	// The working-capital multiple still applies on top for a larger arm.
	assert.ok(agentReclaimFloorSol({ enabled: true, perTradeSol: 0.05 }) >= 0.1 + MIN_OPERATIONAL_WALLET_SOL);
	// A disabled arm is still swept to the bare idle floor — this changes nothing there.
	assert.ok(agentReclaimFloorSol({ enabled: false, perTradeSol: 0.002 }) < MIN_OPERATIONAL_WALLET_SOL);
});

test('agentReclaimFloorSol never sweeps an auto-funded wallet below its refill target', () => {
	// The oscillation this closes, measured on mainnet: the funder refilled an arm to
	// its target, the reclaim swept it back minutes later, repeat — 0.24 SOL round
	// -tripped six times in 15 minutes across two arms, and the arms never held a
	// balance long enough to trade. A reclaim floor under the funding target is a
	// perpetual-motion fee burner.
	const target = autoFundTargetSol();
	assert.ok(agentReclaimFloorSol({ enabled: true, autoFundEnabled: true, perTradeSol: 0.002 }) >= target);
	// It holds for a switched-off arm too: `enabled` is not what triggers a refill.
	assert.ok(agentReclaimFloorSol({ enabled: false, autoFundEnabled: true, perTradeSol: 0.002 }) >= target);
	// An agent the funder does not manage can still be swept to the bare idle floor.
	assert.ok(agentReclaimFloorSol({ enabled: false, autoFundEnabled: false, perTradeSol: 0.002 }) < target);
});

test('planAgentReclaim leaves an enabled arm enough to place its next trade', () => {
	const { plan } = planAgentReclaim([
		{
			agentId: 'arm', name: 'rules-classic', address: 'Arm111',
			owner: 'three-ws@users.three.ws.local', sol: 0.05,
			strategy: { enabled: true, perTradeSol: 0.002 },
		},
	]);
	if (plan.length) {
		const retained = 0.05 - plan[0].sol;
		assert.ok(retained >= MIN_OPERATIONAL_WALLET_SOL, `retained ${retained} SOL must still fund a trade`);
	}
});

test('planAgentReclaim never plans a customer wallet, whatever the balance', () => {
	const { plan, skipped } = planAgentReclaim([
		{ agentId: 'a', name: 'Customer Sniper', address: 'Cust111', owner: 'sol-0000000000000000@wallet.local', sol: 2.13 },
		{ agentId: 'b', name: 'Customer Agent', address: 'Cust222', owner: 'someuser@users.three.ws.local', sol: 0.136 },
	]);
	assert.equal(plan.length, 0);
	assert.equal(skipped.length, 2);
	assert.ok(skipped.every((s) => s.reason === 'not_platform_owned'));
});

test('planAgentReclaim skips agents with capital committed to open positions', () => {
	const { plan, skipped } = planAgentReclaim([
		{ agentId: 'a', name: 'Swarm 1', address: 'S1', owner: PLATFORM, sol: 5, openPositions: 1 },
	]);
	assert.equal(plan.length, 0);
	assert.equal(skipped[0].reason, 'capital_committed');
});

test('planAgentReclaim leaves every swept agent at or above its floor', () => {
	const candidates = [
		{ agentId: 'a', name: 'three', address: 'T1', owner: PLATFORM, sol: 0.35147, strategy: { enabled: true, perTradeSol: 0.05 } },
		{ agentId: 'b', name: 'Atlas #22', address: 'A1', owner: BOT, sol: 0.07839, strategy: { enabled: false } },
		{ agentId: 'c', name: 'Swarm 2', address: 'S2', owner: PLATFORM, sol: 0.0354, strategy: { enabled: true, perTradeSol: 0.207 } },
	];
	const { plan } = planAgentReclaim(candidates);
	for (const p of plan) {
		const c = candidates.find((x) => x.address === p.address);
		assert.ok(c.sol - p.sol >= p.floorSol, `${p.name} would drop below its floor`);
	}
	// Swarm 2 trades 0.207 SOL a pop and holds 0.0354 — far under floor, never swept.
	assert.equal(plan.find((p) => p.name === 'Swarm 2'), undefined);
	// The genuinely idle bot wallet is the kind of stranded capital this exists for.
	assert.ok(plan.some((p) => p.name === 'Atlas #22'));
});

test('planAgentReclaim honours the dust guard and the per-run wallet cap', () => {
	const dust = planAgentReclaim([
		{ agentId: 'a', name: 'Persona', address: 'P1', owner: BOT, sol: 0.0051, strategy: { enabled: false } },
	]);
	assert.equal(dust.plan.length, 0);
	assert.equal(dust.skipped[0].reason, 'at_or_below_floor');

	const many = Array.from({ length: 10 }, (_, i) => ({
		agentId: `a${i}`, name: `Persona ${i}`, address: `P${i}`, owner: BOT, sol: 1, strategy: { enabled: false },
	}));
	const capped = planAgentReclaim(many, { maxWallets: 3 });
	assert.equal(capped.plan.length, 3);
	assert.equal(capped.skipped.filter((s) => s.reason === 'run_cap_reached').length, 7);
	assert.ok(capped.totalSol > 0);
});

// The row -> candidate mapping. This is the seam the pure-function tests above
// cannot see: every guard they assert reads a field that agentCandidateFromRow
// must actually carry off the SQL row. When `auto_fund_enabled` was missing from
// that mapping the anti-oscillation floor silently read `undefined` and collapsed
// to 0 in production while this suite stayed green, so the mapping itself is
// pinned here, field by field.
test('agentCandidateFromRow carries every guard-bearing field off the SQL row', () => {
	const row = {
		agent_id: 'ag_1',
		name: 'Atlas #22',
		address: 'A1',
		owner: BOT,
		secret: 'enc',
		open_positions: 2,
		strategy_enabled: true,
		auto_fund_enabled: true,
		per_trade_lamports: 2_000_000,
	};
	const c = agentCandidateFromRow(row, 0.5);

	assert.equal(c.agentId, 'ag_1');
	assert.equal(c.address, 'A1');
	assert.equal(c.owner, BOT);
	assert.equal(c.secret, 'enc');
	assert.equal(c.sol, 0.5);
	// Ownership, committed capital, and both floor inputs must survive the mapping:
	// planAgentReclaim and agentReclaimFloorSol read exactly these.
	assert.equal(c.openPositions, 2);
	assert.equal(c.strategy.enabled, true);
	assert.equal(c.strategy.autoFundEnabled, true);
	assert.equal(c.strategy.perTradeSol, 0.002);

	// The regression proper: an auto-funded agent's floor must reach the funder's
	// target through the mapping, not just when a test hand-builds the strategy.
	assert.ok(agentReclaimFloorSol(c.strategy) >= autoFundTargetSol());
});

test('agentCandidateFromRow defaults a bare row without inventing consent', () => {
	// No strategy row at all (the LEFT JOIN missed): every flag must read false, and
	// `undefined` must never reach the anti-oscillation floor as a truthy value.
	const c = agentCandidateFromRow(
		{ agent_id: 'ag_2', name: null, address: 'A2', owner: BOT, secret: 'enc' },
		0.1,
	);
	assert.equal(c.name, 'Agent');
	assert.equal(c.openPositions, 0);
	assert.equal(c.strategy.enabled, false);
	assert.equal(c.strategy.autoFundEnabled, false);
	assert.equal(c.strategy.perTradeSol, 0);

	// Postgres can hand back `false`/null for the flag; neither is consent.
	const off = agentCandidateFromRow({ agent_id: 'a', address: 'A', owner: BOT, secret: 's', auto_fund_enabled: false }, 1);
	assert.equal(off.strategy.autoFundEnabled, false);
	const nul = agentCandidateFromRow({ agent_id: 'a', address: 'A', owner: BOT, secret: 's', auto_fund_enabled: null }, 1);
	assert.equal(nul.strategy.autoFundEnabled, false);
});

// ── agent-reclaim ledger rows ────────────────────────────────────────────────
// The agent leg was the only money path in the economy that wrote NOTHING to the
// book of record when it failed. "The reclaim ran and every wallet was
// unreadable" and "the reclaim never ran" were the same absence of rows, and on
// 2026-07-29 that ambiguity cost ~11 hours with the sponsor under its settle
// floor. These pin the three row kinds and, above all, that the summary is
// written even when nothing moved.

test('agent reclaim: a failed send writes an inflow_failed row naming the reason', () => {
	const rows = buildAgentReclaimRows({
		masterPubkey: ECONOMY_MASTER_ADDRESS,
		masterSolBefore: 0.2,
		deficitSol: 0.4,
		result: {
			reclaimedSol: 0.05,
			moves: [{ agentId: 'ag1', name: 'bot-one', address: 'A1', sol: 0.05, signature: 'sig1' }],
			failed: [{ name: 'bot-two', address: 'A2', sol: 0.07, stage: 'send', reason: 'blockhash not found' }],
			skipped: [{ name: 'bot-three', reason: 'at_or_below_floor' }],
			readErrors: [],
		},
		solUsd: 100,
		now: 1_700_000_000_000,
	});
	assert.equal(rows.length, 3);
	assert.equal(rows[0].event, 'inflow');
	assert.equal(rows[0].master_sol_after, 0.25);
	assert.equal(rows[0].tx_signature, 'sig1');
	assert.equal(rows[1].event, 'inflow_failed');
	assert.equal(rows[1].reason, 'blockhash not found');
	assert.equal(rows[1].target_pubkey, 'A2');
	assert.equal(rows[1].detail.stage, 'send');
	// A failed send must not move the running balance.
	assert.equal(rows[1].master_sol_after, 0.25);
	assert.equal(rows[2].event, 'agent_reclaim');
	assert.equal(rows[2].detail.deficit_sol, 0.4);
	assert.deepEqual(rows[2].detail.skipped_reasons, { at_or_below_floor: 1 });
});

test('agent reclaim: an undecryptable secret keeps its stage, so it is not chased as an RPC fault', () => {
	// A WebCrypto AES-GCM OperationError wearing a Solana costume. The SOL behind
	// it is unreachable until the right WALLET_ENCRYPTION_KEY is present, and no
	// RPC tier or deposit changes that.
	const rows = buildAgentReclaimRows({
		masterPubkey: ECONOMY_MASTER_ADDRESS,
		result: {
			reclaimedSol: 0,
			moves: [],
			failed: [{ name: 'bot', address: 'A', sol: 0.3, stage: 'recover', reason: 'secret_undecryptable: OperationError' }],
			skipped: [],
			readErrors: [],
		},
		now: 1_700_000_000_000,
	});
	assert.equal(rows[0].event, 'inflow_failed');
	assert.equal(rows[0].detail.stage, 'recover');
	assert.match(rows[0].reason, /^secret_undecryptable/);
	assert.equal(rows[1].reason, 'blocked');
});

test('agent reclaim: unreadable balances are recorded as blocked, not as an empty fleet', () => {
	// The 2026-07-29 shape exactly: every lane in quota cooldown, so every read
	// failed and nothing was ever planned. Sizing a funding ask from this run
	// would be wrong; the summary says `blocked` so nobody does.
	const readErrors = Array.from({ length: 25 }, (_, i) => ({
		name: `bot-${i}`, address: `A${i}`, reason: 'rpc_error: 429 Too Many Requests',
	}));
	const rows = buildAgentReclaimRows({
		masterPubkey: ECONOMY_MASTER_ADDRESS,
		result: { reclaimedSol: 0, moves: [], failed: [], skipped: [], readErrors },
		now: 1_700_000_000_000,
	});
	// Capped rows, uncapped counts: the chain stays bounded, the truth does not.
	assert.equal(rows.length, 21);
	assert.equal(rows[0].event, 'inflow_failed');
	assert.equal(rows[0].detail.stage, 'read');
	assert.match(rows[0].reason, /rpc_error/);
	const summary = rows[20];
	assert.equal(summary.event, 'agent_reclaim');
	assert.equal(summary.reason, 'blocked');
	assert.equal(summary.detail.read_errors, 25);
	assert.equal(summary.detail.read_errors_logged, 20);
});

test('agent reclaim: a no-op run still writes the summary, and says nothing was reclaimable', () => {
	// The load-bearing case. Without this row, "ran and found nothing" and "never
	// ran" are indistinguishable, and only one of them needs the owner's money.
	const rows = buildAgentReclaimRows({
		masterPubkey: ECONOMY_MASTER_ADDRESS,
		result: {
			reclaimedSol: 0, moves: [], failed: [], readErrors: [],
			skipped: [{ name: 'a', reason: 'at_or_below_floor' }, { name: 'b', reason: 'capital_committed' }],
		},
		now: 1_700_000_000_000,
	});
	assert.equal(rows.length, 1);
	assert.equal(rows[0].event, 'agent_reclaim');
	assert.equal(rows[0].reason, 'nothing_reclaimable');
	assert.equal(rows[0].sol, 0);
	assert.deepEqual(rows[0].detail.skipped_reasons, { at_or_below_floor: 1, capital_committed: 1 });
});

test('agent reclaim: a leg that threw records its own error rather than a clean zero', () => {
	const rows = buildAgentReclaimRows({
		masterPubkey: ECONOMY_MASTER_ADDRESS,
		result: { reclaimedSol: 0, moves: [], failed: [], skipped: [], readErrors: [], error: 'agent_reclaim_failed' },
		now: 1_700_000_000_000,
	});
	assert.match(rows[0].reason, /^leg_error: agent_reclaim_failed/);
});

test('agent reclaim: a dry run is recorded as a dry run', () => {
	const rows = buildAgentReclaimRows({
		masterPubkey: ECONOMY_MASTER_ADDRESS,
		result: { reclaimedSol: 0.1, moves: [{ name: 'a', address: 'A', sol: 0.1, dryRun: true }], failed: [], skipped: [], readErrors: [], dryRun: true },
		now: 1_700_000_000_000,
	});
	assert.equal(rows[1].detail.dry_run, true);
});

test('agent reclaim: rows chain like every other ledger batch', () => {
	// The rows are appended to the same tamper-evident chain, so they must hash
	// the same way. A row shape the hasher cannot read breaks verifyChain from
	// that point on, which reads as a tamper, not as a bug.
	const rows = buildAgentReclaimRows({
		masterPubkey: ECONOMY_MASTER_ADDRESS,
		masterSolBefore: 1,
		result: {
			reclaimedSol: 0.2,
			moves: [{ name: 'a', address: 'A', sol: 0.2, signature: 'sigA' }],
			failed: [{ name: 'b', address: 'B', sol: 0.1, stage: 'send', reason: 'send_failed' }],
			skipped: [], readErrors: [],
		},
		now: 1_700_000_000_000,
	});
	let prev = '';
	const hashes = rows.map((r, i) => {
		const h = hashEntry(prev, { ...r, seq: i + 1 });
		prev = h;
		return h;
	});
	assert.equal(new Set(hashes).size, rows.length);
	assert.ok(hashes.every((h) => /^[0-9a-f]{64}$/.test(h)));
});
