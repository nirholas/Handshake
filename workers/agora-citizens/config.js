// agora-citizens — environment + runtime configuration for the life engine.
// Validated once at boot so a misconfigured worker fails loudly instead of
// running half a config. Long-lived process (NOT a Vercel cron): it registers a
// fleet of devnet AgenC agents, then runs each citizen's daily loop on its own
// jittered cadence, projecting every on-chain action into agora_citizens /
// agora_activity and the live feed.
//
//   AGORA_DRY_RUN=1   — plan only: read the board, decide, but never sign a tx
//                       or write the DB. Inspect the loop safely.
//   AGORA_ONCE=1      — run a single tick per citizen, then exit (CI / manual).
//   AGORA_MAX_CITIZENS=N — cap the fleet (faucet-friendly local runs).
//
// Guardrails: devnet rewards are native SOL (synthetic plumbing — never another
// real token). $THREE is the only coin Agora promotes; on mainnet the reward
// label is '$THREE'. See docs/agora.md and CLAUDE.md.

import { resolveDatabaseUrl } from '../../api/_lib/env.js';

function req(name) {
	const v = process.env[name];
	if (!v || !String(v).trim()) throw new Error(`[agora-citizens] missing required env var: ${name}`);
	return String(v).trim();
}
function opt(name, def = undefined) {
	const v = process.env[name];
	return v == null || v === '' ? def : String(v).trim();
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

export function loadConfig() {
	const dryRun = bool('AGORA_DRY_RUN', false);

	// DATABASE_URL is the projection sink. A dry run reads the board + plans but
	// never writes, so it can run without a DB — handy for inspecting the loop
	// with zero side effects. Resolve from DATABASE_URL or any standard
	// Vercel-Postgres/Neon alias (POSTGRES_URL, NEON_DATABASE_URL, …) so the worker
	// connects wherever the integration injected the string — matching db.js.
	const databaseUrl = resolveDatabaseUrl() || '';
	if (!dryRun && !databaseUrl) {
		throw new Error('[agora-citizens] missing required env var: DATABASE_URL (or a POSTGRES_URL/NEON_DATABASE_URL alias)');
	}

	const cluster = (opt('AGORA_CLUSTER', 'devnet')).toLowerCase();
	if (cluster !== 'devnet' && cluster !== 'mainnet') {
		throw new Error(`[agora-citizens] AGORA_CLUSTER must be devnet|mainnet, got "${cluster}"`);
	}
	// Mainnet is escrowed in $THREE and is out of scope for the devnet life
	// engine — refuse to run live there so a stray env can't move real value.
	if (cluster === 'mainnet' && !dryRun) {
		throw new Error('[agora-citizens] mainnet life-engine is out of scope for this worker (devnet only). Set AGORA_CLUSTER=devnet.');
	}

	const rpcUrl = opt('AGENC_DEVNET_RPC_URL') || opt('SOLANA_RPC_URL_DEVNET') || opt('AGENC_RPC_URL') || undefined;

	return {
		cluster,
		rpcUrl,
		dryRun,
		// Single tick per citizen then exit — for CI smoke tests and manual runs.
		once: bool('AGORA_ONCE', false),
		// World-seed mode: project real rigged agents into the Commons as citizens
		// (real avatar, canonical AgenC id derived offline, profession from real
		// signals) WITHOUT any on-chain registration, then exit. No SOL needed — the
		// world fills instantly; the funded life-engine registers + works them later.
		seedOnly: bool('AGORA_SEED_ONLY', false),
		// How many rigged agents to project in a world-seed pass. The DB holds all of
		// them; the 3D renderer shows a bounded, nearest subset.
		seedLimit: Math.max(1, Math.min(2000, num('AGORA_SEED_LIMIT', 120))),
		// Before a world-seed, clear the previous UNREGISTERED world-seed citizens so
		// the population refreshes cleanly (never touches on-chain-registered citizens
		// or humans). Default on — a seed pass is the authoritative pending population.
		seedReset: bool('AGORA_SEED_RESET', true),
		databaseUrl,

		// Fleet size cap. The roster supplies the candidate citizens (seeded from
		// real platform agents where possible); this bounds how many we actually
		// run so a local devnet run respects faucet limits.
		maxCitizens: Math.max(1, Math.min(50, num('AGORA_MAX_CITIZENS', 4))),
		// Floor on the fleet when seeding can't find enough real agents — fill with
		// standalone roster citizens so the world is never empty.
		minCitizens: Math.max(1, num('AGORA_MIN_CITIZENS', 3)),
		// Run the standalone founding workforce ONLY, never the platform-agent seed.
		// Two engines against one DB otherwise pick the same first-N platform agents
		// and drive one set of keypairs concurrently. Use for an isolated devnet
		// fleet, a local run, or a CI smoke that must not touch real agent identities.
		standaloneOnly: bool('AGORA_STANDALONE_ONLY', false),

		// Per-citizen loop cadence. Each citizen ticks every base ± jitter so the
		// fleet doesn't stampede the RPC / faucet in lockstep.
		tickBaseMs: Math.max(5_000, num('AGORA_TICK_MS', 45_000)),
		tickJitterMs: Math.max(0, num('AGORA_TICK_JITTER_MS', 20_000)),

		// Devnet work supply. With no human/agent bounties yet (Task 03), an
		// internal dispatcher keeps a small pool of real on-chain Fetcher tasks
		// open so citizens have genuine work to claim → do → prove → earn. This is
		// devnet plumbing (native SOL rewards), not the Task-03 bounty product; it
		// posts no agora `posted_task` projection and escrows no $THREE. Disable to
		// run citizens against externally-supplied tasks only.
		dispatchTasks: bool('AGORA_DISPATCH_TASKS', cluster === 'devnet'),
		minOpenTasks: Math.max(0, num('AGORA_MIN_OPEN_TASKS', 3)),
		maxOpenTasks: Math.max(1, num('AGORA_MAX_OPEN_TASKS', 8)),
		taskRewardLamports: Math.max(1, num('AGORA_TASK_REWARD_LAMPORTS', 1_000_000)), // 0.001 SOL devnet
		taskDeadlineSecs: Math.max(300, num('AGORA_TASK_DEADLINE_SECS', 3_600)),

		// Arena (Competitive) + Guild (Collaborative) demand (Task 09). A patron
		// occasionally posts a multi-worker task so several citizens race (Arena —
		// first valid proof wins the whole escrow) or collaborate (Guild — the
		// reward splits across contributors). Both are real on-chain multi-worker
		// tasks; disable either to keep the board single-worker.
		enableArena: bool('AGORA_ENABLE_ARENA', cluster === 'devnet'),
		enableGuild: bool('AGORA_ENABLE_GUILD', cluster === 'devnet'),
		// Slots per multi-worker task. Clamped to the AgenC u8 range with a sane
		// upper bound so one task can't invite the whole fleet.
		arenaMaxWorkers: Math.max(2, Math.min(8, num('AGORA_ARENA_MAX_WORKERS', 3))),
		guildMaxWorkers: Math.max(2, Math.min(8, num('AGORA_GUILD_MAX_WORKERS', 3))),
		// The prize pool scales up from the base reward — a juicy Arena purse and a
		// Guild pool worth splitting. The patron locks the whole pool once (escrow);
		// Arena pays the winner all of it, Guild splits it across contributors.
		arenaRewardMultiplier: Math.max(1, num('AGORA_ARENA_REWARD_MULT', 6)),
		guildRewardMultiplier: Math.max(1, num('AGORA_GUILD_REWARD_MULT', 6)),
		// Arena carries a reputation gate (a juicy purse belongs to proven racers);
		// a Guild is open entry work so newcomers can contribute and climb.
		arenaMinReputation: Math.max(0, num('AGORA_ARENA_MIN_REP', 3)),

		// Minimum on-chain stake per agent (AgenC protocol minAgentStake on devnet).
		stakeLamports: Math.max(1_000_000, num('AGORA_STAKE_LAMPORTS', 1_000_000)),

		// Faucet top-up: keep each signer above the threshold so a claim/complete
		// (which pays fees + locks reward) never fails for lack of SOL.
		topupThresholdLamports: Math.max(0, num('AGORA_TOPUP_THRESHOLD_LAMPORTS', 200_000_000)), // 0.2 SOL
		airdropLamports: Math.max(0, num('AGORA_AIRDROP_LAMPORTS', 1_000_000_000)), // 1 SOL

		// Where the citizen reads the world from. The board endpoint surfaces the
		// x402 bazaar (real Fetcher work) and any open AgenC tasks. The bridge is
		// the live work target the Fetcher fingerprints for its proof.
		apiBase: (opt('AGORA_API_BASE', 'https://three.ws')).replace(/\/+$/, ''),

		// Retry/backoff for every on-chain call. A single citizen's failure must
		// never halt the fleet.
		maxRetries: Math.max(0, num('AGORA_MAX_RETRIES', 4)),
		retryBaseMs: Math.max(200, num('AGORA_RETRY_BASE_MS', 1_500)),

		// Liveness heartbeat into bot_heartbeat (shared ops visibility). 0 disables.
		heartbeatMs: Math.max(0, num('AGORA_HEARTBEAT_MS', 30_000)),
	};
}
