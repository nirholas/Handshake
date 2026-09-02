// POST /api/print/prepare: repair a model and write the files a printer takes.
//
// This is the step between "we measured your mesh" and "a machine can run it".
// It welds and re-winds the surface, fills the holes the generator left, closes
// it into a real solid, scales it to the ordered height, optionally hollows it
// for resin economy, and writes three artifacts to object storage:
//
//   .stl   binary, millimetres, what every slicer on earth reads
//   .3mf   the modern package, carrying per-vertex colour when the source had a
//          texture, which is what makes a full-colour sandstone print possible
//   .glb   the repaired model itself, so the buyer can see exactly what will be
//          printed rather than the mesh they uploaded
//
// It returns the before and after reports side by side. A repair the buyer
// cannot inspect is a repair the buyer cannot trust, and /materialize renders
// this response as the "what changed" list next to the model.
//
// Free and keyless like analyze: preparing a file costs CPU, not fulfillment,
// and a buyer who can see the repaired result is a buyer who orders.

import { createHash } from 'node:crypto';

import { Document, NodeIO } from '@gltf-transform/core';

import { cors, error, json, method, rateLimited, readJson, wrap } from '../_lib/http.js';
import { clientIp, limits } from '../_lib/rate-limit.js';
import { loadMeshFromUrl, MeshIoError, boundsOf } from '../_lib/print/mesh-io.js';
import { analyzeMesh } from '../_lib/print/analyze.js';
import { repairMesh, hollowSolid, scaleMesh, solidToArrays } from '../_lib/print/repair.js';
import { exportStl } from '../_lib/print/export-stl.js';
import { export3mf } from '../_lib/print/export-3mf.js';
import { findMaterial, loadCatalog } from '../_lib/print/quote.js';
import { getPublicCreation } from '../_lib/forge-store.js';
import { objectStorageConfigured, publicUrl, putObject } from '../_lib/r2.js';

const MESH_ERROR_STATUS = {
	invalid_model: 422,
	no_geometry: 422,
	too_large: 413,
	too_complex: 413,
	invalid_url: 400,
	fetch_failed: 502,
};

const MM_PER_METER = 1000;

/**
 * A minimal GLB carrying exactly the repaired geometry. Deliberately plain: no
 * materials, no textures, no node hierarchy, because its only job is to let the
 * viewer show the solid that will actually be printed. Colour lives in the 3MF,
 * which is the file a colour printer reads.
 */
async function writeGlb({ positions, indices }) {
	const doc = new Document();
	const buffer = doc.createBuffer();
	const vertices = new Float32Array(positions.length);
	for (let i = 0; i < positions.length; i += 1) vertices[i] = positions[i];

	const position = doc.createAccessor().setType('VEC3').setArray(vertices).setBuffer(buffer);
	const index = doc.createAccessor().setType('SCALAR').setArray(Uint32Array.from(indices)).setBuffer(buffer);
	const primitive = doc.createPrimitive().setAttribute('POSITION', position).setIndices(index);
	const mesh = doc.createMesh('prepared').addPrimitive(primitive);
	const node = doc.createNode('prepared').setMesh(mesh);
	doc.createScene('prepared').addChild(node);

	return Buffer.from(await new NodeIO().writeBinary(doc));
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS' })) return;
	if (!method(req, res, ['POST'])) return;

	const rate = await limits.printQuoteIp(clientIp(req));
	if (!rate.success) return rateLimited(res, rate, 'too many prepare requests');

	const body = await readJson(req, 8_000).catch(() => null);
	if (!body || typeof body !== 'object') {
		return error(res, 400, 'validation_error', 'a JSON body is required');
	}

	let sourceUrl = typeof body.glbUrl === 'string' ? body.glbUrl.trim() : '';
	let creationId = null;
	if (typeof body.creationId === 'string' && body.creationId.trim()) {
		const creation = await getPublicCreation({ id: body.creationId.trim() });
		if (!creation?.glb_url) {
			return error(res, 404, 'creation_not_found', 'No finished public creation with that id.');
		}
		sourceUrl = creation.glb_url;
		creationId = creation.id;
	}
	if (!sourceUrl) {
		return error(res, 400, 'validation_error', 'Pass a creationId or a glbUrl to prepare.');
	}

	if (!objectStorageConfigured()) {
		return error(
			res,
			503,
			'storage_unavailable',
			'Object storage is not configured on this deployment, so prepared files cannot be written.',
		);
	}

	const material = body.materialId ? findMaterial(String(body.materialId)) : null;
	if (body.materialId && !material) {
		return error(res, 422, 'unknown_material', `No material with id "${body.materialId}".`);
	}

	let mesh;
	let before;
	try {
		mesh = await loadMeshFromUrl(sourceUrl);
		before = await analyzeMesh(mesh, { sourceUrl });
	} catch (err) {
		if (err instanceof MeshIoError) {
			return error(res, MESH_ERROR_STATUS[err.code] ?? 422, err.code, err.message, err.extra || {});
		}
		throw err;
	}

	const repaired = await repairMesh(mesh);

	// Scale to the ordered height before hollowing: the wall thickness a material
	// asks for is a real millimetre measurement, so the erosion has to happen on
	// the mesh at the size it will be printed, not on the source mesh.
	const targetHeightMm = Number(body.targetHeightMm);
	const nativeHeightMm = (boundsOf(repaired.positions)?.size?.[1] ?? 0) * MM_PER_METER;
	const scale = targetHeightMm > 0 && nativeHeightMm > 0 ? targetHeightMm / nativeHeightMm : 1;

	let positions = scale === 1 ? repaired.positions : scaleMesh(repaired.positions, scale);
	let indices = repaired.indices;
	let hollow = { hollowed: false, reason: 'not-requested' };

	if (body.hollow && material?.hollow?.supported) {
		const scaledSolid = scale === 1 ? repaired.solid : repaired.solid.scale([scale, scale, scale]);
		hollow = hollowSolid(repaired.wasm, scaledSolid, {
			// The catalog's wall is in millimetres; the mesh is in metres.
			wallThickness: material.hollow.wallMm / MM_PER_METER,
		});
		if (hollow.hollowed) {
			const arrays = solidToArrays(hollow.solid);
			positions = arrays.positions;
			indices = arrays.indices;
		}
	} else if (body.hollow) {
		hollow = { hollowed: false, reason: material ? 'material-does-not-hollow' : 'no-material-chosen' };
	}

	const prepared = { positions, indices, colors: null };
	const after = await analyzeMesh(prepared, { sourceUrl });

	const stl = exportStl(prepared, { requireWatertight: true, openEdges: after.open_edges });
	const threeMf = export3mf(prepared, {
		title: creationId ? `three.ws creation ${creationId}` : 'three.ws Materialize print',
		description: `Prepared ${new Date().toISOString().slice(0, 10)} from ${sourceUrl}`,
	});
	const glb = await writeGlb(prepared);

	// One folder per (source, size, hollow) so a re-prepare of the same order
	// overwrites rather than accumulating, and two different sizes never collide.
	const digest = createHash('sha256')
		.update(`${sourceUrl}|${Math.round(targetHeightMm || 0)}|${hollow.hollowed ? 1 : 0}|${material?.id || ''}`)
		.digest('hex')
		.slice(0, 20);
	const prefix = `print/prepared/${digest}`;

	const [stlKey, mfKey, glbKey] = [`${prefix}/model.stl`, `${prefix}/model.3mf`, `${prefix}/model.glb`];
	await Promise.all([
		putObject({ key: stlKey, body: stl, contentType: 'model/stl', metadata: { source: 'materialize' } }),
		putObject({ key: mfKey, body: threeMf, contentType: 'model/3mf', metadata: { source: 'materialize' } }),
		putObject({ key: glbKey, body: glb, contentType: 'model/gltf-binary', metadata: { source: 'materialize' } }),
	]);

	return json(
		res,
		200,
		{
			sourceUrl,
			creationId,
			assets: {
				stl: publicUrl(stlKey),
				threemf: publicUrl(mfKey),
				glb: publicUrl(glbKey),
				bytes: { stl: stl.length, threemf: threeMf.length, glb: glb.length },
			},
			before,
			after,
			// Exactly what changed, in the buyer's terms. Every number here was
			// measured, not asserted.
			repair: {
				strategy: repaired.strategy,
				holesFilled: repaired.metrics.holesFilled,
				patchTriangles: repaired.metrics.patchTriangles,
				mergedVertices: repaired.metrics.mergedVertices,
				degenerateRemoved: repaired.metrics.degenerateRemoved,
				duplicateRemoved: repaired.metrics.duplicateRemoved,
				trianglesFlipped: repaired.metrics.trianglesFlipped,
				trianglesBefore: repaired.metrics.trianglesBefore,
				trianglesAfter: repaired.metrics.trianglesAfter,
				shells: repaired.metrics.shells,
				elapsedMs: repaired.metrics.elapsedMs,
			},
			hollow: {
				applied: hollow.hollowed,
				reason: hollow.reason,
				wallMm: hollow.hollowed ? material.hollow.wallMm : null,
				drainHoles: hollow.metrics?.drainHoles ?? 0,
			},
			targetHeightMm: targetHeightMm > 0 ? Math.round(targetHeightMm * 10) / 10 : null,
			catalogVersion: loadCatalog().version,
		},
		{ 'cache-control': 'no-store' },
	);
});
