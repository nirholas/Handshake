// api/_lib/x402/pipelines/sniper-intel-enrich.js
//
// Sniper Intel Enrichment via Crypto Intel — autonomous pipeline (self/024).
//
// The most critical self-loop on the platform: the trading engine pays the
// platform's own intelligence API to make better decisions. On each run it pays
// the $0.01 USDC Crypto Intel feed (/api/x402/crypto-intel) for live market
// sentiment on the coins the sniper is actively watching — the ones it currently
// holds (open/opening positions) and the freshest high-conviction Oracle
// candidates it is about to consider — and turns the headline signal into a
// per-coin gate modifier. On each run it:
//
//   1. Selects the coins the sniper is actively watching (selectEnrichTargets):
//      open positions first (a sentiment flip on a held coin is an exit signal),
//      then recent watch-worthy Oracle coins, deduped by mint, capped per run.
//   2. Pays POST /api/x402/crypto-intel { topic: <symbol>, mint } for each via
//      the shared payX402 client: real on-chain USDC from the seed wallet,
//      never mocked. Crypto Intel prices the mint through the multi-source
//      on-chain market lib (Birdeye, DexScreener, GeckoTerminal), falling
//      back to CoinGecko/Coinbase by ticker, so pump.fun coins with a live
//      pool resolve to real data instead of always 503ing. A coin with no
//      resolvable market anywhere still makes the endpoint throw 503 BEFORE
//      settlement: the wallet is never charged for a coin we have no real
//      market read on, and nothing is written. That is the honesty guard; we
//      only ever attach a signal a real market produced.
//   3. Maps the signal (bullish / bearish / neutral) + confidence into a clamped
//      threshold delta (deriveSentiment) and upserts it into sniper_coin_sentiment
//      keyed by (mint, network). bearish raises the snipe bar, bullish lowers it.
//   4. Records a row in x402_autonomous_log for every call (success or failure)
//      with the verdict in value_extracted.
//
// Wiring: declared as a run()-style entry in autonomous-registry.js. The per-tick
// loop (api/cron/x402-autonomous-loop.js) hands run() a shared payment context
// (buyer, conn, blockhash, mintInfo, remainingCap, runId, origin); called
// standalone (manual test) it bootstraps its own via bootstrapSolanaContext().
//
// Downstream consumer: workers/agent-sniper/oracle-gate.js reads
// sniper_coin_sentiment on the pre-snipe path (coinSentimentAdjustment) and
// folds the per-coin delta into the effective min_oracle_score alongside the
// macro adjustment. Fail-open and clamped: a missing/stale signal never moves the
// bar, and the delta is bounded to ±10 points, so this layer can only ever nudge
// a snipe — never dominate or hard-veto it.

import { randomUUID } from 'node:crypto';

import { sql } from '../../db.js';
import { env } from '../../env.js';
import { logger } from '../../usage.js';
import { payX402, bootstrapSolanaContext, USDC_MINT } from '../pay.js';

const log = logger('x402-sniper-intel-enrich');

// Coins enriched per run. Each is one $0.01 USDC payment, so a full batch is
// ≤ $0.0BATCH — bounded again by the remainingCap the loop passes in and the
// loop's daily cap. Default 8 keeps a steady spend at the registry cooldown.
const BATCH_SIZE = Number(process.env.X402_SNIPER_INTEL_BATCH || 8);
// A signal is "fresh" for this many minutes — within the window we don't re-pay
// for the same coin. Markets move, so a short window keeps sentiment current.
const FRESH_MINUTES = Number(process.env.X402_SNIPER_INTEL_FRESH_MIN || 30);
// Only enrich Oracle candidates scored within this window — older coins are no
// longer live snipe candidates, so paying to read sentiment on them is waste.
const CANDIDATE_HOURS = Number(process.env.X402_SNIPER_INTEL_CANDIDATE_HOURS || 12);

const NETWORK = (process.env.SNIPER_NETWORK || 'mainnet').trim();
const ASSET = USDC_MINT || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const ENDPOINT_PATH = '/api/x402/crypto-intel';

// Tiers the sniper would actually evaluate — `avoid` coins never reach the gate,
// so spending intel on them is wasted. Mirrors the conviction tier ladder.
const WATCHED_TIERS = ['prime', 'strong', 'lean', 'watch'];

let _schemaReady = false;
async function ensureSchema() {
	if (_schemaReady) return;
	// Sentiment sink (idempotent — mirrors the migration so the pipeline is safe
	// to run before the migration is applied).
	await sql`
		CREATE TABLE IF NOT EXISTS sniper_coin_sentiment (
			mint           text NOT NULL,
			network        text NOT NULL DEFAULT 'mainnet',
			symbol         text,
			topic          text,
			signal         text,
			headline       text,
			rationale      text,
			confidence     numeric(5,4),
			price_usd      numeric(20,10),
			change_24h     numeric,
			sentiment_adj  smallint NOT NULL DEFAULT 0,
			source         text NOT NULL DEFAULT 'crypto-intel',
			tx_signature   text,
			run_id         uuid,
			checked_at     timestamptz NOT NULL DEFAULT now(),
			PRIMARY KEY (mint, network)
		)
	`;
	await sql`CREATE INDEX IF NOT EXISTS sniper_coin_sentiment_checked ON sniper_coin_sentiment (network, checked_at DESC)`;
	// The autonomous log predates the value_extracted column on some envs.
	await sql`ALTER TABLE x402_autonomous_log ADD COLUMN IF NOT EXISTS value_extracted jsonb`;
	_schemaReady = true;
}

/**
 * Pick the coins the sniper is actively watching that need a fresh sentiment
 * read. Open/opening positions first (a held coin's sentiment flip is an exit
 * signal), then recent watch-worthy Oracle candidates. Deduped by mint, capped
 * at `limit`. Returns [] if neither source table exists yet (degrade, never throw).
 */
export async function selectEnrichTargets(limit = BATCH_SIZE) {
	try {
		const rows = await sql`
			(
				SELECT p.mint, p.symbol, 0 AS src_rank, p.opened_at AS ts
				FROM agent_sniper_positions p
				LEFT JOIN sniper_coin_sentiment s
					ON s.mint = p.mint AND s.network = p.network
				WHERE p.network = ${NETWORK}
					AND p.status IN ('opening', 'open')
					AND p.symbol IS NOT NULL AND p.symbol <> ''
					AND (s.checked_at IS NULL
						OR s.checked_at < now() - make_interval(mins => ${FRESH_MINUTES}))
			)
			UNION ALL
			(
				SELECT c.mint, c.symbol, 1 AS src_rank, c.scored_at AS ts
				FROM oracle_conviction c
				LEFT JOIN sniper_coin_sentiment s
					ON s.mint = c.mint AND s.network = c.network
				WHERE c.network = ${NETWORK}
					AND c.symbol IS NOT NULL AND c.symbol <> ''
					AND c.tier = ANY(${WATCHED_TIERS})
					AND c.scored_at > now() - make_interval(hours => ${CANDIDATE_HOURS})
					AND (s.checked_at IS NULL
						OR s.checked_at < now() - make_interval(mins => ${FRESH_MINUTES}))
			)
			ORDER BY src_rank ASC, ts DESC NULLS LAST
		`;
		// Dedupe by mint (a held coin may also appear as an Oracle candidate),
		// keeping the first — positions outrank candidates by the ORDER BY above.
		const seen = new Set();
		const out = [];
		for (const r of rows) {
			if (seen.has(r.mint)) continue;
			seen.add(r.mint);
			out.push({ mint: r.mint, symbol: r.symbol, source: r.src_rank === 0 ? 'position' : 'oracle' });
			if (out.length >= limit) break;
		}
		return out;
	} catch (err) {
		if (!err?.message?.includes('does not exist')) {
			log.warn('sniper_intel_select_failed', { message: err?.message });
		}
		return [];
	}
}

/**
 * Map a crypto-intel response into a sentiment verdict + a clamped per-coin gate
 * delta (in Oracle score points). bearish raises the snipe bar; bullish lowers
 * it; neutral leaves it untouched. Asymmetric on purpose — conservative on
 * weakness, modest on strength — and mirrors the macro adjustment in the gate.
 * Returns null for a malformed/empty response.
 *
 * @param {object} body crypto-intel response
 * @returns {{ signal, confidence, headline, rationale, price_usd, change_24h, sentiment_adj } | null}
 */
export function deriveSentiment(body) {
	if (!body || typeof body !== 'object' || !body.signal) return null;
	const signal = String(body.signal).toLowerCase();
	if (!['bullish', 'bearish', 'neutral'].includes(signal)) return null;

	const confRaw = Number(body.confidence);
	const confidence = Number.isFinite(confRaw) ? Math.max(0, Math.min(1, confRaw)) : 0.5;

	let adj = 0;
	if (signal === 'bearish') adj = Math.round(8 * confidence);   // raise bar
	else if (signal === 'bullish') adj = -Math.round(4 * confidence); // lower bar
	adj = Math.max(-10, Math.min(10, adj));

	const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
	return {
		signal,
		confidence,
		headline: typeof body.headline === 'string' ? body.headline : null,
		rationale: typeof body.rationale === 'string' ? body.rationale : null,
		price_usd: num(body.price_usd),
		change_24h: num(body.change_24h),
		sentiment_adj: adj,
	};
}

async function upsertSentiment(runId, { mint, symbol, topic }, v, txSig) {
	await sql`
		INSERT INTO sniper_coin_sentiment
			(mint, network, symbol, topic, signal, headline, rationale, confidence,
			 price_usd, change_24h, sentiment_adj, source, tx_signature, run_id, checked_at)
		VALUES
			(${mint}, ${NETWORK}, ${symbol || null}, ${topic || null}, ${v.signal},
			 ${v.headline}, ${v.rationale}, ${v.confidence}, ${v.price_usd}, ${v.change_24h},
			 ${v.sentiment_adj}, ${'crypto-intel'}, ${txSig || null}, ${runId}, now())
		ON CONFLICT (mint, network) DO UPDATE SET
			symbol        = EXCLUDED.symbol,
			topic         = EXCLUDED.topic,
			signal        = EXCLUDED.signal,
			headline      = EXCLUDED.headline,
			rationale     = EXCLUDED.rationale,
			confidence    = EXCLUDED.confidence,
			price_usd     = EXCLUDED.price_usd,
			change_24h    = EXCLUDED.change_24h,
			sentiment_adj = EXCLUDED.sentiment_adj,
			source        = EXCLUDED.source,
			tx_signature  = EXCLUDED.tx_signature,
			run_id        = EXCLUDED.run_id,
			checked_at    = now()
	`;
}

// One row per enriched coin into x402_autonomous_log (the loop also records one
// aggregate summary row for the run() entry; these are the granular per-coin ones).
async function recordCall(runId, { mint, endpointUrl, amountAtomic, txSig, responseData, durationMs, success, errorMsg, valueExtracted }) {
	try {
		await sql`
			INSERT INTO x402_autonomous_log
				(run_id, endpoint_type, service_name, endpoint_url,
				 network, amount_atomic, asset, tx_signature,
				 response_data, value_extracted, duration_ms, success, error_msg, pipeline)
			VALUES
				(${runId}, ${'self'}, ${`Sniper Intel: ${mint.slice(0, 8)}…`}, ${endpointUrl},
				 ${'solana:mainnet'}, ${amountAtomic || 0}, ${ASSET}, ${txSig || null},
				 ${responseData ? JSON.stringify(responseData) : null},
				 ${valueExtracted ? JSON.stringify(valueExtracted) : null},
				 ${durationMs || 0}, ${success}, ${errorMsg || null}, ${'sniper'})
		`;
	} catch (err) {
		log.warn('sniper_intel_log_insert_failed', { mint, message: err?.message });
	}
}

/**
 * Run the sniper intel enrichment sweep. Conforms to the run()-style registry
 * contract: the loop hands over { origin, buyer, conn, blockhash, mintInfo,
 * remainingCap, runId }; standalone (manual test) it bootstraps its own Solana
 * context via bootstrapSolanaContext().
 *
 * Returns the aggregate outcome the loop records as one summary row:
 *   { success, amountAtomic, txSig, errorMsg, responseData, signalData, skipped, note }
 */
export async function run(ctx = {}) {
	const runId = ctx.runId || randomUUID();
	const origin = ctx.origin || env.APP_ORIGIN || 'https://three.ws';
	const endpointUrl = `${origin}${ENDPOINT_PATH}`;
	let remainingCap = ctx.remainingCap ?? Number.POSITIVE_INFINITY;

	// ── Schema first: without the sentiment sink there's nothing to extract, so don't pay.
	try {
		await ensureSchema();
	} catch (err) {
		log.warn('sniper_intel_schema_failed', { message: err?.message });
		return { success: false, skipped: true, amountAtomic: 0, errorMsg: `schema_failed: ${err?.message}` };
	}

	// ── Find work before touching the wallet — no watched coins → no spend.
	const targets = await selectEnrichTargets(BATCH_SIZE);
	if (targets.length === 0) {
		return { success: true, skipped: true, amountAtomic: 0, note: 'no_watched_coins' };
	}

	// ── Solana payment context: reuse the loop's, else bootstrap (graceful on an
	//    unconfigured wallet — bootstrap throws, we exit logged without paying).
	let { buyer, conn, blockhash, mintInfo } = ctx;
	if (!buyer || !conn || !blockhash || !mintInfo) {
		try {
			({ buyer, conn, blockhash, mintInfo } = await bootstrapSolanaContext({ buyer }));
		} catch (err) {
			log.info('sniper_intel_skipped', { reason: err.message });
			return { success: false, skipped: true, amountAtomic: 0, errorMsg: err.message, note: 'wallet_or_rpc_unconfigured' };
		}
	}

	let spentAtomic = 0;
	let paid = 0;
	let enriched = 0;   // sentiment rows stored
	let bearish = 0;    // coins whose read raised the bar
	let bullish = 0;    // coins whose read lowered the bar
	let noData = 0;     // 503 before settlement (no resolvable market)
	let callErrors = 0;
	let lastTxSig = null;

	// Responses are mint-specific (Crypto Intel prices the exact mint on-chain),
	// so the same-run reuse cache is keyed by mint: two coins sharing a ticker
	// must never read each other's market.
	const topicCache = new Map();

	for (let i = 0; i < targets.length; i++) {
		const { mint, symbol } = targets[i];
		if (remainingCap <= 0) {
			log.info('sniper_intel_cap_reached', { spent_atomic: spentAtomic, remaining_targets: targets.length - i });
			break;
		}

		const topic = String(symbol || '').toLowerCase().trim().slice(0, 30);
		if (!topic) continue;

		const t0 = Date.now();

		// Reuse a same-run response for a repeated mint (no second payment).
		let result = topicCache.get(mint);
		if (!result) {
			try {
				result = await payX402({
					url: endpointUrl,
					method: 'POST',
					body: { topic, mint },
					buyer, conn, blockhash, mintInfo,
					remainingCap,
					userAgent: 'threews-x402-sniper-intel/1.0',
				});
			} catch (err) {
				// Network failure / abort — log the call, never crash the sweep.
				callErrors += 1;
				await recordCall(runId, {
					mint, endpointUrl, amountAtomic: 0, txSig: null, responseData: null,
					durationMs: Date.now() - t0, success: false, errorMsg: err?.message || 'fetch_failed', valueExtracted: null,
				});
				continue;
			}
			topicCache.set(mint, result);

			if (result.paid) {
				spentAtomic += result.amountAtomic;
				remainingCap -= result.amountAtomic;
				paid += 1;
				if (result.txSig) lastTxSig = result.txSig;
			}
		}

		// Derive + persist the sentiment only when the call delivered a usable body.
		let verdict = null;
		let valueExtracted = null;
		if (result.success) {
			verdict = deriveSentiment(result.responseBody);
			if (verdict) {
				try {
					await upsertSentiment(runId, { mint, symbol, topic }, verdict, result.txSig);
					enriched += 1;
					if (verdict.sentiment_adj > 0) bearish += 1;
					else if (verdict.sentiment_adj < 0) bullish += 1;
					valueExtracted = {
						mint,
						topic,
						signal: verdict.signal,
						confidence: verdict.confidence,
						sentiment_adj: verdict.sentiment_adj,
						price_usd: verdict.price_usd,
					};
				} catch (err) {
					// Payment already settled — record the call as success but surface
					// the persistence error for observability.
					log.warn('sniper_intel_persist_failed', { mint, message: err?.message });
				}
			}
		} else {
			// crypto-intel throws 503 (data_unavailable) when no source (the
			// on-chain market lib included) has a live market for the mint, e.g. a
			// bonding-curve coin with no indexed pool yet. Un-charged, and never
			// attach a wrong signal.
			if (result.status === 503) noData += 1;
			else callErrors += 1;
		}

		await recordCall(runId, {
			mint,
			endpointUrl: `${endpointUrl} [${topic}]`,
			amountAtomic: result.paid ? result.amountAtomic : 0,
			txSig: result.txSig,
			// Keep the row compact — the verdict lives in value_extracted + sniper_coin_sentiment.
			responseData: { status: result.status, topic, code: result.responseBody?.code || null, rpc_error: result.responseBody?.error || null },
			durationMs: Date.now() - t0,
			success: result.success,
			errorMsg: result.errorMsg,
			valueExtracted,
		});
	}

	log.info('sniper_intel_complete', {
		run_id: runId,
		targets: targets.length,
		paid,
		enriched,
		bearish,
		bullish,
		no_data: noData,
		spent_usdc: (spentAtomic / 1e6).toFixed(4),
	});

	return {
		// success when the loop did its job: at least one sentiment stored, or every
		// candidate honestly had no resolvable market (no charge, nothing to enrich).
		success: enriched > 0 || (paid === 0 && noData === targets.length && targets.length > 0),
		amountAtomic: spentAtomic,
		txSig: lastTxSig,
		errorMsg: enriched === 0 && callErrors > 0 ? `sniper_intel_calls_failed:${callErrors}` : null,
		skipped: paid === 0 && enriched === 0 && noData === 0,
		responseData: { targets: targets.length, paid, enriched, bearish, bullish, no_data: noData },
		signalData: { enriched, bearish, bullish, no_data: noData },
		note: `sniper_intel targets=${targets.length} paid=${paid} enriched=${enriched} bear=${bearish} bull=${bullish} nodata=${noData}`,
	};
}
