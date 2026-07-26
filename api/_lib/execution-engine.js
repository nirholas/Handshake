// MEV-aware execution engine — the single protected broadcast path for every
// agent-signed trade on three.ws (the sniper worker + both discretionary trade
// endpoints).
//
//   submitProtected({ network, connection, payer, instructions, opts })
//     → { signature, slot, route, tipLamports, priorityFeeMicroLamports, attempts, landedMs }
//
// What it does, all with REAL on-chain / Jito calls (never a simulated landing
// or a fabricated fee):
//
//   1. Dynamic compute budget. Prepends ComputeBudgetProgram.setComputeUnitLimit
//      from a REAL simulateTransaction unit estimate (not a guess) and
//      setComputeUnitPrice from a REAL priority-fee estimate — Helius
//      getPriorityFeeEstimate when HELIUS_API_KEY is set, falling back to the
//      getRecentPrioritizationFees 75th-percentile. Both estimates are cached
//      briefly so the hot snipe path doesn't re-pay for them every tick.
//
//   2. Jito bundle route. When tipMode is 'economy'|'turbo' AND a Jito Block
//      Engine is reachable on mainnet, it fetches the live tip-floor, appends a
//      REAL SOL tip transfer to a Jito tip account as the last instruction, and
//      submits the signed tx as a single-tx bundle via sendBundle. It then polls
//      getBundleStatuses for a real landing. Tip sizing is adaptive: it scales
//      with the mode and the live tip-floor and escalates on retry.
//
//   3. Transparent fallback. Devnet, tipMode 'off', no Jito, or a Jito error all
//      fall back to the protected single-tx route (sendRawTransaction + confirm)
//      and SAY SO in the returned `route`/`fallbackReason`. A bundle that doesn't
//      land within the poll window is reported as not-landed and retried on the
//      protected route — never claimed as landed.
//
//   4. Adaptive retry. Simulate first (skippable for a pre-simulated caller); on
//      blockhash expiry or a not-landed bundle, refresh the blockhash, escalate
//      the priority fee + tip, and re-submit up to a bounded count. Honest
//      landing telemetry (route, attempts, tip, fee, landedMs) is returned.
//
// Idempotency / double-spend safety is the CALLER's responsibility (the sniper's
// per-(agent,mint) lock + DB claim, the endpoints' idempotency key). Re-sending
// the same signed tx to a second RPC or a bundle is safe — Solana dedupes by
// signature, and a landed tx confirms regardless of which lane carried it.

import {
	ComputeBudgetProgram,
	PublicKey,
	SystemProgram,
	TransactionMessage,
	VersionedTransaction,
} from '@solana/web3.js';
import { pollConfirmation } from './solana/confirm.js';

// Jito's published mainnet tip accounts. A bundle's tip must transfer SOL to one
// of these — Jito only accepts a bundle that pays a tip to a known tip account.
// (https://docs.jito.wtf/lowlatencytxnsend/#tip-amount). We rotate per-attempt to
// spread load and avoid a hot account.
const JITO_TIP_ACCOUNTS = [
	'96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
	'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
	'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
	'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
	'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
	'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
	'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
	'3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
];

const DEFAULT_JITO_URL = 'https://mainnet.block-engine.jito.wtf';
const LAMPORTS_PER_SOL = 1_000_000_000;

// ── adaptive tip sizing (lamports) ────────────────────────────────────────────
// A tip is real SOL leaving the wallet, so the floors are deliberately modest and
// the ceiling hard-caps any single tip. 'economy' rides near the live tip-floor;
// 'turbo' pays a multiple for first-block inclusion under contention. Each retry
// escalates the chosen tip toward the ceiling.
const TIP_PROFILE = {
	economy: { floor: 10_000n, multiplier: 1.5, ceiling: 1_000_000n },
	turbo: { floor: 100_000n, multiplier: 4, ceiling: 5_000_000n },
};

// Compute-unit price floors per mode (microLamports/CU) — a lower bound so the tx
// is never priced below what the network currently demands even if the estimate
// reads abnormally low. Turbo bids the network fee up alongside the bundle tip.
const CU_PRICE_FLOOR = { off: 1_000, economy: 5_000, turbo: 25_000 };
const CU_PRICE_CEILING = 5_000_000; // hard cap on microLamports/CU

const MAX_ATTEMPTS = 3;
const BUNDLE_POLL_MS = 700; // between getBundleStatuses polls
const BUNDLE_POLL_TIMEOUT_MS = 12_000; // give a bundle this long to land before falling back

// ── brief estimate caches (per lambda instance) ──────────────────────────────
// Keyed by network. The hot snipe path calls submitProtected on every fill; these
// keep the priority-fee + tip-floor reads off the critical path for a few seconds
// without ever serving a stale-enough value to misprice a tx.
const PRIORITY_FEE_TTL_MS = 4_000;
const TIP_FLOOR_TTL_MS = 4_000;
const _priorityFeeCache = new Map(); // network → { at, microLamports }
const _tipFloorCache = new Map(); // jitoUrl → { at, lamports }

function jitoBlockEngineUrl() {
	const u = (process.env.JITO_BLOCK_ENGINE_URL || DEFAULT_JITO_URL).trim();
	return u.replace(/\/+$/, '');
}

/** A Jito bundle route is only attempted on mainnet with a non-'off' tip mode. */
function jitoEligible(network, tipMode) {
	return network !== 'devnet' && (tipMode === 'economy' || tipMode === 'turbo');
}

function pickTipAccount(attempt) {
	return JITO_TIP_ACCOUNTS[attempt % JITO_TIP_ACCOUNTS.length];
}

function clampBig(v, min, max) {
	if (v < min) return min;
	if (v > max) return max;
	return v;
}

// ── priority fee estimate (microLamports per CU) ──────────────────────────────
// Helius getPriorityFeeEstimate first (it reads the global fee market, not just
// this node's recent blocks); falls back to the connection's
// getRecentPrioritizationFees 75th percentile. Cached briefly per network.
async function estimatePriorityFeeMicroLamports(connection, network) {
	const cached = _priorityFeeCache.get(network);
	if (cached && Date.now() - cached.at < PRIORITY_FEE_TTL_MS) return cached.microLamports;

	let micro = null;
	const heliusKey = process.env.HELIUS_API_KEY;
	if (heliusKey) {
		micro = await heliusPriorityFee(heliusKey, network).catch(() => null);
	}
	if (micro == null) {
		micro = await recentPrioritizationFee(connection).catch(() => null);
	}
	if (micro == null) micro = 5_000; // last-resort floor; never zero-priced

	const value = Math.max(0, Math.round(micro));
	_priorityFeeCache.set(network, { at: Date.now(), microLamports: value });
	return value;
}

async function heliusPriorityFee(heliusKey, network) {
	const host = network === 'devnet' ? 'devnet.helius-rpc.com' : 'mainnet.helius-rpc.com';
	const url = `https://${host}/?api-key=${heliusKey}`;
	const resp = await fetch(url, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			jsonrpc: '2.0',
			id: 'three-ws-mev',
			method: 'getPriorityFeeEstimate',
			// account-less, options-only form: Helius returns the global recommended
			// microLamports/CU. We escalate from this in turbo, so 'Medium'/recommended
			// is the right anchor.
			params: [{ options: { recommended: true } }],
		}),
	});
	if (!resp.ok) throw new Error(`helius pf ${resp.status}`);
	const body = await resp.json();
	const est = body?.result?.priorityFeeEstimate;
	if (typeof est !== 'number' || !Number.isFinite(est)) throw new Error('helius pf shape');
	return est;
}

async function recentPrioritizationFee(connection) {
	const fees = await connection.getRecentPrioritizationFees();
	if (!Array.isArray(fees) || fees.length === 0) return 1_000;
	const sorted = fees.map((f) => f.prioritizationFee).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
	if (!sorted.length) return 1_000;
	return sorted[Math.floor(sorted.length * 0.75)] ?? sorted[sorted.length - 1];
}

// ── compute-unit estimate ─────────────────────────────────────────────────────
// A REAL simulateTransaction of the trade instructions to read unitsConsumed,
// padded 15% for the runtime drift between sim and land. Not cached (it depends on
// the exact instruction set), but it's a single RPC call on the hot path.
async function estimateComputeUnits(connection, payer, instructions) {
	const { blockhash } = await connection.getLatestBlockhash('confirmed');
	const msg = new TransactionMessage({
		payerKey: payer.publicKey,
		recentBlockhash: blockhash,
		instructions,
	}).compileToV0Message();
	const sim = await connection.simulateTransaction(new VersionedTransaction(msg), {
		sigVerify: false,
		replaceRecentBlockhash: true,
		commitment: 'confirmed',
	});
	if (sim.value?.err) {
		const err = new Error(`pre-broadcast simulation failed: ${JSON.stringify(sim.value.err)}`);
		err.code = 'SIM_FAILED';
		err.simLogs = sim.value.logs || [];
		throw err;
	}
	const units = sim.value?.unitsConsumed;
	if (!units || units <= 0) {
		// No unit count returned — fall back to a conservative bound by instruction
		// count rather than the chain default 200k (which under-budgets a multi-CPI
		// pump.fun buy that opens an ATA).
		return Math.min(1_400_000, 60_000 + instructions.length * 40_000);
	}
	// +15% headroom, clamped to the per-tx max (1.4M CU).
	return Math.min(1_400_000, Math.ceil(units * 1.15));
}

// ── Jito Block Engine REST ────────────────────────────────────────────────────
async function jitoRpc(method, params) {
	const url = `${jitoBlockEngineUrl()}/api/v1/bundles`;
	const resp = await fetch(url, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
	});
	if (!resp.ok) {
		const text = await resp.text().catch(() => '');
		const err = new Error(`jito ${method} ${resp.status}: ${text.slice(0, 160)}`);
		err.code = 'JITO_HTTP';
		throw err;
	}
	const body = await resp.json();
	if (body.error) {
		const err = new Error(`jito ${method}: ${body.error.message || JSON.stringify(body.error)}`);
		err.code = 'JITO_RPC';
		throw err;
	}
	return body.result;
}

// Live Jito tip-floor (lamports). Reads the tip-floor endpoint and uses the 50th
// percentile of recent landed-tips as the baseline. Cached briefly. Returns null
// when the endpoint is unreachable — the caller then uses the mode floor.
async function fetchJitoTipFloorLamports() {
	const url = jitoBlockEngineUrl();
	const cached = _tipFloorCache.get(url);
	if (cached && Date.now() - cached.at < TIP_FLOOR_TTL_MS) return cached.lamports;
	try {
		const resp = await fetch(`${url}/api/v1/bundles/tip_floor`, { method: 'GET' });
		if (!resp.ok) return null;
		const body = await resp.json();
		const row = Array.isArray(body) ? body[0] : body;
		// The endpoint reports tips in SOL; prefer the 50th percentile, fall back to
		// the EMA of landed tips.
		const sol = row?.landed_tips_50th_percentile ?? row?.ema_landed_tips_50th_percentile ?? null;
		if (sol == null || !Number.isFinite(Number(sol))) return null;
		const lamports = BigInt(Math.max(0, Math.round(Number(sol) * LAMPORTS_PER_SOL)));
		_tipFloorCache.set(url, { at: Date.now(), lamports });
		return lamports;
	} catch {
		return null;
	}
}

// Resolve the tip for this attempt: max(mode floor, live tip-floor) scaled by the
// mode multiplier and the attempt index, hard-capped by the mode ceiling.
function resolveTipLamports(tipMode, tipFloorLamports, attempt) {
	const profile = TIP_PROFILE[tipMode];
	if (!profile) return 0n;
	const base = tipFloorLamports != null && tipFloorLamports > profile.floor ? tipFloorLamports : profile.floor;
	// Escalate with both the mode multiplier and the retry index (attempt 0 = base).
	const scaled = BigInt(Math.ceil(Number(base) * profile.multiplier * (1 + attempt * 0.5)));
	return clampBig(scaled, profile.floor, profile.ceiling);
}

// Submit a signed v0 tx as a single-tx Jito bundle and poll for a real landing.
// Returns { landed, slot, bundleId } — landed:false means the poll window lapsed
// without an on-chain landing (the caller falls back to the protected route).
async function sendJitoBundle(signedTx, signature, connection) {
	const b64 = Buffer.from(signedTx.serialize()).toString('base64');
	const bundleId = await jitoRpc('sendBundle', [[b64], { encoding: 'base64' }]);

	const deadline = Date.now() + BUNDLE_POLL_TIMEOUT_MS;
	while (Date.now() < deadline) {
		await sleep(BUNDLE_POLL_MS);
		// Prefer the chain's own view of the signature — it's authoritative and avoids
		// trusting Jito's status alone for a landing claim.
		const status = await connection
			.getSignatureStatus(signature, { searchTransactionHistory: true })
			.catch(() => null);
		const conf = status?.value?.confirmationStatus;
		if (status?.value?.err) {
			return { landed: false, slot: null, bundleId, error: status.value.err };
		}
		if (conf === 'confirmed' || conf === 'finalized') {
			return { landed: true, slot: status.value.slot ?? null, bundleId };
		}
		// Cross-check Jito's bundle status: a 'Failed'/'Dropped' verdict ends the wait
		// early so we fall back without burning the full timeout.
		const jitoStatus = await jitoRpc('getBundleStatuses', [[bundleId]]).catch(() => null);
		const st = jitoStatus?.value?.[0]?.confirmation_status || jitoStatus?.value?.[0]?.status;
		if (st === 'failed' || st === 'Failed' || st === 'dropped' || st === 'Dropped') {
			return { landed: false, slot: null, bundleId };
		}
	}
	return { landed: false, slot: null, bundleId };
}

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

// ── protected single-tx route ─────────────────────────────────────────────────
// sendRawTransaction with preflight, then a bounded confirm with an ambiguous-
// timeout re-check (a landed tx is never reported as failed). Returns the slot on
// landing.
async function sendProtected(signedTx, signature, connection, blockhashCtx, confirmTimeoutMs) {
	await connection.sendRawTransaction(signedTx.serialize(), { skipPreflight: false, maxRetries: 3 });

	// HTTP-polling confirm (no WebSocket) — bounded by confirmTimeoutMs and re-checked
	// on the ambiguous-timeout path below, so a throttled RPC can't spin web3.js's WS
	// 429 reconnect loop. Returns the confirmTransaction result shape this code reads.
	const confirmPromise = pollConfirmation(
		connection,
		{ signature, blockhash: blockhashCtx.blockhash, lastValidBlockHeight: blockhashCtx.lastValidBlockHeight },
		'confirmed',
		{ timeoutMs: confirmTimeoutMs },
	);
	const timeout = new Promise((_, rej) =>
		setTimeout(() => rej(Object.assign(new Error('confirm timeout'), { code: 'CONFIRM_TIMEOUT' })), confirmTimeoutMs),
	);

	let landed = false;
	let slot = null;
	try {
		const result = await Promise.race([confirmPromise, timeout]);
		if (result?.value?.err) {
			throw Object.assign(new Error(`tx failed on-chain: ${JSON.stringify(result.value.err)}`), { code: 'TX_ERR' });
		}
		landed = true;
		slot = result?.context?.slot ?? null;
	} catch (err) {
		if (err?.code === 'TX_ERR') throw err;
		// Ambiguous confirm (timeout / RPC blip): re-check the chain before giving up
		// so a tx that actually landed isn't retried or reported as not-landed.
		const status = await connection.getSignatureStatus(signature, { searchTransactionHistory: true }).catch(() => null);
		if (status?.value?.err) {
			throw Object.assign(new Error(`tx failed on-chain: ${JSON.stringify(status.value.err)}`), { code: 'TX_ERR' });
		}
		const conf = status?.value?.confirmationStatus;
		landed = conf === 'confirmed' || conf === 'finalized';
		slot = status?.value?.slot ?? null;
		if (!landed) {
			const e = new Error('not landed within confirm window');
			e.code = 'NOT_LANDED';
			throw e;
		}
	}
	return { landed, slot };
}

/**
 * Submit a protected, MEV-aware transaction.
 *
 * @param {object}  o
 * @param {'mainnet'|'devnet'} o.network
 * @param {import('@solana/web3.js').Connection} o.connection   failover-wrapped Connection
 * @param {import('@solana/web3.js').Keypair}    o.payer        the agent keypair (signs)
 * @param {import('@solana/web3.js').TransactionInstruction[]} o.instructions  the trade ixs
 * @param {object}  [o.opts]
 * @param {'off'|'economy'|'turbo'} [o.opts.tipMode='off']     per-strategy Jito tip policy
 * @param {import('@solana/web3.js').Keypair[]} [o.opts.extraSigners=[]]  co-signers
 *          beyond the fee-payer (e.g. a new mint Keypair on a launch)
 * @param {number}  [o.opts.confirmTimeoutMs=45000]            protected-route confirm bound
 * @param {boolean} [o.opts.preSimulated=false]               caller already simulated (firewall) — still estimates CU
 * @param {(tipLamports: bigint, route: string) => Promise<void>} [o.opts.onTip]
 *          Spend-guard hook invoked BEFORE a tip is appended. Throw to veto the
 *          tip (engine then falls back to the protected route, no tip paid).
 * @returns {Promise<{ signature: string, slot: number|null, route: string,
 *           tipLamports: number, priorityFeeMicroLamports: number, attempts: number,
 *           landedMs: number, fallbackReason: string|null }>}
 */
export async function submitProtected({ network, connection, payer, instructions, opts = {} }) {
	const tipMode = ['economy', 'turbo'].includes(opts.tipMode) ? opts.tipMode : 'off';
	const confirmTimeoutMs = Number.isFinite(opts.confirmTimeoutMs) ? opts.confirmTimeoutMs : 45_000;
	// Co-signers beyond the fee-payer — e.g. a freshly generated mint Keypair on a
	// token launch. The fee payer is always `payer`; these are added to the
	// signature set. (Sim uses sigVerify:false, so it needs only the account metas
	// the instructions already carry, not these keypairs.)
	const extraSigners = Array.isArray(opts.extraSigners) ? opts.extraSigners : [];
	// Strip any caller-supplied ComputeBudget instructions: this engine sets its own
	// data-driven CU limit + escalating priority fee, and a SECOND ComputeBudget
	// instruction of the same kind makes the runtime reject the whole transaction.
	// No-op for the trade path (passes none); lets migrated send paths hand us their
	// raw instructions untouched without each having to remember to drop their own.
	const computeBudgetId = ComputeBudgetProgram.programId.toBase58();
	const userIxs = instructions.filter((ix) => {
		const pid = ix?.programId;
		const id = typeof pid?.toBase58 === 'function' ? pid.toBase58() : String(pid ?? '');
		return id !== computeBudgetId;
	});
	const t0 = Date.now();

	// 1. Data-driven compute budget. Estimate the priority fee and the CU limit in
	//    parallel — both are real RPC reads (fee cached, CU is a fresh simulate).
	const [priorityFeeBase, cuLimit] = await Promise.all([
		estimatePriorityFeeMicroLamports(connection, network),
		estimateComputeUnits(connection, payer, userIxs),
	]);

	const canJito = jitoEligible(network, tipMode);
	const tipFloor = canJito ? await fetchJitoTipFloorLamports() : null;

	let attempts = 0;
	let lastErr = null;
	let fallbackReason = canJito ? null : (network === 'devnet' ? 'devnet_no_jito' : (tipMode === 'off' ? 'tip_mode_off' : null));

	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
		attempts = attempt + 1;

		// Escalate the priority fee on each retry; floor + ceiling clamp it. The
		// ramp is steep on purpose (1x, 3x, 5x): a retry means the network outbid
		// us during a congested launch window, and re-bidding 60% higher was losing
		// the same auction again (EXEC_EXHAUSTED clusters in peak hours). The
		// ceiling caps the worst case at CU_PRICE_CEILING x cuLimit, well under a
		// position's size.
		const feeFloor = CU_PRICE_FLOOR[tipMode] || CU_PRICE_FLOOR.off;
		const priorityFeeMicroLamports = Math.min(
			CU_PRICE_CEILING,
			Math.max(feeFloor, Math.round(priorityFeeBase * (1 + attempt * 2))),
		);

		// Decide whether THIS attempt rides the Jito bundle. The first attempt(s) try
		// Jito; a bundle that doesn't land falls the NEXT attempt back to protected.
		const tryJito = canJito && fallbackReason == null;
		let tipLamports = 0n;
		const budgetIxs = [
			ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }),
			ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFeeMicroLamports }),
		];
		const txIxs = [...budgetIxs, ...userIxs];

		if (tryJito) {
			tipLamports = resolveTipLamports(tipMode, tipFloor, attempt);
			// Spend-guard the tip BEFORE it's appended. The hook counts it against the
			// daily budget + kill switch; a veto drops us to the protected route with no
			// tip ever leaving the wallet.
			let tipVetoed = false;
			if (typeof opts.onTip === 'function') {
				try {
					await opts.onTip(tipLamports, tipMode === 'turbo' ? 'jito_turbo' : 'jito_economy');
				} catch (e) {
					tipVetoed = true;
					fallbackReason = e?.code === 'spend_guard' ? 'tip_spend_guarded' : 'tip_vetoed';
				}
			}
			if (tipVetoed) {
				// Re-loop on the same attempt index via protected route (don't consume a
				// retry just to drop the tip).
				attempt--;
				continue;
			}
			txIxs.push(
				SystemProgram.transfer({
					fromPubkey: payer.publicKey,
					toPubkey: new PublicKey(pickTipAccount(attempt)),
					lamports: tipLamports,
				}),
			);
		}

		// Build, sign.
		let blockhashCtx;
		try {
			blockhashCtx = await connection.getLatestBlockhash('confirmed');
		} catch (e) {
			lastErr = e;
			continue;
		}
		const msg = new TransactionMessage({
			payerKey: payer.publicKey,
			recentBlockhash: blockhashCtx.blockhash,
			instructions: txIxs,
		}).compileToV0Message();
		const tx = new VersionedTransaction(msg);
		tx.sign([payer, ...extraSigners]);
		const signature = bs58Sig(tx);

		try {
			if (tryJito) {
				// Race BOTH lanes with the SAME signed tx. Solana dedupes by signature,
				// so at most one landing exists and the tip spend is identical to the
				// old serial flow (the protected re-send always carried the tip too).
				// What changes is latency: the public broadcast no longer waits out the
				// bundle poll window, which was costing the sniper ~12s of prime launch
				// time per attempt on a lane that lands a small minority of the time.
				const jitoTagged = sendJitoBundle(tx, signature, connection)
					.then((r) => ({ lane: 'jito', r }))
					.catch((e) => {
						// Jito unreachable / rejected: record honestly. We do NOT claim a
						// landing — the protected lane is already racing the same tx.
						fallbackReason = `jito_unavailable:${e?.code || 'error'}`;
						return { lane: 'jito', r: null };
					});
				const protTagged = sendProtected(tx, signature, connection, blockhashCtx, confirmTimeoutMs)
					.then((r) => ({ lane: 'protected', r }))
					.catch((e) => {
						lastErr = e;
						return { lane: 'protected', r: null, err: e };
					});

				// First landing wins; if the first lane to settle didn't land, wait for
				// the other before giving up the attempt.
				let outcome = await Promise.race([jitoTagged, protTagged]);
				if (!outcome.r?.landed) {
					outcome = await (outcome.lane === 'jito' ? protTagged : jitoTagged);
				}
				if (outcome.r?.landed) {
					return {
						signature,
						slot: outcome.r.slot,
						// Route label reflects the lane that actually reported the landing.
						route: outcome.lane === 'jito' ? (tipMode === 'turbo' ? 'jito_turbo' : 'jito_economy') : 'protected',
						tipLamports: Number(tipLamports),
						priorityFeeMicroLamports,
						attempts,
						landedMs: Date.now() - t0,
						fallbackReason: outcome.lane === 'jito' ? null : (fallbackReason || 'jito_not_landed'),
					};
				}
				// Neither lane landed. A hard on-chain revert is terminal: the same
				// instructions would revert again on every retry.
				const protSettled = await protTagged;
				if (protSettled.err?.code === 'TX_ERR') throw protSettled.err;
				if (fallbackReason == null) fallbackReason = 'jito_not_landed';
				// Retry with a fresh blockhash + higher fee/tip.
				continue;
			}

			// Protected single-tx route (devnet, tip 'off', or post-fallback).
			const prot = await sendProtected(tx, signature, connection, blockhashCtx, confirmTimeoutMs);
			if (prot.landed) {
				return {
					signature,
					slot: prot.slot,
					route: 'protected',
					tipLamports: 0,
					priorityFeeMicroLamports,
					attempts,
					landedMs: Date.now() - t0,
					fallbackReason,
				};
			}
		} catch (e) {
			lastErr = e;
			// A hard on-chain failure (TX_ERR) is terminal — the instructions reverted,
			// retrying the same trade would just revert again.
			if (e?.code === 'TX_ERR' || e?.code === 'SIM_FAILED') throw e;
			// Blockhash expiry / not-landed: refresh and retry.
		}
	}

	const err = lastErr || new Error('execution engine exhausted retries without landing');
	if (!err.code) err.code = 'EXEC_EXHAUSTED';
	throw err;
}

// Recover the base58 signature string from a signed VersionedTransaction without
// re-importing bs58 (web3.js bundles it; the signature is the first signature).
function bs58Sig(tx) {
	const sig = tx.signatures?.[0];
	if (!sig) throw new Error('transaction is not signed');
	// @solana/web3.js exposes bs58 via its own export; encode the 64-byte sig.
	return encodeBase58(sig);
}

// Minimal, dependency-free base58 encode (Bitcoin alphabet) for a 64-byte sig.
const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function encodeBase58(bytes) {
	const digits = [0];
	for (let i = 0; i < bytes.length; i++) {
		let carry = bytes[i];
		for (let j = 0; j < digits.length; j++) {
			carry += digits[j] << 8;
			digits[j] = carry % 58;
			carry = (carry / 58) | 0;
		}
		while (carry > 0) {
			digits.push(carry % 58);
			carry = (carry / 58) | 0;
		}
	}
	let out = '';
	for (let k = 0; k < bytes.length && bytes[k] === 0; k++) out += '1';
	for (let q = digits.length - 1; q >= 0; q--) out += B58_ALPHABET[digits[q]];
	return out;
}
