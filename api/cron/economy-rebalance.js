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
// before arming it. Every swap is reserve-, per-swap-, per-run- and slippage-capped
// (see economy-rebalance.js). Read-and-quote only until armed.
//
// Env: CRON_SECRET, SOLANA_RPC_URL, the a2a-payer / x402-ring-payer signer secrets,
// and the ECONOMY_REBALANCE_* tuning knobs.
import { json, method, wrapCron } from '../_lib/http.js';
import { env } from '../_lib/env.js';
import { constantTimeEquals } from '../_lib/crypto.js';
import { solanaConnection } from '../_lib/solana/connection.js';
import { SOLANA_SIGNERS, resolveSignerPubkey, loadSignerKeypair } from '../_lib/solana-signers.js';
import { solUsdPrice } from '../_lib/avatar-wallet.js';
import { planRebalance, executeSwap, REBALANCE, WSOL_MINT } from '../_lib/economy-rebalance.js';
import { USDC_MINT_BY_NETWORK } from '../_lib/vault-jupiter.js';
import { logAudit } from '../_lib/audit.js';

// Which engine wallets spend USDC and therefore want a USDC floor kept topped up
// from their SOL. floorUsd is env-overridable per role.
//
// selfPayFee: this wallet ALSO pays its own SOL network fee on every self-pay
// ring settle, so it has a second, independent need: SOL. Without it the
// planner only ever saw the USDC side, and a payer that drifted under the
// 0.02 SOL settle floor while holding plenty of USDC deadlocked the whole
// ring (July 2026, twice): the facilitator rejected every settle while the
// rebalancer reported "above_floor". The SOL leg only arms when the wallet is
// genuinely below its registry minSol (true starvation, not routine drift),
// and refills toward refillTo so one swap buys days of fee runway.
const USDC_WALLETS = [
	{ role: 'x402-ring-payer', floorEnv: 'ECONOMY_REBALANCE_RING_USDC_FLOOR', floorDflt: 10, selfPayFee: true },
	{ role: 'a2a-payer', floorEnv: 'ECONOMY_REBALANCE_A2A_USDC_FLOOR', floorDflt: 5 },
];

function requireCron(req, res) {
	const secret = process.env.CRON_SECRET || env.CRON_SECRET;
	if (!secret) {
		json(res, 503, { error: 'not_configured', message: 'CRON_SECRET unset' });
		return false;
	}
	const auth = req.headers['authorization'] || '';
	const presented = auth.startsWith('Bearer ') ? auth.slice(7) : '';
	if (!constantTimeEquals(presented, secret)) {
		json(res, 401, { error: 'unauthorized' });
		return false;
	}
	return true;
}

const NETWORK = 'mainnet';
const USDC_MINT = USDC_MINT_BY_NETWORK[NETWORK];

async function readWallet(connection, pubkey) {
	const { PublicKey } = await import('@solana/web3.js');
	let sol = 0;
	let usdc = 0;
	try {
		const owner = new PublicKey(pubkey);
		sol = (await connection.getBalance(owner)) / 1e9;
		const accts = await connection.getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(USDC_MINT) });
		usdc = accts.value.reduce(
			(a, x) => a + Number(x.account.data.parsed.info.tokenAmount.uiAmount || 0),
			0,
		);
	} catch {
		/* an RPC hiccup — report zeros; the plan just skips this wallet honestly */
	}
	return { sol, usdc };
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
		const { sol, usdc } = await readWallet(connection, pubkey);
		const floorUsd = Number(process.env[cfg.floorEnv]) || cfg.floorDflt;
		// A self-pay wallet's fee-SOL refill target doubles as the untouchable
		// reserve on its sol->usdc leg (see planRebalance), so the USDC floor can
		// never be fed by clawing back the fee runway the SOL leg just bought.
		const targetSol = cfg.selfPayFee ? (spec.refillTo ?? (spec.minSol ?? 0) * 3) : 0;
		wallets.push({ name: cfg.role, pubkey, sol, usdc, wants: 'usdc', floorUsd, solFloor: targetSol });

		// Self-pay fee wallets get a second row for their SOL need. Same name on
		// purpose: the executor resolves the signing key by name, and both legs
		// are self-swaps on the same wallet. Armed only below the registry minSol
		// so routine drift never triggers it, and targeting refillTo (not minSol)
		// so the swap buys real runway instead of landing exactly on the floor.
		if (cfg.selfPayFee && sol < (spec.minSol ?? 0)) {
			wallets.push({ name: cfg.role, pubkey, sol, usdc, wants: 'sol', floorUsd: targetSol * solPriceUsd });
		}
	}

	const { plan, skipped } = planRebalance({ solPriceUsd, wallets });
	const armed = REBALANCE.enabled;

	// Dry run (disabled) — return the plan without touching a key.
	if (!armed) {
		return json(res, 200, {
			ok: true,
			armed: false,
			mode: 'dry_run',
			solPriceUsd,
			wallets: wallets.map((w) => ({ name: w.name, sol: w.sol, usdc: w.usdc, floorUsd: w.floorUsd })),
			plan,
			skipped,
			note: 'ECONOMY_REBALANCE_ENABLED is not set — no swaps executed',
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
