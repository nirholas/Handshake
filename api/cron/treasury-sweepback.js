// @ts-check
// GET/POST /api/cron/treasury-sweepback — consolidation: return engine-signer
// balances to the ONE economy master wallet.
//
// The mirror of treasury-topup. Topup pushes SOL from the master DOWN to any
// engine below its floor; sweepback pulls surplus back UP, so the whole fleet
// cycles through a single owner-controlled root: master → engines → work →
// surplus → master. Destination is locked in code to ECONOMY_MASTER_ADDRESS
// (api/_lib/economy-sweepback.js) — no parameter can redirect it.
//
// Modes:
//   • GET (scheduled, default `mode=excess`) — skim SOL above each signer's
//     operating float and consolidate stray token balances from signers that
//     don't operationally hold tokens. Safe on a schedule: floors equal the
//     topup targets, so the two crons never fight, and dust is never moved.
//   • POST ?mode=drain&confirm=drain — full consolidation: every token balance,
//     every reclaimed rent lamport, all SOL minus fee headroom. Engines are left
//     unfunded until the next topup, so this is for decommission or emergency
//     recovery and requires the explicit confirm token.
//
// Every movement lands in the tamper-evident economy_master_ledger as `inflow`
// / `inflow_token` rows chained onto the same history the topup writes.
//
// Env (reuses existing infra):
//   CRON_SECRET, SOLANA_RPC_URL, the SOLANA_SIGNERS secrets already configured
//   ECONOMY_SWEEPBACK_MIN_SOL — dust floor for a SOL sweep (default 0.01)

import { randomUUID } from 'node:crypto';
import { error, json, method, wrapCron } from '../_lib/http.js';
import { env } from '../_lib/env.js';
import { sendOpsAlert } from '../_lib/alerts.js';
import { sweepBack } from '../_lib/economy-sweepback.js';
import { ECONOMY_MASTER_ADDRESS } from '../_lib/economy-master.js';
import { recordSweepback } from '../_lib/economy-ledger.js';
import { requireCron } from '../_lib/cron-auth.js';

export default wrapCron(async (req, res) => {
	if (!method(req, res, ['GET', 'POST'])) return;
	if (!requireCron(req, res)) return;

	const url = new URL(req.url || '/', 'https://internal');
	const mode = url.searchParams.get('mode') === 'drain' ? 'drain' : 'excess';
	const includeTokens = url.searchParams.get('tokens') !== '0';

	// A drain empties every engine — never something a schedule or a stray GET
	// should be able to do. Require the explicit method + confirm token.
	if (mode === 'drain' && (req.method !== 'POST' || url.searchParams.get('confirm') !== 'drain')) {
		return error(res, 400, 'confirm_required', 'a full drain needs POST with ?mode=drain&confirm=drain');
	}

	const rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
	const { solanaConnection } = await import('../_lib/solana/connection.js');
	const connection = solanaConnection({ url: rpcUrl, network: 'mainnet', commitment: 'confirmed' });

	const result = await sweepBack({ connection, mode, includeTokens, network: 'mainnet' });

	// Book every movement onto the master's hash chain. Same contract as the
	// topup: a dropped write never fails the response, but real money moving
	// unrecorded is an ops alert.
	const runId = randomUUID();
	let ledger = { written: 0 };
	try {
		ledger = await recordSweepback({ runId, masterPubkey: ECONOMY_MASTER_ADDRESS, network: 'mainnet', result });
	} catch (e) {
		ledger = { written: 0, skippedWrite: e?.message || 'record_failed' };
	}
	const moved = result.sweptSol.length + result.sweptTokens.length;
	if (ledger.skippedWrite && moved > 0) {
		await sendOpsAlert(
			`🧾 Economy ledger did NOT record a sweepback`,
			`sweepback ${runId} returned ${result.receivedSol} SOL and ${result.sweptTokens.length} token transfer(s) to the master but the ledger write failed (${ledger.skippedWrite}). The money moved; the book is behind — reconcile manually.`,
			{ signature: `economy-ledger-miss:${runId}` },
		);
	}

	for (const f of result.failed) {
		await sendOpsAlert(
			`↩️ Sweepback transfer failed (${f.name})`,
			`${f.sol != null ? `${f.sol} SOL` : 'token transfer'} from ${f.pubkey} → master did not land: ${f.reason}`,
			{ signature: `economy-sweepback-fail:${f.pubkey}:${f.reason}` },
		);
	}
	// A wallet whose balance could not be READ is silently absent from the sweep:
	// it is neither swept nor reported as skipped, so the run looks clean while
	// consolidating less than it should. Send failures above already alert; reads
	// did not, and a read failure is exactly the shape RPC starvation takes (every
	// Solana lane in quota cooldown, 2026-07-29). Aggregate into ONE alert rather
	// than one per wallet, so a dark RPC tier cannot turn into an alert storm.
	const readErrors = result.readErrors || [];
	if (readErrors.length) {
		await sendOpsAlert(
			`↩️ Sweepback could not read ${readErrors.length} wallet(s)`,
			`sweepback ${runId} skipped ${readErrors.length} wallet(s) it could not evaluate, so this consolidation is INCOMPLETE ` +
				`(swept ${result.receivedSol} SOL). First: ${readErrors[0].name} ${String(readErrors[0].reason).slice(0, 160)}. ` +
				'An `rpc_error` here means the Solana RPC tier is exhausted, not that the wallets are empty: ' +
				'those wallets may hold SOL the master needs. Check healthz rpc_lanes and the provider quotas.',
			{ signature: 'economy-sweepback-read-errors', severity: 'warn' },
		);
	}
	if (mode === 'drain') {
		await sendOpsAlert(
			`↩️ Full drain consolidated engine wallets to the master`,
			`sweepback ${runId}: ${result.receivedSol} SOL + ${result.sweptTokens.length} token transfer(s) → ${ECONOMY_MASTER_ADDRESS}. Engines are now unfunded until the next treasury-topup.`,
			{ signature: `economy-sweepback-drain:${runId}` },
		);
	}

	return json(res, 200, {
		ok: true,
		rpc: rpcUrl,
		mode,
		master: result.master,
		master_sol_before: result.masterSolBefore,
		master_sol_after: result.masterSolAfter,
		swept_sol: result.sweptSol,
		swept_tokens: result.sweptTokens,
		received_sol: result.receivedSol,
		failed: result.failed,
		skipped: result.skipped,
		read_errors: result.readErrors,
		run_id: runId,
		ledger,
	});
});
