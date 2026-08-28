// The render dispatcher: CPU first, chromium as failover.
//
// Every server-side avatar picture on the platform goes through
// renderGlbToPng: OG cards, avatar thumbnails, forge thumbnails, the batch
// cron, /api/render/glb. As of the software rasterizer landing, that function
// is a dispatcher rather than a chromium call, so these tests hold the two
// properties every one of those callers depends on: the fast lane is actually
// taken, and a model it cannot decode still comes back as a picture.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const CPU_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x63, 0x70, 0x75]);
const BROWSER_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x62, 0x72]);

const renderGlbToPngCpu = vi.fn();

vi.mock('../../api/_lib/render-cpu.js', () => ({
	renderGlbToPngCpu: (...args) => renderGlbToPngCpu(...args),
	renderGlbToApngCpu: vi.fn(),
	isUnsupportedModelError: () => false,
	clearModelCache: () => {},
}));

vi.mock('../../api/_lib/fetch-model.js', () => ({
	fetchModel: vi.fn(async () => ({ bytes: new Uint8Array([1, 2, 3]) })),
}));

/** A puppeteer stand-in whose pages always screenshot successfully. */
function fakeBrowser() {
	return {
		connected: true,
		on() {},
		async newPage() {
			return {
				async setViewport() {},
				async setContent() {},
				async waitForFunction() {},
				async evaluate() {
					return null;
				},
				async screenshot() {
					return BROWSER_PNG;
				},
				async close() {},
			};
		},
	};
}

beforeEach(() => {
	renderGlbToPngCpu.mockReset();
	delete process.env.RENDER_CPU_LANE;
});

afterEach(async () => {
	const { __setBrowserForTests } = await import('../../api/_lib/render-glb.js');
	__setBrowserForTests(null);
	vi.restoreAllMocks();
});

describe('renderGlbToPng dispatcher', () => {
	it('validates arguments before touching either lane', async () => {
		const { renderGlbToPng } = await import('../../api/_lib/render-glb.js');
		await expect(renderGlbToPng({})).rejects.toThrow(/glbUrl required/);
		await expect(renderGlbToPng({ glbUrl: 42 })).rejects.toThrow(/glbUrl required/);
		expect(renderGlbToPngCpu).not.toHaveBeenCalled();
	});

	it('takes the CPU lane and never boots a browser', async () => {
		renderGlbToPngCpu.mockResolvedValue(CPU_PNG);
		const { renderGlbToPng, __setBrowserForTests } = await import('../../api/_lib/render-glb.js');
		// No browser is registered: if the dispatcher reached chromium at all,
		// the launcher would run and this test would not return a PNG.
		__setBrowserForTests(null);
		const png = await renderGlbToPng({ glbUrl: 'https://example.com/a.glb', width: 200, height: 100 });
		expect(png).toBe(CPU_PNG);
		expect(renderGlbToPngCpu).toHaveBeenCalledWith(
			expect.objectContaining({ glbUrl: 'https://example.com/a.glb', width: 200, height: 100 }),
		);
	});

	it('falls back to chromium when the CPU lane cannot decode the model', async () => {
		renderGlbToPngCpu.mockRejectedValue(new Error('KHR_draco_mesh_compression needs an external decoder'));
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const { renderGlbToPng, __setBrowserForTests } = await import('../../api/_lib/render-glb.js');
		__setBrowserForTests(fakeBrowser());
		const png = await renderGlbToPng({ glbUrl: 'https://example.com/draco.glb' });
		expect(png).toBe(BROWSER_PNG);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('cpu lane fell back'), expect.anything());
	});

	it('falls back when the CPU lane returns nothing usable', async () => {
		renderGlbToPngCpu.mockResolvedValue(Buffer.alloc(0));
		const { renderGlbToPng, __setBrowserForTests } = await import('../../api/_lib/render-glb.js');
		__setBrowserForTests(fakeBrowser());
		expect(await renderGlbToPng({ glbUrl: 'https://example.com/empty.glb' })).toBe(BROWSER_PNG);
	});

	it('can be pinned back onto chromium without a deploy', async () => {
		process.env.RENDER_CPU_LANE = 'off';
		renderGlbToPngCpu.mockResolvedValue(CPU_PNG);
		const { renderGlbToPng, __setBrowserForTests } = await import('../../api/_lib/render-glb.js');
		__setBrowserForTests(fakeBrowser());
		expect(await renderGlbToPng({ glbUrl: 'https://example.com/a.glb' })).toBe(BROWSER_PNG);
		expect(renderGlbToPngCpu).not.toHaveBeenCalled();
	});
});
