// GET /api/render/animate: the animated-avatar image endpoint.
//
// The render itself is covered by packages/render/tests; what matters here is
// the public contract around it: a discoverable catalog, an honest error for an
// unknown clip, and a clip name that can never escape the motion library into
// the filesystem.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const getAvatar = vi.fn();
const renderGlbToApngCpu = vi.fn();

vi.mock('../../api/_lib/avatars.js', () => ({
	getAvatar: (...args) => getAvatar(...args),
}));

vi.mock('../../api/_lib/render-cpu.js', () => ({
	renderGlbToApngCpu: (...args) => renderGlbToApngCpu(...args),
	renderGlbToPngCpu: vi.fn(),
	isUnsupportedModelError: () => false,
	clearModelCache: () => {},
}));

vi.mock('../../api/_lib/rate-limit.js', () => ({
	clientIp: () => '203.0.113.7',
	limits: { renderIp: async () => ({ success: true, limit: 60, remaining: 59, reset: Date.now() + 1000 }) },
}));

function makeRes() {
	const res = {
		statusCode: 0,
		headers: {},
		body: null,
		setHeader(k, v) {
			this.headers[k.toLowerCase()] = v;
		},
		getHeader(k) {
			return this.headers[k.toLowerCase()];
		},
		removeHeader(k) {
			delete this.headers[k.toLowerCase()];
		},
		writeHead(status, headers) {
			this.statusCode = status;
			Object.assign(this.headers, headers || {});
			return this;
		},
		end(body) {
			if (body !== undefined) this.body = body;
			this.ended = true;
			return this;
		},
		on() {},
	};
	return res;
}

async function call(url) {
	const { default: handler } = await import('../../api/render/animate.js');
	const req = { method: 'GET', url, headers: { host: 'three.ws' }, on() {} };
	const res = makeRes();
	await handler(req, res);
	return res;
}

const json = (res) => JSON.parse(typeof res.body === 'string' ? res.body : res.body.toString('utf8'));

beforeEach(() => {
	getAvatar.mockReset();
	renderGlbToApngCpu.mockReset();
	renderGlbToApngCpu.mockResolvedValue(Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
});

describe('catalog', () => {
	it('lists the built-in motion library when asked for nothing', async () => {
		const res = await call('/api/render/animate');
		expect(res.statusCode).toBe(200);
		const body = json(res);
		expect(body.clips.length).toBeGreaterThan(20);
		expect(body.clips.map((c) => c.name)).toContain('idle');
		expect(body.usage).toContain('/api/render/animate');
		expect(res.getHeader('cache-control')).toContain('max-age');
	});
});

describe('clip resolution', () => {
	it('refuses a clip the library does not have', async () => {
		const res = await call('/api/render/animate?clip=definitely-not-a-clip');
		expect(res.statusCode).toBe(400);
		const body = json(res);
		expect(body.error).toBe('unknown_clip');
		expect(body.clips).toContain('idle');
		expect(renderGlbToApngCpu).not.toHaveBeenCalled();
	});

	it('cannot be walked out of the motion library', async () => {
		for (const attempt of ['../../../etc/passwd', '..%2f..%2fpackage', '/etc/hosts', 'idle/../../secret']) {
			const res = await call(`/api/render/animate?clip=${encodeURIComponent(attempt)}`);
			expect(res.statusCode, attempt).toBe(400);
			expect(json(res).error, attempt).toBe('unknown_clip');
		}
		expect(renderGlbToApngCpu).not.toHaveBeenCalled();
	});
});

describe('rendering', () => {
	it('renders the default model with no target named', async () => {
		const res = await call('/api/render/animate?clip=idle');
		expect(res.statusCode).toBe(200);
		expect(res.getHeader('content-type')).toBe('image/png');
		expect(res.getHeader('x-render-lane')).toBe('cpu');
		const args = renderGlbToApngCpu.mock.calls[0][0];
		expect(args.glbUrl).toBe('https://three.ws/avatars/default.glb');
		expect(args.clipJson.tracks.length).toBeGreaterThan(0);
	});

	it('clamps frame count, fps and size to the documented ranges', async () => {
		await call('/api/render/animate?clip=idle&frames=9999&fps=1000&size=99999');
		const args = renderGlbToApngCpu.mock.calls[0][0];
		expect(args.frames).toBe(48);
		expect(args.fps).toBe(30);
		expect(args.width).toBe(640);
		expect(args.height).toBe(640);
	});

	it('renders a public avatar by id', async () => {
		getAvatar.mockResolvedValue({ id: 'abc', name: 'Vern', model_url: 'https://three.ws/cdn/a.glb' });
		const res = await call('/api/render/animate?avatar=abc&clip=idle');
		expect(res.statusCode).toBe(200);
		expect(renderGlbToApngCpu.mock.calls[0][0].glbUrl).toBe('https://three.ws/cdn/a.glb');
	});

	it('will not render a private avatar', async () => {
		getAvatar.mockResolvedValue({ id: 'abc', name: 'Private', model_url: null });
		const res = await call('/api/render/animate?avatar=abc&clip=idle');
		expect(res.statusCode).toBe(404);
		expect(renderGlbToApngCpu).not.toHaveBeenCalled();
	});

	it('404s an avatar that does not exist', async () => {
		getAvatar.mockResolvedValue(null);
		const res = await call('/api/render/animate?avatar=missing&clip=idle');
		expect(res.statusCode).toBe(404);
	});

	it('refuses a src pointed at a private address', async () => {
		const res = await call('/api/render/animate?clip=idle&src=http://169.254.169.254/latest/meta-data/');
		expect(res.statusCode).toBe(400);
		expect(json(res).error).toBe('invalid_src');
		expect(renderGlbToApngCpu).not.toHaveBeenCalled();
	});

	it('reports a render failure as a 502 rather than a broken image', async () => {
		renderGlbToApngCpu.mockRejectedValue(new Error('not a GLB'));
		const res = await call('/api/render/animate?clip=idle');
		expect(res.statusCode).toBe(502);
		expect(json(res).error).toBe('render_failed');
	});
});
