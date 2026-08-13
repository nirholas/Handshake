/**
 * agent-screen-caster — CLI entrypoint
 * -------------------------------------
 * Reads configuration from environment variables (or .env file via --env flag),
 * resolves the requested task module, instantiates AgentScreenCaster, and runs.
 *
 * Usage:
 *   node index.js
 *   node index.js --env .env.local
 *   TASK=pump-monitor TASK_ARG=<mint> node index.js
 *
 * Multiple agents in one process:
 *   Spin up additional AgentScreenCaster instances (each with their own
 *   agentId/bearerToken) and run their task functions concurrently.
 *
 * Env vars (README.md holds the full table, including the trade task's
 * WALLET_STORAGE_STATE_PATH):
 *   AGENT_ID             UUID of the agent identity (required)
 *   AGENT_BEARER_TOKEN   JWT or API key (required)
 *   PUSH_URL             Override push endpoint (default: https://three.ws/api/agent-screen-push)
 *   FRAME_INTERVAL_MS    Milliseconds between frame captures (default: 400)
 *   JPEG_QUALITY         JPEG quality 1-100 (default: 72)
 *   HEADLESS             "true" (default) | "false" for visible browser window
 *   TASK                 Task module name: pump-monitor | trade (default: pump-monitor)
 *   TASK_ARG             Primary argument passed to the task (e.g. mint address)
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { AgentScreenCaster } from './caster.js';

const __dir = dirname(fileURLToPath(import.meta.url));

// ── Parse --env flag ───────────────────────────────────────────────────────────
const envFlagIdx = process.argv.indexOf('--env');
if (envFlagIdx !== -1) {
	const envFile = process.argv[envFlagIdx + 1];
	if (!envFile) fatal('--env requires a file path');
	loadEnvFile(resolve(process.cwd(), envFile));
} else if (fileExists('.env')) {
	loadEnvFile(resolve(__dir, '.env'));
}

// ── Read config ────────────────────────────────────────────────────────────────
const agentId     = required('AGENT_ID');
const bearerToken = required('AGENT_BEARER_TOKEN');
const pushUrl     = process.env.PUSH_URL           || 'https://three.ws/api/agent-screen-push';
const frameMs     = Number(process.env.FRAME_INTERVAL_MS || 400);
const jpegQuality = Number(process.env.JPEG_QUALITY      || 72);
const headless    = process.env.HEADLESS !== 'false';
const task        = process.env.TASK     || 'pump-monitor';
const taskArg     = process.env.TASK_ARG || '';

// ── Resolve task module ────────────────────────────────────────────────────────
const TASK_MAP = {
	'pump-monitor': './tasks/pump-monitor.js',
	'trade':        './tasks/trade.js',
};

const taskPath = TASK_MAP[task];
if (!taskPath) fatal(`Unknown task "${task}". Valid tasks: ${Object.keys(TASK_MAP).join(', ')}`);

// ── Boot ───────────────────────────────────────────────────────────────────────
const caster = new AgentScreenCaster({ agentId, bearerToken, pushUrl, frameIntervalMs: frameMs, jpegQuality });

// Register BEFORE the task runs. Registering after the top-level `await run(...)`
// means no handler exists while a task is in flight, so Playwright's own SIGINT
// hook closes the browser first and the task's rejection reads as a real error
// (isClosing still false) instead of a clean shutdown.
process.on('SIGTERM', async () => { await caster.close(); process.exit(0); });
process.on('SIGINT',  async () => { await caster.close(); process.exit(0); });

console.log('[agent-screen-caster] starting');
console.log('  agentId  :', agentId);
console.log('  pushUrl  :', pushUrl);
console.log('  task     :', task, taskArg ? `(arg: ${taskArg})` : '');
console.log('  headless :', headless);
console.log('  frameMs  :', frameMs, 'ms  jpegQuality:', jpegQuality);

await caster.launch(headless);

console.log('[agent-screen-caster] browser launched — starting task');

const { run } = await import(taskPath);

// Push an initial activity so watchers see the agent is alive.
await caster.pushActivity([{
	type:    'start',
	summary: `Agent starting task: ${task}${taskArg ? ` — ${taskArg}` : ''}`,
	ts:      Date.now(),
}]);

caster.startFrameLoop();

try {
	await run(caster, taskArg);
} catch (err) {
	if (caster.isClosing) {
		// SIGINT/SIGTERM closed the browser under the task; the resulting page
		// rejection is clean shutdown, not an error the agent's watchers should see.
		console.log('[agent-screen-caster] task interrupted by shutdown');
	} else {
		console.error('[agent-screen-caster] task error:', err?.message || err);
		await caster.pushActivity([{
			type:    'error',
			summary: `Task error: ${err?.message || String(err)}`,
			ts:      Date.now(),
		}]).catch((pushErr) => {
			console.error('[agent-screen-caster] could not report task error:', pushErr?.message || pushErr);
		});
	}
} finally {
	await caster.close();
	console.log('[agent-screen-caster] shut down');
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function required(name) {
	const v = process.env[name];
	if (!v) fatal(`Missing required env var: ${name}`);
	return v;
}

function fatal(msg) {
	console.error('[agent-screen-caster] fatal:', msg);
	process.exit(1);
}

function fileExists(path) {
	try { readFileSync(resolve(__dir, path)); return true; } catch { return false; }
}

function loadEnvFile(path) {
	let raw;
	try { raw = readFileSync(path, 'utf8'); } catch { fatal(`Cannot read env file: ${path}`); }

	for (const line of raw.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;
		const eqIdx = trimmed.indexOf('=');
		if (eqIdx === -1) continue;
		const key = trimmed.slice(0, eqIdx).trim();
		const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
		if (key && !(key in process.env)) process.env[key] = val;
	}
}
