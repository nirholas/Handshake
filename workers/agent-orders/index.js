// agent-orders — programmable order execution worker (entrypoint).
//
// Long-lived process (NOT a Vercel cron). Every cfg.pollMs it sweeps all active
// orders, re-quotes each mint off live on-chain state, evaluates the
// trigger/schedule, and fires matched orders through executeAgentTrade — the
// same firewall + spend-guard + custody-audited path every agent trade uses.
//
//   ORDERS_MODE=simulate  — real quotes, no broadcast (default, safe)
//   ORDERS_MODE=live      — real fills from agent wallets
//   ORDERS_GLOBAL_KILL=1  — halt all fires (orders untouched; cancel still works)
//
// Run: node workers/agent-orders  (npm run worker:orders / worker:orders:live)

import http from 'node:http';
import { sql } from '../../api/_lib/db.js';
import { loadConfig } from './config.js';
import { runOrderSweep } from './sweep.js';
import { log } from './log.js';

const BOOT_AT = new Date().toISOString();
const WORKER = 'agent-orders';

// Cloud Run services must answer a startup/health probe on $PORT. This worker is
// a background daemon — its real work is the sweep timer, not HTTP — so bind a
// tiny liveness endpoint only when PORT is set (matches workers/agent-sniper and
// workers/agora-citizens). Deployed as a Cloud Run Job (no probe) nothing sets
// PORT and nothing listens; the loop is unaffected either way.
const _live = { mode: null, network: null, globalKill: null };
function startHealthServer() {
	const port = Number(process.env.PORT);
	if (!Number.isFinite(port) || port <= 0) return;
	http
		.createServer((_req, res) => {
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ ok: true, worker: WORKER, bootAt: BOOT_AT, ..._live }));
		})
		.listen(port, () => log.info('health server listening', { port }));
}

async function heartbeat(cfg, extra) {
	try {
		await sql`
			INSERT INTO bot_heartbeat (worker, mode, last_beat_at, meta)
			VALUES (${WORKER}, ${cfg.mode}, now(), ${JSON.stringify({ network: cfg.network, globalKill: cfg.globalKill, bootAt: BOOT_AT, ...extra })}::jsonb)
			ON CONFLICT (worker) DO UPDATE
			SET mode = excluded.mode, last_beat_at = excluded.last_beat_at, meta = excluded.meta
		`;
	} catch (err) {
		log.warn('heartbeat write failed', { err: err?.message });
	}
}

async function main() {
	const cfg = loadConfig();
	log.info('boot', { network: cfg.network, mode: cfg.mode, pollMs: cfg.pollMs, globalKill: cfg.globalKill });

	let draining = false;
	let sweeping = false;
	let sweeps = 0;

	const tick = async () => {
		if (draining || sweeping || cfg.globalKill) return;
		sweeping = true;
		const started = Date.now();
		try {
			await runOrderSweep(cfg);
			sweeps++;
		} catch (err) {
			log.error('sweep failed', { err: err?.message });
		} finally {
			sweeping = false;
			if (cfg.heartbeatMs) heartbeat(cfg, { sweeps, lastSweepMs: Date.now() - started });
		}
	};

	if (cfg.heartbeatMs) await heartbeat(cfg, { sweeps: 0 });
	const timer = setInterval(tick, cfg.pollMs);
	tick();

	const shutdown = (signal) => {
		if (draining) return;
		draining = true;
		log.info('shutdown', { signal });
		clearInterval(timer);
		// Neon HTTP is stateless — nothing else to close. Give an in-flight sweep a
		// brief grace period, then exit.
		const deadline = Date.now() + 8_000;
		const wait = setInterval(() => {
			if (!sweeping || Date.now() > deadline) { clearInterval(wait); log.info('bye', {}); process.exit(0); }
		}, 200);
	};
	process.on('SIGINT', () => shutdown('SIGINT'));
	process.on('SIGTERM', () => shutdown('SIGTERM'));
	process.on('unhandledRejection', (err) => log.error('unhandledRejection', { err: err?.message }));
}

main().catch((err) => {
	log.error('fatal', { err: err?.message, stack: err?.stack });
	process.exit(1);
});
