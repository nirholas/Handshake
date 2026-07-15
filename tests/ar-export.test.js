import { describe, it, expect } from 'vitest';

import {
	detectArTarget,
	assertArAssetUrl,
	buildSceneViewerUrl,
	buildViewerUrl,
	buildArLaunchUrl,
	buildIrlUrl,
	planArLaunch,
} from '../api/_lib/ar-launch.js';
import { toolDefs as arDefs } from '../api/_mcp3d/tools/ar.js';
import { validateSpatialArtifact } from '../api/_lib/spatial-mcp.js';

const GLB = 'https://three.ws/cdn/creations/model.glb';
const IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36';
const DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

describe('detectArTarget', () => {
	it('classifies iOS, Android, and desktop', () => {
		expect(detectArTarget(IOS)).toBe('ios');
		expect(detectArTarget('… iPad …')).toBe('ios');
		expect(detectArTarget(ANDROID)).toBe('android');
		expect(detectArTarget(DESKTOP)).toBe('desktop');
		expect(detectArTarget('')).toBe('desktop');
	});
});

describe('assertArAssetUrl — boundary rejection', () => {
	it('accepts an https .glb / .gltf', () => {
		expect(assertArAssetUrl(GLB)).toBe(GLB);
		expect(assertArAssetUrl('https://x.io/a.gltf')).toBe('https://x.io/a.gltf');
		expect(assertArAssetUrl('https://x.io/a.glb?token=1')).toContain('.glb');
	});
	it('rejects non-https, non-glb, and garbage — with a coded error, not a crash', () => {
		expect(() => assertArAssetUrl('http://x.io/a.glb')).toThrow(/https/i);
		expect(() => assertArAssetUrl('https://x.io/a.png')).toThrow(/\.glb/i);
		expect(() => assertArAssetUrl('not a url')).toThrow(/valid https url/i);
		try {
			assertArAssetUrl('http://x.io/a.glb');
		} catch (e) {
			expect(e.code).toBe('not_https');
			expect(e.arUserMessage).toBe(true);
		}
	});
});

describe('buildSceneViewerUrl', () => {
	it('builds an ARCore intent URL with the GLB as the source and a browser fallback', () => {
		const u = buildSceneViewerUrl(GLB, { title: 'Robot', fallbackUrl: 'https://three.ws/viewer?src=x' });
		expect(u).toMatch(/^intent:\/\/arvr\.google\.com\/scene-viewer\/1\.2\?/);
		expect(u).toContain('package=com.google.ar.core');
		expect(u).toContain(encodeURIComponent(GLB));
		expect(u).toContain('S.browser_fallback_url=');
	});
});

describe('planArLaunch — device routing', () => {
	it('Android → redirect to Scene Viewer', () => {
		const p = planArLaunch({ glbUrl: GLB, userAgent: ANDROID, origin: 'https://three.ws' });
		expect(p.target).toBe('android');
		expect(p.action).toBe('redirect');
		expect(p.url).toContain('scene-viewer');
	});
	it('iOS → serve the launch page', () => {
		const p = planArLaunch({ glbUrl: GLB, userAgent: IOS, origin: 'https://three.ws' });
		expect(p.target).toBe('ios');
		expect(p.action).toBe('page');
		expect(p.viewerUrl).toContain('/viewer?src=');
	});
	it('desktop → serve the launch page (WebGL fallback)', () => {
		const p = planArLaunch({ glbUrl: GLB, userAgent: DESKTOP, origin: 'https://three.ws' });
		expect(p.target).toBe('desktop');
		expect(p.action).toBe('page');
	});
	it('bad input throws at the boundary (handled by the endpoint)', () => {
		expect(() => planArLaunch({ glbUrl: 'http://x/a.glb', userAgent: IOS, origin: 'https://three.ws' })).toThrow();
	});
});

describe('GET /api/ar — response caching is UA-safe', () => {
	function makeReq(ua) {
		return {
			method: 'GET',
			url: `/api/ar?src=${encodeURIComponent(GLB)}&title=Robot`,
			headers: { 'user-agent': ua, host: 'three.ws' },
		};
	}
	function makeRes() {
		return {
			statusCode: 200,
			_h: {},
			writableEnded: false,
			headersSent: false,
			setHeader(k, v) {
				this._h[k.toLowerCase()] = v;
			},
			getHeader(k) {
				return this._h[k.toLowerCase()];
			},
			end(body) {
				this._body = body;
				this.writableEnded = true;
			},
		};
	}

	it('the launch page varies on User-Agent so a CDN never serves a desktop page to a phone', async () => {
		const { default: handler } = await import('../api/ar.js');
		const res = makeRes();
		await handler(makeReq(IOS), res);
		expect(res.statusCode).toBe(200);
		expect(res.getHeader('vary')).toMatch(/user-agent/i);
		expect(res.getHeader('cache-control')).toContain('public');
	});

	it('the Android Scene Viewer redirect stays uncached (no-store)', async () => {
		const { default: handler } = await import('../api/ar.js');
		const res = makeRes();
		await handler(makeReq(ANDROID), res);
		expect(res.statusCode).toBe(302);
		expect(res.getHeader('location')).toContain('scene-viewer');
		expect(res.getHeader('cache-control')).toBe('no-store');
	});
});

describe('buildViewerUrl / buildArLaunchUrl', () => {
	it('build https viewer and AR launch URLs', () => {
		expect(buildViewerUrl('https://three.ws', GLB)).toBe(`https://three.ws/viewer?src=${encodeURIComponent(GLB)}`);
		expect(buildArLaunchUrl('https://three.ws', GLB)).toBe(`https://three.ws/api/ar?src=${encodeURIComponent(GLB)}`);
	});
});

describe('export_ar MCP tool', () => {
	const tool = arDefs.find((d) => d.name === 'export_ar');
	const req = { headers: { host: 'three.ws', 'x-forwarded-proto': 'https' } };

	it('is a free, read-only tool', () => {
		expect(tool).toBeTruthy();
		expect(tool.scope).toBeUndefined();
		expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
	});

	it('returns AR links and a conformant spatial artifact with the AR handoff', async () => {
		const r = await tool.handler({ glb_url: GLB, title: 'Robot' }, null, req);
		const sc = r.structuredContent;
		expect(sc.arLaunchUrl).toContain('/api/ar?src=');
		expect(sc.viewerUrl).toContain('/viewer?src=');
		expect(sc.sceneViewerUrl).toContain('scene-viewer');
		// The embedded spatial artifact is conformant and carries the AR block.
		const v = validateSpatialArtifact(sc.spatial);
		expect(v.valid).toBe(true);
		expect(sc.spatial.ar.supported).toBe(true);
		expect(sc.spatial.ar.launchUrl).toContain('/api/ar');
	});

	it('rejects bad input cleanly (isError, no crash)', async () => {
		const r = await tool.handler({ glb_url: 'http://x/a.glb' }, null, req);
		expect(r.isError).toBe(true);
		expect(r.structuredContent.error).toBe(true);
	});

	it('response carries no payment/coin/internal-id surface (OpenAI-clean)', async () => {
		const r = await tool.handler({ glb_url: GLB }, null, req);
		const FORBIDDEN = /x402|payment|wallet|usdc|\$three|\btoken\b|\bcoin\b|price|\bpaid\b|onchain|web3|mint|session|trace|job_id|creation_id/i;
		expect(FORBIDDEN.test(JSON.stringify(r))).toBe(false);
	});

	it('kind:"avatar" adds the IRL living-agent link and marks the launch as live', async () => {
		const r = await tool.handler({ glb_url: GLB, title: 'Scout', kind: 'avatar' }, null, req);
		const sc = r.structuredContent;
		expect(sc.irlUrl).toBe(`https://three.ws/irl?avatar=${encodeURIComponent(GLB)}`);
		expect(sc.arLaunchUrl).toContain('kind=avatar');
		expect(sc.spatial.kind).toBe('avatar');
		expect(validateSpatialArtifact(sc.spatial).valid).toBe(true);
		// The narration leads with the living experience, not the static placement.
		expect(r.content[0].text).toContain(sc.irlUrl);
	});

	it('plain models stay static: no irlUrl, no live flag on the launch link', async () => {
		const r = await tool.handler({ glb_url: GLB }, null, req);
		expect(r.structuredContent.irlUrl).toBeUndefined();
		expect(r.structuredContent.arLaunchUrl).not.toContain('kind=avatar');
	});
});

describe('live (avatar) AR lane: the agent-economy bridge into physical space', () => {
	it('buildIrlUrl builds the /irl living handoff for a GLB', () => {
		expect(buildIrlUrl('https://three.ws', GLB)).toBe(`https://three.ws/irl?avatar=${encodeURIComponent(GLB)}`);
		expect(buildIrlUrl('https://three.ws/', GLB)).toBe(`https://three.ws/irl?avatar=${encodeURIComponent(GLB)}`);
	});

	it('buildArLaunchUrl marks live launches with kind=avatar', () => {
		expect(buildArLaunchUrl('https://three.ws', GLB, '', { live: true })).toContain('&kind=avatar');
		expect(buildArLaunchUrl('https://three.ws', GLB)).not.toContain('kind=avatar');
	});

	it('planArLaunch live: Android gets the page (never a blind Scene Viewer redirect), with irlUrl', () => {
		const p = planArLaunch({ glbUrl: GLB, userAgent: ANDROID, origin: 'https://three.ws', live: true });
		expect(p.action).toBe('page');
		expect(p.irlUrl).toContain('/irl?avatar=');
	});

	it('planArLaunch live: iOS and desktop carry irlUrl on the page plan', () => {
		for (const ua of [IOS, DESKTOP]) {
			const p = planArLaunch({ glbUrl: GLB, userAgent: ua, origin: 'https://three.ws', live: true });
			expect(p.action).toBe('page');
			expect(p.irlUrl).toContain('/irl?avatar=');
		}
	});

	it('planArLaunch static: Android redirect unchanged, no irlUrl anywhere', () => {
		const android = planArLaunch({ glbUrl: GLB, userAgent: ANDROID, origin: 'https://three.ws' });
		expect(android.action).toBe('redirect');
		expect(android.irlUrl).toBe('');
		const ios = planArLaunch({ glbUrl: GLB, userAgent: IOS, origin: 'https://three.ws' });
		expect(ios.irlUrl).toBe('');
	});
});

describe('GET /api/ar?kind=avatar: living-agent launch page', () => {
	function makeReq(ua, extra = '') {
		return {
			method: 'GET',
			url: `/api/ar?src=${encodeURIComponent(GLB)}&title=Scout${extra}`,
			headers: { 'user-agent': ua, host: 'three.ws' },
		};
	}
	function makeRes() {
		return {
			statusCode: 200,
			_h: {},
			writableEnded: false,
			headersSent: false,
			setHeader(k, v) {
				this._h[k.toLowerCase()] = v;
			},
			getHeader(k) {
				return this._h[k.toLowerCase()];
			},
			end(body) {
				this._body = body;
				this.writableEnded = true;
			},
		};
	}

	it('an avatar launch serves the page on Android with the Bring-it-to-life handoff', async () => {
		const { default: handler } = await import('../api/ar.js');
		const res = makeRes();
		await handler(makeReq(ANDROID, '&kind=avatar'), res);
		expect(res.statusCode).toBe(200);
		expect(res._body).toContain('Bring it to life');
		expect(res._body).toContain('/irl?avatar=');
	});

	it('an avatar launch on iOS offers both the living handoff and static placement', async () => {
		const { default: handler } = await import('../api/ar.js');
		const res = makeRes();
		await handler(makeReq(IOS, '&kind=avatar'), res);
		expect(res._body).toContain('Bring it to life');
		expect(res._body).toContain('Place in your space');
	});

	it('a static model launch page has no living-agent surface', async () => {
		const { default: handler } = await import('../api/ar.js');
		const res = makeRes();
		await handler(makeReq(IOS), res);
		expect(res._body).not.toContain('Bring it to life');
		expect(res._body).not.toContain('/irl?avatar=');
	});
});
