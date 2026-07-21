import fs from 'node:fs';
import { Vector3 } from 'three';
import { parseGltfJson, buildBoneGraph } from '/workspaces/three.ws/tests/_helpers/glb-bone-graph.js';
import { makeGltfRig, poseFromMannequinPreset } from '/workspaces/three.ws/src/pose-rig.js';
import { getPresetById } from '/workspaces/three.ws/src/pose-presets.js';

const buf = fs.readFileSync('/workspaces/three.ws/public/avatars/michelle.glb');
const doc = parseGltfJson(buf);
const graph = buildBoneGraph(doc);
const scene = graph.root || graph.scene || graph;
console.log('graph keys:', Object.keys(graph));
scene.updateMatrixWorld(true);
scene.traverse((n) => { if (n.isSkinnedMesh && n.skeleton) n.skeleton.calculateInverses(); });
const rig = makeGltfRig(scene);
console.log('rig?', !!rig, 'bones:', rig ? rig.getBones().length : 0);
if (!rig) process.exit(1);
scene.updateMatrixWorld(true);
const posOf = (k) => rig.getNode(k)?.getWorldPosition(new Vector3());
console.log('bind RightArm world pos', posOf('RightArm'));
rig.applyPose(poseFromMannequinPreset(getPresetById('hands-up').pose));
scene.updateMatrixWorld(true);
for (const { key, node } of rig.getBones().slice(0, 30)) {
	const q = node.quaternion;
	const bad = [q.x, q.y, q.z, q.w].some((v) => !Number.isFinite(v));
	if (bad) console.log('NaN quat on', key);
}
console.log('posed RightArm world pos', posOf('RightArm'));
console.log('posed RightForeArm world pos', posOf('RightForeArm'));
console.log('posed Hips world pos', posOf('Hips'));
