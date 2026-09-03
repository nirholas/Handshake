/**
 * Tests for api/_lib/material-studio-store.js — the Material Studio server core
 * (AI PBR restyle + seeded colorway variants + persistence).
 *
 * The network/credential boundary is stubbed (R2 upload, watsonx.ai, and the
 * SSRF DNS check), but everything else runs for REAL against a real GLB
 * fixture (public/avatars/fox.glb): the glTF-Transform document is actually
 * loaded, materials actually mutated, the output actually re-serialized and
 * run through the real Khronos gltf-validator. This is the offline stand-in
 * for a live end-to-end call — same philosophy as tests/api/x402-pipeline.test.js.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const FIXTURE_GLB_PATH = resolve(process.cwd(), 'public/avatars/fox.glb');
const FIXTURE_URL = 'https://three.ws/cdn/fixtures/fox.glb';

let fixtureBytes;
let uploadedObjects;
let watsonxReply;

// The stand-in CDN origin these tests assert against. publicUrl() is mocked
// away entirely, so the real S3_PUBLIC_DOMAIN never applies here; what matters
// is that every URL assertion below is anchored to the SAME base the mock
// returns. Three of them once hardcoded a different host and silently failed
// the moment the mock's base changed.
const CDN_BASE = 'https://three.ws/cdn';
/** Matches a persisted object URL under `prefix`, e.g. material-studio/restyle. */
const persistedGlbUrl = (prefix) =>
	new RegExp(`^${CDN_BASE.replace(/[.\\/]/g, '\\$&')}/${prefix}/.+\\.glb$`);

vi.mock('../../api/_lib/r2.js', () => ({
	putObject: vi.fn(async ({ key, body }) => {
		uploadedObjects.push({ key, bytes: body.length ?? body.byteLength, body: Buffer.from(body) });
	}),
	publicUrl: vi.fn((key) => `https://three.ws/cdn/${key}`),
}));

vi.mock('../../api/_lib/ssrf.js', () => ({
	assertPublicHttpsUrl: vi.fn(async (url) => url),
}));

// material-studio-store.js fetches through the pinned SSRF guard (raw
// sockets). Route it through the per-test fetch stub, enforcing opts.maxBytes
// the way the real guard does.
vi.mock('../../api/_lib/ssrf-guard.js', async () => {
	const actual = await vi.importActual('../../api/_lib/ssrf-guard.js');
	return {
		...actual,
		fetchSafePublicUrlPinned: async (url, init, opts) => {
			const resp = await globalThis.fetch(url, init);
			if (opts?.maxBytes == null) return resp;
			const buf = await resp.arrayBuffer();
			if (buf.byteLength > opts.maxBytes) {
				throw new actual.MaxBytesExceededError(buf.byteLength, opts.maxBytes);
			}
			return {
				ok: resp.ok,
				status: resp.status,
				headers: resp.headers ?? new Headers(),
				arrayBuffer: async () => buf,
				text: async () => Buffer.from(buf).toString('utf8'),
			};
		},
	};
});

vi.mock('../../api/_lib/watsonx.js', () => ({
	watsonxConfig: vi.fn(() => ({ configured: true, chatModel: 'ibm/granite-3-8b-instruct' })),
	watsonxChatComplete: vi.fn(async () => ({
		text: JSON.stringify(watsonxReply),
		model: 'ibm/granite-3-8b-instruct',
		usage: { total_tokens: 42 },
	})),
}));

// The second rung of the restyle author chain. Granite leads, but a deployment
// with no IBM key must still restyle through the shared free-first chain rather
// than answering a dead 503. That is the behaviour the two fallback tests pin.
vi.mock('../../api/_lib/llm.js', () => ({
	llmComplete: vi.fn(async () => ({
		text: JSON.stringify(watsonxReply),
		model: 'free-chain/test-model',
	})),
}));

beforeEach(() => {
	// Call counts leak across tests otherwise, and the author-chain tests below
	// assert exactly which rung ran. mockClear keeps the factory implementations.
	vi.clearAllMocks();
	uploadedObjects = [];
	fixtureBytes = readFileSync(FIXTURE_GLB_PATH);
	watsonxReply = {
		name: 'Polished chrome',
		baseColorFactor: [0.79, 0.81, 0.83],
		metallicFactor: 1,
		roughnessFactor: 0.05,
		emissiveFactor: [0, 0, 0],
		notes: 'a bright, reflective chrome finish',
	};
	global.fetch = vi.fn(async (url) => {
		if (url === FIXTURE_URL) {
			return { ok: true, status: 200, arrayBuffer: async () => fixtureBytes.buffer.slice(fixtureBytes.byteOffset, fixtureBytes.byteOffset + fixtureBytes.byteLength) };
		}
		throw new Error(`unexpected fetch: ${url}`);
	});
});

describe('restyleMaterialFromInstruction', () => {
	it('applies AI-proposed PBR factors, persists a valid GLB, and seeds a lineage', async () => {
		const { restyleMaterialFromInstruction } = await import('../../api/_lib/material-studio-store.js');
		const result = await restyleMaterialFromInstruction({
			glbUrl: FIXTURE_URL,
			instruction: 'make it chrome',
		});

		expect(result.glbUrl).toMatch(persistedGlbUrl('material-studio/restyle'));
		expect(result.sourceGlbUrl).toBe(FIXTURE_URL);
		expect(result.factors.metallicFactor).toBe(1);
		expect(result.materialsEdited).toBeGreaterThan(0);
		expect(uploadedObjects).toHaveLength(1);
		// magic bytes of the persisted output really are a binary glTF
		expect(uploadedObjects[0].bytes).toBeGreaterThan(12);

		// Lineage: origin (index 0) → restyle (index 1), immutable + well-formed.
		expect(result.lineage).toHaveLength(2);
		expect(result.lineage[0]).toMatchObject({ index: 0, parentIndex: null, glbUrl: FIXTURE_URL, refKind: 'origin' });
		expect(result.lineage[1]).toMatchObject({
			index: 1,
			parentIndex: 0,
			glbUrl: result.glbUrl,
			instruction: 'make it chrome',
			refKind: 'restyle',
		});
		expect(result.activeIndex).toBe(1);
	});

	it('extends a caller-supplied parent_lineage instead of starting fresh', async () => {
		const { restyleMaterialFromInstruction } = await import('../../api/_lib/material-studio-store.js');
		const parentLineage = [
			{ index: 0, parentIndex: null, glbUrl: FIXTURE_URL, refKind: 'origin' },
			{ index: 1, parentIndex: 0, glbUrl: 'https://three.ws/cdn/material-studio/variants/abc.glb', instruction: 'Chrome 3', refKind: 'variant' },
		];
		const result = await restyleMaterialFromInstruction({
			glbUrl: FIXTURE_URL,
			instruction: 'wooden',
			parentLineage,
		});

		expect(result.lineage).toHaveLength(3);
		expect(result.lineage[2]).toMatchObject({ index: 2, parentIndex: 1, instruction: 'wooden', refKind: 'restyle' });
	});

	it('rejects a malformed parent_lineage by falling back to a fresh one rather than corrupting history', async () => {
		const { restyleMaterialFromInstruction } = await import('../../api/_lib/material-studio-store.js');
		const corrupt = [{ index: 0, parentIndex: null, glbUrl: FIXTURE_URL, refKind: 'origin' }, { index: 5, parentIndex: 99, glbUrl: 'x', refKind: 'text' }];
		const result = await restyleMaterialFromInstruction({ glbUrl: FIXTURE_URL, instruction: 'gold', parentLineage: corrupt });
		expect(result.lineage).toHaveLength(2);
		expect(result.lineage[0].glbUrl).toBe(FIXTURE_URL);
	});

	it('restyles through the free-first LLM chain when watsonx has no credentials', async () => {
		const { watsonxConfig, watsonxChatComplete } = await import('../../api/_lib/watsonx.js');
		const { llmComplete } = await import('../../api/_lib/llm.js');
		watsonxConfig.mockReturnValueOnce({ configured: false });
		const { restyleMaterialFromInstruction } = await import('../../api/_lib/material-studio-store.js');
		const result = await restyleMaterialFromInstruction({ glbUrl: FIXTURE_URL, instruction: 'chrome' });
		// Granite is skipped entirely, the fallback rung answers, and a real
		// restyled GLB is persisted, with no 503 on a deployment lacking an IBM key.
		expect(watsonxChatComplete).not.toHaveBeenCalled();
		expect(llmComplete).toHaveBeenCalledTimes(1);
		expect(result.glbUrl).toMatch(persistedGlbUrl('material-studio/restyle'));
		expect(uploadedObjects).toHaveLength(1);
	});

	it('falls back to the LLM chain when watsonx is configured but throws', async () => {
		const { watsonxChatComplete } = await import('../../api/_lib/watsonx.js');
		const { llmComplete } = await import('../../api/_lib/llm.js');
		watsonxChatComplete.mockRejectedValueOnce(new Error('watsonx 502'));
		const { restyleMaterialFromInstruction } = await import('../../api/_lib/material-studio-store.js');
		const result = await restyleMaterialFromInstruction({ glbUrl: FIXTURE_URL, instruction: 'chrome' });
		expect(llmComplete).toHaveBeenCalledTimes(1);
		expect(result.glbUrl).toMatch(persistedGlbUrl('material-studio/restyle'));
	});

	it('errors with no_provider only when BOTH author rungs are unavailable, without persisting anything', async () => {
		const { watsonxConfig } = await import('../../api/_lib/watsonx.js');
		const { llmComplete } = await import('../../api/_lib/llm.js');
		watsonxConfig.mockReturnValueOnce({ configured: false });
		llmComplete.mockRejectedValueOnce(new Error('no provider is configured'));
		const { restyleMaterialFromInstruction } = await import('../../api/_lib/material-studio-store.js');
		await expect(restyleMaterialFromInstruction({ glbUrl: FIXTURE_URL, instruction: 'chrome' })).rejects.toMatchObject({
			code: 'no_provider',
			status: 503,
		});
		expect(uploadedObjects).toHaveLength(0);
	});

	it('rejects a too-short instruction before any network call', async () => {
		const { restyleMaterialFromInstruction } = await import('../../api/_lib/material-studio-store.js');
		await expect(restyleMaterialFromInstruction({ glbUrl: FIXTURE_URL, instruction: 'x' })).rejects.toMatchObject({
			code: 'invalid_instruction',
		});
		expect(uploadedObjects).toHaveLength(0);
	});

	it('applies clearcoat + transmission + sheen as real KHR material extensions and the output still validates', async () => {
		watsonxReply = {
			name: 'Wet car paint over frosted glass trim',
			baseColorFactor: [0.55, 0.05, 0.08],
			metallicFactor: 0.6,
			roughnessFactor: 0.35,
			emissiveFactor: [0, 0, 0],
			clearcoatFactor: 1,
			clearcoatRoughnessFactor: 0.03,
			transmissionFactor: 0.9,
			ior: 1.45,
			sheenColorFactor: [0.9, 0.9, 0.95],
			sheenRoughnessFactor: 0.5,
			notes: 'glossy lacquered paint with a frosted glass accent',
		};
		const { restyleMaterialFromInstruction } = await import('../../api/_lib/material-studio-store.js');
		const result = await restyleMaterialFromInstruction({
			glbUrl: FIXTURE_URL,
			instruction: 'car paint with a frosted glass trim',
		});

		expect(result.factors.clearcoatFactor).toBe(1);
		expect(result.factors.transmissionFactor).toBe(0.9);
		expect(result.factors.ior).toBe(1.45);
		expect(uploadedObjects).toHaveLength(1); // gltf-validator (writeAndValidate) passed

		// Re-parse the persisted bytes and confirm the extensions actually landed
		// on the material, not just in the returned `factors` echo.
		const { NodeIO } = await import('@gltf-transform/core');
		const { ALL_EXTENSIONS } = await import('@gltf-transform/extensions');
		const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
		const doc = await io.readBinary(new Uint8Array(uploadedObjects[0].body));
		const mat = doc.getRoot().listMaterials()[0];
		const clearcoat = mat.getExtension('KHR_materials_clearcoat');
		const transmission = mat.getExtension('KHR_materials_transmission');
		const ior = mat.getExtension('KHR_materials_ior');
		const sheen = mat.getExtension('KHR_materials_sheen');
		expect(clearcoat?.getClearcoatFactor()).toBeCloseTo(1);
		expect(clearcoat?.getClearcoatRoughnessFactor()).toBeCloseTo(0.03);
		expect(transmission?.getTransmissionFactor()).toBeCloseTo(0.9);
		expect(ior?.getIOR()).toBeCloseTo(1.45);
		expect(sheen?.getSheenRoughnessFactor()).toBeCloseTo(0.5);
	});
});

describe('generateSeededVariants', () => {
	it('is deterministic — the same preset + seed produce byte-identical factor sets across two runs', async () => {
		const { generateSeededVariants } = await import('../../api/_lib/material-studio-store.js');
		const a = await generateSeededVariants({ glbUrl: FIXTURE_URL, preset: 'gold', seed: 7, count: 3 });
		uploadedObjects = [];
		const b = await generateSeededVariants({ glbUrl: FIXTURE_URL, preset: 'gold', seed: 7, count: 3 });

		expect(a.variants).toHaveLength(3);
		expect(a.variants.map((v) => v.config.color)).toEqual(b.variants.map((v) => v.config.color));
		expect(a.variants.map((v) => v.seed)).toEqual(b.variants.map((v) => v.seed));
		for (const v of a.variants) expect(v.glbUrl).toMatch(persistedGlbUrl('material-studio/variants'));
	});

	it('fans every variant off the SAME shared parent rather than chaining them', async () => {
		const { generateSeededVariants } = await import('../../api/_lib/material-studio-store.js');
		const result = await generateSeededVariants({ glbUrl: FIXTURE_URL, preset: 'chrome', seed: 1, count: 4 });
		const nonOrigin = result.lineage.filter((v) => v.refKind === 'variant');
		expect(nonOrigin).toHaveLength(4);
		const parentIndices = new Set(nonOrigin.map((v) => v.parentIndex));
		expect(parentIndices.size).toBe(1); // all siblings, one shared parent
		expect([...parentIndices][0]).toBe(result.activeIndex);
	});

	it('rejects an unknown preset', async () => {
		const { generateSeededVariants } = await import('../../api/_lib/material-studio-store.js');
		await expect(generateSeededVariants({ glbUrl: FIXTURE_URL, preset: 'unobtainium' })).rejects.toMatchObject({
			code: 'invalid_preset',
		});
	});

	it('carries the carPaint preset clearcoat through to the persisted GLB as a real extension', async () => {
		const { generateSeededVariants } = await import('../../api/_lib/material-studio-store.js');
		const result = await generateSeededVariants({ glbUrl: FIXTURE_URL, preset: 'carPaint', seed: 3, count: 1 });
		expect(uploadedObjects).toHaveLength(1);

		const { NodeIO } = await import('@gltf-transform/core');
		const { ALL_EXTENSIONS } = await import('@gltf-transform/extensions');
		const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
		const doc = await io.readBinary(new Uint8Array(uploadedObjects[0].body));
		const clearcoat = doc.getRoot().listMaterials()[0].getExtension('KHR_materials_clearcoat');
		expect(clearcoat?.getClearcoatFactor()).toBeCloseTo(1);
		expect(result.variants[0].config.clearcoat).toBe(1);
	});

	it('clamps an out-of-range count into [1, 12]', async () => {
		const { generateSeededVariants } = await import('../../api/_lib/material-studio-store.js');
		const result = await generateSeededVariants({ glbUrl: FIXTURE_URL, preset: 'wood', seed: 2, count: 999 });
		expect(result.variants).toHaveLength(12);
	});
});

describe('validateAndPersistGlb', () => {
	it('accepts a real GLB and rejects non-GLB bytes', async () => {
		const { validateAndPersistGlb, MaterialStudioError } = await import('../../api/_lib/material-studio-store.js');
		const good = await validateAndPersistGlb(fixtureBytes, { keyPrefix: 'material-studio/checkpoints' });
		expect(good.url).toMatch(persistedGlbUrl('material-studio/checkpoints'));

		await expect(validateAndPersistGlb(Buffer.from('not a glb'))).rejects.toBeInstanceOf(MaterialStudioError);
	});
});

describe('meshopt-compressed sources', () => {
	/** The fixture, re-encoded with EXT_meshopt_compression, as three.ws ships avatars. */
	async function compressFixture() {
		const { NodeIO } = await import('@gltf-transform/core');
		const { ALL_EXTENSIONS, EXTMeshoptCompression } = await import('@gltf-transform/extensions');
		const { MeshoptDecoder, MeshoptEncoder } = await import('meshoptimizer');
		await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready]);
		const io = new NodeIO()
			.registerExtensions(ALL_EXTENSIONS)
			.registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
		const doc = await io.readBinary(new Uint8Array(fixtureBytes));
		doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
		return Buffer.from(await io.writeBinary(doc));
	}

	it('restyles a compressed avatar instead of rejecting it as an invalid GLB', async () => {
		// Regression: the reader registered the extension but never the codec, so
		// every compressed source (most three.ws avatars) died as "failed to parse".
		fixtureBytes = await compressFixture();
		const { NodeIO } = await import('@gltf-transform/core');
		const { ALL_EXTENSIONS } = await import('@gltf-transform/extensions');
		const bare = new NodeIO().registerExtensions(ALL_EXTENSIONS);
		await expect(bare.readBinary(new Uint8Array(fixtureBytes))).rejects.toBeTruthy();

		const { restyleMaterialFromInstruction } = await import('../../api/_lib/material-studio-store.js');
		const result = await restyleMaterialFromInstruction({
			glbUrl: FIXTURE_URL,
			instruction: 'make it chrome',
		});

		expect(result.glbUrl).toMatch(persistedGlbUrl('material-studio/restyle'));
		expect(result.materialsEdited).toBeGreaterThan(0);
		expect(uploadedObjects).toHaveLength(1);
	});
});
