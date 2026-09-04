// @ts-check
// GET/POST /api/cron/economy-rebalance — keep USDC-spending engine wallets stocked
// in USDC by swapping a slice of their own SOL, and vice versa. The companion to
// treasury-topup: topup moves SOL down to engines below their SOL floor; this
// converts SOL↔USDC on the engines that spend the OTHER asset, so loading the
// economy with SOL alone still keeps the x402 ring and a2a settlement payers able
// to pay in USDC.
//
// SAFE BY DEFAULT: inert unless ECONOMY_REBALANCE_ENABLED=1. Even disabled it
// computes and returns the plan (dry run) so the owner can see what it WOULD do
// before arming it, and `?dry=1` returns that same plan without signing even
// when it IS armed. Every swap is reserve-, per-swap-, per-run- and slippage-capped
// (see economy-rebalance.js). Read-and-quote only until armed.
//
// Env: CRON_SECRET, SOLANA_RPC_URL, the a2a-payer / x402-ring-payer signer secrets,
// and the ECONOMY_REBALANCE_* tuning knobs.
import { json, method, wrapCron } from '../_lib/http.js';
import { env } from '../_lib/env.js';
import { solanaConnection } from '../_lib/solana/connection.js';
import { SOLANA_SIGNERS, resolveSignerPubkey, loadSignerKeypair } from '../_lib/solana-signers.js';
import { solUsdPrice } from '../_lib/avatar-wallet.js';
import { planRebalance, executeSwap, resolveSelfPayFloors, REBALANCE, USDC_WALLETS, WSOL_MINT } from '../_lib/economy-rebalance.js';
import { USDC_MINT_BY_NETWORK } from '../_lib/vault-jupiter.js';
import { logAudit } from '../_lib/audit.js';
import { requireCron } from '../_lib/cron-auth.js';

const NETWORK = 'mainnet';
const USDC_MINT = USDC_MINT_BY_NETWORK[NETWORK];

async function readWallet(connection, pubkey) {
	const { PublicKey } = await import('@solana/web3.js');
	let sol = 0;
	let usdc = 0;
	// Whether a wSOL account already exists decides whether a usdc->sol swap has
	// to fund one out of this wallet's own lamports (planRebalance's swap-rent
	// guard). Read it here rather than assuming: assuming "absent" would block a
	// wallet that can in fact swap.
	let hasWsolAccount = false;
	try {
		const owner = new PublicKey(pubkey);
		sol = (await connection.getBalance(owner)) / 1e9;
		const accts = await connection.getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(USDC_MINT) });
		usdc = accts.value.reduce(
			(a, x) => a + Number(x.account.data.parsed.info.tokenAmount.uiAmount || 0),
			0,
		);
		const wsol = await connection.getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(WSOL_MINT) });
		hasWsolAccount = wsol.value.length > 0;
	} catch {
		/* an RPC hiccup — report zeros; the plan just skips this wallet honestly */
	}
	return { sol, usdc, hasWsolAccount };
}

export default wrapCron(async (req, res) => {
	if (!method(req, res, ['GET', 'POST'])) return;
	if (!requireCron(req, res)) return;

	const solPriceUsd = await solUsdPrice().catch(() => 0);
	const connection = solanaConnection({ url: process.env.SOLANA_RPC_URL, commitment: 'confirmed' });

	// Resolve each USDC wallet's pubkey + live balances.
	const wallets = [];
	for (const cfg of USDC_WALLETS) {
		const spec = SOLANA_SIGNERS.find((s) => s.name === cfg.role);
		if (!spec) continue;
		const resolved = await resolveSignerPubkey(spec).catch(() => null);
		const pubkey = resolved?.pubkey;
		if (!pubkey) continue;
		const { sol, usdc, hasWsolAccount } = await readWallet(connection, pubkey);
		const floorUsd = Number(process.env[cfg.floorEnv]) || cfg.floorDflt;
		// A self-pay wallet's fee-SOL refill target doubles as the untouchable
		// reserve on its sol->usdc leg (see planRebalance), so the USDC floor can
		// never be fed by clawing back the fee runway the SOL leg just bought.
		const targetSol = cfg.selfPayFee ? (spec.refillTo ?? (spec.minSol ?? 0) * 3) : 0;
		// Both legs of a self-pay wallet must aim at the SAME fee-SOL level or they
		// reverse each other. resolveSelfPayFloors keeps that level at targetSol
		// while the wallet can afford both floors, and drops it to the bare fee
		// reserve when it cannot, the state that deadlocked the ring payer for eight
		// days. It also decides when the usdc->sol rescue leg is armed.
		const floors = cfg.selfPayFee
			? resolveSelfPayFloors({ sol, usdc, solPriceUsd, targetSol, usdcFloorUsd: floorUsd })
			: { solFloor: 0, constrained: false, rescueArmed: false };
		wallets.push({ name: cfg.role, pubkey, sol, usdc, hasWsolAccount, wants: 'usdc', floorUsd, solFloor: floors.solFloor });

		// Self-pay fee wallets get a second row for their SOL need. Same name on
		// purpose: the executor resolves the signing key by name, and both legs
		// are self-swaps on the same wallet. Armed only once the wallet is under the
		// bare fee reserve -- the point where it genuinely cannot pay its own way --
		// and targeting the same resolved floor the sol->usdc leg holds back, so a
		// rescue can never overshoot into a level the other leg will claw straight
		// back.
		if (floors.rescueArmed) {
			wallets.push({ name: cfg.role, pubkey, sol, usdc, hasWsolAccount, wants: 'sol', floorUsd: floors.solFloor * solPriceUsd });
		}
	}

	const { plan, skipped } = planRebalance({ solPriceUsd, wallets });
	const armed = REBALANCE.enabled;
	// ?dry=1 → plan only, no key load and no swap. Being disarmed used to be the
	// only path that did not sign: with ECONOMY_REBALANCE_ENABLED=1 in
	// production a ?dry=1 preview built, signed and submitted real swaps (hit
	// 2026-09-04 while previewing this cron). treasury-topup has honored the
	// same query flag since it shipped and the triage runbook tells an operator
	// to preview before firing, so the two crons agreeing is what makes that
	// instruction safe to follow.
	const dryRun = /[?&]dry=(1|true)\b/.test(req.url || '');

	// Dry run (disarmed, or asked for): return the plan without touching a key.
	if (!armed || dryRun) {
		return json(res, 200, {
			ok: true,
			armed,
			mode: 'dry_run',
			solPriceUsd,
			wallets: wallets.map((w) => ({
				name: w.name, sol: w.sol, usdc: w.usdc, wants: w.wants, floorUsd: w.floorUsd, solFloor: w.solFloor,
			})),
			plan,
			skipped,
			note: armed
				? 'dry=1: plan only, no swaps executed'
				: 'ECONOMY_REBALANCE_ENABLED is not set, so no swaps executed',
		});
	}

	// Armed — execute each planned leg as a self-swap on its wallet.
	const results = [];
	for (const leg of plan) {
		const spec = SOLANA_SIGNERS.find((s) => s.name === leg.name);
		let keypair;
		try {
			// loadSignerKeypair returns { configured, keypair, decodeError } — the
			// web3.js Keypair lives on .keypair (same shape economy-sweepback uses).
			const loaded = await loadSignerKeypair(spec);
			keypair = loaded?.keypair || null;
			if (!keypair) {
				results.push({
					name: leg.name,
					status: 'skipped',
					reason: loaded?.decodeError ? 'signer_decode_error' : 'signer_unconfigured',
				});
				continue;
			}
		} catch (err) {
			results.push({ name: leg.name, status: 'failed', reason: `key: ${err.message}` });
			continue;
		}
		try {
			const r = await executeSwap({ connection, keypair, leg, solPriceUsd, network: NETWORK });
			results.push(r);
			if (r.status === 'swapped') {
				// logAudit is fire-and-forget: it schedules its own microtask, swallows
				// its own DB errors, and returns undefined — so do NOT await or .catch it
				// (that threw "reading 'catch'" on every successful swap), and the payload
				// field is `meta`, not `detail`.
				logAudit({
					action: 'economy_rebalance_swap',
					meta: { name: r.name, dir: r.dir, inUsd: r.inUsd, signature: r.signature },
				});
			}
		} catch (err) {
			results.push({ name: leg.name, status: 'failed', reason: err.message?.slice(0, 160) });
		}
	}

	return json(res, 200, { ok: true, armed: true, mode: 'live', solPriceUsd, plan, results, skipped });
	// Deliberately NOT gated on requireWriteCapacity: this cron is what refills
	// the x402 fee wallet, and skipping it while the DB sits at its storage
	// high-water mark starves every settle (2026-07-28: the pressure latch
	// preceded a fee_wallet_below_floor outage). Its own writes are a handful of
	// best-effort audit rows; a genuine capacity error still degrades gracefully
	// inside wrapCron.
});
