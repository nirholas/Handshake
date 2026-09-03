// The three.js CDN failover, and the tripwire that keeps it wired in.
//
// api/_lib/three-cdn.js shipped fully written but imported by nobody: all
// three headless renderers still hardcoded `unpkg.com/three@…` in their import
// maps, so the failover it describes never ran. An unpkg outage would have
// hung each page's module import until the render watchdog fired, and every
// poster, avatar image and clip would have come back blank with no error to
// explain it. These tests cover the resolver itself and, more importantly,
// assert that the renderers still route through it.

import { describe, it, expect, beforeEach } from 'vitest';
import { readFile } from 'node:fs/promises';

import {
	DEFAULT_THREE_BASE,
	THREE_CDN_HOSTS,
	THREE_VERSION,
	_resetThreeCdnProbes,
	resolveThreeCdn,
	threeImportMap,
} from '../../api/_lib/three-cdn.js';

const RENDERERS = [
	'api/_lib/render-glb.js',
	'api/_lib/avatar-render.js',
	'api/_lib/render-clip.js',
];

beforeEach(() => { _resetThreeCdnProbes(); });

describe('resolveThreeCdn', () => {
	it('stays on unpkg while unpkg answers the probe', async () => {
		const fetchImpl = async () => ({ ok: true, status: 200 });
		const { host, base, cached } = await resolveThreeCdn(THREE_VERSION, { fetchImpl });
		expect(host).toBe('unpkg');
		expect(base).toBe(THREE_CDN_HOSTS.unpkg(THREE_VERSION));
		expect(cached).toBe(false);
	});

	it('fails over to jsDelivr when unpkg errors', async () => {
		const fetchImpl = async () => { throw new Error('ECONNRESET'); };
		const { host, base } = await resolveThreeCdn(THREE_VERSION, { fetchImpl });
		expect(host).toBe('jsdelivr');
		expect(base).toBe(THREE_CDN_HOSTS.jsdelivr(THREE_VERSION));
	});

	it('fails over on a non-ok status, not just a thrown error', async () => {
		const fetchImpl = async () => ({ ok: false, status: 503 });
		const { host } = await resolveThreeCdn(THREE_VERSION, { fetchImpl });
		expect(host).toBe('jsdelivr');
	});

	it('probes once per TTL so a render burst pays one HEAD', async () => {
		let calls = 0;
		const fetchImpl = async () => { calls += 1; return { ok: true, status: 200 }; };
		await resolveThreeCdn(THREE_VERSION, { fetchImpl });
		const second = await resolveThreeCdn(THREE_VERSION, { fetchImpl });
		expect(calls).toBe(1);
		expect(second.cached).toBe(true);
	});

	it('re-probes past the TTL, so a recovered unpkg is picked back up', async () => {
		let ok = false;
		let now = 1_000_000;
		const fetchImpl = async () => { if (!ok) throw new Error('down'); return { ok: true, status: 200 }; };
		expect((await resolveThreeCdn(THREE_VERSION, { fetchImpl, now: () => now })).host).toBe('jsdelivr');
		ok = true;
		now += 11 * 60_000;
		expect((await resolveThreeCdn(THREE_VERSION, { fetchImpl, now: () => now })).host).toBe('unpkg');
	});

	it('builds an import map that resolves both three and its addons', () => {
		const map = threeImportMap(THREE_CDN_HOSTS.jsdelivr(THREE_VERSION));
		expect(map.three).toBe(`https://cdn.jsdelivr.net/npm/three@${THREE_VERSION}/build/three.module.js`);
		expect(map['three/addons/']).toBe(`https://cdn.jsdelivr.net/npm/three@${THREE_VERSION}/examples/jsm/`);
	});
});

describe('the renderers route through the resolver', () => {
	it('no renderer hardcodes a three.js CDN host', async () => {
		for (const path of RENDERERS) {
			const src = await readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
			expect(src, `${path} hardcodes a CDN host instead of using resolveThreeCdn()`)
				.not.toMatch(/unpkg\.com\/three@|cdn\.jsdelivr\.net\/npm\/three@/);
		}
	});

	it('every renderer imports the shared resolver and pin', async () => {
		for (const path of RENDERERS) {
			const src = await readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
			expect(src, `${path} does not import three-cdn.js`).toMatch(/from '\.\/three-cdn\.js'/);
			expect(src, `${path} never calls resolveThreeCdn`).toMatch(/resolveThreeCdn\(THREE_VERSION\)/);
			expect(src, `${path} keeps its own THREE_VERSION pin`).not.toMatch(/const THREE_VERSION\s*=/);
		}
	});
});

describe('sceneViewerHtml honors the resolved base', () => {
	function importMapOf(html) {
		const m = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
		expect(m, 'render page has no import map').toBeTruthy();
		return JSON.parse(m[1]).imports;
	}

	const args = {
		glbUrl: 'https://example.com/a.glb',
		width: 64, height: 64, background: '#000',
		pose: null, cameraOrbit: null, expression: null, scenePreset: null,
	};

	it('defaults to unpkg when the caller skips the probe', async () => {
		const { sceneViewerHtml } = await import('../../api/_lib/avatar-render.js');
		const imports = importMapOf(sceneViewerHtml(args));
		expect(imports.three).toBe(threeImportMap(DEFAULT_THREE_BASE).three);
	});

	it('emits a parseable import map that keeps the pose modules alongside three', async () => {
		const { sceneViewerHtml } = await import('../../api/_lib/avatar-render.js');
		const base = THREE_CDN_HOSTS.jsdelivr(THREE_VERSION);
		const html = sceneViewerHtml({ ...args, threeBase: base });
		const imports = importMapOf(html);
		expect(imports.three).toBe(threeImportMap(base).three);
		expect(imports['three/addons/']).toBe(threeImportMap(base)['three/addons/']);
		// The pose runtime is served as data: URLs from the same map; a
		// malformed splice of the three entries would have dropped them.
		expect(imports['glb-canonicalize']).toMatch(/^data:text\/javascript/);
		expect(imports['pose-rig']).toMatch(/^data:text\/javascript/);
	});

	it('switches the decoder-asset base too, not just the module imports', async () => {
		const { sceneViewerHtml } = await import('../../api/_lib/avatar-render.js');
		const base = THREE_CDN_HOSTS.jsdelivr(THREE_VERSION);
		const html = sceneViewerHtml({ ...args, threeBase: base });
		expect(html).toContain(`${base}examples/jsm/`);
		expect(html).not.toContain('unpkg.com');
	});
});
