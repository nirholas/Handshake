/**
 * Agent vision for 3D (api/_lib/3d-vision.js + api/3d/look.js).
 *
 * The point of this surface is that an agent can SEE a model instead of
 * holding a link to it, so what is pinned here is the contract that makes that
 * usable: a sane default turntable, honest partial results, and bounds that
 * stop one caller from parking the shared headless browser.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';

process.env.PUBLIC_APP_ORIGIN = 'https://three.ws';

const render = vi.hoisted(() => ({ calls: [], impl: null }));
vi.mock('../api/_lib/avatar-render.js', () => ({
	SCENE_PRESETS: { 'full-body': { id: 'full-body' }, 'upper-body': { id: 'upper-body' } },
	renderAvatarScene: async (args) => {
		render.calls.push(args);
		if (render.impl) return render.impl(args);
		return { png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]) };
	},
}));
vi.mock('../api/_lib/ssrf-guard.js', () => ({
	assertSafePublicUrl: async (u) => {
		if (String(u).includes('private')) throw Object.assign(new Error('blocked'), { code: 'invalid_url' });
	},
	SsrfBlockedError: class extends Error {},
}));
vi.mock('../api/_lib/image-persist.js', () => ({
	persistImageBytes: async (b) => `https://cdn.test/${b.length}-${Math.min(...b)}.png`,
	looksLikeImageBytes: () => true,
}));
vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: { renderIp: vi.fn(async () => ({ success: true, reset: Date.now() + 1000 })) },
	clientIp: () => '203.0.113.1',
}));

const vision = await import('../api/_lib/3d-vision.js');
const { default: handler } = await import('../api/3d/look.js');

beforeEach(() => {
	render.calls.length = 0;
	render.impl = null;
	globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ stats: { triangles: 12400, materials: 2 } }), { status: 200, headers: { 'content-type': 'application/json' } }));
});

function makeRes() {
	return {
		statusCode: 200, headers: {}, body: null,
		setHeader(n, v) { this.headers[String(n).toLowerCase()] = v; },
		end(b) { this.body = b ?? null; },
	};
}
function makeReq({ method = 'POST', url = '/api/3d/look', body = null } = {}) {
	const payload = body == null ? '' : JSON.stringify(body);
	const req = Readable.from(payload ? [Buffer.from(payload)] : []);
	req.method = method; req.url = url; req.query = {};
	req.headers = { 'content-type': 'application/json', host: 'three.ws', 'x-forwarded-proto': 'https' };
	return req;
}
const post = async (body) => { const res = makeRes(); await handler(makeReq({ body }), res); return res; };

describe('the default turntable is the smallest set that answers "is this good"', () => {
	it('renders three-quarter, front, side and back when the caller says nothing', async () => {
		const out = await vision.renderTurntable({ glbUrl: 'https://cdn.test/a.glb' });
		expect(out.frames.map((f) => f.view)).toEqual(['three-quarter', 'front', 'side', 'back']);
	});

	it('frames the whole bounding box, never a humanoid crop that would cut a prop in half', async () => {
		await vision.renderTurntable({ glbUrl: 'https://cdn.test/a.glb', views: ['front'] });
		expect(render.calls[0].scenePreset.id).toBe('full-body');
	});

	it('renders one frame at a time: the shared browser dies if four pages are opened at once', async () => {
		let concurrent = 0;
		let peak = 0;
		render.impl = async () => {
			peak = Math.max(peak, ++concurrent);
			await new Promise((r) => setTimeout(r, 5));
			concurrent--;
			return { png: Buffer.from([0x89, 0x50, 0x4e, 0x47]) };
		};
		await vision.renderTurntable({ glbUrl: 'https://cdn.test/a.glb' });
		expect(peak).toBe(1);
	});
});

describe('a caller cannot park the renderer', () => {
	it('drops unknown angles instead of failing, and collapses duplicates', () => {
		expect(vision.normalizeViews(['left', 'FRONT', 'front', 'side'])).toEqual(['front', 'side']);
	});

	it('falls back to the default set rather than rendering nothing', () => {
		expect(vision.normalizeViews([])).toEqual([...vision.DEFAULT_VIEWS]);
		expect(vision.normalizeViews(['nope'])).toEqual([...vision.DEFAULT_VIEWS]);
	});

	it('caps the view count and the frame size', () => {
		expect(vision.normalizeViews(Object.keys(vision.VIEW_ANGLES)).length).toBeLessThanOrEqual(vision.MAX_VIEWS);
		expect(vision.normalizeSize(99_999)).toBe(vision.MAX_SIZE);
		expect(vision.normalizeSize(1)).toBe(vision.MIN_SIZE);
		expect(vision.normalizeSize('nonsense')).toBe(vision.DEFAULT_SIZE);
	});

	it('refuses a URL the SSRF guard rejects, before any render runs', async () => {
		await expect(vision.renderTurntable({ glbUrl: 'https://private.internal/a.glb' })).rejects.toThrow();
		expect(render.calls).toHaveLength(0);
	});
});

describe('partial results are reported, not hidden', () => {
	it('keeps the frames that rendered and names the angles that did not', async () => {
		render.impl = async ({ cameraOrbit }) => {
			if (cameraOrbit.theta === 180) throw new Error('gpu hiccup');
			return { png: Buffer.from([0x89, 0x50, 0x4e, 0x47]) };
		};
		const out = await vision.renderTurntable({ glbUrl: 'https://cdn.test/a.glb' });
		expect(out.frames).toHaveLength(3);
		expect(out.failed).toEqual([{ view: 'back', error: 'gpu hiccup' }]);
	});

	it('fails loudly only when nothing at all could be drawn', async () => {
		render.impl = async () => { throw new Error('not a glb'); };
		await expect(vision.renderTurntable({ glbUrl: 'https://cdn.test/a.glb' })).rejects.toThrow(/could not render/);
	});
});

describe('the geometry reading turns numbers into judgement', () => {
	it('bands the triangle count into advice a caller can act on', () => {
		expect(vision.describeGeometry({ triangles: 900 })[0]).toMatch(/very light/);
		expect(vision.describeGeometry({ triangles: 12_000 })[0]).toMatch(/normal real-time budget/);
		expect(vision.describeGeometry({ triangles: 500_000 })[0]).toMatch(/render or print asset/);
	});

	it('says nothing it cannot measure', () => {
		expect(vision.describeGeometry(null)).toEqual([]);
		expect(vision.describeGeometry({})).toEqual([]);
	});
});

describe('POST /api/3d/look', () => {
	it('answers with a frame URL per angle, the stats and the reading', async () => {
		const res = await post({ glb_url: 'https://cdn.test/robot.glb' });
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.body);
		expect(body.views).toHaveLength(4);
		expect(body.views[0].image_url).toMatch(/^https:\/\/cdn\.test\//);
		expect(body.stats.triangles).toBe(12400);
		expect(body.notes[0]).toMatch(/triangles/);
		expect(body.viewer_url).toContain('/viewer?src=');
		expect(body.ar_url).toContain('/api/ar?src=');
	});

	it('rejects a non-https model URL without touching the renderer', async () => {
		const res = await post({ glb_url: 'http://cdn.test/robot.glb' });
		expect(res.statusCode).toBe(400);
		expect(JSON.parse(res.body).error).toBe('invalid_url');
		expect(render.calls).toHaveLength(0);
	});

	it('still returns frames when the inspector is down: the pictures are the irreplaceable part', async () => {
		globalThis.fetch = vi.fn(async () => new Response('nope', { status: 503 }));
		const res = await post({ glb_url: 'https://cdn.test/robot.glb' });
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.body);
		expect(body.views.length).toBeGreaterThan(0);
		expect(body.stats).toBeUndefined();
	});

	it('answers 422 when the model itself cannot be drawn', async () => {
		render.impl = async () => { throw new Error('corrupt glb'); };
		const res = await post({ glb_url: 'https://cdn.test/broken.glb' });
		expect(res.statusCode).toBe(422);
		expect(JSON.parse(res.body).error).toBe('render_failed');
	});

	it('serves a discovery doc on GET so an agent can learn the angles', async () => {
		const res = makeRes();
		await handler(makeReq({ method: 'GET', body: null }), res);
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.body);
		expect(body.free).toBe(true);
		expect(Object.keys(body.views)).toContain('three-quarter');
		expect(body.mcp_equivalent.tool).toBe('look_at_model');
	});
});
