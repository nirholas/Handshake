// @ts-check
// GET /api/cron/rewards-distribute — the holder-rewards (reflections) loop.
//
// The `rewards` leg of every $THREE spend accrues in THREE_REWARDS_WALLET. This
// cron reads the live pool balance + a $THREE holder snapshot, computes the
// pro-rata distribution (computeRewardsDistribution — pure + tested), and returns
// the plan. The plan is the deflation-free alternative to a burn: value flows back
// to holders rather than being destroyed.
//
// Execution: distributing on-chain requires a funded distributor key
// (REWARDS_DISTRIBUTOR_SECRET). When it's absent the cron is authoritative as a
// DRY RUN — it returns exactly who would receive what so the plan can be audited
// offline — and reports executed:false with the reason. This mirrors the funded-
// signer gating on the platform's other on-chain payout lanes.
//
// Standalone (not [name].js) so the import graph stays minimal — just the token
// config, the holder snapshot reader, and the pure distribution math.

import { json, method, wrapCron } from '../_lib/http.js';
import { TOKEN_MINT, ATOMICS_PER_TOKEN, treasuryWalletOrNull, rewardsWalletOrNull } from '../_lib/token/config.js';
import { fetchHolderBalances } from '../_lib/coin/holders.js';
import { getBalances } from '../_lib/balances.js';
import { computeRewardsDistribution } from '../_lib/token/rewards.js';
import { recordRewardsDistribution } from '../_lib/token/payments.js';
import { requireCron } from '../_lib/cron-auth.js';

// Read the rewards pool's current $THREE balance (atomics). Returns 0n on any
// failure so the cron degrades to "nothing to distribute" rather than erroring.
async function readPoolAtomics(poolWallet) {
	try {
		const balances = await getBalances({ chain: 'solana', address: poolWallet });
		const entry = (balances?.tokens ?? []).find((t) => t.mint === TOKEN_MINT);
		const ui = entry?.amount || 0;
		return BigInt(Math.floor(ui * Number(ATOMICS_PER_TOKEN)));
	} catch {
		return 0n;
	}
}

export default wrapCron(async (req, res) => {
	if (!method(req, res, ['GET', 'POST'])) return;
	if (!requireCron(req, res)) return;

	const rewardsWallet = rewardsWalletOrNull();
	const treasuryWallet = treasuryWalletOrNull();
	if (!rewardsWallet) {
		return json(res, 200, {
			ok: true,
			executed: false,
			reason: 'THREE_REWARDS_WALLET not configured — no pool to distribute',
		});
	}

	// Min payout floor: skip dust so we don't pay a holder less than it costs to
	// create their ATA. One $THREE worth of atomics is a sane, mint-agnostic floor.
	const minPayoutAtomics = ATOMICS_PER_TOKEN;

	const [poolAtomics, snapshot] = await Promise.all([
		readPoolAtomics(rewardsWallet),
		fetchHolderBalances({ mint: TOKEN_MINT, network: 'mainnet' }),
	]);

	// Holders eligible for reflections = everyone holding $THREE, EXCLUDING the
	// platform's own wallets (pool can't pay itself; treasury isn't a holder).
	const exclude = new Set([rewardsWallet, treasuryWallet].filter(Boolean));
	const holders = (snapshot || [])
		.filter((h) => h?.wallet && !exclude.has(h.wallet))
		.map((h) => ({ wallet: h.wallet, balance: h.balance ?? h.amount ?? 0 }));

	const plan = computeRewardsDistribution({ poolAtomics, holders, minPayoutAtomics });

	// Distribution requires a funded signer; without it this run is an authoritative
	// dry run (the plan is exact and auditable). Executing is the only step gated.
	const distributorConfigured = Boolean(process.env.REWARDS_DISTRIBUTOR_SECRET);
	const note = distributorConfigured
		? 'executor pending funded-distributor verification'
		: 'REWARDS_DISTRIBUTOR_SECRET not configured — dry run only';

	// Record the run so /three can show a real, verifiable distribution history.
	// Status 'planned' (dry run) is logged but excluded from the reflected total —
	// only 'completed' on-chain runs count toward "reflected to holders". A logging
	// failure must never fail the cron, so it's best-effort.
	let recordId = null;
	try {
		const rec = await recordRewardsDistribution({
			mint: TOKEN_MINT,
			poolWallet: rewardsWallet,
			poolAtomics,
			distributedAtomics: plan.distributed,
			dustAtomics: plan.dust,
			holderCount: plan.payouts.length,
			eligibleSupplyAtomics: plan.eligibleSupply,
			status: 'planned',
			note,
		});
		recordId = rec.id;
	} catch (err) {
		console.error('[rewards-distribute] failed to record run', err?.message || err);
	}

	return json(res, 200, {
		distribution_id: recordId,
		ok: true,
		executed: false,
		dry_run: true,
		reason: note,
		mint: TOKEN_MINT,
		pool_wallet: rewardsWallet,
		pool_atomics: poolAtomics.toString(),
		eligible_holders: plan.payouts.length,
		eligible_supply_atomics: plan.eligibleSupply.toString(),
		distributable_atomics: plan.distributed.toString(),
		dust_atomics: plan.dust.toString(),
		// Cap the returned payout list so a 200k-holder snapshot doesn't blow the
		// response; the headline totals above cover the full set.
		payouts_preview: plan.payouts.slice(0, 100).map((p) => ({
			wallet: p.wallet,
			atomics: p.atomics.toString(),
		})),
	});
});
