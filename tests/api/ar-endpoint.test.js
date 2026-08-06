// Integration tests for GET /api/ar, the "View in your space" / "Bring it to
// life" endpoint every generation links to (shapeSubmit's arUrl, the export_ar
// MCP tool, the /forge and /ar pages).
//
// The routing core is pure and unit-tested in tests/ar-export.test.js. What was
// never pinned is the HTTP surface a reviewer actually hits: the User-Agent
// branch (Android intent redirect vs iOS/desktop launch page vs the avatar IRL
// handoff), the designed error page for a bad src, and the cache/Vary headers
// that keep a CDN from serving a desktop page to an Android phone.
//
// No network and no mocks: the handler is invoked directly with mocked req/res
// objects (the pattern used by tests/api/avatar-og.test.js), so every assertion
// runs against the real handler, the real planArLaunch, and the real HTML.

import { describe, it, expect } from 'vitest';

const { default: handler } = await import('../../api/ar.js');

// Real-world User-Agent strings, one per branch the handler routes on.
const UA = {
	android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
	iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
	ipad: 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
	desktop: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
};

const GLB = 'https://pub-2534e921bf9c4314addcd4d8a6e98b7b.r2.dev/forge/anon/fox.glb';

function mkReq({ src = GLB, title = '', kind = '', ua = UA.desktop, method = 'GET', headers = {} } = {}) {
	const q = new URLSearchParams();
	if (src !== null) q.set('src', src);
	if (title) q.set('title', title);
	if (kind) q.set('kind', kind);
	const qs = q.toString();
	return {
		method,
		url: `/api/ar${qs ? `?${qs}` : ''}`,
		headers: { host: 'three.ws', 'x-forwarded-proto': 'https', ...(ua ? { 'user-agent': ua } : {}), ...headers },
	};
}

function mkRes() {
	return {
		statusCode: 200,
		_h: {},
		_body: undefined,
		headersSent: false,
		writableEnded: false,
		setHeader(k, v) { this._h[k.toLowerCase()] = v; },
		getHeader(k) { return this._h[k.toLowerCase()]; },
		end(b) { this._body = b; this.writableEnded = true; },
	};
}

async function get(opts) {
	const req = mkReq(opts);
	const res = mkRes();
	await handler(req, res);
	return res;
}

describe('GET /api/ar - Android Scene Viewer branch', () => {
	it('302s a static model straight into the ARCore Scene Viewer intent', async () => {
		const res = await get({ ua: UA.android, title: 'a low-poly fox' });
		expect(res.statusCode).toBe(302);
		const loc = res._h.location;
		expect(loc.startsWith('intent://arvr.google.com/scene-viewer/1.2?')).toBe(true);
		expect(loc).toContain(`file=${encodeURIComponent(GLB)}`);
		expect(loc).toContain('mode=ar_preferred');
		expect(loc).toContain('package=com.google.ar.core');
		// Browser fallback lands on the WebGL viewer when ARCore is absent.
		expect(loc).toContain(`S.browser_fallback_url=${encodeURIComponent(`https://three.ws/viewer?src=${encodeURIComponent(GLB)}&title=${encodeURIComponent('a low-poly fox')}`)}`);
	});

	it('never caches the redirect (the target is UA-specific)', async () => {
		const res = await get({ ua: UA.android });
		expect(res._h['cache-control']).toBe('no-store');
		expect(res._body).toBeFalsy();
	});
});

describe('GET /api/ar - iOS and desktop launch page', () => {
	it('serves the HTML launch page to iPhone with the model wired into model-viewer', async () => {
		const res = await get({ ua: UA.iphone });
		expect(res.statusCode).toBe(200);
		expect(res._h['content-type']).toBe('text/html; charset=utf-8');
		expect(res._body).toContain(`<model-viewer id="mv" src="${GLB}"`);
		// Quick Look is what iOS enters; model-viewer converts the GLB in-page.
		expect(res._body).toContain('ar-modes="webxr scene-viewer quick-look"');
		expect(res._body).toContain('id="ar-btn"');
		expect(res._body).toContain('View in your space');
	});

	it('serves the same page to iPad and to desktop, with the 3D viewer fallback link', async () => {
		for (const ua of [UA.ipad, UA.desktop]) {
			const res = await get({ ua });
			expect(res.statusCode).toBe(200);
			expect(res._body).toContain(`href="https://three.ws/viewer?src=${encodeURIComponent(GLB)}"`);
			expect(res._body).toContain('Open in 3D viewer');
		}
	});

	it('renders the title into the document title and the name chip, HTML-escaped', async () => {
		const res = await get({ ua: UA.desktop, title: '<img src=x onerror=alert(1)>' });
		expect(res.statusCode).toBe(200);
		expect(res._body).not.toContain('<img src=x');
		expect(res._body).toContain('&lt;img src=x onerror=alert(1)&gt;');
		expect(res._body).toContain('class="name"');
	});

	it('unfurls with a real render of THIS model, not a logo', async () => {
		const res = await get({ ua: UA.desktop, title: 'a fox' });
		expect(res._body).toContain(
			`content="https://three.ws/api/render/glb?glbUrl=${encodeURIComponent(GLB)}&amp;width=1200&amp;height=630"`,
		);
		expect(res._body).toContain('<meta property="og:url" content="https://three.ws/api/ar?src=');
	});

	it('honours the forwarded host so the page links back to the origin that served it', async () => {
		const req = mkReq({ ua: UA.desktop, headers: { 'x-forwarded-host': 'staging.three.ws' } });
		const res = mkRes();
		await handler(req, res);
		expect(res._body).toContain('https://staging.three.ws/viewer?src=');
		expect(res._body).toContain('https://staging.three.ws/api/render/glb?');
	});
});

describe('GET /api/ar - kind=avatar IRL handoff', () => {
	it('keeps Android on the launch page so the living-agent path stays visible', async () => {
		const res = await get({ ua: UA.android, kind: 'avatar' });
		expect(res.statusCode).toBe(200);
		expect(res._h.location).toBeUndefined();
		expect(res._body).toContain(`href="https://three.ws/irl?avatar=${encodeURIComponent(GLB)}"`);
		expect(res._body).toContain('Bring it to life');
		// Static placement stays available alongside the living handoff.
		expect(res._body).toContain('Place in your space');
	});

	it('offers the IRL handoff on iOS and desktop too', async () => {
		for (const ua of [UA.iphone, UA.desktop]) {
			const res = await get({ ua, kind: 'avatar' });
			expect(res.statusCode).toBe(200);
			expect(res._body).toContain('/irl?avatar=');
			expect(res._body).toContain('This is a living agent.');
		}
	});

	it('a static model gets no IRL link at all', async () => {
		const res = await get({ ua: UA.desktop });
		expect(res._body).not.toContain('/irl?avatar=');
		expect(res._body).not.toContain('Bring it to life');
	});
});

describe('GET /api/ar - designed error page for bad input', () => {
	const cases = [
		{ name: 'a missing src', src: '', message: 'Provide a valid https URL to a .glb model.' },
		{ name: 'a non-URL src', src: 'not a url', message: 'Provide a valid https URL to a .glb model.' },
		{ name: 'a non-https src', src: 'http://cdn.example/fox.glb', message: 'The model URL must be https.' },
		{ name: 'a non-GLB src', src: 'https://cdn.example/fox.png', message: 'The model URL must point at a .glb or .gltf file.' },
		{ name: 'a javascript: src', src: 'javascript:alert(1)//a.glb', message: 'The model URL must be https.' },
	];

	for (const c of cases) {
		it(`400s ${c.name} with the designed page, never a crash`, async () => {
			const res = await get({ src: c.src, ua: UA.desktop });
			expect(res.statusCode).toBe(400);
			expect(res._h['content-type']).toBe('text/html; charset=utf-8');
			expect(res._h['cache-control']).toBe('no-store');
			expect(res._body).toContain("Can't open this in AR");
			expect(res._body).toContain(c.message);
			// The error state is actionable: it offers the way forward.
			expect(res._body).toContain('Create a 3D model');
			// A rejected asset never reaches the page.
			expect(res._body).not.toContain('<model-viewer');
		});
	}

	it('rejects .gltf lookalikes but accepts a real .gltf with a query string', async () => {
		const bad = await get({ src: 'https://cdn.example/fox.glb.exe', ua: UA.desktop });
		expect(bad.statusCode).toBe(400);
		const ok = await get({ src: 'https://cdn.example/scene.gltf?v=2', ua: UA.desktop });
		expect(ok.statusCode).toBe(200);
		expect(ok._body).toContain('https://cdn.example/scene.gltf?v=2');
	});
});

describe('GET /api/ar - caching and CORS headers', () => {
	it('varies the cached page on user-agent so an Android phone cannot be served a desktop page', async () => {
		const res = await get({ ua: UA.desktop });
		expect(res._h.vary).toBe('user-agent');
		expect(res._h['cache-control']).toBe('public, max-age=60, s-maxage=600');
	});

	it('answers the CORS preflight with 204 and no body', async () => {
		const res = await get({ method: 'OPTIONS', ua: UA.desktop });
		expect(res.statusCode).toBe(204);
		expect(res._h['access-control-allow-methods']).toBe('GET,OPTIONS');
		expect(res._body).toBeFalsy();
	});

	it('treats an absent User-Agent as desktop rather than failing', async () => {
		const res = await get({ ua: '' });
		expect(res.statusCode).toBe(200);
		expect(res._body).toContain('<model-viewer');
	});
});
