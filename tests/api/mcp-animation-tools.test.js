// Handler tests for the MCP animation tools (api/_mcp/tools/animations.js).
//
// The catalogue tools read the platform's own published artifacts
// (public/animations/manifest.json and signatures.json), so the suite serves
// that real directory over an ephemeral HTTP server and lets the handlers fetch
// it exactly as they do in production. No fixture manifests, no stubbed fetch:
// if the published artifacts change shape, these tests notice.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ANIMATIONS_DIR = path.join(ROOT, 'public', 'animations');

const { toolDefs } = await import('../../api/_mcp/tools/animations.js');
const tool = (name) => toolDefs.find((t) => t.name === name);

// resolveOrigin prefers explicit env over the Host header, so the origin env
// has to be out of the way for the handlers to reach the local server.
const ORIGIN_ENV = ['APP_ORIGIN', 'PUBLIC_ORIGIN', 'PUBLIC_APP_ORIGIN', 'VERCEL_URL'];
const savedEnv = {};

let server;
let req;
// A second server that answers every request with 404, for the failure path
// where the published artifacts are unreachable.
let emptyServer;
let missingReq;

function listen(handler) {
	return new Promise((resolve) => {
		const s = http.createServer(handler);
		s.listen(0, '127.0.0.1', () => resolve(s));
	});
}

beforeAll(async () => {
	for (const key of ORIGIN_ENV) {
		savedEnv[key] = process.env[key];
		delete process.env[key];
	}

	server = await listen(async (rq, rs) => {
		// Only /animations/** is served, and only by basename, so a traversal
		// attempt in a test can never read outside the published directory.
		const rel = rq.url.split('?')[0].replace(/^\/animations\//, '');
		const file = path.join(ANIMATIONS_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
		try {
			const info = await stat(file);
			if (!info.isFile()) throw new Error('not a file');
			rs.writeHead(200, { 'content-type': 'application/json' });
			createReadStream(file).pipe(rs);
		} catch {
			rs.writeHead(404).end('not found');
		}
	});
	emptyServer = await listen((_rq, rs) => rs.writeHead(404).end('not found'));

	req = { headers: { host: `127.0.0.1:${server.address().port}` } };
	missingReq = { headers: { host: `127.0.0.1:${emptyServer.address().port}` } };
});

afterAll(async () => {
	for (const key of ORIGIN_ENV) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
	await Promise.all(
		[server, emptyServer].map((s) => new Promise((resolve) => s.close(resolve))),
	);
});

const auth = { userId: null, rateKey: 'test', scope: '', source: 'free' };

describe('catalog assembly', () => {
	it('exports the five animation tools with explicit MCP annotations', () => {
		const names = toolDefs.map((t) => t.name);
		expect(names).toEqual([
			'list_animations',
			'animation_signature',
			'find_similar_animations',
			'apply_animation',
			'text_to_animation',
		]);
		for (const t of toolDefs) {
			// destructiveHint defaults to true when omitted, so every tool must
			// state all four hints rather than inherit a wrong default.
			expect(Object.keys(t.annotations).sort()).toEqual([
				'destructiveHint',
				'idempotentHint',
				'openWorldHint',
				'readOnlyHint',
			]);
		}
	});
});

describe('list_animations', () => {
	it('lists the published presets with category and loop flags', async () => {
		const out = await tool('list_animations').handler({}, auth, req);
		const { count, animations } = out.structuredContent;
		expect(count).toBeGreaterThan(0);
		expect(count).toBe(animations.length);
		expect(out.content[0].text).toContain(`${count} animation presets:`);

		const idle = animations.find((a) => a.name === 'idle');
		expect(idle).toMatchObject({ name: 'idle', loop: true });
		expect(typeof idle.category).toBe('string');
		expect(idle.label.length).toBeGreaterThan(0);
	});

	it('filters to a single category, case-insensitively', async () => {
		const all = await tool('list_animations').handler({}, auth, req);
		const category = all.structuredContent.animations[0].category;
		const filtered = await tool('list_animations').handler(
			{ category: category.toUpperCase() },
			auth,
			req,
		);
		expect(filtered.structuredContent.count).toBeGreaterThan(0);
		expect(filtered.structuredContent.count).toBeLessThan(all.structuredContent.count);
		expect(filtered.structuredContent.animations.every((a) => a.category === category)).toBe(
			true,
		);
	});

	it('returns an empty, well-formed list for a category nothing matches', async () => {
		const out = await tool('list_animations').handler({ category: 'no-such-category' }, auth, req);
		expect(out.structuredContent).toEqual({ count: 0, animations: [] });
		expect(out.content[0].text).toContain('0 animation presets:');
	});

	// Failure path: the catalogue is a published artifact, so an unreachable one
	// is reported as a fetch failure rather than silently listed as empty.
	it('throws when the manifest cannot be fetched', async () => {
		await expect(tool('list_animations').handler({}, auth, missingReq)).rejects.toThrow(
			/manifest fetch failed \(HTTP 404\)/,
		);
	});
});

describe('animation_signature', () => {
	it('returns the measured signature and energy band for a real clip', async () => {
		const out = await tool('animation_signature').handler({ clip: 'idle' }, auth, req);
		const { signature } = out.structuredContent;
		expect(signature.clip).toBe('idle');
		expect(signature.duration).toBeGreaterThan(0);
		expect(typeof signature.band).toBe('string');
		expect(out.content[0].text).toMatch(/^idle: /);
		expect(out.structuredContent.fit).toBeUndefined();
	});

	it('adds a slot fit verdict when a runtime slot is supplied', async () => {
		const out = await tool('animation_signature').handler({ clip: 'idle', slot: 'idle' }, auth, req);
		const { fit } = out.structuredContent;
		expect(fit.slot).toBe('idle');
		expect(fit.level).toBeTruthy();
		expect(fit.message).toBeTruthy();
		expect(out.content[0].text).toContain('Fit for "idle"');
	});

	it('rejects an unknown clip with invalid-params and points at list_animations', async () => {
		await expect(
			tool('animation_signature').handler({ clip: 'not-a-clip' }, auth, req),
		).rejects.toMatchObject({ code: -32602, message: expect.stringContaining('list_animations') });
	});

	// The signature index comes back from JSON.parse and carries Object.prototype,
	// so an inherited member name must not read as a clip.
	it('does not resolve an inherited Object member as a clip', async () => {
		for (const clip of ['constructor', 'toString', '__proto__']) {
			await expect(tool('animation_signature').handler({ clip }, auth, req)).rejects.toMatchObject(
				{ code: -32602 },
			);
		}
	});

	it('rejects a slot that is not a runtime slot', async () => {
		await expect(
			tool('animation_signature').handler({ clip: 'idle', slot: 'nonsense' }, auth, req),
		).rejects.toMatchObject({ code: -32602, message: expect.stringContaining('Slots:') });
	});
});

describe('find_similar_animations', () => {
	it('ranks neighbours by measured-motion distance, nearest first', async () => {
		const out = await tool('find_similar_animations').handler(
			{ clip: 'idle', limit: 3 },
			auth,
			req,
		);
		const { clip, similar } = out.structuredContent;
		expect(clip).toBe('idle');
		expect(similar).toHaveLength(3);
		expect(similar.map((m) => m.clip)).not.toContain('idle');
		const distances = similar.map((m) => m.distance);
		expect([...distances].sort((a, b) => a - b)).toEqual(distances);
		expect(out.content[0].text).toContain('nearest to idle');
	});

	it('clamps the limit into the documented 1..20 range', async () => {
		const out = await tool('find_similar_animations').handler({ clip: 'idle', limit: 999 }, auth, req);
		expect(out.structuredContent.similar).toHaveLength(20);
	});

	it('rejects an unknown reference clip with invalid-params', async () => {
		await expect(
			tool('find_similar_animations').handler({ clip: 'not-a-clip' }, auth, req),
		).rejects.toMatchObject({ code: -32602 });
	});

	it('throws when the signature index cannot be fetched', async () => {
		await expect(
			tool('find_similar_animations').handler({ clip: 'idle' }, auth, missingReq),
		).rejects.toThrow(/signatures fetch failed \(HTTP 404\)/);
	});
});

describe('apply_animation', () => {
	// Failure path only: the success path fetches a caller-supplied rigged GLB
	// over the SSRF-hardened fetcher, which by design refuses a loopback URL, so
	// a real retarget belongs to the browser/pose suites rather than here.
	it('rejects an unknown preset before fetching the caller model', async () => {
		await expect(
			tool('apply_animation').handler(
				{ model_url: 'https://three.ws/models/rig.glb', animation: 'not-a-preset' },
				auth,
				req,
			),
		).rejects.toMatchObject({
			code: -32602,
			data: { hint: 'call list_animations for valid names' },
		});
	});

	it('refuses a non-public model URL (SSRF guard) rather than fetching it', async () => {
		await expect(
			tool('apply_animation').handler(
				{ model_url: 'http://169.254.169.254/latest/meta-data/', animation: 'idle' },
				auth,
				req,
			),
		).rejects.toThrow(/fetch failed/);
	});
});

describe('text_to_animation', () => {
	// The motion model lives on the GPU worker; with no worker configured the
	// tool must say so rather than fabricate a clip.
	it('reports that generation is unconfigured instead of inventing motion', async () => {
		const saved = process.env.GCP_TEXT2MOTION_URL;
		delete process.env.GCP_TEXT2MOTION_URL;
		try {
			await expect(
				tool('text_to_animation').handler(
					{ prompt: 'a celebratory jump', model_url: 'https://three.ws/models/rig.glb' },
					auth,
					req,
				),
			).rejects.toMatchObject({ code: -32001 });
		} finally {
			if (saved === undefined) delete process.env.GCP_TEXT2MOTION_URL;
			else process.env.GCP_TEXT2MOTION_URL = saved;
		}
	});
});
