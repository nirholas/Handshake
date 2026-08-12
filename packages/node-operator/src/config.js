/**
 * Client config: env-first with a config file fallback, validated eagerly so
 * a misconfigured node fails at boot with a readable message instead of
 * mid-job.
 *
 * Precedence: environment variable > config file (operator.config.json) >
 * default. Every field maps 1:1 to the README's operator guide.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULTS = {
	platformUrl: 'https://three.ws',
	model: 'Xenova/all-MiniLM-L6-v2',
	capability: 'text-embedding',
	pollIntervalMs: 5000,
	maxConcurrency: 1,
	identityPath: 'node-identity.json',
	jobTimeoutMs: 120_000,
};

/**
 * Load and validate config.
 *
 * @param {object} [opts]
 * @param {NodeJS.ProcessEnv} [opts.env] environment map (defaults to process.env)
 * @param {string} [opts.cwd] directory to look for operator.config.json / the identity file
 * @returns the validated config object
 */
export function loadConfig({ env = process.env, cwd = process.cwd() } = {}) {
	let file = {};
	const configPath = join(cwd, 'operator.config.json');
	if (existsSync(configPath)) {
		try {
			file = JSON.parse(readFileSync(configPath, 'utf8'));
		} catch (err) {
			throw new Error(`operator.config.json is not valid JSON: ${err.message}`);
		}
	}

	const pick = (envKey, fileKey, fallback) => {
		if (env[envKey] !== undefined && env[envKey] !== '') return env[envKey];
		if (file[fileKey] !== undefined) return file[fileKey];
		return fallback;
	};

	const cfg = {
		platformUrl: pick('PLATFORM_URL', 'platformUrl', DEFAULTS.platformUrl).replace(/\/+$/, ''),
		model: pick('MODEL', 'model', DEFAULTS.model),
		capability: pick('CAPABILITY', 'capability', DEFAULTS.capability),
		pollIntervalMs: int(pick('POLL_INTERVAL_MS', 'pollIntervalMs', DEFAULTS.pollIntervalMs), 'POLL_INTERVAL_MS', 1000),
		maxConcurrency: int(pick('MAX_CONCURRENCY', 'maxConcurrency', DEFAULTS.maxConcurrency), 'MAX_CONCURRENCY', 1),
		jobTimeoutMs: int(pick('JOB_TIMEOUT_MS', 'jobTimeoutMs', DEFAULTS.jobTimeoutMs), 'JOB_TIMEOUT_MS', 10_000),
		identityPath: pick('IDENTITY_PATH', 'identityPath', DEFAULTS.identityPath),
		secretKey: env.OPERATOR_SECRET_KEY || file.secretKey || null,
		label: pick('NODE_LABEL', 'label', null),
	};

	if (!/^https?:\/\//.test(cfg.platformUrl)) {
		throw new Error(`platformUrl must be an absolute http(s) URL, got: ${cfg.platformUrl}`);
	}
	if (!Number.isInteger(cfg.maxConcurrency) || cfg.maxConcurrency < 1) {
		throw new Error('maxConcurrency must be a positive integer');
	}
	return cfg;
}

function int(value, name, min) {
	const n = Number(value);
	if (!Number.isFinite(n) || !Number.isInteger(n) || n < min) {
		throw new Error(`${name} must be an integer >= ${min}, got: ${value}`);
	}
	return n;
}
