// Rig-path bake-off: the SAME garment skinned by (A) the rig-worker lane vs
// (B) proximity transfer, attached to the parametric base, driven through the
// canonical walk clip. Metric: distance from each skinned garment vertex to
// the nearest skinned body vertex, sampled across the gait — good cloth keeps
// a small bounded offset; broken skinning spikes.
//
// Usage (SCRATCH dir must contain base-notex.glb + the two garment variants —
// see workers/garment-forge/README.md "Skinning bake-off" for how to produce
// them from any published garment):
//
//     SCRATCH=/path/to/dir node scripts/garment-rig-bakeoff.mjs
//
// Verdict of 2026-07-25 on the first seeded shirt (5 gait samples, 15,210
// measurements): rig-worker mean 2.87cm / p95 6.36cm; proximity mean 5.88cm /
// p95 13.06cm. The rig-worker lane is production; the proximity lib survives
// only as the offline test harness (workers/garment-forge/lib/).
// Re-run this whenever either skinning path changes.
import { readFile } from 'node:fs/promises';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { Group, Vector3, AnimationClip, AnimationMixer } from 'three';
import { attachGarment } from '/workspaces/three.ws/src/avatar-garment.js';
import { retargetClipToObject } from '/workspaces/three.ws/src/animation-retarget.js';

const SCRATCH = process.env.SCRATCH;
const load = async (p) => {
  const buf = await readFile(p);
  const loader = new GLTFLoader();
  return new Promise((res, rej) => loader.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '', res, rej));
};

const clipJson = JSON.parse(await readFile('/workspaces/three.ws/public/animations/clips/walk.json', 'utf8'));
const clip = AnimationClip.parse(clipJson.clip || clipJson);

async function evaluate(garmentPath, label) {
  const avatar = await load(`${SCRATCH}/base-notex.glb`);
  const root = new Group();
  root.add(avatar.scene);
  root.updateMatrixWorld(true);

  const garment = await load(garmentPath);
  const res = attachGarment(root, garment.scene, { slot: 'top' });
  if (!res.ok) { console.log(label, 'ATTACH FAILED:', res.reason); return; }
  const gMesh = res.meshes[0];

  let body;
  root.traverse((o) => { if (o.isSkinnedMesh && !o.userData.garmentSlot && (!body || o.geometry.attributes.position.count > body.geometry.attributes.position.count)) body = o; });

  const { clip: rClip } = retargetClipToObject(clip, root);
  if (!rClip) { console.log(label, 'RETARGET FAILED'); return; }
  const mixer = new AnimationMixer(root);
  mixer.clipAction(rClip).play();

  const stats = { mean: 0, p95: 0, max: 0, n: 0 };
  const all = [];
  const v = new Vector3();
  for (const t of [0.1, 0.3, 0.5, 0.7, 0.9]) {
    mixer.setTime(t * rClip.duration);
    root.updateMatrixWorld(true);
    body.skeleton.update();
    gMesh.skeleton.update();

    // body surface samples in world space
    const bp = body.geometry.attributes.position;
    const bodyPts = [];
    for (let i = 0; i < bp.count; i += 4) {
      v.fromBufferAttribute(bp, i); body.applyBoneTransform(i, v); v.applyMatrix4(body.matrixWorld);
      bodyPts.push(v.x, v.y, v.z);
    }
    // coarse grid for nearest lookup
    const cell = 0.05;
    const grid = new Map();
    for (let i = 0; i < bodyPts.length / 3; i++) {
      const k = `${Math.floor(bodyPts[i*3]/cell)},${Math.floor(bodyPts[i*3+1]/cell)},${Math.floor(bodyPts[i*3+2]/cell)}`;
      (grid.get(k) || grid.set(k, []).get(k)).push(i);
    }
    const nearest = (x, y, z) => {
      let best = Infinity;
      const cx = Math.floor(x/cell), cy = Math.floor(y/cell), cz = Math.floor(z/cell);
      for (let r = 0; r < 8; r++) {
        for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) for (let dz = -r; dz <= r; dz++) {
          if (Math.max(Math.abs(dx),Math.abs(dy),Math.abs(dz)) !== r) continue;
          const b = grid.get(`${cx+dx},${cy+dy},${cz+dz}`);
          if (!b) continue;
          for (const i of b) {
            const d = (bodyPts[i*3]-x)**2 + (bodyPts[i*3+1]-y)**2 + (bodyPts[i*3+2]-z)**2;
            if (d < best) best = d;
          }
        }
        if (best < Infinity && r > 1) break;
      }
      return Math.sqrt(best);
    };

    const gp = gMesh.geometry.attributes.position;
    for (let i = 0; i < gp.count; i += 8) {
      v.fromBufferAttribute(gp, i); gMesh.applyBoneTransform(i, v); v.applyMatrix4(gMesh.matrixWorld);
      const d = nearest(v.x, v.y, v.z);
      if (Number.isFinite(d)) all.push(d);
    }
  }
  all.sort((a, b) => a - b);
  const mean = all.reduce((s, x) => s + x, 0) / all.length;
  console.log(`${label}: n=${all.length} mean=${(mean*100).toFixed(2)}cm p95=${(all[Math.floor(all.length*0.95)]*100).toFixed(2)}cm max=${(all[all.length-1]*100).toFixed(2)}cm`);
}

await evaluate(`${SCRATCH}/seed-shirt-notex.glb`, 'A rig-worker ');
await evaluate(`${SCRATCH}/seed-shirt-proximity.glb`, 'B proximity  ');
