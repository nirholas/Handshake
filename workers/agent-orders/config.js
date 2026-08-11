// agent-orders — environment + runtime configuration. Validated once at boot so
// a misconfigured worker fails loudly instead of trading with half a config.

import { databaseConfigured } from '../../api/_lib/env.js';

function req(name) {
	const v = process.env[name];
	if (!v || !String(v).trim()) throw new Error(`[agent-orders] missing required env var: ${name}`);
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

export function loadConfig() {
	requireDatabase('agent-orders');
	req('JWT_SECRET');

	const network = (process.env.ORDERS_NETWORK || 'mainnet').trim();
	if (network !== 'mainnet' && network !== 'devnet') {
		throw new Error(`[agent-orders] ORDERS_NETWORK must be mainnet|devnet, got "${network}"`);
	}
	const mode = (process.env.ORDERS_MODE || 'simulate').trim();
	if (mode !== 'live' && mode !== 'simulate') {
		throw new Error(`[agent-orders] ORDERS_MODE must be live|simulate, got "${mode}"`);
	}
	// A live worker on a public RPC will rate-limit under re-quote load — refuse to
	// start live without a real endpoint rather than silently dropping fills.
	if (mode === 'live' && !process.env.SOLANA_RPC_URL && !process.env.HELIUS_API_KEY) {
		throw new Error('[agent-orders] live mode requires SOLANA_RPC_URL or HELIUS_API_KEY');
	}
	// Custodial agent keys are encrypted at rest under WALLET_ENCRYPTION_KEY
	// (api/_lib/agent-wallet.js). Without it the decrypt silently falls back to
	// JWT_SECRET, so every live fill dies at key recovery with a NON-terminal
	// error and the order retries forever. Fail at boot instead. Simulate mode
	// never touches the key (it stops before signing), so it does not need this.
	if (mode === 'live') req('WALLET_ENCRYPTION_KEY');

	return {
		network,
		mode,
		// Emergency stop — halt all fires while leaving orders intact (cancel still works via the API).
		globalKill: bool('ORDERS_GLOBAL_KILL', false),
		// Evaluation cadence.
		pollMs: Math.max(3_000, num('ORDERS_POLL_MS', 10_000)),
		// Agents evaluated in parallel per sweep (each agent's orders run serially).
		concurrency: Math.max(1, Math.min(16, num('ORDERS_CONCURRENCY', 4))),
		// A 'firing' claim older than this is considered crash-orphaned and recovered.
		staleFiringMs: Math.max(60_000, num('ORDERS_STALE_FIRING_MS', 180_000)),
		// Liveness heartbeat into bot_heartbeat (shared ops visibility). 0 disables.
		heartbeatMs: Math.max(0, num('ORDERS_HEARTBEAT_MS', 30_000)),
	};
}
