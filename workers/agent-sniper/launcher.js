// agent-sniper — autonomous coin launcher.
//
// Periodically checks agent_launcher_configs for due launches and fires them
// via POST /api/pump?action=launch-agent. Runs as a timer inside the sniper
// worker, started from index.js when cfg.launcher is true.
//
// Name template tokens:
//   {{timestamp}} — UNIX epoch seconds at launch time
//   {{seq}}       — launches_count + 1 (1-based sequence number)
//
// Simulate mode: logs the intended launch but does not POST or write DB rows.
//
// Per-launcher errors are isolated — one failed launch never blocks others.

import { sql } from '../../api/_lib/db.js';
import { log } from './log.js';
import { screenPush } from './screen-push.js';

const API_BASE_URL = process.env.API_BASE_URL || 'https://three.ws';
const AGENT_JWT = process.env.AGENT_JWT;

/**
 * Resolve a name template string against runtime values.
 *
 * @param {string|null} template
 * @param {number} seq          launches_count + 1
 * @returns {string}
 */
function resolveName(template, seq) {
	if (!template) return `Coin #${seq}`;
	const ts = Math.floor(Date.now() / 1000);
	return template
		.replace(/\{\{timestamp\}\}/g, String(ts))
		.replace(/\{\{seq\}\}/g, String(seq));
}

/**
 * Fire a single coin launch via the platform API.
 *
 * @param {object} config  Row from agent_launcher_configs
 * @param {string} name    Resolved name string
 * @returns {Promise<{ok:boolean, mint:string, sig:string, name:string, symbol:string}>}
 */
async function postLaunch(config, name) {
	const body = {
		agentId:       config.agent_id,
		network:       config.network,
		name,
		symbol:        config.symbol,
		description:   config.description   ?? null,
		image:         config.image_url     ?? null,
		twitter:       config.twitter       ?? null,
		telegram:      config.telegram      ?? null,
		website:       config.website       ?? null,
		initialBuySol: Number(config.initial_buy_sol) || 0,
	};

	const res = await fetch(`${API_BASE_URL}/api/pump?action=launch-agent`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			authorization:  `Bearer ${AGENT_JWT}`,
		},
		body: JSON.stringify(body),
	});

	const json = await res.json().catch(() => ({}));
	if (!res.ok || !json.ok) {
		throw new Error(json.error || json.message || `HTTP ${res.status}`);
	}
	return json;
}

/**
 * Record a successful launch in the DB and advance the launcher's schedule.
 *
 * @param {object} config        Row from agent_launcher_configs
 * @param {{mint:string, sig:string, name:string, symbol:string}} result
 */
async function recordLaunch(config, result) {
	// Persist the new coin into agent_launched_coins.
	await sql`
		INSERT INTO agent_launched_coins (
			agent_id,
			mint,
			symbol,
			name,
			launch_sig,
			auto_claim_enabled,
			network
		) VALUES (
			${config.agent_id},
			${result.mint},
			${result.symbol},
			${result.name},
			${result.sig},
			${config.auto_claim_enabled ?? false},
			${config.network}
		)
		ON CONFLICT (mint) DO NOTHING
	`;

	// Advance the launcher state: bump count, record timestamp, compute next fire.
	if (config.interval_hours != null) {
		await sql`
			UPDATE agent_launcher_configs
			SET
				launches_count  = launches_count + 1,
				last_launched_at = NOW(),
				next_launch_at  = NOW() + (${config.interval_hours} * INTERVAL '1 hour')
			WHERE id = ${config.id}
		`;
	} else {
		// No recurring interval — fire once and park it (next_launch_at = NULL means
		// the WHERE clause won't pick it up again, and the enabled flag stays true
		// for manual inspection).
		await sql`
			UPDATE agent_launcher_configs
			SET
				launches_count   = launches_count + 1,
				last_launched_at = NOW(),
				next_launch_at   = NULL
			WHERE id = ${config.id}
		`;
	}
}

/**
 * Query all launcher configs that are due to fire on the given network.
 *
 * @param {string} network  'mainnet' | 'devnet'
 * @returns {Promise<object[]>}
 */
async function fetchDueLaunchers(network) {
	const rows = await sql`
		SELECT *
		FROM agent_launcher_configs
		WHERE
			enabled = true
			AND network = ${network}
			AND (next_launch_at IS NULL OR next_launch_at <= NOW())
			AND (max_launches IS NULL OR launches_count < max_launches)
	`;
	return rows;
}

/**
 * Process a single due launcher config. Errors are caught and logged without
 * propagating so a single failure never disrupts the scan loop.
 *
 * @param {object} config  Row from agent_launcher_configs
 * @param {boolean} simulate  When true, log the intended action but skip I/O
 */
async function runLauncher(config, simulate) {
	const seq  = (Number(config.launches_count) || 0) + 1;
	const name = resolveName(config.name_template, seq);

	try {
		screenPush(`Launching $${config.symbol} on pump.fun...`, 'trade');
		log.info('launcher firing', {
			agentId: config.agent_id,
			symbol: config.symbol,
			name,
			seq,
			network: config.network,
			simulate,
		});

		if (simulate) {
			log.info('launcher simulate — skipping POST', {
				agentId: config.agent_id,
				symbol: config.symbol,
				name,
			});
			return;
		}

		const result = await postLaunch(config, name);

		log.info('launcher launched', {
			agentId: config.agent_id,
			symbol: result.symbol,
			mint: result.mint,
			sig: result.sig,
		});
		screenPush(`Launched $${result.symbol}: ${result.mint.slice(0, 8)}...`, 'trade');

		await recordLaunch(config, result);
	} catch (err) {
		log.error('launcher error', {
			agentId: config.agent_id,
			symbol: config.symbol,
			err: err?.message,
		});
		screenPush(`Launcher error for $${config.symbol}: ${err.message}`, 'activity');
	}
}

/**
 * Start the launcher watch loop. Checks for due launcher configs every
 * cfg.launcherPollMs milliseconds (minimum 60 seconds).
 *
 * @param {object} o
 * @param {object} o.cfg     loadConfig() result
 * @param {AbortSignal} [o.signal]  Optional abort signal for clean shutdown
 * @returns {() => void}  stop function
 */
export function startLauncherWatch({ cfg, signal }) {
	if (!AGENT_JWT) {
		log.warn('launcher disabled — AGENT_JWT not set');
		return () => {};
	}

	let scanning = false;

	const tick = async () => {
		if (scanning) return;
		scanning = true;
		try {
			const configs = await fetchDueLaunchers(cfg.network);
			if (!configs.length) return;

			log.info('launcher tick — due launchers', { count: configs.length, network: cfg.network });

			// Run launchers sequentially to avoid a thundering-herd of simultaneous
			// launch POSTs. Each is isolated — an error in one does not short-circuit
			// the rest (runLauncher swallows its own errors).
			for (const config of configs) {
				await runLauncher(config, cfg.mode === 'simulate');
			}
		} catch (err) {
			log.error('launcher scan failed', { err: err?.message });
		} finally {
			scanning = false;
		}
	};

	const pollMs = Math.max(60_000, cfg.launcherPollMs ?? 60_000);
	const interval = setInterval(() => {
		tick().catch((err) => log.error('launcher tick crashed', { err: err?.message }));
	}, pollMs);
	if (interval.unref) interval.unref();

	// Honour an abort signal if provided (lets callers share the worker's
	// AbortController without needing the returned stop function).
	if (signal) {
		signal.addEventListener('abort', () => clearInterval(interval), { once: true });
	}

	log.info('launcher watch armed', { pollMs, network: cfg.network, mode: cfg.mode });

	return function stop() {
		clearInterval(interval);
	};
}
