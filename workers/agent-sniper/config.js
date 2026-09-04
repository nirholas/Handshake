// agent-sniper — environment + runtime configuration.
//
// Reads and validates the process environment once at boot. Throws on missing
// REQUIRED vars so a misconfigured worker fails loudly instead of trading with
// half a config. Optional vars get sane, conservative defaults.

import { databaseConfigured } from '../../api/_lib/env.js';

function req(name) {
	const v = process.env[name];
	if (!v || !String(v).trim()) {
		throw new Error(`[agent-sniper] missing required env var: ${name}`);
	}
	return v;
}
// The Postgres connection string may arrive under DATABASE_URL or any standard
// Vercel-Postgres/Neon alias; db.js resolves the live connection from that set,
// so assert configuration the same way rather than hard-requiring the bare name.
function requireDatabase(scope) {
	if (!databaseConfigured()) {
		throw new Error(`[${scope}] missing required env var: DATABASE_URL (or a POSTGRES_URL/NEON_DATABASE_URL alias)`);
	}
}

function num(name, def) {
	const raw = process.env[name];
	if (raw == null || raw === '') return def;
	const n = Number(raw);
	return Number.isFinite(n) ? n : def;
}

function bool(name, def = false) {
	const raw = process.env[name];
	if (raw == null || raw === '') return def;
	return /^(1|true|yes|on)$/i.test(String(raw).trim());
}

// Parse a comma/space/newline-separated allowlist of agent UUIDs. Returns a
// de-duped array, or null when unset/empty (null = "all agents", the default).
// Exported for unit testing — the scoping fix that keeps a worker from acting on
// every armed strategy in the shared DB depends on this being exact.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function parseAgentIds(raw) {
	if (raw == null || String(raw).trim() === '') return null;
	const ids = String(raw)
		.split(/[\s,]+/)
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean)
		.filter((s) => UUID_RE.test(s));
	if (!ids.length) return null;
	return [...new Set(ids)];
}

// Resolve the RPC endpoint the worker's read paths (e.g. the Mayhem curve read)
// should use. Prefer an explicit URL, then a Helius key, else empty (callers
// fall back to a public mainnet endpoint).
function resolveRpcUrl() {
	if (process.env.SOLANA_RPC_URL) return process.env.SOLANA_RPC_URL.trim();
	if (process.env.HELIUS_API_KEY) return `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY.trim()}`;
	return '';
}

export function loadConfig() {
	// DATABASE_URL + JWT_SECRET are consumed transitively by db.js / agent-wallet.js.
	// We assert them here so the failure points at config, not a cryptic decrypt
	// error three layers deep on the first trade.
	requireDatabase('agent-sniper');
	req('JWT_SECRET');

	const network = (process.env.SNIPER_NETWORK || 'mainnet').trim();
	if (network !== 'mainnet' && network !== 'devnet') {
		throw new Error(`[agent-sniper] SNIPER_NETWORK must be mainnet|devnet, got "${network}"`);
	}

	const mode = (process.env.SNIPER_MODE || 'simulate').trim();
	if (mode !== 'live' && mode !== 'simulate') {
		throw new Error(`[agent-sniper] SNIPER_MODE must be live|simulate, got "${mode}"`);
	}

	// Live trading on a public RPC will 429 under the new-mint firehose. Refuse to
	// start live without a real endpoint rather than silently dropping trades.
	if (mode === 'live' && !process.env.SOLANA_RPC_URL && !process.env.HELIUS_API_KEY) {
		throw new Error(
			'[agent-sniper] live mode requires SOLANA_RPC_URL or HELIUS_API_KEY (public RPC will rate-limit)',
		);
	}

	return {
		network,
		mode,
		// Resolved RPC endpoint, shared by the worker's read paths (Mayhem curve read).
		rpcUrl: resolveRpcUrl(),
		// ── agent scoping ────────────────────────────────────────────────────────
		// Optional allowlist of agent UUIDs. When set, the worker acts ONLY on these
		// agents' strategies — the rest of the shared DB's armed strategies are
		// ignored. Unset (null) = every enabled strategy for the network, the legacy
		// behaviour. Set this to run a bounded experiment/fleet against the prod DB
		// without entangling it with every other armed agent.
		agentIds: parseAgentIds(process.env.SNIPER_AGENT_IDS),
		// ── Mayhem exclusion (owner rule) ────────────────────────────────────────
		// NEVER buy pump.fun "Mayhem"-mode tokens — only regular launches. Reads the
		// bonding curve's isMayhemMode once per mint (cached). On by default; set
		// SNIPER_MAYHEM_FILTER=0 to disable. FAIL CLOSED by default: when the curve
		// can't be read we skip the buy, because we can't confirm it isn't Mayhem —
		// and the owner rule is NEVER buy Mayhem, not "buy when unsure". A fresh
		// mint's curve exists at creation, so an unreadable read is an RPC hiccup, not
		// a missing account; the right response is to pass on that coin, not buy blind.
		// Set SNIPER_MAYHEM_STRICT=0 to restore allow-on-unknown (raw speed).
		mayhemFilter: bool('SNIPER_MAYHEM_FILTER', true),
		mayhemStrict: bool('SNIPER_MAYHEM_STRICT', true),
		// Global emergency stop — set SNIPER_GLOBAL_KILL=1 to halt all new buys
		// while still letting the position loop manage/exit open positions.
		globalKill: bool('SNIPER_GLOBAL_KILL', false),
		// ── adversarial Risk Officer ─────────────────────────────────────────────
		// Fleet-wide DEFAULT enforcement level for the independent pre-trade review
		// (workers/agent-sniper/risk-officer.js); a strategy's own
		// `risk_officer_level` column overrides it. 'shadow' (the default) records
		// the veto it would have cast and changes nothing; 'enforce' lets a veto
		// abort the buy and a smaller suggested size shrink it; 'off' skips it.
		// Deliberately NOT 'enforce' out of the box: enforcement changes what the
		// live fleet buys with real SOL, so arming it is an owner decision made
		// against the evidence in sniper_risk_reviews.
		riskOfficer: (process.env.SNIPER_RISK_OFFICER || 'shadow').trim().toLowerCase(),
		// Position re-quote / exit-evaluation cadence.
		pollMs: Math.max(1_000, num('SNIPER_POLL_MS', 5_000)),
		// Liquidity-decay exit: an underwater position whose quoted value has not
		// moved AT ALL for this long (no one is trading the coin) exits early with
		// reason 'liquidity_decay' instead of squatting on a concurrency slot until
		// the 30-minute timeout. 0 disables. Default 5 minutes: on a minutes-old
		// pump.fun launch, five minutes of literally zero trades is a dead market.
		liquidityDecayS: Math.max(0, num('SNIPER_LIQUIDITY_DECAY_S', 300)),
		// How often the strategy cache is refreshed from the DB.
		strategyRefreshMs: Math.max(5_000, num('SNIPER_STRATEGY_REFRESH_MS', 15_000)),
		// Platform-wide buy throttle — a backstop independent of per-agent caps.
		maxGlobalBuysPerMin: Math.max(0, num('SNIPER_MAX_GLOBAL_BUYS_PER_MIN', 10)),
		// Watchdog: if the feed delivers nothing for this long, re-subscribe.
		feedWatchdogMs: Math.max(30_000, num('SNIPER_FEED_WATCHDOG_MS', 180_000)),
		// Confirmation timeout for a broadcast trade.
		confirmTimeoutMs: Math.max(15_000, num('SNIPER_CONFIRM_TIMEOUT_MS', 60_000)),
		// Owner directive: the fleet is a learning experiment, not a profit desk — a
		// wallet too poor for its strategy's configured per_trade_lamports should
		// shrink the trade to whatever it actually has left rather than sit idle.
		// This is the floor below that shrink: once even a dust-sized buy wouldn't
		// clear it, THEN skip with insufficient_sol. Default 0.00001 SOL.
		minTradeLamports: BigInt(Math.max(1, Math.round(num('SNIPER_MIN_TRADE_LAMPORTS', 10_000)))),
		// ── liveness + alerting ──────────────────────────────────────────────────
		// How often the worker upserts its bot_heartbeat row. /api/sniper/status
		// (and /status) read this to answer "is the sniper alive?" without SSH.
		heartbeatMs: Math.max(10_000, num('SNIPER_HEARTBEAT_MS', 30_000)),
		// Executor/RPC errors within this sliding window that trip an ops alert.
		errorAlertThreshold: Math.max(1, num('SNIPER_ERROR_ALERT_THRESHOLD', 5)),
		errorAlertWindowMs: Math.max(60_000, num('SNIPER_ERROR_ALERT_WINDOW_MS', 600_000)),
		// Announce boot/shutdown to the ops channel (a deploy that never comes back
		// up is otherwise silent). Disable in noisy dev with SNIPER_ANNOUNCE=0.
		announceLifecycle: bool('SNIPER_ANNOUNCE', true),
		// ── first-claim trigger ─────────────────────────────────────────────────
		// How often to poll the on-chain fee-claim stream for first-ever claims.
		claimPollMs: Math.max(10_000, num('SNIPER_CLAIM_POLL_MS', 30_000)),
		// Window scanned each poll — must comfortably exceed the poll interval so a
		// claim can't slip between scans.
		claimLookbackSeconds: Math.max(60, num('SNIPER_CLAIM_LOOKBACK_S', 600)),
		// Default freshness gate: ignore a first claim older than this when first
		// observed (a per-strategy first_claim_max_age_seconds overrides it). Keeps
		// a worker restart / backfill from sniping a stale claim.
		claimMaxAgeSeconds: Math.max(30, num('SNIPER_CLAIM_MAX_AGE_S', 300)),
		// ── coin intelligence engine ────────────────────────────────────────────
		// Observe every new coin's first seconds of trading, classify it, persist
		// signals, and drive intel_confirmed strategies. On by default — it's the
		// platform's eyes. Set SNIPER_INTEL=0 to disable (e.g. a trade-only worker).
		intel: bool('SNIPER_INTEL', true),
		// Observation window per coin before signals are finalized (ms).
		intelWindowMs: Math.max(15_000, num('SNIPER_INTEL_WINDOW_MS', 90_000)),
		// Max coins observed simultaneously — a backstop on memory + WS subs.
		intelMaxConcurrent: Math.max(50, num('SNIPER_INTEL_MAX_CONCURRENT', 400)),
		// Refine classification with the LLM (free-first). Off by default: the
		// deterministic heuristic is instant and free; LLM adds ~1 call per coin.
		intelLlm: bool('SNIPER_INTEL_LLM', false),
		// ── pre-launch creator-wallet radar (task 04) ───────────────────────────
		// Watch proven creator + smart-money wallets on-chain and detect launch
		// precursors (funding a fresh deploy wallet / a pump create) at block-0 to
		// pre-arm a snipe on signal rather than luck. On by default — it's the
		// platform's earliest edge. SNIPER_RADAR=0 disables it (degrades to the
		// normal feed-based snipe, reported honestly as paused).
		radar: bool('SNIPER_RADAR', true),
		// How often each watched wallet's recent signatures are polled.
		radarPollMs: Math.max(5_000, num('SNIPER_RADAR_POLL_MS', 15_000)),
		// Watched wallets scanned per tick (bounds RPC pressure; the set is covered
		// round-robin across ticks).
		radarWalletsPerTick: Math.max(5, num('SNIPER_RADAR_WALLETS_PER_TICK', 60)),
		// How often the watchlist is auto-recurated from the graph.
		radarWatchlistRefreshMs: Math.max(60_000, num('SNIPER_RADAR_WATCHLIST_REFRESH_MS', 300_000)),
		// Creator pedigree floor for auto-inclusion (graduated coins).
		radarMinCreatorGraduated: Math.max(1, num('SNIPER_RADAR_MIN_GRADUATED', 2)),
		// Reputation floor for smart-money auto-inclusion (0..100).
		radarSmartMoneyMinScore: Math.max(0, Math.min(100, num('SNIPER_RADAR_SM_MIN_SCORE', 70))),
		// Hard cap on the monitored set (stale low-signal wallets are evicted).
		radarMaxWatch: Math.max(20, num('SNIPER_RADAR_MAX_WATCH', 500)),
		// Default freshness gate for a precursor before it can pre-arm (ms). A
		// per-strategy radar_max_age_ms overrides it.
		radarMaxAgeMs: Math.max(10_000, num('SNIPER_RADAR_MAX_AGE_MS', 120_000)),
		// A SOL outflow at least this large to a fresh wallet counts as deploy
		// funding (rent + first buy). Below it is ignored as noise.
		radarMinFundingLamports: Math.max(0, num('SNIPER_RADAR_MIN_FUNDING_LAMPORTS', 30_000_000)),
		// How long a freshly-funded wallet stays under correlation watch for its
		// create instruction before it's dropped (ms).
		radarDeployWatchTtlMs: Math.max(30_000, num('SNIPER_RADAR_DEPLOY_WATCH_TTL_MS', 180_000)),
		// ── autonomous coin launcher ────────────────────────────────────────────
		// Runs a periodic check for enabled launcher configs and fires launches.
		// On by default when AGENT_JWT is set; disable with SNIPER_LAUNCHER=0.
		launcher: bool('SNIPER_LAUNCHER', !!process.env.AGENT_JWT),
		// How often to check for due launcher configs (ms).
		launcherPollMs: Math.max(30_000, num('SNIPER_LAUNCHER_POLL_MS', 60_000)),
		// ── sentiment-flip exit ─────────────────────────────────────────────────
		// Let the per-coin x402 sentiment the worker already pays for drive a sell:
		// cut an underwater position early when its signal flips confidently bearish,
		// ahead of the hard stop-loss. Off by default — existing strategies keep their
		// exact stop/trailing/TP behaviour until an operator opts in.
		exitOnBearish: bool('SNIPER_EXIT_ON_BEARISH', false),
		// Minimum sentiment confidence (0..1) before a bearish flip can exit.
		exitBearishMinConfidence: Math.max(0, Math.min(1, num('SNIPER_EXIT_BEARISH_MIN_CONFIDENCE', 0.7))),
		// ── buy-side auto-funding ───────────────────────────────────────────────
		// Keeps each armed agent's own wallet topped up from the launcher master so
		// a hot sniper never silently runs dry and starts failing every buy. On by
		// default; disable with SNIPER_AUTO_FUND=0. Per-transfer / daily caps and
		// the floor/target are read in auto-funder.js (SNIPER_AUTO_FUND_*).
		autoFund: bool('SNIPER_AUTO_FUND', true),
		// ── creator auto-claim ──────────────────────────────────────────────────
		// Polls claimable creator fees on agent-launched coins and auto-claims them.
		// On by default when AGENT_JWT is set; disable with SNIPER_AUTO_CLAIM=0.
		autoClaim: bool('SNIPER_AUTO_CLAIM', !!process.env.AGENT_JWT),
		// How often to poll claimable fees (ms). Default 5 minutes.
		autoClaimPollMs: Math.max(60_000, num('SNIPER_AUTO_CLAIM_POLL_MS', 300_000)),
		// ── market maker ───────────────────────────────────────────────────────
		// Runs range-based market making on configured coins via Jito execution.
		// On by default; disable with SNIPER_MARKET_MAKER=0.
		marketMaker: bool('SNIPER_MARKET_MAKER', true),
		// Default rebalance interval when no per-config override (ms).
		marketMakerIntervalMs: Math.max(5_000, num('SNIPER_MM_INTERVAL_MS', 10_000)),
	};
}
