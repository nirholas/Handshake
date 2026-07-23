/**
 * Tests for the paid 3D-pipeline x402 stages (api/x402/pipeline-*.js) and their
 * shared execution rail (api/_lib/pipeline-stage.js).
 *
 * The GCP Cloud Run workers these stages drive are external and env-gated, so the
 * worker itself is exercised by its own worker suites. What's tested here is the
 * wrapper contract that guarantees a buyer is never charged for a failed stage:
 *   - input validation (bad URL → 400, non-GLB/non-image → 415),
 *   - the discovery schema each route publishes is present and valid,
 *   - price resolution flows through priceFor (env-overridable),
 *   - the stage-lane boundary (submit → poll → validate → persist) against real
 *     captured worker response shapes, injected via the runStageJob provider
 *     seam so no live Cloud Run service is needed.
 */

import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

// pipeline-stage.js fetches through the pinned SSRF guard (raw sockets, no
// sandbox egress). Route the guard through the per-test fetch spy so those
// staged responses stay authoritative, and enforce opts.maxBytes the way the
// real guard does so the byte-cap branches keep their meaning.
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

import {
	StageError,
	isGlbMagic,
	isImageMagic,
	validateAssetUrl,
	sniffRemoteAsset,
	runStageJob,
	persistStageOutput,
	stageObjectKey,
	readJsonBody,
} from '../../api/_lib/pipeline-stage.js';
import { priceFor } from '../../api/_lib/x402-prices.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// A real committed GLB — its first bytes are the authentic "glTF" magic header.
const REAL_GLB = readFileSync(resolve(__dirname, '../_fixtures/club-venue.glb'));
const REAL_GLB_HEAD = new Uint8Array(REAL_GLB.subarray(0, 64));
// A real PNG magic prefix (89 50 4E 47 0D 0A 1A 0A) padded to 64 bytes.
const REAL_PNG_HEAD = new Uint8Array(64);
REAL_PNG_HEAD.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
// An HTML page — the classic "wrong asset behind a URL" case.
const HTML_HEAD = new Uint8Array(Buffer.from('<!doctype html><html><head><title>nope', 'utf8'));

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

// Each shipped stage: slug, default price atomics, and the worker mode it drives.
const STAGES = [
	{ slug: 'pipeline-rig', price: '50000', mode: 'rerig', module: '../../api/x402/pipeline-rig.js' },
	{ slug: 'pipeline-remesh', price: '30000', mode: 'remesh', module: '../../api/x402/pipeline-remesh.js' },
	{ slug: 'pipeline-gameready', price: '30000', mode: 'remesh', module: '../../api/x402/pipeline-gameready.js' },
	{ slug: 'pipeline-stylize', price: '30000', mode: 'stylize', module: '../../api/x402/pipeline-stylize.js' },
	{ slug: 'pipeline-rembg', price: '10000', mode: 'rembg', module: '../../api/x402/pipeline-rembg.js' },
];

beforeAll(() => {
	// The 402 challenge + price plumbing read these at import; set before loading routes.
	Object.assign(process.env, {
		APP_ORIGIN: 'https://three.ws',
		X402_PAY_TO_SOLANA: 'THREEsynthetic1111111111111111111111111111',
		X402_ASSET_MINT_SOLANA: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
		X402_FEE_PAYER_SOLANA: 'THREEfeepayer11111111111111111111111111111',
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	delete process.env.X402_PRICE_PIPELINE_REMESH;
});

// ── Magic-byte predicates (real captured bytes) ─────────────────────────────
describe('asset magic-byte predicates', () => {
	it('recognizes a real GLB header and rejects non-GLB bytes', () => {
		expect(isGlbMagic(REAL_GLB_HEAD)).toBe(true);
		expect(isGlbMagic(HTML_HEAD)).toBe(false);
		expect(isGlbMagic(REAL_PNG_HEAD)).toBe(false);
		expect(isGlbMagic(new Uint8Array(4))).toBe(false); // too short
	});
	it('recognizes a real PNG header and rejects a GLB posing as an image', () => {
		expect(isImageMagic(REAL_PNG_HEAD)).toBe(true);
		expect(isImageMagic(REAL_GLB_HEAD)).toBe(false);
	});
});

// ── Input validation: bad URL → 400 ─────────────────────────────────────────
describe('validateAssetUrl rejects bad input with 400', () => {
	it('rejects an empty url', async () => {
		await expect(validateAssetUrl('', 'glb_url')).rejects.toMatchObject({ status: 400, code: 'missing_url' });
	});
	it('rejects a non-http scheme', async () => {
		await expect(validateAssetUrl('ftp://example.com/a.glb', 'glb_url')).rejects.toMatchObject({
			status: 400,
			code: 'invalid_url',
		});
	});
	it('rejects a non-URL string', async () => {
		await expect(validateAssetUrl('not a url', 'glb_url')).rejects.toMatchObject({ status: 400, code: 'invalid_url' });
	});
});

// ── Input validation: non-GLB/non-image → 415 ───────────────────────────────
describe('sniffRemoteAsset enforces the expected media type', () => {
	function stubFetch(head) {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue({
			ok: true,
			status: 206,
			arrayBuffer: async () => head.buffer.slice(head.byteOffset, head.byteOffset + head.byteLength),
		});
	}
	it('passes a real GLB', async () => {
		stubFetch(REAL_GLB_HEAD);
		await expect(sniffRemoteAsset('https://three.ws/x.glb', 'glb')).resolves.toBe(true);
	});
	it('rejects an HTML page fed as a GLB with 415', async () => {
		stubFetch(HTML_HEAD);
		await expect(sniffRemoteAsset('https://three.ws/x.glb', 'glb')).rejects.toMatchObject({
			status: 415,
			code: 'unsupported_media_type',
		});
	});
	it('rejects a GLB fed as an image with 415', async () => {
		stubFetch(REAL_GLB_HEAD);
		await expect(sniffRemoteAsset('https://three.ws/x.png', 'image')).rejects.toMatchObject({
			status: 415,
			code: 'unsupported_media_type',
		});
	});
	it('maps an upstream 404 to a clean 404, not a charge', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) });
		await expect(sniffRemoteAsset('https://three.ws/missing.glb', 'glb')).rejects.toMatchObject({ status: 404 });
	});
});

// ── Stage-lane boundary against captured worker shapes ──────────────────────
describe('runStageJob poll-to-completion boundary (fixture-backed)', () => {
	// A real captured "done" shape from the gcp provider's status() for a remesh
	// job (see api/_providers/gcp.js status() → resultGlbUrl + telemetry).
	const DONE_REMESH = {
		status: 'done',
		resultGlbUrl: 'https://storage.googleapis.com/three-workers/remesh/out.glb',
		faceCount: 20000,
		quadRatio: 0.98,
		textured: true,
		mode: 'quad',
	};

	function fakeProvider({ statuses }) {
		let i = 0;
		return {
			supportsMode: () => true,
			submit: vi.fn(async () => ({ extJobId: 'ext-job-1', eta: 30 })),
			status: vi.fn(async () => statuses[Math.min(i++, statuses.length - 1)]),
		};
	}

	it('returns the finished result once the worker reports done', async () => {
		const provider = fakeProvider({ statuses: [{ status: 'running' }, DONE_REMESH] });
		const out = await runStageJob({
			mode: 'remesh',
			sourceUrl: 'https://three.ws/in.glb',
			params: { remesh_mode: 'quad' },
			provider,
			pollIntervalMs: 1,
			pollBudgetMs: 1000,
		});
		expect(out.resultGlbUrl).toBe(DONE_REMESH.resultGlbUrl);
		expect(out.faceCount).toBe(20000);
		expect(provider.submit).toHaveBeenCalledOnce();
	});

	it('throws (never settles) when the worker reports failed', async () => {
		const provider = fakeProvider({ statuses: [{ status: 'failed', error: 'mesh non-manifold' }] });
		await expect(
			runStageJob({ mode: 'remesh', sourceUrl: 'https://three.ws/in.glb', params: {}, provider, pollIntervalMs: 1 }),
		).rejects.toMatchObject({ status: 502, code: 'stage_failed' });
	});

	it('throws a 504 timeout when the worker never finishes inside the budget', async () => {
		const provider = fakeProvider({ statuses: [{ status: 'running' }] });
		await expect(
			runStageJob({
				mode: 'remesh',
				sourceUrl: 'https://three.ws/in.glb',
				params: {},
				provider,
				pollIntervalMs: 5,
				pollBudgetMs: 8,
			}),
		).rejects.toMatchObject({ status: 504, code: 'stage_timeout' });
	});

	it('throws 503 unconfigured when no worker URL is set (buyer not charged)', async () => {
		// No provider passed → real createRegenProvider() throws (GCP_RECONSTRUCTION_KEY unset).
		delete process.env.GCP_RECONSTRUCTION_KEY;
		await expect(
			runStageJob({ mode: 'remesh', sourceUrl: 'https://three.ws/in.glb', params: {} }),
		).rejects.toMatchObject({ status: 503, code: 'unconfigured' });
	});
});

// ── Output persistence + validation ─────────────────────────────────────────
describe('persistStageOutput validates and falls back cleanly', () => {
	it('returns the worker URL (persisted:false) when R2 is unconfigured, validating magic bytes', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue({
			ok: true,
			status: 200,
			arrayBuffer: async () => REAL_GLB.buffer.slice(REAL_GLB.byteOffset, REAL_GLB.byteOffset + REAL_GLB.byteLength),
		});
		const out = await persistStageOutput({
			resultUrl: 'https://worker/out.glb',
			key: 'x402-pipeline/remesh/abc.glb',
			kind: 'glb',
		});
		expect(out.url).toBe('https://worker/out.glb');
		expect(out.persisted).toBe(false);
		expect(out.bytes).toBe(REAL_GLB.length);
	});

	it('throws invalid_output when the worker returns non-GLB bytes', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue({
			ok: true,
			status: 200,
			arrayBuffer: async () => HTML_HEAD.buffer.slice(HTML_HEAD.byteOffset, HTML_HEAD.byteOffset + HTML_HEAD.byteLength),
		});
		await expect(
			persistStageOutput({ resultUrl: 'https://worker/out.glb', key: 'k.glb', kind: 'glb' }),
		).rejects.toMatchObject({ status: 502, code: 'invalid_output' });
	});

	it('throws no_output when the worker reports done with no URL', async () => {
		await expect(persistStageOutput({ resultUrl: null, key: 'k.glb', kind: 'glb' })).rejects.toMatchObject({
			code: 'no_output',
		});
	});
});

describe('stageObjectKey is stable + namespaced', () => {
	it('derives the same key for the same source and differs by stage', async () => {
		const a = await stageObjectKey({ stage: 'remesh', sourceUrl: 'https://three.ws/in.glb', ext: 'glb' });
		const b = await stageObjectKey({ stage: 'remesh', sourceUrl: 'https://three.ws/in.glb', ext: 'glb' });
		const c = await stageObjectKey({ stage: 'rig', sourceUrl: 'https://three.ws/in.glb', ext: 'glb' });
		expect(a).toBe(b);
		expect(a).not.toBe(c);
		expect(a.startsWith('x402-pipeline/remesh/')).toBe(true);
	});
});

// ── Price resolution via priceFor ───────────────────────────────────────────
describe('price resolution', () => {
	for (const { slug, price } of STAGES) {
		it(`${slug} defaults to ${price} atomics`, () => {
			expect(priceFor(slug, price)).toBe(price);
		});
	}
	it('honors an env override', () => {
		process.env.X402_PRICE_PIPELINE_REMESH = '99000';
		expect(priceFor('pipeline-remesh', '30000')).toBe('99000');
	});
});

// ── Discovery schema present + valid for every stage ────────────────────────
describe('discovery schema', () => {
	for (const stage of STAGES) {
		it(`${stage.slug} publishes a valid, priced, discoverable bazaar schema`, async () => {
			const mod = await import(stage.module);
			expect(typeof mod.default).toBe('function'); // paidEndpoint handler
			expect(mod.BAZAAR).toBeTruthy();
			expect(mod.BAZAAR.discoverable).toBe(true);
			expect(mod.BAZAAR.info).toBeTruthy();
			expect(mod.BAZAAR.schema).toBeTruthy();
			// Input + output JSON Schemas must compile.
			expect(() => ajv.compile(mod.INPUT_SCHEMA)).not.toThrow();
			const validateOut = ajv.compile(mod.OUTPUT_SCHEMA);
			// The advertised output.example must validate against the output schema —
			// exactly what x402scan / agentic.market render and rank on.
			expect(validateOut(mod.BAZAAR.info.output.example)).toBe(true);
		});
	}
});

describe('StageError shape', () => {
	it('carries status + code', () => {
		const e = new StageError('x', { status: 415, code: 'unsupported_media_type' });
		expect(e).toBeInstanceOf(Error);
		expect(e.status).toBe(415);
		expect(e.code).toBe('unsupported_media_type');
	});
});
