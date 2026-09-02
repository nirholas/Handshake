// Read environment values off a Cloud Run service, following Secret Manager
// references.
//
// Production's authoritative env lives on the `three-ws-api` service, and a pile
// of operator scripts reach for it when `.env` has no copy (`vercel env pull`
// returns empty for secret-type vars, so it is never a substitute). Those scripts
// all read `env[].value`, which stopped carrying credentials on 2026-09-02 when
// every credential-bearing var moved into Secret Manager
// (scripts/migrate-plaintext-secrets.mjs): `describe` now returns a
// `valueFrom.secretKeyRef` in its place, and a `.value` read silently yields
// undefined. This module resolves both shapes so one helper serves both eras.
//
// Every function takes its gcloud callers as arguments so a test can drive them
// without a network or an authenticated session.

import { execFileSync } from 'node:child_process';
import './gcloud-path.mjs';

export const DEFAULT_SERVICE = 'three-ws-api';
export const DEFAULT_REGION = 'us-central1';
export const DEFAULT_PROJECT = 'aerial-vehicle-466722-p5';

export function describeService({
	service = DEFAULT_SERVICE,
	region = DEFAULT_REGION,
	project = DEFAULT_PROJECT,
} = {}) {
	return execFileSync(
		'gcloud',
		['run', 'services', 'describe', service, `--region=${region}`, `--project=${project}`, '--format=json'],
		{ encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] },
	);
}

export function accessSecretVersion(secretName, version = 'latest', { project = DEFAULT_PROJECT } = {}) {
	return execFileSync(
		'gcloud',
		['secrets', 'versions', 'access', version, `--secret=${secretName}`, `--project=${project}`],
		{ encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] },
	);
}

/** Every env entry on the service, in declaration order. */
export function serviceEnvEntries(opts = {}) {
	const describe = opts.describe || describeService;
	const svc = JSON.parse(describe(opts));
	return svc?.spec?.template?.spec?.containers?.[0]?.env || [];
}

/**
 * The value of one env var, whether it is stored as a literal or as a Secret
 * Manager reference. Returns null when the service does not carry the name, or
 * when the reference cannot be read (which usually means the caller is missing
 * `roles/secretmanager.secretAccessor` on that one secret).
 *
 * The payload is returned byte for byte, exactly what the container receives.
 * Trimming here would hand a caller a value production never uses.
 */
export function serviceEnvValue(name, opts = {}) {
	const access = opts.accessVersion || accessSecretVersion;
	const entry = serviceEnvEntries(opts).find((e) => e.name === name);
	if (!entry) return null;
	if (entry.value !== undefined && entry.value !== '') return entry.value;
	const ref = entry.valueFrom?.secretKeyRef;
	if (!ref?.name) return null;
	try {
		return access(ref.name, ref.key || 'latest', opts) || null;
	} catch {
		return null;
	}
}

/**
 * Same, but throws with the places to look instead of returning null, for the
 * scripts that cannot do anything useful without the value.
 */
export function requireServiceEnvValue(name, opts = {}) {
	const value = serviceEnvValue(name, opts);
	if (value) return value;
	throw new Error(
		`${name} is not readable: not in this process's env, and not resolvable off the ` +
			`${opts.service || DEFAULT_SERVICE} Cloud Run service. If it is a Secret Manager ` +
			`reference, this account needs roles/secretmanager.secretAccessor on that secret. ` +
			`Inspect with: node scripts/read-service-env.mjs '^${name}$' --names`,
	);
}
