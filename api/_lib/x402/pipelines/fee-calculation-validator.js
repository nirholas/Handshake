// api/_lib/x402/pipelines/fee-calculation-validator.js
//
// Fee Calculation Validator — autonomous pipeline (self/028).
//
// USDC is a 6-decimal asset: every x402 price the platform quotes is an integer
// number of atomic units, and every price it DISPLAYS is that integer divided by
// 1_000_000. The conversion both ways is the platform's single most safety-
// critical bit of arithmetic — an off-by-one or a float-rounding slip in
// atomic↔decimal means buyers get over- or under-charged on every paid call.
//
// This validator exercises the REAL production conversion functions
// (usdcToAtomics / atomicsToUsdc in api/_lib/agent-paid-services.js, the same
// ones every paid endpoint and the monetize_endpoint tool use to build their 402
// challenge amount and render prices) at the boundary atomics where rounding bugs
// hide: 1 ($0.000001 — the minimum), 999 / 1000 / 1001 (the milli-dollar tier
// edge), and 999999 (just under $1). For each boundary it asserts two things:
//
//   1. RENDER — atomicsToUsdc(B).toFixed(6) equals the BigInt ground-truth
//      decimal string (integer math, no float). Catches precision drift.
//   2. ROUND-TRIP — usdcToAtomics(that decimal) returns exactly B. Catches the
//      off-by-one class (e.g. a Math.floor regression that drops a unit).
//
// Then it makes ONE real on-chain payment: the $0.001 dance-tip endpoint quotes
// exactly 1000 atomics (priceFor('dance-tip')), which IS one of the boundaries,
// so a live probe→pay→settle proves the deployed quote and the settled amount
// agree with the local fee math end-to-end (deploy/env skew a same-process unit
// test can't see). Real USDC from the seed wallet, never mocked.
//
// Tables:
//   fee_calculation_audit  — one row per boundary per run. Columns receiving the
//                            extracted value: boundary_atomic, expected_decimal,
//                            rendered_decimal, round_trip_atomic, mismatch, kind,
//                            tx_signature, error.
//   x402_autonomous_log    — one summary row per run; value_extracted carries
//                            { boundaries, mismatch_count, mismatched,
//                              live_quoted_atomic, live_settled_atomic,
//                              live_consistent }.
//
// Downstream consumer: fee_calculation_audit is the fee-integrity audit trail.
// Ops gates deploys on it alongside cosmetic_pricing_audit (self/020) — a
// `mismatch=true` row is the signal that an atomic↔decimal change would mis-bill
// buyers and must be held. The latest per-boundary state answers "does the
// deployed fee math still convert every tier exactly".

import { randomUUID } from 'node:crypto';

import { sql } from '../../db.js';
import { env } from '../../env.js';
import { logger } from '../../usage.js';
import { usdcToAtomics, atomicsToUsdc } from '../../agent-paid-services.js';
import { priceFor } from '../../x402-prices.js';
import {
	loadSeedKeypair,
	bootstrapSolanaContext,
	payX402,
	fetchWithTimeout,
	parseSolanaAccept,
	USDC_MINT,
} from '../pay.js';

const log = logger('x402-fee-calculation-validator');

// Boundary atomics where atomic↔decimal rounding bugs surface (USDC, 6 decimals):
//   1       — the $0.000001 minimum (one atomic)
//   999     — just below the milli-dollar tier
//   1000    — exactly $0.001 (the dance-tip live-payment boundary)
//   1001    — just above the milli-dollar tier
//   999999  — just below $1.00
const BOUNDARY_ATOMICS = [1, 999, 1000, 1001, 999999];

// The live boundary we actually settle on-chain. dance-tip quotes exactly $0.001
// (1000 atomics) via priceFor — one of the boundaries above — so a real payment
// closes the loop on the deployed quote vs. the local fee math.
// dance-tip is declared GET (paidEndpoint({ method: 'GET' }) in api/x402/dance-tip.js)
// and reads its selection from QUERY params. A credential-less request on any
// method still gets the 402 challenge, so the free quote probe worked either way,
// but the PAID replay on the wrong method is answered with a strict 405: the
// validator's live settle leg had never once landed. Both legs ride GET now.
const LIVE_QUERY = 'dancer=1&dance=hiphop';
const LIVE_ROUTE = `/api/x402/dance-tip?${LIVE_QUERY}`;
const LIVE_METHOD = 'GET';
const LIVE_EXPECTED_ATOMIC = Number(priceFor('dance-tip', '1000'));

const MINT = () => USDC_MINT || env.X402_ASSET_MINT_SOLANA || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// BigInt ground-truth: integer atomic → fixed 6-decimal string, no float anywhere.
// 1 → "0.000001", 1000 → "0.001000", 999999 → "0.999999", 1000000 → "1.000000".
// This is the reference the float-based platform render is checked against.
export function atomicToDecimalString(atomic) {
	const n = BigInt(atomic);
	const whole = n / 1_000_000n;
	const frac = n % 1_000_000n;
	return `${whole}.${frac.toString().padStart(6, '0')}`;
}

// Validate one boundary atomic through the real production conversion functions.
// Pure — no I/O, never throws (a thrown usdcToAtomics is captured as the error).
export function validateBoundary(atomic) {
	const expectedDecimal = atomicToDecimalString(atomic);

	// 1) RENDER: the platform's atomic→decimal path must format to the ground truth.
	let renderedDecimal = null;
	let renderOk = false;
	try {
		renderedDecimal = atomicsToUsdc(atomic).toFixed(6);
		renderOk = renderedDecimal === expectedDecimal;
	} catch (err) {
		return {
			boundaryAtomic: atomic,
			expectedDecimal,
			renderedDecimal,
			roundTripAtomic: null,
			mismatch: true,
			error: `render_threw: ${err?.message || 'error'}`,
		};
	}

	// 2) ROUND-TRIP: decimal→atomic must land back exactly on the boundary.
	let roundTripAtomic = null;
	let roundTripOk = false;
	let error = null;
	try {
		roundTripAtomic = Number(usdcToAtomics(expectedDecimal));
		roundTripOk = roundTripAtomic === atomic;
	} catch (err) {
		error = `round_trip_threw: ${err?.message || 'error'}`;
	}

	const mismatch = !renderOk || !roundTripOk;
	if (mismatch && !error) {
		error = !renderOk
			? `render_mismatch: got ${renderedDecimal} want ${expectedDecimal}`
			: `round_trip_mismatch: got ${roundTripAtomic} want ${atomic}`;
	}

	return { boundaryAtomic: atomic, expectedDecimal, renderedDecimal, roundTripAtomic, mismatch, error };
}

async function ensureSchema() {
	await sql`
		CREATE TABLE IF NOT EXISTS fee_calculation_audit (
			id                bigserial PRIMARY KEY,
			run_id            uuid NOT NULL,
			ts                timestamptz DEFAULT now(),
			boundary_atomic   bigint NOT NULL,
			expected_decimal  text NOT NULL,
			rendered_decimal  text,
			round_trip_atomic bigint,
			mismatch          boolean NOT NULL DEFAULT false,
			kind              text NOT NULL DEFAULT 'math',
			tx_signature      text,
			error             text
		)
	`;
	await sql`CREATE INDEX IF NOT EXISTS fee_calculation_audit_boundary_ts ON fee_calculation_audit (boundary_atomic, ts DESC)`;
	await sql`CREATE INDEX IF NOT EXISTS fee_calculation_audit_mismatch ON fee_calculation_audit (mismatch) WHERE mismatch`;
	// x402_autonomous_log predates value_extracted; add it idempotently (mirrors
	// the cosmetic-pricing-audit + bazaar-warmup pipelines so they share one column).
	await sql`ALTER TABLE x402_autonomous_log ADD COLUMN IF NOT EXISTS value_extracted jsonb`;
}

async function recordAuditRow(runId, row) {
	try {
		await sql`
			INSERT INTO fee_calculation_audit
				(run_id, boundary_atomic, expected_decimal, rendered_decimal,
				 round_trip_atomic, mismatch, kind, tx_signature, error)
			VALUES
				(${runId}, ${row.boundaryAtomic}, ${row.expectedDecimal},
				 ${row.renderedDecimal ?? null}, ${row.roundTripAtomic ?? null},
				 ${!!row.mismatch}, ${row.kind || 'math'}, ${row.txSig || null},
				 ${row.error || null})
		`;
	} catch (err) {
		log.warn('fee_calculation_audit_insert_failed', { boundary: row.boundaryAtomic, message: err?.message });
	}
}

async function recordSummary(runId, { amountAtomic, txSig, responseData, durationMs, success, errorMsg, valueExtracted }) {
	try {
		await sql`
			INSERT INTO x402_autonomous_log
				(run_id, endpoint_type, service_name, endpoint_url,
				 network, amount_atomic, asset, tx_signature,
				 response_data, value_extracted, duration_ms, success, error_msg, pipeline)
			VALUES
				(${runId}, ${'self'}, ${'Fee Calculation Validator'}, ${LIVE_ROUTE},
				 ${'solana:mainnet'}, ${amountAtomic || 0}, ${MINT()}, ${txSig || null},
				 ${responseData ? JSON.stringify(responseData) : null},
				 ${valueExtracted ? JSON.stringify(valueExtracted) : null},
				 ${durationMs || 0}, ${success}, ${errorMsg || null}, ${'finance'})
		`;
	} catch (err) {
		log.warn('fee_calculation_summary_failed', { run_id: runId, message: err?.message });
	}
}

// Free probe of the live endpoint's 402 challenge — reads the advertised atomic
// amount without paying. Never throws: a fault returns a null quote + reason.
async function probeLiveQuote(origin) {
	const url = `${origin}${LIVE_ROUTE}`;
	try {
		const res = await fetchWithTimeout(url, {
			method: LIVE_METHOD,
			headers: { 'content-type': 'application/json', 'user-agent': 'threews-x402-autonomous/1.0' },
		});
		if (res.status !== 402) {
			return { quotedAtomic: null, error: `unexpected_status_${res.status}` };
		}
		const accept = parseSolanaAccept(res.body);
		if (!accept) return { quotedAtomic: null, error: 'no_solana_accept' };
		const quoted = Number(accept.amount || 0);
		if (!Number.isFinite(quoted) || quoted <= 0) {
			return { quotedAtomic: null, error: `bad_quote:${accept.amount}` };
		}
		return { quotedAtomic: quoted, error: null };
	} catch (err) {
		return { quotedAtomic: null, error: err?.message || 'probe_failed' };
	}
}

/**
 * Run the fee-calculation audit. Self-contained: builds its own Solana payment
 * context when one isn't supplied, so it works both inside the per-tick
 * autonomous loop (handed shared blockhash + keypair) and as a direct manual test.
 *
 * @param {object} [ctx]
 * @param {string} [ctx.runId]              correlation id (defaults to fresh uuid)
 * @param {string} [ctx.origin]             base origin for the live endpoint
 * @param {import('@solana/web3.js').Keypair} [ctx.buyer] seed keypair (loaded if absent)
 * @param {object} [ctx.conn]               Solana connection (created if absent)
 * @param {string} [ctx.blockhash]          recent blockhash (fetched if absent)
 * @param {object} [ctx.mintInfo]           USDC mint info (fetched if absent)
 * @param {number} [ctx.remainingCap]       spend ceiling for this run (atomics)
 */
// The live boundary leg's HTTP shape, exported so the registry shape guard can
// assert it against ring-catalog.js (the source of truth for every paid route's
// method + query form). A pipeline that drifts off its endpoint's method pays for
// a 405 instead of a settlement.
export const FEE_VALIDATOR_PROBE = Object.freeze({ path: LIVE_ROUTE, method: LIVE_METHOD });

export async function run(ctx = {}) {
	const t0 = Date.now();
	const runId = ctx.runId || randomUUID();
	const origin = ctx.origin || env.APP_ORIGIN || 'https://three.ws';
	const remainingCap = ctx.remainingCap ?? Number.POSITIVE_INFINITY;

	// Schema is the only durable sink — without it there's nothing to record to.
	try {
		await ensureSchema();
	} catch (err) {
		log.warn('fee_calculation_schema_failed', { message: err?.message });
		return {
			success: false, skipped: true, amountAtomic: 0, txSig: null,
			errorMsg: `schema_failed: ${err?.message}`, note: 'schema unavailable',
		};
	}

	// ── 1) Pure fee-math sweep over the boundaries (free, always runs) ──────────
	const findings = BOUNDARY_ATOMICS.map(validateBoundary);

	// ── 2) Live probe: read the deployed dance-tip quote (free) ────────────────
	const { quotedAtomic, error: probeError } = await probeLiveQuote(origin);
	// The deployed quote is itself a boundary check at 1000 atomics: it must equal
	// the local fee math's expected amount AND render to the ground-truth decimal.
	let liveQuoteMismatch = false;
	let liveQuoteError = probeError;
	if (quotedAtomic != null) {
		const expectedDecimal = atomicToDecimalString(quotedAtomic);
		const renderOk = atomicsToUsdc(quotedAtomic).toFixed(6) === expectedDecimal;
		const matchesExpected = quotedAtomic === LIVE_EXPECTED_ATOMIC;
		liveQuoteMismatch = !renderOk || !matchesExpected;
		if (liveQuoteMismatch && !liveQuoteError) {
			liveQuoteError = matchesExpected
				? `render_mismatch: ${quotedAtomic}`
				: `deploy_skew: quoted ${quotedAtomic} want ${LIVE_EXPECTED_ATOMIC}`;
		}
	}

	// ── 3) One real on-chain payment at the 1000-atomic boundary ────────────────
	let buyer = ctx.buyer;
	let walletReason = null;
	if (!buyer) {
		try { buyer = loadSeedKeypair(); } catch (err) { walletReason = err.message; }
	}

	let settledAtomic = null;
	let liveSettleError = null;
	let txSig = null;
	let spentAtomic = 0;
	let payResponse = null;

	if (buyer && quotedAtomic != null && remainingCap >= quotedAtomic) {
		try {
			let { conn, blockhash, mintInfo } = ctx;
			if (!conn || !blockhash || !mintInfo) {
				const boot = await bootstrapSolanaContext({ buyer });
				conn = conn || boot.conn;
				blockhash = blockhash || boot.blockhash;
				mintInfo = mintInfo || boot.mintInfo;
			}
			const r = await payX402({
				url: `${origin}${LIVE_ROUTE}`,
				method: LIVE_METHOD,
				body: null,
				buyer, conn, blockhash, mintInfo,
				remainingCap,
				userAgent: 'threews-x402-fee-validator/1.0',
			});
			payResponse = r.responseBody || null;
			if (r.paid) {
				settledAtomic = r.amountAtomic || 0;
				txSig = r.txSig || null;
				spentAtomic = settledAtomic;
				// The settled amount MUST equal the advertised quote, else the fee
				// charged on-chain drifts from what the buyer was quoted.
				if (settledAtomic !== quotedAtomic) {
					liveSettleError = `settle_drift: settled ${settledAtomic} quoted ${quotedAtomic}`;
				}
			} else {
				liveSettleError = r.errorMsg || `settle_status_${r.status || 0}`;
			}
		} catch (err) {
			liveSettleError = err?.message || 'pay_failed';
		}
	} else if (!buyer) {
		log.info('fee_calculation_no_wallet', { reason: walletReason });
	} else if (quotedAtomic != null && remainingCap < quotedAtomic) {
		liveSettleError = 'cap_would_exceed';
	}

	const liveSettleMismatch = settledAtomic != null && settledAtomic !== quotedAtomic;

	// ── 4) Persist per-boundary findings (math sweep + the live boundary) ──────
	for (const f of findings) {
		await recordAuditRow(runId, { ...f, kind: 'math' });
	}
	// The live boundary lands as its own row: expected/rendered from the deployed
	// quote, round_trip_atomic = settled amount, tx = on-chain signature.
	if (quotedAtomic != null || probeError) {
		await recordAuditRow(runId, {
			boundaryAtomic: quotedAtomic ?? LIVE_EXPECTED_ATOMIC,
			expectedDecimal: atomicToDecimalString(LIVE_EXPECTED_ATOMIC),
			renderedDecimal: quotedAtomic != null ? atomicsToUsdc(quotedAtomic).toFixed(6) : null,
			roundTripAtomic: settledAtomic,
			mismatch: liveQuoteMismatch || liveSettleMismatch,
			kind: 'live',
			txSig,
			error: liveSettleError || liveQuoteError,
		});
	}

	// ── 5) Summary row in x402_autonomous_log (always, success or skip) ────────
	const mathMismatches = findings.filter((f) => f.mismatch);
	const mismatchCount = mathMismatches.length + (liveQuoteMismatch || liveSettleMismatch ? 1 : 0);
	const liveConsistent = quotedAtomic != null && !liveQuoteMismatch
		? (settledAtomic != null ? settledAtomic === quotedAtomic : null)
		: false;

	const valueExtracted = {
		boundaries: findings.length,
		mismatch_count: mismatchCount,
		mismatched: mathMismatches.map((f) => ({ atomic: f.boundaryAtomic, error: f.error })),
		live_quoted_atomic: quotedAtomic,
		live_expected_atomic: LIVE_EXPECTED_ATOMIC,
		live_settled_atomic: settledAtomic,
		live_consistent: liveConsistent,
		live_error: liveSettleError || liveQuoteError || null,
	};

	// success = all boundary math holds AND (no payment attempted OR it settled at
	// the quoted amount). A wallet that's simply unconfigured is not a failure —
	// the deterministic math sweep is the primary signal and it still ran.
	const mathOk = mathMismatches.length === 0 && !liveQuoteMismatch;
	const settleOk = settledAtomic == null ? true : !liveSettleMismatch;
	const success = mathOk && settleOk && !probeError;
	const errorMsg = mismatchCount > 0
		? `fee_mismatch:${mismatchCount}`
		: (probeError ? `probe:${probeError}` : (walletReason ? `wallet_unconfigured: ${walletReason}` : liveSettleError));

	await recordSummary(runId, {
		amountAtomic: spentAtomic,
		txSig,
		responseData: { quoted_atomic: quotedAtomic, settled_atomic: settledAtomic, live_response: payResponse },
		durationMs: Date.now() - t0,
		success,
		errorMsg,
		valueExtracted,
	});

	if (mismatchCount > 0) {
		log.warn('fee_calculation_mismatch', { run_id: runId, count: mismatchCount, mismatched: valueExtracted.mismatched });
	}
	log.info('fee_calculation_complete', {
		run_id: runId,
		boundaries: findings.length,
		mismatch: mismatchCount,
		live_quoted: quotedAtomic,
		live_settled: settledAtomic,
		spent_usdc: (spentAtomic / 1e6).toFixed(6),
	});

	return {
		success,
		amountAtomic: spentAtomic,
		txSig,
		network: 'solana:mainnet',
		responseData: valueExtracted,
		signalData: { mismatch_count: mismatchCount, live_consistent: liveConsistent },
		errorMsg,
		note: `boundaries ${findings.length}, mismatch ${mismatchCount}, live ${settledAtomic != null ? 'settled' : 'not_settled'}`,
		...(walletReason ? { skipped: true } : {}),
	};
}
