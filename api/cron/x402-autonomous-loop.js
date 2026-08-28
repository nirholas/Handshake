// GET /api/cron/x402-autonomous-loop
//
// Scheduled autonomous agent spend loop — the engine that makes three.ws an
// active participant in the x402 agent-to-agent economy rather than just a
// passive facilitator.
//
// Each tick:
//   1. Selects up to MAX_PER_TICK ready entries from autonomous-registry.js
//      (entries whose cooldown has elapsed, sorted by priority desc).
//   2. For each entry, probes the endpoint for a 402 challenge, builds a
//      Solana USDC payment, fires the request with X-PAYMENT header.
//   3. Records every call to x402_autonomous_log (success AND failure).
//   4. For oracle/sniper pipeline entries, extracts signal data and upserts
//      into oracle_intel_signals for the sniper oracle gate to consume.
//   5. Enforces a daily USDC spend cap across all calls in this loop.
//
// Real on-chain payments only — no mocks, no simulations.
//
// Env:
//   X402_SEED_SOLANA_SECRET_BASE58     seeder keypair (preferred)
//   X402_AGENT_SOLANA_SECRET_BASE58    fallback agent keypair
//   X402_AUTONOMOUS_ENABLED            'false' to pause (default: enabled)
//   X402_AUTONOMOUS_MAX_PER_TICK       max calls per cron tick (default: 8)
//   X402_AUTONOMOUS_DAILY_CAP_ATOMIC   daily USDC cap in atomics (default: 5000000 = $5)
//   CRON_SECRET                        required Vercel cron auth

import { randomUUID } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import {
	getAssociatedTokenAddressSync,
	TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getMint,
} from '@solana/spl-token';

import { json, method, wrapCron } from '../_lib/http.js';
import { env } from '../_lib/env.js';
import { getRedis } from '../_lib/redis.js';
import { sql } from '../_lib/db.js';
import { solanaConnection } from '../_lib/solana/connection.js';
import { logger } from '../_lib/usage.js';
import {
	loadSeedKeypair,
	fetchWithTimeout,
	parseSolanaAccept,
	buildPaymentTx,
	ringFeeConfig,
	expectedFeeLamports,
} from '../_lib/x402/pay.js';
import { assessFeeAdmission } from '../_lib/x402/wallet-fee-meter.js';
import {
	getFullRegistry,
	MAX_PER_TICK,
	DAILY_CAP_ATOMIC,
} from '../_lib/x402/autonomous-registry.js';
import { assertRingSpendInvariants } from '../_lib/x402/ring-allowlist.js';
import { SPONSOR_SOL_FLOOR_LAMPORTS, sponsorKnownBelowFloor } from '../_lib/x402/self-facilitator.js';
import { sendOpsAlert } from '../_lib/alerts.js';
import { requireCron } from '../_lib/cron-auth.js';

const log = logger('x402-autonomous-loop');

// Live USDC balance of the ring payer, in atomic units (6dp).
//
// Returns 0 when the wallet genuinely holds nothing (including the no-ATA case:
// a wallet that has never held USDC has no token account at all). Returns null
// when the balance could not be determined — a transient RPC failure must NOT
// read as "zero", because callers gate the spend path on this and an unknown
// balance should leave the path open rather than silently halt the ring.
//
// Existence is probed with getAccountInfo (returns null for a missing account,
// no throw) rather than by pattern-matching getTokenAccountBalance's error
// string, whose wording varies across RPC providers.
export async function readPayerUsdcAtomic(conn, payerPubkey) {
	if (!USDC_MINT) return 0;
	let ata;
	try {
		ata = getAssociatedTokenAddressSync(
			new PublicKey(USDC_MINT), payerPubkey,
			false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
		);
	} catch (err) {
		// Off-curve owner — a misconfigured payer key, not an empty wallet.
		log.warn('payer_usdc_ata_underivable', { message: err?.message });
		return null;
	}
	try {
		const info = await conn.getAccountInfo(ata);
		if (info === null) return 0; // no token account ⇒ holds no USDC
		const bal = await conn.getTokenAccountBalance(ata);
		const amount = Number(bal?.value?.amount);
		return Number.isFinite(amount) ? amount : null;
	} catch (err) {
		log.warn('payer_usdc_read_failed', { message: err?.message });
		return null;
	}
}

const ORIGIN = () => env.APP_ORIGIN || 'https://three.ws';
const USDC_MINT = env.X402_ASSET_MINT_SOLANA;
const SOLANA_RPC = env.SOLANA_RPC_URL;

// Redis key prefix for cooldown tracking.
const COOLDOWN_PREFIX = 'x402:auto:last:';
// Redis key for daily spend accumulator (resets each UTC calendar day).
const DAILY_SPEND_KEY = () => `x402:auto:daily:${new Date().toISOString().slice(0, 10)}`;

async function recordLog(runId, entry, { amountAtomic, txSig, responseData, durationMs, success, errorMsg, signalData, valueExtracted, endpointUrl }) {
	try {
		await sql`
			INSERT INTO x402_autonomous_log
				(run_id, endpoint_type, service_name, endpoint_url,
				 network, amount_atomic, asset, tx_signature,
				 response_data, signal_data, value_extracted, duration_ms, success, error_msg, pipeline)
			VALUES
				(${runId}, ${entry.url ? 'external' : 'self'},
				 ${entry.name}, ${endpointUrl || entry.url || entry.path},
				 ${'solana:mainnet'}, ${amountAtomic || 0},
				 ${USDC_MINT || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'},
				 ${txSig || null},
				 ${responseData ? JSON.stringify(responseData) : null},
				 ${signalData ? JSON.stringify(signalData) : null},
				 ${valueExtracted ? JSON.stringify(valueExtracted) : null},
				 ${durationMs || 0}, ${success}, ${errorMsg || null},
				 ${entry.pipeline || 'unknown'})
		`;
	} catch (err) {
		log.warn('autonomous_log_insert_failed', { id: entry.id, message: err?.message });
	}
}

async function upsertOracleSignal(entry, signalData, txSig = null) {
	if (!signalData || entry.pipeline !== 'oracle') return;
	try {
		await sql`
			INSERT INTO oracle_intel_signals
				(source_id, topic, signal, headline, confidence, price_usd, raw, tx_signature, ts)
			VALUES
				(${entry.id}, ${signalData.topic || entry.id},
				 ${signalData.signal || null}, ${signalData.headline || null},
				 ${signalData.confidence || null}, ${signalData.price_usd || null},
				 ${JSON.stringify(signalData)}, ${txSig}, now())
			ON CONFLICT (source_id, topic)
			DO UPDATE SET
				signal       = EXCLUDED.signal,
				headline     = EXCLUDED.headline,
				confidence   = EXCLUDED.confidence,
				price_usd    = EXCLUDED.price_usd,
				raw          = EXCLUDED.raw,
				tx_signature = EXCLUDED.tx_signature,
				ts           = now()
		`;
	} catch (err) {
		// Table may not exist yet — suppress, it will be created by the migration.
		if (!err?.message?.includes('does not exist')) {
			log.warn('oracle_signal_upsert_failed', { id: entry.id, message: err?.message });
		}
	}
}

async function ensureSchema() {
	// x402_autonomous_log: records every autonomous loop call.
	try {
		await sql`
			CREATE TABLE IF NOT EXISTS x402_autonomous_log (
				id              bigserial PRIMARY KEY,
				run_id          uuid NOT NULL,
				ts              timestamptz DEFAULT now(),
				endpoint_type   text NOT NULL CHECK (endpoint_type IN ('self', 'external')),
				service_name    text NOT NULL,
				endpoint_url    text NOT NULL,
				network         text NOT NULL DEFAULT 'solana:mainnet',
				amount_atomic   bigint NOT NULL DEFAULT 0,
				asset           text,
				tx_signature    text,
				response_data   jsonb,
				signal_data     jsonb,
				value_extracted jsonb,
				duration_ms     int,
				success         boolean NOT NULL,
				error_msg       text,
				pipeline        text
			)
		`;
	} catch { /* already exists or migration system handles it */ }

	// value_extracted predates some installs (the table may already exist without
	// it); ensure it before any recordLog INSERT references the column. Idempotent.
	try {
		await sql`ALTER TABLE x402_autonomous_log ADD COLUMN IF NOT EXISTS value_extracted jsonb`;
	} catch { /* column already present */ }

	// oracle_intel_signals: deduped latest signal per source+topic.
	// The sniper oracle gate queries this to enrich conviction scores.
	try {
		await sql`
			CREATE TABLE IF NOT EXISTS oracle_intel_signals (
				source_id    text NOT NULL,
				topic        text NOT NULL,
				signal       text,
				headline     text,
				confidence   numeric(5,2),
				price_usd    numeric(20,8),
				raw          jsonb,
				tx_signature text,
				ts           timestamptz DEFAULT now(),
				PRIMARY KEY (source_id, topic)
			)
		`;
	} catch { /* already exists */ }
	try {
		// Pre-migration deployments created the table without the receipt column.
		await sql`ALTER TABLE oracle_intel_signals ADD COLUMN IF NOT EXISTS tx_signature text`;
	} catch { /* concurrent tick or insufficient privileges; migration covers it */ }
}

async function getDailySpend(redis) {
	if (!redis) return 0;
	try {
		const val = await redis.get(DAILY_SPEND_KEY());
		return val ? Number(val) : 0;
	} catch { return 0; }
}

async function incrementDailySpend(redis, atomics) {
	if (!redis || !atomics) return;
	try {
		const key = DAILY_SPEND_KEY();
		await redis.incrby(key, atomics);
		await redis.expire(key, 86400 * 2); // 2-day TTL (covers UTC rollover)
	} catch { /* non-fatal */ }
}

async function isCoolingDown(redis, entry) {
	if (!redis) return false;
	try {
		const val = await redis.get(`${COOLDOWN_PREFIX}${entry.id}`);
		return !!val;
	} catch { return false; }
}

async function setCooldown(redis, entry) {
	if (!redis || !entry.cooldown_s) return;
	try {
		await redis.set(`${COOLDOWN_PREFIX}${entry.id}`, '1', { ex: entry.cooldown_s });
	} catch { /* non-fatal */ }
}

// Optional per-entry value-store hook. Lets a pipeline persist its extracted
// value into a dedicated table (beyond the generic signal_data column). Wrapped
// so a DB failure inside the hook can never crash the tick.
async function runStoreValue(entry, ctx) {
	if (typeof entry.storeValue !== 'function') return;
	try {
		await entry.storeValue(ctx);
	} catch (err) {
		log.warn('store_value_failed', { id: entry.id, message: err?.message });
	}
}

// ── Main handler ──────────────────────────────────────────────────────────────

export default wrapCron(async (req, res) => {
	if (!method(req, res, ['GET'])) return;
	if (!requireCron(req, res)) return;

	if (process.env.X402_AUTONOMOUS_ENABLED === 'false') {
		return json(res, 200, { ok: true, skipped: true, reason: 'X402_AUTONOMOUS_ENABLED=false' });
	}

	// ── Ring spend invariants — fail CLOSED ───────────────────────────────────
	// No money moves unless the closed-loop guard env holds (external spending
	// off, charity split zero, facilitator = self). A flipped or forgotten flag
	// no-ops the entire spend path and fires one throttled CRITICAL alert naming
	// the flag — see api/_lib/x402/ring-allowlist.js.
	const invariants = await assertRingSpendInvariants({ context: 'x402-autonomous-loop' });
	if (!invariants.ok) {
		return json(res, 200, {
			ok: false,
			skipped: true,
			reason: 'ring_invariant_violation',
			violations: invariants.violations.map((v) => v.flag),
		});
	}

	const runId = randomUUID();
	const origin = ORIGIN();
	const redis = getRedis();

	// ── Pre-flight checks ─────────────────────────────────────────────────────
	let buyer;
	try { buyer = loadSeedKeypair(); } catch (err) {
		return json(res, 200, { ok: false, skipped: true, reason: err.message });
	}

	if (redis) {
		try { await redis.ping(); } catch (err) {
			return json(res, 200, { ok: false, skipped: true, reason: `redis_unavailable: ${err?.message}` });
		}
	}

	// ── Daily spend cap check ─────────────────────────────────────────────────
	const dailySpentSoFar = await getDailySpend(redis);
	if (dailySpentSoFar >= DAILY_CAP_ATOMIC) {
		log.info('autonomous_daily_cap_reached', { spent: dailySpentSoFar, cap: DAILY_CAP_ATOMIC });
		return json(res, 200, { ok: true, skipped: true, reason: 'daily_cap_reached', spent_usdc: dailySpentSoFar / 1e6 });
	}

	// ── Ensure schema exists ──────────────────────────────────────────────────
	await ensureSchema();

	// ── Select ready entries ──────────────────────────────────────────────────
	const registry = getFullRegistry();
	const readyChecks = await Promise.all(
		registry.map(async (entry) => {
			const cooling = await isCoolingDown(redis, entry);
			return { entry, ready: !cooling };
		}),
	);
	// Maintenance entries (recirculation: treasury→payer sweep, agent float
	// top-up, pool funding) get RESERVED slots outside MAX_PER_TICK. They move
	// zero net spend, are cooldown-gated at 120s, and are the only thing keeping
	// the payer float alive. When they competed on priority alone, a wave of
	// failing high-priority paid entries starved them for days and the whole
	// ring drained (July 2026 flat-line).
	const readyAll = readyChecks.filter((e) => e.ready).map((e) => e.entry);
	const byPriority = (a, b) => (b.priority || 0) - (a.priority || 0);
	const maintenance = readyAll.filter((e) => e.maintenance).sort(byPriority);
	const ready = [
		...maintenance,
		...readyAll.filter((e) => !e.maintenance).sort(byPriority).slice(0, MAX_PER_TICK),
	];

	if (ready.length === 0) {
		return json(res, 200, { ok: true, skipped: true, reason: 'all_cooling_down', run_id: runId });
	}

	// ── Shared Solana state (one blockhash per tick, shared across all calls) ─
	const conn = solanaConnection({ url: SOLANA_RPC, commitment: 'confirmed' });
	let blockhash, mintInfo;
	try {
		[{ blockhash }, mintInfo] = await Promise.all([
			conn.getLatestBlockhash('confirmed'),
			getMint(conn, new PublicKey(USDC_MINT)),
		]);
	} catch (err) {
		return json(res, 200, { ok: false, reason: `solana_preflight_failed: ${err?.message}`, run_id: runId });
	}

	// ── Payer USDC float — the spend ceiling the daily cap can't see ─────────
	// The daily cap bounds how much we're *allowed* to spend; the payer's token
	// balance bounds how much we're *able* to. Without this read, a drained float
	// still probes, signs, and POSTs a payment for every ready entry each tick —
	// the server then fails at settle with `broadcast_failed:Simulation failed`
	// (observed: 1,262 failures in 24h, ~1/min, forever). Read it once per tick
	// and treat it as a hard spend ceiling so a dry wallet degrades to "skip the
	// paid calls" instead of "hammer Solana with transactions that cannot land".
	// Free endpoints and run()-style monitors (including the wallet-balance
	// monitor that alerts on this very condition) keep running regardless.
	const payerUsdcAtomic = await readPayerUsdcAtomic(conn, buyer.publicKey);
	if (payerUsdcAtomic === 0) {
		log.warn('autonomous_payer_usdc_empty', { payer: buyer.publicKey.toBase58() });
		await sendOpsAlert(
			'💸 x402 autonomous loop halted — payer USDC float is empty',
			`Ring payer ${buyer.publicKey.toBase58()} holds $0.00 USDC. Every paid call this tick is skipped ` +
				'(they would fail at settle with "Simulation failed"). The loop keeps running its free and ' +
				'monitoring entries. Top up the payer\'s USDC float to resume autonomous spend.',
			{ signature: `x402-autonomous-payer-usdc-empty:${buyer.publicKey.toBase58()}` },
		);
	}

	// ── Sponsor SOL floor: the settle ceiling neither cap can see ────────────
	// This loop builds SPONSOR-mode payments (buildPaymentTx without selfPay), so
	// every settle is fee-paid by the sponsor wallet, and the self-facilitator
	// fail-closes the moment that wallet dips under SPONSOR_SOL_FLOOR_LAMPORTS.
	// Without this read, a below-floor sponsor still probes, signs, and POSTs a
	// payment for every ready entry, and every one dies at settle with a 502
	// (observed: ~420 fee_wallet_below_floor rejects/hour, for days). Read the
	// sponsor balance once per tick and treat below-floor as a hard pause on paid
	// calls: free endpoints and run()-style monitors keep running, and ONE deduped
	// CRITICAL alert names the wallet instead of a silent failure wave.
	// `null` = balance read failed. That used to read as "not paused", which is
	// how this gate failed exactly when it was needed most: on 2026-08-28 all four
	// paid Solana RPC lanes were over quota at the same moment the sponsor sat at
	// 0.000899 SOL, so getBalance threw, sponsorSolLamports stayed null, and the
	// loop spent three hours signing payments that could not settle. 95 attempts,
	// 0 settled. An unreadable balance is not evidence of solvency, so the second
	// opinion below decides it instead of a fail-open default.
	const sponsorPubkey = env.X402_FEE_PAYER_SOLANA || null;
	let sponsorSolLamports = null;
	if (sponsorPubkey) {
		try {
			sponsorSolLamports = await conn.getBalance(new PublicKey(sponsorPubkey), 'confirmed');
		} catch (err) {
			log.warn('sponsor_sol_read_failed', { message: err?.message });
		}
	}
	// The floor guard is written by settle failures as well as by balance reads
	// (noteSponsorRentFailure in self-facilitator.js), so it still answers when
	// the RPC does not: a rent-exemption rejection IS the chain stating the
	// sponsor cannot pay, and it costs no RPC call to observe.
	const sponsorFloorPaused = sponsorSolLamports === null
		? sponsorKnownBelowFloor()
		: sponsorSolLamports < SPONSOR_SOL_FLOOR_LAMPORTS;
	if (sponsorFloorPaused) {
		log.warn('autonomous_sponsor_sol_floor', { sponsor: sponsorPubkey, lamports: sponsorSolLamports, floor: SPONSOR_SOL_FLOOR_LAMPORTS });
		await sendOpsAlert(
			'⛔ x402 autonomous loop paused: sponsor wallet below SOL settle floor',
			`Sponsor ${sponsorPubkey} ${
				sponsorSolLamports === null
					? 'could not be read (RPC unavailable) and the settle path has already reported it below floor'
					: `holds ${(sponsorSolLamports / 1e9).toFixed(6)} SOL`
			}, below the ` +
				`${(SPONSOR_SOL_FLOOR_LAMPORTS / 1e9).toFixed(3)} SOL settle floor. The self-facilitator ` +
				'fail-closes every settle at this level, so all paid calls are skipped this tick (free and ' +
				'monitoring entries keep running). Fund the sponsor with SOL (or let treasury-topup refuel it) to resume.',
			{ signature: `x402-autonomous-sponsor-sol-floor:${sponsorPubkey}` },
		);
	}

	// ── Process each entry ────────────────────────────────────────────────────
	const results = [];
	let remainingCap = DAILY_CAP_ATOMIC - dailySpentSoFar;

	for (const entry of ready) {
		if (remainingCap <= 0) break;

		let endpointUrl = entry.url || `${origin}${entry.path}`;
		let targetUrl = null;
		let targetContext = null;
		const t0 = Date.now();
		let amountAtomic = 0;
		let txSig = null;
		let success = false;
		let errorMsg = null;
		let responseBody = null;
		let signalData = null;

		// run()-style entries own their full call sequence (queue scans, worker
		// polling, multi-row fan-out). They pay via the shared payX402 client and
		// hand back a structured outcome; the loop records it exactly like an
		// inline call. A thrown run() never crashes the tick — it lands as a
		// recorded failure with the cooldown still applied to avoid hot-looping.
		if (typeof entry.run === 'function') {
			let outcome = null;
			try {
				outcome = await entry.run({
					origin, buyer, conn, blockhash, mintInfo,
					redis, sql, log, runId,
					// A run() pipeline pays through the shared payX402 client, so it
					// must see the payer's real float as its ceiling too — otherwise it
					// happily attempts settles the daily cap permits but the wallet
					// cannot fund. `null` (read failed) leaves the cap untouched.
					remainingCap: payerUsdcAtomic === null
						? remainingCap
						: Math.min(remainingCap, payerUsdcAtomic),
					payerUsdcAtomic,
				});
			} catch (err) {
				errorMsg = err?.message || 'run_error';
			}
			outcome = outcome || {};
			amountAtomic = Number(outcome.amountAtomic) || 0;
			txSig = outcome.txSig || null;
			success = outcome.success ?? false;
			errorMsg = outcome.errorMsg || errorMsg;
			responseBody = outcome.responseData ?? null;
			signalData = outcome.signalData ?? null;

			if (success && amountAtomic > 0) {
				remainingCap -= amountAtomic;
				await incrementDailySpend(redis, amountAtomic);
			}
			await setCooldown(redis, entry);

			results.push({
				id: entry.id,
				status: outcome.skipped ? 'skip' : (success ? (amountAtomic > 0 ? 'paid' : 'ok') : 'error'),
				amount_usdc: amountAtomic / 1e6,
				tx: txSig,
				...(outcome.note ? { note: outcome.note } : {}),
			});
			// A pipeline that records its own granular per-call rows (one per
			// resource it fanned across) sets outcome.recorded so the loop does not
			// add a duplicate summary row. Entries that don't self-record still get
			// the single canonical row here.
			if (!outcome.recorded) {
				await recordLog(runId, entry, {
					amountAtomic, txSig, responseData: responseBody,
					durationMs: Date.now() - t0, success, errorMsg, signalData,
					valueExtracted: outcome.valueExtracted ?? null,
				});
			}
			continue;
		}

		// Dynamic target resolution (rotation pipelines, e.g. GLB canonicalization):
		// resolveTarget computes the per-call path and the resource URL being checked.
		if (typeof entry.resolveTarget === 'function') {
			try {
				const resolved = await entry.resolveTarget({ redis, sql, origin, runId });
				if (resolved?.path) endpointUrl = entry.url || `${origin}${resolved.path}`;
				if (resolved?.targetUrl) targetUrl = resolved.targetUrl;
				if (resolved?.context) targetContext = resolved.context;
			} catch (err) {
				log.warn('resolve_target_failed', { id: entry.id, message: err?.message });
			}
		}

		// Resolve the request body. Most entries carry a static `body`. Pipeline
		// entries provide `body` as a function of the resolved target — e.g. the VRM
		// compatibility checker embeds the selected avatar's public GLB URL into an
		// MCP inspect_model tools/call. A function body that returns null means
		// "no target to process this tick": skip without probing or paying.
		const requestBody = typeof entry.body === 'function'
			? entry.body({ targetUrl, targetContext, origin, endpointUrl })
			: entry.body;
		if (typeof entry.body === 'function' && requestBody == null) {
			results.push({ id: entry.id, status: 'skip', reason: 'no_target' });
			await setCooldown(redis, entry); // back off so we don't re-query every tick
			continue;
		}

		try {
			// Step 1: probe for 402 challenge
			const probeRes = await fetchWithTimeout(endpointUrl, {
				method: entry.method || 'POST',
				headers: { 'content-type': 'application/json', 'user-agent': 'threews-x402-autonomous/1.0' },
				...(requestBody != null ? { body: JSON.stringify(requestBody) } : {}),
			});

			if (probeRes.status !== 402) {
				// Free endpoint — record as success without payment.
				success = true;
				responseBody = probeRes.body;
				if (entry.extractSignal) signalData = entry.extractSignal(responseBody);
				results.push({ id: entry.id, status: 'free', success });
				await recordLog(runId, entry, { amountAtomic: 0, txSig: null, responseData: responseBody, durationMs: Date.now() - t0, success, signalData, endpointUrl });
				if (signalData) await upsertOracleSignal(entry, signalData);
				await runStoreValue(entry, { sql, redis, responseBody, signalData, runId, targetUrl, targetContext, endpointUrl, origin, durationMs: Date.now() - t0, success, amountAtomic, txSig });
				await setCooldown(redis, entry);
				continue;
			}

			const accept = parseSolanaAccept(probeRes.body);
			if (!accept) {
				errorMsg = 'no_solana_accept';
				results.push({ id: entry.id, status: 'skip', reason: errorMsg });
				await setCooldown(redis, entry); // endpoint misconfigured; don't re-probe every tick
				continue;
			}
			if (!USDC_MINT || accept.asset !== USDC_MINT) {
				errorMsg = `unexpected_asset:${accept.asset}`;
				results.push({ id: entry.id, status: 'skip', reason: errorMsg });
				await setCooldown(redis, entry);
				continue;
			}
			if (!accept.extra?.feePayer) {
				errorMsg = 'missing_fee_payer';
				results.push({ id: entry.id, status: 'skip', reason: errorMsg });
				await setCooldown(redis, entry);
				continue;
			}

			// Below the settle floor every sponsor-mode payment is rejected by the
			// facilitator before broadcast; skip BEFORE building/signing/POSTing.
			if (sponsorFloorPaused) {
				results.push({ id: entry.id, status: 'skip', reason: 'sponsor_sol_floor_paused' });
				await setCooldown(redis, entry); // SOL won't appear mid-cooldown; stop re-probing
				continue;
			}

			amountAtomic = Number(accept.amount || 0);
			if (amountAtomic > remainingCap) {
				log.info('autonomous_cap_would_exceed', { id: entry.id, amount: amountAtomic, remaining: remainingCap });
				results.push({ id: entry.id, status: 'skip', reason: 'cap_would_exceed' });
				await setCooldown(redis, entry); // cap headroom won't appear mid-cooldown; stop re-probing
				continue;
			}
			// Can't pay what we don't hold. Skip BEFORE building/signing/POSTing a
			// transaction the facilitator would only fail to simulate. `null` means
			// the balance read itself failed — unknown, so don't gate on it.
			if (payerUsdcAtomic !== null && amountAtomic > payerUsdcAtomic) {
				log.info('autonomous_insufficient_payer_usdc', { id: entry.id, amount: amountAtomic, held: payerUsdcAtomic });
				results.push({ id: entry.id, status: 'skip', reason: 'insufficient_payer_usdc' });
				await setCooldown(redis, entry); // back off; don't re-probe every tick
				continue;
			}

			// Fee-budget admission: the caller-side twin of the settle path's wallet
			// fee governor, and the guard this loop was missing while the ring's
			// payX402() already had it (api/_lib/x402/pay.js). Once the fee wallet has
			// spent its daily SOL budget the facilitator refuses every settle, so an
			// ATA read, a signature, a facilitator verify (which simulates against an
			// RPC node) and the POST itself all buy a guaranteed refusal at the end.
			// That round trip was the whole of this loop's 502 rate: 15,619 of the
			// 20,030 `http_502` rows in the 48h to 2026-08-06 were this exact refusal
			// arriving after a full handshake. Skipping here removes only doomed work:
			// assessFeeAdmission() fails open whenever it cannot price the call, and
			// it settles nothing extra when the budget is healthy.
			const feeConfig = ringFeeConfig(0, { selfPay: false });
			const admission = await assessFeeAdmission({
				feeWalletB58: accept.extra.feePayer,
				estFeeLamports: expectedFeeLamports({
					selfPay: false,
					priorityMicrolamports: feeConfig.microLamports,
					cuLimit: feeConfig.cuLimit,
				}),
				connection: conn,
			});
			if (!admission.ok) {
				errorMsg = admission.reason || 'fee_runway_exhausted';
				results.push({ id: entry.id, status: 'skip', reason: errorMsg });
				await setCooldown(redis, entry); // budget refills on a top-up or the UTC reset, not mid-cooldown
				// Recorded, not silently dropped: x402-settle-health.js reads this table
				// and counts `fee_runway_exhausted` as governorSkips so a paced rail
				// reports "top the fee wallet up" instead of the `unknown` verdict an
				// empty window produces. A skip that leaves no row is indistinguishable
				// from a rail nobody used.
				await recordLog(runId, entry, {
					amountAtomic: 0, txSig: null, responseData: null,
					durationMs: Date.now() - t0, success: false, errorMsg, endpointUrl,
				});
				continue;
			}

			// Step 2: check if receiver ATA exists (optimization — share lookup)
			const receiverAta = getAssociatedTokenAddressSync(
				new PublicKey(accept.asset), new PublicKey(accept.payTo),
				false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
			);
			const receiverAtaInfo = await conn.getAccountInfo(receiverAta).catch(() => null);

			// Step 3: build signed tx
			const txBase64 = buildPaymentTx({
				accept, buyer, blockhash, mintInfo,
				receiverAtaExists: receiverAtaInfo !== null,
			});

			const xPayment = Buffer.from(JSON.stringify({
				x402Version: 2,
				scheme: 'exact',
				network: accept.network,
				resource: { url: endpointUrl, mimeType: 'application/json' },
				payload: { transaction: txBase64 },
				accepted: accept,
			})).toString('base64');

			// Step 4: fire with payment
			const paidRes = await fetchWithTimeout(endpointUrl, {
				method: entry.method || 'POST',
				headers: {
					'content-type': 'application/json',
					'user-agent': 'threews-x402-autonomous/1.0',
					'x-payment': xPayment,
				},
				...(requestBody != null ? { body: JSON.stringify(requestBody) } : {}),
			});

			responseBody = paidRes.body;
			success = paidRes.ok;

			if (success) {
				// Extract tx signature from X-PAYMENT-RESPONSE header if present.
				const responseHeader = paidRes.headers?.get?.('x-payment-response');
				if (responseHeader) {
					try {
						const settled = JSON.parse(Buffer.from(responseHeader, 'base64').toString('utf8'));
						txSig = settled?.transaction || null;
					} catch { /* non-fatal */ }
				}

				remainingCap -= amountAtomic;
				await incrementDailySpend(redis, amountAtomic);
				if (entry.extractSignal) signalData = entry.extractSignal(responseBody);
				await setCooldown(redis, entry);
				// The settle signature rides along so the sniper's oracle gate can cite
				// the exact on-chain payment behind each signal it acts on.
				if (signalData) await upsertOracleSignal(entry, signalData, txSig);
				await runStoreValue(entry, { sql, redis, responseBody, signalData, runId, targetUrl, targetContext, endpointUrl, origin, durationMs: Date.now() - t0, success, amountAtomic, txSig });
			} else {
				errorMsg = `http_${paidRes.status}`;
				// Failure MUST cool down too. Without this a failing paid entry
				// retried every tick forever: 12k+ settle-502 rows/day, all 8 tick
				// slots pinned by the same broken entries, and the maintenance
				// pipelines starved out of the rotation entirely.
				await setCooldown(redis, entry);
			}

			results.push({ id: entry.id, status: success ? 'paid' : 'error', amount_usdc: amountAtomic / 1e6, tx: txSig });
		} catch (err) {
			errorMsg = err?.message || 'unknown_error';
			results.push({ id: entry.id, status: 'error', reason: errorMsg });
			await setCooldown(redis, entry);
		}

		await recordLog(runId, entry, {
			amountAtomic,
			txSig,
			responseData: responseBody,
			durationMs: Date.now() - t0,
			success,
			errorMsg,
			signalData,
			endpointUrl,
		});
	}

	const paid = results.filter((r) => r.status === 'paid');
	const totalUsdc = paid.reduce((s, r) => s + (r.amount_usdc || 0), 0);

	log.info('autonomous_tick_complete', {
		run_id: runId,
		ready: ready.length,
		called: results.length,
		paid: paid.length,
		total_usdc: totalUsdc.toFixed(4),
		payer: buyer.publicKey.toBase58(),
	});

	return json(res, 200, {
		ok: true,
		run_id: runId,
		ready: ready.length,
		called: results.length,
		paid: paid.length,
		total_usdc: totalUsdc.toFixed(4),
		daily_spent_usdc: (dailySpentSoFar / 1e6 + totalUsdc).toFixed(4),
		daily_cap_usdc: (DAILY_CAP_ATOMIC / 1e6).toFixed(2),
		results,
	});
});
