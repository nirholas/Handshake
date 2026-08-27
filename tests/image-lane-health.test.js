/**
 * imageLaneHealth (api/_lib/ai-image-lanes.js) must report what a lane will
 * actually DO, not what it is configured to do.
 *
 * On 2026-08-27 the Vertex probe reported `ok` while every real Vertex call
 * 403'd: the project was in billing dunning, which still hands out access
 * tokens, and the probe only minted one. Text-to-3D had no working image lane
 * for hours while health read green.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.GOOGLE_CLOUD_PROJECT = 'test-project';
delete process.env.NVIDIA_API_KEY;
delete process.env.REPLICATE_API_TOKEN;
delete process.env.HF_TOKEN;

vi.mock('../api/_lib/gcp-auth.js', () => ({
	getGcpAccessToken: async () => 'token',
	gcpAuthConfigured: () => true,
}));
vi.mock('../api/_lib/provider-health.js', () => ({
	providersInCooldown: async () => new Set(),
	markProviderCooldown: async () => {},
}));

const vertex = { respond: null };
globalThis.fetch = vi.fn(async (url) => {
	const u = String(url);
	if (u.includes('aiplatform.googleapis.com')) return vertex.respond();
	if (u.includes('pollinations')) return new Response(null, { status: 200 });
	throw new Error(`unexpected fetch ${u}`);
});

const { imageLaneHealth } = await import('../api/_lib/ai-image-lanes.js');

beforeEach(() => {
	vertex.respond = () => new Response('{}', { status: 200 });
});

describe('vertex probe reports real serving ability', () => {
	it('is ok when the API answers, not merely when a token mints', async () => {
		const h = await imageLaneHealth();
		expect(h.lanes.vertex.status).toBe('ok');
		expect(globalThis.fetch).toHaveBeenCalled();
	});

	it('is down, and names the billing hold, when the project is in dunning', async () => {
		vertex.respond = () =>
			new Response(JSON.stringify({ error: { message: 'Lightning dunning decision is deny for project: projects/93741856042' } }), { status: 403 });
		const h = await imageLaneHealth();
		expect(h.lanes.vertex.status).toBe('down');
		expect(h.lanes.vertex.httpStatus).toBe(403);
		// The message reads like an IAM problem; say what it actually is.
		expect(h.lanes.vertex.detail).toMatch(/billing/i);
	});

	it('is down on any other API refusal, carrying the status', async () => {
		vertex.respond = () => new Response('quota exhausted', { status: 429 });
		const h = await imageLaneHealth();
		expect(h.lanes.vertex.status).toBe('down');
		expect(h.lanes.vertex.httpStatus).toBe(429);
	});

	it('still reports the surface configured through the keyless rung, and names the absent keyed lanes', async () => {
		vertex.respond = () => new Response('denied', { status: 403 });
		const h = await imageLaneHealth();
		expect(h.configured).toBe(true);
		expect(h.lanes.pollinations.status).toBe('ok');
		expect(h.missing_env).toContain('NVIDIA_API_KEY');
		expect(h.missing_env).toContain('HF_TOKEN');
	});
});
