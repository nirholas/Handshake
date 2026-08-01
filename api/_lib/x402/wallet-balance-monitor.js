// api/_lib/x402/wallet-balance-monitor.js
//
// Agent Wallet Balance Monitor — autonomous pipeline (self).
//
// The autonomous spend loop pays for everything else from the platform seed
// wallet. If that wallet runs dry, every other autonomous call silently starts
// failing with insufficient-funds. This monitor is the early-warning system:
// once every 10 minutes it reads the wallet's live USDC + SOL balance, records
// a time-series sample, derives the spend rate since the previous sample, and
// raises a low-balance alert before the autonomous loop can be starved.
//
// Endpoint: GET /api/x402-pay?balance=1 — a FREE read (no 402, no payment). It
// returns { configured, address, sol, usdc } for the wallet backed by
// X402_AGENT_SOLANA_SECRET_BASE58 (the same secret loadSeedKeypair() falls back
// to), i.e. the wallet that funds the autonomous loop. Because the call is free,
// this pipeline moves no funds — amountAtomic is always 0.
//
// Wiring: declared as a run()-style entry in autonomous-registry.js
// (`agent-wallet-balance-monitor`). The per-tick loop
// (api/cron/x402-autonomous-loop.js) hands run() { origin, redis, sql, log,
// runId } and records the returned outcome as one row in x402_autonomous_log.
// Called standalone (manual test) it derives its own origin/sql and still works.
//
// Value extracted & where it lands:
//   • agent_wallet_balance_log — one time-series row per run. Columns:
//       usdc, sol            → the live balances
//       low_balance          → alert flag (usdc < threshold)
//       threshold_usdc       → the alert threshold in force at sample time
//       usdc_delta           → usdc change vs the previous sample (− = spent)
//       spend_rate_usdc_hr   → derived burn rate (USDC/hour) since last sample
//   • Redis x402:wallet-balance:latest — newest sample (configured, usdc, sol,
//     low_balance, ts) for cheap dashboard reads without a DB round-trip.
//   • Redis x402:wallet-balance:alert  — present (with TTL) only while the wallet
//     is below threshold, so a consumer can detect the alert state in one GET.
//
// Downstream consumer: api/ops/health.js reads the latest balance sample and
// folds a low / unconfigured wallet into the internal health verdict, so the
// status dashboard and on-call alerting surface "top up the agent wallet"
// before autonomous calls begin to fail. The time-series rows back the spend-
// rate trend an operator reads to decide how much to top up.

import { randomUUID } from 'node:crypto';

import { fetchWithTimeout, loadSeedKeypair, USDC_MINT } from './pay.js';
import { SPONSOR_SOL_FLOOR_LAMPORTS } from './self-facilitator.js';
import { ringFloorSpecs, evaluateRingWallet, LAMPORTS_PER_SOL } from './ring-floors.js';
import {
	computeSponsorRunway,
	formatSponsorRunwayAlert,
	measureSponsorBurn,
	SPONSOR_BURN_WINDOW_DAYS,
	SPONSOR_RUNWAY_ALERT_DAYS,
} from './sponsor-runway.js';
import { sql as defaultSql } from '../db.js';
import { env } from '../env.js';
import { sendOpsAlert } from '../alerts.js';
import { solanaConnection } from '../solana/connection.js';
import { logger } from '../usage.js';

const log = logger('x402-wallet-balance-monitor');

// ── Ring-wallet floors ──────────────────────────────────────────────────────
// The closed-loop ring has three platform-controlled wallets (payer, treasury,
// sponsor). Each has a role-appropriate floor the monitor watches so the loop
// never silently halts on a drained fee wallet or an empty USDC float:
//   • sponsor SOL — the fee wallet. At/below the facilitator's own hard floor
//     (X402_SPONSOR_SOL_FLOOR_LAMPORTS, default 0.02 SOL) settlement is refused
//     and the ring pauses. Alert BEFORE that so an operator (or the economy
//     master's treasury-topup cron) can refill first. Watched at 1.5× the floor.
//   • payer SOL — in self-pay mode (X402_RING_SELF_PAY) the payer pays its own
//     1-signature fee, so it needs the same SOL headroom as the sponsor.
//   • payer USDC — the recirculating float. Below this the daily volume cap can
//     no longer be funded. New env X402_RING_PAYER_USDC_FLOOR_ATOMIC, default $5.
//   • treasury — UNBOUNDED. It only receives ring payments and gets swept back
//     to the payer by the rebalancer, so a low balance is its healthy resting
//     state, not an alert condition.
const RING_SOL_FLOOR_LAMPORTS = Math.round(SPONSOR_SOL_FLOOR_LAMPORTS * 1.5);
const RING_PAYER_USDC_FLOOR_ATOMIC = Number(
	env.X402_RING_PAYER_USDC_FLOOR_ATOMIC || process.env.X402_RING_PAYER_USDC_FLOOR_ATOMIC || 5_000_000,
);

const REDIS_RING_KEY = 'x402:ring-wallets:latest';

// Low-balance alert threshold (USDC). Default $5 — below this the autonomous
// loop's own daily cap ($5) can no longer be fully funded, so it's the natural
// "top up now" line. Override via env without a redeploy.
const ALERT_THRESHOLD_USDC = Number(env.X402_WALLET_BALANCE_ALERT_USDC || process.env.X402_WALLET_BALANCE_ALERT_USDC || 5);

const REDIS_LATEST_KEY = 'x402:wallet-balance:latest';
const REDIS_ALERT_KEY = 'x402:wallet-balance:alert';
// Alert key TTL: a little over two monitor cycles (10 min) so a missed run
// lets the flag lapse to "unknown" rather than latching a stale alert forever.
const ALERT_TTL_SECONDS = 25 * 60;

// One-time DDL guard per warm instance (mirrors the loop's ensureSchema idiom).
let _schemaReady = false;
async function ensureSchema(sql) {
	if (_schemaReady) return;
	await sql`
		CREATE TABLE IF NOT EXISTS agent_wallet_balance_log (
			id                 bigserial PRIMARY KEY,
			ts                 timestamptz NOT NULL DEFAULT now(),
			run_id             uuid,
			address            text,
			configured         boolean NOT NULL DEFAULT true,
			usdc               numeric(20,6),
			sol                numeric(20,9),
			low_balance        boolean NOT NULL DEFAULT false,
			threshold_usdc     numeric(20,6),
			usdc_delta         numeric(20,6),
			spend_rate_usdc_hr numeric(20,6),
			source             text
		)
	`;
	await sql`CREATE INDEX IF NOT EXISTS agent_wallet_balance_log_ts ON agent_wallet_balance_log (ts DESC)`;
	_schemaReady = true;
}

// Most-recent prior sample, for delta + spend-rate derivation. Returns null on
// first run or any DB hiccup (the monitor still records the current sample).
async function previousSample(sql) {
	try {
		const [row] = await sql`
			SELECT usdc, extract(epoch FROM ts) AS ts_epoch
			FROM agent_wallet_balance_log
			WHERE configured = true AND usdc IS NOT NULL
			ORDER BY ts DESC
			LIMIT 1
		`;
		if (!row) return null;
		return { usdc: Number(row.usdc), tsEpoch: Number(row.ts_epoch) };
	} catch (err) {
		if (!/does not exist/i.test(err?.message || '')) {
			log.warn('balance_prev_sample_failed', { message: err?.message });
		}
		return null;
	}
}

// Persist the alert/latest state to Redis for cheap, DB-free consumer reads.
async function writeRedisState(redis, sample) {
	if (!redis) return;
	try {
		await redis.set(REDIS_LATEST_KEY, JSON.stringify(sample), { ex: ALERT_TTL_SECONDS });
		if (sample.low_balance) {
			await redis.set(REDIS_ALERT_KEY, JSON.stringify({
				usdc: sample.usdc,
				threshold: sample.threshold_usdc,
				address: sample.address,
				ts: sample.ts,
			}), { ex: ALERT_TTL_SECONDS });
		} else {
			// Cleared — wallet is healthy again, drop any lingering alert flag.
			await redis.del(REDIS_ALERT_KEY);
		}
	} catch (err) {
		log.warn('balance_redis_write_failed', { message: err?.message });
	}
}

// Read a wallet's live SOL balance (lamports) — null on any RPC failure so a
// transient RPC hiccup never fabricates a false breach.
async function readSol(conn, ownerB58) {
	try {
		return await conn.getBalance(new (await pk())(ownerB58), 'confirmed');
	} catch {
		return null;
	}
}

// Read a wallet's live USDC balance (atomic) — null on RPC failure, 0 when the
// ATA does not exist yet (a real "empty" state, not an error).
async function readUsdc(conn, ownerB58) {
	if (!USDC_MINT) return null;
	try {
		const spl = await import('@solana/spl-token');
		const PublicKey = await pk();
		const ata = spl.getAssociatedTokenAddressSync(
			new PublicKey(USDC_MINT), new PublicKey(ownerB58), false,
			spl.TOKEN_PROGRAM_ID, spl.ASSOCIATED_TOKEN_PROGRAM_ID,
		);
		try {
			return Number((await spl.getAccount(conn, ata)).amount);
		} catch {
			return 0; // no ATA = zero USDC, a real balance
		}
	} catch {
		return null; // spl-token unavailable — USDC unknown, don't fabricate a breach
	}
}

let _PublicKey = null;
async function pk() {
	if (!_PublicKey) ({ PublicKey: _PublicKey } = await import('@solana/web3.js'));
	return _PublicKey;
}

// Resolve the three ring wallet addresses from env, exactly as production does:
// treasury = X402_PAY_TO_SOLANA, sponsor = X402_FEE_PAYER_SOLANA, payer = the
// seed keypair's pubkey (loadSeedKeypair). Any role whose env is unset is
// reported as unconfigured, never guessed.
function resolveRingAddresses() {
	let payer = null;
	try {
		payer = loadSeedKeypair().publicKey.toBase58();
	} catch { /* payer key not configured in this env */ }
	return {
		payer,
		treasury: env.X402_PAY_TO_SOLANA || null,
		sponsor: env.X402_FEE_PAYER_SOLANA || null,
	};
}

/**
 * Check the three ring wallets against their role-appropriate floors and raise
 * an ops alert on any breach. Reads balances live on-chain (no funds moved).
 * Best-effort: an unresolved address or dead RPC is reported, never thrown.
 *
 * The floor math lives in ring-floors.js (pure, dependency-free) so it can be
 * unit-tested without a chain. Here we resolve addresses, read balances, hand
 * them to the evaluator, and fire alerts on breach.
 *
 * @param {object} ctx — all optional:
 *   { redis }         cheap-read snapshot sink
 *   { readBalance }   async (address) => { lamports, usdcAtomic } — override the
 *                     on-chain reader (used by tests to avoid RPC + spl-token)
 *   { sendAlert }     override sendOpsAlert (tests assert on it)
 *   { sql }           override the SQL client the burn measurement reads
 *   { measureBurn }   override the burn measurement entirely (tests, dry runs)
 * @returns {Promise<{ configured: boolean, wallets: object[], breaches: string[],
 *   sponsorRunway: import('./sponsor-runway.js').SponsorRunway|null }>}
 */
export async function checkRingWallets(ctx = {}) {
	const redis = ctx.redis || null;
	const sendAlert = ctx.sendAlert || sendOpsAlert;
	const addrs = resolveRingAddresses();
	const anyConfigured = Boolean(addrs.payer || addrs.treasury || addrs.sponsor);
	if (!anyConfigured) {
		return { configured: false, wallets: [], breaches: [], sponsorRunway: null };
	}

	// On-chain balance reader — injectable for tests. Reads SOL always and USDC
	// only for the roles that watch it (payer float, treasury for the dashboard).
	let conn = null;
	const readBalance = ctx.readBalance || (async (address, watchUsdc) => {
		if (!conn) conn = solanaConnection({ url: env.SOLANA_RPC_URL, commitment: 'confirmed' });
		return {
			lamports: await readSol(conn, address),
			usdcAtomic: watchUsdc ? await readUsdc(conn, address) : null,
		};
	});

	const selfPay = String(process.env.X402_RING_SELF_PAY || env.X402_RING_SELF_PAY || '').toLowerCase() === 'true';
	const specs = ringFloorSpecs({
		solFloorLamports: RING_SOL_FLOOR_LAMPORTS,
		payerUsdcFloorAtomic: RING_PAYER_USDC_FLOOR_ATOMIC,
		selfPay,
	});
	const addrFor = { sponsor: addrs.sponsor, payer: addrs.payer, treasury: addrs.treasury };

	const wallets = [];
	const breaches = [];
	for (const spec of specs) {
		const address = addrFor[spec.role] || null;
		if (!address) {
			wallets.push({ role: spec.role, address: null, configured: false });
			continue;
		}
		let lamports = null;
		let usdcAtomic = null;
		try {
			({ lamports, usdcAtomic } = await readBalance(address, spec.watchUsdc));
		} catch (err) {
			log.warn('ring_balance_read_failed', { role: spec.role, message: err?.message });
		}
		const entry = evaluateRingWallet(spec, address, lamports, usdcAtomic);
		wallets.push(entry);

		if (entry.sol_low) {
			breaches.push(`${spec.role} SOL ${entry.sol.toFixed(4)} < floor ${entry.sol_floor.toFixed(4)}`);
			await sendAlert(
				`⛽ x402 ring ${spec.role} low on SOL`,
				`${spec.role} ${address} holds ${entry.sol.toFixed(4)} SOL, below the ${entry.sol_floor.toFixed(4)} SOL floor. ` +
					`Below the facilitator's ${(SPONSOR_SOL_FLOOR_LAMPORTS / LAMPORTS_PER_SOL).toFixed(4)} SOL hard floor settlement is refused and the ring halts. ` +
					`The economy master's treasury-topup cron refills registry signers automatically; fund it or the ${spec.role} directly.`,
				{ signature: `x402-ring-sol-low:${address}` },
			);
		}
		if (entry.usdc_low) {
			breaches.push(`${spec.role} USDC ${entry.usdc.toFixed(2)} < floor ${entry.usdc_floor.toFixed(2)}`);
			await sendAlert(
				`💵 x402 ring ${spec.role} low on USDC float`,
				`${spec.role} ${address} holds $${entry.usdc.toFixed(2)} USDC, below the $${entry.usdc_floor.toFixed(2)} float floor. ` +
					`The daily volume cap can no longer be fully funded — top up the payer's USDC float.`,
				{ signature: `x402-ring-usdc-low:${address}` },
			);
		}
	}

	// ── Sponsor RUNWAY ────────────────────────────────────────────────────────
	// The floor check above answers "is the fee wallet dead yet?". This answers
	// "how long until it is", which is the only version of the question anyone can
	// act on. Burn is measured from the settle ledger every run (see
	// sponsor-runway.js for why a remembered constant is not acceptable here), and
	// the runway is taken to the FACILITATOR hard floor rather than the ring's 1.5x
	// watch floor, because the hard floor is where settling actually stops.
	const sponsorEntry = wallets.find((w) => w.role === 'sponsor' && w.configured) || null;
	let sponsorRunway = null;
	if (sponsorEntry) {
		const sql = ctx.sql || (await import('../db.js')).sql;
		const burn = ctx.measureBurn
			? await ctx.measureBurn({ windowDays: SPONSOR_BURN_WINDOW_DAYS })
			: await measureSponsorBurn(sql, { windowDays: SPONSOR_BURN_WINDOW_DAYS });
		sponsorRunway = computeSponsorRunway({
			address: sponsorEntry.address,
			sol: sponsorEntry.sol,
			floorSol: SPONSOR_SOL_FLOOR_LAMPORTS / LAMPORTS_PER_SOL,
			burnSolPerDay: burn.burn_sol_per_day,
			settles: burn.settles,
			windowDays: burn.window_days,
			alertDays: SPONSOR_RUNWAY_ALERT_DAYS,
		});
		if (sponsorRunway.should_alert) {
			const a = formatSponsorRunwayAlert(sponsorRunway);
			await sendAlert(a.title, a.detail, { signature: a.signature, severity: a.severity });
		}
		log.info('x402_sponsor_runway', {
			status: sponsorRunway.status,
			sol: sponsorRunway.sol,
			burn_sol_per_day: sponsorRunway.burn_sol_per_day,
			runway_days_to_floor: sponsorRunway.runway_days_to_floor,
			window_days: sponsorRunway.burn_window_days,
		});
	}

	// Cheap consumer snapshot (dashboard / health) — mirrors the seed-wallet key.
	if (redis) {
		try {
			await redis.set(REDIS_RING_KEY, JSON.stringify({
				ts: new Date().toISOString(), wallets, breaches, sponsor_runway: sponsorRunway,
			}), { ex: ALERT_TTL_SECONDS });
		} catch (err) {
			log.warn('ring_balance_redis_write_failed', { message: err?.message });
		}
	}

	if (breaches.length) {
		log.warn('x402_ring_wallet_breach', { breaches });
	} else {
		log.info('x402_ring_wallets_ok', {
			wallets: wallets.filter((w) => w.configured).map((w) => `${w.role}:${w.sol?.toFixed?.(3) ?? '?'}SOL/$${w.usdc?.toFixed?.(2) ?? '?'}`).join(' '),
		});
	}

	return { configured: true, wallets, breaches, sponsorRunway };
}

/**
 * Run the wallet balance monitor. Conforms to the run()-style registry contract.
 *
 * @param {object} ctx — supplied by the autonomous loop:
 *   { origin, redis, sql, log, runId }. All optional for standalone/manual runs.
 * @returns the aggregate outcome the loop records to x402_autonomous_log:
 *   { success, amountAtomic, txSig, responseData, signalData, errorMsg, note }
 */
export async function run(ctx = {}) {
	const runId = ctx.runId || randomUUID();
	const origin = ctx.origin || env.APP_ORIGIN || 'https://three.ws';
	const sql = ctx.sql || defaultSql;
	const redis = ctx.redis || null;
	const endpointUrl = `${origin}/api/x402-pay?balance=1`;

	// Schema first: without the sink there's no time-series to write.
	try {
		await ensureSchema(sql);
	} catch (err) {
		log.warn('balance_schema_failed', { message: err?.message });
		return { success: false, amountAtomic: 0, txSig: null, skipped: true, errorMsg: `schema_failed: ${err?.message}` };
	}

	// ── Read the live balance (free GET — no 402, no payment) ─────────────────
	let body;
	try {
		const res = await fetchWithTimeout(endpointUrl, {
			method: 'GET',
			headers: { 'user-agent': 'threews-x402-wallet-monitor/1.0' },
		});
		if (!res.ok) {
			const errorMsg = `balance_http_${res.status}`;
			log.warn('balance_read_non_ok', { status: res.status });
			return {
				success: false, amountAtomic: 0, txSig: null,
				responseData: { status: res.status }, errorMsg, note: errorMsg,
			};
		}
		body = res.body;
	} catch (err) {
		// Network failure / timeout — never crash the loop.
		const errorMsg = `balance_fetch_failed: ${err?.message || 'network'}`;
		log.warn('balance_fetch_failed', { message: err?.message });
		return { success: false, amountAtomic: 0, txSig: null, errorMsg, note: 'fetch_failed' };
	}

	const configured = body?.configured === true;
	const address = body?.address || null;
	const usdc = configured ? Number(body?.usdc ?? 0) : null;
	const sol = configured ? Number(body?.sol ?? 0) : null;
	const lowBalance = configured && Number.isFinite(usdc) && usdc < ALERT_THRESHOLD_USDC;

	// ── Derive spend rate vs the previous sample ──────────────────────────────
	let usdcDelta = null;
	let spendRateUsdcHr = null;
	if (configured && Number.isFinite(usdc)) {
		const prev = await previousSample(sql);
		if (prev && Number.isFinite(prev.usdc)) {
			usdcDelta = usdc - prev.usdc; // negative = spent since last sample
			const hours = (Date.now() / 1000 - prev.tsEpoch) / 3600;
			if (hours > 0) {
				// Positive burn rate = USDC leaving the wallet per hour.
				spendRateUsdcHr = -usdcDelta / hours;
			}
		}
	}

	// ── Persist the time-series sample ────────────────────────────────────────
	try {
		await sql`
			INSERT INTO agent_wallet_balance_log
				(ts, run_id, address, configured, usdc, sol,
				 low_balance, threshold_usdc, usdc_delta, spend_rate_usdc_hr, source)
			VALUES
				(now(), ${runId}, ${address}, ${configured}, ${usdc}, ${sol},
				 ${lowBalance}, ${ALERT_THRESHOLD_USDC}, ${usdcDelta}, ${spendRateUsdcHr}, ${endpointUrl})
		`;
	} catch (err) {
		// DB failure on the sink is logged but must not crash the loop; the call
		// itself succeeded, so report the read result with a recording note.
		log.warn('balance_insert_failed', { message: err?.message });
	}

	// ── Publish alert/latest state for cheap consumer reads ───────────────────
	const sample = {
		ts: new Date().toISOString(),
		address,
		configured,
		usdc,
		sol,
		low_balance: lowBalance,
		threshold_usdc: ALERT_THRESHOLD_USDC,
		usdc_delta: usdcDelta,
		spend_rate_usdc_hr: spendRateUsdcHr,
	};
	await writeRedisState(redis, sample);

	// ── Ring wallets (payer / treasury / sponsor) — role-floor breach alerts ──
	// Independent of the seed-wallet reading above: these are the closed-loop
	// ring's own wallets, watched on-chain against their role floors so the loop
	// never halts on a drained sponsor or an empty payer float. Never throws.
	let ring = { configured: false, wallets: [], breaches: [], sponsorRunway: null };
	try {
		ring = await checkRingWallets({ redis, sql });
	} catch (err) {
		log.warn('ring_balance_check_failed', { message: err?.message });
	}

	if (lowBalance) {
		log.warn('agent_wallet_low_balance', {
			run_id: runId, address, usdc, threshold: ALERT_THRESHOLD_USDC,
			spend_rate_usdc_hr: spendRateUsdcHr,
		});
	} else if (!configured) {
		log.info('agent_wallet_unconfigured', { run_id: runId });
	} else {
		log.info('agent_wallet_balance_ok', {
			run_id: runId, usdc, sol, spend_rate_usdc_hr: spendRateUsdcHr,
		});
	}

	const signalData = {
		configured,
		address,
		usdc,
		sol,
		low_balance: lowBalance,
		threshold_usdc: ALERT_THRESHOLD_USDC,
		usdc_delta: usdcDelta,
		spend_rate_usdc_hr: spendRateUsdcHr,
		ring: ring.configured ? { wallets: ring.wallets, breaches: ring.breaches } : null,
	};

	const ringNote = ring.configured
		? ` ring:${ring.breaches.length ? `BREACH(${ring.breaches.length})` : 'ok'}`
		: '';

	return {
		// success = we obtained a live, usable reading from a configured wallet.
		// An unconfigured wallet is a real, recorded state (not a crash) but not a
		// healthy reading — surface it as not-success so health can flag it.
		success: configured,
		amountAtomic: 0,
		txSig: null,
		responseData: { configured, address, usdc, sol, ring },
		signalData,
		errorMsg: configured ? null : (body?.code || 'wallet_unconfigured'),
		note: (configured
			? `usdc=${usdc?.toFixed?.(4) ?? usdc} sol=${sol?.toFixed?.(4) ?? sol}${lowBalance ? ' LOW_BALANCE' : ''}`
			: 'wallet_unconfigured') + ringNote,
	};
}

export const WALLET_BALANCE = Object.freeze({
	endpoint: '/api/x402-pay?balance=1',
	alertThresholdUsdc: ALERT_THRESHOLD_USDC,
	redisLatestKey: REDIS_LATEST_KEY,
	redisAlertKey: REDIS_ALERT_KEY,
	// Ring-wallet floors (role-appropriate). Treasury is intentionally absent —
	// it fills from payments and is swept back, so it has no floor.
	ring: {
		redisKey: REDIS_RING_KEY,
		solFloorLamports: RING_SOL_FLOOR_LAMPORTS,
		payerUsdcFloorAtomic: RING_PAYER_USDC_FLOOR_ATOMIC,
		sponsorHardFloorLamports: SPONSOR_SOL_FLOOR_LAMPORTS,
	},
});
