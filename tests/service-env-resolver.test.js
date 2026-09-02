// Cover scripts/lib/service-env.mjs, the one place that knows a Cloud Run env var
// can be either a literal or a Secret Manager reference.
//
// This exists because of a specific breakage: on 2026-09-02 every credential on
// three-ws-api moved into Secret Manager, and five operator scripts that read
// `env[].value` off `gcloud run services describe` started silently getting
// undefined instead of a database URL or a cron secret. Reading only `.value` is
// the bug; every case below is one of the shapes that has to keep working.

import { describe, it, expect } from 'vitest';
import { serviceEnvValue, requireServiceEnvValue, serviceEnvEntries } from '../scripts/lib/service-env.mjs';

const service = (env) => () => JSON.stringify({ spec: { template: { spec: { containers: [{ env }] } } } });

describe('serviceEnvValue', () => {
	it('reads a plaintext literal', () => {
		expect(serviceEnvValue('PUBLIC_APP_ORIGIN', { describe: service([{ name: 'PUBLIC_APP_ORIGIN', value: 'https://three.ws' }]) })).toBe(
			'https://three.ws',
		);
	});

	it('follows a secret reference to the version the container reads', () => {
		const seen = [];
		const value = serviceEnvValue('DATABASE_URL', {
			describe: service([{ name: 'DATABASE_URL', valueFrom: { secretKeyRef: { name: 'DATABASE_URL', key: 'latest' } } }]),
			accessVersion: (secret, version) => {
				seen.push([secret, version]);
				return 'postgres://real';
			},
		});
		expect(value).toBe('postgres://real');
		expect(seen).toEqual([['DATABASE_URL', 'latest']]);
	});

	it('pins to the exact version the service references, not always latest', () => {
		const seen = [];
		serviceEnvValue('JWT_SECRET', {
			describe: service([{ name: 'JWT_SECRET', valueFrom: { secretKeyRef: { name: 'jwt-secret', key: '7' } } }]),
			accessVersion: (secret, version) => {
				seen.push(version);
				return 'v7';
			},
		});
		expect(seen).toEqual(['7']);
	});

	it('returns the payload untrimmed, byte for byte with what the container gets', () => {
		expect(
			serviceEnvValue('CRON_SECRET', {
				describe: service([{ name: 'CRON_SECRET', valueFrom: { secretKeyRef: { name: 'cron-secret', key: 'latest' } } }]),
				accessVersion: () => ' padded \n',
			}),
		).toBe(' padded \n');
	});

	it('returns null for a name the service does not carry', () => {
		expect(serviceEnvValue('NOPE', { describe: service([{ name: 'OTHER', value: 'x' }]) })).toBe(null);
	});

	it('returns null rather than throwing when the secret version is unreadable', () => {
		expect(
			serviceEnvValue('DATABASE_URL', {
				describe: service([{ name: 'DATABASE_URL', valueFrom: { secretKeyRef: { name: 'DATABASE_URL', key: 'latest' } } }]),
				accessVersion: () => {
					throw new Error('PERMISSION_DENIED');
				},
			}),
		).toBe(null);
	});

	// An empty literal is what a half-migrated var looks like. Treating it as the
	// value hands a caller a blank credential, which fails far from here.
	it('does not accept an empty literal as the value', () => {
		expect(serviceEnvValue('CRON_SECRET', { describe: service([{ name: 'CRON_SECRET', value: '' }]) })).toBe(null);
	});

	it('returns null for a reference with no secret name', () => {
		expect(
			serviceEnvValue('CRON_SECRET', { describe: service([{ name: 'CRON_SECRET', valueFrom: { secretKeyRef: { key: 'latest' } } }]) }),
		).toBe(null);
	});
});

describe('requireServiceEnvValue', () => {
	it('returns the value when one resolves', () => {
		expect(requireServiceEnvValue('X', { describe: service([{ name: 'X', value: 'y' }]) })).toBe('y');
	});

	it('names the permission and the command to inspect when it cannot resolve', () => {
		expect(() => requireServiceEnvValue('DATABASE_URL', { describe: service([]) })).toThrow(
			/secretmanager.secretAccessor[\s\S]*read-service-env/,
		);
	});
});

describe('serviceEnvEntries', () => {
	it('tolerates a service with no env block at all', () => {
		expect(serviceEnvEntries({ describe: () => JSON.stringify({ spec: { template: { spec: { containers: [{}] } } } }) })).toEqual([]);
	});
});
