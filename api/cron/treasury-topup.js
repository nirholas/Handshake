// @ts-check
// GET /api/cron/treasury-topup — economy funding-root auto-refill.
//
// The companion to relayer-balance-check (which only ALERTS). This cron reads
// every configured engine signer's mainnet SOL balance and, for any that has
// dropped below its `minSol` floor, tops it up from the ONE economy master
// wallet (api/_lib/economy-master.js) — the "masters fund engines, engines do
// the work" model applied platform-wide.
//
// Safe by construction:
//   • Inert until ECONOMY_MASTER_SECRET_BASE58 is set — with no master it does
//     nothing (relayer-balance-check keeps alerting), so shipping it is a no-op
//     until the operator funds WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW.
//   • Only ever pays pubkeys derived from SOLANA_SIGNERS (the registry is the
//     allowlist). The master never trades, launches, or settles.
//   • Reserve floor + per-engine cap + per-run cap (see economy-master.js) bound
//     every sweep; the reserve floor is an on-chain read, so it holds with no DB.
//
// Runs every 30 min — fast enough that no engine dries out between sweeps, cheap
// enough (one getBalance per signer + at most a handful of transfers) to stay
// well inside the RPC/Upstash budgets.
//
// Env (reuses existing infra):
//   CRON_SECRET   — Vercel cron bearer auth (shared with other crons)
//   SOLANA_RPC_URL — mainnet RPC (defaults to api.mainnet-beta)
//   ECONOMY_MASTER_SECRET_BASE58 — the funding-root key (unset ⇒ inert)
//   ECONOMY_MASTER_RESERVE_SOL / _PER_TOPUP_MAX_SOL / _RUN_CAP_SOL — guard caps

import { randomUUID } from 'node:crypto';
import { error, json, method, wrapCron } from '../_lib/http.js';
import { env } from '../_lib/env.js';
import { constantTimeEquals } from '../_lib/crypto.js';
import { sendOpsAlert } from '../_lib/alerts.js';
import { SOLANA_SIGNERS, resolveSignerPubkey } from '../_lib/solana-signers.js';
import { sweepTopUps, RESERVE_SOL, RUN_CAP_SOL, PER_TOPUP_MAX_SOL, ECONOMY_MASTER_ADDRESS } from '../_lib/economy-master.js';
import { recordSweep } from '../_lib/economy-ledger.js';
import { refuelMasterFromUsdc } from '../_lib/economy-fuel.js';
import { reclaimIdleSol } from '../_lib/economy-sweepback.js';

const LAMPORTS_PER_SOL = 1_000_000_000;
// How high to lift an engine when it falls below its floor, unless the spec
// pins its own refillTo. minSol×3 gives comfortable headroom without overfunding
// a hot wallet we deliberately keep thin.
const DEFAULT_REFILL_MULTIPLE = 3;

function requireCron(req, res) {
	const secret = process.env.CRON_SECRET || env.CRON_SECRET;
	if (!secret) {
		error(res, 503, 'not_configured', 'CRON_SECRET unset');
		return false;
	}
	const auth = req.headers['authorization'] || '';
	const presented = auth.startsWith('Bearer ') ? auth.slice(7) : '';
	if (!constantTimeEquals(presented, secret)) {
		error(res, 401, 'unauthorized', 'invalid cron secret');
		return false;
	}
	return true;
}

export default wrapCron(async (req, res) => {
	if (!method(req, res, ['GET', 'POST'])) return;
	if (!requireCron(req, res)) return;

	const rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
	const { PublicKey } = await import('@solana/web3.js');
	const { solanaConnection } = await import('../_lib/solana/connection.js');
	const connection = solanaConnection({ url: rpcUrl, network: 'mainnet', commitment: 'confirmed' });

	// Read every engine signer's balance; collect the ones under floor as refill
	// targets. The master itself (isMaster) and unconfigured/devnet signers are
	// never targets.
	const targets = [];
	const errors = [];
	// Fallback env vars can resolve two registry entries to the SAME wallet
	// (e.g. x402-ring-payer falling back to the agent key) — top it up once.
	const seenPubkeys = new Set();
	for (const spec of SOLANA_SIGNERS) {
		if (spec.isMaster || spec.network === 'devnet') continue;
		const resolved = await resolveSignerPubkey(spec);
		if (!resolved.configured) continue;
		if (resolved.decodeError || !resolved.pubkey) {
			errors.push({ name: spec.name, reason: 'secret_decode_failed' });
			continue;
		}
		if (seenPubkeys.has(resolved.pubkey)) continue;
		seenPubkeys.add(resolved.pubkey);
		let lamports;
		try {
			lamports = await connection.getBalance(new PublicKey(resolved.pubkey), 'confirmed');
		} catch (e) {
			errors.push({ name: spec.name, pubkey: resolved.pubkey, reason: `rpc_error: ${e.message}` });
			continue;
		}
		const sol = lamports / LAMPORTS_PER_SOL;
		if (sol >= spec.minSol) continue;
		targets.push({
			name: spec.name,
			pubkey: resolved.pubkey,
			currentSol: Number(sol.toFixed(6)),
			refillToSol: spec.refillTo ?? spec.minSol * DEFAULT_REFILL_MULTIPLE,
		});
	}

	// ?dry=1 → plan only: same balance reads, allowlist filter, and cap math, but
	// no SOL moves, no ledger write, no alerts. Lets an operator inspect exactly
	// what the next sweep would do (e.g. after adding a signer to the registry).
	const dryRun = /[?&]dry=(1|true)\b/.test(req.url || '');

	// Self-healing fuel: before the master distributes, if it cannot cover the
	// engines' real SOL deficit, convert a small bounded slice of its own idle
	// USDC into native SOL. The circulation loop leaks SOL to fees every tick, so
	// without a source the funding root drains to zero and /pulse goes quiet —
	// this keeps the tank full from revenue instead of waiting on a human. No-op
	// unless there is a genuine shortage AND spare USDC (see economy-fuel.js).
	const totalDeficitSol = targets.reduce((s, t) => s + Math.max(0, t.refillToSol - t.currentSol), 0);

	// Self-healing, step 1 (free SOL first): when there is a real deficit, reclaim
	// idle SOL sitting above other engines' operating floors back to the master
	// before spending any revenue. This is the automated form of the manual "drain
	// the fleet to refund the feed" recovery, and it is non-oscillating (see
	// reclaimIdleSol). Only runs when the master can't already cover the deficit, so
	// a healthy fleet never churns fees.
	let reclaim = { reclaimedSol: 0, moves: [], skipped: [], failed: [] };
	if (totalDeficitSol > 0) {
		try {
			const masterSolNow = (await connection.getBalance(new PublicKey(ECONOMY_MASTER_ADDRESS), 'confirmed')) / 1e9;
			if (Math.max(0, masterSolNow - RESERVE_SOL) < totalDeficitSol) {
				reclaim = await reclaimIdleSol({ connection, network: 'mainnet', dryRun });
			}
		} catch (e) {
			reclaim = { reclaimedSol: 0, moves: [], skipped: [], failed: [], error: e?.message || 'reclaim_failed' };
		}
	}
	if (reclaim.reclaimedSol > 0 && !dryRun) {
		await sendOpsAlert(
			`♻️ Economy master reclaimed idle SOL`,
			`pulled ${reclaim.reclaimedSol} SOL back from ${reclaim.moves.length} engine(s) to cover a ${totalDeficitSol.toFixed(3)} SOL deficit before spending revenue.`,
			{ signature: `economy-reclaim:${reclaim.moves.map((m) => m.pubkey).join(',')}` },
		);
	}

	// Self-healing, step 2 (revenue): if reclaim did not close the gap, convert a
	// small bounded slice of the master's own idle USDC into native SOL. The
	// circulation loop leaks SOL to fees every tick, so without a source the funding
	// root drains to zero and /pulse goes quiet — this keeps the tank full from
	// revenue instead of waiting on a human. No-op unless a genuine shortage remains
	// AND there is spare USDC (see economy-fuel.js).
	let fuel = { acted: false, reason: 'not_needed' };
	if (totalDeficitSol > 0) {
		try {
			fuel = await refuelMasterFromUsdc({ connection, deficitSol: totalDeficitSol, network: 'mainnet', dryRun });
		} catch (e) {
			fuel = { acted: false, reason: 'error', error: e?.message || 'refuel_failed' };
		}
	}
	if (fuel.acted && fuel.signature) {
		await sendOpsAlert(
			`⛽ Economy master refueled from USDC`,
			`swapped ~$${fuel.spentUsd} USDC → ${fuel.boughtSol} SOL (impact ${fuel.priceImpactPct}%) so the funding root can cover a ${totalDeficitSol.toFixed(3)} SOL deficit.\ntx: ${fuel.signature}`,
			{ signature: `economy-fuel:${fuel.signature}` },
		);
	}

	const result = await sweepTopUps({ connection, targets, network: 'mainnet', dryRun });
	if (dryRun) {
		return json(res, 200, {
			ok: true,
			dry_run: true,
			rpc: rpcUrl,
			configured: result.configured,
			targets,
			plan: result.plan || [],
			skipped: result.skipped || [],
			rejected: result.rejected || [],
			master_sol: result.masterSol ?? null,
			spendable_sol: result.spendableSol ?? null,
			reclaim,
			fuel,
			read_errors: errors,
		});
	}

	// Record the sweep to the tamper-evident accounting ledger. Every transfer,
	// block, and failure becomes a hash-chained row; the heartbeat row proves the
	// monitor ran even on a no-op sweep. The write never fails the response — but
	// if SOL moved and the record was dropped, that is a monitoring gap an operator
	// must know about (the reconcile cron would flag the tx as unrecorded).
	const runId = randomUUID();
	let ledger = { written: 0 };
	if (result.configured && result.master) {
		try {
			ledger = await recordSweep({
				runId,
				masterPubkey: result.master,
				network: 'mainnet',
				result,
				caps: { reserveSol: RESERVE_SOL, runCapSol: RUN_CAP_SOL, perTopupMaxSol: PER_TOPUP_MAX_SOL },
			});
		} catch (e) {
			ledger = { written: 0, skippedWrite: e?.message || 'record_failed' };
		}
		if (ledger.skippedWrite && result.funded.length > 0) {
			await sendOpsAlert(
				`🧾 Economy ledger did NOT record a real transfer`,
				`sweep ${runId} moved ${result.spentSol} SOL across ${result.funded.length} transfer(s) but the ledger write failed (${ledger.skippedWrite}). The money moved; the book is behind. economy-reconcile will flag these as unrecorded — reconcile manually.`,
				{ signature: `economy-ledger-miss:${runId}` },
			);
		}
	}

	// Alert when the master is configured but too drained to cover a real deficit
	// AND self-healing could not rescue it (USDC exhausted, daily cap hit, or fuel
	// disabled) — that is the one condition a human must act on (fund the root).
	// When the refuel swap DID act, the shortage is being handled autonomously, so
	// suppress the page: the next tick distributes the freshly-bought SOL.
	if (result.configured && targets.length > 0 && result.spentSol === 0 && result.funded.length === 0 && !fuel.acted) {
		const fuelNote =
			fuel.reason === 'daily_cap_reached' ? ' Fuel daily cap reached; raise ECONOMY_FUEL_DAILY_USDC or fund SOL.'
			: fuel.reason === 'no_spare_usdc' ? ' Master is also out of spare USDC to convert.'
			: fuel.reason === 'disabled' ? ' Auto-refuel is disabled (ECONOMY_FUEL_ENABLED=0).'
			: '';
		await sendOpsAlert(
			`⛽ Economy master could not refill ${targets.length} engine(s)`,
			`master ${result.master} has ${result.masterSol} SOL (reserve ${result.reserveSol}). ` +
				`Underfunded: ${targets.map((t) => t.name).join(', ')}. Fund the master on mainnet.${fuelNote}`,
			{ signature: `economy-master-empty:${result.master}` },
		);
	}
	for (const f of result.funded) {
		await sendOpsAlert(
			`⛽ Economy master topped up ${f.name}`,
			`+${f.sol} SOL → ${f.pubkey}\ntx: ${f.signature}`,
			{ signature: `economy-topup:${f.pubkey}:${f.signature}` },
		);
	}

	// An off-registry target reaching the sweep means a bad caller/target list.
	// No SOL moved (the allowlist blocked it), but a human should know why.
	for (const r of result.rejected || []) {
		await sendOpsAlert(
			`🚫 Economy master blocked an off-registry target (${r.reason})`,
			`refused to fund ${r.name} → ${r.pubkey}. Not a resolved SOLANA_SIGNERS wallet; the sweep skipped it. No SOL left the master.`,
			{ signature: `economy-reject:${r.pubkey}:${r.reason}` },
		);
	}

	return json(res, 200, {
		ok: true,
		rpc: rpcUrl,
		configured: result.configured,
		targets: targets.length,
		funded: result.funded,
		failed: result.failed,
		skipped: result.skipped,
		rejected: result.rejected || [],
		spent_sol: result.spentSol,
		master_sol: result.masterSol ?? null,
		reclaim,
		fuel,
		read_errors: errors,
		run_id: runId,
		ledger,
	});
});
