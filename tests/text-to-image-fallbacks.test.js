/**
 * The concept-image ladder (api/_mcp3d/text-to-image.js) has five independent
 * rungs: Vertex, NIM FLUX.1-dev, HF-routed fal-ai, HF-routed nscale, and
 * keyless Pollinations. On 2026-08-27 the first two were both out (billing
 * hold, stalled gateway) and text-to-3D failed for hours; these pin that every
 * later rung is reached, in order, and that the keyless one is always there.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.NVIDIA_API_KEY = 'nim-key';
process.env.HF_TOKEN = 'hf-token';
delete process.env.GOOGLE_CLOUD_PROJECT;
delete process.env.REPLICATE_API_TOKEN;
delete process.env.LIVEPEER_FEDERATION_ENABLED;
delete process.env.TEXT_TO_IMAGE_BUDGET_MS;

vi.mock('../api/_lib/provider-health.js', () => ({ providersInCooldown: async () => new Set(), markProviderCooldown: async () => {} }));
vi.mock('../api/_lib/forge-scale.js', () => ({ reserveProviderRateSlot: async () => ({ ok: true, waitMs: 0 }), SCALE_LIMITS: {} }));
vi.mock('../api/_providers/livepeer.js', () => ({ livepeerFederationEnabled: () => false, livepeerTextToImage: async () => { throw new Error('unused'); } }));
const persisted = vi.hoisted(() => ({ calls: 0 }));
vi.mock('../api/_lib/image-persist.js', async (importOriginal) => {
	const real = await importOriginal();
	return { ...real, persistImageBytes: async () => { persisted.calls++; return `https://cdn.test/img-${persisted.calls}.png`; }, persistImageBase64: async () => { persisted.calls++; return `https://cdn.test/img-${persisted.calls}.png`; } };
});

const { textToImage } = await import('../api/_mcp3d/text-to-image.js');

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const bytes = (b, type) => new Response(b, { status: 200, headers: { 'content-type': type } });

// Per-test behaviour by host.
const lane = {};
const hits = [];
globalThis.fetch = vi.fn(async (url, init) => {
	const u = String(url);
	hits.push(u);
	if (u.includes('ai.api.nvidia.com')) return lane.nim(init);
	if (u.includes('router.huggingface.co/fal-ai')) return lane.fal(init);
	if (u.includes('fal.media')) return bytes(JPG, 'image/jpeg');
	if (u.includes('router.huggingface.co/nscale')) return lane.nscale(init);
	if (u.includes('image.pollinations.ai')) return lane.pollinations(init);
	throw new Error(`unexpected fetch ${u}`);
});

beforeEach(() => {
	hits.length = 0;
	persisted.calls = 0;
	lane.nim = () => json(502, { error: 'gateway' });
	lane.fal = () => json(503, {});
	lane.nscale = () => json(503, {});
	lane.pollinations = () => bytes(JPG, 'image/jpeg');
});

describe('the ladder reaches every rung in order', () => {
	it('NIM serves first when it is up', async () => {
		lane.nim = () => json(200, { artifacts: [{ base64: Buffer.from(PNG).toString('base64'), finishReason: 'SUCCESS' }] });
		const out = await textToImage('a fox', { budgetMs: 20_000 });
		expect(out.model).toBe('black-forest-labs/flux.1-dev');
		expect(hits.some((u) => u.includes('huggingface'))).toBe(false);
	});

	it('falls to HF fal-ai when NIM fails, and fetches the hosted image it returns', async () => {
		lane.fal = () => json(200, { images: [{ url: 'https://v3b.fal.media/files/x.jpg' }] });
		const out = await textToImage('a fox', { budgetMs: 20_000 });
		expect(out.model).toBe('hf/fal-ai/flux-schnell');
		expect(out.imageUrl).toMatch(/^https:\/\/cdn\.test\//);
		expect(hits.some((u) => u.includes('nscale'))).toBe(false);
	});

	it('falls to HF nscale when fal-ai fails too', async () => {
		lane.nscale = () => json(200, { data: [{ b64_json: Buffer.from(PNG).toString('base64') }] });
		const out = await textToImage('a fox', { budgetMs: 20_000 });
		expect(out.model).toBe('hf/nscale/flux-schnell');
	});

	it('ends on keyless Pollinations when every keyed rung is down', async () => {
		const out = await textToImage('a fox', { budgetMs: 20_000 });
		expect(out.model).toBe('pollinations/flux');
		expect(hits.filter((u) => u.includes('huggingface'))).toHaveLength(2);
	});

	it('sends the NIM request flux.1-dev needs (steps >= 5, a cfg_scale)', async () => {
		let body;
		lane.nim = (init) => { body = JSON.parse(init.body); return json(200, { artifacts: [{ base64: Buffer.from(PNG).toString('base64') }] }); };
		await textToImage('a fox', { budgetMs: 20_000 });
		expect(body.steps).toBeGreaterThanOrEqual(5);
		expect(body.cfg_scale).toBeGreaterThan(0);
		expect(hits[0]).toContain('flux.1-dev');
	});

	it('refuses a non-image body from a rung instead of persisting garbage', async () => {
		lane.pollinations = () => bytes(new Uint8Array([0x3c, 0x68, 0x74, 0x6d, 0x6c]), 'text/html');
		await expect(textToImage('a fox', { budgetMs: 20_000 })).rejects.toThrow(/non-image/);
		expect(persisted.calls).toBe(0);
	});
});
