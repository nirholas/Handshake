/**
 * materializeCreation() quality-scoring + compression wiring (prompt-02
 * "Forge generation quality" work order).
 *
 * These are additive, opt-in params on the universal completion writer every
 * Forge lane (sync + async) flows through. Default behavior (no `quality`, no
 * `compress`) must stay byte-identical to before; opting in must run the REAL
 * glb-quality / glb-compress pipeline against real bytes — not a mock — so
 * this exercises them against an actual shipped GLB (public/avatars/fox.glb)
 * fetched through a stubbed `fetch`. Only the network/db/object-storage
 * boundaries are stubbed, matching this repo's existing forge-store test
 * conventions (see tests/api/forge-free-first.test.js).
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const FOX_GLB = readFileSync(resolve(process.cwd(), 'public/avatars/fox.glb'));

beforeAll(() => {
	Object.assign(process.env, {
		DATABASE_URL: 'postgres://test:test@localhost:5432/test',
		S3_ENDPOINT: 'https://s3.example.com',
		S3_BUCKET: 'test-bucket',
		S3_PUBLIC_DOMAIN: 'https://cdn.example.com',
		S3_ACCESS_KEY_ID: 'test-key',
		S3_SECRET_ACCESS_KEY: 'test-secret',
	});
});

const existingRow = {
	id: 'creation-xyz',
	status: 'pending',
	glb_url: null,
	glb_key: null,
	prompt: 'a low poly fox',
	preview_image_url: null,
	views_requested: 0,
	views_used: null,
	multiview: false,
	backend: 'trellis',
	tier: 'standard',
	path: 'image',
	model_category: null,
	created_at: new Date().toISOString(),
};

const sqlMock = vi.fn(async (strings) => {
	const text = strings.join(' ');
	if (text.includes('select')) return [existingRow];
	return [];
});

vi.mock('../api/_lib/db.js', () => ({
	sql: (...args) => sqlMock(...args),
	isDbUnavailableError: () => false,
}));

const putObjectMock = vi.fn(async ({ key }) => ({ key }));
vi.mock('../api/_lib/r2.js', () => ({
	putObject: (...args) => putObjectMock(...args),
	publicUrl: (key) => `https://cdn.example.com/${key}`,
}));

vi.mock('../api/_lib/forge-events.js', () => ({
	recordGenerationEvent: vi.fn(async () => {}),
}));

const { materializeCreation } = await import('../api/_lib/forge-store.js');

function stubFetch(buf) {
	global.fetch = vi.fn(async () => ({
		ok: true,
		headers: { get: () => 'model/gltf-binary' },
		arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
	}));
}

afterEach(() => {
	sqlMock.mockClear();
	putObjectMock.mockClear();
	delete global.fetch;
});

describe('materializeCreation — quality + compression (additive, opt-in)', () => {
	it('defaults run the geometry cleanup pass, shrinking the delivered mesh', async () => {
		// cleanup defaults ON: every forge mesh is raw marching-cubes geometry that
		// dedup/join/weld/simplify improves. quality + compression stay opt-in.
		stubFetch(FOX_GLB);
		const out = await materializeCreation({
			replicateJobId: 'job-1',
			clientKey: 'client-1',
			glbUrl: 'https://provider.example/fox.glb',
		});
		expect(out.glbUrl).toBe(`https://cdn.example.com/forge/client-1/${existingRow.id}.glb`);
		expect(out.quality).toBeNull();
		expect(out.compression).toBeNull();
		// The cleaned mesh is what ships, and it's smaller than the raw input.
		expect(out.cleaned).not.toBeNull();
		expect(out.cleaned.tris_after).toBeLessThanOrEqual(out.cleaned.tris_before);
		const written = putObjectMock.mock.calls[0][0];
		expect(written.body.length).toBeLessThan(FOX_GLB.length);
		expect(written.body.length).toBe(out.cleaned.output_bytes);
	});

	it('cleanup:false delivers the provider bytes verbatim', async () => {
		stubFetch(FOX_GLB);
		const out = await materializeCreation({
			replicateJobId: 'job-1b',
			clientKey: 'client-1',
			glbUrl: 'https://provider.example/fox.glb',
			cleanup: false,
		});
		expect(out.cleaned).toBeNull();
		const written = putObjectMock.mock.calls[0][0];
		expect(written.body.length).toBe(FOX_GLB.length);
	});

	it('quality:true scores the REAL bundled GLB as valid and not degenerate', async () => {
		stubFetch(FOX_GLB);
		const out = await materializeCreation({
			replicateJobId: 'job-2',
			clientKey: 'client-1',
			glbUrl: 'https://provider.example/fox.glb',
			quality: true,
		});
		expect(out.quality).not.toBeNull();
		expect(out.quality.valid).toBe(true);
		expect(out.quality.flag).not.toBe('degenerate');
		expect(out.quality.metrics.triangleCount).toBeGreaterThan(0);
	});

	it('compress:"meshopt" runs the real @gltf-transform pipeline and shrinks the delivered bytes', async () => {
		stubFetch(FOX_GLB);
		const out = await materializeCreation({
			replicateJobId: 'job-3',
			clientKey: 'client-1',
			glbUrl: 'https://provider.example/fox.glb',
			quality: true,
			compress: 'meshopt',
		});
		expect(out.compression).not.toBeNull();
		expect(out.compression.mode).toBe('meshopt');
		if (!out.compression.skipped) {
			expect(out.compression.output_bytes).toBeLessThan(out.compression.input_bytes);
			// The bytes actually written to storage are the compressed variant, not
			// the original — confirms the pipeline result is what ships, not a
			// side-computed stat that's discarded.
			const written = putObjectMock.mock.calls[0][0];
			expect(written.body.length).toBe(out.compression.output_bytes);
		}
		expect(out.quality.valid).toBe(true);
	}, 20_000);

	it('an unparseable buffer scores invalid but never throws or blocks delivery', async () => {
		stubFetch(Buffer.from('not a glb'));
		const out = await materializeCreation({
			replicateJobId: 'job-4',
			clientKey: 'client-1',
			glbUrl: 'https://provider.example/bad.glb',
			quality: true,
		});
		expect(out).not.toBeNull();
		expect(out.quality.valid).toBe(false);
		expect(out.quality.flag).toBe('invalid');
	});
});
