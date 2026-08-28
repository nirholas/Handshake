// Where a machine keeps its companion credentials.
//
// One small JSON file per user account on the machine, so the CLI, the desktop
// companion (apps/desktop), and anything else built on this package all read
// the same token instead of each inventing their own env var. It is written
// with 0600 permissions because it holds a bearer token.
//
// Resolution order, most explicit first:
//   1. an argument passed in code,
//   2. COMPANION_TOKEN / THREEWS_COMPANION_TOKEN in the environment,
//   3. the config file below.

import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

export const DEFAULT_API_BASE = 'https://three.ws';

export function configPath() {
	if (process.env.COMPANION_CONFIG) return process.env.COMPANION_CONFIG;
	const base = process.env.XDG_CONFIG_HOME
		|| (process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support') : join(homedir(), '.config'));
	return join(base, 'three-ws', 'companion.json');
}

export function readConfig() {
	const path = configPath();
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, 'utf8')) || {};
	} catch {
		// A corrupted file must not brick the CLI: treat it as absent, and the
		// next `companion login` overwrites it cleanly.
		return {};
	}
}

export function writeConfig(patch) {
	const path = configPath();
	mkdirSync(dirname(path), { recursive: true });
	const next = { ...readConfig(), ...patch, updated_at: new Date().toISOString() };
	writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
	try {
		chmodSync(path, 0o600);
	} catch {
		/* filesystems without POSIX modes (Windows) ignore this */
	}
	return next;
}

export function resolveCredentials({ token = null, apiBase = null } = {}) {
	const stored = readConfig();
	return {
		token: token || process.env.COMPANION_TOKEN || process.env.THREEWS_COMPANION_TOKEN || stored.token || null,
		apiBase: apiBase || process.env.COMPANION_API_BASE || stored.apiBase || DEFAULT_API_BASE,
		threshold: Number(process.env.COMPANION_THRESHOLD || stored.threshold || 60),
	};
}
