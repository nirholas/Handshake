// agent-sniper — autonomous pump.fun sniper worker (entrypoint).
//
// Holds the PumpPortal new-mint feed open, scores each launch against every
// armed agent strategy, and snipes from the agent's own wallet. A second loop
// manages open positions to their exit. This is a long-lived process — NOT a
// Vercel cron (hourly is far too slow to snipe). Run: node workers/agent-sniper.
//
//   SNIPER_MODE=simulate  — real quotes, no broadcast (default, safe)
//   SNIPER_MODE=live      — real trades from agent wallets
//   SNIPER_GLOBAL_KILL=1  — halt new buys; positions still managed/exited

import http from 'node:http';
import { connectPumpFunFeed } from '../../api/_lib/pumpfun-ws-feed.js';
import { loadConfig } from './config.js';
import { log } from './log.js';
import { refreshStrategies, cachedStrategies, logStrategyLoad } from './strategy-store.js';
import { scoreMint, scoreIntel } from './scorer.js';
import { executeBuy } from './executor.js';
import { oracleGate } from './oracle-gate.js';
import { judgeLaunch, llmVerdictGate } from './llm-judge.js';
import { runPositionSweep } from './positions.js';
import { runSwarmConsensus, runSwarmSettlement } from './swarm.js';
import { startFirstClaimWatch } from './first-claim-watch.js';
import { startOracleCrossingWatch } from './oracle-crossing.js';
import { startPrelaunchRadar } from './prelaunch-radar.js';
import { startIntelWatcher } from './intel/watcher.js';
import { getLearnedWeights } from './intel/store.js';
import { getSmartMoneyForMint } from '../../api/_lib/smart-money.js';
import { startHeartbeat } from './heartbeat.js';
import { makeErrorTracker } from './error-tracker.js';
import {
	alertFeedSilent,
	alertErrorSpike,
	alertBoot,
	alertShutdown,
	alertStrictModelOffline,
} from './alerts.js';
import { screenPush } from './screen-push.js';
import { scoreAlpha } from './alpha-hunt.js';
import { startAutoClaimerWatch } from './auto-claimer.js';
import { graduationRideGate, executeBoostRideBuy } from './graduation-ride.js';
import { startAutoFunderWatch, latestSolvency } from './auto-funder.js';
import { startLauncherWatch } from './launcher.js';
import { startMarketMakerWatch } from './market-maker.js';

const BOOT_AT = new Date().toISOString();

// Cloud Run services must answer a startup/health probe on $PORT (agent-sniper
// runs with ingress:internal, but the health check still applies). This worker
// is a background daemon — its real work is the feed loop, not HTTP — so bind a
// tiny liveness endpoint only when PORT is set (matches workers/agora-citizens).
// Locally (no PORT) nothing listens.
const _live = { mode: null, network: null };
function startHealthServer() {
	const port = Number(process.env.PORT);
	if (!Number.isFinite(port) || port <= 0) return;
	http
		.createServer((req, res) => {
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ ok: true, worker: 'agent-sniper', bootAt: BOOT_AT, ..._live }));
		})
		.listen(port, () => log.info('health server listening', { port }));
}

// ── global buy throttle (sliding 60s window) ─────────────────────────────────
function makeThrottle(maxPerMin) {
	const hits = [];
	return {
		tryConsume() {
			if (maxPerMin <= 0) return true;
			const now = Date.now();
			while (hits.length && now - hits[0] > 60_000) hits.shift();
			if (hits.length >= maxPerMin) return false;
			hits.push(now);
			return true;
		},
	};
}

// ── bounded buy queue (cap concurrent snipe attempts → bounded RPC) ──────────
function makeQueue(concurrency, maxDepth, onError) {
	let active = 0;
	const q = [];
	const pump = () => {
		while (active < concurrency && q.length) {
			const job = q.shift();
			active++;
			Promise.resolve()
				.then(job)
				.catch((err) => { log.error('buy job crashed', { err: err?.message }); onError?.(err?.message); })
				.finally(() => { active--; pump(); });
		}
	};
	return {
		push(job) {
			if (q.length >= maxDepth) { log.warn('buy queue full — dropping snipe', { depth: q.length }); return; }
			q.push(job);
			pump();
		},
		get inFlight() { return active + q.length; },
	};
}

async function main() {
	const cfg = loadConfig();
	log.info('boot', { network: cfg.network, mode: cfg.mode, globalKill: cfg.globalKill, pollMs: cfg.pollMs });
	_live.mode = cfg.mode;
	_live.network = cfg.network;
	startHealthServer();
	if (cfg.announceLifecycle) alertBoot({ network: cfg.network, mode: cfg.mode, globalKill: cfg.globalKill });
	screenPush(`Sniper online — ${cfg.network} / ${cfg.mode} mode`, 'activity');

	const throttle = makeThrottle(cfg.maxGlobalBuysPerMin);
	const errors = makeErrorTracker({ threshold: cfg.errorAlertThreshold, windowMs: cfg.errorAlertWindowMs });
	// Funnel an error into the spike tracker; alert once when a run-up crosses the
	// threshold. Pure observability — never alters the trade path.
	const noteError = (where, message) => {
		const spike = errors.record(`${where}: ${message || 'error'}`);
		if (spike) alertErrorSpike({ ...spike, network: cfg.network, mode: cfg.mode });
	};
	const queue = makeQueue(3, 50, (message) => noteError('buy', message));
	let draining = false;
	let lastEventAt = Date.now();
	let feedConnected = false;
	let reconnectCount = 0;

	if (cfg.agentIds) log.info('agent scope active', { agents: cfg.agentIds.length });
	log.info('mayhem filter', { enabled: cfg.mayhemFilter, strict: cfg.mayhemStrict });
	await refreshStrategies(cfg.network, 0, cfg.agentIds).then(() => logStrategyLoad(cfg.network)).catch((err) =>
		log.error('initial strategy load failed', { err: err?.message }),
	);

	const onEvent = ({ kind, data }) => {
		lastEventAt = Date.now();
		feedConnected = true; // an event is proof the subscription is live
		if (draining || cfg.globalKill) return;

		// Migration events drive graduation_ride (BOOST-window) strategies: the
		// coin just left the curve, pump.fun's 5-minute buyback+burn TWAP is
		// starting, and the arm buys the new AMM pool to sell into that window.
		// executeBoostRideBuy waits for the pool then flows through the same
		// executeBuy chokepoint (Mayhem gate, firewall, budgets) as every path.
		if (kind === 'graduation') {
			const gsym = (data.symbol || data.mint?.slice(0, 6) || '?').toUpperCase();
			for (const strat of cachedStrategies()) {
				const gate = graduationRideGate(data, strat);
				if (!gate.pass) {
					if (gate.reason !== 'not_graduation_ride') log.info('boost-ride gate skip', { agent: strat.agent_id, mint: data.mint, reason: gate.reason });
					continue;
				}
				log.info('boost-ride candidate', { agent: strat.agent_id, mint: data.mint, symbol: data.symbol });
				screenPush(`$${gsym} migrated — riding the BOOST window`, 'trade');
				queue.push(async () => {
					await executeBoostRideBuy({ cfg, strat, ev: data, throttle });
				});
			}
			return;
		}

		if (kind !== 'mint') return;
		const sym = (data.symbol || data.mint.slice(0, 6)).toUpperCase();
		screenPush(`New token: $${sym} — scoring`, 'analysis');
		const strategies = cachedStrategies();
		for (const strat of strategies) {
			// The new-mint feed only drives new_mint strategies; first_claim
			// strategies are driven by the on-chain claim poll loop below.
			if ((strat.trigger || 'new_mint') !== 'new_mint') continue;

			// LLM-judged experiment arm: no rule shields, no oracle gate: a model
			// reads the launch and decides. The executeBuy chokepoint still enforces
			// every safety rail (Mayhem, firewall round-trip, budgets, headroom).
			//
			// judgeLaunch() self-bounds its own concurrency (see llm-judge.js) and is
			// called directly, NOT through the shared `queue` — that queue is sized
			// for bounded RPC (buy execution), and an LLM call that's retrying a
			// failing provider chain can occupy a slot for many seconds. Routing the
			// judge call through `queue` let a provider outage back the queue up past
			// its depth cap and starve real buy attempts fleet-wide (rules arms
			// included) with "buy queue full — dropping snipe". Only the confirmed
			// buy touches `queue`.
			if ((strat.decision_mode || 'rules') === 'llm') {
				judgeLaunch(data, strat)
					.then((verdict) => {
						if (!verdict) return;
						const gate = llmVerdictGate(verdict, strat);
						if (!gate.pass) {
							log.info('llm judge pass', { agent: strat.agent_id, mint: data.mint, model: verdict.model, buy: verdict.buy, confidence: verdict.confidence, gate: gate.reason });
							// A strict arm rejecting a fallback verdict is not a trading
							// decision — it is a parked arm. Page (hourly, per model) so a
							// dead model route can never quietly retire an experiment again.
							if (gate.reason === 'fallback_model') {
								alertStrictModelOffline({ model: strat.llm_model, answeredBy: verdict.answeredBy, agentId: strat.agent_id });
							}
							return;
						}
						log.info('llm judge buy', { agent: strat.agent_id, mint: data.mint, model: verdict.model, confidence: verdict.confidence, thesis: verdict.thesis });
						screenPush(`$${sym} LLM verdict: BUY at ${Math.round(verdict.confidence * 100)}%: ${verdict.thesis}`, 'trade');
						queue.push(async () => {
							await executeBuy({
								cfg, strat, throttle,
								mint: { ...data, entry_trigger: 'llm_judge', trigger_ref: verdict.model, score: verdict.confidence, llm: verdict },
							});
						});
					})
					.catch((err) => log.error('llm judge branch failed', { agent: strat.agent_id, mint: data.mint, err: err?.message }));
				continue;
			}

			const { pass, score, reasons } = scoreMint(data, strat);
			if (!pass) continue;
			log.info('candidate', { agent: strat.agent_id, mint: data.mint, symbol: data.symbol, score, reasons });
			screenPush(`$${sym} scored ${score} — BUYING`, 'trade');
			queue.push(async () => {
				const og = await oracleGate(data.mint, cfg.network, strat);
				if (!og.pass) {
					log.info('oracle gate skip', { agent: strat.agent_id, mint: data.mint, reason: og.reason });
					screenPush(`$${sym} oracle blocked: ${og.reason}`, 'analysis');
					return;
				}
				if (og.skipped) log.info('oracle unscored — proceeding', { agent: strat.agent_id, mint: data.mint });
				await executeBuy({ cfg, strat, mint: data, throttle });
			});
		}
	};

	const abort = new AbortController();
	// kind 'all' = new mints + migrations (no per-mint trade subs without tracked
	// mints). Migrations feed the graduation_ride (BOOST-window) strategies.
	let stopFeed = connectPumpFunFeed({ kind: 'all', signal: abort.signal, onEvent });
	feedConnected = true;
	log.info('feed connected', {});

	// Coin Intelligence Engine: observe every new coin's first seconds, classify
	// it, persist signals, and drive intel_confirmed strategies on a finished
	// verdict. Separate WS (dynamic per-mint trade subscriptions) from the snipe
	// feed above. Read-only on the chain — it never trades, only watches.
	let stopIntel = () => {};
	if (cfg.intel) {
		const onIntel = (rec) => {
			if (draining || cfg.globalKill) return;
			const strategies = cachedStrategies();
			const wantsIntel = strategies.some(
				(strat) => (strat.trigger || 'new_mint') === 'intel_confirmed' && strat.network === cfg.network,
			);
			if (!wantsIntel) return;

			// Attach the live smart-money graph read once per finished intel record so
			// scoreIntel's gate + score see who reputable is in. Degrades silently to a
			// zero-data result (computed:false) — never blocks the snipe path.
			const smartReady = getSmartMoneyForMint(rec.mint, cfg.network)
				.then((sm) => { rec.smart_money = sm; })
				.catch(() => { rec.smart_money = null; });

			for (const strat of strategies) {
				const trigger = strat.trigger || 'new_mint';
				if (strat.network !== cfg.network) continue;

				// LLM arms on the intel trigger judge the coin AFTER observation, so the
				// model sees the market SHAPE (buyer/seller diversity, concentration,
				// timing) — the painted-stairstep tell a human reads off the chart and a
				// blind new_mint LLM buy never gets. Safety rails still gate at executeBuy.
				if (trigger === 'intel_confirmed' && (strat.decision_mode || 'rules') === 'llm') {
					smartReady.then(() => {
						const judgeMint = {
							mint: rec.mint, symbol: rec.symbol, name: rec.name, description: rec.description,
							twitter: rec.twitter, telegram: rec.telegram, website: rec.website,
							market_cap_usd: rec.market_cap_usd, initial_buy_sol: rec.dev_buy_sol,
							creator_launches: rec.creator_launches, creator_graduated: rec.creator_graduated,
							signals: rec.signals,
						};
						judgeLaunch(judgeMint, strat).then((verdict) => {
							if (!verdict) return;
							// Floor + overconfidence ceiling + named-model strictness in one
							// gate (llmVerdictGate). The verdict is already recorded either
							// way; only the money is gated here.
							const gate = llmVerdictGate(verdict, strat);
							if (!gate.pass) {
								log.info('llm judge pass', { agent: strat.agent_id, mint: rec.mint, model: verdict.model, buy: verdict.buy, confidence: verdict.confidence, gate: gate.reason });
								if (gate.reason === 'fallback_model') {
									alertStrictModelOffline({ model: strat.llm_model, answeredBy: verdict.answeredBy, agentId: strat.agent_id });
								}
								return;
							}
							log.info('llm judge buy', { agent: strat.agent_id, mint: rec.mint, model: verdict.model, confidence: verdict.confidence, thesis: verdict.thesis });
							queue.push(async () => {
								await executeBuy({
									cfg, strat, throttle,
									mint: { mint: rec.mint, symbol: rec.symbol, name: rec.name, market_cap_usd: rec.market_cap_usd, entry_trigger: 'llm_intel', trigger_ref: verdict.model, score: verdict.confidence, llm: verdict },
								});
							});
						}).catch((err) => log.error('llm intel judge failed', { mint: rec.mint, err: err?.message }));
					});
					continue;
				}

				if (trigger === 'intel_confirmed') {
					Promise.all([getLearnedWeights(cfg.network), smartReady])
						.then(([weights]) => {
							const { pass, score, reasons } = scoreIntel(rec, strat, weights);
							if (!pass) return;
							log.info('intel candidate', { agent: strat.agent_id, mint: rec.mint, symbol: rec.symbol, score, reasons });
							screenPush(`$${(rec.symbol || rec.mint.slice(0, 6)).toUpperCase()} intel score ${score} — BUYING`, 'trade');
							queue.push(async () => {
								const og = await oracleGate(rec.mint, cfg.network, strat);
								if (!og.pass) { log.info('oracle gate skip', { agent: strat.agent_id, mint: rec.mint, reason: og.reason }); return; }
								if (og.skipped) log.info('oracle unscored — proceeding', { agent: strat.agent_id, mint: rec.mint });
								await executeBuy({
									cfg, strat, throttle,
									mint: { mint: rec.mint, symbol: rec.symbol, name: rec.name, market_cap_usd: rec.market_cap_usd, entry_trigger: 'intel_confirmed', trigger_ref: rec.mint },
								});
							});
						})
						.catch((err) => log.error('intel score failed', { mint: rec.mint, err: err?.message }));
				}

				if (trigger === 'alpha_hunt') {
					// alpha_hunt scores on the fully-enriched intel record (smart money,
					// organic score, quality, narrative) — no learned weights needed.
					smartReady.then(() => {
						const { pass, score, reasons } = scoreAlpha(rec, strat);
						if (!pass) return;
						log.info('alpha candidate', { agent: strat.agent_id, mint: rec.mint, symbol: rec.symbol, score, reasons });
						screenPush(`$${(rec.symbol || rec.mint.slice(0, 6)).toUpperCase()} alpha score ${score} — BUYING`, 'trade');
						queue.push(async () => {
							if (draining || cfg.globalKill) return;
							const og = await oracleGate(rec.mint, cfg.network, strat);
							if (!og.pass) { log.info('oracle gate skip', { agent: strat.agent_id, mint: rec.mint, reason: og.reason }); return; }
							if (og.skipped) log.info('oracle unscored — proceeding', { agent: strat.agent_id, mint: rec.mint });
							await executeBuy({
								cfg, strat, throttle,
								mint: { mint: rec.mint, symbol: rec.symbol, name: rec.name, market_cap_usd: rec.market_cap_usd, entry_trigger: 'alpha_hunt', trigger_ref: rec.mint },
							});
						});
					}).catch((err) => log.error('alpha score failed', { mint: rec.mint, err: err?.message }));
				}
			}
		};
		stopIntel = startIntelWatcher({
			network: cfg.network,
			windowMs: cfg.intelWindowMs,
			maxConcurrent: cfg.intelMaxConcurrent,
			useLlm: cfg.intelLlm,
			signal: abort.signal,
			onIntel,
		});
		log.info('intel watcher started', { windowMs: cfg.intelWindowMs, llm: cfg.intelLlm });
	}

	// First-claim trigger: polls the on-chain fee-claim stream and snipes a
	// creator's coin on their first-ever reward claim. Shares the buy queue +
	// global throttle with the new-mint path, and halts new buys on drain/kill.
	const stopClaimWatch = startFirstClaimWatch({
		cfg, queue, throttle, isHalted: () => draining || cfg.globalKill,
	});

	// Oracle conviction-crossing entries — buys the FIRST crossing of a
	// strategy's conviction threshold (median 2 minutes after launch) instead of
	// gating a launch-second buy on a score that does not exist yet. See
	// workers/agent-sniper/oracle-crossing.js for the measured rationale.
	const stopCrossingWatch = startOracleCrossingWatch({
		cfg, queue, throttle, isHalted: () => draining || cfg.globalKill,
	});

	// Autonomous coin launcher — fires pump.fun launches on schedule.
	let stopLauncher = () => {};
	if (cfg.launcher) {
		stopLauncher = startLauncherWatch({ cfg, signal: abort.signal });
		log.info('launcher armed', { network: cfg.network, pollMs: cfg.launcherPollMs });
	}

	// Creator auto-claim — polls claimable fees on agent-launched coins.
	let stopAutoClaimer = () => {};
	if (cfg.autoClaim) {
		stopAutoClaimer = startAutoClaimerWatch({ cfg, signal: abort.signal });
		log.info('auto-claimer armed', { network: cfg.network, pollMs: cfg.autoClaimPollMs });
	}

	// Buy-side auto-funding — keeps each armed agent's wallet topped from the
	// launcher master so a live sniper never silently runs out of SOL mid-run.
	//
	// Started unconditionally: the same loop measures fleet solvency, and a fleet
	// running with auto-funding OFF is the one most likely to starve unnoticed
	// (nothing refills it at all). Funding itself still requires cfg.autoFund —
	// the loop measures always, moves money only when armed to.
	const stopAutoFunder = startAutoFunderWatch({ cfg, signal: abort.signal });

	// Market maker — range-based liquidity provisioning with Jito execution.
	let stopMarketMaker = () => {};
	if (cfg.marketMaker) {
		stopMarketMaker = startMarketMakerWatch({ cfg, signal: abort.signal });
		log.info('market-maker armed', { network: cfg.network, intervalMs: cfg.marketMakerIntervalMs });
	}

	// Pre-launch creator-wallet radar: watches proven creator + smart-money wallets
	// on-chain, detects launch precursors (funding a fresh deploy wallet / a pump
	// create) at block-0, and pre-arms a snipe through the SAME executor as the feed
	// path. Honestly reports paused when no RPC endpoint is available. Shares the
	// buy queue + throttle and halts new buys on drain/kill.
	let radar = { stop() {}, getState: () => ({ active: false, paused: true, reason: 'disabled' }) };
	if (cfg.radar) {
		radar = startPrelaunchRadar({
			cfg, queue, throttle, isHalted: () => draining || cfg.globalKill,
		});
	}

	// Strategy cache refresh.
	const strategyTimer = setInterval(() => {
		refreshStrategies(cfg.network, cfg.strategyRefreshMs, cfg.agentIds)
			.then(() => logStrategyLoad(cfg.network))
			.catch((err) => log.error('strategy refresh failed', { err: err?.message }));
	}, cfg.strategyRefreshMs);

	// Position lifecycle sweep — overlap-guarded so a slow sweep can't stack.
	let sweeping = false;
	const positionTimer = setInterval(async () => {
		if (sweeping || draining) return;
		sweeping = true;
		try {
			await runPositionSweep(cfg);
		} catch (err) {
			log.error('position sweep failed', { err: err?.message });
			noteError('sweep', err?.message);
		} finally {
			sweeping = false;
			errors.tick(); // re-arm the spike alert once the window drains
		}
	}, cfg.pollMs);

	// Trading-swarm consensus + settlement — overlap-guarded so a slow pass can't
	// stack. Consensus pools members' live positions into a reputation-weighted vote
	// and fires firewall-gated treasury buys; settlement distributes realized profit
	// pro-rata. Both reuse the same guards/execution as solo snipes.
	let swarmBusy = false;
	const swarmTimer = setInterval(async () => {
		if (swarmBusy || draining || cfg.globalKill) return;
		swarmBusy = true;
		try {
			await runSwarmConsensus(cfg, { throttle });
			await runSwarmSettlement(cfg);
		} catch (err) {
			log.error('swarm loop failed', { err: err?.message });
			noteError('swarm', err?.message);
		} finally {
			swarmBusy = false;
		}
	}, Math.max(cfg.pollMs, 8000));

	// Feed watchdog: connectPumpFunFeed stops after 5 drops; if the feed goes
	// quiet past the threshold, tear down and re-subscribe so the brain never
	// silently goes deaf.
	const watchdogTimer = setInterval(() => {
		if (draining) return;
		const silentMs = Date.now() - lastEventAt;
		if (silentMs > cfg.feedWatchdogMs) {
			feedConnected = false;
			reconnectCount++;
			log.warn('feed silent — re-subscribing', { silentMs, reconnects: reconnectCount });
			alertFeedSilent({ silentMs, network: cfg.network, mode: cfg.mode });
			screenPush(`Feed silent ${Math.round(silentMs / 1000)}s — reconnecting`, 'activity');
			try { stopFeed?.(); } catch {}
			lastEventAt = Date.now();
			const a2 = new AbortController();
			abort.signal.addEventListener('abort', () => a2.abort());
			stopFeed = connectPumpFunFeed({ kind: 'all', signal: a2.signal, onEvent });
		}
	}, Math.min(cfg.feedWatchdogMs, 60_000));

	// Liveness heartbeat — upserts bot_heartbeat so /api/sniper/status and the
	// uptime cron can see the worker is alive AND that its feed is actually live
	// (a process that's up with a dead feed is the worst, silent failure mode).
	const stopHeartbeat = startHeartbeat({
		mode: cfg.mode,
		intervalMs: cfg.heartbeatMs,
		getMeta: () => ({
			network: cfg.network,
			feedConnected,
			lastEventAgeMs: Date.now() - lastEventAt,
			feedWatchdogMs: cfg.feedWatchdogMs,
			strategies: cachedStrategies().length,
			globalKill: cfg.globalKill,
			reconnects: reconnectCount,
			errors: errors.total,
			lastError: errors.lastError,
			intel: cfg.intel,
			inFlightBuys: queue.inFlight,
			radar: cfg.radar ? radar.getState() : { active: false, paused: true, reason: 'disabled' },
			// Can the fleet actually afford to trade? Liveness alone reported a
			// green worker through ten days of unaffordable entries; this is the
			// money half of the same question. Null until the funder's first tick.
			solvency: latestSolvency(),
			bootAt: BOOT_AT,
		}),
	});

	const shutdown = async (signal) => {
		if (draining) return;
		draining = true;
		log.info('shutdown', { signal, inFlight: queue.inFlight });
		if (cfg.announceLifecycle) alertShutdown({ signal, inFlight: queue.inFlight });
		clearInterval(strategyTimer);
		clearInterval(positionTimer);
		clearInterval(swarmTimer);
		clearInterval(watchdogTimer);
		try { stopHeartbeat?.(); } catch {}
		try { stopClaimWatch?.(); } catch {}
		try { stopCrossingWatch?.(); } catch {}
		try { radar?.stop?.(); } catch {}
		try { stopFeed?.(); } catch {}
		try { stopIntel?.(); } catch {}
		try { stopLauncher?.(); } catch {}
		try { stopAutoClaimer?.(); } catch {}
		try { stopAutoFunder?.(); } catch {}
		try { stopMarketMaker?.(); } catch {}
		abort.abort();
		// Give in-flight buys a moment to settle (Neon HTTP is stateless — nothing
		// else to close).
		const deadline = Date.now() + 10_000;
		while (queue.inFlight > 0 && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 200));
		}
		log.info('bye', { inFlight: queue.inFlight });
		process.exit(0);
	};
	process.on('SIGINT', () => shutdown('SIGINT'));
	process.on('SIGTERM', () => shutdown('SIGTERM'));
	process.on('unhandledRejection', (err) => {
		log.error('unhandledRejection', { err: err?.message });
		noteError('unhandledRejection', err?.message);
		screenPush(`Error: ${err?.message || 'unhandled rejection'}`, 'activity');
	});
}

main().catch((err) => {
	log.error('fatal', { err: err?.message, stack: err?.stack });
	process.exit(1);
});
