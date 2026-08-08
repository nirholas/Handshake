// agent-sniper — ops alerting.
//
// Thin wrapper over the platform's shared ops-alert pipeline
// (api/_lib/alerts.js → Telegram TELEGRAM_ALERTS_CHAT_ID). That module already
// owns the dedup-per-signature-per-hour and global-ceiling throttle, the 2.5s
// fire-and-forget timeout, and the [env] prefix — so a sustained feed outage
// pages once an hour, not every reconnect, and an alert storm can never wedge
// the trade loop.
//
// The trade-success / position-exit notifications are a SEPARATE channel
// (api/_lib/sniper/notify.js — TELEGRAM_SNIPER_CHAT_ID): those are product
// signal for the strategy owner. THIS module is for OPERATORS — "the worker is
// in trouble" (silent feed, repeated RPC failures, executor crashes, boot,
// shutdown). Distinct so a busy snipe day never drowns out a dead feed.
//
// Signatures are stable strings so the same failure dedups; transient detail
// (counts, ages) goes in the body, never the signature.

import { sendOpsAlert } from '../../api/_lib/alerts.js';
import { log } from './log.js';

const PREFIX = '🎯 agent-sniper';

function alert(title, detail, signature) {
	// sendOpsAlert is best-effort and swallows its own errors, but guard anyway:
	// alerting must never throw into the worker's control loop.
	Promise.resolve(sendOpsAlert(`${PREFIX} — ${title}`, detail, { signature })).catch(() => {});
}

/** The feed went silent past the watchdog threshold and we re-subscribed. */
export function alertFeedSilent({ silentMs, network, mode }) {
	alert(
		'feed silent — re-subscribing',
		`No PumpPortal events for ${Math.round(silentMs / 1000)}s on ${network} (${mode}). Re-subscribed; if this repeats the upstream feed or egress is degraded.`,
		'sniper:feed-silent',
	);
}

/** The feed dropped and exhausted its internal reconnect budget. */
export function alertFeedDown({ network, mode }) {
	alert(
		'feed connection down',
		`PumpPortal subscription closed and the worker re-subscribed from scratch on ${network} (${mode}). Nothing is scored while the feed is down.`,
		'sniper:feed-down',
	);
}

/**
 * The fleet cannot place a single entry — every armed wallet is below the size
 * its own executor would accept. This is the alert the 2026-07-29 outage did not
 * have: the worker stayed green for ten days while booking a thousand failed
 * buys, because nothing watched the money.
 */
export function alertFleetStarved({ summary, network, mode }) {
	alert(
		'fleet starved — no wallet can trade',
		`${summary} Network ${network} (${mode}). Nothing will fill until SOL reaches these wallets.`,
		'sniper:fleet-starved',
	);
}

/**
 * The auto-funder has wallets to refill and not enough SOL to do it. Distinct
 * from the starved alert on purpose: this one cannot self-heal, so it names the
 * human action rather than describing a condition that may pass on its own.
 */
export function alertFundingMasterDry({ summary, network, mode }) {
	alert(
		'funding master cannot cover refills',
		`${summary} Network ${network} (${mode}). Auto-funding is a no-op until the master wallet is topped up.`,
		'sniper:funding-master-dry',
	);
}

/** Executor / RPC errors crossed the run-window threshold. */
export function alertErrorSpike({ count, windowMs, lastError, network, mode }) {
	alert(
		'executor error spike',
		`${count} executor/RPC errors in the last ${Math.round(windowMs / 60000)}m on ${network} (${mode}). Last: ${lastError || 'unknown'}. Check the RPC endpoint and agent-wallet funding.`,
		'sniper:error-spike',
	);
}

/**
 * A strict-model arm refused a verdict because the failover chain answered for
 * its named model. One of these is noise (a single timeout); a sustained run of
 * them means the arm is parked — it will never trade until the named model's
 * route is restored. Signature is per model so a dead route pages hourly, not
 * per launch, and two broken models are two distinct pages.
 */
export function alertStrictModelOffline({ model, answeredBy, agentId }) {
	alert(
		`strict-model arm parked — ${model || 'unknown model'} not answering`,
		`A strict arm (${agentId || 'unknown agent'}) refused a buy because ${answeredBy || 'the failover chain'} answered in place of ${model || 'its named model'}. `
		+ 'A strict arm never trades on a fallback verdict, so it stays parked until that route works. Check the provider key/credits for that model.',
		`sniper:strict-model-offline:${model || 'unknown'}`,
	);
}

/** A heartbeat write to Postgres failed repeatedly — the worker is flying blind. */
export function alertHeartbeatStale({ network, mode }) {
	alert(
		'heartbeat write failing',
		`The sniper cannot write its liveness heartbeat to Postgres on ${network} (${mode}). /status will show it as stale even if trading is fine — fix the DB connection.`,
		'sniper:heartbeat-stale',
	);
}

/** The worker booted. Confirms a deploy/restart actually came back up. */
export function alertBoot({ network, mode, globalKill }) {
	alert(
		'worker started',
		`Sniper online — network=${network} mode=${mode}${globalKill ? ' [GLOBAL KILL]' : ''}.`,
		`sniper:boot:${Date.now()}`, // unique: every boot should announce
	);
	log.info('boot alert sent', { network, mode });
}

/** The worker is shutting down (deploy, scale-in, SIGTERM). */
export function alertShutdown({ signal, inFlight }) {
	alert(
		'worker stopping',
		`Sniper received ${signal}; draining ${inFlight} in-flight buy(s). Cloud Run will start a fresh revision.`,
		`sniper:shutdown:${Date.now()}`,
	);
}
