// okx-chat-bot: thin, non-throwing wrappers around the two external CLIs.
//
// Everything the worker knows about the bot's health comes from these two
// binaries, and neither is allowed to take the supervisor down: a CLI that hangs
// or exits non-zero must become a health verdict, never an unhandled rejection.
// So every call here is timeout-bounded and returns a value, including on error.
//
//   okx-a2a    the XMTP daemon that marketplace chat is delivered to
//   onchainos  the OKX wallet session the daemon reads agent identities through

import { execFile } from 'node:child_process';
import { log } from './log.js';

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Environment every CLI call inherits. HOME is the whole point: it decides where
 * both CLIs read and write their state, which is what makes the restored GCS
 * snapshot the session the daemon actually uses.
 * @param {ReturnType<import('./config.js').loadConfig>} cfg
 */
export function cliEnv(cfg) {
	return {
		...process.env,
		HOME: cfg.home,
		// The onchainos installer drops its binary in $HOME/.local/bin, but the
		// image relocates it to /usr/local/bin so it survives a state restore that
		// replaces $HOME. Keep both on PATH so a local run works either way.
		PATH: `${cfg.home}/.local/bin:${process.env.PATH || ''}`,
	};
}

/**
 * Run a CLI and capture stdout. Never throws.
 * @returns {Promise<{ ok: boolean, stdout: string, stderr: string, code: number|null }>}
 */
export function exec(cfg, bin, args, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
	return new Promise((resolve) => {
		execFile(
			bin,
			args,
			{ env: cliEnv(cfg), timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
			(err, stdout, stderr) => {
				resolve({
					ok: !err,
					stdout: (stdout || '').trim(),
					stderr: (stderr || '').trim(),
					code: err?.code ?? (err ? 1 : 0),
				});
			},
		);
	});
}

/**
 * Run a CLI whose output ends in a JSON line and parse it. Returns null when the
 * call failed or emitted nothing parseable, so callers branch on `null` rather
 * than on an exception.
 */
export async function execJson(cfg, bin, args, opts) {
	const r = await exec(cfg, bin, args, opts);
	const line = r.stdout.split('\n').filter(Boolean).pop();
	if (!line) return null;
	try {
		return JSON.parse(line);
	} catch {
		log.warn('cli emitted unparseable output', { bin, args: args.join(' '), sample: line.slice(0, 160) });
		return null;
	}
}

/** `okx-a2a daemon status` → the raw status line ('running pid=…', 'stopped', 'stale …'). */
export async function daemonStatus(cfg) {
	const r = await exec(cfg, 'okx-a2a', ['daemon', 'status'], { timeoutMs: 15_000 });
	return r.stdout || r.stderr || 'unknown';
}

/**
 * Wallet session state. `loggedIn:false` is a normal, expected answer (the OKX
 * session expires and needs a human OTP); `null` means the CLI itself failed.
 * @returns {Promise<{ loggedIn: boolean, email: string, accountCount: number }|null>}
 */
export async function walletStatus(cfg) {
	const j = await execJson(cfg, 'onchainos', ['wallet', 'status'], { timeoutMs: 30_000 });
	const d = j?.data;
	if (!d || typeof d.loggedIn !== 'boolean') return null;
	return { loggedIn: d.loggedIn, email: d.email || '', accountCount: Number(d.accountCount) || 0 };
}

/**
 * Pull agent identities so the XMTP clients come online, and report how many
 * are actually serving. `activeClients` is the number that decides whether a
 * buyer's message can be delivered at all.
 * @returns {Promise<{ agentCount: number, activeClients: number }>}
 */
export async function agentRefresh(cfg) {
	const j = await execJson(cfg, 'okx-a2a', ['agent', 'refresh', '--json'], { timeoutMs: 90_000 });
	const p = j?.payload || {};
	return { agentCount: Number(p.agentCount) || 0, activeClients: Number(p.activeClients) || 0 };
}

/**
 * Start a fresh browser login and return the URL a human must open. Used to make
 * the "session expired" alert actionable instead of merely descriptive.
 * @returns {Promise<{ authSessionId: string, loginUrl: string }|null>}
 */
export async function beginLogin(cfg) {
	const j = await execJson(cfg, 'onchainos', ['wallet', 'login', '--phase', 'init'], { timeoutMs: 60_000 });
	const d = j?.data;
	if (!d?.loginUrl || !d?.authSessionId) return null;
	return { authSessionId: String(d.authSessionId), loginUrl: String(d.loginUrl) };
}
