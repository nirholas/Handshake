// @ts-check
// GET /api/cron/treasury-topup, economy funding-root auto-refill.
//
// The companion to relayer-balance-check (which only ALERTS). This cron reads
// every configured engine signer's mainnet SOL balance and, for any that has
// dropped below its `minSol` floor, tops it up from the ONE economy master
// wallet (api/_lib/economy-master.js), the "masters fund engines, engines do
// the work" model applied platform-wide.
//
// Safe by construction:
//   • Inert until ECONOMY_MASTER_SECRET_BASE58 is set, with no master it does
//     nothing (relayer-balance-check keeps alerting), so shipping it is a no-op
//     until the operator funds WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW.
//   • Only ever pays pubkeys derived from SOLANA_SIGNERS (the registry is the
//     allowlist). The master never trades, launches, or settles.
//   • Reserve floor + per-engine cap + per-run cap (see economy-master.js) bound
//     every sweep; the reserve floor is an on-chain read, so it holds with no DB.
//
// Runs every 30 min, fast enough that no engine dries out between sweeps, cheap
// enough (one getBalance per signer + at most a handful of transfers) to stay
// well inside the RPC/Upstash budgets.
//
// Env (reuses existing infra):
//   CRON_SECRET, Vercel cron bearer auth (shared with other crons)
//   SOLANA_RPC_URL, mainnet RPC (defaults to api.mainnet-beta)
//   ECONOMY_MASTER_SECRET_BASE58, the funding-root key (unset ⇒ inert)
//   ECONOMY_MASTER_RESERVE_SOL / _PER_TOPUP_MAX_SOL / _RUN_CAP_SOL, guard caps

import { randomUUID } from 'node:crypto';
import { json, method, wrapCron } from '../_lib/http.js';
import { sendOpsAlert } from '../_lib/alerts.js';
import { SOLANA_SIGNERS, resolveSignerPubkey } from '../_lib/solana-signers.js';
import { sweepTopUps, RESERVE_SOL, RUN_CAP_SOL, PER_TOPUP_MAX_SOL, ECONOMY_MASTER_ADDRESS } from '../_lib/economy-master.js';
import { recordSweep, recordAgentReclaim } from '../_lib/economy-ledger.js';
import { refuelMasterFromUsdc } from '../_lib/economy-fuel.js';
import { topUpUsdcEngines } from '../_lib/economy-usdc-topup.js';
import { reclaimIdleSol, reclaimIdleAgentSol } from '../_lib/economy-sweepback.js';
import { requireCron } from '../_lib/cron-auth.js';

const LAMPORTS_PER_SOL = 1_000_000_000;
// How high to lift an engine when it falls below its floor, unless the spec
// pins its own refillTo. minSol×3 gives comfortable headroom without overfunding
// a hot wallet we deliberately keep thin.
const DEFAULT_REFILL_MULTIPLE = 3;

export default wrapCron(async (req, res) => {
	if (!method(req, res, ['GET', 'POST'])) return;
	if (!requireCron(req, res)) return;

	const rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
	const { PublicKey } = await import('@solana/web3.js');
	const { solanaConnection, isTransientRpcError } = await import('../_lib/solana/connection.js');
	const connection = solanaConnection({ url: rpcUrl, network: 'mainnet', commitment: 'confirmed' });

	// Read every engine signer's balance; collect the ones under floor as refill
	// targets. The master itself (isMaster) and unconfigured/devnet signers are
	// never targets.
	const targets = [];
	const errors = [];
	// A non-master signer whose SECRET resolves to the master's own wallet (env
	// aliasing, e.g. THREE_BUYBACK_SECRET_KEY_B64 set to the master key). Its
	// balance IS the master's balance, so it can never be a refill target, before
	// this check, every sweep listed it as underfunded, filterToRegistry rejected
	// the master-to-itself transfer, and the pair of alerts re-fired forever
	// (~10k repeats each) while misreporting the count of genuinely dry engines.
	const masterAliased = [];
	// Fallback env vars can resolve two registry entries to the SAME wallet
	// (e.g. x402-ring-payer falling back to the agent key, or the circulation
	// treasury sharing the pump-cron-relayer key). Top a shared wallet up ONCE,
	// but judge it against the STRICTEST of its specs. First-spec-wins dedupe
	// silently dropped the later, higher floor: production 2026-07-30 had the
	// circulation treasury (floor 0.2, refill 0.5) deduped behind
	// pump-cron-relayer (floor 0.01), so the shared wallet at 0.012 SOL was
	// never a refill target, the deficit read zero, fuel never fired, and the
	// Money Pulse ran free-actions-only while the master held idle USDC.
	const byPubkey = new Map();
	for (const spec of SOLANA_SIGNERS) {
		if (spec.isMaster || spec.network === 'devnet') continue;
		const resolved = await resolveSignerPubkey(spec);
		if (!resolved.configured) continue;
		if (resolved.decodeError || !resolved.pubkey) {
			errors.push({ name: spec.name, reason: 'secret_decode_failed' });
			continue;
		}
		if (resolved.pubkey === ECONOMY_MASTER_ADDRESS) {
			masterAliased.push(spec.name);
			continue;
		}
		const refillToSol = spec.refillTo ?? spec.minSol * DEFAULT_REFILL_MULTIPLE;
		const merged = byPubkey.get(resolved.pubkey);
		if (!merged) {
			byPubkey.set(resolved.pubkey, {
				names: [spec.name],
				minSol: spec.minSol,
				refillToSol,
				// One shared wallet is settle-critical if ANY spec resolving to it
				// is: the x402 ring payer shares a pubkey with the coin-launcher
				// master, and the payment rail's claim on it does not weaken
				// because a launcher happens to spend from the same address.
				settleCritical: !!spec.settleCritical,
			});
		} else {
			merged.names.push(spec.name);
			merged.minSol = Math.max(merged.minSol, spec.minSol);
			merged.refillToSol = Math.max(merged.refillToSol, refillToSol);
			merged.settleCritical = merged.settleCritical || !!spec.settleCritical;
		}
	}
	for (const [pubkey, merged] of byPubkey) {
		const name = merged.names.join('+');
		let lamports;
		try {
			lamports = await connection.getBalance(new PublicKey(pubkey), 'confirmed');
		} catch (e) {
			errors.push({ name, pubkey, reason: `rpc_error: ${e.message}` });
			continue;
		}
		const sol = lamports / LAMPORTS_PER_SOL;
		if (sol >= merged.minSol) continue;
		targets.push({
			name,
			pubkey,
			currentSol: Number(sol.toFixed(6)),
			refillToSol: merged.refillToSol,
			settleCritical: merged.settleCritical,
		});
	}

	// ?dry=1 → plan only: same balance reads, allowlist filter, and cap math, but
	// no SOL moves, no ledger write, no alerts. Lets an operator inspect exactly
	// what the next sweep would do (e.g. after adding a signer to the registry).
	const dryRun = /[?&]dry=(1|true)\b/.test(req.url || '');

	// One id for the whole tick: the reclaim legs and the sweep below are phases of
	// the same run, and sharing the id is what lets a reader join a blocked reclaim
	// to the sweep that then had nothing to distribute.
	const runId = randomUUID();

	// Self-healing fuel: before the master distributes, if it cannot cover the
	// engines' real SOL deficit, convert a small bounded slice of its own idle
	// USDC into native SOL. The circulation loop leaks SOL to fees every tick, so
	// without a source the funding root drains to zero and /pulse goes quiet,
	// this keeps the tank full from revenue instead of waiting on a human. No-op
	// unless there is a genuine shortage AND spare USDC (see economy-fuel.js).
	const engineDeficitSol = targets.reduce((s, t) => s + Math.max(0, t.refillToSol - t.currentSol), 0);

	// The master is ALSO the x402 sponsor fee wallet: below the sponsor SOL floor
	// (0.02) the self-facilitator fail-closes every settle and the autonomous
	// economy flat-lines. The master can never be a top-up TARGET (it is the
	// funding root), so its own shortfall must count as deficit here or the
	// reclaim/refuel self-healing below never fires for it, the July 2026
	// recurrences all stalled exactly this way, with the master a few thousand
	// lamports under the settle floor while the deficit read as engines-only.
	// Operating floor = reserve + working headroom for sponsor co-sign fees;
	// the headroom default clears economy-fuel's minimum-gap trigger (0.1 SOL).
	const masterOperatingSol = (() => {
		const n = Number(process.env.ECONOMY_MASTER_OPERATING_SOL);
		return Number.isFinite(n) && n >= 0 ? n : 0.15;
	})();
	let masterDeficitSol = 0;
	let masterSolBefore = null;
	try {
		masterSolBefore = (await connection.getBalance(new PublicKey(ECONOMY_MASTER_ADDRESS), 'confirmed')) / 1e9;
		masterDeficitSol = Math.max(0, RESERVE_SOL + masterOperatingSol - masterSolBefore);
	} catch {
		/* balance read failed, engines-only deficit this tick, next tick retries */
	}
	const totalDeficitSol = engineDeficitSol + masterDeficitSol;

	// Self-healing, step 1 (free SOL first): when there is a real deficit, reclaim
	// idle SOL sitting above other engines' operating floors back to the master
	// before spending any revenue. This is the automated form of the manual "drain
	// the fleet to refund the feed" recovery, and it is non-oscillating (see
	// reclaimIdleSol). Only runs when the master can't already cover the deficit, so
	// a healthy fleet never churns fees.
	let reclaim = { reclaimedSol: 0, moves: [], skipped: [], failed: [] };
	if (totalDeficitSol > 0) {
		try {
			const masterSolNow = masterSolBefore ?? (await connection.getBalance(new PublicKey(ECONOMY_MASTER_ADDRESS), 'confirmed')) / 1e9;
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

	// Self-healing, step 1b (the other half of the fleet's SOL): the engine reclaim
	// above only walks the SOLANA_SIGNERS registry. Most of the platform's SOL lives
	// one layer down, in PLATFORM-OWNED agent custody wallets, which had no return
	// path at all, master → agent funding is one-way and snipe proceeds settle back
	// into the agent, never the master. Without this the fleet can hold plenty of SOL
	// while the fee wallet starves under its settle floor (audited 2026-07-28: 7.2 of
	// 7.53 SOL stranded in agent wallets, engines at 0.31, rail fully 503). Customer
	// agents are never touched, see reclaimIdleAgentSol's ownership gate.
	let agentReclaim = { reclaimedSol: 0, moves: [], skipped: [], failed: [] };
	if (totalDeficitSol > 0 && reclaim.reclaimedSol < totalDeficitSol) {
		try {
			agentReclaim = await reclaimIdleAgentSol({ connection, network: 'mainnet', dryRun });
		} catch (e) {
			agentReclaim = { reclaimedSol: 0, moves: [], skipped: [], failed: [], error: e?.message || 'agent_reclaim_failed' };
		}
	}
	// Book of record for the agent leg. Until this call the leg wrote NOTHING to
	// the ledger, success or failure, so "the reclaim ran and every wallet was
	// unreadable" and "the reclaim never ran" were the same absence of rows. The
	// summary row is written even on a no-op, which is what makes the two
	// distinguishable after the fact. Fail-soft: the ledger never gates the money
	// path, and a dry run is recorded as a dry run rather than skipped, so an
	// operator inspecting a plan leaves a trace too.
	if (totalDeficitSol > 0 && reclaim.reclaimedSol < totalDeficitSol) {
		try {
			await recordAgentReclaim({
				runId,
				masterPubkey: ECONOMY_MASTER_ADDRESS,
				network: 'mainnet',
				result: { ...agentReclaim, dryRun },
				masterSolBefore,
				deficitSol: totalDeficitSol,
			});
		} catch (e) {
			console.error('[treasury-topup] agent reclaim ledger write failed', { error: e?.message });
		}
	}

	if (agentReclaim.reclaimedSol > 0 && !dryRun) {
		await sendOpsAlert(
			`♻️ Economy master reclaimed idle agent SOL`,
			`pulled ${agentReclaim.reclaimedSol} SOL back from ${agentReclaim.moves.length} platform agent wallet(s) to cover a ${totalDeficitSol.toFixed(3)} SOL deficit.`,
			{ signature: `economy-agent-reclaim:${agentReclaim.moves.map((m) => m.address).join(',')}` },
		);
	}

	// A self-heal that CANNOT heal has to say so. Both reclaim legs return their
	// readErrors and failed sends in the HTTP response, and this cron's response
	// goes to Cloud Scheduler, which discards it, so until now a reclaim that was
	// blocked left no log line, no ledger row and no alert. Both gaps are closed:
	// the alert below names which of the two outcomes happened, and
	// recordAgentReclaim() above writes the durable rows the agent leg used to
	// skip entirely. On 2026-07-29 that silence cost ~11 hours: every Solana RPC
	// lane was in quota cooldown, so the balance reads failed, no candidate was
	// ever planned, and
	// 0.12 SOL sat reclaimable in agent wallets while the sponsor stayed under its
	// settle floor and every 402 challenge dropped its Solana accept.
	//
	// Two outcomes look identical from the master's balance and have OPPOSITE
	// remediations, so name which one happened:
	//   blocked  : we could not read or could not send. Nothing to fund; the RPC
	//              tier is the problem. Free to fix, no owner money.
	//   nothing  : every source is genuinely at or below its floor. This is the
	//              only case that needs the owner to send SOL.
	const reclaimedTotal = Number((reclaim.reclaimedSol + agentReclaim.reclaimedSol).toFixed(6));
	if (!dryRun && totalDeficitSol > 0 && reclaimedTotal < totalDeficitSol) {
		const readErrors = [...(reclaim.readErrors || []), ...(agentReclaim.readErrors || [])];
		const failedSends = [...(reclaim.failed || []), ...(agentReclaim.failed || [])];
		const legErrors = [reclaim.error, agentReclaim.error].filter(Boolean);
		const blocked = readErrors.length + failedSends.length + legErrors.length > 0;
		const sample = readErrors[0]?.reason || failedSends[0]?.reason || legErrors[0] || '';
		// A recovery failure and a broadcast failure are both "failed" but have
		// nothing else in common. Undecryptable secrets are a KEY problem: the SOL
		// in those wallets is unreachable until the right WALLET_ENCRYPTION_KEY is
		// present, and no RPC tier or deposit changes that. Counting them as failed
		// sends is what pointed the 2026-07-31 investigation at RPC health for an
		// AES-GCM OperationError.
		const undecryptable = failedSends.filter((f) => String(f?.reason || '').startsWith('secret_undecryptable'));
		// Everything that is not a key problem is a send problem. Splitting on a
		// `stage` field instead dropped legacy failure objects (which carry none)
		// into neither bucket, and the alert then claimed "0 failed send(s)" while
		// quoting a send error as its own sample.
		const sendFailures = failedSends.filter((f) => !undecryptable.includes(f));
		if (blocked) {
			const strandedSol = undecryptable.reduce((s, f) => s + (Number(f?.sol) || 0), 0);
			await sendOpsAlert(
				'♻️ Economy self-heal BLOCKED: reclaim could not run',
				`Deficit ${totalDeficitSol.toFixed(4)} SOL, reclaimed only ${reclaimedTotal} SOL. ` +
					`${readErrors.length} balance read error(s), ${sendFailures.length} failed send(s), ` +
					`${undecryptable.length} undecryptable wallet secret(s)` +
					`${legErrors.length ? `, ${legErrors.length} leg error(s)` : ''}. First: ${String(sample).slice(0, 180)}. ` +
					'An `rpc_error` here means the Solana RPC tier is exhausted, NOT that the wallets are dry: ' +
					'idle SOL may still be sitting in agent wallets that could not be read. Check ' +
					'healthz rpc_lanes and the provider quotas before sending any funds.' +
					(undecryptable.length
						? ` ${strandedSol.toFixed(4)} SOL is stranded behind secrets this deploy cannot decrypt ` +
							`(${undecryptable.map((f) => f.name).slice(0, 4).join(', ')}). That is a KEY problem, not an RPC or ` +
							'funding one: verify WALLET_ENCRYPTION_KEY matches the key those wallets were encrypted with. ' +
							'Reclaim will keep skipping them until it does, so exclude that SOL from any runway estimate.'
						: ''),
				{ signature: 'economy-selfheal-blocked', severity: 'warn' },
			);
		} else {
			await sendOpsAlert(
				'⛽ Economy self-heal found nothing to reclaim',
				`Deficit ${totalDeficitSol.toFixed(4)} SOL and every reclaim source is at or below its floor ` +
					`(${(reclaim.skipped || []).length + (agentReclaim.skipped || []).length} source(s) skipped). ` +
					'This is the case that genuinely needs funding: send SOL to the economy master.',
				{ signature: 'economy-selfheal-nothing-to-reclaim', severity: 'warn' },
			);
		}
	}

	// Self-healing, step 2 (revenue): if reclaim did not close the gap, convert a
	// small bounded slice of the master's own idle USDC into native SOL. The
	// circulation loop leaks SOL to fees every tick, so without a source the funding
	// root drains to zero and /pulse goes quiet, this keeps the tank full from
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
	// A refuel that could not READ the USDC balance is the same class of
	// look-alike as a reclaim that could not run, and it lands after the
	// classification above, so it needs to say so itself. Without this the tick
	// reports the indistinguishable-but-opposite `no_spare_usdc` and the operator
	// funds a wallet that was never empty.
	if (!dryRun && fuel.reason === 'usdc_read_failed') {
		await sendOpsAlert(
			'⛽ Economy refuel BLOCKED: USDC balance unreadable',
			`Deficit ${totalDeficitSol.toFixed(4)} SOL and the master's USDC balance could not be read, so no refuel was planned. ` +
				`First error: ${String(fuel.readError || 'unknown').slice(0, 180)}. ` +
				'This is NOT "the revenue is spent": the balance is unknown, not zero. Check the Solana RPC lanes ' +
				'(healthz rpc_lanes) before sending any funds.',
			{ signature: 'economy-fuel-read-blocked', severity: 'warn' },
		);
	}

	// Self-healing, step 3 (the USDC side): the steps above keep SOL flowing, but
	// the ring/a2a payers SPEND USDC, and their only refill path used to be
	// swapping their own SOL on Jupiter. When a payer holds neither spare SOL nor
	// USDC while the master sits on idle USDC revenue, settles die with SPL
	// insufficient-funds inside arm's reach of the money (2026-07-28: payer at
	// ~5 USDC failing every $10 ring-settle leg, master idle at 48 USDC). Top the
	// engines up directly: no swap, no slippage, allowlist + caps + daily budget
	// inside economy-usdc-topup.js.
	let usdcTopup = { enabled: true, acted: false, reason: 'not_run' };
	try {
		usdcTopup = await topUpUsdcEngines({ connection, network: 'mainnet', dryRun });
	} catch (e) {
		usdcTopup = { enabled: true, acted: false, reason: `error: ${e?.message || 'usdc_topup_failed'}` };
	}
	if (usdcTopup.acted && !dryRun) {
		for (const s of usdcTopup.sent || []) {
			await sendOpsAlert(
				`💵 Economy master topped up ${s.name} with USDC`,
				`+$${s.sendUsd} USDC → ${s.pubkey}\ntx: ${s.signature}`,
				{ signature: `economy-usdc-topup:${s.pubkey}:${s.signature}` },
			);
		}
	}

	// The sweep is the only leg that both reads AND moves SOL, so it is the one
	// that dies when every RPC lane is cooling at once. Letting it throw took the
	// whole cron down with a 500 (2026-08-07: ~1 in 15 ticks), and this cron IS
	// the self-heal for a starved engine, so the outage disabled its own remedy
	// exactly when the ring needed it. An exhausted lane chain is upstream
	// weather, not a bug: report it as a skipped sweep the same way wrapCron
	// reports an unavailable database, and let the next tick (30 min) retry with
	// the reclaim, fuel, and USDC legs above already applied. A non-RPC failure
	// is still a real defect and still throws.
	let result;
	try {
		result = await sweepTopUps({ connection, targets, network: 'mainnet', dryRun });
	} catch (e) {
		if (!isTransientRpcError(e)) throw e;
		const reason = e?.message || 'rpc_unavailable';
		console.warn(`[cron] treasury-topup sweep skipped, solana rpc unavailable: ${reason}`);
		return json(res, 200, {
			ok: false,
			reason: 'rpc_unavailable',
			detail: reason,
			dry_run: dryRun,
			rpc: rpcUrl,
			targets: targets.length,
			swept: false,
			reclaim,
			agent_reclaim: agentReclaim,
			fuel,
			usdc_topup: usdcTopup,
			master_aliased: masterAliased,
			read_errors: errors,
			run_id: runId,
		});
	}
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
			master_deficit_sol: Number(masterDeficitSol.toFixed(6)),
			master_operating_sol: masterOperatingSol,
			reclaim,
			agent_reclaim: agentReclaim,
			fuel,
			usdc_topup: usdcTopup,
			master_aliased: masterAliased,
			read_errors: errors,
		});
	}

	// Record the sweep to the tamper-evident accounting ledger. Every transfer,
	// block, and failure becomes a hash-chained row; the heartbeat row proves the
	// monitor ran even on a no-op sweep. The write never fails the response, but
	// if SOL moved and the record was dropped, that is a monitoring gap an operator
	// must know about (the reconcile cron would flag the tx as unrecorded).
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
				`sweep ${runId} moved ${result.spentSol} SOL across ${result.funded.length} transfer(s) but the ledger write failed (${ledger.skippedWrite}). The money moved; the book is behind. economy-reconcile will flag these as unrecorded, reconcile manually.`,
				{ signature: `economy-ledger-miss:${runId}` },
			);
		}
	}

	// Alert when the master is configured but too drained to cover a real deficit
	// AND self-healing could not rescue it (USDC exhausted, daily cap hit, or fuel
	// disabled), that is the one condition a human must act on (fund the root).
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

	// A signer aliased to the master is a standing config condition, not a
	// per-sweep event: say it once per name (stable signature → one ops_alerts
	// row), and never count it among dry engines.
	for (const name of masterAliased) {
		await sendOpsAlert(
			`ℹ️ Signer "${name}" resolves to the economy master wallet`,
			`${name}'s secret decodes to the master (${ECONOMY_MASTER_ADDRESS}), so its balance rides the master's and it is excluded from refill targets. If this aliasing is unintended, point ${name}'s env secret at its own keypair.`,
			{ signature: `economy-alias-master:${name}`, severity: 'info' },
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
		master_deficit_sol: Number(masterDeficitSol.toFixed(6)),
		reclaim,
		agent_reclaim: agentReclaim,
		fuel,
		usdc_topup: usdcTopup,
		master_aliased: masterAliased,
		read_errors: errors,
		run_id: runId,
		ledger,
	});
});
