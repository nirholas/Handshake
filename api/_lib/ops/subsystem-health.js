// @ts-check
// Platform subsystem health — the single gatherer that answers "is the platform
// actually healthy right now?" beyond "did the endpoint return 200".
//
// The uptime monitor (api/cron/uptime-check.js) probes public-surface
// REACHABILITY. That's necessary but not sufficient: a surface can answer 200
// while Redis is on memory-fallback, the x402 ring is half-armed, Helius is in
// quota cooldown, or world.three.ws is unprotected — every one of these was
// live in the 2026-07-03 production log export yet invisible to a reachability
// probe. This module reads the in-process degradation state each subsystem
// already tracks (cache circuit breaker, Helius breaker, ring invariants) plus a
// live DB ping, the world-health cron's parked outcome, and the sniper worker's
// bot_heartbeat row, and rolls them into one structured verdict.
//
// Consumed by:
//   - api/healthz.js         → `subsystems` block (live, per-request)
//   - api/status.js          → public status feed + /status page
//   - api/cron/uptime-check.js → rolling health snapshots + escalation digest
//
// Every check is defensive: a check that throws becomes `unknown`, never an
// exception into the caller. Reads are cheap (module-state gauges + one DB ping),
// so this is safe on a per-request path.
//
// Status vocabulary:
//   ok        — healthy.
//   degraded  — functional but running on a fallback / throttled path.
//   down      — not functional (a hard dependency is unreachable).
//   paused    — intentionally off (an operator switch), not a fault.
//   unknown   — no signal yet (a cron hasn't reported, a probe was skipped).
// Only `degraded` and `down` count against the overall roll-up; `paused` and
// `unknown` are surfaced but neutral.

import { cacheHealth, cacheGet } from '../cache.js';
import { heliusHealth } from '../balances.js';
import { rpcLaneHealth } from '../solana/connection.js';
import { rateLimiterHealth } from '../rate-limit.js';
import { checkRingInvariants } from '../x402/ring-allowlist.js';
import { gatherX402SettleHealth } from './x402-settle-health.js';
import { gatherForgeHealth } from './forge-health-sensor.js';
import { gatherObjectStorageHealth } from './object-storage-health.js';
import { gatherIndexLagHealth } from './index-lag.js';
import { gatherHomeHealth } from './home-health.js';
import { describeSolvency } from '../sniper-solvency.js';

const DB_PING_TIMEOUT_MS = 2_500;
const DB_SLOW_MS = 1_000;
const WORLD_HEALTH_CACHE_KEY = 'world:health';
// A parked world-health outcome older than this is treated as stale/unknown
// rather than trusted — the 15-min cron should refresh it well within the window.
const WORLD_STALE_MS = 90 * 60 * 1000;
// Sniper worker heartbeat (bot_heartbeat, worker='agent-sniper'). It beats every
// ~30s; /api/sniper/status calls it dead past 90s. For paging we use a wider
// window so a deploy blip doesn't page, but a real death pages within two ticks.
// The 2026-07-03 outage (heartbeat frozen 36h, oracle scoring flat-lined, zero
// alerts) is exactly the failure this check exists to catch.
const SNIPER_FRESH_MS = 90_000;
const SNIPER_DOWN_MS = 10 * 60 * 1000;
// OKX marketplace chat bot (workers/okx-chat-bot, bot_heartbeat worker='okx-chat-bot').
// It beats every ~30s and carries its own verdict in meta. Its defining failure is
// SILENT: the wallet session expires, every XMTP client goes offline, and chat is
// simply never delivered until OKX's own 30-minute chat test flags the listing
// offline. A stale heartbeat means the host itself is gone; a fresh one carrying
// meta.health='down' means the host is alive and telling us a human is needed.
const OKX_BOT_FRESH_MS = 2 * 60 * 1000;
const OKX_BOT_DOWN_MS = 10 * 60 * 1000;

/** Statuses that pull the overall roll-up down, worst first. */
const UNHEALTHY = ['down', 'degraded'];

function worstOf(statuses) {
	if (statuses.includes('down')) return 'down';
	if (statuses.includes('degraded')) return 'degraded';
	return 'ok';
}

// ── Individual subsystem checks. Each returns a subsystem record and never
//    throws; a failure to determine state resolves to `unknown`. ──────────────

async function checkDatabase() {
	const base = { name: 'database', label: 'Database (Neon)' };
	try {
		const { sql } = await import('../db.js');
		const started = Date.now();
		await Promise.race([
			sql`SELECT 1`,
			new Promise((_, reject) =>
				setTimeout(() => reject(new Error('db ping exceeded deadline')), DB_PING_TIMEOUT_MS),
			),
		]);
		const ms = Date.now() - started;
		if (ms >= DB_SLOW_MS) {
			return { ...base, status: 'degraded', detail: `slow ping: ${ms}ms`, latencyMs: ms, hint: 'Neon compute may be saturated or cold — check the pooler and compute size.' };
		}
		return { ...base, status: 'ok', detail: `ping ${ms}ms`, latencyMs: ms };
	} catch (err) {
		return {
			...base,
			status: 'down',
			detail: err?.message || 'ping failed',
			hint: 'DATABASE_URL missing/rotated or Neon compute suspended. Audit writes and reads fail until restored.',
		};
	}
}

function checkCache() {
	const base = { name: 'cache', label: 'Cache (Upstash Redis)' };
	try {
		const h = cacheHealth();
		if (!h.configured) {
			return { ...base, status: 'ok', detail: 'in-memory (no Redis configured)', backend: h.backend };
		}
		if (h.degraded) {
			const why = h.circuitOpen
				? `circuit open, reopens in ${Math.round(h.circuitReopensInMs / 1000)}s`
				: 'SET writes suppressed';
			// An exhausted plan allowance and a slow store both read as "degraded",
			// but only one of them is fixable by a timeout knob. Name the real cause.
			const hint = h.quotaExhausted
				? 'Upstash has spent its plan-wide command allowance — commands are REJECTED, not slow. ' +
					'No timeout or region change helps; the counter resets on the plan boundary. ' +
					'Raise the Upstash plan or cut command volume. Reads serve from memory meanwhile.'
				: 'Upstash is timing out — use a same-region cache store or raise CACHE_REDIS_CMD_TIMEOUT_MS. Reads keep serving.';
			return {
				...base,
				status: 'degraded',
				detail: `${why}; serving from memory (${h.totalSetFailures} SET fails, ${h.totalCircuitOpens} opens since start)${h.quotaExhausted ? ' — plan command allowance exhausted' : ''}`,
				backend: h.backend,
				metrics: { totalSetFailures: h.totalSetFailures, totalCircuitOpens: h.totalCircuitOpens },
				quotaExhausted: h.quotaExhausted,
				hint,
			};
		}
		return { ...base, status: 'ok', detail: `upstash healthy`, backend: h.backend, metrics: { totalSetFailures: h.totalSetFailures, totalCircuitOpens: h.totalCircuitOpens } };
	} catch (err) {
		return { ...base, status: 'unknown', detail: err?.message || 'unreadable' };
	}
}

// The rate limiter guards every money-moving endpoint on the platform, yet it had
// no health surface: when its Redis went blind the only symptom was paid endpoints
// quietly failing closed. Report which backend is actually deciding right now.
function checkRateLimiter() {
	const base = { name: 'rate_limiter', label: 'Rate limiter (Upstash + Postgres fallback)' };
	try {
		const h = rateLimiterHealth();
		if (!h.configured) {
			if (h.durableFallback) {
				return { ...base, status: 'degraded', detail: 'no Redis; money/auth buckets counting in Postgres', backend: 'postgres', hint: 'Configure UPSTASH_REDIS_REST_URL/TOKEN for sliding-window precision.' };
			}
			// No backend at all. Outside production that is the ordinary dev posture
			// (the memory limiter, permissive by design). In production it means every
			// money bucket denies — a real outage.
			return h.enforcing
				? { ...base, status: 'down', detail: 'no Redis and no Postgres — money buckets fail closed', backend: 'none', hint: 'Set DATABASE_URL and/or UPSTASH_REDIS_REST_URL. Paid endpoints deny until then.' }
				: { ...base, status: 'ok', detail: 'in-memory (no Redis configured)', backend: 'memory' };
		}
		if (h.quotaExhausted) {
			return {
				...base,
				status: 'degraded',
				detail: `Upstash command allowance exhausted; ${h.durableFallback ? 'money/auth buckets counting in Postgres' : 'money buckets FAILING CLOSED'}`,
				backend: h.durableFallback ? 'postgres' : 'none',
				quotaExhausted: true,
				hint: 'Commands are rejected until the plan period rolls over. Raise the Upstash plan or cut command volume.',
			};
		}
		if (h.circuitOpen) {
			return {
				...base,
				status: 'degraded',
				detail: `redis circuit open, retries in ${Math.round(h.circuitReopensInMs / 1000)}s; ${h.durableFallback ? 'serving from Postgres' : 'money buckets failing closed'}`,
				backend: h.durableFallback ? 'postgres' : 'none',
				hint: 'Transient Redis fault. The breaker probes on an escalating backoff and closes on the first success.',
			};
		}
		return { ...base, status: 'ok', detail: 'upstash healthy', backend: 'upstash' };
	} catch (err) {
		return { ...base, status: 'unknown', detail: err?.message || 'unreadable' };
	}
}

function checkHelius() {
	const base = { name: 'helius', label: 'Helius RPC (balances)' };
	try {
		const h = heliusHealth();
		if (!h.configured) {
			return { ...base, status: 'ok', detail: 'public RPC (no Helius key)' };
		}
		if (h.degraded) {
			return {
				...base,
				status: 'degraded',
				detail: `quota cooldown ${Math.round(h.cooldownRemainingMs / 60_000)}min left; on public RPC (${h.quotaTripsSinceStart} trips since start)`,
				metrics: { quotaTripsSinceStart: h.quotaTripsSinceStart },
				hint: 'Helius plan quota exhausted — raise the plan/quota. Balances still serve from the public RPC.',
			};
		}
		return { ...base, status: 'ok', detail: 'premium RPC healthy', metrics: { quotaTripsSinceStart: h.quotaTripsSinceStart } };
	} catch (err) {
		return { ...base, status: 'unknown', detail: err?.message || 'unreadable' };
	}
}

// Every PAID Solana lane at once, not just Helius. On 2026-07-29 the Helius
// plan, QuickNode's daily cap and Alchemy's monthly cap were all exhausted
// simultaneously and nothing surfaced it: the only RPC sensor watched Helius
// through per-instance memory, so a fresh instance cheerfully reported "premium
// RPC healthy" while every premium lane was returning -32429 / -32003 / 429.
// Falling through to free public nodes keeps the platform up but throttled, and
// that is precisely the state an operator must be told about, because clearing
// it costs money and only the owner can spend it.
// Render a cooldown as a coarse "back in …". Whole hours past an hour, whole
// minutes below it: an exhausted quota recovers on a 6h window, and reporting it
// to the minute implies a precision the breaker does not have.
function backIn(ms) {
	if (ms >= 3_600_000) {
		// Round to whole minutes FIRST, then split. Splitting first and rounding the
		// remainder lets 59.7 minutes render as "5h60m", which is not a time.
		const totalMin = Math.round(ms / 60_000);
		const h = Math.floor(totalMin / 60);
		const m = totalMin % 60;
		return m ? `${h}h${m}m` : `${h}h`;
	}
	if (ms >= 60_000) return `${Math.round(ms / 60_000)}m`;
	return `${Math.max(1, Math.round(ms / 1000))}s`;
}

// A one-line census of what is parked and when it comes back, appended to the
// detail so it lands on /status and in healthz alike. Without it "1/3 paid lanes
// serving" reads as an unexplained outage during what is in fact a normal quota
// cooldown, and the next reader re-diagnoses "all lanes dead" from scratch. Cap
// the list so a wide chain cannot turn one status line into a paragraph.
const COOLING_LANES_SHOWN = 3;
function coolingCensus(lanes) {
	const cooling = lanes
		.filter((l) => l.cooling)
		.sort((a, b) => a.cooldownRemainingMs - b.cooldownRemainingMs);
	if (cooling.length === 0) return '';
	const shown = cooling
		.slice(0, COOLING_LANES_SHOWN)
		.map((l) => `${l.url.replace(/^https?:\/\//, '')} back in ${backIn(l.cooldownRemainingMs)}`);
	const rest = cooling.length - shown.length;
	return `; ${shown.join(', ')}${rest > 0 ? `, +${rest} more cooling` : ''}`;
}

function checkRpcLanes() {
	const base = { name: 'rpc_lanes', label: 'Solana RPC lanes' };
	try {
		const h = rpcLaneHealth();
		const metrics = {
			paidTotal: h.paidTotal,
			paidCooling: h.paidCooling,
			total: h.total,
			cooling: h.cooling,
		};
		// Per-lane state, so healthz answers "which lane, and when is it back?"
		// without anyone having to re-probe the providers by hand. Masked to
		// scheme+host by rpcLaneHealth, so no API key leaves the process.
		const lanes = h.lanes.map((l) => ({
			url: l.url,
			paid: l.paid,
			cooling: l.cooling,
			recoversAt: l.recoversAt,
			recoversIn: l.cooling ? backIn(l.cooldownRemainingMs) : null,
			blockedMethods: l.blockedMethods.map((b) => b.method),
		}));
		const census = coolingCensus(h.lanes);
		if (h.paidTotal === 0) {
			return {
				...base,
				status: 'ok',
				detail: `${h.total} keyless lanes (no paid RPC configured)${census}`,
				metrics,
				lanes,
			};
		}
		if (h.allPaidCooling) {
			return {
				...base,
				status: 'degraded',
				detail: `all ${h.paidTotal} paid lanes exhausted; serving from ${h.total - h.cooling} free lanes${census}`,
				metrics,
				lanes,
				hint: 'Every paid Solana RPC plan is over quota at once. Calls still succeed on free public nodes but are throttled, which shows up as intermittent 5xx and slow settles. Each lane above carries its own recovery time, a quota cooldown clears itself, so check those before assuming an outage. Owner action if they are not clearing: top up or upgrade the RPC plans.',
			};
		}
		return {
			...base,
			status: 'ok',
			detail: `${h.paidTotal - h.paidCooling}/${h.paidTotal} paid lanes serving${census}`,
			metrics,
			lanes,
		};
	} catch (err) {
		return { ...base, status: 'unknown', detail: err?.message || 'unreadable' };
	}
}

function checkRing() {
	const base = { name: 'x402_ring', label: 'x402 autonomous ring' };
	try {
		// An explicit operator pause is a chosen state, not a fault — report it as
		// `paused` so it's visible without dragging the platform to "degraded".
		// Two switches pause the loop: the long-standing X402_AUTONOMOUS_ENABLED=false
		// (api/cron/x402-autonomous-loop.js) and the dedicated X402_RING_PAUSED=true
		// tamper-quiet pause. Recognise either so the status word stays accurate
		// whichever an operator reaches for.
		if (process.env.X402_AUTONOMOUS_ENABLED === 'false' || process.env.X402_RING_PAUSED === 'true') {
			const via = process.env.X402_RING_PAUSED === 'true' ? 'X402_RING_PAUSED=true' : 'X402_AUTONOMOUS_ENABLED=false';
			return { ...base, status: 'paused', detail: `spend loop paused (${via})` };
		}
		const { ok, violations } = checkRingInvariants();
		if (ok) {
			return { ...base, status: 'ok', detail: 'armed; closed-loop guards satisfied' };
		}
		// Enabled but guards unsatisfied: the loop fails CLOSED (no spend) and this
		// is the half-armed config the log export surfaced. Degraded, not down —
		// nothing is broken, money simply isn't moving.
		return {
			...base,
			status: 'degraded',
			detail: `half-armed — guards unset: ${violations.map((v) => v.flag).join(', ')}`,
			hint: 'Set X402_AUTONOMOUS_ENABLED=false to pause cleanly, or finish the ring guard env to go live. See docs/ops/production-log-triage.md.',
		};
	} catch (err) {
		return { ...base, status: 'unknown', detail: err?.message || 'unreadable' };
	}
}

async function checkWorld() {
	const base = { name: 'world', label: 'world.three.ws (Hyperfy)' };
	try {
		const parked = await cacheGet(WORLD_HEALTH_CACHE_KEY);
		if (!parked || typeof parked !== 'object') {
			return { ...base, status: 'unknown', detail: 'no world-health report yet' };
		}
		const age = parked.checkedAt ? Date.now() - parked.checkedAt : Infinity;
		if (age > WORLD_STALE_MS) {
			return { ...base, status: 'unknown', detail: 'world-health report is stale' };
		}
		if (parked.protected === false) {
			return {
				...base,
				status: 'degraded',
				detail: 'UNPROTECTED — ADMIN_CODE not set; every visitor has build rights',
				hint: 'Set ADMIN_CODE on the world service and re-run deploy/world/apply-hardening.sh.',
			};
		}
		if (parked.status === 'degraded') {
			return { ...base, status: 'degraded', detail: (parked.problems || []).join('; ') || 'degraded' };
		}
		return { ...base, status: 'ok', detail: 'protected; assets present' };
	} catch (err) {
		return { ...base, status: 'unknown', detail: err?.message || 'unreadable' };
	}
}

/**
 * Classify the sniper worker's heartbeat row into a subsystem record. Pure —
 * exported for tests; checkSniper() feeds it the live bot_heartbeat row.
 * @param {{ mode?: string, last_beat_at?: string|Date, meta?: object }|null|undefined} beat
 * @param {number} [now]
 */
export function classifySniperBeat(beat, now = Date.now()) {
	const base = { name: 'sniper', label: 'Sniper worker (Cloud Run)' };
	if (!beat) {
		return { ...base, status: 'unknown', detail: 'no heartbeat reported yet' };
	}
	const lastBeatMs = beat.last_beat_at ? new Date(beat.last_beat_at).getTime() : 0;
	const ageMs = lastBeatMs ? now - lastBeatMs : Number.POSITIVE_INFINITY;
	const meta = beat.meta && typeof beat.meta === 'object' ? beat.meta : {};
	if (ageMs > SNIPER_DOWN_MS) {
		const ageNote = Number.isFinite(ageMs) ? `${Math.round(ageMs / 60_000)} min old` : 'never recorded';
		return {
			...base,
			status: 'down',
			detail: `heartbeat ${ageNote} (mode=${beat.mode || 'unknown'}) — worker dead or its DB writes are failing; oracle scoring and all sniping are stopped`,
			hint: 'Restart the Cloud Run service: npm run deploy:sniper from a gcloud-authed machine (project aerial-vehicle-466722-p5). See deploy/sniper/README.md.',
		};
	}
	if (ageMs > SNIPER_FRESH_MS) {
		return { ...base, status: 'degraded', detail: `heartbeat ${Math.round(ageMs / 1000)}s old — worker slow or mid-restart` };
	}
	// Money before mechanics. A worker whose wallets cannot pay for an entry is
	// not performing its function, however healthy its feed is. That combination
	// (fresh heartbeat, live feed, empty wallets) reported 'ok' here for ten days
	// while the fleet booked a thousand failed buys. Checked before the feed for
	// the same reason it outranks it in /api/sniper/status: it is the more
	// specific diagnosis and the one nothing else was watching.
	const solvency = meta.solvency && typeof meta.solvency === 'object' ? meta.solvency : null;
	if (solvency?.state === 'starved' || solvency?.state === 'degraded') {
		const fullyStarved = solvency.state === 'starved';
		return {
			...base,
			status: fullyStarved ? 'down' : 'degraded',
			detail: `worker alive but out of trading capital. ${describeSolvency(solvency)}`,
			hint: solvency.masterCanCover === false
				? 'The funding master cannot cover the refills: move SOL to it, then the auto-funder tops the agent wallets up within 5 minutes.'
				: 'The auto-funder should refill these wallets on its next 5-minute tick; if it does not, check SNIPER_AUTO_FUND caps and the master balance.',
		};
	}

	const watchdogMs = Number(meta.feedWatchdogMs) || 180_000;
	if (meta.feedConnected !== true || Number(meta.lastEventAgeMs) > watchdogMs) {
		return {
			...base,
			status: 'degraded',
			detail: 'worker alive but the PumpPortal feed is not live — no launches are being scored',
			hint: 'The worker self-reconnects; if this persists past an hour, check PumpPortal status and the worker logs.',
		};
	}
	return {
		...base,
		status: 'ok',
		detail: `live (mode=${beat.mode || 'unknown'}, ${meta.strategies ?? '?'} strategies armed)`,
	};
}

async function checkSniper() {
	const base = { name: 'sniper', label: 'Sniper worker (Cloud Run)' };
	try {
		const { sql } = await import('../db.js');
		const rows = /** @type {Array<{ mode?: string, last_beat_at?: string|Date, meta?: object }>} */ (
			await sql`
				SELECT mode, last_beat_at, meta FROM bot_heartbeat
				WHERE worker = 'agent-sniper'
				LIMIT 1
			`
		);
		return classifySniperBeat(rows[0]);
	} catch (err) {
		return { ...base, status: 'unknown', detail: err?.message || 'heartbeat unreadable' };
	}
}

/**
 * Classify the OKX chat bot's heartbeat row. Pure, exported for tests;
 * checkOkxChatBot() feeds it the live bot_heartbeat row.
 *
 * The bot self-diagnoses (it is the only thing that can run `onchainos wallet
 * status`), so this reads its reported verdict rather than re-deriving one. What
 * it adds is the freshness check: a bot that stops beating cannot report that it
 * is broken, and that silence is the failure mode with the worst blast radius.
 *
 * @param {{ mode?: string, last_beat_at?: string|Date, meta?: object }|null|undefined} beat
 * @param {number} [now]
 */
export function classifyOkxChatBotBeat(beat, now = Date.now()) {
	const base = { name: 'okx_chat_bot', label: 'OKX marketplace chat bot (agent #2632)' };
	if (!beat) {
		return { ...base, status: 'unknown', detail: 'no heartbeat reported yet' };
	}
	const lastBeatMs = beat.last_beat_at ? new Date(beat.last_beat_at).getTime() : 0;
	const ageMs = lastBeatMs ? now - lastBeatMs : Number.POSITIVE_INFINITY;
	const meta = beat.meta && typeof beat.meta === 'object' ? beat.meta : {};

	if (ageMs > OKX_BOT_DOWN_MS) {
		const ageNote = Number.isFinite(ageMs) ? `${Math.round(ageMs / 60_000)} min old` : 'never recorded';
		return {
			...base,
			status: 'down',
			detail: `heartbeat ${ageNote}, the chat-bot host is gone, so marketplace chat is not delivered at all`,
			hint: 'Redeploy the host: gcloud builds submit --config workers/okx-chat-bot/cloudbuild.yaml . (see workers/okx-chat-bot/README.md). For a local stopgap, npm run okx:bot.',
		};
	}
	if (ageMs > OKX_BOT_FRESH_MS) {
		return { ...base, status: 'degraded', detail: `heartbeat ${Math.round(ageMs / 1000)}s old, host slow or mid-restart` };
	}

	const reported = typeof meta.health === 'string' ? meta.health : 'unknown';
	const host = typeof meta.host === 'string' && meta.host ? meta.host : null;
	if (reported === 'ok') {
		const online = `online (${meta.activeClients ?? '?'} XMTP client(s), provider=${beat.mode || meta.provider || 'unknown'}${host ? `, host=${host}` : ''})`;
		// A host that beats but cannot survive on its own is a stopgap, not the
		// fix. Reporting it green is how "the bot is up" and "the bot is up until
		// this workspace sleeps" became the same sentence.
		if (meta.hostDurable === false) {
			return {
				...base,
				status: 'degraded',
				detail: `${online}; that host is a stopgap and dies with its workspace, so chat delivery is not durable yet`,
				hint: 'Deploy the always-on host: gcloud builds submit --config workers/okx-chat-bot/cloudbuild.yaml . (see workers/okx-chat-bot/README.md).',
			};
		}
		return { ...base, status: 'ok', detail: online };
	}
	if (reported === 'unknown') {
		return { ...base, status: 'unknown', detail: String(meta.detail || 'bot could not determine its own state') };
	}
	return {
		...base,
		status: reported === 'down' ? 'down' : 'degraded',
		detail: String(meta.detail || `bot reports ${reported}`),
		hint: meta.needsHumanLogin
			? 'The OKX wallet session expired and only a human can renew it (email OTP as claude@three.ws). The live login URL and the exact three commands are on the host: curl -s $OKX_BOT_URL/readyz | jq .remedy'
			: meta.reason === 'ai_provider_unauthorized'
				? 'The AI credential is configured but the provider refuses it (an expired key, or an account that cannot bill). Chat still arrives and no reply is ever authored. The three ways out are on the host: curl -s $OKX_BOT_URL/readyz | jq .remedy'
				: 'Read the host logs: gcloud logging read \'resource.labels.service_name="okx-chat-bot"\' --freshness=1h --project aerial-vehicle-466722-p5.',
	};
}

async function checkOkxChatBot() {
	const base = { name: 'okx_chat_bot', label: 'OKX marketplace chat bot (agent #2632)' };
	try {
		const { sql } = await import('../db.js');
		const rows = /** @type {Array<{ mode?: string, last_beat_at?: string|Date, meta?: object }>} */ (
			await sql`
				SELECT mode, last_beat_at, meta FROM bot_heartbeat
				WHERE worker = 'okx-chat-bot'
				LIMIT 1
			`
		);
		return classifyOkxChatBotBeat(rows[0]);
	} catch (err) {
		return { ...base, status: 'unknown', detail: err?.message || 'heartbeat unreadable' };
	}
}

function checkX402Config() {
	const base = { name: 'x402_config', label: 'x402 payment config' };
	try {
		const hasSolanaPayTo = !!process.env.X402_PAY_TO_SOLANA || !!process.env.X402_PAY_TO;
		const hasSolanaFeePayer = !!process.env.X402_FEE_PAYER_SOLANA;
		if (hasSolanaPayTo && !hasSolanaFeePayer) {
			return {
				...base,
				status: 'degraded',
				detail: 'X402_PAY_TO_SOLANA set without X402_FEE_PAYER_SOLANA — Solana accepts are dropped',
				hint: 'Set X402_FEE_PAYER_SOLANA or Solana-only paid endpoints (dance-tip, club-cover) fail closed.',
			};
		}
		const configured = !!process.env.X402_PAY_TO_BASE || (hasSolanaPayTo && hasSolanaFeePayer);
		if (!configured) {
			return { ...base, status: 'unknown', detail: 'no pay-to addresses configured' };
		}
		return { ...base, status: 'ok', detail: 'pay-to + fee payer configured' };
	} catch (err) {
		return { ...base, status: 'unknown', detail: err?.message || 'unreadable' };
	}
}

/**
 * Gather every subsystem's health and roll it into one verdict.
 * @param {{ probeDb?: boolean }} [opts] set probeDb:false to skip the live DB
 *   ping (e.g. a caller that already knows the DB is out and wants a fast read).
 * @returns {Promise<{ status: 'ok'|'degraded'|'down', checkedAt: number,
 *   counts: Record<string, number>, degraded: string[], subsystems: Array<object> }>}
 */
export async function gatherSubsystemHealth({ probeDb = true } = {}) {
	const checks = [
		probeDb ? checkDatabase() : Promise.resolve({ name: 'database', label: 'Database (Neon)', status: 'unknown', detail: 'ping skipped' }),
		Promise.resolve(checkCache()),
		Promise.resolve(checkRateLimiter()),
		Promise.resolve(checkHelius()),
		// Whole paid RPC tier, not just Helius (see checkRpcLanes).
		Promise.resolve(checkRpcLanes()),
		Promise.resolve(checkRing()),
		// Settle SUCCESS RATE, not just "armed" — reads x402_autonomous_log. Needs
		// the DB, so it shares the probeDb gate; skipped-DB callers get `unknown`.
		probeDb ? gatherX402SettleHealth() : Promise.resolve({ name: 'x402_settle', label: 'x402 settlement success', status: 'unknown', detail: 'settle read skipped' }),
		// Object storage credentials. Not DB-gated: it is a signed one-key list
		// against the bucket. A rejected credential takes down 3D generation AND
		// every avatar/thumbnail/GLB read at once, and on 2026-09-07 it did so with
		// no health signature at all, because the forge sensor below can only see
		// generations that got far enough to write a row.
		gatherObjectStorageHealth(),
		// Generation SUCCESS RATE, not just lane liveness — reads forge_creations.
		// DB-gated like the settle sensor; skipped-DB callers get `unknown`.
		probeDb ? gatherForgeHealth() : Promise.resolve({ name: 'forge_generation', label: 'Forge 3D generation', status: 'unknown', detail: 'forge read skipped' }),
		// Agent index freshness. A dead crawl cron has NO reachability signature:
		// every surface still answers 200 while the directory quietly stops
		// learning about the chains. Reads cursor tables only, so it shares the
		// probeDb gate with the other DB-backed sensors.
		probeDb ? gatherIndexLagHealth() : Promise.resolve({ name: 'agent_index', label: 'Agent index freshness', status: 'unknown', detail: 'index read skipped' }),
		// Home Assistant bridge. Every rate it reports is computed ACROSS tenants,
		// because one person's house being offline is a UI state for that person
		// and never an outage: see api/_lib/ops/home-health.js. DB-gated like the
		// other rate sensors.
		probeDb ? gatherHomeHealth() : Promise.resolve({ name: 'home', label: 'Home Assistant bridge', status: 'unknown', detail: 'home read skipped' }),
		checkWorld(),
		Promise.resolve(checkX402Config()),
		probeDb ? checkSniper() : Promise.resolve({ name: 'sniper', label: 'Sniper worker (Cloud Run)', status: 'unknown', detail: 'probe skipped' }),
		// The marketplace chat bot goes offline SILENTLY (expired wallet session =
		// no XMTP delivery), and until it was hosted it had no health surface at
		// all: the listing was flagged offline by OKX before anyone here noticed.
		probeDb ? checkOkxChatBot() : Promise.resolve({ name: 'okx_chat_bot', label: 'OKX marketplace chat bot (agent #2632)', status: 'unknown', detail: 'probe skipped' }),
	];
	const subsystems = await Promise.all(checks);

	const counts = subsystems.reduce((acc, s) => {
		acc[s.status] = (acc[s.status] || 0) + 1;
		return acc;
	}, /** @type {Record<string, number>} */ ({}));

	const status = worstOf(subsystems.map((s) => s.status));
	const degraded = subsystems.filter((s) => UNHEALTHY.includes(s.status)).map((s) => s.name);

	return { status, checkedAt: Date.now(), counts, degraded, subsystems };
}
