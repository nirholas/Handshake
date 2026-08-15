// Boundary coverage for the two public headless-chromium renderers,
// /api/render/glb and /api/render/avatar-clip.
//
// The renderers themselves are exercised against real GLBs by hand (they need
// chromium); what is pinned here is everything a caller can reach WITHOUT
// booting a browser: method + input validation, the SSRF pre-check, the render
// page's escaping contract, and the pose catalog. The escaping cases are
// regression tests for a real defect: `background` reached the render page
// through a bare JSON.stringify, so `#000</script><script>…</script>` executed
// caller JS inside a page with container network egress.

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { scriptJson, safeCssColor } from '../../api/_lib/render-safe.js';

const GLB = 'https://three.ws/avatars/default.glb';
const INJECTION = '#000</script><script>window.__renderError="pwned"</script>';

const renderGlbToPng = vi.fn(async () => Buffer.from('89504e470d0a1a0a', 'hex'));
const renderClip = vi.fn(async () => ({ png: Buffer.from('89504e470d0a1a0a', 'hex'), pose: { id: 'wave', label: 'Wave hello' } }));

vi.mock('../../api/_lib/render-glb.js', () => ({ renderGlbToPng: (...a) => renderGlbToPng(...a) }));
vi.mock('../../api/_lib/render-clip.js', () => ({ renderClip: (...a) => renderClip(...a) }));

function makeReq(method, url, body) {
	const req = { method, url, headers: { host: 'three.ws', 'x-forwarded-for': '203.0.113.9' } };
	if (body !== undefined) {
		req.headers['content-type'] = 'application/json';
		req.body = body;
	}
	return req;
}

function makeRes() {
	return {
		statusCode: 200,
		_h: {},
		writableEnded: false,
		headersSent: false,
		setHeader(k, v) { this._h[k.toLowerCase()] = v; },
		getHeader(k) { return this._h[k.toLowerCase()]; },
		removeHeader(k) { delete this._h[k.toLowerCase()]; },
		end(body) { this._body = body; this.writableEnded = true; },
	};
}

async function callGlb(req) {
	const { default: handler } = await import('../../api/render/glb.js');
	const res = makeRes();
	await handler(req, res);
	return res;
}

async function callClip(req) {
	const { default: handler } = await import('../../api/render/avatar-clip.js');
	const res = makeRes();
	await handler(req, res);
	return res;
}

beforeEach(() => {
	renderGlbToPng.mockClear();
	renderClip.mockClear();
});

describe('render-safe escaping contract', () => {
	it('scriptJson neutralises a <script> breakout and the JS line terminators', () => {
		const out = scriptJson('a</script><script>x</script>b c d');
		expect(out).not.toContain('</script>');
		expect(out).not.toContain('<');
		expect(out).not.toContain('>');
		expect(out).not.toContain(' ');
		expect(out).not.toContain(' ');
		expect(JSON.parse(out)).toBe('a</script><script>x</script>b c d');
	});

	it('scriptJson maps undefined to null so an omitted value never emits a bare hole', () => {
		expect(scriptJson(undefined)).toBe('null');
	});

	it('safeCssColor accepts the color forms the renderers document', () => {
		for (const ok of ['#0a0a0a', '#fff', '#0a0a0aff', 'rgb(10, 10, 10)', 'rgba(1,2,3,0.5)', 'hsl(210, 30%, 17%)', 'rgb(10 10 10 / 50%)', 'midnightblue']) {
			expect(safeCssColor(ok)).toBe(ok);
		}
	});

	it('safeCssColor rejects markup, CSS breakouts, and non-strings', () => {
		for (const bad of [INJECTION, '</style><script>x', '#000;}</style><x', 'url(https://x/y)', 'expression(alert(1))', '', '   ', 42, null, undefined, {}]) {
			expect(safeCssColor(bad)).toBeNull();
		}
	});
});

describe('GET|POST /api/render/glb', () => {
	it('400s without a glbUrl instead of booting chromium', async () => {
		const res = await callGlb(makeReq('GET', '/api/render/glb'));
		expect(res.statusCode).toBe(400);
		expect(JSON.parse(res._body).error).toBe('bad_request');
		expect(renderGlbToPng).not.toHaveBeenCalled();
	});

	it('400s a private-address glbUrl on both the GET and the POST form', async () => {
		expect((await callGlb(makeReq('GET', '/api/render/glb?glbUrl=' + encodeURIComponent('https://10.0.0.8/a.glb')))).statusCode).toBe(400);
		expect((await callGlb(makeReq('POST', '/api/render/glb', { glbUrl: 'http://169.254.169.254/meta' }))).statusCode).toBe(400);
		expect(renderGlbToPng).not.toHaveBeenCalled();
	});

	it('400s a background carrying markup, so nothing injectable reaches the render page', async () => {
		const res = await callGlb(makeReq('POST', '/api/render/glb', { glbUrl: GLB, background: INJECTION }));
		expect(res.statusCode).toBe(400);
		expect(JSON.parse(res._body).error).toBe('bad_request');
		expect(renderGlbToPng).not.toHaveBeenCalled();
	});

	it('405s a method the renderer does not serve', async () => {
		const res = await callGlb(makeReq('PUT', '/api/render/glb'));
		expect(res.statusCode).toBe(405);
	});

	it('renders a PNG with the clamped dimensions echoed back', async () => {
		const res = await callGlb(makeReq('POST', '/api/render/glb', { glbUrl: GLB, width: 99999, height: 1, background: 'transparent' }));
		expect(res.statusCode).toBe(200);
		expect(res._h['content-type']).toBe('image/png');
		expect(res._h['x-render-width']).toBe('2048');
		expect(res._h['x-render-height']).toBe('64');
		expect(res._h['x-render-background']).toBe('transparent');
		expect(renderGlbToPng).toHaveBeenCalledWith(expect.objectContaining({ glbUrl: GLB, width: 2048, height: 64, background: 'transparent' }));
	});

	it('surfaces a renderer failure as its own status, not a stack trace', async () => {
		renderGlbToPng.mockRejectedValueOnce(Object.assign(new Error('glb too large'), { status: 413, code: 'file_too_large' }));
		const res = await callGlb(makeReq('POST', '/api/render/glb', { glbUrl: GLB }));
		expect(res.statusCode).toBe(413);
		expect(JSON.parse(res._body).error).toBe('file_too_large');
	});
});

describe('GET|POST /api/render/avatar-clip', () => {
	it('GET returns the pose catalog so a caller never has to scrape the source', async () => {
		const res = await callClip(makeReq('GET', '/api/render/avatar-clip'));
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res._body);
		expect(body.poses.length).toBeGreaterThan(10);
		expect(body.poses.map((p) => p.id)).toContain('wave');
		for (const p of body.poses) expect(p).toEqual({ id: expect.any(String), label: expect.any(String), group: expect.any(String) });
	});

	it('400s an unknown pose preset and names where the catalog lives', async () => {
		const res = await callClip(makeReq('POST', '/api/render/avatar-clip', { glbUrl: GLB, posePresetId: 'nope' }));
		expect(res.statusCode).toBe(400);
		const body = JSON.parse(res._body);
		expect(body.error).toBe('unknown_pose');
		expect(body.error_description).toMatch(/catalog/i);
		expect(renderClip).not.toHaveBeenCalled();
	});

	it('400s a background carrying markup', async () => {
		const res = await callClip(makeReq('POST', '/api/render/avatar-clip', { glbUrl: GLB, background: INJECTION }));
		expect(res.statusCode).toBe(400);
		expect(renderClip).not.toHaveBeenCalled();
	});

	it('400s a private-address glbUrl before chromium boots', async () => {
		const res = await callClip(makeReq('POST', '/api/render/avatar-clip', { glbUrl: 'http://127.0.0.1:8080/a.glb' }));
		expect(res.statusCode).toBe(400);
		expect(renderClip).not.toHaveBeenCalled();
	});

	it('405s a method the renderer does not serve', async () => {
		expect((await callClip(makeReq('DELETE', '/api/render/avatar-clip'))).statusCode).toBe(405);
	});

	it('keeps an explicit null orbit field as auto-frame instead of coercing it to 0', async () => {
		const res = await callClip(makeReq('POST', '/api/render/avatar-clip', {
			glbUrl: GLB,
			cameraOrbit: { theta: null, phi: null, radius: null },
		}));
		expect(res.statusCode).toBe(200);
		expect(renderClip).toHaveBeenCalledWith(expect.objectContaining({
			cameraOrbit: { theta: 0, phi: 80, radius: null },
		}));
	});

	it('passes pose, orbit, and expression through and reports the applied pose in headers', async () => {
		const res = await callClip(makeReq('POST', '/api/render/avatar-clip', {
			glbUrl: GLB,
			width: 512,
			height: 512,
			posePresetId: 'wave',
			cameraOrbit: { theta: 25, phi: 75, radius: null },
			expression: { jawOpen: 0.4 },
		}));
		expect(res.statusCode).toBe(200);
		expect(res._h['content-type']).toBe('image/png');
		expect(res._h['x-render-pose']).toBe('wave');
		expect(res._h['x-render-pose-label']).toBe('Wave hello');
		expect(renderClip).toHaveBeenCalledWith(expect.objectContaining({
			glbUrl: GLB,
			width: 512,
			height: 512,
			posePresetId: 'wave',
			cameraOrbit: { theta: 25, phi: 75, radius: null },
			expression: { jawOpen: 0.4 },
		}));
	});
});
