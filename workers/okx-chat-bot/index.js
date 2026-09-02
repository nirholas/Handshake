// okx-chat-bot: always-on host for the OKX.AI marketplace chat bot (agent #2632).
//
// Marketplace chat for our listing is delivered over XMTP to a local `okx-a2a`
// daemon backed by an `onchainos` wallet session. Both used to live on a
// developer codespace, which cannot stay up: a rebuild wiped the CLIs and an
// idle nap killed the daemon (observed alive 21:09, dead by 03:13 the same
// night). OKX's chat test then reports "no delivery in 30 min" and the listing
// gets flagged offline. This worker is the durable host.
//
// What it owns:
//   1. State      restore the wallet/XMTP identity from GCS, snapshot it back
//   2. Workspace  rebuild the AI subsession's briefing + skills from the image
//   3. Daemon     supervise `okx-a2a run` with capped backoff restarts
//   4. Health     /readyz strict readiness, every other path liveness
//   5. Heartbeat  bot_heartbeat row → /api/healthz subsystems → gcp-triage
//   6. Alerts     a logged-out session pages a human WITH the exact commands
//
// Run: node workers/okx-chat-bot  (npm run worker:okx-bot)
// Deploy: workers/okx-chat-bot/cloudbuild.yaml. See the README for the one-time
// bucket/secret setup and why --max-instances=1 is load-bearing.

import { mkdir } from 'node:fs/promises';
import { sendOpsAlert } from '../../api/_lib/alerts.js';
import { sql } from '../../api/_lib/db.js';
import { loadConfig, paths } from './config.js';
import { agentRefresh, beginLogin, daemonStatus, exec, walletStatus } from './cli.js';
import { startHealthServer } from './health-server.js';
import { classify, loginInstructions } from './session.js';
import { restoreState, snapshotState } from './state.js';
import { createSupervisor } from './supervisor.js';
import { buildWorkspace } from './workspace.js';
import { log } from './log.js';

const WORKER = 'okx-chat-bot';
const BOOT_AT = new Date().toISOString();

/** Live health, refreshed by the session probe and read by the HTTP handlers. */
const live = {
	verdict: { status: 'unknown', ready: false, reason: 'booting', detail: 'probe has not run yet', needsHumanLogin: false },
	checkedAt: 0,
	daemon: 'unknown',
	wallet: null,
	agents: { agentCount: 0, activeClients: 0 },
	login: null,
	workspace: null,
	stateRestore: null,
};

async function heartbeat(cfg, supervisor) {
	const meta = {
		bootAt: BOOT_AT,
		agentId: cfg.agentId,
		host: cfg.host,
		hostDurable: cfg.hostDurable,
		health: live.verdict.status,
		ready: live.verdict.ready,
		reason: live.verdict.reason,
		detail: live.verdict.detail,
		needsHumanLogin: live.verdict.needsHumanLogin,
		loggedIn: live.wallet?.loggedIn ?? null,
		agentCount: live.agents.agentCount,
		activeClients: live.agents.activeClients,
		provider: cfg.provider,
		providerCredentialed: cfg.providerCredentialed,
		daemonRestarts: supervisor.stats().restarts,
		checkedAt: live.checkedAt,
	};
	try {
		await sql`
			INSERT INTO bot_heartbeat (worker, mode, last_beat_at, meta)
			VALUES (${WORKER}, ${cfg.provider}, now(), ${JSON.stringify(meta)}::jsonb)
			ON CONFLICT (worker) DO UPDATE
			SET mode = excluded.mode, last_beat_at = excluded.last_beat_at, meta = excluded.meta
		`;
	} catch (err) {
		log.warn('heartbeat write failed', { err: err?.message });
	}
}

// A session expiry is the one failure only a human can clear, so it must page
// loudly and carry the commands. Alert on the transition into the bad state,
// then at most every cfg.alertRepeatMs while it persists, so one overnight
// expiry does not become a hundred notifications.
let lastAlertReason = null;
let lastAlertAt = 0;
async function maybeAlert(cfg, verdict) {
	if (verdict.status === 'ok' || verdict.status === 'unknown') {
		if (lastAlertReason) {
			lastAlertReason = null;
			await sendOpsAlert('OKX chat bot recovered', `agent #${cfg.agentId} is reachable again: ${verdict.detail}`, {
				severity: 'info',
			}).catch(() => {});
		}
		return;
	}
	const now = Date.now();
	const changed = verdict.reason !== lastAlertReason;
	if (!changed && now - lastAlertAt < cfg.alertRepeatMs) return;
	lastAlertReason = verdict.reason;
	lastAlertAt = now;

	const lines = [`agent #${cfg.agentId}: ${verdict.detail}`];
	if (verdict.needsHumanLogin) lines.push('', 'Fix (needs a human):', ...loginInstructions(live.login?.loginUrl, live.login?.authSessionId));
	await sendOpsAlert(`OKX chat bot ${verdict.status}: ${verdict.reason}`, lines.join('\n'), {
		severity: verdict.status === 'down' ? 'critical' : 'warn',
	}).catch((err) => log.warn('ops alert failed', { err: err?.message }));
}

// One probe at a time. A probe can legitimately outrun its own interval (the
// three CLI calls are bounded at 15s + 30s + 90s), and two in flight would race
// on the login mint below: both would see `live.login` empty and start a second
// auth session, invalidating the URL a human is halfway through using.
let probing = false;
async function probeSession(cfg, supervisor) {
	if (probing) {
		log.warn('probe still running, skipping this tick', { sinceMs: Date.now() - live.checkedAt });
		return;
	}
	probing = true;
	try {
		await runProbe(cfg, supervisor);
	} finally {
		probing = false;
	}
}

async function runProbe(cfg, supervisor) {
	const daemon = await daemonStatus(cfg);
	const wallet = daemon.startsWith('running') ? await walletStatus(cfg) : null;
	const agents = wallet?.loggedIn ? await agentRefresh(cfg) : { agentCount: 0, activeClients: 0 };
	const verdict = classify({ daemon, wallet, agents, providerCredentialed: cfg.providerCredentialed });

	// Mint a fresh login URL only when one is actually needed, and only when we
	// do not already hold an unused one: `login --phase init` starts a new auth
	// session server-side, so calling it every probe would invalidate the URL a
	// human is halfway through using.
	if (verdict.needsHumanLogin && !live.login) {
		live.login = await beginLogin(cfg);
	} else if (!verdict.needsHumanLogin) {
		live.login = null;
	}

	const changed = verdict.reason !== live.verdict.reason;
	live.daemon = daemon;
	live.wallet = wallet;
	live.agents = agents;
	live.verdict = verdict;
	live.checkedAt = Date.now();

	if (changed) {
		log[verdict.status === 'ok' ? 'info' : 'warn']('health changed', {
			status: verdict.status,
			reason: verdict.reason,
			detail: verdict.detail,
		});
	}
	await maybeAlert(cfg, verdict);
	await heartbeat(cfg, supervisor);
}

async function main() {
	const cfg = loadConfig();
	const p = paths(cfg);
	log.info('boot', {
		home: cfg.home,
		agentId: cfg.agentId,
		host: cfg.host,
		hostDurable: cfg.hostDurable,
		provider: cfg.provider,
		providerReason: cfg.providerReason,
		stateBucket: cfg.stateBucket || null,
	});
	if (!cfg.providerCredentialed) {
		log.error('no AI-provider credential: the daemon will receive chat but cannot author replies', {
			provider: cfg.provider,
			needs: 'ANTHROPIC_API_KEY (preferred) or OPENAI_API_KEY',
		});
	}

	await mkdir(p.agentTask, { recursive: true });
	live.stateRestore = await restoreState(cfg);
	await mkdir(p.logs, { recursive: true });
	live.workspace = await buildWorkspace(cfg, p);

	// Provider + permission preset are persisted in ~/.okx-agent-task/config.toml,
	// which the restored snapshot may carry from an older posture. Re-assert both
	// so the deployed configuration always wins over the snapshot. Bypass matters:
	// without it the subsession stalls on a tool-approval prompt nobody is there to
	// answer, which reads to the buyer as an unresponsive bot.
	await exec(cfg, 'okx-a2a', ['config', 'provider', '--provider', cfg.provider], { timeoutMs: 30_000 });
	await exec(cfg, 'okx-a2a', ['config', 'permissions', '--preset', 'bypass'], { timeoutMs: 30_000 });

	const supervisor = createSupervisor(cfg, p);
	supervisor.start();
	const server = startHealthServer(cfg, live, supervisor, BOOT_AT);

	const probe = () => probeSession(cfg, supervisor).catch((err) => log.error('probe failed', { err: err?.message }));
	const probeTimer = setInterval(probe, cfg.sessionProbeMs);
	// The heartbeat runs on its own timer rather than only at the end of a probe.
	// A probe can outlast the freshness window /api/healthz judges this host by,
	// so tying the beat to it would let one slow CLI call read as "the host is
	// gone" while the bot is perfectly online.
	const heartbeatTimer = setInterval(
		() => heartbeat(cfg, supervisor).catch((err) => log.warn('heartbeat failed', { err: err?.message })),
		cfg.heartbeatMs,
	);
	const snapshotTimer = setInterval(
		() => snapshotState(cfg, { reason: 'timer' }).catch(() => {}),
		cfg.snapshotMs,
	);
	// Give the daemon a moment to bind XMTP before the first verdict, so a normal
	// boot does not page as "down".
	setTimeout(probe, 10_000);

	let draining = false;
	const shutdown = async (signal) => {
		if (draining) return;
		draining = true;
		log.info('shutdown', { signal });
		clearInterval(probeTimer);
		clearInterval(heartbeatTimer);
		clearInterval(snapshotTimer);
		server?.close();
		// Order matters: stop the daemon FIRST so its sqlite files are quiesced,
		// then snapshot. A live-copy snapshot can tear; this one cannot.
		await supervisor.stop();
		await snapshotState(cfg, { reason: signal });
		log.info('bye', {});
		process.exit(0);
	};
	process.on('SIGINT', () => shutdown('SIGINT'));
	process.on('SIGTERM', () => shutdown('SIGTERM'));
	process.on('unhandledRejection', (err) => log.error('unhandledRejection', { err: err?.message }));
}

main().catch((err) => {
	log.error('fatal', { err: err?.message, stack: err?.stack });
	process.exit(1);
});
