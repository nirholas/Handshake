// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { loadModule, loadScript, moduleMirrors, parseCdnModuleUrl } from '../src/shared/load-module.js';

describe('moduleMirrors', () => {
	it('expands an esm.sh URL to jsdelivr and unpkg equivalents, original first', () => {
		expect(moduleMirrors('https://esm.sh/qrcode@1.5.3')).toEqual([
			'https://esm.sh/qrcode@1.5.3',
			'https://cdn.jsdelivr.net/npm/qrcode@1.5.3/+esm',
			'https://unpkg.com/qrcode@1.5.3?module',
		]);
	});
	it('keeps scoped packages, subpaths and the esm.sh query', () => {
		expect(moduleMirrors('https://esm.sh/@solana/web3.js@1.95.3?bundle')).toEqual([
			'https://esm.sh/@solana/web3.js@1.95.3?bundle',
			'https://cdn.jsdelivr.net/npm/@solana/web3.js@1.95.3/+esm',
			'https://unpkg.com/@solana/web3.js@1.95.3?module',
		]);
		expect(moduleMirrors('https://esm.sh/three@0.176.0/examples/jsm/loaders/GLTFLoader.js')[1]).toBe(
			'https://cdn.jsdelivr.net/npm/three@0.176.0/examples/jsm/loaders/GLTFLoader.js/+esm',
		);
	});
	it('starts from jsdelivr when the original is jsdelivr', () => {
		const list = moduleMirrors('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/+esm');
		expect(list[0]).toBe('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/+esm');
		expect(list).toContain('https://esm.sh/@mediapipe/tasks-vision@0.10.21');
		expect(list).toContain('https://unpkg.com/@mediapipe/tasks-vision@0.10.21?module');
	});
	it('leaves non-CDN URLs alone', () => {
		expect(moduleMirrors('/three/draco/gltf/decoder.js')).toEqual(['/three/draco/gltf/decoder.js']);
		expect(parseCdnModuleUrl('https://example.com/x.js')).toBeNull();
	});
});

describe('loadModule', () => {
	it('returns the first importer that succeeds and skips failed mirrors', async () => {
		const importer = vi.fn(async (url) => {
			if (url.includes('esm.sh')) throw new TypeError('Failed to fetch dynamically imported module');
			return { default: `ok:${url}` };
		});
		const mod = await loadModule('https://esm.sh/testpkg@1.0.0', { importer });
		expect(mod.default).toBe('ok:https://cdn.jsdelivr.net/npm/testpkg@1.0.0/+esm');
		expect(importer).toHaveBeenCalledTimes(2);
	});
	it('memoises per list so a second call does not re-import', async () => {
		const importer = vi.fn(async () => ({ v: 1 }));
		const a = loadModule(['https://esm.sh/memo@2.0.0'], { importer });
		const b = loadModule(['https://esm.sh/memo@2.0.0'], { importer });
		expect(a).toBe(b);
		await a;
		expect(importer).toHaveBeenCalledTimes(1);
	});
	it('rejects with a typed error naming every host when all mirrors fail', async () => {
		const importer = vi.fn(async () => { throw new Error('nope'); });
		const err = await loadModule('https://esm.sh/dead@9.9.9', { importer }).catch((e) => e);
		expect(err.code).toBe('module_unavailable');
		expect(err.hosts).toEqual(['esm.sh', 'cdn.jsdelivr.net', 'unpkg.com']);
		expect(err.message).toMatch(/esm\.sh, cdn\.jsdelivr\.net, unpkg\.com/);
		// A failed chain is not memoised: a retry tries again.
		const importer2 = vi.fn(async () => ({ ok: true }));
		await expect(loadModule('https://esm.sh/dead@9.9.9', { importer: importer2 })).resolves.toEqual({ ok: true });
	});
	it('treats a hung import as failed after the deadline and moves on', async () => {
		vi.useFakeTimers();
		const importer = vi.fn((url) => (url.includes('esm.sh') ? new Promise(() => {}) : Promise.resolve({ fast: url })));
		const p = loadModule('https://esm.sh/slow@1.0.0', { importer, timeoutMs: 50 });
		await vi.advanceTimersByTimeAsync(60);
		await expect(p).resolves.toEqual({ fast: 'https://cdn.jsdelivr.net/npm/slow@1.0.0/+esm' });
		vi.useRealTimers();
	});
});

describe('loadScript', () => {
	it('falls through to the next mirror on error and resolves the global', async () => {
		const p = loadScript(['https://a.example/x.js', 'https://b.example/x.js'], { globalName: 'TestGlobalX' });
		await Promise.resolve();
		const first = document.querySelector('script[src="https://a.example/x.js"]');
		expect(first).not.toBeNull();
		first.onerror();
		await Promise.resolve();
		await Promise.resolve();
		const second = document.querySelector('script[src="https://b.example/x.js"]');
		expect(second).not.toBeNull();
		globalThis.TestGlobalX = { ready: true };
		second.onload();
		await expect(p).resolves.toEqual({ ready: true });
		delete globalThis.TestGlobalX;
	});
	it('rejects with the hosts tried when every mirror errors', async () => {
		const p = loadScript(['https://c.example/y.js']);
		await Promise.resolve();
		document.querySelector('script[src="https://c.example/y.js"]').onerror();
		const err = await p.catch((e) => e);
		expect(err.code).toBe('module_unavailable');
		expect(err.hosts).toEqual(['c.example']);
	});
});
