// Tests for the server-side GLB → PNG renderer.
//
// The full render path needs a real chromium binary, a real GLB, and ~3s of
// boot time, so the deep test is gated on RUN_HEADFUL_TESTS=1. CI runs the
// fast input-validation suite only. Integration with the OG endpoint is
// tested separately in tests/api/avatar-og.test.js with the renderer stubbed.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'node:http';
import { Document, NodeIO } from '@gltf-transform/core';

const HEADFUL = process.env.RUN_HEADFUL_TESTS === '1';

describe('renderGlbToPng — input validation', () => {
	it('rejects when glbUrl is missing', async () => {
		const { renderGlbToPng } = await import('../api/_lib/render-glb.js');
		await expect(renderGlbToPng({})).rejects.toThrow(/glbUrl required/);
		await expect(renderGlbToPng({ glbUrl: '' })).rejects.toThrow(/glbUrl required/);
		await expect(renderGlbToPng({ glbUrl: null })).rejects.toThrow(/glbUrl required/);
		await expect(renderGlbToPng({ glbUrl: 42 })).rejects.toThrow(/glbUrl required/);
	});
});

// A batch runner charges a bounded retry against a model each time its render
// fails. If chromium is OOM-killed mid-batch, every remaining render fails
// instantly with "Connection closed." — and without this classifier the runner
// blames the models and retires them permanently. (It did: 1,283 healthy avatars
// were retired that way before the classifier existed.)
describe('isBrowserInfrastructureError — blame the browser, not the model', () => {
	it('classifies a dead/unreachable browser as infrastructure', async () => {
		const { isBrowserInfrastructureError } = await import('../api/_lib/render-glb.js');
		for (const msg of [
			'Connection closed.',
			'Protocol error (Page.navigate): Target closed.',
			'Navigation failed because browser has disconnected!',
			'Session closed. Most likely the page has been closed.',
			'Failed to launch the browser process!',
			'read ECONNRESET',
			'socket hang up',
		]) {
			expect(isBrowserInfrastructureError(new Error(msg)), msg).toBe(true);
		}
	});

	it('does NOT excuse a genuinely broken model', async () => {
		const { isBrowserInfrastructureError } = await import('../api/_lib/render-glb.js');
		for (const msg of [
			'glb fetch failed: upstream returned 404',
			'glb fetch failed: file_too_large',
			'render failed: THREE.GLTFLoader: Unsupported asset. glTF versions >=2.0 are supported.',
			'renderer returned no bytes',
			'glbUrl required',
		]) {
			expect(isBrowserInfrastructureError(new Error(msg)), msg).toBe(false);
		}
	});

	it('tolerates a non-Error / nullish argument', async () => {
		const { isBrowserInfrastructureError } = await import('../api/_lib/render-glb.js');
		expect(isBrowserInfrastructureError(null)).toBe(false);
		expect(isBrowserInfrastructureError(undefined)).toBe(false);
		expect(isBrowserInfrastructureError('Connection closed.')).toBe(true);
	});
});

describe.skipIf(!HEADFUL)('renderGlbToPng — headful render', () => {
	// Generate a minimal-but-valid GLB at module-load time: a single-triangle mesh.
	// Served from a localhost http server so chromium can fetch it the same way
	// production would fetch from R2's public CDN.
	let server;
	let glbUrl;

	beforeAll(async () => {
		const glbBuf = await buildTriangleGlb();
		server = createServer((req, res) => {
			if (req.url?.endsWith('.glb')) {
				res.writeHead(200, {
					'content-type': 'model/gltf-binary',
					'content-length': String(glbBuf.length),
					'access-control-allow-origin': '*',
				});
				res.end(glbBuf);
			} else {
				res.writeHead(404).end();
			}
		});
		await new Promise((r) => server.listen(0, '127.0.0.1', r));
		const { port } = server.address();
		glbUrl = `http://127.0.0.1:${port}/triangle.glb`;
	}, 30_000);

	afterAll(() => {
		server?.close();
	});

	it('renders a GLB to a PNG buffer with the PNG magic header', async () => {
		const { renderGlbToPng } = await import('../api/_lib/render-glb.js');
		const png = await renderGlbToPng({ glbUrl, width: 400, height: 300 });
		expect(Buffer.isBuffer(png) || png instanceof Uint8Array).toBe(true);
		// PNG magic: 89 50 4E 47 0D 0A 1A 0A
		expect(png[0]).toBe(0x89);
		expect(png[1]).toBe(0x50);
		expect(png[2]).toBe(0x4e);
		expect(png[3]).toBe(0x47);
		expect(png[4]).toBe(0x0d);
		expect(png[5]).toBe(0x0a);
		expect(png[6]).toBe(0x1a);
		expect(png[7]).toBe(0x0a);
	}, 60_000);
});

// Smallest legal GLB containing a single triangle mesh — used as a render
// target. Avoids committing a binary fixture by building it from scratch.
async function buildTriangleGlb() {
	const doc = new Document();
	const buf = doc.createBuffer();
	const positions = doc
		.createAccessor()
		.setType('VEC3')
		.setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]))
		.setBuffer(buf);
	const prim = doc.createPrimitive().setAttribute('POSITION', positions);
	const mesh = doc.createMesh().addPrimitive(prim);
	const node = doc.createNode().setMesh(mesh);
	doc.createScene().addChild(node);
	const io = new NodeIO();
	return Buffer.from(await io.writeBinary(doc));
}
