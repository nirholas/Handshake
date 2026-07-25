// Diagnose the signing pose: where do the arm bones actually point on cz.glb?
import fs from 'node:fs';
import { Quaternion, Vector3 } from 'three';
import { canonicalizeBoneName } from '/workspaces/three.ws/src/glb-canonicalize.js';

const file = '/workspaces/three.ws/public/avatars/cz.glb';
const buf = fs.readFileSync(file);
const chunkLen = buf.readUInt32LE(12);
const gltf = JSON.parse(buf.slice(20, 20 + chunkLen).toString('utf8'));
const nodes = gltf.nodes || [];
const parentOf = new Array(nodes.length).fill(-1);
for (let i = 0; i < nodes.length; i++) for (const c of nodes[i]?.children || []) parentOf[c] = i;

const byCanon = new Map();
nodes.forEach((n, i) => {
	if (!n?.name) return;
	const c = canonicalizeBoneName(n.name);
	if (c && !byCanon.has(c)) byCanon.set(c, i);
});

const localQ = (i) => {
	const r = nodes[i]?.rotation || [0, 0, 0, 1];
	return new Quaternion(r[0], r[1], r[2], r[3]);
};
const localT = (i) => {
	const t = nodes[i]?.translation || [0, 0, 0];
	return new Vector3(t[0], t[1], t[2]);
};
const worldQ = (i) => {
	const q = localQ(i);
	for (let p = parentOf[i]; p !== -1; p = parentOf[p]) q.premultiply(localQ(p));
	return q;
};
const worldPos = (i) => {
	// compose translation + rotation up the chain (no scale on this rig? check)
	let p = localT(i);
	for (let par = parentOf[i]; par !== -1; par = parentOf[par]) {
		p = p.clone().applyQuaternion(localQ(par)).add(localT(par));
	}
	return p;
};

const show = (name) => {
	const i = byCanon.get(name);
	if (i === undefined) return console.log(name, 'MISSING');
	const wq = worldQ(i);
	const wp = worldPos(i);
	// child offset direction in world
	const kids = nodes[i].children || [];
	let dir = null;
	if (kids.length) {
		const cp = worldPos(kids[0]);
		dir = cp.clone().sub(wp).normalize();
	}
	const ax = (v) => new Vector3(...v).applyQuaternion(wq);
	console.log(
		name.padEnd(14),
		'node=', nodes[i].name.padEnd(18),
		'pos=', wp.toArray().map((v) => v.toFixed(3)).join(','),
		'| childDir=', dir ? dir.toArray().map((v) => v.toFixed(3)).join(',') : '-',
		'| localY→', ax([0, 1, 0]).toArray().map((v) => v.toFixed(2)).join(','),
		'| localX→', ax([1, 0, 0]).toArray().map((v) => v.toFixed(2)).join(','),
		'| localZ→', ax([0, 0, 1]).toArray().map((v) => v.toFixed(2)).join(','),
	);
};

console.log('=== cz.glb rest ===');
for (const b of ['Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head', 'RightShoulder', 'RightArm', 'RightForeArm', 'RightHand', 'RightHandIndex1', 'RightHandIndex2', 'RightHandThumb1', 'LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand'])
	show(b);

// ---- now apply the current signingPose locals and see where the arm goes ----
const { default: fsMod } = await import('node:fs');
const src = fsMod.readFileSync('/workspaces/three.ws/src/fingerspelling.js', 'utf8');
const mod = await import('/workspaces/three.ws/src/fingerspelling.js');

// Rebuild signingPose via the clip (first keyframe carries RightHand; static bones carry arms)
const clip = mod.buildFingerspellingClip('A');
const poseLocals = {};
for (const t of clip.tracks) {
	if (t.type !== 'quaternion') continue;
	const bone = t.name.split('.')[0];
	poseLocals[bone] = t.values.slice(0, 4);
}

function posedWorld(canon) {
	// compose world using posed locals where available, rest otherwise
	const chain = [];
	let i = byCanon.get(canon);
	while (i !== undefined && i !== -1) {
		chain.unshift(i);
		i = parentOf[i];
	}
	const q = new Quaternion();
	let p = new Vector3();
	for (const idx of chain) {
		const c = canonicalizeBoneName(nodes[idx].name);
		const lq = c && poseLocals[c] ? new Quaternion(...poseLocals[c]) : localQ(idx);
		p = p.add(localT(idx).clone().applyQuaternion(q));
		q.multiply(lq);
	}
	return { q, p };
}

console.log('\n=== posed (current signingPose, letter A) ===');
for (const b of ['RightArm', 'RightForeArm', 'RightHand', 'LeftArm', 'LeftForeArm', 'LeftHand']) {
	const { q, p } = posedWorld(b);
	const i = byCanon.get(b);
	const kid = (nodes[i].children || [])[0];
	let dir = '-';
	if (kid !== undefined) {
		// child world pos under posed chain
		const childLocal = localT(kid).clone().applyQuaternion(q);
		dir = childLocal.clone().normalize().toArray().map((v) => v.toFixed(3)).join(',');
	}
	const palmNormal = new Vector3(0, 0, 1).applyQuaternion(q);
	console.log(b.padEnd(13), 'pos=', p.toArray().map((v) => v.toFixed(3)).join(','), '| boneDir=', dir, '| localZ→', palmNormal.toArray().map((v) => v.toFixed(2)).join(','));
}
