// api/_lib/x402/autonomous-registry.js
//
// Registry of x402 endpoints the autonomous spend loop calls on a schedule.
// Every entry is a self-call to a three.ws x402 endpoint or an external service
// discovered via the bazaar. The loop in api/cron/x402-autonomous-loop.js
// picks entries whose cooldown has elapsed, pays, and records to x402_autonomous_log.
//
// Fields per entry:
//   id             — unique string key (used as Redis cooldown key)
//   name           — human label for logs and analytics
//   path           — URL path (self-calls) OR full URL (external)
//   method         — 'GET' | 'POST' (default 'POST')
//   body           — request body (for POST), can be a function(ctx) => object
//   cooldown_s     — minimum seconds between calls (enforced via Redis)
//   priority       — 1-100; higher = more likely selected when multiple are ready
//   pipeline       — tag: 'oracle' | 'health' | 'volume' | 'sniper' | 'qa' | 'forge' | 'discovery' | 'external'
//   enabled        — boolean; set false to pause without removing
//   extractSignal  — optional fn(responseBody) => object stored in x402_autonomous_log.signal_data
//                    For oracle pipeline entries, return { mint?, signal, confidence, headline }
//   resolveTarget  — optional async fn(ctx) => { path, targetUrl } that computes the
//                    request path dynamically per call (ctx: { redis, origin, runId }).
//                    For pipelines that rotate over a set of resources.
//   storeValue     — optional async fn(ctx) that persists extracted value to a
//                    dedicated table (ctx: { sql, redis, responseBody, signalData,
//                    runId, targetUrl, endpointUrl, origin, durationMs, success }).
//                    The loop wraps it in try/catch so a DB failure can never
//                    crash the tick.
//   run            — optional async fn(ctx) that owns its full call sequence,
//                    payments (via the shared payX402 client), per-call recording
//                    and value extraction. The loop hands it { origin, buyer,
//                    conn, blockhash, mintInfo, redis, sql, log, runId,
//                    remainingCap } and records the returned aggregate as one
//                    summary row. Used for multi-call pipelines (e.g. the bazaar
//                    discovery warmup sweeping 15 categories per run).

import { run as bazaarDiscoveryWarmup } from './pipelines/bazaar-warmup.js';
import {
	run as bazaarCatalogRefresh,
	BAZAAR_CATALOG_REFRESH,
} from './pipelines/bazaar-catalog-refresh.js';
import { run as x402PricingTracker } from './pipelines/x402-pricing-tracker.js';
import { run as avatarSearchWarmup } from './pipelines/avatar-search-warmup.js';
import { run as reputationRefresh } from './pipelines/reputation-refresh.js';
import { run as tokenIntelPreSnipeGate } from './pipelines/token-intel-gate.js';
import { run as sniperIntelEnrich } from './pipelines/sniper-intel-enrich.js';
import { run as volumeBootstrapLoop } from './pipelines/volume-bootstrap-loop.js';
import { run as datapointVolumeSweep } from './pipelines/datapoint-volume-sweep.js';
import { run as ringRebalance, floatTopUp as ringFloatTopUp } from './pipelines/ring-rebalance.js';
import { run as ringAgentBuyers } from './agents/index.js';
import { run as feeAudit } from './pipelines/fee-audit.js';
import { run as liveFeedSeeder } from './pipelines/live-feed-seeder.js';
import { run as feeCalculationValidator } from './pipelines/fee-calculation-validator.js';
import { run as crossChainCostComparison } from './pipelines/cross-chain-cost.js';
import { run as charitySplitAudit } from './pipelines/charity-split-audit.js';
import { classifyThreeSignal, insertThreeSignal } from './three-signal-store.js';
import { classifySniperSignal, insertSniperAnalytics } from './sniper-analytics-store.js';
import { classifyLeaderboard, insertLeaderboardSnapshot } from './agent-leaderboard-store.js';
import { run as cosmeticPricingAudit } from './pipelines/cosmetic-pricing-audit.js';
import { run as builderCodeAttribution } from './pipelines/builder-code-attribution.js';
import { run as paymentProofIdempotencyAudit } from './pipelines/payment-proof-idempotency-audit.js';
import { run as apiKeyBypassAudit } from './pipelines/api-key-bypass-audit.js';
import { run as modelMetadataEnrichment } from './pipelines/model-metadata-enrichment.js';
import { run as forgeContentGeneration } from './pipelines/forge-content.js';
import { run as runAnimationRetargetQa, hasCanaryClips as hasAnimationQaCanaries } from './pipelines/animation-retarget-qa.js';
import { runCircuitBreaker } from './pipelines/circuit-breaker.js';
import { run as runGlbSizeOptimizer } from './glb-size-optimizer.js';
import { run as walletBalanceMonitor } from './wallet-balance-monitor.js';
import { run as revenueReconciliation } from './revenue-reconciliation.js';
import { run as ringReconciliation } from './ring-reconciliation.js';
import { mcpLatencySweep } from './mcp-latency-sweep.js';
import { runStreamingMcpHealth } from './pipelines/streaming-mcp-health.js';
import {
	runGraniteHealth,
	GRANITE_HEALTH_ENDPOINT,
	GRANITE_HEALTH_PRICE_ATOMIC,
} from './granite-health.js';
import { vrmCompatEntry } from './pipelines/vrm-compat-checker.js';
import {
	runSceneCaptureProcessor,
	SCENE_CAPTURE_ENDPOINT,
	SCENE_CAPTURE_PRICE_ATOMIC,
} from './scene-capture-processor.js';
import { run as runRigComplexityScorer } from './pipelines/rig-complexity.js';
import { extractCoverRevenueSignal } from '../club/cover-revenue.js';
import { run as runReservationLeakDetector } from './pipelines/spend-reservation-leak-detector.js';
import { run as runSubscriptionHealth } from './pipelines/subscription-health.js';
import { run as runPayByNameResolution } from './pipelines/pay-by-name-resolver.js';
import {
	run as runServiceUptimeMonitor,
	SERVICE_UPTIME_ENDPOINT,
} from './pipelines/service-uptime-monitor.js';
import {
	runThumbnailRegen,
	THUMBNAIL_REGEN_ENDPOINT,
	THUMBNAIL_REGEN_PRICE_ATOMIC,
	STALE_DAYS as THUMBNAIL_STALE_DAYS,
} from './thumbnail-regen.js';
import { classifyVolumeAnomaly } from './pump-volume-anomaly.js';
import {
	classifyLaunchMonitor,
	storePumpLaunchSnapshot,
} from './pump-launch-monitor.js';
import { extractActivitySignal } from './user-activity-analytics.js';

// ── MCP Tool Latency Monitor (USE-006) ───────────────────────────────────────
// The canary the loop pays every 5 min to exercise the MCP paid path end-to-end
// (auth → price → pay → settle → dispatch). validate_model is the cheapest
// read-only priced MCP tool ($0.005); the Khronos Box.glb is a tiny, stable,
// public Khronos sample so the call is deterministic and always settles. The
// paid round-trip latency feeds x402_perf_log alongside the per-tool sweep that
// storeValue runs (see mcp-latency-sweep.js). Override the canary model via env
// without editing source.
const MCP_PERF_CANARY_MODEL =
	(process.env.X402_MCP_PERF_CANARY_MODEL || '').trim() ||
	'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Models/main/2.0/Box/glTF-Binary/Box.glb';

// ── GLB Canonicalization Pipeline (USE-011) ──────────────────────────────────
// Real rig-reference avatars served from three.ws/avatars/*.glb. Each covers a
// distinct skeleton convention that src/glb-canonicalize.js maps onto the
// canonical bone set (Mixamo, Daz/Genesis, glTF reference, photoreal scan,
// rigged non-humanoid). The autonomous loop rotates through them so every known
// rig type is continuously re-validated against /api/x402/model-check. The day a
// glTF-Transform bump — or a brand-new rig added to the rotation — regresses
// skin/animation detection (the signal that would otherwise silently drop an
// avatar to a bind-pose T-pose), the verdict flips and lands in
// glb_canonicalization_results keyed by model URL for the avatar pipeline to read.
const RIG_REFERENCE_AVATARS = [
	'michelle.glb',       // Mixamo humanoid (mixamorig:* bones)
	'xbot.glb',           // Mixamo X-Bot
	'cz.glb',             // Daz/Genesis-style rig
	'cesium-man.glb',     // glTF reference skinned rig
	'realistic-male.glb', // photoreal scanned humanoid
	'dancing-twerk.glb',  // Mixamo clip-baked rig
	'brainstem.glb',      // glTF reference skinned (non-humanoid joints)
	'fox.glb',            // rigged non-humanoid (animal) — exercises the fallback gate
];

export { RIG_REFERENCE_AVATARS };

// Derive the canonicalization verdict from a /api/x402/model-check response.
// Shared by extractSignal (→ x402_autonomous_log.signal_data) and storeValue
// (→ glb_canonicalization_results) so both always agree on the classification.
export function classifyCanonicalization(r) {
	const model = (r && r.model) || {};
	const c = model.counts || {};
	const ext = [
		...(Array.isArray(model.extensionsUsed) ? model.extensionsUsed : []),
		...(Array.isArray(model.extensionsRequired) ? model.extensionsRequired : []),
	];
	const isVrm = ext.some((x) => typeof x === 'string' && /^VRM/i.test(x));
	const skins = Number(c.skins || 0);
	const animations = Number(c.animations || 0);
	const isSkinned = skins > 0;
	// supportsCanonicalClips() gate (AnimationManager): only skeleton-driven rigs
	// can retarget the pre-baked idle/walk library. A skin-less model uses the
	// default-rig fallback rather than collapsing to a T-pose.
	const rigType = isVrm
		? 'vrm'
		: isSkinned
			? 'skinned'
			: animations > 0
				? 'node-animated'
				: 'static';
	return {
		model_url: (r && r.url) || null,
		container: model.container || null,
		generator: model.generator || null,
		rig_type: rigType,
		is_skinned: isSkinned,
		vrm: isVrm,
		skins,
		animations,
		nodes: Number(c.nodes || 0),
		canonical_ready: isSkinned,
		extensions: ext,
		suggestion_count: Array.isArray(r && r.suggestions) ? r.suggestions.length : 0,
		fetched_bytes: Number((r && r.fetchedBytes) || 0),
	};
}

// One-time DDL guard per warm instance (mirrors the loop's ensureSchema idiom).
let _canonSchemaReady = false;
async function ensureCanonicalSchema(sql) {
	if (_canonSchemaReady) return;
	await sql`
		CREATE TABLE IF NOT EXISTS glb_canonicalization_results (
			model_url       text PRIMARY KEY,
			container       text,
			generator       text,
			rig_type        text,
			is_skinned      boolean,
			vrm             boolean,
			skins           int,
			animations      int,
			nodes           int,
			canonical_ready boolean,
			extensions      jsonb,
			suggestions     jsonb,
			run_id          uuid,
			checked_at      timestamptz DEFAULT now()
		)
	`;
	_canonSchemaReady = true;
}

// Round-robin cursor over the reference avatars (per warm instance; Redis-backed
// when available so rotation is stable across instances).
let _canonCursor = 0;
async function nextCanonicalTarget(ctx) {
	const list = RIG_REFERENCE_AVATARS;
	let idx;
	if (ctx?.redis) {
		try {
			const n = await ctx.redis.incr('x402:auto:glb-canon:cursor');
			idx = (Number(n) - 1) % list.length;
		} catch {
			idx = _canonCursor++ % list.length;
		}
	} else {
		idx = _canonCursor++ % list.length;
	}
	const origin = ctx?.origin || 'https://three.ws';
	const targetUrl = `${origin}/avatars/${list[idx]}`;
	return { path: `/api/x402/model-check?url=${encodeURIComponent(targetUrl)}`, targetUrl };
}

// ── Forge Content Generation Health helpers (USE-072) ─────────────────────────
// The latency SLA the forge content-generation probe asserts (mirrors
// HEALTH_CHECK_BUDGET_MS in api/x402/forge.js). A completion slower than this — or
// an outright generator failure — is a forge performance alert.
const FORGE_HEALTH_BUDGET_MS = 5000;
// Redis key the on-call surface reads to detect a degraded content-generation
// lane in one GET, mirroring the wallet-balance alert convention.
const FORGE_HEALTH_ALERT_KEY = 'x402:forge-health:alert';
const FORGE_HEALTH_ALERT_TTL_SECONDS = 25 * 60;

// storeValue sink for the forge content-generation health probe. Raises (or
// clears) the forge performance alert based on the extracted verdict, and never
// throws — the loop wraps it in try/catch, but a health canary must not be able
// to crash the tick over an alerting hiccup.
async function recordForgeHealthAlert({ redis, signalData }) {
	if (!redis) return;
	const v = signalData || {};
	const degraded = v.generated === false || v.slow === true;
	try {
		if (degraded) {
			await redis.set(
				FORGE_HEALTH_ALERT_KEY,
				JSON.stringify({
					reason: v.generated === false ? 'generation_failed' : 'latency_budget_exceeded',
					generated: v.generated === true,
					latency_ms: v.latency_ms ?? null,
					budget_ms: FORGE_HEALTH_BUDGET_MS,
					provider: v.provider ?? null,
					error: v.error ?? null,
					ts: new Date().toISOString(),
				}),
				{ ex: FORGE_HEALTH_ALERT_TTL_SECONDS },
			);
			console.warn(
				`[x402/forge-health] ALERT: content generation degraded (` +
					`generated=${v.generated}, latency_ms=${v.latency_ms}, budget=${FORGE_HEALTH_BUDGET_MS}ms)`,
			);
		} else if (v.generated === true) {
			// Healthy again — drop any lingering alert flag.
			await redis.del(FORGE_HEALTH_ALERT_KEY);
		}
	} catch (err) {
		console.warn(`[x402/forge-health] alert write failed: ${err?.message || err}`);
	}
}

// ── Forge Image Generation Health helpers (USE-073) ──────────────────────────
// The latency SLA the forge image-generation probe asserts (mirrors
// HEALTH_CHECK_IMAGE_BUDGET_MS in api/x402/forge.js). Image generation is
// slower than text — >30s means the image provider chain is hung.
const FORGE_IMAGE_HEALTH_BUDGET_MS = 30_000;
const FORGE_IMAGE_HEALTH_ALERT_KEY = 'x402:forge-image-health:alert';
const FORGE_IMAGE_HEALTH_ALERT_TTL_SECONDS = 25 * 60;

// storeValue sink for the forge image-generation health probe. Raises (or clears)
// the image performance alert based on the extracted verdict. Uses a separate Redis
// key from the text-health alert so the two lanes can degrade independently.
async function recordForgeImageHealthAlert({ redis, signalData }) {
	if (!redis) return;
	const v = signalData || {};
	const degraded = v.generated === false || v.slow === true;
	try {
		if (degraded) {
			await redis.set(
				FORGE_IMAGE_HEALTH_ALERT_KEY,
				JSON.stringify({
					reason: v.generated === false ? 'generation_failed' : 'latency_budget_exceeded',
					generated: v.generated === true,
					latency_ms: v.latency_ms ?? null,
					budget_ms: FORGE_IMAGE_HEALTH_BUDGET_MS,
					url: v.url ?? null,
					model: v.model ?? null,
					error: v.error ?? null,
					ts: new Date().toISOString(),
				}),
				{ ex: FORGE_IMAGE_HEALTH_ALERT_TTL_SECONDS },
			);
			console.warn(
				`[x402/forge-image-health] ALERT: image generation degraded (` +
					`generated=${v.generated}, latency_ms=${v.latency_ms}, budget=${FORGE_IMAGE_HEALTH_BUDGET_MS}ms)`,
			);
		} else if (v.generated === true) {
			await redis.del(FORGE_IMAGE_HEALTH_ALERT_KEY);
		}
	} catch (err) {
		console.warn(`[x402/forge-image-health] alert write failed: ${err?.message || err}`);
	}
}

// ── Club Social Activity Analytics (USE-045) ─────────────────────────────
// Derives the social-economy signal from a /api/x402/analytics {report:'clubs'}
// response. Shared by extractSignal (→ x402_autonomous_log.signal_data) and
// storeValue (→ club_social_analytics time series) so both always agree on the
// snapshot they record.
export function classifyClubAnalytics(r) {
	const m = (r && r.metrics) || {};
	const tips = m.tips || {};
	const cover = m.cover_charges || {};
	const top = Array.isArray(r && r.top_clubs) ? r.top_clubs[0] : null;
	return {
		report: (r && r.report) || 'clubs',
		period: (r && r.period) || null,
		active_clubs: m.active_clubs ?? null,
		total_clubs: m.total_clubs ?? null,
		members: m.members ?? null,
		tip_count: tips.count ?? null,
		tip_volume_atomics: tips.volume_atomics ?? null,
		tip_volume_usdc: tips.volume_usdc ?? null,
		cover_count: cover.count ?? null,
		cover_atomics: cover.atomics ?? null,
		cover_usdc: cover.usdc ?? null,
		top_club: top ? (top.display_name || top.dancer || null) : null,
		top_club_volume_atomics: top ? (top.volume_atomics ?? null) : null,
		top_club_volume_usdc: top ? (top.volume_usdc ?? null) : null,
	};
}

// Time-series sink for the club social-economy snapshot. One row per autonomous
// run so a dashboard can chart active stages / members / tip + cover volume over
// time and spot growth or decline. Created lazily on first write (per warm
// instance), mirroring the ensureCanonicalSchema idiom above.
let _clubAnalyticsSchemaReady = false;
async function ensureClubAnalyticsSchema(sql) {
	if (_clubAnalyticsSchemaReady) return;
	await sql`
		CREATE TABLE IF NOT EXISTS club_social_analytics (
			id                       bigserial PRIMARY KEY,
			ts                       timestamptz DEFAULT now(),
			period                   text NOT NULL,
			active_clubs             int,
			total_clubs              int,
			members                  int,
			tip_count                int,
			tip_volume_atomics       numeric,
			cover_count              int,
			cover_atomics            numeric,
			top_club                 text,
			top_club_volume_atomics  numeric,
			run_id                   uuid
		)
	`;
	await sql`CREATE INDEX IF NOT EXISTS club_social_analytics_ts_desc ON club_social_analytics (ts desc)`;
	_clubAnalyticsSchemaReady = true;
}

const SELF_ENDPOINTS = [
	// ── Club Social Activity Analytics (USE-045) ──────────────────────
	// Pays $0.005 USDC every 30 min to /api/x402/analytics {report:'clubs',
	// period:'24h'} for a live snapshot of the Pole Club social economy — active
	// stages, distinct patron members, tip count + USDC volume, cover charges
	// collected, and the fastest-growing stages. extractSignal lifts the snapshot
	// into x402_autonomous_log.signal_data; storeValue appends it to the
	// club_social_analytics time series so a dashboard can track social-economy
	// health and surface growing clubs over time. Health pipeline (not oracle —
	// this is platform telemetry, not a sniper trading signal). Cooldown 1800s →
	// ~48 snapshots/day ≈ $0.24/day, well under the loop's daily cap.
	{
		id: 'analytics-club-social',
		name: 'Analytics: Club Social Activity',
		path: '/api/x402/analytics',
		method: 'POST',
		body: { report: 'clubs', period: '24h' },
		cooldown_s: 1800,
		priority: 48,
		pipeline: 'health',
		enabled: true,
		extractSignal: (r) => classifyClubAnalytics(r),
		storeValue: async ({ sql, responseBody, signalData, runId }) => {
			if (!sql) return;
			const v = signalData || classifyClubAnalytics(responseBody);
			if (!v || v.report !== 'clubs') return;
			await ensureClubAnalyticsSchema(sql);
			await sql`
				INSERT INTO club_social_analytics
					(period, active_clubs, total_clubs, members, tip_count,
					 tip_volume_atomics, cover_count, cover_atomics, top_club,
					 top_club_volume_atomics, run_id)
				VALUES
					(${v.period || '24h'}, ${v.active_clubs}, ${v.total_clubs},
					 ${v.members}, ${v.tip_count}, ${v.tip_volume_atomics || 0},
					 ${v.cover_count}, ${v.cover_atomics || 0}, ${v.top_club},
					 ${v.top_club_volume_atomics || 0}, ${runId})
			`;
		},
	},

	// ── 3D Pipeline: VRM 1.0 Compatibility Checker (USE-019) ──────────────────
	// Pays a real $0.01 x402 call to /api/mcp (inspect_model) per avatar, derives a
	// VRM 0.x → 1.0 migration report, and upserts it into avatar_vrm_compat. Full
	// implementation in ./pipelines/vrm-compat-checker.js.
	vrmCompatEntry,

	// ── 3D Pipeline: GLB Size Optimizer (USE-018) ─────────────────────────────
	// Picks the heaviest public avatar GLB over the 5 MB web-delivery budget that
	// has not been analyzed in the last 14 days, then pays one real x402 call to
	// /api/mcp (optimize_model) to inspect it and surface Draco/Meshopt geometry
	// compression, 4K→2K texture downscaling, and PNG→KTX2 transcoding. run()
	// projects the post-optimization size from the model's measured stats and
	// persists original + projected-optimized bytes and load-time improvement to
	// glb_optimizations (+ a detailed x402_autonomous_log row with value_extracted).
	// 6h pacing sweeps the heavy backlog one model per run, biggest/stalest first,
	// well under the daily cap. Downstream consumer: GET /api/x402/glb-optimization
	// -report aggregates the catalog-wide average size + load-time improvement and
	// the remaining heavy-GLB backlog.
	{
		id: 'glb-size-optimizer',
		name: 'GLB Size Optimizer (>5MB catalog sweep)',
		// path is informational — runGlbSizeOptimizer() selects the target GLB and
		// pays the optimize_model call against /api/mcp itself. Real price is read
		// from the live 402 challenge (optimize_model is $0.05/call).
		path: '/api/mcp',
		method: 'POST',
		cooldown_s: 21_600, // 6h — gradual catalog sweep, one heavy model per run
		priority: 37,
		pipeline: 'self',
		enabled: true,
		run: runGlbSizeOptimizer,
		extractSignal: null,
	},

	// GLB optimization catalog feed — a zero-param GET that pays for and reads the
	// full optimization-opportunity report. Broadens real coverage to the
	// glb-optimization-report endpoint without any fixture: no required params, no
	// side effects, idempotent. Slow cadence — the catalog moves gradually.
	{
		id: 'glb-optimization-report',
		name: 'GLB Optimization Report (catalog feed)',
		path: '/api/x402/glb-optimization-report',
		method: 'GET',
		body: null,
		cooldown_s: 21_600, // 6h
		priority: 36,
		pipeline: 'self',
		enabled: true,
		extractSignal: null,
	},

	// ── Circuit Breaker (cheapest end-to-end proof the payment stack is alive) ─
	{
		id: 'circuit-breaker-cross-network',
		name: 'Cross-Network Payment Circuit Breaker',
		// path is informational — runCircuitBreaker() probes + settles itself.
		// It pays the cheapest 402-gated endpoint ($0.001 dance-tip) on Solana and
		// route-verifies Base + BSC from the same live challenge.
		path: '/api/x402/dance-tip',
		method: 'POST',
		cooldown_s: 3600, // hourly — see agents/x402-buildout/self/009
		priority: 88,
		pipeline: 'circuit-breaker',
		enabled: true,
		run: runCircuitBreaker,
		extractSignal: null,
	},

	// ── Payment Proof Idempotency Audit (anti-fraud) ──────────────────────────
	// Daily anti-replay canary. Pays ONE real $0.001 USDC call to the idempotent
	// /api/x402/model-check, then resubmits the IDENTICAL signed X-PAYMENT proof
	// and confirms the idempotency store returns a replay/conflict (never a second
	// on-chain settlement). run() owns the two-call sequence + payment; the verdict
	// lands in x402_idempotency_audit and a confirmed double-settle raises an ops
	// alert. Daily cadence → one paid audit/day ≈ $0.001/day. Downstream consumer:
	// api/ops/health.js folds a double-settlement into the platform health verdict.
	{
		id: 'payment-proof-idempotency-audit',
		name: 'Payment Proof Idempotency Audit',
		// path is informational — the pipeline probes + pays + replays itself.
		path: '/api/x402/model-check',
		method: 'GET',
		cooldown_s: 86400, // daily — critical anti-fraud check
		priority: 86,
		pipeline: 'security',
		enabled: true,
		run: paymentProofIdempotencyAudit,
		extractSignal: null,
	},

	// ── API Key Bypass Security Test (free-access canary) ─────────────────────
	// Daily security canary for the X-API-Key bypass lane (access-control.js →
	// installAccessControl). run() probes a bypass matrix against both the hand-
	// rolled (/api/x402/model-check) and paidEndpoint-factory (/api/x402/dance-tip)
	// access-control paths: a VALID key must grant free access (200 + x-payment-
	// bypass), an INVALID key must be denied (403/402), and NO key must hit the 402
	// paywall — any free 200 on the deny/no-key paths is a LEAK. It mints an
	// ephemeral, self-expiring subscription key (revoked in a finally) to exercise
	// the partner lane, then makes ONE real $0.001 payment against the no-key
	// model-check 402 to prove the paywall→verify→settle path is intact end-to-end.
	// Verdict lands in x402_api_key_bypass_audit; a confirmed leak raises a CRITICAL
	// ops alert. Daily cadence → one paid probe/day ≈ $0.001/day. Downstream
	// consumer: api/ops/health.js folds a bypass leak / broken bypass into the
	// platform health verdict.
	{
		id: 'api-key-bypass-audit',
		name: 'API Key Bypass Security Test',
		// path is informational — the pipeline probes the bypass matrix + pays itself.
		path: '/api/x402/model-check',
		method: 'GET',
		price_atomic: 1000, // the bypass is free; the lone paywall-proof payment is $0.001
		cooldown_s: 86400, // daily — catches a refactor-introduced bypass within 24h
		priority: 84,
		pipeline: 'security',
		enabled: true,
		run: apiKeyBypassAudit,
		extractSignal: null,
	},

	// ── Agent Wallet Balance Monitor (self) ───────────────────────────────────
	// Polls the seed/agent wallet balance (the wallet that funds every other
	// autonomous call) via the free GET /api/x402-pay?balance=1 every 10 minutes.
	// run() records a time-series sample to agent_wallet_balance_log, derives the
	// USDC burn rate vs the previous sample, and raises a low-balance alert (USDC
	// < $5, env-tunable) to Redis + the logs so operators can top up before the
	// loop is starved. Free read → moves no funds (amountAtomic always 0).
	// Downstream consumer: api/ops/health.js folds a low/unconfigured wallet into
	// the internal health verdict so the status dashboard flags it early.
	{
		id: 'agent-wallet-balance-monitor',
		name: 'Agent Wallet Balance Monitor',
		// path is informational — walletBalanceMonitor() owns the free GET call.
		path: '/api/x402-pay?balance=1',
		method: 'GET',
		cooldown_s: 600, // every 10 minutes
		priority: 92, // high: a starved wallet breaks every other pipeline
		pipeline: 'health',
		enabled: true,
		run: walletBalanceMonitor,
		extractSignal: null,
	},

	// ── 3D Pipeline: Avatar Thumbnail Regeneration (USE-015) ──────────────────
	// Pays asset-download for the stalest marketplace listing (thumbnail null /
	// older than STALE_DAYS / model bytes newer than last render), then queues a
	// re-render in avatar_thumbnail_regen_jobs. The drainer cron
	// (api/cron/avatar-thumbnail-render.js) renders the GLB to a fresh PNG and
	// writes it back onto paid_assets.thumbnail_r2_key + the linked avatars row so
	// listings always show current appearance. run() selects + pays + enqueues
	// and returns 'no_stale_assets' (skip, no spend) when nothing is overdue.
	{
		id: 'avatar-thumbnail-regen',
		name: `Avatar Thumbnail Regeneration (>${THUMBNAIL_STALE_DAYS}d stale)`,
		// path is informational — runThumbnailRegen() resolves the per-asset slug
		// and pays asset-download itself. price is per-listing; ref price below.
		path: THUMBNAIL_REGEN_ENDPOINT,
		method: 'GET',
		price_atomic: THUMBNAIL_REGEN_PRICE_ATOMIC,
		// 6h pacing: drains the stale backlog one listing per run (~4/day, well
		// under the daily cap) while the 30-day staleness gate decides actual work.
		cooldown_s: 21_600,
		priority: 38,
		pipeline: 'self',
		enabled: true,
		run: runThumbnailRegen,
		extractSignal: null,
	},

	// ── Oracle / Intelligence (highest priority — feeds sniper decisions) ─────
	{
		id: 'crypto-intel-sol',
		name: 'Crypto Intel: Solana',
		path: '/api/x402/crypto-intel',
		method: 'POST',
		body: { topic: 'solana' },
		cooldown_s: 900,
		priority: 95,
		pipeline: 'oracle',
		enabled: true,
		extractSignal: (r) => ({ topic: r?.topic, signal: r?.signal, headline: r?.headline, confidence: r?.confidence, price_usd: r?.price_usd }),
	},

	// ── Token Intel: SOL Price Feed (USE-050) ─────────────────────────────────
	// Pays $0.01 USDC every 300s to /api/x402/token-intel for the live SOL
	// (wrapped Solana) market snapshot: price_usd, 24h change, volume, market cap,
	// bullish/bearish/neutral signal. The mint is the canonical wrapped-SOL address
	// (So11111111111111111111111111111111111111112), resolved via DexScreener.
	// extractSignal lifts { price_usd, change_24h } plus the full signal/headline
	// into x402_autonomous_log.signal_data; as an `oracle` entry the loop upserts
	// the verdict into oracle_intel_signals (topic 'solana_price') so the sniper
	// gate and any downstream SOL price consumer can query it from a single row.
	// Cooldown 300s → 12 reads/hour; SOL price moves fast, 5-min granularity is
	// appropriate. Spend: $0.01/call × 12/hr ≈ $0.12/hr, bounded by the daily cap.
	{
		id: 'token-intel-sol-price',
		name: 'Token Intel: SOL Price Feed',
		path: '/api/x402/token-intel?mint=So11111111111111111111111111111111111111112',
		method: 'GET',
		body: null,
		cooldown_s: 300,
		priority: 88,
		pipeline: 'oracle',
		enabled: true,
		extractSignal: (r) => ({
			topic: 'solana_price',
			signal: r?.signal ?? null,
			headline: r?.headline ?? null,
			confidence: r?.confidence ?? null,
			price_usd: r?.price_usd ?? null,
			change_24h: r?.change_24h ?? null,
			volume_24h_usd: r?.volume_24h_usd ?? null,
			market_cap_usd: r?.market_cap_usd ?? null,
			symbol: r?.symbol ?? null,
			mint: r?.mint ?? null,
		}),
	},
	{
		id: 'crypto-intel-btc',
		name: 'Crypto Intel: Bitcoin',
		path: '/api/x402/crypto-intel',
		method: 'POST',
		body: { topic: 'bitcoin' },
		cooldown_s: 900,
		priority: 90,
		pipeline: 'oracle',
		enabled: true,
		extractSignal: (r) => ({ topic: r?.topic, signal: r?.signal, headline: r?.headline, confidence: r?.confidence, price_usd: r?.price_usd }),
	},
	{
		id: 'crypto-intel-eth',
		name: 'Crypto Intel: Ethereum',
		path: '/api/x402/crypto-intel',
		method: 'POST',
		body: { topic: 'ethereum' },
		cooldown_s: 900,
		priority: 85,
		pipeline: 'oracle',
		enabled: true,
		extractSignal: (r) => ({ topic: r?.topic, signal: r?.signal, headline: r?.headline, confidence: r?.confidence, price_usd: r?.price_usd }),
	},
	// ── USDC Peg Monitor (USE-052) ─────────────────────────────────────────────────────
	// Pays $0.01 USDC every 10 min to /api/x402/token-intel for the live USDC
	// market price on Solana. A stablecoin deviation >0.5% from $1.00 is a
	// payment-ecosystem health event: every x402 price is quoted in USDC, so a
	// depeg skews all atomic amounts and settlement math. extractSignal returns
	// { depeg, price_usd, deviation_pct } plus a bearish signal when depegged;
	// storeValue raises/clears a Redis alert (x402:usdc-peg:alert) so the
	// status surface can surface the anomaly before it corrupts payments.
	// As an oracle entry the signal upserts into oracle_intel_signals under
	// topic 'usdc_peg' for the sniper macro gate to consume. Cooldown 600s
	// 6 reads/hr; free read when DexScreener has no live pair (503 before
	// settlement -- never charged). Mint: USDC on Solana (EPjFWdd5...).
	{
		id: 'usdc-peg-monitor',
		name: 'USDC Peg Monitor',
		path: '/api/x402/token-intel?mint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
		method: 'GET',
		body: null,
		cooldown_s: 600,
		priority: 87,
		pipeline: 'oracle',
		enabled: true,
		extractSignal: (r) => {
			const price = typeof r?.price_usd === 'number' ? r.price_usd : null;
			const deviation = price != null ? Math.abs(price - 1.0) * 100 : null;
			const depeg = deviation != null && deviation > 0.5;
			return {
				topic: 'usdc_peg',
				signal: depeg ? 'bearish' : 'neutral',
				headline: price != null
					? depeg
						? `USDC depegged: $${price.toFixed(6)} (${deviation.toFixed(3)}% from $1.00)`
						: `USDC stable at $${price.toFixed(6)}`
					: 'USDC price unavailable',
				confidence: price != null ? 0.95 : 0,
				price_usd: price,
				depeg,
				deviation_pct: deviation != null ? Math.round(deviation * 1000) / 1000 : null,
				symbol: r?.symbol ?? null,
				change_24h: r?.change_24h ?? null,
			};
		},
		storeValue: async ({ redis, signalData }) => {
			if (!redis) return;
			const v = signalData || {};
			const USDC_PEG_ALERT_KEY = 'x402:usdc-peg:alert';
			const USDC_PEG_ALERT_TTL_SECONDS = 25 * 60;
			try {
				if (v.depeg) {
					await redis.set(
						USDC_PEG_ALERT_KEY,
						JSON.stringify({
							price_usd: v.price_usd,
							deviation_pct: v.deviation_pct,
							headline: v.headline,
							ts: new Date().toISOString(),
						}),
						{ ex: USDC_PEG_ALERT_TTL_SECONDS },
					);
					console.warn(
						`[x402/usdc-peg] DEPEG ALERT: USDC at $${v.price_usd} (${v.deviation_pct}% from $1.00)`,
					);
				} else if (v.depeg === false) {
					await redis.del(USDC_PEG_ALERT_KEY);
				}
			} catch (err) {
				console.warn(`[x402/usdc-peg] alert write failed: ${err?.message || err}`);
			}
		},
	},

	{
		id: 'crypto-intel-pump',
		name: 'Crypto Intel: Pump.fun Meme',
		path: '/api/x402/crypto-intel',
		method: 'POST',
		body: { topic: 'pump' },
		cooldown_s: 600,
		priority: 95,
		pipeline: 'oracle',
		enabled: true,
		extractSignal: (r) => ({ topic: r?.topic, signal: r?.signal, headline: r?.headline, confidence: r?.confidence }),
	},
	// ── Pump.fun Trending Score Feed (USE-047) ─────────────────────────────────
	// Pays $0.01 USDC every 5 min to /api/x402/crypto-intel (topic=pump_trending)
	// for the live pump.fun trending leaderboard enriched with real buy/sell
	// pressure and whale activity. The engine fetches the top 20 coins by market
	// cap from frontend-api-v3, then pulls recent swap-api trades for the top 5
	// to derive: aggregate buy pressure (ratio of buy txns by count), total SOL
	// volume, and individual whale buys (≥5 SOL). The bullish/bearish/neutral
	// verdict + confidence score land in oracle_intel_signals (topic=pump_trending)
	// so the sniper gate can consume them via the standard oracle query. The full
	// trending_mints list (top 10 with market cap) and whale_buys array land in
	// x402_autonomous_log.signal_data for downstream analytics. Cooldown 300s →
	// 12 reads/hour; pump.fun trending refreshes frequently, fast-moving mints
	// can reverse in minutes. Spend: $0.01/call, bounded by the loop's daily cap.
	{
		id: 'crypto-intel-pump-trending',
		name: 'Crypto Intel: Pump.fun Trending Score Feed',
		path: '/api/x402/crypto-intel',
		method: 'POST',
		body: { topic: 'pump_trending' },
		cooldown_s: 300,
		priority: 88,
		pipeline: 'oracle',
		enabled: true,
		extractSignal: (r) => ({
			topic: 'pump_trending',
			signal: r?.signal ?? null,
			headline: r?.headline ?? null,
			confidence: r?.confidence ?? null,
			buy_pressure: r?.buy_pressure ?? null,
			total_volume_sol: r?.total_volume_sol ?? null,
			whale_buy_count: r?.whale_buy_count ?? 0,
			top_mint: r?.top_mint ?? null,
			trending_mints: Array.isArray(r?.trending_mints) ? r.trending_mints.slice(0, 5) : [],
			whale_buys: Array.isArray(r?.whale_buys) ? r.whale_buys.slice(0, 5) : [],
		}),
	},

	// ── Pump.fun Volume Anomaly Oracle (USE-048) ──────────────────────────────
	// Pays $0.01 USDC every 5 minutes to /api/x402/crypto-intel with topic
	// pump_volume_anomaly. The endpoint scans the live pump.fun currently-trading
	// set, fetches trailing-1h trade volumes from the swap API, and flags any coin
	// whose hourly USD volume is >=3x the peer-coin median as an anomaly. A ratio
	// > 5 is tagged high-conviction; as an `oracle` entry the loop upserts the
	// verdict into oracle_intel_signals (topic 'pump_volume_anomaly') for the
	// sniper gate. Cooldown 300s -> 12 scans/hr; $0.01/scan ~= $0.12/hr.
	{
		id: 'pump-volume-anomaly',
		name: 'Pump.fun Volume Anomaly Oracle',
		path: '/api/x402/crypto-intel',
		method: 'POST',
		body: { topic: 'pump_volume_anomaly' },
		cooldown_s: 300,
		priority: 88,
		pipeline: 'oracle',
		enabled: true,
		extractSignal: (r) => classifyVolumeAnomaly(r),
	},

	// ── Pump.fun Whale Wallet Activity Oracle (USE-049) ───────────────────────
	// Pays $0.02 USDC every 15 min to POST /api/x402/pump-agent-audit with
	// body { mode:'whale_activity', limit:5 }. The endpoint fetches recent trades
	// across the top 5 pump.fun coins by market cap and identifies wallets that
	// bought ≥5 SOL in the current sweep window — the large buyers whose entries
	// signal genuine conviction (vs bot dust). extractSignal lifts
	// { wallets, total_sol_moved, whale_count } plus the bullish/bearish/neutral
	// verdict into x402_autonomous_log.signal_data; as an `oracle` entry the loop
	// upserts into oracle_intel_signals (topic 'whale_activity') so the sniper
	// gate can: (a) avoid front-running when whale_count > 3 on a target coin,
	// (b) boost conviction score when total_sol_moved is high on a fresh launch.
	// Cooldown 900s (15 min) — whale positions evolve over minutes, not seconds.
	// Spend: $0.02/call × 4/hr ≈ $0.08/hr, well under the loop's daily cap.
	{
		id: 'pump-whale-activity',
		name: 'Pump.fun Whale Wallet Activity Oracle',
		path: '/api/x402/pump-agent-audit',
		method: 'POST',
		body: { mode: 'whale_activity', limit: 5 },
		cooldown_s: 900,
		priority: 87,
		pipeline: 'oracle',
		enabled: true,
		extractSignal: (r) => ({
			topic: 'whale_activity',
			signal: r?.signal ?? null,
			headline: r?.headline ?? null,
			confidence: r?.confidence ?? null,
			whale_count: r?.whale_count ?? 0,
			total_sol_moved: r?.total_sol_moved ?? 0,
			wallets: Array.isArray(r?.wallets)
				? r.wallets.slice(0, 5).map((w) => ({
					wallet: w.wallet,
					total_sol: w.total_sol,
					buy_count: w.buy_count,
				}))
				: [],
		}),
	},

	{
		// ── $THREE Signal Feed (USE: $THREE market oracle) ─────────────
		// Pays $0.01 USDC every 15 min to /api/x402/three-intel for the live $THREE
		// market snapshot (price, 24 h change, mcap, liquidity, volume, signal). As an
		// `oracle` entry the latest snapshot also dedups into oracle_intel_signals
		// (topic 'three') for the sniper gate; storeValue appends every snapshot to the
		// three_market_signals time series. Downstream consumers of that series:
		//   • the public $THREE price widget — GET /api/three-signal (latest + sparkline)
		//   • $THREE-denominated x402 pricing — usdToThreeTokens() reads the latest price
		id: 'three-intel',
		name: '$THREE Signal Feed',
		path: '/api/x402/three-intel',
		method: 'GET', // three-intel is a GET endpoint (query input, no request body)
		body: null,
		cooldown_s: 900, // 15 min
		priority: 99,
		pipeline: 'oracle',
		enabled: true,
		// classifyThreeSignal carries the full market shape into signal_data so the
		// oracle dedup + the autonomous-log row both hold the complete snapshot.
		extractSignal: (r) => ({ topic: 'three', ...classifyThreeSignal(r) }),
		storeValue: async ({ sql, responseBody, signalData, runId }) => {
			if (!sql) return;
			const v = classifyThreeSignal(responseBody || signalData);
			if (v.price_usd == null) return; // never persist an empty/failed snapshot
			await insertThreeSignal(sql, v, { runId, source: 'x402-autonomous' });
		},
	},
	{
		id: 'fact-check-sol',
		name: 'Fact-Check: SOL market claim',
		path: '/api/x402/fact-check',
		method: 'POST',
		body: { claim: 'Solana is the fastest blockchain by TPS' },
		cooldown_s: 3600,
		priority: 60,
		pipeline: 'oracle',
		enabled: true,
		extractSignal: (r) => ({ verdict: r?.verdict, confidence: r?.confidence, sources: r?.sources }),
	},

	// ── Bazaar Price Trend Monitor (USE-060) ──────────────────────────────────
	// Pays $0.001 USDC to /api/x402/bazaar-feed for a 24h read of price movement
	// across the x402 service marketplace, derived from the platform's own
	// x402_service_price_history time series (populated by the x402-pricing-tracker
	// pipeline). The endpoint classifies each tracked service as trending up /
	// down / stable over the window and derives the net price pressure as a
	// bullish / bearish / neutral signal. As an `oracle` entry the latest verdict
	// dedups into oracle_intel_signals (topic 'bazaar_price_trends') so the sniper
	// gate can fold marketplace cost sentiment into conviction. extractSignal lifts
	// the directional signal + the mover counts into x402_autonomous_log.signal_data.
	// Cooldown 900s (15 min) → matches the price feed's volatility without re-reading
	// the same window every tick; spend ≈ $0.10/day, well under the loop's daily cap.
	{
		id: 'bazaar-price-trends',
		name: 'Bazaar Price Trend Monitor',
		path: '/api/x402/bazaar-feed',
		method: 'POST',
		body: { filter: 'price_trends', period: '24h' },
		cooldown_s: 900, // 15 min — price-pressure signal volatility
		priority: 82,
		pipeline: 'oracle',
		enabled: true,
		extractSignal: (r) => ({
			topic: 'bazaar_price_trends',
			signal: r?.signal || null,
			headline: r?.headline || null,
			confidence: r?.confidence ?? null,
			net_pressure: r?.net_pressure ?? null,
			avg_change_pct: r?.avg_change_pct ?? null,
			trending_up: Array.isArray(r?.trending_up)
				? r.trending_up.map((s) => ({ service_key: s.service_key, pct_change: s.pct_change }))
				: [],
			trending_down: Array.isArray(r?.trending_down)
				? r.trending_down.map((s) => ({ service_key: s.service_key, pct_change: s.pct_change }))
				: [],
			stable_count: r?.stable_count ?? 0,
			total_tracked: r?.total_tracked ?? 0,
			period: r?.period || '24h',
		}),
	},


	// ── Symbol Availability Common Scan (USE-053) ────────────────────────────
	// Pays $0.005 USDC every 30 min to POST /api/x402/symbol-availability with
	// the 5 highest-demand meme token symbols: MOON, ROCKET, FROG, CAT, DOG.
	// The batch endpoint checks each against pump_agent_mints for exact collisions
	// and returns { available_count, taken_count, available_list, headline } — the
	// 2026-07-08 storefront cleanup (prompt 18) removed the bullish/bearish/neutral
	// `signal` field from the wire response (it's a collision checker, not a market
	// oracle), so this consumer now derives its own coarse bucket locally from the
	// available/scanned ratio, same thresholds the endpoint used to apply. As an
	// `oracle` entry the bucket + headline dedup into oracle_intel_signals (topic
	// 'symbol_availability') — actionable for the sniper gate: many available
	// high-demand names = underexploited launch window; all taken = market
	// saturated, raise launch-entry threshold. Cooldown 1800s (30 min) — symbol
	// availability changes slowly as new mints land; 48 calls/day × $0.005 =
	// $0.24/day, well under the loop's $5/day cap. Downstream: oracle_intel_signals
	// WHERE topic = 'symbol_availability' + the full batch breakdown in
	// x402_autonomous_log.signal_data.
	{
		id: 'symbol-scan-common',
		name: 'Symbol Availability: Common Meme Scan',
		path: '/api/x402/symbol-availability',
		method: 'POST',
		body: { symbols: ['MOON', 'ROCKET', 'FROG', 'CAT', 'DOG'] },
		cooldown_s: 1800,
		priority: 86,
		pipeline: 'oracle',
		enabled: true,
		extractSignal: (r) => {
			const available = r?.available_count ?? 0;
			const scanned = r?.scanned_count ?? 0;
			const ratio = scanned > 0 ? available / scanned : 0;
			const signal = ratio >= 0.6 ? 'bullish' : ratio >= 0.3 ? 'neutral' : 'bearish';
			return {
				topic: 'symbol_availability',
				signal,
				headline: r?.headline ?? null,
				confidence: signal === 'bullish' ? 0.85 : signal === 'neutral' ? 0.65 : 0.80,
				available_count: r?.available_count ?? null,
				taken_count: r?.taken_count ?? null,
				scanned_count: r?.scanned_count ?? null,
				available_list: Array.isArray(r?.available_list) ? r.available_list : [],
				taken_list: Array.isArray(r?.taken_list) ? r.taken_list : [],
			};
		},
	},

	// ── Bazaar New-Listing Feed (USE-059) ──────────────────────────────────────
	// Pays $0.001 USDC to /api/x402/bazaar-feed every 30 min (filter "new", limit 10)
	// to retrieve the 10 newest service listings from the platform's own
	// bazaar_service_index registry. Extracts { count, newest_id, newest_price,
	// categories } for the signal log. As an `oracle` entry the listing-velocity
	// signal (spike/active/quiet) + category rollup dedup into oracle_intel_signals
	// (topic 'bazaar_new_listings') so downstream consumers can detect agent
	// marketing bursts. Cooldown 1800s (30 min) — matches the task spec and the
	// signal's update frequency. Spend: $0.001 x 48/day = $0.048/day.
	{
		id: 'bazaar-new-listings',
		name: 'Bazaar New-Listing Feed',
		path: '/api/x402/bazaar-feed',
		method: 'POST',
		body: { filter: 'new', limit: 10 },
		cooldown_s: 1800, // 30 min — listing-spike detection cadence
		priority: 72,
		pipeline: 'oracle',
		enabled: true,
		extractSignal: (r) => {
			const newest = r && r.newest;
			const activity = (r && r.activity) || {};
			const categories = Array.isArray(r && r.categories) ? r.categories : [];
			return {
				topic: 'bazaar_new_listings',
				signal: activity.signal || null,
				headline: activity.headline || null,
				confidence: activity.confidence ?? null,
				count: r && typeof r.count === 'number' ? r.count : null,
				new_24h: activity.new_24h ?? null,
				new_7d: activity.new_7d ?? null,
				daily_avg_7d: activity.daily_avg_7d ?? null,
				newest_id: newest ? newest.id : null,
				newest_price: newest ? newest.price_atomic : null,
				categories: categories.slice(0, 5).map((c) => c.tag),
			};
		},
	},

	// ── Skill Marketplace Price Distribution (USE-056) ───────────────────────────
	// Pays $0.001 USDC every 5 min to POST /api/x402/skill-marketplace with body
	// { mode: "price_distribution" }. Computes marketplace-wide pricing statistics
	// from all active agent_skill_prices listings: min, max, and median active
	// listing price (USDC float + atomics) plus total listing count and distinct
	// skill count. As an `oracle` entry the latest snapshot dedups into
	// oracle_intel_signals (topic 'skill_marketplace_prices') so the sniper gate
	// and ops can query a single row for current marketplace health.
	// storeValue runs a week-over-week price floor erosion check: it queries the
	// most recent x402_autonomous_log oracle snapshot from ≥6 days ago and, if the
	// median has dropped >20%, raises a Redis alert (x402:skill-market:price-floor-
	// alert, 24h TTL) so ops can investigate a race to zero before it collapses
	// the marketplace. Cooldown 300s → 288 reads/day × $0.001 = $0.288/day.
	{
		id: 'skill-marketplace-price-distribution',
		name: 'Skill Marketplace Price Distribution',
		path: '/api/x402/skill-marketplace',
		method: 'POST',
		body: { mode: 'price_distribution' },
		cooldown_s: 300,
		priority: 85,
		pipeline: 'oracle',
		enabled: true,
		extractSignal: (r) => {
			const skillCount = r?.skill_count ?? 0;
			const medianPrice = typeof r?.median_price === 'number' ? r.median_price : null;
			const signal = skillCount >= 10 ? 'healthy' : skillCount > 0 ? 'thin' : 'empty';
			const medianDisplay = medianPrice != null ? `$${medianPrice.toFixed(4)}` : '?';
			const headline = skillCount > 0
				? `Skill market: ${skillCount} active listings, median ${medianDisplay} USDC`
				: 'No active skill listings in marketplace';
			return {
				topic: 'skill_marketplace_prices',
				signal,
				headline,
				confidence: 1.0,
				min_price: r?.min_price ?? null,
				max_price: r?.max_price ?? null,
				median_price: medianPrice,
				skill_count: skillCount,
				distinct_skills: r?.distinct_skills ?? null,
			};
		},
		storeValue: async ({ sql: sqlClient, redis, signalData }) => {
			if (!sqlClient || typeof signalData?.median_price !== 'number') return;
			const currentMedian = signalData.median_price;
			if (currentMedian <= 0) return;
			try {
				const [prev] = await sqlClient`
					SELECT (signal_data->>'median_price')::numeric AS prev_median
					  FROM x402_autonomous_log
					 WHERE endpoint_url LIKE '%/api/x402/skill-marketplace'
					   AND pipeline = 'oracle'
					   AND ts < now() - interval '6 days'
					 ORDER BY ts DESC
					 LIMIT 1
				`;
				if (!prev?.prev_median) return;
				const prevMedian = Number(prev.prev_median);
				if (!prevMedian || prevMedian <= 0) return;
				const changePct = (currentMedian - prevMedian) / prevMedian;
				const ALERT_KEY = 'x402:skill-market:price-floor-alert';
				if (changePct < -0.20 && redis) {
					await redis.set(
						ALERT_KEY,
						JSON.stringify({
							current_median: currentMedian,
							prev_median: prevMedian,
							change_pct: changePct,
							ts: new Date().toISOString(),
						}),
						{ ex: 86400 },
					);
					console.warn(
						`[x402/skill-market] ALERT: price floor erosion detected ` +
						`(median $${currentMedian.toFixed(4)} vs $${prevMedian.toFixed(4)} ` +
						`week-ago, ${(changePct * 100).toFixed(1)}% change)`,
					);
				} else if (redis) {
					await redis.del(ALERT_KEY).catch(() => {});
				}
			} catch (err) {
				console.warn(`[x402/skill-market] floor-erosion check failed: ${err?.message || err}`);
			}
		},
	},

	// ── Club Membership Snapshot (USE-066) ─────────────────────────────────────
	// Pays the $0.01 USDC club cover (POST snapshot mode) once a day to take a
	// growth/churn snapshot of the three_holders club, read live off the club
	// ledger: { member_count, active_last_7d, new_this_week } plus a classified
	// signal (growing / stable / churning / empty). As an `oracle` entry the
	// latest snapshot dedups into oracle_intel_signals under topic
	// 'club:three_holders' — a club-membership topic the sniper macro gate ignores
	// (it reads only solana/bitcoin/pump) so it never pollutes trade decisions —
	// giving any dashboard a single queryable row for current club health. The
	// full snapshot also lands in x402_autonomous_log.signal_data every run, so
	// the day-over-day growth/churn trend is reconstructable from the log alone.
	// Daily cadence → one paid snapshot/day ≈ $0.01/day, well under the loop cap.
	{
		id: 'club-membership-snapshot',
		name: 'Club Membership Snapshot (three_holders)',
		path: '/api/x402/club-cover',
		method: 'POST',
		body: { club: 'three_holders', mode: 'snapshot' },
		cooldown_s: 86400, // daily — membership growth/churn is a slow-moving signal
		priority: 86,
		pipeline: 'oracle',
		enabled: true,
		extractSignal: (r) => ({
			topic: 'club:three_holders',
			club: r?.club ?? 'three_holders',
			member_count: r?.member_count ?? null,
			active_last_7d: r?.active_last_7d ?? null,
			new_this_week: r?.new_this_week ?? null,
			growth_rate: r?.growth_rate ?? null,
			active_rate: r?.active_rate ?? null,
			signal: r?.signal ?? null,
			headline: r?.headline ?? null,
			confidence: r?.confidence ?? null,
		}),
	},

	// ── Volume / Activity Feed (keep the live feed alive) ─────────────────────
	{
		id: 'dance-tip-vol-1',
		name: 'Dance Tip Volume: Dancer 1',
		path: '/api/x402/dance-tip',
		method: 'POST',
		body: { dancer: '1', dance: 'hiphop' },
		cooldown_s: 120,
		priority: 70,
		pipeline: 'volume',
		enabled: true,
		extractSignal: null,
	},
	{
		id: 'dance-tip-vol-2',
		name: 'Dance Tip Volume: Dancer 2',
		path: '/api/x402/dance-tip',
		method: 'POST',
		body: { dancer: '2', dance: 'rumba' },
		cooldown_s: 120,
		priority: 70,
		pipeline: 'volume',
		enabled: true,
		extractSignal: null,
	},
	{
		id: 'dance-tip-vol-3',
		name: 'Dance Tip Volume: Thriller',
		path: '/api/x402/dance-tip',
		method: 'POST',
		body: { dancer: '3', dance: 'thriller' },
		cooldown_s: 120,
		priority: 65,
		pipeline: 'volume',
		enabled: true,
		extractSignal: null,
	},
	{
		id: 'cosmetic-purchase-test',
		name: 'Cosmetic Purchase Health Check',
		path: '/api/x402/cosmetic-purchase',
		method: 'POST',
		body: { item: 'canary_test', quantity: 1, _health_check: true },
		cooldown_s: 1800,
		priority: 40,
		pipeline: 'health',
		enabled: true,
		extractSignal: (r) => ({ purchase_id: r?.purchase_id, item: r?.item }),
	},

	// ── Health Checks (verify each x402 endpoint is live) ─────────────────────
	{
		id: 'health-crypto-intel',
		name: 'Health: crypto-intel',
		path: '/api/x402/crypto-intel',
		method: 'POST',
		body: { topic: 'xrp' },
		cooldown_s: 300,
		priority: 50,
		pipeline: 'health',
		enabled: true,
		extractSignal: (r) => ({ alive: !!r?.signal, topic: r?.topic }),
	},
	{
		id: 'health-token-intel',
		name: 'Health: token-intel',
		path: '/api/x402/token-intel',
		method: 'POST',
		// Canary: well-known USDC mint — stable, always has data.
		body: { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', network: 'mainnet' },
		cooldown_s: 600,
		priority: 55,
		pipeline: 'health',
		enabled: true,
		extractSignal: (r) => ({ alive: !!r?.symbol, symbol: r?.symbol, holders: r?.holders }),
	},
	{
		id: 'health-skill-marketplace',
		name: 'Health: skill-marketplace',
		path: '/api/x402/skill-marketplace',
		method: 'GET',
		body: null,
		cooldown_s: 600,
		priority: 45,
		pipeline: 'health',
		enabled: true,
		extractSignal: (r) => ({ alive: Array.isArray(r?.skills), count: r?.skills?.length }),
	},
	// ── Skill Marketplace: Canary Execute (USE-058) ───────────────────────────
	// Pays $0.001 USDC every 5 minutes to POST /api/x402/skill-marketplace with
	// mode:"canary_execute" / skill:"echo_test". The endpoint exercises the
	// skill execution path in-process (no external I/O) and returns within the
	// 2-second SLA. If executed===false or latency_ms > 2000, the slow flag
	// fires and ops can investigate skill execution performance before users do.
	{
		id: 'skill-marketplace-canary-execute',
		name: 'Skill Marketplace: Canary Execute (echo_test)',
		path: '/api/x402/skill-marketplace',
		method: 'POST',
		body: { mode: 'canary_execute', skill: 'echo_test' },
		cooldown_s: 300,
		priority: 52,
		pipeline: 'health',
		enabled: true,
		extractSignal: (r) => ({
			executed: r?.executed === true,
			skill: r?.skill ?? 'echo_test',
			latency_ms: r?.latency_ms ?? null,
			output: r?.output ?? null,
			slow: typeof r?.latency_ms === 'number' && r.latency_ms > 2000,
		}),
	},
	// ── Pay-By-Name Resolution Health (USE-054) ───────────────────────────────
	// Canary in front of the name → on-chain address resolver that every "send
	// USDC to a name" flow depends on (SDK payByName(), /pay studio, profile pay
	// button). Every 10 min run() resolves a KNOWN name — the platform's own SNS
	// parent domain (<PARENT_LABEL>.sol) via the FREE GET resolve path — and
	// asserts the registry returns a valid, on-curve Solana wallet (and, when
	// X402_PAY_BY_NAME_EXPECTED_ADDRESS is set, that it MATCHES that wallet — an
	// anti-poisoning check that catches the domain repointing between deploys).
	// The resolve path is free, so this moves no funds (amountAtomic always 0);
	// run() owns the OK/verified classification so a 404 is recorded as unhealthy
	// rather than the generic loop's false "free success". Value sink:
	// pay_by_name_resolution_log (time-series) + Redis x402:pay-by-name:{latest,
	// alert}. Full implementation in ./pipelines/pay-by-name-resolver.js.
	{
		id: 'pay-by-name-resolution',
		name: 'Pay-By-Name Resolution Health',
		// path is informational — run() owns the free GET resolve call itself.
		path: '/api/x402/pay-by-name',
		method: 'GET',
		body: null,
		price_atomic: 0, // free resolve-only read — never pays
		cooldown_s: 600, // every 10 min
		priority: 45,
		pipeline: 'health',
		enabled: true,
		run: (ctx) => runPayByNameResolution(ctx),
		extractSignal: null,
	},

	// ── Pay-By-Name x402 Registry Canary (USE-054) ────────────────────────────
	// Pays $0.001 USDC every 10 min to POST /api/x402/pay-by-name with
	// { name: 'three.ws' } — a real x402 call through the paid name-resolution
	// mode. The endpoint resolves 'three.ws' through the username registry, SNS
	// domain chain, and raw-address pass-through in order, then returns
	// { data: { name, address, verified, source } }. verified=true confirms the
	// resolved address is a valid on-curve Solana wallet. This is the PAID
	// complement to the free GET health check above: the free check verifies the
	// resolver returns a result; this paid call validates the entire
	// 402→verify→settle→resolve pipeline is live end-to-end with a real on-chain
	// USDC payment. extractSignal lifts { name, address, verified, source } into
	// x402_autonomous_log.signal_data — the actionable signal that confirms the
	// registry is both alive and resolving to the correct wallet. Cooldown 600s
	// → 144 calls/day ≈ $0.144/day, bounded by the loop's daily cap.
	{
		id: 'pay-by-name-resolve-three-ws',
		name: 'Pay-By-Name: Resolve three.ws (paid canary)',
		path: '/api/x402/pay-by-name',
		method: 'POST',
		body: { name: 'three.ws' },
		cooldown_s: 600, // every 10 min — health check cadence
		priority: 52,
		pipeline: 'health',
		enabled: true,
		extractSignal: (r) => ({
			name: r?.data?.name ?? null,
			address: r?.data?.address ?? null,
			verified: r?.data?.verified ?? false,
			source: r?.data?.source ?? null,
		}),
	},

	{
		id: 'health-agent-reputation',
		name: 'Health: agent-reputation',
		path: '/api/x402/agent-reputation',
		method: 'GET',
		body: null,
		cooldown_s: 600,
		priority: 50,
		pipeline: 'health',
		enabled: true,
		extractSignal: (r) => ({ alive: r !== null }),
	},

	// ── Active Agent Reputation Sweep (USE-055) ───────────────────────────────
	// Pays one real $0.01 USDC call to the POST sweep mode of
	// /api/x402/agent-reputation, scoring the 20 most recently active three.ws
	// agents in a single request (vs paying per agent). The endpoint synthesizes
	// each 0..100 trust score from real on-chain pump.fun agent-payments activity,
	// distribute/buyback success, and signed Solana attestations. extractSignal
	// lifts { count, avg_score, flagged_count } + the flagged agent ids into
	// x402_autonomous_log.signal_data so platform-trust monitoring (and ops) can
	// watch the fleet's average reputation and catch a spike in low-trust agents
	// (score < 30) straight off the autonomous log. Cooldown 1800s (30 min) →
	// reputation is a slow-moving, audit-style signal; ≤ $0.48/day, well under
	// the loop's daily cap.
	{
		id: 'agent-reputation-active-sweep',
		name: 'Active Agent Reputation Sweep',
		path: '/api/x402/agent-reputation',
		method: 'POST',
		body: { mode: 'sweep', limit: 20 },
		cooldown_s: 1800,
		priority: 58,
		pipeline: 'health',
		enabled: true,
		extractSignal: (r) => ({
			count: r?.count ?? 0,
			avg_score: r?.avg_score ?? null,
			flagged_count: r?.flagged_count ?? 0,
			flagged_agent_ids: Array.isArray(r?.flagged)
				? r.flagged.map((a) => a?.agent_id).filter(Boolean)
				: [],
		}),
	},

	// ── Reputation Score Decay Monitor (USE-070) ──────────────────────────────
	// Pays $0.01 USDC every 30 min to POST /api/x402/agent-reputation with
	// { mode: 'decay_report' }. The endpoint snapshots current trust scores
	// (from agent_reputation_scores) into agent_reputation_score_history, then
	// finds agents whose score dropped >10 points vs their baseline >= 5 days ago.
	// A spike in decayed_count or a sharp fastest_decline_agent.decay indicates
	// coordinated abuse, score manipulation, or a systemic failure in the
	// distribution/buyback pipeline. As an 'oracle' entry the signal upserts into
	// oracle_intel_signals (topic 'reputation_decay_monitor') so any downstream
	// trust consumer can read the latest decay verdict without re-querying.
	// extractSignal lifts { decayed_count, fastest_decline_agent, avg_decay } into
	// x402_autonomous_log.signal_data. Meaningful comparisons emerge after 5 days
	// of history; until then has_baseline=false is recorded. Cooldown 1800s -> 48
	// snapshots/day ~= $0.48/day, well within the loop's daily cap.
	{
		id: 'reputation-decay-monitor',
		name: 'Reputation Score Decay Monitor',
		path: '/api/x402/agent-reputation',
		method: 'POST',
		body: { mode: 'decay_report' },
		cooldown_s: 1800,
		priority: 85,
		pipeline: 'oracle',
		enabled: true,
		extractSignal: (r) => {
			const decayedCount = r?.decayed_count ?? 0;
			const avgDecay = r?.avg_decay ?? 0;
			const top = r?.fastest_decline_agent ?? null;
			const hasBaseline = r?.has_baseline ?? false;
			const signal = !hasBaseline
				? 'neutral'
				: decayedCount > 5
					? 'alert'
					: decayedCount > 0
						? 'warning'
						: 'normal';
			const headline = !hasBaseline
				? 'Reputation decay monitor: building 5-day baseline'
				: decayedCount > 0
					? decayedCount + ' agent(s) with >10pt score decay; avg drop ' + avgDecay + 'pts' +
					  (top ? '; worst: ' + (top.name || top.agent_id) + ' (-' + top.decay + 'pts)' : '')
					: 'No significant reputation decay detected';
			return {
				topic: 'reputation_decay_monitor',
				signal,
				headline,
				confidence: hasBaseline ? 0.9 : 0.3,
				decayed_count: decayedCount,
				avg_decay: avgDecay,
				fastest_decline_agent: top
					? { agent_id: top.agent_id, name: top.name || null, decay: top.decay }
					: null,
				has_baseline: hasBaseline,
			};
		},
	},

	// ── Agent Reputation Leaderboard (USE-071) ─────────────────────────────────
	// Pays $0.01 USDC every 30 min to POST /api/x402/agent-reputation with
	// { mode: 'leaderboard', limit: 10 }. The endpoint ranks the 10 most recently
	// active three.ws agents by on-chain behavioral trust score (synthesized from
	// pump.fun agent-payments activity, distribution/buyback success, and signed
	// Solana attestations). As an `oracle` entry the loop upserts the verdict into
	// oracle_intel_signals (topic 'agent_reputation_leaderboard') for any downstream
	// consumer — marketplace promotion, partnership outreach, skill routing.
	// storeValue appends the full ranked list to agent_reputation_leaderboard_snapshots
	// (time-series for trend analysis) and writes the top agent IDs to Redis key
	// x402:rep-leaderboard:top-agent-ids (TTL 2h) so the marketplace recommended sort
	// can promote them without a DB round-trip. extractSignal lifts
	// { count, avg_score, top_agent_id, top_score, agents } into
	// x402_autonomous_log.signal_data. Cooldown 1800s → 48 snapshots/day ≈ $0.48/day,
	// well under the loop's daily cap. Reputation is slow-moving (audit-style);
	// 30-min cadence gives fresh signal without over-spending.
	{
		id: 'agent-reputation-leaderboard',
		name: 'Agent Reputation Leaderboard (Top 10)',
		path: '/api/x402/agent-reputation',
		method: 'POST',
		body: { mode: 'leaderboard', limit: 10 },
		cooldown_s: 1800,
		priority: 87,
		pipeline: 'oracle',
		enabled: true,
		extractSignal: (r) => {
			const agents = Array.isArray(r?.agents) ? r.agents : [];
			const top = agents[0] ?? null;
			const count = r?.count ?? agents.length;
			const avgScore = r?.avg_score ?? null;
			const topScore = top?.score ?? null;
			const topName = top?.name ?? null;
			const topId = top?.agent_id ?? null;
			const signal = count > 0 ? 'live' : 'quiet';
			const headline = top
				? `${topName || 'Agent'} leads reputation at score ${topScore} (${count} ranked)`
				: 'No agents in reputation leaderboard';
			return {
				topic: 'agent_reputation_leaderboard',
				signal,
				headline,
				confidence: count > 0 ? 0.95 : 0.5,
				count,
				avg_score: avgScore,
				top_agent_id: topId,
				top_agent_name: topName,
				top_score: topScore,
				agents: agents.slice(0, 10).map((a) => ({
					agent_id: a.agent_id,
					name: a.name ?? null,
					score: a.score,
					rank: a.rank,
					flagged: a.flagged ?? false,
				})),
			};
		},
		storeValue: async ({ sql: sqlClient, redis, signalData, runId }) => {
			if (!sqlClient) return;
			const v = signalData || {};
			const agents = Array.isArray(v.agents) ? v.agents : [];
			// Ensure snapshot table (idempotent DDL guard, one-per-warm-instance).
			try {
				await sqlClient`
					CREATE TABLE IF NOT EXISTS agent_reputation_leaderboard_snapshots (
						id              bigserial PRIMARY KEY,
						ts              timestamptz NOT NULL DEFAULT now(),
						run_id          uuid,
						count           int,
						avg_score       numeric(5,1),
						top_agent_id    uuid,
						top_agent_name  text,
						top_score       numeric(5,1),
						agents          jsonb NOT NULL DEFAULT '[]'::jsonb
					)
				`;
				await sqlClient`
					CREATE INDEX IF NOT EXISTS arls_ts_desc
						ON agent_reputation_leaderboard_snapshots (ts DESC)
				`;
			} catch (err) {
				console.warn('[x402/rep-leaderboard] schema ensure failed:', err?.message);
				return;
			}
			// Insert snapshot row.
			try {
				const topId = typeof v.top_agent_id === 'string' && v.top_agent_id
					? v.top_agent_id
					: null;
				await sqlClient`
					INSERT INTO agent_reputation_leaderboard_snapshots
						(run_id, count, avg_score, top_agent_id, top_agent_name, top_score, agents)
					VALUES
						(${runId || null}, ${v.count ?? 0}, ${v.avg_score ?? null},
						 ${topId}, ${v.top_agent_name ?? null}, ${v.top_score ?? null},
						 ${JSON.stringify(agents)}::jsonb)
				`;
			} catch (err) {
				console.warn('[x402/rep-leaderboard] snapshot insert failed:', err?.message);
			}
			// Cache top agent IDs in Redis for marketplace promotion (2h TTL,
			// refreshed every 30min by this entry's cooldown cadence).
			if (redis && agents.length > 0) {
				try {
					const topIds = agents.map((a) => a.agent_id).filter(Boolean);
					await redis.set(
						'x402:rep-leaderboard:top-agent-ids',
						JSON.stringify(topIds),
						{ ex: 7200 },
					);
				} catch (err) {
					console.warn('[x402/rep-leaderboard] redis write failed:', err?.message);
				}
			}
		},
	},

	{
		id: 'health-symbol-avail',
		name: 'Health: symbol-availability',
		path: '/api/x402/symbol-availability',
		method: 'POST',
		body: { symbol: 'HEALTH' },
		cooldown_s: 900,
		priority: 40,
		pipeline: 'health',
		enabled: true,
		extractSignal: (r) => ({ available: r?.available }),
	},
	{
		id: 'health-fact-check',
		name: 'Health: fact-check',
		path: '/api/x402/fact-check',
		method: 'POST',
		body: { claim: 'The sky is blue' },
		cooldown_s: 1800,
		priority: 40,
		pipeline: 'health',
		enabled: true,
		extractSignal: (r) => ({ alive: !!r?.verdict, verdict: r?.verdict }),
	},

	// ── Spend Session Canary (USE-065) ──────────────────────────────────────────
	// The most important health check for the x402 governance layer. Pays $0.01
	// USDC to /api/x402/spend-session (mode:canary) every 5 min. The x402 payment
	// proves the settlement path is alive; the handler writes a canary row to
	// spend_session_health_log and immediately marks it consumed — exercising the
	// full DB create→consume lifecycle. extractSignal lifts { created, consumed,
	// latency_ms } into x402_autonomous_log.signal_data. A created:false means the
	// DB write path is down; a consumed:false means the update path is down. Either
	// is a governance-layer alert. Cooldown 300s → 12 probes/hr × $0.01 = $0.12/hr
	// at full pace; in practice the loop budget keeps spend well under the cap.
	// Health pipeline — not oracle (no sniper signal; this is platform infra health).
	{
		id: 'spend-session-canary',
		name: 'Spend Session Canary',
		path: '/api/x402/spend-session',
		method: 'POST',
		body: { mode: 'canary', budget: 0.01 },
		cooldown_s: 300,
		priority: 55,
		pipeline: 'health',
		enabled: true,
		extractSignal: (r) => ({
			created: r?.created ?? null,
			consumed: r?.consumed ?? null,
			latency_ms: r?.latency_ms ?? null,
			session_id: r?.session_id ?? null,
			budget: r?.budget ?? null,
		}),
	},

	// ── Spend Session Active Audit (USE-064) ─────────────────────────────────────
	// Pays $0.01 USDC every 15 min to /api/x402/spend-session (mode:audit) for a
	// live aggregate snapshot of all payment sessions: active count, total remaining
	// budget, exhausted count, and expired sessions in the last 24h. extractSignal
	// lifts { active_count, total_budget_remaining_usdc, expired_count_24h } into
	// x402_autonomous_log.signal_data. A spike in expired_count_24h signals that
	// something is preventing session cleanup (background sweep not running, DB lock,
	// etc.) and a Redis alert is raised so ops can investigate before sessions
	// accumulate as zombie rows. Cooldown 900s → 4 probes/hr × $0.01 = $0.04/hr,
	// well under the loop's daily cap. Health pipeline — this is governance telemetry,
	// not a trading signal, so it does not upsert into oracle_intel_signals.
	{
		id: 'spend-session-active-audit',
		name: 'Spend Session Active Audit',
		path: '/api/x402/spend-session',
		method: 'POST',
		body: { mode: 'audit' },
		cooldown_s: 900, // 15 min — session state is slow-moving governance telemetry
		priority: 52,
		pipeline: 'health',
		enabled: true,
		extractSignal: (r) => ({
			active_count: r?.active_count ?? null,
			exhausted_count: r?.exhausted_count ?? null,
			expired_count_24h: r?.expired_count_24h ?? null,
			total_budget_remaining_usdc: r?.total_budget_remaining_usdc ?? null,
			avg_budget_remaining_usd: r?.avg_budget_remaining_usd ?? null,
			total_spent_usdc: r?.total_spent_usdc ?? null,
		}),
		storeValue: async ({ redis, signalData }) => {
			if (!redis) return;
			const v = signalData || {};
			const EXPIRED_SPIKE_KEY = 'x402:spend-session:expired-spike-alert';
			const EXPIRED_SPIKE_TTL_S = 25 * 60;
			const EXPIRED_SPIKE_THRESHOLD = 10;
			const expiredCount = typeof v.expired_count_24h === 'number' ? v.expired_count_24h : null;
			try {
				if (expiredCount !== null && expiredCount >= EXPIRED_SPIKE_THRESHOLD) {
					await redis.set(
						EXPIRED_SPIKE_KEY,
						JSON.stringify({
							expired_count_24h: expiredCount,
							active_count: v.active_count ?? null,
							exhausted_count: v.exhausted_count ?? null,
							ts: new Date().toISOString(),
						}),
						{ ex: EXPIRED_SPIKE_TTL_S },
					);
					console.warn(
						`[x402/spend-session-audit] ALERT: expired_count_24h=${expiredCount} ` +
							`(threshold ${EXPIRED_SPIKE_THRESHOLD}) — session cleanup may be failing`,
					);
				} else if (expiredCount !== null) {
					await redis.del(EXPIRED_SPIKE_KEY).catch(() => {});
				}
			} catch (err) {
				console.warn(`[x402/spend-session-audit] alert write failed: ${err?.message || err}`);
			}
		},
	},

	// MCP Model Validation Sweep — picks the longest-unvalidated public GLB from
	// the avatars table, runs glTF-Transform inspection, and upserts a quality
	// score row to model_quality_scores. Each tick advances the sweep by one avatar.
	// Cooldown 300 s → 12 models/hour; a library of 100 models is fully covered
	// within ~8 hours and re-validated on a 24-hour rolling basis.
	// Downstream consumer: model_quality_scores → explore quality badges and
	// curation pipelines that surface models needing attention.
	{
		id: 'mcp-model-validation-sweep',
		name: 'MCP Model Validation Sweep',
		path: '/api/x402/model-validation-sweep',
		method: 'POST',
		body: {},
		cooldown_s: 300,
		priority: 45,
		pipeline: 'health',
		enabled: true,
		extractSignal: (r) => ({
			avatar_id: r?.avatar_id || null,
			score: r?.score ?? null,
			has_errors: r?.has_errors ?? null,
			missing_bones: r?.missing_bones ?? null,
			skipped: r?.skipped ?? false,
		}),
	},

	// ── MCP Tool Catalog Sync Probe (USE-061) ────────────────────────────────
	// Pays $0.001 USDC hourly to POST /api/x402/mcp-tool-catalog with
	// body { mode: 'sync' }, which runs the live catalog diff/persist logic
	// (the endpoint defaults 'sync' to discover mode) and returns
	// { total_tools, removed_tools[], new_tools[], changed_tools[], ts }.
	// extractSignal maps to { tool_count, missing_count, last_sync }:
	//   tool_count    = live advertised catalog size
	//   missing_count = count of registered-but-vanished tools (the
	//                   degradation signal — endpoint logged + deactivated
	//                   them in mcp_tool_registry)
	//   last_sync     = the sync timestamp
	// A non-zero missing_count means a deploy silently dropped a capability
	// agents may already depend on. Hourly cadence → ≤24 probes/day ≈
	// $0.024/day, bounded by the daily cap.
	// Downstream: mcp_tool_registry — feature-flag source agents read to
	// discover newly-shipped MCP capabilities.
	{
		id: 'mcp-tool-catalog-sync',
		name: 'MCP Tool Catalog Sync Probe',
		path: '/api/x402/mcp-tool-catalog',
		method: 'POST',
		body: { mode: 'sync' },
		cooldown_s: 3600, // hourly — MCP catalog changes only on deploy
		priority: 54,
		pipeline: 'health',
		enabled: true,
		extractSignal: (r) => ({
			tool_count: r?.total_tools ?? null,
			missing_count: Array.isArray(r?.removed_tools) ? r.removed_tools.length : 0,
			last_sync: r?.ts ?? null,
			new_count: Array.isArray(r?.new_tools) ? r.new_tools.length : 0,
			changed_count: Array.isArray(r?.changed_tools) ? r.changed_tools.length : 0,
			priced_tools: r?.priced_tools ?? null,
			removed_tools: Array.isArray(r?.removed_tools) ? r.removed_tools : [],
		}),
	},

	// ── Notification Delivery Probe (USE-079) ────────────────────────────────
	// Pays $0.001 USDC every 5 min to POST /api/x402/notify with a `canary`
	// channel heartbeat message. The endpoint records the notification to
	// canary_notification_log, measuring time-to-DB-insert as the delivery
	// latency. extractSignal lifts { delivered, channel, latency_ms } into
	// x402_autonomous_log.signal_data — the actionable signal that confirms the
	// notification subsystem is alive within a 2-second SLA. delivered=false or
	// latency_ms > 2000 indicates a degraded delivery path. Cooldown 300s →
	// 288 probes/day ≈ $0.288/day, well inside the loop's daily cap.
	{
		id: 'notify-delivery-probe',
		name: 'Notification Delivery Probe (canary heartbeat)',
		path: '/api/x402/notify',
		method: 'POST',
		body: { channel: 'canary', message: 'x402 loop heartbeat', priority: 'low' },
		cooldown_s: 300, // 5 min — frequent enough to catch delivery regressions fast
		priority: 52,
		pipeline: 'health',
		enabled: true,
		extractSignal: (r) => ({
			delivered: r?.delivered ?? false,
			channel: r?.channel ?? null,
			latency_ms: r?.latency_ms ?? null,
			notification_id: r?.notification_id ?? null,
			within_sla: typeof r?.latency_ms === 'number' ? r.latency_ms <= 2000 : null,
		}),
	},

	// ── MCP Health: Solana agent registration canary ──────────────────────────
	// Verifies the server-custodial Solana registration subsystem end-to-end by
	// resolving a known canary agent's on-chain Metaplex Agent Registry record
	// (Identity PDA + Core asset) and confirming both accounts still exist
	// on-chain. The endpoint owns the verification + persists the canonical
	// health row to mcp_health_canary; this loop pays the $0.001 canary fee,
	// records the call to x402_autonomous_log, and respects the 6h cooldown
	// (4 probes/day). extractSignal lifts the health verdict into signal_data so
	// a status dashboard can read it straight off the autonomous log too.
	{
		id: 'mcp-solana-register-health',
		name: 'MCP Health: Solana agent registration',
		path: '/api/x402/solana-register-health',
		method: 'GET',
		body: null,
		cooldown_s: 21600, // 6h — registration is a slow-changing subsystem
		priority: 55,
		pipeline: 'health',
		enabled: true,
		extractSignal: (r) => ({
			alive: r?.healthy === true,
			tool: r?.tool || 'solana_register',
			network: r?.network || null,
			canary_agent_id: r?.canary_agent_id || null,
			asset: r?.asset || null,
			identity_pda: r?.identity_pda || null,
			registry_enrolled: r?.checks?.registry_enrolled === true,
			asset_onchain: r?.checks?.asset_onchain === true,
			identity_pda_onchain: r?.checks?.identity_pda_onchain === true,
			consecutive_failures: r?.consecutive_failures ?? null,
			rpc_latency_ms: r?.rpc_latency_ms ?? null,
		}),
	},

	// SSE Streaming MCP Health (USE-010): pays $0.01 USDC for a single priced
	// tools/call (validate_model on a tiny public canary GLB) against POST /api/mcp
	// in SSE mode (Accept: text/event-stream), then reads the paid response as a
	// STREAM to verify the streaming transport is intact before close — measuring
	// time-to-first-byte, inter-chunk gaps, chunk count and total bytes, and
	// flagging stalled streams, dropped connections, or broken chunked encoding.
	// run() owns the probe/pay/stream-read; the loop records one x402_autonomous_log
	// row (verdict in signal_data) and run() also persists the streaming-integrity
	// metrics to mcp_stream_health (the value sink the status surface + ops alerts
	// consume; complements the latency percentiles the MCP Latency Monitor writes
	// to x402_perf_log). Cooldown 300s → one paid probe every ~5 min ≈ $2.88/day at
	// $0.01, well under the loop's daily cap. The MCP server has no $0.001 tool, so
	// the minimum priced lightweight tool (validate_model, $0.01) governs the spend.
	{
		id: 'mcp-sse-stream-health',
		name: 'SSE Streaming MCP Health',
		// path is informational — runStreamingMcpHealth() probes + settles itself.
		path: '/api/mcp',
		method: 'POST',
		body: null,
		cooldown_s: 300,
		priority: 52,
		pipeline: 'health',
		enabled: true,
		run: runStreamingMcpHealth,
	},

	// ── MCP Observability: Tool Latency Monitor (USE-006) ─────────────────────
	// Every 5 min the loop makes ONE real x402 payment to /api/mcp — a
	// validate_model canary against a tiny, stable, public Khronos sample GLB.
	// That paid round-trip exercises the full paid MCP path (auth → price → pay →
	// settle → dispatch) and is recorded to x402_autonomous_log like every other
	// call. storeValue then runs the latency sweep (mcp-latency-sweep.js): it
	// lists every advertised tool and probes each with an unpaid, side-effect-free
	// tools/call, timing the caller-observed first response, then writes rolling
	// p50/p95/p99 per tool to x402_perf_log and alerts when any tool's p95 > 2s.
	// Downstream consumer: GET /api/x402/mcp-perf (the ops SLA dashboard) reads
	// x402_perf_log for live health + breach state.
	{
		id: 'mcp-latency-monitor',
		name: 'MCP Tool Latency Monitor',
		path: '/api/mcp',
		method: 'POST',
		body: {
			jsonrpc: '2.0',
			id: 'mcp-perf-canary',
			method: 'tools/call',
			params: {
				name: 'validate_model',
				arguments: { url: MCP_PERF_CANARY_MODEL, max_issues: 1 },
			},
		},
		cooldown_s: 300, // 5 min — matches the monitor's described schedule
		priority: 52,
		pipeline: 'observability',
		enabled: true,
		// Lift the canary's validation verdict into x402_autonomous_log.signal_data
		// so the autonomous log alone proves the paid MCP path returned real work.
		extractSignal: (r) => {
			const sc = r?.result?.structuredContent || null;
			return {
				canary_tool: 'validate_model',
				rpc_ok: !!(r?.result && !r?.error && !r?.result?.isError),
				file_size: sc?.fileSize ?? null,
				num_errors: sc?.numErrors ?? null,
				validator_version: sc?.validatorVersion ?? null,
			};
		},
		// Value extraction: full per-tool latency sweep → x402_perf_log.
		storeValue: ({ responseBody, runId, origin, durationMs, success }) =>
			mcpLatencySweep({
				responseBody,
				runId,
				origin,
				durationMs,
				success: success && !!(responseBody?.result && !responseBody?.error),
			}),
	},

	// ── Sniper Pipeline Support ────────────────────────────────────────────────
	// Pump Launch Monitor: Recent Launches (USE-046) ─────────────────────────
	// Pays $0.02 USDC to GET /api/x402/pump-agent-audit?limit=10&sort=newest for
	// the 10 freshest pump.fun bonding-curve tokens. extractSignal distills the
	// live cohort into { topic, signal, headline, confidence, count, newest_mint,
	// newest_name, newest_symbol, avg_initial_liquidity, max_initial_liquidity,
	// agent_token_count }. As an `oracle` pipeline entry the loop upserts the
	// verdict into oracle_intel_signals (topic 'pump_launch_monitor') so the
	// sniper gate and any downstream consumer can compare any candidate mint's
	// initial liquidity against the rolling cohort baseline. storeValue appends
	// the full cohort to pump_launch_snapshots for the sniper-screening surface.
	// Cooldown 300 s (5 min) — fast enough to catch the earliest sniping window
	// on new launches. At $0.02/call → $5.76/day at continuous pace, well below
	// the loop's daily cap (the cooldown keeps actual spend much lower).
	{
		id: 'pump-launch-monitor',
		name: 'Pump Launch Monitor: Recent Launches',
		// GET with query params; the autonomous loop appends them to the URL.
		path: '/api/x402/pump-agent-audit?limit=10&sort=newest',
		method: 'GET',
		body: null,
		cooldown_s: 300,
		priority: 88,
		pipeline: 'oracle',
		enabled: true,
		extractSignal: (r) => classifyLaunchMonitor(r),
		storeValue: (ctx) => storePumpLaunchSnapshot(ctx),
	},
	// Legacy entry kept for backwards-compat with existing cooldown keys, but
	// corrected to use the real GET interface and extractSignal shape.
	// Now superseded by pump-launch-monitor above (which has priority 88 vs 75
	// so the loop will run the new one first on each tick). Consider removing
	// this entry once pump-launch-monitor has several days of clean logs.
	{
		id: 'sniper-pump-audit-latest',
		name: 'Pump Agent Audit: latest 5 (legacy)',
		path: '/api/x402/pump-agent-audit?limit=5&sort=newest',
		method: 'GET',
		body: null,
		cooldown_s: 600,
		priority: 75,
		pipeline: 'sniper',
		enabled: true,
		extractSignal: (r) => ({
			count: r?.count ?? r?.launches?.length ?? null,
			newest_mint: r?.newest_mint ?? null,
			avg_initial_liquidity: r?.avg_initial_liquidity_sol ?? null,
		}),
	},
	// Token Intel Pre-Snipe Gate (USE-023) — pays the $0.01 USDC Token Oracle
	// (/api/x402/token-intel) for the freshest pump.fun mints the sniper is about
	// to consider, turning the due-diligence risk.score into a 0..100 rugpull
	// sub-score. run() owns the batch sequence + per-mint recording; the loop
	// records one summary row. Verdicts upsert to token_intel_risk keyed by
	// (mint, network). Cooldown 1200s (20 min) → ~3 batches/hour, ~$0.09/hr at the
	// default batch of 3 — bounded again by the loop's daily cap.
	// Downstream consumer: workers/agent-sniper/oracle-gate.js auto-rejects any
	// mint with a fresh `rejected = true` verdict before committing SOL.
	{
		id: 'token-intel-presnipe-gate',
		name: 'Token Intel Pre-Snipe Gate',
		path: '/api/x402/token-intel',
		method: 'GET',
		body: null,
		cooldown_s: 1200,
		priority: 78,
		pipeline: 'sniper',
		enabled: true,
		run: (ctx) => tokenIntelPreSnipeGate(ctx),
	},
	// Sniper Intel Enrichment (USE-024) — the trading engine pays the platform's
	// own $0.01 USDC Crypto Intel feed (/api/x402/crypto-intel) for live market
	// sentiment on the coins the sniper is actively watching (open positions +
	// freshest high-conviction Oracle candidates), turning the headline signal
	// into a clamped per-coin gate modifier. run() owns the batch sequence +
	// per-coin recording; the loop records one summary row. Verdicts upsert to
	// sniper_coin_sentiment keyed by (mint, network). Crypto Intel 503s (un-charged)
	// for any coin CoinGecko can't resolve, so a memecoin never gets a wrong-coin
	// signal. Cooldown 900s (15 min) → ~4 batches/hour, ≤$0.08/batch at the default
	// batch of 8 — bounded again by the loop's daily cap.
	// Downstream consumer: workers/agent-sniper/oracle-gate.js folds the fresh
	// per-coin delta into the effective min_oracle_score before committing SOL.
	{
		id: 'sniper-intel-enrich',
		name: 'Sniper Intel Enrichment',
		path: '/api/x402/crypto-intel',
		method: 'POST',
		body: null,
		cooldown_s: 900,
		priority: 77,
		pipeline: 'sniper',
		enabled: true,
		run: (ctx) => sniperIntelEnrich(ctx),
	},

	// ── Identity / DID ─────────────────────────────────────────────────────────
	{
		id: 'health-did-resolve',
		name: 'Health: DID resolution',
		path: '/api/x402/did',
		method: 'GET',
		body: null,
		cooldown_s: 3600,
		priority: 30,
		pipeline: 'health',
		enabled: true,
		extractSignal: (r) => ({ alive: !!r }),
	},
	// ── DID Verification Canary (USE-069) ────────────────────────────────────
	// Pays a real $0.001 USDC POST to /api/x402/did, which resolves three.ws's
	// published W3C DID document over its real public route (/.well-known/did.json
	// — the same path an external x402 counterparty hits to resolve our
	// offer/receipt signing key), structurally validates it, and measures
	// end-to-end resolution latency. The verdict { verified, latency_ms } is the
	// actionable signal: verified flips false when the document is unreachable,
	// malformed, or slower than 1500ms — exactly the failure that would make a
	// partner's signature verification silently fail. extractSignal lifts the
	// verdict into x402_autonomous_log.signal_data so the status surface can read
	// the DID subsystem's health straight off the autonomous log. Distinct from
	// the free GET liveness probe above: this paid canary proves correctness +
	// latency, not just reachability. Cooldown 600s (10 min) → ~$0.006/hr, well
	// under the loop's daily cap, while sampling latency often enough to catch a
	// degraded resolver quickly.
	{
		id: 'did-verification-canary',
		name: 'DID Verification Canary',
		path: '/api/x402/did',
		method: 'POST',
		body: { did: 'did:three:canary', mode: 'verify' },
		cooldown_s: 600,
		priority: 50,
		pipeline: 'health',
		enabled: true,
		extractSignal: (r) => ({
			verified: r?.verified ?? null,
			latency_ms: r?.latency_ms ?? null,
			resolved_did: r?.resolved_did ?? null,
			http_status: r?.http_status ?? null,
			malformed: r?.malformed ?? null,
			within_latency: r?.within_latency ?? null,
			configured: r?.configured ?? null,
		}),
	},
	// DID Registry Health Sweep (USE-068) — pays $0.001 USDC to POST /api/x402/did
	// in sweep mode, which queries the 10 most recently created agent_identities,
	// checks each for cryptographic key material (wallet_address → resolvable DID),
	// and returns { count, resolvable_count, failed_count }. An agent without a
	// wallet_address has no key material for claim signing or counterparty
	// verification. storeValue raises a Redis alert (x402:did-sweep:alert) when
	// failed_count > 0 so ops can investigate before agents silently fail to produce
	// verifiable credentials. Cooldown 600s → ~144 sweeps/day ≈ $0.144/day.
	{
		id: 'did-registry-sweep',
		name: 'DID Registry Health Sweep',
		path: '/api/x402/did',
		method: 'POST',
		body: { mode: 'sweep', limit: 10 },
		cooldown_s: 600,
		priority: 50,
		pipeline: 'health',
		enabled: true,
		extractSignal: (r) => ({
			count: r?.count ?? null,
			resolvable_count: r?.resolvable_count ?? null,
			failed_count: r?.failed_count ?? null,
		}),
		storeValue: async ({ redis, signalData }) => {
			if (!redis) return;
			const v = signalData || {};
			const DID_SWEEP_ALERT_KEY = 'x402:did-sweep:alert';
			const DID_SWEEP_ALERT_TTL_SECONDS = 25 * 60;
			const failed = typeof v.failed_count === 'number' && v.failed_count > 0;
			try {
				if (failed) {
					await redis.set(
						DID_SWEEP_ALERT_KEY,
						JSON.stringify({
							count: v.count ?? null,
							failed_count: v.failed_count,
							resolvable_count: v.resolvable_count ?? null,
							ts: new Date().toISOString(),
						}),
						{ ex: DID_SWEEP_ALERT_TTL_SECONDS },
					);
					console.warn(
						`[x402/did-sweep] ALERT: ${v.failed_count} of ${v.count} agent DIDs unresolvable`,
					);
				} else if (typeof v.count === 'number') {
					await redis.del(DID_SWEEP_ALERT_KEY);
				}
			} catch (err) {
				console.warn(`[x402/did-sweep] alert write failed: ${err?.message || err}`);
			}
		},
	},


	// ── Cross-Chain Bridge Status Monitor (USE-078) ────────────────────────────
	// Pays $0.005 USDC every 5 min to POST /api/x402/cross-chain {mode:"bridge_status"},
	// which probes Wormhole, Li.Fi, and deBridge health endpoints in parallel and
	// returns { bridges: [{chain, status, latency_ms}], down_count, signal }. A
	// bridge with status=down is a platform risk — cross-chain settlement on that
	// provider may silently fail. As an `oracle` entry the loop upserts the verdict
	// into oracle_intel_signals (topic 'bridge_status') so the sniper gate can factor
	// cross-chain ecosystem health into conviction: all-down is bearish (settlement
	// risk blocks exits), all-up is bullish (liquidity paths open). storeValue raises
	// a Redis alert (x402:bridge-status:alert) when any bridge is down so ops can
	// investigate before a user's cross-chain transfer fails. Cooldown 300s → 12
	// probes/hr ≈ $0.06/hr, well under the loop's daily cap.
	{
		id: 'cross-chain-bridge-status',
		name: 'Cross-Chain Bridge Status Monitor',
		path: '/api/x402/cross-chain',
		method: 'POST',
		body: { mode: 'bridge_status' },
		cooldown_s: 300,
		priority: 58,
		pipeline: 'oracle',
		enabled: true,
		extractSignal: (r) => ({
			topic:      'bridge_status',
			signal:     r?.signal ?? null,
			headline:   r?.headline ?? null,
			confidence: r?.confidence ?? null,
			down_count: r?.down_count ?? 0,
			bridges:    Array.isArray(r?.bridges)
				? r.bridges.map(({ chain, status, latency_ms }) => ({ chain, status, latency_ms }))
				: [],
		}),
		storeValue: async ({ redis, signalData }) => {
			if (!redis) return;
			const v = signalData || {};
			const BRIDGE_ALERT_KEY = 'x402:bridge-status:alert';
			const BRIDGE_ALERT_TTL_SECONDS = 10 * 60;
			const hasDown = typeof v.down_count === 'number' && v.down_count > 0;
			try {
				if (hasDown) {
					const downBridges = Array.isArray(v.bridges)
						? v.bridges.filter((b) => b.status === 'down').map((b) => b.chain)
						: [];
					await redis.set(
						BRIDGE_ALERT_KEY,
						JSON.stringify({
							down_count:   v.down_count,
							down_bridges: downBridges,
							headline:     v.headline ?? null,
							ts: new Date().toISOString(),
						}),
						{ ex: BRIDGE_ALERT_TTL_SECONDS },
					);
					console.warn(
						`[x402/bridge-status] ALERT: \${v.down_count} bridge(s) down — \${downBridges.join(', ')}`,
					);
				} else if (typeof v.down_count === 'number') {
					await redis.del(BRIDGE_ALERT_KEY);
				}
			} catch (err) {
				console.warn(`[x402/bridge-status] alert write failed: \${err?.message || err}`);
			}
		},
	},
	// ── Wallet Connect Session Health (USE-063) ───────────────────────────────
	// Pays $0.001 USDC every 5 min to POST /api/x402/wallet-connect with
	// { mode: "health" }, which probes the SIWS (Sign-In With Solana) session
	// initiation path end-to-end: fires a real GET to /api/auth/siws/nonce,
	// validates the returned 22-char alphanumeric nonce, and measures the
	// roundtrip latency. session_created:true means wallet connect handshakes
	// CAN be initiated right now (auth gateway + DB nonce write + CSRF layer all
	// alive). A false verdict or a latency > 1s (slow:true) surfaces as an ops
	// alert via Redis x402:wallet-connect:alert (TTL 25 min), mirroring the
	// forge-health and DID-sweep alert convention. Cooldown 300s → 288 probes/day
	// ≈ $0.288/day, well under the loop's daily cap. Health pipeline — not oracle.
	{
		id: 'wallet-connect-health',
		name: 'Wallet Connect Session Health',
		path: '/api/x402/wallet-connect',
		method: 'POST',
		body: { mode: 'health' },
		cooldown_s: 300,
		priority: 52,
		pipeline: 'health',
		enabled: true,
		extractSignal: (r) => ({
			session_created: r?.session_created ?? null,
			latency_ms: r?.latency_ms ?? null,
			slow: r?.slow ?? null,
			nonce_valid: r?.nonce_valid ?? null,
			domain: r?.domain ?? null,
			reason: r?.reason ?? null,
		}),
		storeValue: async ({ redis, signalData }) => {
			if (!redis) return;
			const v = signalData || {};
			const ALERT_KEY = 'x402:wallet-connect:alert';
			const ALERT_TTL_SECONDS = 25 * 60;
			const degraded = v.session_created === false || v.slow === true;
			try {
				if (degraded) {
					await redis.set(
						ALERT_KEY,
						JSON.stringify({
							reason: v.session_created === false
								? (v.reason || 'session_creation_failed')
								: 'latency_budget_exceeded',
							session_created: v.session_created === true,
							latency_ms: v.latency_ms ?? null,
							domain: v.domain ?? null,
							ts: new Date().toISOString(),
						}),
						{ ex: ALERT_TTL_SECONDS },
					);
					console.warn(
						`[x402/wallet-connect-health] ALERT: ` +
						`session_created=${v.session_created}, latency_ms=${v.latency_ms}, reason=${v.reason}`,
					);
				} else if (v.session_created === true) {
					await redis.del(ALERT_KEY);
				}
			} catch (err) {
				console.warn(`[x402/wallet-connect-health] alert write failed: ${err?.message || err}`);
			}
		},
	},


	// ── RSS Feed: Changelog XML Validity (USE-081) ───────────────────────────────
	// Pays $0.001 USDC every 5 minutes to POST /api/x402/feed-health with body
	// { feed: "changelog_rss" } to validate the public changelog RSS feed at
	// three.ws/changelog.xml end-to-end. The endpoint fetches the live XML, parses
	// it with fast-xml-parser, counts <item> elements, and cross-checks the latest
	// item title against public/changelog.json (the canonical build output). A
	// broken XML document, an unreachable URL, or a title divergence (feed went
	// stale after a deploy that skipped the build step) each flip valid:false.
	// extractSignal lifts { valid, item_count, latest_title } into
	// x402_autonomous_log.signal_data so the status surface can read feed health
	// off the autonomous log without a separate query. Health pipeline. Cooldown
	// 300s → 288 probes/day ≈ $0.288/day, well under the loop's $5/day cap.
	{
		id: 'changelog-rss-health',
		name: 'RSS Feed: Changelog XML Validity',
		path: '/api/x402/feed-health',
		method: 'POST',
		body: { feed: 'changelog_rss' },
		cooldown_s: 300,
		priority: 52,
		pipeline: 'health',
		enabled: true,
		extractSignal: (r) => ({
			valid: r?.valid ?? false,
			item_count: r?.item_count ?? null,
			latest_title: r?.latest_title ?? null,
			title_match: r?.title_match ?? false,
			fetch_ms: r?.fetch_ms ?? null,
		}),
	},

	// ── Changelog JSON Schema Conformance Check (USE-082) ─────────────────────
	// Pays $0.001 USDC every 30 min to POST /api/x402/schema-check with
	// { api: "changelog_json" }, which fetches the public /changelog.json feed and
	// validates its schema: generated_at (ISO datetime), site.name, site.url, and
	// entries (non-empty array with each entry having date/title/summary/tags). A
	// schema break here means every $THREE holder, RSS reader, and downstream parser
	// depending on the changelog feed is silently broken — this catches it before
	// they notice. extractSignal lifts { valid, version, entry_count } into
	// x402_autonomous_log.signal_data; valid=false is the actionable alarm (a
	// breaking schema change or a failed fetch). Cooldown 1800s (30 min) → 48
	// checks/day ≈ $0.048/day, well under the loop's daily cap. Health pipeline —
	// not oracle, this is feed-integrity telemetry not a trading signal.
	{
		id: 'changelog-schema-check',
		name: 'Changelog JSON Schema Conformance Check',
		path: '/api/x402/schema-check',
		method: 'POST',
		body: { api: 'changelog_json' },
		cooldown_s: 1800, // 30 min — changelog updates infrequently; catches breakage within one window
		priority: 52,
		pipeline: 'health',
		enabled: true,
		extractSignal: (r) => ({
			api: r?.api ?? 'changelog_json',
			valid: r?.valid ?? false,
			version: r?.version ?? null,
			entry_count: r?.entry_count ?? 0,
			schema_errors: Array.isArray(r?.schema_errors) ? r.schema_errors : [],
		}),
	},

	// ── Changelog Telegram Bot Health (USE-080) ───────────────────────────────
	// Pays $0.001 USDC every 5 min to POST /api/x402/telegram-health with
	// { bot: "changelog" }. The endpoint calls Telegram's getMe API with the
	// configured TELEGRAM_BOT_TOKEN, measuring reachability and latency in one
	// round-trip. When unreachable ($THREE holders would silently miss new
	// changelog entries), the endpoint writes a Redis alert key
	// `x402:telegram-health:alert` (TTL 25 min) so the ops dashboard and the
	// changelog-push script can detect a degraded channel without a DB query.
	// extractSignal lifts { reachable, bot_id, latency_ms } into
	// x402_autonomous_log.signal_data — the actionable signal proves the
	// changelog delivery channel is alive on every tick. Health pipeline
	// (not oracle — delivery-channel health is platform telemetry, not a
	// trading signal). Cooldown 300s → 288 probes/day ≈ $0.288/day, well
	// within the loop's $5/day cap. A sustained outage flips reachable=false
	// across multiple signal_data rows, which ops alerting reads directly.
	{
		id: 'telegram-changelog-health',
		name: 'Changelog Telegram Bot Health',
		path: '/api/x402/telegram-health',
		method: 'POST',
		body: { bot: 'changelog' },
		cooldown_s: 300, // 5 min — delivery-channel health changes fast on degradation
		priority: 55,
		pipeline: 'health',
		enabled: true,
		extractSignal: (r) => ({
			reachable: r?.reachable ?? false,
			bot_id: r?.bot_id ?? null,
			bot_username: r?.bot_username ?? null,
			latency_ms: r?.latency_ms ?? null,
			reason: r?.reason ?? null,
		}),
	},

	// ── Auth Session Lifecycle Health (USE-083) ──────────────────────────────────
	// Security-critical canary that exercises the full JWT auth session lifecycle
	// every 30 minutes: create (mint canary access token), validate (verify it with
	// the full verifier), refresh (issue a replacement and re-verify), expire
	// (craft an already-expired token and confirm it is rejected). A failed_step
	// means that stage of the auth subsystem is broken — a verifier that accepts
	// expired tokens, or a signer that can't produce a valid JWT, is a security
	// incident. extractSignal lifts { all_pass, failed_step, latency_ms } into
	// x402_autonomous_log.signal_data so ops and the status surface can read auth
	// health off the autonomous log without a separate DB query. Health pipeline —
	// not oracle (auth health is not a trading signal). Cooldown 1800s → 48
	// probes/day ≈ $0.048/day, well under the loop's daily cap.
	{
		id: 'auth-session-lifecycle',
		name: 'Auth Session Lifecycle Health',
		path: '/api/x402/auth-health',
		method: 'POST',
		body: { mode: 'session_lifecycle' },
		cooldown_s: 1800, // 30 min — security-critical; auth is fast-changing
		priority: 55,
		pipeline: 'health',
		enabled: true,
		extractSignal: (r) => ({
			all_pass: r?.all_pass ?? null,
			failed_step: r?.failed_step ?? null,
			latency_ms: r?.latency_ms ?? null,
			create_ms: r?.steps?.create?.latency_ms ?? null,
			validate_ms: r?.steps?.validate?.latency_ms ?? null,
			refresh_ms: r?.steps?.refresh?.latency_ms ?? null,
			expire_ms: r?.steps?.expire?.latency_ms ?? null,
		}),
	},

	// ── Animation Retargeting QA (USE-012) ──────────────────────────────────────
	// Pays $0.005 USDC to download a representative set of canary animation clips
	// (one per rig convention — Mixamo, VRM, Avaturn, Daz) through the real
	// paid-delivery path (402 paywall → R2 presign → animated GLB), then fetches
	// each presigned GLB and inspects the actual bytes with inspectGlb(): the file
	// must be a valid, non-zero binary glTF whose animation track survived. An
	// empty/truncated/non-GLB artifact, or one whose animation channels vanished —
	// the regression a glb-canonicalize.js / animation-retarget.js break produces —
	// flips the verdict to passed:false. run() owns the per-clip pay/fetch/inspect
	// and per-clip recording; the loop records one summary row (verdict in
	// signal_data), and run() upserts each verdict into animation_qa_results keyed
	// by clip_id (the sink the animation marketplace + retarget-regression alerting
	// read). Gated on X402_ANIMATION_QA_CLIP_IDS / X402_ANIMATION_QA_CLIP_ID —
	// disabled (no spend) until canary clips are designated. Cooldown 6h → at
	// $0.005 per clip, a 4-rig sweep ≈ $0.08/day.
	{
		id: 'anim-retarget-qa',
		name: 'Animation Retargeting QA',
		// path is informational — runAnimationRetargetQa() probes + settles each clip.
		path: '/api/x402/animation-download',
		method: 'GET',
		body: null,
		cooldown_s: 21600,
		priority: 45,
		pipeline: 'qa',
		enabled: hasAnimationQaCanaries(),
		run: (ctx) => runAnimationRetargetQa(ctx),
	},
	// GLB Canonicalization: pays $0.001 USDC to run a rig-reference avatar
	// through /api/x402/model-check, validating that its skeleton still inspects
	// as a skinned/animated rig (the precondition for canonical-clip retargeting).
	// resolveTarget rotates the avatar set so every rig convention is re-checked
	// over time; storeValue upserts the verdict into glb_canonicalization_results
	// (consumed by the avatar upload + animation retarget pipeline to gate T-pose
	// fallback). Cooldown 300s → one avatar every 5 min, full ~8-rig cycle ≈ 40 min.
	{
		id: 'glb-canonicalize',
		name: 'GLB Canonicalization Check',
		// Stable fallback path; resolveTarget overrides it per call (rotation).
		path: `/api/x402/model-check?url=${encodeURIComponent('https://three.ws/avatars/xbot.glb')}`,
		method: 'GET',
		body: null,
		cooldown_s: 300,
		priority: 55,
		pipeline: 'canonicalize',
		enabled: true,
		resolveTarget: (ctx) => nextCanonicalTarget(ctx),
		extractSignal: (r) => classifyCanonicalization(r),
		storeValue: async ({ sql, responseBody, signalData, runId, targetUrl }) => {
			if (!sql) return;
			const v = signalData || classifyCanonicalization(responseBody);
			const url = v.model_url || targetUrl;
			if (!url) return;
			await ensureCanonicalSchema(sql);
			await sql`
				INSERT INTO glb_canonicalization_results
					(model_url, container, generator, rig_type, is_skinned, vrm,
					 skins, animations, nodes, canonical_ready, extensions, suggestions,
					 run_id, checked_at)
				VALUES
					(${url}, ${v.container}, ${v.generator}, ${v.rig_type},
					 ${v.is_skinned}, ${v.vrm}, ${v.skins}, ${v.animations}, ${v.nodes},
					 ${v.canonical_ready},
					 ${JSON.stringify(v.extensions || [])},
					 ${JSON.stringify((responseBody && responseBody.suggestions) || [])},
					 ${runId}, now())
				ON CONFLICT (model_url) DO UPDATE SET
					container       = EXCLUDED.container,
					generator       = EXCLUDED.generator,
					rig_type        = EXCLUDED.rig_type,
					is_skinned      = EXCLUDED.is_skinned,
					vrm             = EXCLUDED.vrm,
					skins           = EXCLUDED.skins,
					animations      = EXCLUDED.animations,
					nodes           = EXCLUDED.nodes,
					canonical_ready = EXCLUDED.canonical_ready,
					extensions      = EXCLUDED.extensions,
					suggestions     = EXCLUDED.suggestions,
					run_id          = EXCLUDED.run_id,
					checked_at      = now()
			`;
		},
	},

	// ── 3D Forge Content Generation (USE-014) ──────────────────────────────────
	// Pays the paid Forge ($0.05 draft) hourly to generate one procedural prop
	// (crate / barrel / furniture / terrain tile), rotating the category each hour
	// so the public asset library stays balanced. run() owns the pay→embed→persist
	// sequence: it inserts the prop into forge_autonomous_props (the asset-library +
	// diversity table the forge gallery/dashboard reads) and scores novelty + a
	// k-means cluster id over the recent catalog (the embedding-clustering diversity
	// measure). Cooldown 3600s → ≤24 props/day ≈ $1.20/day, well under the loop cap.
	{
		id: 'forge-content-gen',
		name: '3D Forge: procedural prop generation',
		path: '/api/x402/forge',
		method: 'POST',
		body: null,
		cooldown_s: 3600,
		priority: 55,
		pipeline: 'forge',
		enabled: true,
		run: (ctx) => forgeContentGeneration(ctx),
	},

	// ── Forge: Content Generation Health (USE-072) ─────────────────────────────
	// A lightweight liveness+latency canary for the generative AI lane every Forge
	// job depends on, distinct from the hourly prop generator above. Pays the floor
	// ($0.001) to /api/x402/forge in health_check mode, which runs ONE fast, real
	// text completion over the platform's free-first LLM provider chain (no mesh
	// reconstruction) and returns a measured { generated, latency_ms, token_count }
	// verdict. extractSignal lifts that verdict into x402_autonomous_log.signal_data;
	// storeValue raises a forge performance alert (Redis x402:forge-health:alert,
	// mirroring the wallet-balance alert convention) whenever the probe is slow
	// (>5s) or the generator failed, and clears it once healthy — the on-call
	// surface reads that key to know the content path degraded before users do.
	// Cooldown 600s -> one probe every 10 min ~= $0.144/day, well under the loop cap.
	{
		id: 'forge-content-health',
		name: 'Forge: Content Generation Health',
		path: '/api/x402/forge',
		method: 'POST',
		body: { mode: 'health_check', type: 'text', prompt: 'Write one sentence about Solana.' },
		price_atomic: 1000, // $0.001 — the health_check floor price the endpoint quotes
		cooldown_s: 600, // 10 min
		priority: 50,
		pipeline: 'health',
		enabled: true,
		extractSignal: (r) => {
			const latencyMs = typeof r?.latency_ms === 'number' ? r.latency_ms : null;
			return {
				generated: r?.generated === true,
				latency_ms: latencyMs,
				token_count: r?.token_count ?? null,
				within_budget: r?.within_budget ?? null,
				provider: r?.provider ?? null,
				model: r?.model ?? null,
				// Performance verdict consumed by storeValue + the status surface.
				slow: latencyMs != null ? latencyMs > FORGE_HEALTH_BUDGET_MS : null,
				error: r?.error ?? null,
			};
		},
		storeValue: (ctx) => recordForgeHealthAlert(ctx),
	},

	// ── Forge: Image Generation Canary (USE-073) ───────────────────────────────
	// Pays the floor $0.001 to /api/x402/forge in health_check+image mode every
	// 5 min. Unlike the text health probe (which exercises the LLM completion
	// lane), this canary runs a real text→image call through the platform's
	// free-first image provider chain (NIM FLUX → Vertex Imagen → Replicate
	// backstop) and uploads the result to R2 CDN — proving the FULL image
	// generation + CDN upload path is alive. A `generated:false` means the image
	// provider chain is down or unconfigured; `slow:true` (>30s) means a hung
	// provider is degrading response times before users notice. storeValue raises
	// or clears the image-specific Redis alert key (x402:forge-image-health:alert)
	// which is distinct from the text alert so both lanes can degrade independently
	// and the on-call surface can pinpoint which part of the pipeline is affected.
	// extractSignal lifts { generated, url, latency_ms } into
	// x402_autonomous_log.signal_data. Health pipeline — not oracle. Cooldown 300s
	// → 288 probes/day ≈ $0.288/day, well under the loop's daily cap.
	{
		id: 'forge-image-generation-canary',
		name: 'Forge: Image Generation Canary',
		path: '/api/x402/forge',
		method: 'POST',
		body: { mode: 'health_check', type: 'image', prompt: 'A simple blue circle.' },
		price_atomic: 1000, // $0.001 — health_check floor price
		cooldown_s: 300, // 5 min — image provider chain can degrade fast
		priority: 50,
		pipeline: 'health',
		enabled: true,
		extractSignal: (r) => {
			const latencyMs = typeof r?.latency_ms === 'number' ? r.latency_ms : null;
			return {
				generated: r?.generated === true,
				url: r?.url ?? null,
				latency_ms: latencyMs,
				within_budget: r?.within_budget ?? null,
				model: r?.model ?? null,
				slow: latencyMs != null ? latencyMs > FORGE_IMAGE_HEALTH_BUDGET_MS : null,
				error: r?.error ?? null,
			};
		},
		storeValue: (ctx) => recordForgeImageHealthAlert(ctx),
	},

	// ── Bazaar Discovery Warmup (USE-008) ──────────────────────────────────────
	// Sweeps 15 discovery categories through the x402 Bazaar MCP server
	// (/api/mcp-bazaar → search_services) at $0.001/call, validating that the
	// returned services are live + priced and snapshotting the catalog per
	// category into x402_bazaar_catalog for drift detection. run() owns the full
	// 15-call sequence and per-call recording; the loop records one summary row.
	// Cooldown 86400s (daily warmup) → 15 calls/day ≈ $0.015/day. The snapshots
	// are the source list for external x402 service onboarding (EXTERNAL_ENDPOINTS)
	// and the per-category drift flags feed the external pipeline.
	{
		id: 'bazaar-discovery-warmup',
		name: 'Bazaar Discovery Warmup',
		path: '/api/mcp-bazaar',
		method: 'POST',
		body: null,
		cooldown_s: 86400,
		priority: 35,
		pipeline: 'discovery',
		enabled: true,
		run: (ctx) => bazaarDiscoveryWarmup(ctx),
	},

	// -- Bazaar Service Catalog Daily Refresh -----------------------------------
	// A full-catalog census, distinct from the category-search warmup above. Once
	// a day it browses EVERY service on the bazaar (browse_services for http + mcp
	// via /api/mcp-bazaar at $0.001/call), then pays get_service ($0.001/call) for
	// each newly-appeared service to capture its full payment requirements -- the
	// bazaar_search_services + bazaar_service_details pair. run() owns the census,
	// the day-over-day diff, and per-call recording; it sets recorded:true so the
	// loop adds no summary row. The diff is the value: new services (opportunity
	// alerts) and removed services (pipeline-dependency alerts) land in the daily
	// snapshot + the durable bazaar_service_index, and removed resources are
	// cross-checked against active EXTERNAL_ENDPOINTS to raise a dependency alert.
	// Cooldown 86400s (daily) -> ~2 census + <=8 enrichment calls/day ~= $0.01/day.
	// Value sinks: bazaar_catalog_snapshots (daily snapshot + diff) and
	// bazaar_service_index (per-service registry). Downstream consumer: external
	// onboarding reads bazaar_service_index WHERE status='active' (the opportunity
	// feed) and ops reads the Redis dependency-alert before a dead external entry
	// starts erroring.
	{
		id: 'bazaar-catalog-refresh',
		name: 'Bazaar Service Catalog Daily Refresh',
		path: BAZAAR_CATALOG_REFRESH.endpoint,
		endpoint: BAZAAR_CATALOG_REFRESH.endpoint,
		method: 'POST',
		body: null,
		price_atomic: BAZAAR_CATALOG_REFRESH.priceAtomic,
		cooldown_s: BAZAAR_CATALOG_REFRESH.cooldownSeconds,
		cooldown_seconds: BAZAAR_CATALOG_REFRESH.cooldownSeconds,
		priority: 34,
		pipeline: 'discovery',
		enabled: true,
		run: (ctx) => bazaarCatalogRefresh(ctx),
		extractSignal: null,
	},

	// ── x402 Service Pricing Tracker (USE: cost-model price history) ───────────
	// Tracks the PRICE HISTORY of the external x402 services we depend on so our
	// cost models stay honest (distinct from the catalog census above, which
	// tracks service presence). Each run pays $0.001/call to /api/mcp-bazaar
	// (bazaar_service_details) for the stalest tracked services and reads each
	// one's current live cheapest price. run() compares to the last recorded price,
	// appends to x402_service_price_history, and upserts x402_service_price_current
	// with the % change + alert flags — raising a cost-model alert when a price
	// jumped > 20% and flagging a drop opportunity when it fell ≥ 15%. The tracked
	// set is built from the live priced resources the Bazaar Discovery Warmup
	// snapshots into x402_bazaar_catalog (no hardcoded list). run() self-records one
	// x402_autonomous_log row per call (value_extracted = price + change), so it
	// sets recorded:true and the loop adds no summary row. Cooldown 21600s (6h) with
	// a 5-service batch → ≤ $0.005/run, rotating the catalog ≈ daily, well under the
	// loop's daily cap. Downstream consumer: GET /api/x402/service-pricing-report
	// surfaces the tracked catalog, active increase alerts, and drop opportunities.
	{
		id: 'x402-pricing-tracker',
		name: 'x402 Service Pricing Tracker',
		// path/endpoint are informational — run() builds the bazaar_service_details
		// JSON-RPC body and pays the live $0.001 challenge itself, per service.
		path: '/api/mcp-bazaar',
		endpoint: '/api/mcp-bazaar',
		method: 'POST',
		body: null,
		price_atomic: 1000, // $0.001 USDC — bazaar_service_details per-call price
		cooldown_s: 21600,
		cooldown_seconds: 21600,
		priority: 33,
		pipeline: 'discovery',
		enabled: true,
		run: (ctx) => x402PricingTracker(ctx),
		extractSignal: null,
	},

	// ── Avatar Search Index Warmup (USE-003) ───────────────────────────────────
	// Fires ~20 common gallery queries (human, robot, anime, warrior, …) through
	// the MCP server (/api/mcp → search_public_avatars) at $0.001/call, proving the
	// full search path returns ranked results WITH resolved thumbnails on a cold
	// start. run() owns the 20-call sequence and per-call recording; the loop
	// records one summary row. Cooldown 21600s (every 6h) → ~20 calls/run ≈
	// $0.08/day. Each query's ranked, thumbnail-resolved slice is upserted into
	// avatar_search_warm_cache; GET /api/avatars/popular-searches reads it to power
	// the gallery's popular-search chips and instant cached results.
	{
		id: 'avatar-search-index-warmup',
		name: 'Avatar Search Index Warmup',
		path: '/api/mcp',
		method: 'POST',
		body: null,
		cooldown_s: 21600,
		priority: 38,
		pipeline: 'discovery',
		enabled: true,
		run: (ctx) => avatarSearchWarmup(ctx),
	},

	// ── MCP Tool Discovery (USE-062) ───────────────────────────────────────────
	// Pays $0.001 USDC every 2h to /api/x402/mcp-tool-catalog (mode:discover),
	// which fingerprints the MCP server's live tool catalog (api/_mcp/catalog.js →
	// TOOL_CATALOG, the exact list /api/mcp returns from tools/list) and diffs it
	// against the durable mcp_tool_registry. The endpoint persists the new catalog
	// state itself, so a newly-shipped MCP tool (or a price/shape change, or a
	// removal) is captured in mcp_tool_registry the moment it ships — the
	// feature-flag source agents read to light up a new capability without polling
	// tools/list and diffing by hand. extractSignal lifts the diff
	// (new_tools / total_tools / changed / removed counts) into
	// x402_autonomous_log.signal_data so the autonomous log alone proves what
	// changed each probe. Cooldown 7200s (2h) → ≤12 probes/day ≈ $0.012/day,
	// bounded again by the loop's daily cap.
	{
		id: 'mcp-tool-discovery',
		name: 'MCP Tool Discovery',
		path: '/api/x402/mcp-tool-catalog',
		method: 'POST',
		body: { mode: 'discover' },
		cooldown_s: 7200, // 2h — matches the use case's described schedule
		priority: 36, // discovery tier (33–38)
		pipeline: 'discovery',
		enabled: true,
		extractSignal: (r) => ({
			total_tools: r?.total_tools ?? null,
			priced_tools: r?.priced_tools ?? null,
			free_tools: r?.free_tools ?? null,
			new_tools: Array.isArray(r?.new_tools) ? r.new_tools.map((t) => t?.name).filter(Boolean) : [],
			new_count: Array.isArray(r?.new_tools) ? r.new_tools.length : 0,
			changed_count: Array.isArray(r?.changed_tools) ? r.changed_tools.length : 0,
			removed_tools: Array.isArray(r?.removed_tools) ? r.removed_tools : [],
		}),
	},

	// ── Agent Reputation Score Refresh (USE-005) ───────────────────────────────
	// Refreshes the on-chain attestation reputation of the stalest registered
	// Solana agents by paying the /api/mcp tool solana_agent_reputation
	// ($0.001/call) for each. run() owns the full per-agent sweep and per-call
	// recording; the loop records one summary row. Cooldown 21600s (6h) →
	// ≤25 agents/run ≈ $0.025/run, bounded again by the loop's daily cap; stalest
	// agents sort first so coverage rotates. Value sink: agent_solana_reputation
	// (per-agent score + flag) — read by the agent-profile trust badge, the
	// reputation leaderboard, and the moderation flagged feed (see
	// getStoredSolanaReputation / listSolanaReputationLeaderboard /
	// listFlaggedSolanaAgents in pipelines/reputation-refresh.js).
	{
		id: 'reputation-score-refresh',
		name: 'Agent Reputation Score Refresh',
		// path is informational — run() fans the call across registered agents.
		path: '/api/mcp',
		method: 'POST',
		body: null,
		cooldown_s: 21600,
		priority: 45,
		pipeline: 'self',
		enabled: true,
		run: (ctx) => reputationRefresh(ctx),
	},

	// ── Volume Bootstrap Loop (USE-026) ────────────────────────────────────────
	// The core growth/volume engine. Round-robins through the full catalog of
	// paid, cheap self x402 endpoints (VOLUME_ENDPOINTS in
	// pipelines/volume-bootstrap-loop.js), paying each a real on-chain USDC
	// payment so the platform accrues genuine agent-to-agent transaction volume —
	// the metric agentic.market ranks facilitators on — while continuously proving
	// every paid endpoint is live. run() owns the full sweep, per-call recording
	// and per-endpoint ledger upsert; the loop records one summary row. Budgeted
	// by both the loop's daily cap and a self-imposed per-run cap. Cooldown 300s →
	// a window every 5 min, full ~11-endpoint cycle ≈ 15 min. Value sink:
	// x402_volume_metrics (per-endpoint call/success/spend ledger) — read by the
	// growth + status surfaces for proof-of-volume and per-endpoint liveness.
	{
		id: 'volume-bootstrap-loop',
		name: 'Volume Bootstrap Loop',
		// path is informational — run() round-robins the VOLUME_ENDPOINTS catalog.
		path: '/api/x402/*',
		method: 'POST',
		body: null,
		cooldown_s: 300,
		priority: 25,
		pipeline: 'volume',
		enabled: true,
		run: (ctx) => volumeBootstrapLoop(ctx),
	},

	// ── Datapoint Fabric Volume Sweep ──────────────────────────────────────────
	// Settles real on-chain USDC against the datapoint fabric (the 1M+ endpoints
	// served by api/x402/d/[...path].js), which the main volume loop never touches.
	// run() cursors a live-resolved pool of concrete datapoint URLs and pays the
	// next window on Solana via the shared settleAndRecord path — the cheapest call
	// in the catalog ($0.0005), so it is the most tx-per-dollar-efficient volume
	// generator and gives x402scan per-resource settlement history for the fabric.
	// Draws from the same daily cap as the main loop (can't blow spend); no-op when
	// the wallet/RPC is unconfigured. Sweeps thousands of distinct URLs over time.
	// See pipelines/datapoint-volume-sweep.js. Batch: X402_DATAPOINT_SWEEP_BATCH.
	{
		id: 'datapoint-volume-sweep',
		name: 'Datapoint Fabric Volume Sweep',
		path: '/api/x402/d/*',
		method: 'GET',
		body: null,
		cooldown_s: 300,
		priority: 25,
		pipeline: 'datapoint',
		enabled: true,
		run: (ctx) => datapointVolumeSweep(ctx),
	},

	// ── Ring Rebalancer ────────────────────────────────────────────────────────
	// Recirculates the closed-loop float: sweeps USDC from the treasury
	// (X402_PAY_TO_SOLANA) back to the ring payer so the same money cycles
	// indefinitely instead of the payer draining and the loop halting. Between
	// platform-controlled wallets only; the sponsor pays the SOL fee so burn
	// stays on one wallet. Recirculation, not spend — returns amountAtomic:0, so
	// it never consumes the daily spend cap. No-op until X402_TREASURY_SECRET_BASE58
	// is set. Value sink: x402_ring_ledger (kind='sweep'). See
	// pipelines/ring-rebalance.js.
	//
	// Cooldown 120s (was 300s): the per-minute ring tick cycles the payer float
	// far faster than the old 5-min volume-only cadence, so the rebalancer must
	// keep up or the payer drains between sweeps. Sweep threshold is env-tunable
	// via X402_RING_MIN_SWEEP_ATOMIC.
	{
		id: 'ring-rebalance',
		name: 'Ring Rebalancer',
		path: '/api/x402/ring-settle',
		method: 'POST',
		body: null,
		cooldown_s: 120,
		priority: 20,
		pipeline: 'volume',
		enabled: true,
		run: (ctx) => ringRebalance(ctx),
	},

	// ── Ring Agent Buyers (Task 09) ──────────────────────────────────────────────
	// The roster of platform agents that make the ring an agent-to-agent economy
	// rather than a cron paying itself. Each tick, the provisioned personas
	// (endpoint-shopper, agora-citizen, curator — api/_lib/x402/agents/) shop the
	// ring in character: intel + health, club cover + dance tips, marketplace +
	// billboards. Every purchase pays with the AGENT's custodial keypair, is
	// spend-limit-checked via enforceSpendLimit, custody-logged, and recorded to
	// x402_autonomous_log WITH agent_id for attribution. Recirculation stays closed:
	// the treasury is the seller and float-top-up recycles proceeds back to the
	// agents. At low cadence (X402_RING_ONCHAIN_EVERY_N_TICKS) one roster agent also
	// lands a real on-chain agent-invocation receipt (devnet), fee-paid by its own
	// ring wallet. run() self-records granular per-purchase rows, so the loop adds no
	// duplicate summary. No-op until a roster can be provisioned. Value sink:
	// x402_autonomous_log (pipeline='ring-agents'/'ring-onchain') + agent_custody_events.
	{
		id: 'agent-buyers',
		name: 'Ring Agent Buyers',
		// path is informational — run() drives the persona roster across the catalog.
		path: '/api/x402/*',
		method: 'POST',
		body: null,
		cooldown_s: 60,
		priority: 40,
		pipeline: 'agents',
		enabled: true,
		run: (ctx) => ringAgentBuyers(ctx),
	},

	// ── Ring Agent Float Top-Up (Task 09) ────────────────────────────────────────
	// Keeps each roster agent's USDC float inside a floor/target/ceiling band
	// (X402_RING_AGENT_FLOAT_ATOMIC, default $2): tops up a hungry agent from the
	// treasury, sweeps an overfull one back. Same closed loop as the payer
	// rebalancer, applied to the agent wallets. Every counterparty is asserted
	// against ringAllowedAddresses() before any move (fail-closed). Recorded to
	// x402_ring_ledger (kind='fund'). Recirculation, not spend — returns
	// amountAtomic:0. No-op until X402_TREASURY_SECRET_BASE58 is set. See
	// pipelines/ring-rebalance.js floatTopUp().
	{
		id: 'ring-float-topup',
		name: 'Ring Agent Float Top-Up',
		path: '/api/x402/ring-settle',
		method: 'POST',
		body: null,
		cooldown_s: 120,
		priority: 22,
		pipeline: 'agents',
		enabled: true,
		run: (ctx) => ringFloatTopUp(ctx),
	},

	// ── Fee Audit + ATA Rent Reclaim ─────────────────────────────────────────────
	// Nightly enforcement of the ring's "lowest fees always" rule. Sums the real
	// chain-read settlement fees for the day (x402_self_facilitator_log +
	// x402_autonomous_log), derives lamports-per-settlement and SOL-per-$100 of
	// volume, upserts one row into x402_fee_audit, and raises an ops alert when
	// per-settlement fee drifts above 1.5× the 1-sig floor (7,500 lamports) or the
	// daily burn exceeds X402_RING_DAILY_FEE_BUDGET_LAMPORTS (default 0.05 SOL).
	// The same run reclaims ATA rent: it closes any zero-balance, non-role USDC
	// ATA owned by a ring wallet (owner-signed, rent → owner, capped 5/run) — the
	// safety selection is a pure, unit-tested function that never returns a funded
	// or active role ATA. Audit + reclaim only — returns amountAtomic:0, never a
	// spend, so it never consumes the daily cap. Value sink: x402_fee_audit
	// (per-day). Downstream: GET /api/x402-ring exposes the two efficiency metrics.
	{
		id: 'fee-audit',
		name: 'Fee Audit + ATA Rent Reclaim',
		// path is informational — run() reads the fee logs and closes empty ATAs itself.
		path: '/api/x402-ring',
		method: 'GET',
		body: null,
		cooldown_s: 86400, // nightly
		priority: 22,
		pipeline: 'self',
		enabled: true,
		run: (ctx) => feeAudit(ctx),
		extractSignal: null,
	},

	// ── Live Payment Feed Seeder (USE-025) ─────────────────────────────────────
	// Keeps the homepage "live payment feed" (the /pay page, the in-world
	// jumbotron and the exchange NPCs — all polling GET /api/x402-pay?feed=1)
	// populated with recent activity. The Redis ring that feed renders
	// (x402:pay:feed) is written ONLY by real /api/x402-pay demo payments, so
	// with no organic traffic it goes stale and a visitor sees a dead system.
	// run() makes ONE real on-chain $0.001 USDC demo payment per tick through the
	// platform-wallet demo flow (signed by X402_AGENT_SOLANA_SECRET_BASE58
	// server-side), rotating across MCP tools (avatar search / model inspect /
	// validate / optimize / capability discovery) so the feed shows variety, not
	// one repeated call. The demo call pushes the receipt onto the Redis ring
	// (the hot path) and run() mirrors it durably into x402_demo_feed. Cooldown
	// 300s → one fresh feed entry every 5-min tick ≈ $0.29/day, bounded again by
	// the loop's daily cap. Value sink: x402_demo_feed (durable activity history +
	// Redis-eviction backstop). Downstream consumer: the homepage/jumbotron/NPC
	// live feed via /api/x402-pay?feed=1.
	{
		id: 'live-feed-seeder',
		name: 'Live Payment Feed Seeder',
		// path is informational — run() rotates the demo-call set against /api/x402-pay.
		path: '/api/x402-pay',
		method: 'POST',
		body: null,
		cooldown_s: 300,
		priority: 72,
		pipeline: 'feed',
		enabled: true,
		run: (ctx) => liveFeedSeeder(ctx),
	},

	// ── Model Metadata Enrichment (USE-016) ────────────────────────────────────
	// Finds public avatars with no tags and pays inspect_model ($0.01/call via
	// /api/mcp) to parse each GLB, then derives searchable feature tags + a model
	// category from the structural report and writes them back to avatars.tags /
	// avatars.model_category. run() owns the per-avatar call sequence + recording
	// (value_extracted holds the derived tags); the loop records one summary row.
	// Cooldown 3600s (hourly) → up to 10 models/run ≈ $0.10/run, bounded again by
	// the loop's daily cap. Downstream consumer: listPublicAvatars({ tag, category })
	// search facets in api/_lib/avatars.js + the recommendation engine, both of
	// which read avatars.tags — an untagged avatar is invisible to them until enriched.
	{
		id: 'enrich-model-metadata',
		name: 'Model Metadata Enrichment',
		path: '/api/mcp',
		method: 'POST',
		body: null,
		cooldown_s: 3600,
		priority: 28,
		pipeline: '3d',
		enabled: true,
		run: (ctx) => modelMetadataEnrichment(ctx),
	},

	// ── Club Cover Charge (social economy test) ────────────────────────────────
	{
		id: 'club-cover-health',
		name: 'Club Cover Charge Health',
		path: '/api/x402/club-cover',
		method: 'POST',
		body: { club: 'canary_test' },
		cooldown_s: 1800,
		priority: 35,
		pipeline: 'health',
		enabled: true,
		extractSignal: null,
	},

	// ── Club Cover Charge Revenue Summary (USE-067) ───────────────────────────
	// Pays $0.01 USDC every 15 min to POST /api/x402/club-cover with mode:"revenue"
	// to read the 7-day cover-charge and floor revenue across all clubs. The
	// response aggregates:
	//   • door revenue — every settled payment_settled event on the club-cover route,
	//     queried from x402_audit_log (the canonical settlement ledger)
	//   • floor revenue per act — settled dance tips in club_tips grouped by dancer,
	//     each act being one identifiable "club" in the venue
	// extractSignal lifts { total_usdc, top_club_id, top_club_revenue } into
	// x402_autonomous_log.signal_data so dashboards can read social-economy health
	// off the autonomous log directly. The `volume` pipeline tag keeps it out of
	// the oracle dedup path — cover revenue is a lagging metric, not a real-time
	// oracle price signal. Cooldown 900 s → 96 reads/day ≈ $0.96/day, well under
	// the loop's $5/day cap. The data source is the live DB (never cached), so
	// a drop in total_usdc within one 15-min window surfaces a revenue anomaly.
	{
		id: 'club-cover-revenue-summary',
		name: 'Club Cover Charge Revenue Summary',
		path: '/api/x402/club-cover',
		method: 'POST',
		body: { mode: 'revenue', period: '7d' },
		cooldown_s: 900,
		priority: 68,
		pipeline: 'volume',
		enabled: true,
		extractSignal: (r) => extractCoverRevenueSignal(r),
	},

	// ── Avatar Optimization Pipeline (nightly MCP Health) ─────────────────────
	// Pays $0.001 USDC to run optimize_model analysis on the top 50 most-viewed
	// public avatars. Results upserted to avatar_optimization_results per avatar_id.
	// Downstream consumer: avatar owner notifications + model quality dashboard.
	// Cooldown: 86400 s (nightly — keeps daily spend to $0.001).
	{
		id: 'avatar-optimize-batch',
		name: 'Avatar Optimization Pipeline',
		path: '/api/x402/avatar-optimize-batch',
		method: 'POST',
		body: { limit: 50 },
		cooldown_s: 86400,
		priority: 30,
		pipeline: 'health',
		enabled: true,
		extractSignal: (r) => ({
			analyzed: r?.analyzed,
			critical_count: r?.critical_count,
			warn_count: r?.warn_count,
			total_size_bytes: r?.total_size_bytes,
		}),
	},
	// ── Scene Capture Video Queue Processor (USE-013, 3D Pipeline) ────
	// Drains scene_capture_queue: pays $0.01 USDC for one processing credit, then
	// submits the queued user video to the LingBot-Map GPU worker; subsequent
	// ticks poll for completion (free) and store the finished .ply point-cloud URL
	// + telemetry back on the queue row. run()-style entry — owns the full
	// scan → pay → submit → poll → store sequence (scene-capture-processor.js).
	// Downstream consumer: src/scene-capture.js renders result_url as a THREE.Points
	// cloud on /capture. Cooldown 120 s so user uploads auto-process within minutes.
	{
		id: 'scene-capture-processor',
		name: 'Scene Capture Video Queue Processor',
		path: SCENE_CAPTURE_ENDPOINT,
		endpoint: SCENE_CAPTURE_ENDPOINT,
		method: 'GET',
		price_atomic: SCENE_CAPTURE_PRICE_ATOMIC,
		cooldown_s: 120,
		cooldown_seconds: 120,
		priority: 60,
		pipeline: 'self',
		enabled: true,
		run: (ctx) => runSceneCaptureProcessor(ctx),
		extractSignal: null,
	},
	// ── Avatar Marketplace Dynamic Pricing (USE-020) ──────────────────────────
	// Pricing-integrity probe across every premium cosmetic. run() sweeps each
	// item's live 402 quote (free), flags drift / underpricing vs the catalog's
	// server-owned price, and makes ONE real x402 purchase of the cheapest item to
	// validate quote → pay → settle end-to-end. Per-item findings land in
	// cosmetic_pricing_audit; a summary row (value_extracted = drift summary) goes
	// to x402_autonomous_log. Cooldown 86400 s (daily — cosmetic pricing is a
	// slow-changing config). Downstream consumer: ops gates avatar-shop releases on
	// the underpriced flag so a pricing bug never ships at a loss.
	{
		id: 'cosmetic-pricing-audit',
		name: 'Avatar Marketplace Dynamic Pricing',
		path: '/api/x402/cosmetic-purchase',
		method: 'GET',
		body: null,
		cooldown_s: 86400,
		priority: 32,
		pipeline: 'commerce',
		enabled: true,
		run: (ctx) => cosmeticPricingAudit(ctx),
	},
	// ── Payment Revenue Reconciliation (USE-027, Finance) ─────────────────────
	// Daily financial-integrity sweep. Probes the free /api/x402-status endpoint to
	// confirm payment wiring is live, then cross-checks every settlement our books
	// claim (outbound x402_autonomous_log paid rows + inbound agent_payment_intents)
	// against the actual on-chain transaction via getSignatureStatuses. Flags any
	// row where the DB says settled but no tx exists on-chain, the tx reverted, or
	// no signature was kept. run()-style entry — owns the full probe → load → verify
	// → upsert sequence (revenue-reconciliation.js); read-only, so it runs even when
	// the spend wallet is absent. Per-record verdicts land in payment_reconciliation;
	// a summary (value_extracted = discrepancy counts) goes to x402_autonomous_log.
	// Cooldown 86400 s (daily). Downstream consumer: the financial-integrity surface
	// reads payment_reconciliation WHERE NOT reconciled to alert ops on unsettled or
	// failed payments before they corrupt revenue accounting.
	{
		id: 'revenue-reconciliation',
		name: 'Payment Revenue Reconciliation',
		path: '/api/x402-status',
		endpoint: '/api/x402-status',
		method: 'GET',
		body: null,
		price_atomic: 0, // /api/x402-status is free; reconciliation owes no payment
		cooldown_s: 86400,
		cooldown_seconds: 86400,
		priority: 28,
		pipeline: 'reconciliation',
		enabled: true,
		run: (ctx) => revenueReconciliation(ctx),
	},
	// ── Ring Reconciliation (Finance) ─────────────────────────────────────────
	// Closes the reconciliation blind spot over the closed-loop x402 ring economy.
	// The daily revenue reconciler proves x402_autonomous_log + agent_payment_intents
	// against the chain but NEVER reads the ring's own books. This entry does: every
	// x402_self_facilitator_log settle and x402_ring_ledger sweep from the last 72h is
	// proven on-chain (batched getSignatureStatuses), a sampled subset is parsed to
	// verify the USDC amount + receiver + sweep direction (≤50 parsed-tx/run), the two
	// ring books are joined on signature to catch settlements with no buyer record (the
	// "leak through our own facilitator" case), daily logged fees are compared to the
	// fee-audit rollup, and a zero-volume tripwire fires when the ring is enabled but
	// silent for 30 min — the alarm that was missing when it stopped working quietly.
	// run()-style, read-only on chain (runs without the spend wallet). Verdicts land in
	// payment_reconciliation under ring_* sources so the ops board separates them;
	// CRITICAL for missing/failed/mismatch, WARN (daily-throttled) for coherence/fee
	// drift. Cooldown 1800 s (30 min) so the tripwire window stays tight.
	{
		id: 'ring-reconciliation',
		name: 'Ring Reconciliation',
		// path/endpoint informational — run() owns the multi-book verify itself.
		path: '/api/x402-facilitator',
		endpoint: '/api/x402-facilitator',
		method: 'GET',
		body: null,
		price_atomic: 0, // read-only audit of our own books + chain; owes no payment
		cooldown_s: 1800,
		cooldown_seconds: 1800,
		priority: 30,
		pipeline: 'reconciliation',
		enabled: true,
		run: (ctx) => ringReconciliation(ctx),
		extractSignal: null,
	},
	// Builder Code Attribution Tracker (Finance) — watchdog over ERC-8021
	// builder-code attribution, the mechanism Coinbase builder rewards / x402scan
	// use to credit on-chain x402 volume to the app that exposed the paid endpoint
	// (X402_BUILDER_CODE_APP = three_d_agent). run() sweeps a representative set of
	// priced /api/x402/* endpoints, verifying each declares the builder-code
	// extension (a = three_d_agent) on its live 402 challenge — any priced endpoint
	// that drops the declaration earns ZERO rewards on every dollar it settles, the
	// attribution gap this tracker alerts on. It then makes ONE real $0.001 USDC
	// payment to the cheapest declaring endpoint (dance-tip) with the builder-code
	// echo ATTACHED to the X-PAYMENT envelope (a/w/s), reads the X-PAYMENT-RESPONSE
	// settlement, and confirms an attributed payment settles end-to-end (the
	// resource server rejects a non-echoing payment with builder_code_tampered, so a
	// settled tx is proof). Per-endpoint verdicts upsert to builder_code_attribution
	// (keyed by endpoint); a summary (value_extracted = gap list + settle proof)
	// goes to x402_autonomous_log. Cooldown 21600 s (6h, ~$0.004/day) — attribution
	// config only changes on deploy/env, the live settle catches drift within hours.
	// Downstream consumer: api/ops/health.js -> loadBuilderAttribution() folds an
	// attribution gap (or a failed attributed settlement) into the platform health
	// verdict so on-call sees lost-rewards risk before a billing cycle closes.
	{
		id: 'builder-code-attribution',
		name: 'Builder Code Attribution Tracker',
		// path is informational — run() owns the multi-endpoint sweep + settle.
		path: '/api/x402/*',
		endpoint: '/api/x402/*',
		method: 'POST',
		body: null,
		price_atomic: 1000, // the single settlement proof pays $0.001 (dance-tip)
		cooldown_s: 21600,
		cooldown_seconds: 21600,
		priority: 31,
		pipeline: 'finance',
		enabled: true,
		run: (ctx) => builderCodeAttribution(ctx),
		extractSignal: null,
	},
	// ── Fee Calculation Validator (USE-028, Finance) ──────────────────────────
	// Fee-integrity probe over the platform's atomic↔decimal conversion — the
	// arithmetic that turns every USDC price into an x402 challenge amount and back
	// into a displayed dollar figure. run() exercises the REAL production
	// converters (usdcToAtomics / atomicsToUsdc) at the boundary atomics where
	// rounding bugs hide (1, 999, 1000, 1001, 999999), asserting exact render +
	// round-trip at each, then makes ONE real on-chain payment to the $0.001
	// dance-tip (1000 atomics — a boundary) to prove the deployed quote and the
	// settled amount agree with the local fee math end-to-end. Per-boundary
	// findings land in fee_calculation_audit; a summary (value_extracted = mismatch
	// counts) goes to x402_autonomous_log. Cooldown 21600 s (6h → ≤4 paid probes/day
	// ≈ $0.004/day) — fee math only changes on deploy, the live settle catches
	// deploy/env skew. Downstream consumer: ops gates releases on a mismatch=true
	// row (alongside cosmetic_pricing_audit) so an off-by-one in fee conversion
	// never ships and mis-bills buyers.
	{
		id: 'fee-calculation-validator',
		name: 'Fee Calculation Validator',
		path: '/api/x402/dance-tip',
		endpoint: '/api/x402/dance-tip',
		method: 'POST',
		body: null,
		price_atomic: 1000, // the live boundary settles $0.001; math sweep is free
		cooldown_s: 21600,
		cooldown_seconds: 21600,
		priority: 30,
		pipeline: 'finance',
		enabled: true,
		run: (ctx) => feeCalculationValidator(ctx),
	},
	// ── Charity Split Audit (Finance) ─────────────────────────────────────────
	// Giving-integrity audit — "ensures donation promises are kept." Weekly, it
	// (1) sweeps every charity-enabled merchant in x402_merchant_settings (free,
	// read-only) and flags any whose donation promise is unroutable (missing /
	// malformed cause address, zero share, cause == payout — a tip the checkout
	// silently drops), then (2) makes ONE real on-chain payment WITH a charity
	// split through the PRODUCTION checkout code (/api/x402-checkout prepare →
	// sign → encode → settle the $0.001 dance-tip, facilitator-sponsored fee) and
	// reads the settled tx back from chain to assert the cause wallet's
	// transferChecked leg landed with the EXACT computed atomics
	// (floor(amount × bps / 10000)). run() owns the sweep/pay/verify and writes
	// per-merchant + canary rows to charity_split_audit (value sink) and its own
	// x402_autonomous_log summary; the loop adds the billed row. The canary cause
	// wallet defaults to the seed wallet (safe self-route, zero net outflow);
	// X402_CHARITY_AUDIT_ADDRESS_SOLANA points it at a platform cause wallet.
	// Cooldown 604800 s (weekly) → ~$0.001/week. Downstream consumer: ops reads
	// charity_split_audit WHERE NOT config_valid OR charity_routed = false to alert
	// before a buyer is told their payment gave to a cause that never received it.
	{
		id: 'charity-split-audit',
		// path/endpoint are informational — run() probes + pays + verifies itself.
		path: '/api/x402-merchant',
		endpoint: '/api/x402-merchant',
		method: 'POST',
		price_atomic: 1000, // the canary settles the $0.001 dance-tip base; split rides along
		cooldown_s: 604800, // weekly — donation promises are a slow-changing config
		cooldown_seconds: 604800,
		priority: 31,
		pipeline: 'finance',
		enabled: true,
		run: (ctx) => charitySplitAudit(ctx),
		extractSignal: null,
	},
	// ── Cross-Chain Payment Cost Comparison (USE-029, Finance) ────────────────
	// Measures the real all-in cost of an identical $0.001 USDC payment on Solana
	// vs Base and tracks the gas premium between the rails over time. run() probes
	// the cheapest idempotent $0.001 endpoint (/api/x402/model-check) for the live
	// multi-network challenge (both networks quote the same amount, so the
	// comparison is apples to apples), settles the REAL Solana leg and reads its
	// actual on-chain meta.fee, prices the equivalent Base settlement from the live
	// Base gas price × the documented USDC ERC-3009 transferWithAuthorization gas
	// units, and converts both to USD with live SOL/ETH prices. Base outbound
	// settlement isn't attempted (no autonomous EVM payer is provisioned — same
	// boundary the circuit breaker hits); its gas figure is real live network data.
	// Per-run snapshots (amount + per-network gas/total USD + gas_premium_ratio +
	// cheapest_network) land in cross_chain_cost_comparison; the loop records the
	// paid Solana settlement to x402_autonomous_log (value_extracted = the cost
	// summary). Cooldown 3600 s (hourly — gas prices drift, one paid probe/hr ≈
	// $0.024/day) keeps a fresh premium trend well inside the daily cap.
	// Downstream consumer: GET /api/x402/network-cost surfaces the latest snapshot,
	// a rolling gas-premium average, and the recommended cheapest settlement
	// network — used to steer users to the cheaper rail and inform default pricing.
	{
		id: 'cross-chain-cost-comparison',
		name: 'Cross-Chain Payment Cost Comparison (Base + Solana)',
		// path/endpoint are informational — run() probes /api/x402/model-check and
		// settles the Solana leg itself. Real price is the live $0.001 challenge.
		path: '/api/x402-pay',
		endpoint: '/api/x402-pay',
		method: 'GET',
		price_atomic: 1000, // $0.001 USDC — the identical amount both rails quote
		cooldown_s: 3600,
		cooldown_seconds: 3600,
		priority: 34,
		pipeline: 'finance',
		enabled: true,
		run: (ctx) => crossChainCostComparison(ctx),
		extractSignal: null,
	},

	// ── IBM Granite Inference Health Check (USE-007) ──────────────────────────
	// Pays ONE real x402 batch call to /api/ibm-mcp that invokes all five paid
	// IBM Granite tools (chat, code, embed, analyze, forecast) with tiny canary
	// arguments. The IBM MCP server prices the whole request, so one on-chain
	// payment (~0.14 USDC) exercises the full watsonx.ai inference surface. run()
	// summarises the batch — verifying each tool answered with its expected schema
	// and tallying token throughput — and stores the verdict to
	// granite_inference_health (downstream consumer: GET /api/x402/granite-health,
	// the watsonx backend SLA + token-throughput dashboard feed). The paid
	// round-trip is recorded to x402_autonomous_log like every loop call.
	// Cooldown 21600 s (every 6 h → 4 paid sweeps/day ≈ $0.56/day) keeps an
	// expensive inference probe well inside the autonomous daily cap while still
	// catching a watsonx outage or a tool-schema regression within hours.
	{
		id: 'granite-inference-health',
		name: 'IBM Granite Inference Health Check',
		path: GRANITE_HEALTH_ENDPOINT,
		endpoint: GRANITE_HEALTH_ENDPOINT,
		method: 'POST',
		price_atomic: GRANITE_HEALTH_PRICE_ATOMIC,
		cooldown_s: 21600,
		cooldown_seconds: 21600,
		priority: 42,
		pipeline: 'health',
		enabled: true,
		run: (ctx) => runGraniteHealth(ctx),
		extractSignal: null,
	},

	// ── Rig Complexity Scorer (USE-017) ───────────────────────────────────────
	// Pays to call inspect_model on POST /api/mcp for a small batch of avatars
	// that have never been scored or whose GLB changed since the last score. From
	// each inspection it derives a 0-100 complexity score (bone count, vertices,
	// triangles, texture bytes, file size) and a tier (light/standard/heavy/
	// extreme), and upserts the result into avatar_complexity (keyed by avatar_id).
	// run() owns the per-avatar probe/pay/store and records one x402_autonomous_log
	// row per call with the parsed score in value_extracted (so it sets
	// outcome.recorded — the loop adds no duplicate summary row). Downstream
	// consumer: the Avatar Pricing Engine (USE-020) tiers marketplace listing
	// prices on avatar_complexity.tier, and the marketplace gallery raises a
	// "performance-heavy" badge when perf_warning is set. The MCP server prices
	// inspect_model at $0.01/call (no $0.001 tool exists), so each scored avatar
	// costs ~$0.01; cooldown 3600 s (hourly) with a 4-avatar batch drains any
	// backlog at ≤ $0.04/run and idles to ~zero spend once every avatar is scored.
	{
		id: 'rig-complexity-scorer',
		name: 'Rig Complexity Scorer',
		// path/endpoint are informational — run() builds the JSON-RPC body itself.
		path: '/api/mcp',
		endpoint: '/api/mcp',
		method: 'POST',
		body: null,
		price_atomic: 10_000, // $0.01 USDC — inspect_model's advertised per-call price
		cooldown_s: 3600,
		cooldown_seconds: 3600,
		priority: 48,
		pipeline: '3d',
		enabled: true,
		run: (ctx) => runRigComplexityScorer(ctx),
		extractSignal: null,
	},

	// ── Subscription Status Health Check (Commerce) ───────────────────────────
	// Daily integrity sweep over every paying x402 subscriber. run() enumerates all
	// subscriptions via the real admin endpoint GET /api/x402/admin/subscriptions
	// (authenticated as an internal service with INTERNAL_API_KEY — the GET-only
	// read bypass added to that route), falling back to the canonical
	// listSubscriptions() lib read if the HTTP path is unavailable. It classifies
	// each key (active | expiring_soon | expired | revoked), emails the subscriber
	// 7 days before expiry (once per expiry window), and upserts every verdict into
	// x402_subscription_health. Free + read-only: the admin endpoint owes no payment,
	// so this never moves funds (amountAtomic 0) and runs even without a spend
	// wallet. run() writes its own canonical x402_autonomous_log row (recorded:true)
	// with the per-run summary in value_extracted. Cooldown 86400 s (daily) → the
	// 7-day warning window is re-evaluated across ~7 runs so no expiry is missed.
	// Downstream consumer: the admin subscription-management surface badges
	// expiring/expired keys off x402_subscription_health, and ops alerting watches
	// status IN ('expired','expiring_soon') to catch a lapse before a partner's
	// integration breaks.
	{
		id: 'subscription-status-health-check',
		name: 'Subscription Status Health Check',
		// path/endpoint informational — run() owns the internal-service HTTP call.
		path: '/api/x402/admin/subscriptions',
		endpoint: '/api/x402/admin/subscriptions',
		method: 'GET',
		body: null,
		price_atomic: 0, // free internal endpoint — no payment owed
		cooldown_s: 86_400,
		cooldown_seconds: 86_400,
		priority: 34,
		pipeline: 'self',
		enabled: true,
		run: (ctx) => runSubscriptionHealth(ctx),
		extractSignal: null,
	},

	// ── External x402 Service Uptime Monitor (USE-038, Reliability) ────────────
	// Liveness gate in front of every external x402 service we depend on. The
	// registered external services live in x402_bazaar_catalog (snapshotted by the
	// Bazaar Discovery Warmup) plus any directly-registered EXTERNAL_ENDPOINTS;
	// production pipelines pay those endpoints, so a dead one wastes a tick (and
	// risks a half-settled payment). run() collects every distinct external URL and
	// probes each with a cheap, UNPAID HEAD request (falling back to OPTIONS then
	// GET when a server rejects HEAD): a 402 means the x402 endpoint is live, 2xx/3xx
	// is reachable, and 5xx or a network timeout means DOWN. Because the probe never
	// attaches an X-PAYMENT header, reading a 402 challenge is free — this pipeline
	// moves no funds (price_atomic 0, amountAtomic always 0). Each verdict upserts
	// into x402_service_uptime (consecutive_failures / last_seen_live tracked) and
	// run() records one x402_autonomous_log row per probe (value_extracted = the
	// verdict). Cooldown 900 s (15 min) catches an outage within minutes while a
	// Redis cursor rotates the per-run probe budget across a large catalog.
	// Downstream consumer: any pipeline paying an external endpoint calls
	// isServiceLive(sql, url) to skip a confirmed-dead service; listServiceUptime()
	// backs an ops reliability surface.
	{
		id: 'external-service-uptime-monitor',
		name: 'External x402 Service Uptime Monitor',
		// path/endpoint are informational — run() fans HEAD probes across the
		// external service registry itself; it owns no single URL.
		path: SERVICE_UPTIME_ENDPOINT,
		endpoint: SERVICE_UPTIME_ENDPOINT,
		method: 'HEAD',
		body: null,
		price_atomic: 0, // free probe — never pays
		cooldown_s: 900, // 15 min — catch outages fast; probes are free
		cooldown_seconds: 900,
		priority: 58, // reliability gate protects every paying external pipeline
		pipeline: 'reliability',
		enabled: true,
		run: (ctx) => runServiceUptimeMonitor(ctx),
		extractSignal: null,
	},

	// ── Spend Reservation Leak Detector (Finance) ─────────────────────────────
	// Liveness guard on the agent spend caps themselves. Every autonomous spend
	// reserves cap headroom first, then finalizes or releases it after settlement.
	// A crash between reserve and finalize/release orphans the reservation — it
	// holds headroom forever against money that never moved, silently exhausting
	// the agent's rolling-24h cap until every real spend fails `daily_exceeded`.
	// run() sweeps both reservation books for entries older than 1h that were never
	// finalized: USD reservations (agent_custody_events, status 'pending') released
	// via releaseSpendReservation() → marked 'failed', and SOL reservations
	// (agent_actions, payload.status 'reserved') recorded-then-released via
	// releaseSpend() (which deletes, so the evidence is captured first). Free DB
	// maintenance — no x402 challenge, no payment, amountAtomic always 0 — so it runs
	// even without the spend wallet (exactly when the cap most needs freeing). run()
	// writes its own canonical x402_autonomous_log row (recorded:true) with the sweep
	// summary in value_extracted. Cooldown 900 s (15 min) keeps the caps clean and
	// drains any backlog across runs. Value sink: spend_reservation_leaks (one row
	// per swept leak) + Redis x402:reservation-leak:{latest,alert}. Downstream
	// consumer: api/ops/health.js loadReservationLeaks() folds a spike in freshly
	// swept leaks into the platform health verdict (a sustained leak rate means a
	// reserve→finalize path is crashing and quietly starving agent spend caps).
	{
		id: 'spend-reservation-leak-detector',
		name: 'Spend Reservation Leak Detector',
		// path/endpoint are informational — run() owns the DB sweep + cleanup itself.
		path: '/api/_lib/agent-trade-guards',
		endpoint: '/api/_lib/agent-trade-guards',
		method: 'POST',
		body: null,
		price_atomic: 0, // free DB maintenance — no payment owed
		cooldown_s: 900, // 15 min — keep spend caps clean; the sweep is free
		cooldown_seconds: 900,
		priority: 62, // protects every autonomous spend path from a starved cap
		pipeline: 'finance',
		enabled: true,
		run: (ctx) => runReservationLeakDetector(ctx),
		extractSignal: null,
	},

	// ── Platform Revenue Analytics (USE-039, Oracle pipeline) ─────────────────
	// Pays $0.001 USDC every 15 min to POST /api/x402/analytics
	// ({ report:"revenue", period:"24h" }) and pulls the last 24 hours of real
	// platform revenue from the settled-payment ledger (x402_audit_log) plus the
	// measured settlement fee from cross_chain_cost_comparison. extractSignal lifts
	// { total_usd, top_endpoint, fee_collected } into oracle_intel_signals with
	// topic 'platform-revenue' so the sniper gate sees live platform health data.
	// The oracle upsert carries signal ('healthy'|'active'|'quiet') and a human
	// headline so the status dashboard can render it without re-querying.
	// Cooldown 900s (15 min) → 96 calls/day ≈ $0.096/day, well inside the loop cap.
	// Downstream consumers:
	//   • oracle_intel_signals WHERE topic = 'platform-revenue' — sniper gate health
	//   • x402_autonomous_log signal_data — autonomous loop status view
	{
		id: 'platform-revenue-analytics',
		name: 'Platform Revenue Analytics',
		path: '/api/x402/analytics',
		method: 'POST',
		body: { report: 'revenue', period: '24h' },
		cooldown_s: 900,
		priority: 87,
		pipeline: 'oracle',
		enabled: true,
		extractSignal: (r) => {
			const grossUsd = parseFloat(r?.totals?.gross_usd || '0');
			const feeUsd = parseFloat(r?.fee_splits?.settlement_fee_usd || '0');
			const payments = r?.totals?.total_payments ?? 0;
			const topEndpoint = r?.top_endpoint?.endpoint ?? null;
			const topCount = r?.top_endpoint?.count ?? 0;
			const topGross = r?.top_endpoint?.gross_usd ?? '0';
			const signal = grossUsd >= 0.10 ? 'healthy' : payments > 0 ? 'active' : 'quiet';
			const headline = payments > 0
				? `Platform earned $${grossUsd.toFixed(4)} gross in 24h across ${payments} payments${topEndpoint ? `; top: ${topEndpoint}` : ''}`
				: 'No settled payments in the last 24h';
			return {
				topic: 'platform-revenue',
				signal,
				headline,
				confidence: 1.0,
				price_usd: grossUsd,
				total_usd: grossUsd.toFixed(6),
				top_endpoint: topEndpoint,
				top_endpoint_count: topCount,
				top_endpoint_gross: topGross,
				fee_collected: feeUsd.toFixed(6),
				net_platform_usd: r?.totals?.net_platform_usd ?? null,
				total_payments: payments,
				unique_payers: r?.totals?.unique_payers ?? 0,
				period: r?.period ?? '24h',
				generated_at: r?.generated_at ?? null,
			};
		},
	},
	// ── Sniper Trade Performance Analytics (USE-041) ──────────────────────────
	// Pays $0.005 USDC every 5 minutes to POST /api/x402/analytics with
	// { report: "sniper_trades", period: "24h" } to fetch the autonomous sniper's
	// real trade performance from the closed agent_sniper_positions ledger: win rate,
	// average profit (SOL + USDC at the live SOL/USD quote), worst loss, and total
	// SOL volume snipped. The extracted signal is actionable: if win_rate drops below
	// 40% across ≥ 5 closed trades the endpoint itself raises a low-win-rate alert
	// in signal_data.alert — the strategy auto-tuner reads that field to pull back
	// sizing or tighten entry filters before the next snipe. extractSignal lifts the
	// headline metrics into x402_autonomous_log.signal_data; storeValue appends every
	// snapshot to the sniper_trade_analytics time series (used by the performance
	// dashboard). As a `sniper` pipeline entry the signal is NOT upserted into
	// oracle_intel_signals (win rate is a trailing metric, not a real-time oracle
	// price feed). Cooldown 300s → 288 reads/day ≈ $1.44/day, well under the loop cap.
	// Downstream consumers: sniper_trade_analytics time series + the alert field in
	// x402_autonomous_log.signal_data (strategy auto-tuner, ops dashboard).
	{
		id: 'sniper-trade-analytics',
		name: 'Sniper Trade Performance Analytics',
		path: '/api/x402/analytics',
		method: 'POST',
		body: { report: 'sniper_trades', period: '24h' },
		cooldown_s: 300,
		priority: 72,
		pipeline: 'sniper',
		enabled: true,
		extractSignal: (r) => classifySniperSignal(r),
		storeValue: async ({ sql, responseBody, signalData, runId }) => {
			if (!sql) return;
			const report = responseBody || signalData;
			if (!report || report.sample_size == null) return;
			await insertSniperAnalytics(sql, report, { runId, source: 'x402-autonomous' });
		},
	},

	// ── Agent x402 Spend Leaderboard (USE-043, Oracle pipeline) ──────────────────
	// Pays $0.005 USDC every 30 min to POST /api/x402/analytics
	// ({ report:"agent_leaderboard", limit:10 }) and pulls the top 10 agents by
	// completed x402 USDC spend in the trailing 7-day window from the real
	// agent-to-agent hire ledger (agent_hires JOIN agent_identities). The extracted
	// signal surfaces the highest-value paying agents — the actionable intelligence
	// partnership outreach uses to prioritize engagement: top_agent_id,
	// top_agent_name, top_agent_spend_usdc (the #1 spender), and the full ranked
	// leaderboard. As an `oracle` pipeline entry the signal is also upserted into
	// oracle_intel_signals (topic 'agent_leaderboard') with a signal
	// ('live'|'quiet') and a human headline. storeValue appends every snapshot to
	// agent_spend_leaderboard_snapshots (the partnership-outreach time series).
	// Agent-economy spend changes at most daily, so cooldown 1800s (30 min) is fine
	// — 48 calls/day × $0.005 ≈ $0.24/day, bounded by the loop's daily cap.
	{
		id: 'agent-spend-leaderboard',
		name: 'Agent x402 Spend Leaderboard',
		path: '/api/x402/analytics',
		method: 'POST',
		body: { report: 'agent_leaderboard', limit: 10 },
		cooldown_s: 1800, // 30 min — hire ledger changes are slow; $0.24/day
		priority: 72,     // oracle tier, below macro signals (85-99) but above volume (65-75)
		pipeline: 'oracle',
		enabled: true,
		extractSignal: (r) => classifyLeaderboard(r),
		storeValue: async ({ sql, responseBody, signalData, runId }) => {
			if (!sql) return;
			const v = signalData || classifyLeaderboard(responseBody);
			if (v.agent_count == null) return;
			await insertLeaderboardSnapshot(sql, v, { runId, source: 'x402-autonomous' });
		},
	},

	// ── Marketplace Catalog Stats (USE-044, Health) ───────────────────────────
	// Pays $0.005 USDC to POST /api/x402/analytics { report:"marketplace", period:"7d" }
	// every 5 minutes. Confirms the public agent marketplace is alive and measures
	// catalog depth + pricing health: listing_count > 0 means the catalog table is
	// reachable and populated; avg_price_sol tracks whether pricing is in a sane range
	// (null = SOL oracle outage; a sudden spike = mis-configurations); most_viewed_id
	// anchors a deep-link to the top listing without a follow-up query. Lives in the
	// 'health' pipeline — signal_data feeds the platform-status surface and the
	// autonomous-log time series so ops can detect a dead catalog within minutes.
	// Cooldown 300s → 12 reads/hour ≈ $0.06/hr, well inside the $5/day cap.
	{
		id: 'marketplace-catalog-stats',
		name: 'Marketplace Catalog Stats',
		path: '/api/x402/analytics',
		method: 'POST',
		body: { report: 'marketplace', period: '7d' },
		cooldown_s: 300,
		priority: 55,
		pipeline: 'health',
		enabled: true,
		extractSignal: (r) => ({
			listing_count: r?.catalog?.listing_count ?? null,
			priced_listings: r?.catalog?.priced_listings ?? null,
			free_listings: r?.catalog?.free_listings ?? null,
			new_in_period: r?.catalog?.new_in_period ?? null,
			avg_price_usd: r?.pricing?.avg_price_usd ?? null,
			avg_price_sol: r?.pricing?.avg_price_sol ?? null,
			sol_usd_price: r?.pricing?.sol_usd_price ?? null,
			total_views: r?.engagement?.total_views ?? null,
			most_viewed_id: r?.engagement?.most_viewed_id ?? null,
			most_viewed_name: r?.engagement?.most_viewed_name ?? null,
		}),
	},
	// ── User Activity Analytics (USE-040) ─────────────────────────────────────
	// Pays $0.005 USDC every 6h to POST /api/x402/analytics with
	// { report: "user_activity", period: "7d" }. Computes DAU, WAU, stickiness
	// (DAU/WAU), top features by usage_events volume, platform error rate, and
	// session-length distribution (avg / median / p90) from the real metered
	// tables — usage_events + sessions. extractSignal lifts { dau, wau,
	// top_feature } into x402_autonomous_log.signal_data. storeValue upserts each
	// snapshot into user_activity_snapshots (DDL-guarded time series) for the
	// engagement dashboard and trend alerting. Cooldown 21600s (6h) → 4
	// snapshots/day ≈ $0.02/day, well within the cap.
	{
		id: 'user-activity-analytics',
		name: 'User Activity Analytics (DAU/WAU)',
		path: '/api/x402/analytics',
		method: 'POST',
		body: { report: 'user_activity', period: '7d' },
		cooldown_s: 21600, // 6h — engagement is a slow-moving signal
		priority: 58,
		pipeline: 'health',
		enabled: true,
		extractSignal: (r) => extractActivitySignal(r),
		storeValue: async ({ sql: sqlClient, responseBody, signalData, runId }) => {
			if (!sqlClient) return;
			const r = responseBody || {};
			const sig = signalData || extractActivitySignal(r);
			await sqlClient`
				CREATE TABLE IF NOT EXISTS user_activity_snapshots (
					id            bigserial PRIMARY KEY,
					run_id        uuid,
					period        text NOT NULL DEFAULT '7d',
					dau           int NOT NULL DEFAULT 0,
					wau           int NOT NULL DEFAULT 0,
					stickiness    numeric(6,3),
					active_actors int,
					total_events  bigint,
					error_rate    numeric(8,4),
					top_feature   text,
					top_features  jsonb,
					session_avg_s numeric(10,1),
					session_p90_s numeric(10,1),
					ts            timestamptz NOT NULL DEFAULT now()
				)
			`.catch(() => {});
			await sqlClient`
				INSERT INTO user_activity_snapshots
					(run_id, period, dau, wau, stickiness, active_actors,
					 total_events, error_rate, top_feature, top_features,
					 session_avg_s, session_p90_s, ts)
				VALUES (
					${runId},
					${r.period || '7d'},
					${sig.dau || 0},
					${sig.wau || 0},
					${r.stickiness ?? null},
					${r.active_actors ?? null},
					${r.total_events ?? null},
					${r.error_rate ?? null},
					${sig.top_feature || null},
					${JSON.stringify(r.top_features || [])},
					${r.session_length?.avg_seconds ?? null},
					${r.session_length?.p90_seconds ?? null},
					now()
				)
			`.catch(() => {});
		},
	},

	// ── x402 Volume Analytics (USE-042, Volume) ───────────────────────────────
	// Pays $0.005 USDC every 30 min to POST /api/x402/analytics with
	// { report: "x402_volume", period: "24h" }. Reads the platform's settled
	// payment ledger (x402_audit_log via getPaymentStats) and returns x402
	// transaction volume across EVERY endpoint: total settled calls, total USDC
	// paid, unique payers, the per-endpoint breakdown, and the least-active
	// ("underused") endpoints. extractSignal lifts the headline totals + the
	// underused-endpoint list into x402_autonomous_log.signal_data — the
	// actionable signal proves ecosystem growth over time and flags endpoints to
	// promote or retire. 'volume' pipeline. Cooldown 1800s → 48 reads/day ≈
	// $0.24/day, well inside the $5/day cap.
	{
		id: 'analytics-x402-volume',
		name: 'x402 Volume Analytics',
		path: '/api/x402/analytics',
		method: 'POST',
		body: { report: 'x402_volume', period: '24h' },
		cooldown_s: 1800, // 30 min — aggregate volume is a slow-moving signal
		priority: 68, // volume pipeline (65–75)
		pipeline: 'volume',
		enabled: true,
		extractSignal: (r) => ({
			report: r?.report || 'x402_volume',
			period: r?.period || null,
			total_calls: r?.total_calls ?? 0,
			total_usdc_paid: r?.total_usdc_paid ?? '0',
			unique_payers: r?.unique_payers ?? 0,
			total_failed: r?.total_failed ?? 0,
			endpoint_count:
				r?.endpoint_count ?? (Array.isArray(r?.by_endpoint) ? r.by_endpoint.length : 0),
			top_endpoint: r?.by_endpoint?.[0]?.route ?? null,
			underused_endpoints: Array.isArray(r?.underused_endpoints)
				? r.underused_endpoints.map((e) => e?.route).filter(Boolean)
				: [],
		}),
	},

	// ── Skill Marketplace: Most-Used Skills (USE-057) ─────────────────────────
	// Pays $0.001 USDC every 30 min to POST /api/x402/skill-marketplace with
	// { mode: "popular", limit: 5 }, which queries the real agent_hires ledger
	// (completed hires, last 7 days) grouped by skill_name and returns the 5
	// most-purchased capabilities on the platform. extractSignal lifts the
	// actionable signal — { top_skill_id, top_skill_name, top_skill_purchases }
	// plus the full ranked list — into x402_autonomous_log.signal_data so the
	// featured-listings curator can promote high-demand skills without a separate
	// query. A change in top_skill_id between runs signals an emerging workflow
	// trend worth surfacing in the marketplace. Volume pipeline (not oracle —
	// skill popularity is a lagging demand metric, not a real-time price feed).
	// Cooldown 1800s → 48 reads/day ≈ $0.048/day, inside the $5/day cap.
	{
		id: 'skill-marketplace-popular',
		name: 'Skill Marketplace: Most-Used Skills',
		path: '/api/x402/skill-marketplace',
		method: 'POST',
		body: { mode: 'popular', limit: 5 },
		cooldown_s: 1800, // 30 min — hire-ledger demand signal changes slowly
		priority: 67,     // volume pipeline (65–75)
		pipeline: 'volume',
		enabled: true,
		extractSignal: (r) => {
			const skills = Array.isArray(r?.skills) ? r.skills : [];
			const top = skills[0] || null;
			return {
				top_skill_id: top?.id ?? null,
				top_skill_name: top?.name ?? null,
				top_skill_purchases: top?.purchases ?? null,
				skill_count: skills.length,
				period: r?.period ?? '7d',
				skills: skills.map((s) => ({
					id: s.id,
					name: s.name,
					purchases: s.purchases,
				})),
			};
		},
	},

	// ── Rate-Limit Capacity Probe (USE-074) ────────────────────────────────────
	// Pays $0.001 USDC every 5 min to POST /api/x402/rate-limit-probe with
	// body { endpoint: '/api/x402/crypto-intel' }. The probe reads the autonomous
	// loop's own Redis telemetry — daily spend vs cap, plus per-entry cooldown
	// TTLs for all registry entries that call crypto-intel — and returns:
	//   { remaining_calls, reset_at, limit, daily_cap_atomic, daily_spent_atomic,
	//     remaining_capacity_atomic, price_atomic, cooldown_active, cooldown_ttl_seconds }
	// extractSignal lifts the actionable fields into x402_autonomous_log.signal_data
	// so the loop can dynamically throttle: when remaining_calls falls below a
	// threshold, lower-priority entries yield their slot so oracle calls keep going.
	// 'health' pipeline — platform telemetry, not a market signal, so not upserting
	// to oracle_intel_signals. Cooldown 300s → 12 reads/hour → $0.288/day.
	{
		id: 'rate-limit-probe-crypto-intel',
		name: 'Rate-Limit Capacity Probe: crypto-intel',
		path: '/api/x402/rate-limit-probe',
		method: 'POST',
		body: { endpoint: '/api/x402/crypto-intel' },
		cooldown_s: 300,
		priority: 60,
		pipeline: 'health',
		enabled: true,
		extractSignal: (r) => ({
			remaining_calls:           r?.remaining_calls           ?? null,
			reset_at:                  r?.reset_at                  ?? null,
			limit:                     r?.limit                     ?? null,
			daily_spent_atomic:        r?.daily_spent_atomic        ?? null,
			remaining_capacity_atomic: r?.remaining_capacity_atomic ?? null,
			price_atomic:              r?.price_atomic              ?? null,
			cooldown_active:           r?.cooldown_active           ?? null,
			cooldown_ttl_seconds:      r?.cooldown_ttl_seconds      ?? null,
		}),
	},


	// ── LLM Proxy Latency Benchmark (USE-076) ─────────────────────────────────
	// Pays $0.005 USDC every 10 min to POST /api/x402/llm-proxy with the
	// minimal "Count to 3." canary prompt. Measures wall-clock latency across
	// the platform's free-first provider chain (Groq → OpenRouter → NVIDIA NIM
	// → Anthropic). extractSignal lifts { latency_ms, tokens_used, model,
	// provider, slow } into x402_autonomous_log.signal_data. storeValue computes
	// rolling p95 latency from the last 20 successful samples and raises a Redis
	// alert (x402:llm-proxy-latency:p95-alert, 25-min TTL) when p95 > 3 seconds
	// so ops can investigate provider degradation before end users notice.
	// Cooldown 600s → 6 probes/hr × $0.005 = $0.03/hr, well under the daily cap.
	// Health pipeline — not oracle (platform infra health, not a trading signal).
	{
		id: 'llm-proxy-latency',
		name: 'LLM Proxy Latency Benchmark',
		path: '/api/x402/llm-proxy',
		method: 'POST',
		body: { model: 'fast', prompt: 'Count to 3.', max_tokens: 10 },
		cooldown_s: 600, // 10 min — latency benchmark cadence
		priority: 52,
		pipeline: 'health',
		enabled: true,
		extractSignal: (r) => ({
			latency_ms: r?.latency_ms ?? null,
			tokens_used: r?.tokens_used ?? null,
			model: r?.model ?? null,
			provider: r?.provider ?? null,
			slow: typeof r?.latency_ms === 'number' && r.latency_ms > 3000,
		}),
		storeValue: async ({ sql: sqlClient, redis, signalData }) => {
			if (!sqlClient || signalData?.latency_ms == null) return;
			const P95_ALERT_KEY = 'x402:llm-proxy-latency:p95-alert';
			const P95_ALERT_TTL = 25 * 60; // 25 min — covers 2.5 missed ticks
			const P95_THRESHOLD_MS = 3000;
			try {
				const rows = await sqlClient`
					SELECT (signal_data->>'latency_ms')::numeric AS latency_ms
					  FROM x402_autonomous_log
					 WHERE endpoint_url LIKE '%/api/x402/llm-proxy'
					   AND success = true
					   AND signal_data->>'latency_ms' IS NOT NULL
					 ORDER BY ts DESC
					 LIMIT 20
				`;
				if (rows.length < 3) return; // not enough samples yet
				const latencies = rows
					.map((row) => Number(row.latency_ms))
					.filter((n) => n > 0)
					.sort((a, b) => a - b);
				const p95idx = Math.ceil(latencies.length * 0.95) - 1;
				const p95 = latencies[Math.max(0, p95idx)];
				if (p95 > P95_THRESHOLD_MS) {
					if (redis) {
						await redis.set(
							P95_ALERT_KEY,
							JSON.stringify({
								p95_ms: p95,
								sample_count: latencies.length,
								threshold_ms: P95_THRESHOLD_MS,
								ts: new Date().toISOString(),
							}),
							{ ex: P95_ALERT_TTL },
						);
					}
					console.warn(
						`[x402/llm-proxy-latency] ALERT: p95 latency ${p95}ms exceeds ` +
						`${P95_THRESHOLD_MS}ms threshold (${latencies.length} samples)`,
					);
				} else if (redis) {
					await redis.del(P95_ALERT_KEY).catch(() => {});
				}
			} catch (err) {
				console.warn(`[x402/llm-proxy-latency] p95 check failed: ${err?.message || err}`);
			}
		},
	},

	// ── API Key Validity Health Check (USE-075) ───────────────────────────────
	// Pays $0.001 USDC every hour to POST /api/x402/api-key-health with
	// { scope: "autonomous_loop" }. Confirms the platform has a valid, non-expired
	// access key (subscription or INTERNAL_API_KEY) covering the autonomous loop
	// scope. extractSignal lifts { valid, scopes, expires_at, hours_until_expiry,
	// expiry_warning } into x402_autonomous_log.signal_data. storeValue raises a
	// Redis alert (x402:api-key-health:expiry-alert, TTL 1h) when hours_until_expiry
	// < 24 — giving the ops surface a 24-hour window to renew before the loop's
	// bypass lane lapses and every endpoint in the tick starts getting 402'd.
	// Hourly cadence → 24 calls/day × $0.001 = $0.024/day, negligible against the
	// $5 cap. Health pipeline. Priority 55 (mid-range health tier).
	{
		id: 'api-key-validity-check',
		name: 'API Key Validity Health Check',
		path: '/api/x402/api-key-health',
		method: 'POST',
		body: { scope: 'autonomous_loop' },
		cooldown_s: 3600, // hourly — key expiry is slow-changing; 24h warning window is ample
		priority: 55,
		pipeline: 'health',
		enabled: true,
		extractSignal: (r) => {
			const expiresAt = r?.expires_at ? new Date(r.expires_at).getTime() : null;
			const hoursUntilExpiry =
				expiresAt != null ? Math.round((expiresAt - Date.now()) / 3_600_000) : null;
			return {
				valid: r?.valid === true,
				scopes: Array.isArray(r?.scopes) ? r.scopes : [],
				expires_at: r?.expires_at || null,
				key_type: r?.key_type || null,
				source: r?.source || null,
				hours_until_expiry: hoursUntilExpiry,
				expiry_warning: hoursUntilExpiry !== null && hoursUntilExpiry < 24,
			};
		},
		storeValue: async ({ redis, signalData }) => {
			if (!redis || !signalData) return;
			const ALERT_KEY = 'x402:api-key-health:expiry-alert';
			const ALERT_TTL = 3600; // 1h — re-alerts each hourly tick while warning persists
			try {
				if (!signalData.valid) {
					await redis.set(
						ALERT_KEY,
						JSON.stringify({
							valid: false,
							scopes: signalData.scopes,
							expires_at: signalData.expires_at,
							ts: new Date().toISOString(),
						}),
						{ ex: ALERT_TTL },
					);
					console.warn('[x402/api-key-health] ALERT: no valid key found for scope autonomous_loop');
				} else if (signalData.expiry_warning) {
					await redis.set(
						ALERT_KEY,
						JSON.stringify({
							valid: true,
							hours_until_expiry: signalData.hours_until_expiry,
							expires_at: signalData.expires_at,
							key_type: signalData.key_type,
							ts: new Date().toISOString(),
						}),
						{ ex: ALERT_TTL },
					);
					console.warn(
						`[x402/api-key-health] ALERT: autonomous_loop key expires in ` +
						`${signalData.hours_until_expiry}h (expires_at: ${signalData.expires_at})`,
					);
				} else {
					// Healthy — clear any lingering alert flag.
					await redis.del(ALERT_KEY);
				}
			} catch (err) {
				console.warn(`[x402/api-key-health] alert write failed: ${err?.message || err}`);
			}
		},
	},

	// ── LLM Proxy: Output Quality Probe (USE-077) ─────────────────────────────
	// Pays $0.005 USDC every 10 min to POST /api/x402/llm-proxy with a minimal
	// arithmetic prompt ("What is 7 + 8? Reply with only the number.") to verify
	// the LLM proxy returns a correct, deterministic response. A correct answer of
	// "15" confirms the provider chain is producing valid output — not garbled, not
	// truncated, not hallucinating on trivial math. extractSignal lifts { output,
	// correct, provider, latency_ms } into x402_autonomous_log.signal_data.
	// correct:false triggers an immediate quality_failure Redis alert
	// (x402:llm-proxy:quality-alert, TTL 25 min) so ops can investigate model
	// degradation before agents downstream experience silent LLM failures. Health
	// pipeline — not oracle (output correctness is platform telemetry, not a
	// trading signal). Cooldown 600s → 144 probes/day × $0.005 = $0.72/day,
	// well under the loop's daily cap.
	{
		id: 'llm-proxy-output-quality',
		name: 'LLM Proxy: Output Quality Probe',
		path: '/api/x402/llm-proxy',
		method: 'POST',
		body: { model: 'reasoning', prompt: 'What is 7 + 8? Reply with only the number.', max_tokens: 5 },
		cooldown_s: 600,
		priority: 56,
		pipeline: 'health',
		enabled: true,
		extractSignal: (r) => {
			const raw = typeof r?.content === 'string' ? r.content.trim() : null;
			const correct = raw === '15';
			return {
				output: raw,
				correct,
				quality_failure: !correct,
				provider: r?.provider ?? null,
				model: r?.model ?? null,
				latency_ms: r?.latency_ms ?? null,
				tokens_used: r?.tokens_used ?? null,
			};
		},
		storeValue: async ({ redis, signalData }) => {
			if (!redis) return;
			const v = signalData || {};
			const ALERT_KEY = 'x402:llm-proxy:quality-alert';
			const ALERT_TTL_SECONDS = 25 * 60;
			const failed = v.quality_failure === true;
			try {
				if (failed) {
					await redis.set(
						ALERT_KEY,
						JSON.stringify({
							output: v.output ?? null,
							expected: '15',
							provider: v.provider ?? null,
							model: v.model ?? null,
							latency_ms: v.latency_ms ?? null,
							ts: new Date().toISOString(),
						}),
						{ ex: ALERT_TTL_SECONDS },
					);
					console.warn(
						`[x402/llm-proxy-quality] ALERT: quality_failure — ` +
						`output="${v.output}" expected "15" ` +
						`(provider=${v.provider}, model=${v.model})`,
					);
				} else if (v.correct === true) {
					await redis.del(ALERT_KEY);
				}
			} catch (err) {
				console.warn(`[x402/llm-proxy-quality] alert write failed: ${err?.message || err}`);
			}
		},
	},

];

// ── External registry ─────────────────────────────────────────────────────────
// External x402 services. Endpoints discovered via bazaar or direct registration.
// Add entries here as external services are onboarded. The autonomous loop
// calls these exactly like self-endpoints — same payment flow, same recording.
//
// X402_EXTERNAL_ENABLED=false disables the entire external section without
// touching individual enabled flags.

const EXTERNAL_ENDPOINTS = [
	// Populated by agents building out the external/ use cases.
	// Each entry added here becomes an active call in the autonomous loop.
	// Example structure (commented out until service endpoint is discovered):
	//
	// {
	//   id: 'helius-rpc-ping',
	//   name: 'Helius Premium RPC Health',
	//   url: 'https://api.helius.xyz/v0/x402/ping',
	//   method: 'GET',
	//   body: null,
	//   cooldown_s: 300,
	//   priority: 80,
	//   pipeline: 'external',
	//   enabled: false, // enable once endpoint URL confirmed
	//   extractSignal: (r) => ({ latency_ms: r?.latency_ms }),
	// },
];

// Maximum entries the loop processes per tick (prevents runaway spend). Raised
// from the original demo curve (8) to serve more of the ready backlog each tick
// and lift real throughput across the catalog. Per-endpoint cooldowns still gate
// how often any single endpoint is hit, so a higher per-tick budget broadens
// volume without hammering one service. Override via env.
export const MAX_PER_TICK = Number(process.env.X402_AUTONOMOUS_MAX_PER_TICK || 12);

// Daily USDC spend cap for the autonomous loop (atomics, 6 decimals). Raised from
// the demo default ($5) to $15 so the higher per-tick throughput isn't money-
// starved mid-day. Still a hard, bounded ceiling enforced per tick — raise it
// via env (together with actually funding the payer) without a deploy.
// Default: $15.00 = 15_000_000 atomics. Override via X402_AUTONOMOUS_DAILY_CAP_ATOMIC.
export const DAILY_CAP_ATOMIC = Number(process.env.X402_AUTONOMOUS_DAILY_CAP_ATOMIC || 15_000_000);

export function getSelfRegistry() { return SELF_ENDPOINTS; }
export function getExternalRegistry() { return EXTERNAL_ENDPOINTS; }

export function getFullRegistry() {
	const externalEnabled = process.env.X402_EXTERNAL_ENABLED !== 'false';
	const self = SELF_ENDPOINTS.filter((e) => e.enabled);
	const external = externalEnabled ? EXTERNAL_ENDPOINTS.filter((e) => e.enabled) : [];
	return [...self, ...external];
}
