// Probe a GLB's skeleton: bone names, joint world positions, mesh bounds, skinning.
import { NodeIO } from '@gltf-transform/core';

const path = process.argv[2];
const doc = await new NodeIO().read(path);
const root = doc.getRoot();

for (const mesh of root.listMeshes()) {
	const prims = mesh.listPrimitives();
	const hasSkin = prims.some((p) => p.getAttribute('JOINTS_0'));
	let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
	for (const p of prims) {
		const pos = p.getAttribute('POSITION');
		if (!pos) continue;
		const mn = pos.getMin([]), mx = pos.getMax([]);
		for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i], mn[i]); max[i] = Math.max(max[i], mx[i]); }
	}
	console.log(`mesh "${mesh.getName()}" prims=${prims.length} skinned=${hasSkin}`,
		'bounds', min.map(v => v.toFixed(3)), '->', max.map(v => v.toFixed(3)));
}

for (const skin of root.listSkins()) {
	const joints = skin.listJoints();
	console.log(`skin joints=${joints.length}`);
	// world positions via parent chain
	const worldOf = (node) => {
		let m = node.getMatrix?.() ? null : null;
		// compose translation only from getWorldMatrix if available
		const wm = node.getWorldMatrix ? node.getWorldMatrix() : null;
		return wm ? [wm[12], wm[13], wm[14]] : null;
	};
	for (const j of joints) {
		const w = worldOf(j);
		console.log('  joint', j.getName(), w ? w.map(v => +v.toFixed(3)) : '');
	}
}
