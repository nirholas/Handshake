// api/_lib/x402/pipelines/live-feed-seeder.js
//
// Live Payment Feed Seeder — autonomous pipeline (self/025).
//
// The homepage "live payment feed" (the /pay page, the in-world jumbotron and
// the exchange NPCs) reads from GET /api/x402-pay?feed=1, which is backed ONLY
// by the Redis ring `x402:pay:feed`. That ring is populated EXCLUSIVELY by real
// /api/x402-pay demo-flow payments — nothing else writes to it. With no organic
// demo traffic the feed goes stale and a first-time visitor sees a dead system.
//
// This pipeline keeps that feed alive: on each run it makes ONE real, on-chain
// $0.001 USDC demo payment through /api/x402-pay (the platform-wallet demo flow,
// signed by X402_AGENT_SOLANA_SECRET_BASE58 server-side), rotating across a set
// of MCP tools so the feed shows a variety of recent agent-to-agent activity
// (avatar searches, model inspections, validations, optimizations, capability
// discovery) rather than the same call repeated.
//
// Two sinks, both real:
//   1. The /api/x402-pay call itself pushes the receipt onto `x402:pay:feed`
//      (the hot path the homepage actually renders) — that IS the live feed.
//   2. This module mirrors every successful receipt into `x402_demo_feed`
//      (Postgres) — a durable, queryable history that survives the 50-entry
//      Redis ring's eviction and feeds activity analytics.
//
// Wiring: declared as a run()-style entry in autonomous-registry.js. The
// per-tick loop (api/cron/x402-autonomous-loop.js) hands run() its shared
// context and records the single summary row (with value_extracted) to
// x402_autonomous_log. We never sign here — /api/x402-pay owns the payment — so
// the only Solana context this pipeline needs is the origin to call.
//
// Downstream consumers of the data written here:
//   - Homepage / jumbotron / exchange-NPC live feed → GET /api/x402-pay?feed=1
//     (Redis ring written by the demo call).
//   - x402_demo_feed table → durable activity history + Redis-eviction backstop
//     for the same feed; queryable for "recent live payments" analytics.

import { randomUUID } from 'node:crypto';

import { sql } from '../../db.js';
import { env } from '../../env.js';
import { logger } from '../../usage.js';
import { fetchWithTimeout, USDC_MINT } from '../pay.js';

const log = logger('x402-live-feed-seeder');

const ASSET = USDC_MINT || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// Public rig-reference avatars served from three.ws/avatars/*.glb. The model
// tools (inspect/validate/optimize) fetch their `url` server-side through the
// SSRF-guarded safeFetchModel, so the target must be a public https URL — these
// are. (Defined locally rather than imported from autonomous-registry.js to keep
// the registry → pipeline import one-directional.)
const REFERENCE_AVATARS = ['michelle.glb', 'xbot.glb', 'cz.glb', 'realistic-male.glb', 'fox.glb'];

const avatarUrl = (origin, file) => `${origin}/avatars/${file}`;

// Rotation of demo calls. Every entry maps to one ALLOWED_TOOLS tool on
// /api/x402-pay (tools/list, validate_model, inspect_model, optimize_model,
// search_public_avatars) so the live feed shows varied, real agent activity.
// `topic` is the human label that lands in the feed mirror + value_extracted.
const SEED_ROTATION = [
	{ tool: 'search_public_avatars', args: { q: 'robot', limit: 6 }, topic: 'avatar search · robot' },
	{ tool: 'inspect_model', avatar: 'michelle.glb', topic: 'model inspect · michelle' },
	{ tool: 'search_public_avatars', args: { q: 'dancer', limit: 6 }, topic: 'avatar search · dancer' },
	{ tool: 'validate_model', avatar: 'xbot.glb', topic: 'model validate · xbot' },
	{ tool: 'search_public_avatars', args: { q: 'anime', limit: 6 }, topic: 'avatar search · anime' },
	{ tool: 'optimize_model', avatar: 'cz.glb', topic: 'model optimize · cz' },
	{ tool: 'search_public_avatars', args: { q: 'character', limit: 6 }, topic: 'avatar search · character' },
	{ tool: 'inspect_model', avatar: 'realistic-male.glb', topic: 'model inspect · realistic-male' },
	{ tool: 'tools/list', args: {}, topic: 'capability discovery' },
	{ tool: 'optimize_model', avatar: 'fox.glb', topic: 'model optimize · fox' },
];

export { SEED_ROTATION, REFERENCE_AVATARS };

// Round-robin cursor over SEED_ROTATION. Redis-backed when available so the
// rotation advances coherently across warm instances; per-instance fallback
// otherwise. Mirrors the GLB-canonicalization rotation idiom in the registry.
let _cursor = 0;
export async function nextRotation(ctx = {}) {
	const list = SEED_ROTATION;
	let idx;
	if (ctx.redis) {
		try {
			const n = await ctx.redis.incr('x402:auto:feed-seeder:cursor');
			idx = (Number(n) - 1) % list.length;
		} catch {
			idx = _cursor++ % list.length;
		}
	} else {
		idx = _cursor++ % list.length;
	}
	return list[idx];
}

// Resolve a rotation entry into the concrete /api/x402-pay request body.
export function buildRequestBody(pick, origin) {
	if (pick.tool === 'tools/list') return { tool: 'tools/list', args: {} };
	if (pick.avatar) return { tool: pick.tool, args: { url: avatarUrl(origin, pick.avatar) } };
	return { tool: pick.tool, args: pick.args || {} };
}

// Compact, human-readable summary of a tool result for the feed mirror +
// value_extracted. Pulls only the headline numbers — never the bulky payload.
export function summarizeResult(tool, result) {
	const sc = (result && result.structuredContent) || {};
	switch (tool) {
		case 'search_public_avatars':
			return { result_kind: 'avatars', result_count: Array.isArray(sc.avatars) ? sc.avatars.length : null };
		case 'inspect_model':
			return { result_kind: 'inspection', triangles: sc.counts?.totalTriangles ?? null, meshes: sc.counts?.meshes ?? null };
		case 'validate_model':
			return { result_kind: 'validation', errors: sc.numErrors ?? null, warnings: sc.numWarnings ?? null };
		case 'optimize_model':
			return { result_kind: 'optimization', suggestions: Array.isArray(sc.suggestions) ? sc.suggestions.length : null };
		case 'tools/list':
			return { result_kind: 'tools', tools: Array.isArray(result?.tools) ? result.tools.length : null };
		default:
			return { result_kind: 'unknown' };
	}
}

function argsSummary(body) {
	const a = body?.args || {};
	if (a.url) {
		try { return new URL(a.url).pathname.split('/').pop() || a.url; }
		catch { return String(a.url).slice(0, 40); }
	}
	if (a.q) return `q=${String(a.q).slice(0, 24)}`;
	const keys = Object.keys(a);
	return keys.length ? keys.map((k) => `${k}=${String(a[k]).slice(0, 16)}`).join(' ') : '';
}

// One-time DDL guard per warm instance (mirrors the loop's ensureSchema idiom).
let _schemaReady = false;
export async function ensureSchema() {
	if (_schemaReady) return;
	await sql`
		CREATE TABLE IF NOT EXISTS x402_demo_feed (
			id             bigserial PRIMARY KEY,
			run_id         uuid NOT NULL,
			ts             timestamptz DEFAULT now(),
			tool           text NOT NULL,
			topic          text,
			args_summary   text,
			tx_signature   text,
			network        text,
			amount_atomic  bigint NOT NULL DEFAULT 0,
			asset          text,
			payer          text,
			pay_to         text,
			explorer       text,
			total_ms       int,
			result_summary jsonb
		)
	`;
	await sql`CREATE INDEX IF NOT EXISTS x402_demo_feed_ts ON x402_demo_feed (ts DESC)`;
	await sql`CREATE UNIQUE INDEX IF NOT EXISTS x402_demo_feed_tx ON x402_demo_feed (tx_signature) WHERE tx_signature IS NOT NULL`;
	_schemaReady = true;
}

// Persist a successful demo-payment receipt into the durable feed mirror.
// Idempotent on tx_signature so a retried run never double-rows the same payment.
async function storeFeedRow(row) {
	try {
		await sql`
			INSERT INTO x402_demo_feed
				(run_id, tool, topic, args_summary, tx_signature, network,
				 amount_atomic, asset, payer, pay_to, explorer, total_ms, result_summary)
			VALUES
				(${row.runId}, ${row.tool}, ${row.topic}, ${row.argsSummary},
				 ${row.txSig}, ${row.network}, ${row.amountAtomic}, ${row.asset},
				 ${row.payer}, ${row.payTo}, ${row.explorer}, ${row.totalMs},
				 ${row.resultSummary ? JSON.stringify(row.resultSummary) : null})
			ON CONFLICT (tx_signature) WHERE tx_signature IS NOT NULL DO NOTHING
		`;
	} catch (err) {
		log.warn('demo_feed_store_failed', { tx: row.txSig, message: err?.message });
	}
}

/**
 * Run the seeder. Conforms to the run()-style registry contract: the per-tick
 * loop hands { origin, redis, runId, ... }; the demo payment is made by
 * /api/x402-pay (platform wallet), so no Solana signing context is needed here.
 *
 * Returns the aggregate outcome the loop records as one x402_autonomous_log row:
 *   { success, amountAtomic, txSig, errorMsg, responseData, valueExtracted, skipped, note }
 * The loop decrements the daily cap by amountAtomic on success and persists
 * value_extracted onto that summary row.
 */
export async function run(ctx = {}) {
	const runId = ctx.runId || randomUUID();
	const origin = ctx.origin || env.APP_ORIGIN || 'https://three.ws';
	const endpointUrl = `${origin}/api/x402-pay`;

	// The demo payment pays from the platform wallet (X402_AGENT_SOLANA_SECRET_BASE58,
	// via loadAgentKeypair in api/x402-pay.js). When that secret is unset the POST
	// below is guaranteed to return 503 config_missing (still handled gracefully
	// below), but firing it every tick logs a 5xx on /api/x402-pay and flags the
	// endpoint's health for nothing. Short-circuit before the request. The endpoint
	// only accepts this secret as the platform wallet in every real deployment (its
	// dev-keypair file exists on no server), so the secret's presence is the exact
	// signal; seeding resumes on its own the moment the wallet is set.
	if (!process.env.X402_AGENT_SOLANA_SECRET_BASE58) {
		return {
			success: false,
			skipped: true,
			amountAtomic: 0,
			errorMsg: 'wallet_unconfigured',
			note: 'platform_wallet_unconfigured (skipped before request)',
		};
	}

	// Schema first — without the durable mirror there is no sink for the value,
	// so don't spend. A schema failure exits logged, never crashes the tick.
	try {
		await ensureSchema();
	} catch (err) {
		log.warn('feed_seeder_schema_failed', { message: err?.message });
		return { success: false, skipped: true, amountAtomic: 0, errorMsg: `schema_failed: ${err?.message}` };
	}

	const pick = await nextRotation(ctx);
	const body = buildRequestBody(pick, origin);
	const argSum = argsSummary(body);

	const t0 = Date.now();
	let res;
	try {
		res = await fetchWithTimeout(endpointUrl, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				accept: 'application/json',
				'user-agent': 'threews-x402-autonomous/1.0',
			},
			body: JSON.stringify(body),
		});
	} catch (err) {
		const errorMsg = err?.message || 'fetch_failed';
		log.warn('feed_seeder_fetch_failed', { topic: pick.topic, message: errorMsg });
		return { success: false, amountAtomic: 0, txSig: null, errorMsg, note: `feed_seeder ${pick.topic} fetch_failed` };
	}

	const durationMs = Date.now() - t0;
	const respBody = res.body && typeof res.body === 'object' ? res.body : null;

	// Wallet unconfigured: /api/x402-pay returns 503 config_missing. Exit gracefully.
	if (res.status === 503 || respBody?.code === 'config_missing' || respBody?.code === 'wallet_unconfigured' || respBody?.code === 'wallet_misconfigured') {
		const errorMsg = respBody?.error || respBody?.code || 'wallet_unconfigured';
		log.info('feed_seeder_wallet_unconfigured', { code: respBody?.code });
		return { success: false, skipped: true, amountAtomic: 0, errorMsg, note: 'wallet_unconfigured' };
	}

	// Any non-success (HTTP error, 402 rejection bubbled as ok:false, rate limit).
	if (!res.ok || !respBody || respBody.ok !== true || !respBody.payment) {
		const errorMsg = respBody?.code || respBody?.error || `http_${res.status}`;
		log.warn('feed_seeder_call_failed', { topic: pick.topic, status: res.status, code: respBody?.code });
		return { success: false, amountAtomic: 0, txSig: null, errorMsg, note: `feed_seeder ${pick.topic} ${errorMsg}` };
	}

	// Success — real on-chain demo payment settled.
	const payment = respBody.payment || {};
	const amountAtomic = Number(payment.amount) || 0;
	const txSig = payment.tx || null;
	const network = payment.network || 'solana:mainnet';
	const totalMs = respBody.durations?.total_ms ?? durationMs;
	const resultSummary = summarizeResult(pick.tool, respBody.result);

	const valueExtracted = {
		tool: pick.tool,
		topic: pick.topic,
		args_summary: argSum,
		tx: txSig,
		network,
		amount_atomic: amountAtomic,
		amount_usdc: amountAtomic / 1e6,
		payer: payment.payer || null,
		pay_to: payment.payTo || null,
		asset: payment.asset || ASSET,
		explorer: payment.explorer || (txSig ? `https://solscan.io/tx/${txSig}` : null),
		total_ms: totalMs,
		...resultSummary,
	};

	// Mirror the receipt into the durable feed table (the /api/x402-pay call has
	// already pushed it onto the Redis ring the homepage renders).
	await storeFeedRow({
		runId,
		tool: pick.tool,
		topic: pick.topic,
		argsSummary: argSum,
		txSig,
		network,
		amountAtomic,
		asset: payment.asset || ASSET,
		payer: payment.payer || null,
		payTo: payment.payTo || null,
		explorer: valueExtracted.explorer,
		totalMs,
		resultSummary,
	});

	log.info('feed_seeder_paid', {
		run_id: runId,
		topic: pick.topic,
		tool: pick.tool,
		tx: txSig,
		amount_usdc: (amountAtomic / 1e6).toFixed(4),
	});

	return {
		success: true,
		amountAtomic,
		txSig,
		responseData: {
			tool: pick.tool,
			topic: pick.topic,
			tx: txSig,
			network,
			amount_usdc: amountAtomic / 1e6,
			...resultSummary,
		},
		valueExtracted,
		note: `feed_seeder ${pick.topic} tx=${txSig ? txSig.slice(0, 8) : 'none'}`,
	};
}
