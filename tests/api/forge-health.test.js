// /api/forge?health — the live backend probe behind the catalog.
//
// The catalog's `configured` flag only proves an env var exists; two prod
// outages (a Replicate account throttle, a misrouted Hunyuan3D worker) hid
// behind it. These tests pin the probe's verdict for each upstream response
// so the health surface can never drift back to "green because env-present".

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { probeForgeHealth, resetForgeHealthCache } from '../../api/_lib/forge-health.js';
import { BACKENDS } from '../../api/_lib/forge-tiers.js';

const ENV_VARS = [
	'NVIDIA_API_KEY',
	'HF_TOKEN',
	'REPLICATE_API_TOKEN',
	'GCP_HUNYUAN3D_URL',
	'GCP_TRIPOSG_URL',
	'GCP_RECONSTRUCTION_URL',
	'GCP_RECONSTRUCTION_KEY',
	'UPSTASH_REDIS_REST_URL',
	'UPSTASH_REDIS_REST_TOKEN',
	'three_KV_REST_API_URL',
	'three_KV_REST_API_TOKEN',
	'KV_REST_API_URL',
	'KV_REST_API_TOKEN',
	// The host shell can leak a real OpenAI key into the suite (workspaces and
	// CI both carry one); the health probe treats any present key as a
	// configured backend and would probe api.openai.com, breaking the
	// nothing-configured assertions. Scrub it with the rest.
	'OPENAI_API_KEY',
	'VERCEL_ENV',
];
const savedEnv = {};
let savedFetch;

// One mock upstream per probe URL; anything unrouted fails the test loudly.
// world.three.ws is probed unconditionally (no credential gates it), so it is
// always routed healthy here — per-backend tests stay focused on their upstream.
function mockUpstreams(routes) {
	global.fetch = vi.fn(async (url) => {
		if (String(url).includes('world.three.ws')) {
			return new Response(JSON.stringify({ protected: true, blueprints: [] }), { status: 200 });
		}
		for (const [match, status] of routes) {
			if (String(url).includes(match)) return new Response('{}', { status });
		}
		throw new Error(`unrouted probe fetch: ${url}`);
	});
}

// The world is the only always-on probe; these helpers assert that no
// credentialed *backend* upstream was hit when nothing is configured.
const backendProbes = () =>
	global.fetch.mock.calls.map((c) => String(c[0])).filter((u) => !u.includes('world.three.ws'));

beforeEach(() => {
	for (const v of ENV_VARS) {
		savedEnv[v] = process.env[v];
		delete process.env[v];
	}
	savedFetch = global.fetch;
	resetForgeHealthCache();
});

afterEach(() => {
	for (const v of ENV_VARS) {
		if (savedEnv[v] === undefined) delete process.env[v];
		else process.env[v] = savedEnv[v];
	}
	global.fetch = savedFetch;
	resetForgeHealthCache();
});

describe('forge-health — per-backend verdicts', () => {
	it('reports every backend in the registry, with BYOK lanes marked byok', async () => {
		mockUpstreams([]);
		const health = await probeForgeHealth();
		// Coverage is derived from the registry so a newly added backend can never
		// be silently absent from the health report.
		expect(Object.keys(health.backends).sort()).toEqual(Object.keys(BACKENDS).sort());
		expect(health.backends.meshy.status).toBe('byok');
		expect(health.backends.tripo.status).toBe('byok');
		// No platform env at all → no credentialed backend probe fired.
		expect(backendProbes()).toEqual([]);
	});

	it('marks unset platform lanes unconfigured', async () => {
		mockUpstreams([]);
		const health = await probeForgeHealth();
		expect(health.backends.nvidia.status).toBe('unconfigured');
		expect(health.backends.huggingface.status).toBe('unconfigured');
		expect(health.backends.trellis.status).toBe('unconfigured');
		expect(health.backends.hunyuan3d.status).toBe('unconfigured');
	});

	it('hunyuan3d stays unconfigured on the avatar pipeline env alone', async () => {
		process.env.GCP_RECONSTRUCTION_URL = 'https://avatar-reconstruction.example.run.app';
		process.env.GCP_RECONSTRUCTION_KEY = 'secret';
		mockUpstreams([]);
		const health = await probeForgeHealth();
		expect(health.backends.hunyuan3d.status).toBe('unconfigured');
		expect(backendProbes()).toEqual([]);
	});

	it('passes Replicate when the invalid-version probe is rejected after auth (422)', async () => {
		process.env.REPLICATE_API_TOKEN = 'r8_test';
		mockUpstreams([['api.replicate.com', 422]]);
		const health = await probeForgeHealth();
		expect(health.backends.trellis.status).toBe('ok');
	});

	it('flags a throttled Replicate account as degraded (429)', async () => {
		process.env.REPLICATE_API_TOKEN = 'r8_test';
		mockUpstreams([['api.replicate.com', 429]]);
		const health = await probeForgeHealth();
		expect(health.backends.trellis.status).toBe('degraded');
		expect(health.backends.trellis.message).toMatch(/throttling/i);
		expect(health.status).toBe('degraded');
	});

	it('flags a billing failure as down (402) and a bad token as down (401)', async () => {
		process.env.REPLICATE_API_TOKEN = 'r8_test';
		mockUpstreams([['api.replicate.com', 402]]);
		expect((await probeForgeHealth()).backends.trellis.status).toBe('down');
		resetForgeHealthCache();
		mockUpstreams([['api.replicate.com', 401]]);
		expect((await probeForgeHealth()).backends.trellis.status).toBe('down');
	});

	it('passes NVIDIA when the synthetic status id 404s under a live key', async () => {
		process.env.NVIDIA_API_KEY = 'nvapi-test';
		mockUpstreams([['api.nvcf.nvidia.com', 404]]);
		const health = await probeForgeHealth();
		expect(health.backends.nvidia.status).toBe('ok');
	});

	it('fails NVIDIA when the key is rejected (401)', async () => {
		process.env.NVIDIA_API_KEY = 'nvapi-bad';
		mockUpstreams([['api.nvcf.nvidia.com', 401]]);
		const health = await probeForgeHealth();
		expect(health.backends.nvidia.status).toBe('down');
	});

	it('passes HuggingFace when whoami authenticates the token (200)', async () => {
		process.env.HF_TOKEN = 'hf_test';
		mockUpstreams([['huggingface.co', 200]]);
		const health = await probeForgeHealth();
		expect(health.backends.huggingface.status).toBe('ok');
	});

	it('fails HuggingFace on a rejected token (401) and degrades on rate-limit (429)', async () => {
		process.env.HF_TOKEN = 'hf_bad';
		mockUpstreams([['huggingface.co', 401]]);
		expect((await probeForgeHealth()).backends.huggingface.status).toBe('down');
		resetForgeHealthCache();
		mockUpstreams([['huggingface.co', 429]]);
		expect((await probeForgeHealth()).backends.huggingface.status).toBe('degraded');
	});

	it('never probes HuggingFace when HF_TOKEN is unset', async () => {
		mockUpstreams([]);
		const health = await probeForgeHealth();
		expect(health.backends.huggingface.status).toBe('unconfigured');
		expect(backendProbes()).toEqual([]);
	});

	it('probes a deployed Hunyuan3D worker and reports 5xx as down', async () => {
		process.env.GCP_HUNYUAN3D_URL = 'https://hunyuan3d.example.run.app';
		process.env.GCP_RECONSTRUCTION_KEY = 'secret';
		mockUpstreams([['hunyuan3d.example.run.app', 200]]);
		expect((await probeForgeHealth()).backends.hunyuan3d.status).toBe('ok');
		resetForgeHealthCache();
		mockUpstreams([['hunyuan3d.example.run.app', 503]]);
		expect((await probeForgeHealth()).backends.hunyuan3d.status).toBe('down');
	});

	it('marks an unreachable upstream down instead of throwing', async () => {
		process.env.REPLICATE_API_TOKEN = 'r8_test';
		global.fetch = vi.fn(async () => {
			throw new Error('network down');
		});
		const health = await probeForgeHealth();
		expect(health.backends.trellis.status).toBe('down');
	});
});

describe('forge-health — rate-limiter store', () => {
	// The June 2026 outage: Upstash over quota → critical limiters failed
	// closed → every paid-lane generation 429'd while all backends read ok.
	// These tests pin the limiter store to the health report so that failure
	// mode can never be invisible again.
	it('reports ok with the in-memory fallback outside production', async () => {
		mockUpstreams([]);
		const health = await probeForgeHealth();
		expect(health.limiter.status).toBe('ok');
		expect(health.limiter.message).toMatch(/in-memory/i);
	});

	it('reports down (and degrades overall) when unconfigured in production', async () => {
		process.env.VERCEL_ENV = 'production';
		mockUpstreams([]);
		const health = await probeForgeHealth();
		expect(health.limiter.status).toBe('down');
		expect(health.limiter.message).toMatch(/fail closed/i);
		expect(health.status).toBe('degraded');
	});

	it('passes when the store answers PING', async () => {
		process.env.UPSTASH_REDIS_REST_URL = 'https://probe.upstash.io';
		process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
		global.fetch = vi.fn(async () => new Response('{"result":"PONG"}', { status: 200 }));
		const health = await probeForgeHealth();
		expect(health.limiter.status).toBe('ok');
	});

	it('reports down when the store rejects commands (over quota)', async () => {
		process.env.UPSTASH_REDIS_REST_URL = 'https://probe.upstash.io';
		process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
		global.fetch = vi.fn(
			async () =>
				new Response('{"error":"ERR max requests limit exceeded. Limit: 500000, Usage: 500000"}', {
					status: 429,
				}),
		);
		const health = await probeForgeHealth();
		expect(health.limiter.status).toBe('down');
		expect(health.limiter.message).toMatch(/max requests limit/i);
		expect(health.status).toBe('degraded');
	});

	it('resolves the store through the three_KV fallback names', async () => {
		process.env.three_KV_REST_API_URL = 'https://fallback.upstash.io';
		process.env.three_KV_REST_API_TOKEN = 'token';
		global.fetch = vi.fn(async () => new Response('{"result":"PONG"}', { status: 200 }));
		const health = await probeForgeHealth();
		expect(health.limiter.status).toBe('ok');
		expect(global.fetch).toHaveBeenCalledWith(
			'https://fallback.upstash.io',
			expect.objectContaining({ method: 'POST' }),
		);
	});
});

describe('forge-health — world.three.ws', () => {
	const HASH = 'a'.repeat(64);
	const ASSET = `https://world.three.ws/assets/${HASH}.glb`;

	function mockWorld(statusBody, { assetStatus = 200 } = {}) {
		global.fetch = vi.fn(async (url, opts = {}) => {
			if (String(url).includes('/status')) {
				return new Response(JSON.stringify(statusBody), { status: 200 });
			}
			if (opts.method === 'HEAD') return new Response(null, { status: assetStatus });
			throw new Error(`unrouted probe fetch: ${url}`);
		});
	}

	it('reports ok when the world is protected and every asset resolves', async () => {
		mockWorld({ protected: true, blueprints: [{ id: '$scene', assetUrl: ASSET }] });
		const health = await probeForgeHealth();
		expect(health.world.status).toBe('ok');
		expect(health.world.protected).toBe(true);
		expect(health.world.blueprint_count).toBe(1);
	});

	it('reports degraded (and degrades overall) when the world is unprotected', async () => {
		mockWorld({ protected: false, blueprints: [] });
		const health = await probeForgeHealth();
		expect(health.world.status).toBe('degraded');
		expect(health.world.message).toMatch(/unprotected/i);
		expect(health.status).toBe('degraded');
	});

	it('reports down when a blueprint asset 404s — the scene would crash on join', async () => {
		mockWorld({ protected: true, blueprints: [{ id: '$scene', assetUrl: ASSET }] }, { assetStatus: 404 });
		const health = await probeForgeHealth();
		expect(health.world.status).toBe('down');
		expect(health.world.message).toMatch(/missing/i);
		// A down world degrades overall — never escalates it past 'degraded'.
		expect(health.status).toBe('degraded');
	});

	it('reports down when /status is unreachable instead of throwing', async () => {
		global.fetch = vi.fn(async () => {
			throw new Error('network down');
		});
		const health = await probeForgeHealth();
		expect(health.world.status).toBe('down');
	});
});

describe('forge-health — caching', () => {
	it('serves the cached payload within the TTL and re-probes on force', async () => {
		process.env.REPLICATE_API_TOKEN = 'r8_test';
		mockUpstreams([['api.replicate.com', 422]]);
		const first = await probeForgeHealth();
		expect(first.cached).toBe(false);
		const calls = global.fetch.mock.calls.length;
		const second = await probeForgeHealth();
		expect(second.cached).toBe(true);
		expect(global.fetch.mock.calls.length).toBe(calls);
		const third = await probeForgeHealth({ force: true });
		expect(third.cached).toBe(false);
		expect(global.fetch.mock.calls.length).toBeGreaterThan(calls);
	});
});
