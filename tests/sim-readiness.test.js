import { describe, it, expect } from 'vitest';
import { Document, NodeIO } from '@gltf-transform/core';
import { gradeSimReadiness, SIM_READINESS_VERSION } from '../api/_lib/sim-readiness.js';

// Solids with analytically known mass properties, authored in-process so the
// expected values are derived from the shape's closed form rather than from a
// previous run of this same code. A cube of side s at unit density has
// V = s³, m = s³, and I_xx = I_yy = I_zz = m·(s² + s²)/12 = s⁵/6.
function cubeMesh(size, { open = false, flipOneTriangle = false } = {}) {
	const h = size / 2;
	const positions = [
		-h, -h, -h,  h, -h, -h,  h,  h, -h, -h,  h, -h,
		-h, -h,  h,  h, -h,  h,  h,  h,  h, -h,  h,  h,
	];
	const faces = [
		[0, 2, 1], [0, 3, 2],   // -Z
		[4, 5, 6], [4, 6, 7],   // +Z
		[0, 1, 5], [0, 5, 4],   // -Y
		[3, 7, 6], [3, 6, 2],   // +Y
		[0, 4, 7], [0, 7, 3],   // -X
		[1, 2, 6], [1, 6, 5],   // +X
	];
	if (open) faces.splice(0, 2);
	const indices = faces.flat();
	if (flipOneTriangle) {
		const [a, b, c] = indices.slice(0, 3);
		indices.splice(0, 3, a, c, b);
	}
	return { positions, indices };
}

async function glbFrom({ positions, indices }, { scaleNode = null } = {}) {
	const doc = new Document();
	const buffer = doc.createBuffer();
	const position = doc.createAccessor()
		.setType('VEC3')
		.setArray(new Float32Array(positions))
		.setBuffer(buffer);
	const index = doc.createAccessor()
		.setType('SCALAR')
		.setArray(new Uint16Array(indices))
		.setBuffer(buffer);
	const prim = doc.createPrimitive().setAttribute('POSITION', position).setIndices(index);
	const mesh = doc.createMesh('solid').addPrimitive(prim);
	const node = doc.createNode('solid').setMesh(mesh);
	if (scaleNode) node.setScale(scaleNode);
	doc.createScene('scene').addChild(node);
	return Buffer.from(await new NodeIO().writeBinary(doc));
}

describe('gradeSimReadiness', () => {
	it('grades a closed cube as simulation ready with exact mass properties', async () => {
		const report = await gradeSimReadiness(await glbFrom(cubeMesh(0.4)));

		expect(report.grader).toBe(SIM_READINESS_VERSION);
		expect(report.readable).toBe(true);
		expect(report.verdict).toBe('simulation_ready');
		expect(report.blockers).toEqual([]);
		expect(report.topology.watertight).toBe(true);
		expect(report.topology.boundaryEdges).toBe(0);
		expect(report.topology.nonManifoldEdges).toBe(0);
		expect(report.topology.inconsistentWindingEdges).toBe(0);

		// V = 0.4³ = 0.064 m³, and I = s⁵/6 = 0.01024/6 at unit density. glTF
		// stores POSITION as float32, so the achievable agreement with the closed
		// form is ~1e-7 relative, which is what these assert.
		expect(report.mass.volumeM3 / 0.064 - 1).toBeCloseTo(0, 6);
		expect(report.mass.massAtWaterDensityKg / 64 - 1).toBeCloseTo(0, 6);
		expect(report.mass.centroid[0]).toBeCloseTo(0, 7);
		const [ixx, ixy, , , iyy] = report.mass.inertiaUnitDensity;
		expect(ixx / (0.4 ** 5 / 6) - 1).toBeCloseTo(0, 6);
		expect(iyy / (0.4 ** 5 / 6) - 1).toBeCloseTo(0, 6);
		expect(ixy).toBeCloseTo(0, 9);

		// A cube is its own convex hull.
		expect(report.collision.convexityRatio).toBeCloseTo(1, 3);
		expect(report.collision.convexEnough).toBe(true);
	});

	it('applies node transforms before measuring, so scale is world space', async () => {
		const report = await gradeSimReadiness(await glbFrom(cubeMesh(0.4), { scaleNode: [2, 2, 2] }));
		expect(report.scale.longestAxisMeters).toBeCloseTo(0.8, 6);
		expect(report.mass.volumeM3 / 0.8 ** 3 - 1).toBeCloseTo(0, 6);
	});

	it('reports an open surface rather than a fabricated volume', async () => {
		const report = await gradeSimReadiness(await glbFrom(cubeMesh(0.4, { open: true })));
		expect(report.verdict).toBe('needs_repair');
		expect(report.blockers).toContain('open_surface');
		expect(report.topology.watertight).toBe(false);
		expect(report.topology.boundaryEdges).toBeGreaterThan(0);
	});

	it('catches an inconsistently wound triangle', async () => {
		const report = await gradeSimReadiness(await glbFrom(cubeMesh(0.4, { flipOneTriangle: true })));
		expect(report.blockers).toContain('inconsistent_winding');
		expect(report.topology.inconsistentWindingEdges).toBeGreaterThan(0);
		expect(report.topology.windingConsistent).toBe(false);
	});

	it('flags a generator-normalized unit box as unscaled, not as ready', async () => {
		const report = await gradeSimReadiness(await glbFrom(cubeMesh(1)));
		expect(report.scale.normalizedGuess).toBe(true);
		expect(report.verdict).toBe('needs_scale');
		expect(report.blockers).toContain('scale_normalized');
		// The geometry itself is sound; only the units are unknown.
		expect(report.topology.watertight).toBe(true);
	});

	it('returns an honest verdict for a buffer that is not a GLB', async () => {
		const report = await gradeSimReadiness(Buffer.from('not a glb at all'));
		expect(report.grader).toBe(SIM_READINESS_VERSION);
		expect(report.readable).toBe(false);
		expect(report.verdict).toBe('unreadable');
		expect(report.blockers).toContain('unreadable_glb');
	});

	// Every report, including the two early returns, is a claim by a named
	// grader: a stored or signed grade whose version is missing cannot be
	// re-checked later against the grader that produced it.
	it('stamps the grader version on every report shape, and it is the spec string', async () => {
		expect(SIM_READINESS_VERSION).toBe('threews.sim.readiness.v1');
		const empty = new Document();
		empty.createScene('scene');
		const noTriangles = await gradeSimReadiness(Buffer.from(await new NodeIO().writeBinary(empty)));
		expect(noTriangles.verdict).toBe('unusable');
		expect(noTriangles.blockers).toContain('no_triangles');
		expect(noTriangles.grader).toBe(SIM_READINESS_VERSION);
	});

	// The grade is cached, published and signed by content hash, so two runs over
	// the same bytes that disagreed would silently invalidate every stored grade.
	it('is deterministic: the same bytes grade identically twice', async () => {
		const glb = await glbFrom(cubeMesh(0.4));
		const [a, b] = await Promise.all([gradeSimReadiness(glb), gradeSimReadiness(glb)]);
		expect(JSON.stringify(a)).toBe(JSON.stringify(b));
	});
});
