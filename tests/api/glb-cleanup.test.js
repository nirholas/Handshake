/**
 * Geometry cleanup pass (api/_lib/glb-cleanup.js).
 *
 * Runs the REAL @gltf-transform + meshoptimizer pipeline against an actual
 * shipped GLB (public/avatars/fox.glb) — no mocks — and pins the contract the
 * forge delivery path relies on: the output is a valid, smaller-or-equal,
 * still-INDEXED mesh (never the de-indexed vertex explosion a naive normals
 * recompute would cause), and a broken buffer throws rather than corrupting.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanupGlb } from '../../api/_lib/glb-cleanup.js';

const FOX_GLB = readFileSync(resolve(process.cwd(), 'public/avatars/fox.glb'));

describe('cleanupGlb', () => {
	it('produces a smaller, valid GLB with no more triangles than the input', async () => {
		const r = await cleanupGlb(FOX_GLB);
		// A real glTF binary header (magic 0x46546C67 = "glTF").
		expect(r.buffer.readUInt32LE(0)).toBe(0x46546c67);
		expect(r.trisAfter).toBeLessThanOrEqual(r.trisBefore);
		expect(r.trisBefore).toBeGreaterThan(0);
		expect(r.outputBytes).toBeLessThanOrEqual(r.inputBytes);
		expect(r.grew).toBe(false);
	});

	it('stays indexed: never explodes vertices past the triangle-times-three ceiling', async () => {
		// The de-indexed failure mode (flat-normal recompute) yields exactly
		// 3 vertices per triangle. A properly welded mesh stays well under that.
		const r = await cleanupGlb(FOX_GLB);
		expect(r.vertsAfter).toBeLessThan(r.trisAfter * 3);
		expect(r.vertsAfter).toBeLessThanOrEqual(r.vertsBefore);
	});

	it('honors simplify:false — topological cleanup only, no decimation', async () => {
		const r = await cleanupGlb(FOX_GLB, { simplify: false });
		expect(r.simplified).toBe(false);
		// weld/dedup/join can only hold or reduce the triangle count, never raise it.
		expect(r.trisAfter).toBeLessThanOrEqual(r.trisBefore);
	});

	it('decimates a dense mesh when above the simplify threshold', async () => {
		// Force the simplifier on with a low threshold so the fox qualifies, and a
		// conservative ratio: the triangle count must drop.
		const r = await cleanupGlb(FOX_GLB, { simplifyMinTris: 1, simplifyRatio: 0.5 });
		expect(r.simplified).toBe(true);
		expect(r.trisAfter).toBeLessThan(r.trisBefore);
	});

	it('throws on a non-GLB buffer so the caller ships the original', async () => {
		await expect(cleanupGlb(Buffer.from('not a glb'))).rejects.toThrow();
		await expect(cleanupGlb(null)).rejects.toThrow();
	});
});
