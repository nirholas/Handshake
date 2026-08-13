// @vitest-environment jsdom
//
// @three-ws/avatar public API — the surface the README promises to consumers.
//
// The package ships four entry points and only one of them (`./viewer`'s
// rendering half) genuinely needs WebGL. Everything else is plain DOM and fetch
// work that had no coverage at all: the AvatarCreator postMessage trust check,
// its modal lifecycle, the saveBlob upload chain, and the ensureAgent3D
// registration guard. Those are the paths an integrator hits on day one, and a
// break in any of them is silent until someone loads the SDK in a browser.
//
// The viewer's pure state helpers live in avatar-sdk-viewer-state.test.js.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// jsdom's Blob has no arrayBuffer() (browsers have shipped it since 2019, and
// saveBlob needs it to checksum the upload), so the upload tests use Node's
// spec-complete Blob instead of the environment's.
import { Blob as UploadBlob } from 'node:buffer';
import { AvatarCreator, saveBlob } from '../avatar-sdk/src/creator.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SDK = resolve(ROOT, 'avatar-sdk');
const pkg = JSON.parse(readFileSync(resolve(SDK, 'package.json'), 'utf8'));

describe('package manifest', () => {
	it('ships every non-generated export target in the repo', () => {
		// dist/* is produced by `npm run build` (from dist-lib/agent-3d.js) and is
		// gitignored, so only the hand-written targets can be asserted here.
		const targets = [];
		const walk = (node) => {
			if (typeof node === 'string') targets.push(node);
			else if (node && typeof node === 'object') Object.values(node).forEach(walk);
		};
		walk(pkg.exports);

		const sourceTargets = targets.filter((t) => t.startsWith('./src/') || t.startsWith('./types/'));
		expect(sourceTargets.length).toBeGreaterThan(0);
		for (const target of sourceTargets) {
			expect(existsSync(resolve(SDK, target)), `missing export target ${target}`).toBe(true);
		}
	});

	it('publishes the directories those targets live in', () => {
		for (const dir of ['dist', 'src', 'types']) {
			expect(pkg.files).toContain(dir);
		}
	});
});

describe('ensureAgent3D', () => {
	it('resolves immediately when <agent-3d> is already registered', async () => {
		// Registering first keeps the guard on its short-circuit branch: the 4 MB
		// monolith at ../dist/index.mjs is a build artifact and a browser-only
		// module, so a test must never be the thing that imports it.
		if (!customElements.get('agent-3d')) {
			customElements.define('agent-3d', class extends HTMLElement {});
		}
		const mod = await import('../avatar-sdk/src/agent.js');
		expect(typeof mod.ensureAgent3D).toBe('function');
		expect(mod.default).toBe(mod.ensureAgent3D);
		await expect(mod.ensureAgent3D()).resolves.toBeUndefined();
		// Idempotent: a second call is the same cheap resolve, not a second load.
		await expect(mod.ensureAgent3D()).resolves.toBeUndefined();
	});
});

describe('AvatarCreator modal', () => {
	const STUDIO = 'https://studio.example.test/avatar-studio/';
	let creator;

	afterEach(() => {
		creator?.dispose();
		creator = null;
		document.body.innerHTML = '';
	});

	function exportMessage(origin) {
		return new MessageEvent('message', {
			origin,
			data: { source: 'characterstudio', type: 'export', glb: new ArrayBuffer(8) },
		});
	}

	it('mounts an iframe pointed at the studio and a labelled close control', async () => {
		creator = new AvatarCreator({ studioUrl: STUDIO });
		await creator.open();

		const iframe = document.querySelector('iframe');
		expect(iframe).toBeTruthy();
		expect(iframe.src).toBe('https://studio.example.test/avatar-studio');
		expect(iframe.title).toBe('Avatar Creator');
		expect(document.querySelector('button[aria-label="Close"]')).toBeTruthy();
	});

	it('opens an Avaturn edit session when one is supplied', async () => {
		creator = new AvatarCreator({
			studioUrl: STUDIO,
			avaturnSessionUrl: 'https://demo.avaturn.dev/session/abc',
		});
		await creator.open();
		expect(document.querySelector('iframe').src).toBe('https://demo.avaturn.dev/session/abc');
	});

	it('is a no-op when open() is called twice', async () => {
		creator = new AvatarCreator({ studioUrl: STUDIO });
		await creator.open();
		await creator.open();
		expect(document.querySelectorAll('iframe')).toHaveLength(1);
	});

	it('ignores an export message from an origin it did not open', async () => {
		let exported = null;
		creator = new AvatarCreator({ studioUrl: STUDIO, onExport: (b) => (exported = b) });
		await creator.open();

		window.dispatchEvent(exportMessage('https://attacker.example.test'));
		expect(exported).toBeNull();
		expect(document.querySelector('iframe')).toBeTruthy();
	});

	it('resolves a GLB blob and tears the modal down on a trusted export', async () => {
		let exported = null;
		creator = new AvatarCreator({ studioUrl: STUDIO, onExport: (b) => (exported = b) });
		await creator.open();

		window.dispatchEvent(exportMessage('https://studio.example.test'));
		expect(exported).toBeInstanceOf(Blob);
		expect(exported.type).toBe('model/gltf-binary');
		expect(exported.size).toBe(8);
		expect(document.querySelector('iframe')).toBeNull();
	});

	it('closes on Escape and reports it through onClose', async () => {
		let closed = 0;
		creator = new AvatarCreator({ studioUrl: STUDIO, onClose: () => closed++ });
		await creator.open();

		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
		expect(closed).toBe(1);
		expect(document.querySelector('iframe')).toBeNull();

		// dispose() after a close must not fire onClose again or throw.
		creator.dispose();
		expect(closed).toBe(1);
	});

	it('stops listening for messages once closed', async () => {
		let exported = null;
		creator = new AvatarCreator({ studioUrl: STUDIO, onExport: (b) => (exported = b) });
		await creator.open();
		creator.close();

		window.dispatchEvent(exportMessage('https://studio.example.test'));
		expect(exported).toBeNull();
	});
});

describe('saveBlob', () => {
	let calls;
	let originalFetch;

	beforeEach(() => {
		calls = [];
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	function installFetch(overrides = {}) {
		globalThis.fetch = async (url, init = {}) => {
			calls.push({ url: String(url), method: init.method || 'GET', body: init.body, headers: init.headers });
			if (String(url).endsWith('/api/avatars/presign')) {
				return (
					overrides.presign ||
					jsonResponse({ upload_url: 'https://r2.example.test/put/abc', storage_key: 'avatars/abc.glb' })
				);
			}
			if (String(url).startsWith('https://r2.example.test/')) {
				return overrides.put || new Response(null, { status: 200 });
			}
			return (
				overrides.create ||
				jsonResponse({ avatar: { id: 'av_1', url: 'https://cdn.example.test/av_1.glb', slug: 'my-avatar' } })
			);
		};
	}

	function jsonResponse(body, status = 200) {
		return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
	}

	it('refuses to upload without a write-scoped token', async () => {
		await expect(saveBlob(new UploadBlob(['x']), {})).rejects.toThrow(/bearerToken is required/);
	});

	it('presigns, PUTs the bytes, then creates the record', async () => {
		installFetch();

		const blob = new UploadBlob([new Uint8Array([1, 2, 3, 4])], { type: 'model/gltf-binary' });
		const result = await saveBlob(blob, {
			bearerToken: 'tok_test',
			apiOrigin: 'https://api.example.test/',
			name: 'My Avatar',
			visibility: 'unlisted',
			tags: ['demo'],
		});

		expect(result).toEqual({ id: 'av_1', url: 'https://cdn.example.test/av_1.glb', slug: 'my-avatar' });
		expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
			'POST https://api.example.test/api/avatars/presign',
			'PUT https://r2.example.test/put/abc',
			'POST https://api.example.test/api/avatars',
		]);

		const presignBody = JSON.parse(calls[0].body);
		expect(presignBody.size_bytes).toBe(4);
		expect(presignBody.content_type).toBe('model/gltf-binary');
		// SHA-256 of 01 02 03 04, computed client-side before the upload.
		expect(presignBody.checksum_sha256).toMatch(/^[0-9a-f]{64}$/);

		const createBody = JSON.parse(calls[2].body);
		expect(createBody.storage_key).toBe('avatars/abc.glb');
		expect(createBody.name).toBe('My Avatar');
		expect(createBody.visibility).toBe('unlisted');
		expect(createBody.tags).toEqual(['demo']);
		expect(createBody.checksum_sha256).toBe(presignBody.checksum_sha256);
		expect(calls[0].headers.authorization).toBe('Bearer tok_test');
	});

	it('defaults the origin, visibility, and name when they are omitted', async () => {
		installFetch();

		await saveBlob(new UploadBlob([new Uint8Array([9])]), { bearerToken: 'tok_test' });

		expect(calls[0].url).toBe('https://three.ws/api/avatars/presign');
		const createBody = JSON.parse(calls[2].body);
		expect(createBody.visibility).toBe('public');
		expect(createBody.name).toMatch(/^Avatar [0-9a-f]{6}$/);
		expect(createBody.source_meta).toEqual({ via: '@three-ws/avatar' });
	});

	it('surfaces the failing stage instead of resolving with a half-made avatar', async () => {
		installFetch({ presign: jsonResponse({ error: 'nope' }, 403) });

		await expect(saveBlob(new UploadBlob(['x']), { bearerToken: 'tok_test' })).rejects.toThrow(/presign failed: 403/);
		expect(calls).toHaveLength(1);
	});

	it('fails loudly when the R2 upload is rejected', async () => {
		installFetch({ put: new Response(null, { status: 500 }) });

		await expect(saveBlob(new UploadBlob(['x']), { bearerToken: 'tok_test' })).rejects.toThrow(/R2 upload failed: 500/);
		expect(calls).toHaveLength(2);
	});
});
