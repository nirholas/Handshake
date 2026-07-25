import {
	ANCHORS, Pose, boneAxis, boneLength, curlAxis, palmAxis, radialAxis, restDirWorld,
	restPalmWorld, restRadialWorld, signPoint, solveArm, splayAxis, vLen, vSub, qRotate, restWorld,
} from '../../src/sign-rig.js';

const f = (v) => (Array.isArray(v) ? v.map((n) => n.toFixed(3)).join(', ') : v.toFixed(3));

console.log('--- derived hand frames ---');
for (const side of ['Right', 'Left']) {
	console.log(side, 'palmWorld=', f(restPalmWorld(side)), 'radialWorld=', f(restRadialWorld(side)));
}
console.log('\n--- bone axes (local) / lengths ---');
for (const b of ['RightArm', 'RightForeArm', 'RightHand', 'RightHandIndex1', 'RightHandThumb1', 'LeftArm', 'LeftHand']) {
	console.log(b.padEnd(16), 'axis=', f(boneAxis(b)), 'len=', f(boneLength(b)), 'restDir=', f(restDirWorld(b)));
}
console.log('\n--- finger axes ---');
for (const b of ['RightHandIndex1', 'RightHandIndex2', 'LeftHandIndex1', 'RightHandThumb1', 'LeftHandThumb1']) {
	console.log(b.padEnd(18), 'palm=', f(palmAxis(b)), 'radial=', f(radialAxis(b)), 'curl=', f(curlAxis(b)), 'splay=', f(splayAxis(b)));
}
console.log('\n--- anchors ---');
for (const k of ['forward', 'shoulderSpan', 'head', 'chin', 'sternum', 'belly']) console.log(k.padEnd(14), f(ANCHORS[k]));
console.log('shoulder R', f(ANCHORS.shoulder.Right));

console.log('\n--- IK: fingerspelling position (right hand beside the chin, palm out) ---');
const target = signPoint('chin', { out: 0.20, up: -0.05, forward: 0.16, side: 'Right' });
const pose = new Pose();
solveArm(pose, 'Right', { wrist: target, fingers: [0, 1, 0], palm: [0, 0, 1] });
const report = (p, side) => {
	for (const b of [`${side}Arm`, `${side}ForeArm`, `${side}Hand`, `${side}HandMiddle3`]) {
		console.log(b.padEnd(17), 'pos=', f(p.worldPos(b)), 'dir=', f(p.worldDir(b)), 'palm→', f(qRotate(p.worldQuat(b), palmAxis(b.includes('Hand') && !b.endsWith('Arm') ? b : `${side}Hand`))));
	}
};
console.log('target wrist ', f(target));
report(pose, 'Right');
console.log('elbow below wrist?', pose.worldPos('RightForeArm')[1] < pose.worldPos('RightHand')[1]);
console.log('hand in front (z>0)?', pose.worldPos('RightHand')[2] > 0);
console.log('wrist error', f(vLen(vSub(pose.worldPos('RightHand'), target))));
