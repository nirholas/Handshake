// okx-chat-bot: the HTTP surface Cloud Run probes and a human reads.
//
// Two behaviours here are deliberate and load-bearing:
//
//   /readyz   STRICT. 200 only when a buyer's message can actually be delivered.
//             "The process is up" is exactly the false-green this worker exists
//             to end, so a live host with an expired session answers 503.
//   anything  Liveness. Always 200. Cloud Run must NOT restart the container for
//   else      a logged-out session: a restart cannot fix it (only a human OTP
//             can) and a restart loop would destroy the state snapshot cadence.
//
// When a human is needed the response carries a `remedy` array with the real
// commands, so the fix travels with the status instead of living in a runbook
// someone has to go find.
//
// The handler is built separately from the server so the contract above is
// testable over real HTTP without a daemon, a wallet, or a network.

import http from 'node:http';
import { loginInstructions } from './session.js';
import { log } from './log.js';

/**
 * The full status document, shared by both routes.
 *
 * @param {ReturnType<import('./config.js').loadConfig>} cfg
 * @param {object} live        the worker's live health record (see index.js)
 * @param {object} daemonStats supervisor.stats()
 * @param {string} bootAt
 */
export function statusBody(cfg, live, daemonStats, bootAt) {
	const body = {
		worker: 'okx-chat-bot',
		agentId: cfg.agentId,
		bootAt,
		host: { label: cfg.host, durable: cfg.hostDurable },
		provider: { name: cfg.provider, credentialed: cfg.providerCredentialed, reason: cfg.providerReason },
		daemon: { status: live.daemon, ...daemonStats },
		session: live.wallet ? { loggedIn: live.wallet.loggedIn, email: live.wallet.email } : null,
		agents: live.agents,
		workspace: live.workspace,
		state: { bucket: cfg.stateBucket || null, restore: live.stateRestore },
		health: live.verdict,
		checkedAt: live.checkedAt,
	};
	if (live.verdict.needsHumanLogin) body.remedy = loginInstructions(live.login?.loginUrl, live.login?.authSessionId);
	return body;
}

/**
 * @param {ReturnType<import('./config.js').loadConfig>} cfg
 * @param {object} live
 * @param {() => object} daemonStats
 * @param {string} bootAt
 * @returns {http.RequestListener}
 */
export function createHealthHandler(cfg, live, daemonStats, bootAt) {
	return (req, res) => {
		const url = (req.url || '/').split('?')[0];
		const body = statusBody(cfg, live, daemonStats(), bootAt);
		if (url === '/readyz') {
			res.writeHead(live.verdict.ready ? 200 : 503, { 'content-type': 'application/json' });
			res.end(JSON.stringify(body));
			return;
		}
		res.writeHead(200, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ ok: true, ...body }));
	};
}

/**
 * Bind the health server. Returns null when PORT is unset, which is fine for a
 * local run and never for Cloud Run.
 */
export function startHealthServer(cfg, live, supervisor, bootAt) {
	if (!cfg.port) {
		log.warn('PORT unset: no health server (fine for a local run, never for Cloud Run)');
		return null;
	}
	const server = http.createServer(createHealthHandler(cfg, live, () => supervisor.stats(), bootAt));
	server.listen(cfg.port, () => log.info('health server listening', { port: cfg.port }));
	return server;
}
