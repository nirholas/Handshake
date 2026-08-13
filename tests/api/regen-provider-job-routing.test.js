// getRegenProviderForJob has to resolve the adapter for the provider a job was
// SUBMITTED to. The regenerate-status endpoint (the poll a /scan capture rides
// from submission to a stored rigged GLB) calls it with `job.provider` straight
// off the row, then hands the row's `ext_job_id` to whatever comes back.
//
// That id is provider-shaped: the gcp adapter packs a base64url envelope
// carrying the worker base URL and its task id, Replicate stores a bare
// prediction id. Resolve the wrong adapter and the poll asks the wrong backend
// about an id it has never issued, so a capture that is generating perfectly
// well reports a failure from a service that never ran it.
//
// The regression this pins is a configuration change, not a code change: with
// only GCP_RECONSTRUCTION_URL set, the primary and the job provider are the
// same and nothing looks wrong. Add REPLICATE_API_TOKEN (it outranks gcp in the
// platform precedence order) and every gcp job in flight starts being polled as
// a Replicate prediction.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const gcpInstance = { kind: 'gcp', supportsMode: () => true, submit: async () => ({}), status: async () => ({}) };
const replicateInstance = { kind: 'replicate', supportsMode: () => true, submit: async () => ({}), status: async () => ({}) };
const hfInstance = { kind: 'huggingface', supportsMode: () => true, submit: async () => ({}), status: async () => ({}) };

vi.mock('../../api/_providers/gcp.js', () => ({ createRegenProvider: () => gcpInstance }));
vi.mock('../../api/_providers/replicate.js', () => ({ createRegenProvider: () => replicateInstance }));
vi.mock('../../api/_providers/huggingface.js', () => ({ createRegenProvider: () => hfInstance }));

const ENV_KEYS = [
	'AVATAR_REGEN_PROVIDER',
	'REPLICATE_API_TOKEN',
	'GCP_RECONSTRUCTION_URL',
	'GCP_RECONSTRUCTION_KEY',
	'HF_TOKEN',
];
const saved = {};

beforeEach(() => {
	for (const k of ENV_KEYS) {
		saved[k] = process.env[k];
		delete process.env[k];
	}
	vi.resetModules();
});

afterEach(() => {
	for (const k of ENV_KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
});

async function load() {
	return import('../../api/_lib/regen-provider.js');
}

describe('getRegenProviderForJob: platform jobs poll their own provider', () => {
	it('resolves gcp for a gcp job even when Replicate outranks it as primary', async () => {
		process.env.GCP_RECONSTRUCTION_URL = 'https://avatar-reconstruction.example.run.app';
		process.env.GCP_RECONSTRUCTION_KEY = 'k';
		process.env.REPLICATE_API_TOKEN = 'r';

		const { getRegenProviderForJob, resolveProviderName } = await load();
		// Precondition: the primary really is the other provider, so a
		// primary-based resolution would be observably wrong.
		expect(resolveProviderName()).toBe('replicate');

		const resolved = await getRegenProviderForJob('gcp', {});
		expect(resolved.name).toBe('gcp');
		expect(resolved.instance).toBe(gcpInstance);
	});

	it('resolves replicate for a replicate job when gcp is the only other credential', async () => {
		process.env.GCP_RECONSTRUCTION_URL = 'https://avatar-reconstruction.example.run.app';
		process.env.GCP_RECONSTRUCTION_KEY = 'k';
		process.env.REPLICATE_API_TOKEN = 'r';
		process.env.AVATAR_REGEN_PROVIDER = 'gcp';

		const { getRegenProviderForJob } = await load();
		const resolved = await getRegenProviderForJob('replicate', {});
		expect(resolved.name).toBe('replicate');
		expect(resolved.instance).toBe(replicateInstance);
	});

	it('canonicalizes the legacy "hf" job provider to huggingface', async () => {
		process.env.HF_TOKEN = 'h';

		const { getRegenProviderForJob } = await load();
		const resolved = await getRegenProviderForJob('hf', {});
		expect(resolved.name).toBe('huggingface');
		expect(resolved.instance).toBe(hfInstance);
	});

	it('returns no instance when the job provider lost its credentials', async () => {
		// gcp job, but only Replicate is credentialed now. Polling it as a
		// Replicate prediction is worse than not polling: the status endpoint
		// leaves the row alone and reconstruct-sweep ages it out with a reason
		// that names the real provider.
		process.env.REPLICATE_API_TOKEN = 'r';

		const { getRegenProviderForJob } = await load();
		const resolved = await getRegenProviderForJob('gcp', {});
		expect(resolved.name).toBe('gcp');
		expect(resolved.instance).toBeNull();
	});

	it('returns no instance for an unknown provider name', async () => {
		process.env.GCP_RECONSTRUCTION_URL = 'https://avatar-reconstruction.example.run.app';
		process.env.GCP_RECONSTRUCTION_KEY = 'k';

		const { getRegenProviderForJob } = await load();
		const resolved = await getRegenProviderForJob('some-retired-vendor', {});
		expect(resolved.instance).toBeNull();
	});
});
