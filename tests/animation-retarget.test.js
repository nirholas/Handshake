/**
 * Runtime animation retargeting — unit tests.
 *
 * Builds synthetic skeletons and clips in-memory (no GLB fixtures), so the
 * suite is fast and deterministic. Covers the contract that lets a canonical
 * preset clip drive an arbitrarily-named, arbitrarily-proportioned rig:
 *   - track bone names rewritten to the target's actual node names,
 *   - vendor-prefixed rigs (mixamorig:, DEF-, snake_case) still map,
 *   - tracks for bones the rig lacks are dropped + reported,
 *   - coverage gating returns a null clip below MIN_COVERAGE,
 *   - hip translation scaling and speed resampling are applied.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
	Bone,
	SkinnedMesh,
	Skeleton,
	BufferGeometry,
	QuaternionKeyframeTrack,
	NumberKeyframeTrack,
	VectorKeyframeTrack,
	AnimationClip,
	Object3D,
	Quaternion,
	Vector3,
	Euler,
	Uint16BufferAttribute,
	Float32BufferAttribute,
} from 'three';
import {
	canonicalNodeMapFromObject,
	canonicalRestMapFromObject,
	hipGroundLocalY,
	hipRestLocalHeight,
	hipsParentWorldQuat,
	retargetClip,
	retargetClipToObject,
	scaleClipSpeed,
	MIN_COVERAGE,
} from '../src/animation-retarget.js';
import { CANONICAL_REST, CANONICAL_REST_WORLD } from '../src/animation-canonical-rest.js';
import { canonicalizeBoneName } from '../src/glb-canonicalize.js';
import { loadBoneGraph } from './_helpers/glb-bone-graph.js';

// Build a SkinnedMesh-rooted skeleton from a list of bone names so
// canonicalNodeMapFromObject finds it the way it would in a real GLB.
function makeRig(boneNames) {
	const root = new Object3D();
	const bones = boneNames.map((name) => {
		const b = new Bone();
		b.name = name;
		return b;
	});
	// Parent them all under root (flat is fine for name-mapping tests).
	for (const b of bones) root.add(b);
	const mesh = new SkinnedMesh(new BufferGeometry());
	mesh.add(bones[0]);
	mesh.bind(new Skeleton(bones));
	root.add(mesh);
	return root;
}

// A canonical clip: quaternion tracks on a few bones + a Hips position track.
function makeCanonicalClip() {
	const q = new QuaternionKeyframeTrack('Hips.quaternion', [0, 1], [0, 0, 0, 1, 0, 0, 0, 1]);
	const spine = new QuaternionKeyframeTrack('Spine.quaternion', [0, 1], [0, 0, 0, 1, 0, 0, 0, 1]);
	const arm = new QuaternionKeyframeTrack('LeftArm.quaternion', [0, 1], [0, 0, 0, 1, 0, 0, 0, 1]);
	// Hips at world Y = 1.0 (authoring rig height).
	const pos = new VectorKeyframeTrack('Hips.position', [0, 1], [0, 1, 0, 0, 1.1, 0]);
	return new AnimationClip('test', 1, [q, spine, arm, pos]);
}

const CANONICAL_RIG = ['Hips', 'Spine', 'LeftArm', 'RightArm', 'Head'];

describe('canonicalNodeMapFromObject', () => {
	it('maps canonical bone names to themselves', () => {
		const map = canonicalNodeMapFromObject(makeRig(CANONICAL_RIG));
		expect(map.get('Hips')).toBe('Hips');
		expect(map.get('LeftArm')).toBe('LeftArm');
	});

	it('maps vendor-prefixed and separator variants to canonical → real node name', () => {
		const map = canonicalNodeMapFromObject(
			makeRig(['mixamorig:Hips', 'DEF-spine', 'left_arm', 'Armature_Head']),
		);
		expect(map.get('Hips')).toBe('mixamorig:Hips');
		expect(map.get('Spine')).toBe('DEF-spine');
		expect(map.get('LeftArm')).toBe('left_arm');
		expect(map.get('Head')).toBe('Armature_Head');
	});

	it('returns an empty map for a rig with no recognizable humanoid bones', () => {
		const map = canonicalNodeMapFromObject(makeRig(['root', 'wheel_fl', 'wheel_fr']));
		expect(map.size).toBe(0);
	});
});

describe('retargetClip', () => {
	it('rewrites track bone names onto an identically-named rig (100% coverage)', () => {
		const clip = makeCanonicalClip();
		const map = canonicalNodeMapFromObject(makeRig(CANONICAL_RIG));
		const r = retargetClip(clip, map, { hipScale: 1 });
		expect(r.coverage).toBe(1);
		expect(r.matched).toBe(4);
		expect(r.clip.tracks.map((t) => t.name).sort()).toEqual(
			['Hips.position', 'Hips.quaternion', 'LeftArm.quaternion', 'Spine.quaternion'].sort(),
		);
	});

	it('rewrites onto a differently-named (Mixamo) rig', () => {
		const clip = makeCanonicalClip();
		const map = canonicalNodeMapFromObject(
			makeRig([
				'mixamorig:Hips',
				'mixamorig:Spine',
				'mixamorig:LeftArm',
				'mixamorig:RightArm',
			]),
		);
		const r = retargetClip(clip, map, { hipScale: 1 });
		const names = r.clip.tracks.map((t) => t.name);
		expect(names).toContain('mixamorig:Hips.quaternion');
		expect(names).toContain('mixamorig:LeftArm.quaternion');
		expect(names).toContain('mixamorig:Hips.position');
	});

	it('drops tracks for bones the rig lacks and reports them', () => {
		const clip = makeCanonicalClip(); // addresses Hips, Spine, LeftArm
		const map = canonicalNodeMapFromObject(makeRig(['Hips', 'Spine'])); // no LeftArm
		const r = retargetClip(clip, map, { hipScale: 1, minCoverage: 0.1 });
		expect(r.dropped).toContain('LeftArm');
		expect(r.clip.tracks.find((t) => t.name.includes('LeftArm'))).toBeUndefined();
	});

	it('returns a null clip when coverage is below the threshold', () => {
		const clip = makeCanonicalClip(); // 4 tracks (Hips ×2, Spine, LeftArm)
		const map = canonicalNodeMapFromObject(makeRig(['Spine'])); // only 1 of 4 maps
		const r = retargetClip(clip, map);
		expect(r.coverage).toBeLessThan(MIN_COVERAGE);
		expect(r.clip).toBeNull();
	});

	it('scales the hip position track by hipScale', () => {
		const clip = makeCanonicalClip();
		const map = canonicalNodeMapFromObject(makeRig(CANONICAL_RIG));
		const r = retargetClip(clip, map, { hipScale: 2 });
		const pos = r.clip.tracks.find((t) => t.name === 'Hips.position');
		// Original Y values were 1 and 1.1 → doubled.
		expect(pos.values[1]).toBeCloseTo(2, 5);
		expect(pos.values[4]).toBeCloseTo(2.2, 5);
	});

	it('does not mutate the source clip', () => {
		const clip = makeCanonicalClip();
		const before = clip.tracks.map((t) => t.name);
		const map = canonicalNodeMapFromObject(
			makeRig(['mixamorig:Hips', 'mixamorig:Spine', 'mixamorig:LeftArm']),
		);
		retargetClip(clip, map, { hipScale: 3 });
		expect(clip.tracks.map((t) => t.name)).toEqual(before);
		expect(clip.tracks.find((t) => t.name === 'Hips.position').values[1]).toBe(1);
	});

	// The baked library carries a position + quaternion + scale channel per bone.
	// A limb bone's local position (its offset from its parent) and its scale are
	// the *authoring* rig's structure, not motion — replaying them verbatim on a
	// differently-proportioned avatar overwrites its bone lengths and collapses it
	// into a heap while every bone still "matches" (coverage lies at 100%). The
	// retargeter must drop those structural channels and keep only rotations + the
	// root (Hips) translation, and coverage must be computed over just those.
	it('drops non-Hips position and all scale channels (keeps rotations + root)', () => {
		const q = new QuaternionKeyframeTrack('LeftArm.quaternion', [0], [0, 0, 0, 1]);
		const hipsQ = new QuaternionKeyframeTrack('Hips.quaternion', [0], [0, 0, 0, 1]);
		const hipsPos = new VectorKeyframeTrack('Hips.position', [0], [0, 1, 0]);
		// Structural channels that must NOT survive: a limb bone offset + scales.
		const armPos = new VectorKeyframeTrack('LeftArm.position', [0], [0.09, -0.015, 0]);
		const armScale = new VectorKeyframeTrack('LeftArm.scale', [0], [1, 1, 1]);
		const hipsScale = new VectorKeyframeTrack('Hips.scale', [0], [1, 1, 1]);
		const clip = new AnimationClip('struct', 1, [
			hipsQ,
			hipsPos,
			q,
			armPos,
			armScale,
			hipsScale,
		]);
		const map = canonicalNodeMapFromObject(makeRig(CANONICAL_RIG));
		const r = retargetClip(clip, map, { hipScale: 1 });

		const names = r.clip.tracks.map((t) => t.name).sort();
		expect(names).toEqual(['Hips.position', 'Hips.quaternion', 'LeftArm.quaternion'].sort());
		expect(r.clip.tracks.some((t) => t.name === 'LeftArm.position')).toBe(false);
		expect(r.clip.tracks.some((t) => t.name.endsWith('.scale'))).toBe(false);
		// Coverage is over the 3 retargetable channels, not all 6 → honest 100%.
		expect(r.total).toBe(3);
		expect(r.matched).toBe(3);
		expect(r.coverage).toBe(1);
	});
});

describe('bind-rotation correction', () => {
	// A −90°X rest, the up-axis convention Mixamo/FBX bakes onto Hips.
	const MINUS_90X = new Quaternion().setFromAxisAngle({ x: 1, y: 0, z: 0 }, -Math.PI / 2);

	// Pose a synthetic rig in the canonical authoring rest (cz's rest pose), so it
	// matches the convention the clip library was baked against.
	function applyAuthoringRest(rig, names) {
		for (const n of names) {
			const b = rig.getObjectByName(n);
			if (b && CANONICAL_REST[n]) b.quaternion.fromArray(CANONICAL_REST[n]);
		}
	}

	it('round-trips byte-for-byte when the rig matches the canonical authoring rest', () => {
		const clip = makeCanonicalClip();
		const rig = makeRig(CANONICAL_RIG);
		applyAuthoringRest(rig, CANONICAL_RIG);
		const map = canonicalNodeMapFromObject(rig);
		const targetRest = canonicalRestMapFromObject(rig);
		const corrected = retargetClip(clip, map, { hipScale: 1, targetRest }).clip;
		const verbatim = retargetClip(clip, map, { hipScale: 1 }).clip; // no targetRest → no correction
		// Every correction is identity (target rest == authoring rest) → skipped.
		corrected.tracks.forEach((t, i) => {
			expect(Array.from(t.values)).toEqual(Array.from(verbatim.tracks[i].values));
		});
	});

	it('re-applies a Hips up-axis rest the clip would otherwise overwrite (stays upright)', () => {
		const clip = makeCanonicalClip(); // Hips.quaternion identity at every key
		const rig = makeRig(CANONICAL_RIG);
		applyAuthoringRest(rig, CANONICAL_RIG);
		// Bake a Mixamo-style −90°X onto Hips: Tr = (−90X)·Sr ⇒ C = Tr·Sr⁻¹ = −90X.
		const sr = new Quaternion().fromArray(CANONICAL_REST.Hips);
		rig.getObjectByName('Hips').quaternion.copy(MINUS_90X.clone().multiply(sr));
		const map = canonicalNodeMapFromObject(rig);
		const targetRest = canonicalRestMapFromObject(rig);
		const r = retargetClip(clip, map, { hipScale: 1, targetRest }).clip;

		// C · identity = C = −90X exactly, restoring the rig's upright convention.
		const hipsQ = r.tracks.find((t) => t.name === 'Hips.quaternion');
		expect(hipsQ.values[0]).toBeCloseTo(MINUS_90X.x, 5);
		expect(hipsQ.values[3]).toBeCloseTo(MINUS_90X.w, 5);

		// Root-motion keyframes rotate by the same correction: (0,1,0) → (0,0,−1).
		const hipsP = r.tracks.find((t) => t.name === 'Hips.position');
		expect(hipsP.values[2]).toBeCloseTo(-1, 5);
	});

	it('corrects limb bones too — a T-pose (identity) arm rest is not copied verbatim', () => {
		const clip = makeCanonicalClip();
		const rig = makeRig(CANONICAL_RIG); // identity rests ≠ cz's A-pose authoring rest
		const map = canonicalNodeMapFromObject(rig);
		const targetRest = canonicalRestMapFromObject(rig);
		const corrected = retargetClip(clip, map, { hipScale: 1, targetRest }).clip;
		const verbatim = retargetClip(clip, map, { hipScale: 1 }).clip;
		const armC = corrected.tracks.find((t) => t.name === 'LeftArm.quaternion');
		const armV = verbatim.tracks.find((t) => t.name === 'LeftArm.quaternion');
		// cz rests its arms in an A-pose, so an identity-rest arm gets a real correction.
		expect(Array.from(armC.values)).not.toEqual(Array.from(armV.values));
	});

	it('hip scaling and rotation compose on the position track', () => {
		const clip = makeCanonicalClip();
		const rig = makeRig(CANONICAL_RIG);
		applyAuthoringRest(rig, CANONICAL_RIG);
		const sr = new Quaternion().fromArray(CANONICAL_REST.Hips);
		rig.getObjectByName('Hips').quaternion.copy(MINUS_90X.clone().multiply(sr));
		const map = canonicalNodeMapFromObject(rig);
		const targetRest = canonicalRestMapFromObject(rig);
		const r = retargetClip(clip, map, { hipScale: 2, targetRest }).clip;
		const hipsP = r.tracks.find((t) => t.name === 'Hips.position');
		// (0,1,0) rotated → (0,0,−1), then ×2 → (0,0,−2).
		expect(hipsP.values[2]).toBeCloseTo(-2, 5);
	});
});

describe('root-motion correction', () => {
	// A rig whose Hips sit under a tilted armature (the Mixamo +90°X pattern, or
	// any non-standard up-axis). Root motion authored in world-Y-up must be
	// re-expressed in this frame so the body still travels the right way.
	function makeRigWithTiltedArmature(tilt) {
		const root = new Object3D();
		const armature = new Object3D();
		armature.name = 'Armature';
		armature.quaternion.copy(tilt);
		root.add(armature);
		const bones = ['Hips', 'Spine', 'LeftArm', 'RightArm', 'Head'].map((n) => {
			const b = new Bone();
			b.name = n;
			return b;
		});
		armature.add(bones[0]);
		for (let i = 1; i < bones.length; i++) bones[0].add(bones[i]);
		const mesh = new SkinnedMesh(new BufferGeometry());
		mesh.bind(new Skeleton(bones));
		root.add(mesh);
		return root;
	}

	it('rotates the hip-position track by the inverse of the hips-parent world frame', () => {
		const clip = makeCanonicalClip(); // Hips.position keyframe (0,1,0)
		const tilt = new Quaternion().setFromAxisAngle({ x: 1, y: 0, z: 0 }, Math.PI / 2); // +90°X
		const rig = makeRigWithTiltedArmature(tilt);
		const map = canonicalNodeMapFromObject(rig);
		const targetRest = canonicalRestMapFromObject(rig);
		const hpq = hipsParentWorldQuat(rig);
		expect(hpq).not.toBeNull();
		const r = retargetClip(clip, map, { hipScale: 1, targetRest, hipsParentWorldQuat: hpq }).clip;
		const pos = r.tracks.find((t) => t.name.endsWith('.position'));
		// Parent is +90°X → position rotated by −90°X: (0,1,0) → (0,0,−1).
		expect(pos.values[0]).toBeCloseTo(0, 5);
		expect(pos.values[1]).toBeCloseTo(0, 5);
		expect(pos.values[2]).toBeCloseTo(-1, 5);
	});

	it('leaves the hip-position track untouched when the hips-parent frame is identity', () => {
		const clip = makeCanonicalClip();
		const rig = makeRigWithTiltedArmature(new Quaternion()); // identity armature
		const map = canonicalNodeMapFromObject(rig);
		const targetRest = canonicalRestMapFromObject(rig);
		const hpq = hipsParentWorldQuat(rig);
		const r = retargetClip(clip, map, { hipScale: 1, targetRest, hipsParentWorldQuat: hpq }).clip;
		const verbatim = retargetClip(clip, map, { hipScale: 1 }).clip; // no correction baseline
		const pos = r.tracks.find((t) => t.name.endsWith('.position'));
		const posV = verbatim.tracks.find((t) => t.name.endsWith('.position'));
		expect(Array.from(pos.values)).toEqual(Array.from(posV.values));
	});
});

describe('retargetClipToObject', () => {
	it('retargets straight onto an Object3D graph', () => {
		const clip = makeCanonicalClip();
		const rig = makeRig([
			'mixamorig:Hips',
			'mixamorig:Spine',
			'mixamorig:LeftArm',
			'mixamorig:RightArm',
		]);
		const r = retargetClipToObject(clip, rig, { minCoverage: 0.5 });
		expect(r.clip).not.toBeNull();
		expect(r.clip.tracks.some((t) => t.name === 'mixamorig:LeftArm.quaternion')).toBe(true);
	});
});

describe('scaleClipSpeed', () => {
	it('1.8× shortens duration and times proportionally', () => {
		const clip = makeCanonicalClip(); // duration 1
		const fast = scaleClipSpeed(clip, 1.8);
		expect(fast.duration).toBeCloseTo(1 / 1.8, 5);
		const t = fast.tracks[0].times;
		expect(t[t.length - 1]).toBeCloseTo(1 / 1.8, 5);
	});

	it('factor of 1 returns the clip unchanged', () => {
		const clip = makeCanonicalClip();
		expect(scaleClipSpeed(clip, 1)).toBe(clip);
	});

	it('does not mutate the source clip', () => {
		const clip = makeCanonicalClip();
		const origDur = clip.duration;
		scaleClipSpeed(clip, 2);
		expect(clip.duration).toBe(origDur);
	});
});

// ---------------------------------------------------------------------------
// Cross-rig locomotion invariants, validated against the real shipped GLB rigs
// (cz.glb, michelle.glb) plus two synthetic conventions, using a raw GLB parse
// and world-matrix composition — no GLTFLoader, no browser, fully deterministic.
//
// What this guards: root motion lives in the Hips' *parent* local frame, so to
// preserve world-space travel the retargeter rotates the hip-position track by
// the inverse of the target Hips-parent rest rotation (animation-retarget.js →
// hipPositionCorrection). The earlier, narrower fix rotated by the Hips *bone*
// correction, which is exact only on the standard Mixamo +90°X/−90°X split. The
// `tilted` rig below carries a compound, non-±90° armature rotation while its
// Hips sit at the authoring rest (so the Hips bone correction is identity): only
// the parent-frame correction can recover the right world direction, so a
// regression to the bone-correction approach makes the direction/verticality
// assertions fail there.
// ---------------------------------------------------------------------------
describe('cross-rig locomotion invariants (real GLB)', () => {
	const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
	const clipPath = (n) => path.join(REPO, 'public/animations/clips', `${n}.json`);
	const glbPath = (n) => path.join(REPO, 'public/avatars', `${n}.glb`);

	// Real GLB rigs are reconstructed with the shared bone-graph helper
	// (tests/_helpers/glb-bone-graph.js) — the same raw-JSON-chunk parse +
	// SkinnedMesh/Skeleton reconstruction the upright-invariant corpus uses, so
	// production's canonical readers see these rigs exactly as a GLTFLoader scene.
	const realRig = (name) => loadBoneGraph(glbPath(name)).root;

	// A synthetic rig: every canonical bone at the authoring rest (so per-bone
	// limb corrections are identity), parented under an armature carrying an
	// arbitrary rest rotation. This isolates the hip-position correction — the
	// armature rotation is the *only* thing the root motion must compensate for.
	function buildSyntheticRig(armatureQuat) {
		const root = new Object3D();
		const armature = new Object3D();
		armature.name = 'Armature';
		armature.quaternion.copy(armatureQuat);
		root.add(armature);
		const names = Object.keys(CANONICAL_REST);
		const byName = {};
		for (const nm of names) {
			const b = new Bone();
			b.name = nm;
			b.quaternion.fromArray(CANONICAL_REST[nm]);
			byName[nm] = b;
		}
		byName.Hips.position.set(0, 1, 0); // a plausible rest hip height
		armature.add(byName.Hips);
		for (const nm of names) if (nm !== 'Hips') byName.Hips.add(byName[nm]);
		const mesh = new SkinnedMesh(new BufferGeometry());
		mesh.bind(new Skeleton(names.map((n) => byName[n])));
		root.add(mesh);
		root.updateMatrixWorld(true);
		return root;
	}

	function loadClip(name) {
		const clip = AnimationClip.parse(JSON.parse(fs.readFileSync(clipPath(name), 'utf8')));
		clip.name = name;
		return clip;
	}

	function findHips(root) {
		let hips = null;
		root.traverse((n) => {
			if (!hips && n.isBone && canonicalizeBoneName(n.name || '') === 'Hips') hips = n;
		});
		return hips;
	}

	// Net world-space hip displacement over a retargeted clip, expressed in
	// hip-heights (dividing out the rig's overall scale so rigs authored in metres
	// and in centimetres are directly comparable). Composes the real world matrix
	// of the Hips' parent — the frame the position track binds into — so this is
	// what the avatar actually does on screen, not a re-derivation of the maths.
	function worldHipNet(root, clip) {
		const hips = findHips(root);
		root.updateMatrixWorld(true);
		const restHeight = Math.abs(new Vector3().setFromMatrixPosition(hips.matrixWorld).y) || 1;
		const parentWorld = hips.parent.matrixWorld.clone();
		const { clip: out, coverage } = retargetClipToObject(clip, root, { minCoverage: 0 });
		expect(coverage).toBeGreaterThan(MIN_COVERAGE); // the rig really animates
		const track = out.tracks.find((t) => t.name === `${hips.name}.position`);
		const v = track.values;
		const last = v.length - 3;
		const p0 = new Vector3(v[0], v[1], v[2]).applyMatrix4(parentWorld);
		const pN = new Vector3(v[last], v[last + 1], v[last + 2]).applyMatrix4(parentWorld);
		return pN.sub(p0).divideScalar(restHeight);
	}

	// Authored net displacement straight from the clip (the authoring rig is
	// world-Y-up, so this *is* the intended world direction every rig must match).
	function authoredNet(clip) {
		const t = clip.tracks.find(
			(tr) => tr.name.endsWith('.position') && canonicalizeBoneName(tr.name.split('.')[0]) === 'Hips',
		);
		const v = t.values;
		const last = v.length - 3;
		return new Vector3(v[last] - v[0], v[last + 1] - v[1], v[last + 2] - v[2]);
	}

	// Four conventions: cz (authoring rig, identity armature), michelle (Mixamo
	// +90°X armature / −90°X Hips), and two synthetics — a compound non-±90°
	// armature and a pure 30° yaw (an upright RPM-style placement rotation).
	const rigs = {
		cz: realRig('cz'),
		michelle: realRig('michelle'),
		tilted: buildSyntheticRig(
			new Quaternion().setFromEuler(
				new Euler((25 * Math.PI) / 180, (40 * Math.PI) / 180, (15 * Math.PI) / 180, 'XYZ'),
			),
		),
		yawed: buildSyntheticRig(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 6)),
	};
	const rigNames = Object.keys(rigs);

	// Clips that actually travel (the in-place featured walk/jump have ~zero net
	// translation, so a non-trivial library clip is used to test direction).
	const WALK = 'av-walk-crouching'; // pure forward (+Z), flat ground
	const JUMP = 'jumpdown2'; // forward + downward arc

	describe.each([WALK, JUMP])('%s travels the authored world direction on every rig', (name) => {
		const clip = loadClip(name);
		const authored = authoredNet(clip);
		const authoredDir = authored.clone().normalize();

		it.each(rigNames)('direction matches on %s (no sideways drift)', (rigName) => {
			const world = worldHipNet(rigs[rigName], clip);
			// World travel must point the same way as the authored travel: a unit-dot
			// near 1 means the heading is preserved and nothing leaked sideways.
			expect(world.clone().normalize().dot(authoredDir)).toBeGreaterThan(0.999);
		});

		it.each(rigNames)('verticality matches on %s (no sinking / floating)', (rigName) => {
			const world = worldHipNet(rigs[rigName], clip);
			const worldVertFrac = world.y / world.length();
			const authoredVertFrac = authored.y / authored.length();
			// The share of travel that is vertical is preserved, so a forward walk
			// stays on the ground and a jump arcs by exactly its authored amount —
			// horizontal motion never bleeds into the up axis (or vice-versa).
			expect(Math.abs(worldVertFrac - authoredVertFrac)).toBeLessThan(0.02);
		});
	});

	// In-place performances must not acquire net horizontal travel on any rig.
	describe.each(['idle', 'celebrate', 'walk', 'jump'])('%s stays in place on every rig', (name) => {
		const clip = loadClip(name);

		it.each(rigNames)('net XZ travel is ~zero on %s', (rigName) => {
			const world = worldHipNet(rigs[rigName], clip);
			expect(Math.hypot(world.x, world.z)).toBeLessThan(0.01);
		});
	});

	it('cz.glb output is byte-for-byte identical to the verbatim (uncorrected) clip', () => {
		// cz is the authoring rig: identity armature, identity Hips rest. Every
		// correction collapses to identity, so the retarget must be a no-op — the
		// absolute no-regression bar for the whole initiative.
		const clip = loadClip(WALK);
		const corrected = retargetClipToObject(clip, rigs.cz, { minCoverage: 0 }).clip;
		const map = canonicalNodeMapFromObject(rigs.cz);
		const verbatim = retargetClip(clip, map, { hipScale: 1, minCoverage: 0 }).clip;
		const byName = new Map(verbatim.tracks.map((t) => [t.name, t]));
		for (const t of corrected.tracks) {
			expect(Array.from(t.values)).toEqual(Array.from(byName.get(t.name).values));
		}
	});
});

describe('world-delta correctness — limb retarget preserves world motion', () => {
	// The bug this guards: a local-only premultiply correction (Rt·Rs⁻¹·q) replays a
	// clip bone's deviation in the wrong frame, skewing limbs by ~30° on a rig whose
	// rest pose differs from the cz authoring rig. The world-aware correction
	// (q ← L·q·R) must instead reproduce the SAME world-space rotation delta on any
	// rest pose. Oracle is three's getWorldQuaternion — independent of the module's
	// own world-rest math, so the test can't pass by sharing the bug.
	const Rs = new Quaternion().fromArray(CANONICAL_REST.LeftArm); // cz LeftArm local rest
	const WS = new Quaternion().fromArray(CANONICAL_REST_WORLD.LeftArm); // …world rest

	// A target rig whose LeftArm rests deep down-and-in, under rotated Hips/Spine —
	// a rest pose far from cz, so a local-only correction would visibly skew it.
	function buildTarget() {
		const root = new Object3D();
		const hips = Object.assign(new Bone(), { name: 'Hips' });
		hips.quaternion.setFromEuler(new Euler(0.12, 0.25, -0.08));
		const spine = Object.assign(new Bone(), { name: 'Spine' });
		spine.quaternion.setFromEuler(new Euler(0.05, 0, 0.18));
		const arm = Object.assign(new Bone(), { name: 'LeftArm' });
		arm.quaternion.setFromEuler(new Euler(0.2, -0.3, -1.1));
		spine.add(arm);
		hips.add(spine);
		root.add(hips);
		root.updateMatrixWorld(true);
		return { root, arm, restLocal: arm.quaternion.clone() };
	}

	// A clip keyframe: cz's LeftArm rotated by world delta D, as its absolute local
	// rotation (sourceParentWorld = WS·Rs⁻¹ ⇒ local = parent⁻¹·D·WS).
	function clipForWorldDelta(D) {
		const parentWorld = WS.clone().multiply(Rs.clone().invert());
		const S = parentWorld.clone().invert().multiply(D).multiply(WS);
		return new AnimationClip('m', 1, [
			new QuaternionKeyframeTrack(
				'LeftArm.quaternion',
				[0, 1],
				[S.x, S.y, S.z, S.w, S.x, S.y, S.z, S.w],
			),
		]);
	}

	const worldDirErr = (a, b) => {
		const probe = new Vector3(0, 1, 0);
		return (
			(probe.clone().applyQuaternion(a).angleTo(probe.clone().applyQuaternion(b)) * 180) / Math.PI
		);
	};

	it('reproduces a known world-space arm motion on a foreign rest pose (≈0° error)', () => {
		const D = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), (40 * Math.PI) / 180);
		const clip = clipForWorldDelta(D);
		const { root, arm } = buildTarget();
		const restWorld = arm.getWorldQuaternion(new Quaternion()); // bind world (oracle)
		const expected = D.clone().multiply(restWorld); // same world delta on target rest

		const out = retargetClipToObject(clip, root, { minCoverage: 0 }).clip;
		const t = out.tracks.find((x) => x.name === 'LeftArm.quaternion');
		arm.quaternion.set(t.values[0], t.values[1], t.values[2], t.values[3]);
		root.updateMatrixWorld(true);
		const actual = arm.getWorldQuaternion(new Quaternion());

		expect(worldDirErr(actual, expected)).toBeLessThan(0.5);
	});

	it('the old local-only premultiply (Rt·Rs⁻¹·q) would skew this badly (>5°) — test is discriminating', () => {
		const D = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), (40 * Math.PI) / 180);
		const clip = clipForWorldDelta(D);
		const { root, arm, restLocal } = buildTarget();
		const restWorld = arm.getWorldQuaternion(new Quaternion());
		const expected = D.clone().multiply(restWorld);

		// Reconstruct the prior behaviour: C·q with C = Rt·Rs⁻¹ (no world term).
		const S = new Quaternion(clip.tracks[0].values[0], clip.tracks[0].values[1], clip.tracks[0].values[2], clip.tracks[0].values[3]);
		const buggy = restLocal.clone().multiply(Rs.clone().invert()).multiply(S);
		arm.quaternion.copy(buggy);
		root.updateMatrixWorld(true);
		const actual = arm.getWorldQuaternion(new Quaternion());

		expect(worldDirErr(actual, expected)).toBeGreaterThan(5);
	});
});

// ---------------------------------------------------------------------------
// The dignity floor: a rig from any supported naming convention must clear
// MIN_COVERAGE against the REAL shipped clips, with both arms and both legs
// bound. This is the invariant scripts/animation-dignity-sweep.mjs measures in
// full (it also checks that the bones actually rotate and that the hands and
// feet travel through world space); the case below is the cheap CI half of it.
//
// Why coverage is the sharp edge: 30 of a clip's 53 tracks address finger bones.
// A convention whose hands don't name-map scores about 40%, falls under the gate,
// and `retargetClip` returns a NULL clip: production then builds no action at
// all and the avatar stands frozen in its bind pose. Every convention here was
// measured doing exactly that before the finger aliases landed in
// src/glb-canonicalize.js, and nothing in the suite noticed, because every other
// test either passes `minCoverage: 0` or uses a synthetic 5-bone rig.
// ---------------------------------------------------------------------------
describe('rig-convention coverage floor (real clips)', () => {
	const REPO2 = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
	const realClip = (name) => {
		const clip = AnimationClip.parse(
			JSON.parse(fs.readFileSync(path.join(REPO2, 'public/animations/clips', `${name}.json`), 'utf8')),
		);
		clip.name = name;
		return clip;
	};

	const FINGER_STEMS = ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'];

	// Each entry spells the same humanoid skeleton the way that tool exports it.
	// `body` is given left-side-first; right twins are derived by the swap fn.
	const CONVENTIONS = {
		'Unreal mannequin': {
			centre: ['pelvis', 'spine_01', 'spine_02', 'spine_03', 'neck_01', 'head'],
			limb: (s) => [
				`clavicle_${s}`, `upperarm_${s}`, `lowerarm_${s}`, `hand_${s}`,
				`thigh_${s}`, `calf_${s}`, `foot_${s}`, `ball_${s}`,
			],
			finger: (s, f, n) => `${f.toLowerCase()}_0${n}_${s}`,
			sides: ['l', 'r'],
		},
		'VRM 1.0': {
			centre: ['hips', 'spine', 'chest', 'upperChest', 'neck', 'head'],
			limb: (s) => [
				`${s}Shoulder`, `${s}UpperArm`, `${s}LowerArm`, `${s}Hand`,
				`${s}UpperLeg`, `${s}LowerLeg`, `${s}Foot`, `${s}Toes`,
			],
			finger: (s, f, n) => {
				const vf = f === 'Pinky' ? 'Little' : f;
				const phalanx =
					f === 'Thumb'
						? ['Metacarpal', 'Proximal', 'Distal'][n - 1]
						: ['Proximal', 'Intermediate', 'Distal'][n - 1];
				return `${s}${vf}${phalanx}`;
			},
			sides: ['left', 'right'],
		},
		'Daz / Genesis 8': {
			centre: ['hip', 'abdomenLower', 'abdomenUpper', 'chestUpper', 'neckLower', 'head'],
			limb: (s) => [
				`${s}Collar`, `${s}ShldrBend`, `${s}ForearmBend`, `${s}Hand`,
				`${s}ThighBend`, `${s}Shin`, `${s}Foot`, `${s}Toe`,
			],
			finger: (s, f, n) => `${s}${f === 'Middle' ? 'Mid' : f}${n}`,
			sides: ['l', 'r'],
		},
		MakeHuman: {
			centre: ['pelvis', 'spine', 'chest', 'neck', 'head'],
			limb: (s) => [
				`clavicle.${s}`, `upperarm.${s}`, `forearm.${s}`, `hand.${s}`,
				`thigh.${s}`, `shin.${s}`, `foot.${s}`, `toe.${s}`,
			],
			finger: (s, f, n) => `finger${FINGER_STEMS.indexOf(f) + 1}-${n}.${s}`,
			sides: ['L', 'R'],
		},
		'Blender Rigify': {
			centre: ['hips', 'spine', 'chest', 'neck', 'head'],
			limb: (s) => [
				`shoulder.${s}`, `upper_arm.${s}`, `forearm.${s}`, `hand.${s}`,
				`thigh.${s}`, `shin.${s}`, `foot.${s}`, `toe.${s}`,
			],
			finger: (s, f, n) =>
				f === 'Thumb' ? `thumb.0${n}.${s}` : `f_${f.toLowerCase()}.0${n}.${s}`,
			sides: ['L', 'R'],
		},
		'anatomical Latin': {
			centre: ['pelvis', 'lumbar', 'thoracic', 'sternum', 'cervical', 'cranium'],
			limb: (s) => [
				`scapula.${s}`, `humerus.${s}`, `ulna.${s}`, `carpus.${s}`,
				`femur.${s}`, `tibia.${s}`, `talus.${s}`, `metatarsus.${s}`,
			],
			finger: (s, f, n) => {
				const af = f === 'Pinky' ? 'little' : f.toLowerCase();
				const phalanx =
					f === 'Thumb'
						? ['metacarpal', 'proximal', 'distal'][n - 1]
						: ['proximal', 'intermediate', 'distal'][n - 1];
				return `${af}_${phalanx}.${s}`;
			},
			sides: ['L', 'R'],
		},
	};

	function boneNames(spec) {
		const names = [...spec.centre];
		for (const side of spec.sides) {
			names.push(...spec.limb(side));
			for (const f of FINGER_STEMS) {
				for (let n = 1; n <= 3; n++) names.push(spec.finger(side, f, n));
			}
		}
		return names;
	}

	describe.each(Object.entries(CONVENTIONS))('%s', (label, spec) => {
		const rig = makeRig(boneNames(spec));
		const map = canonicalNodeMapFromObject(rig);

		it.each(['idle', 'walk'])('clears the MIN_COVERAGE gate on %s', (clipName) => {
			// Default minCoverage on purpose: this asserts what PRODUCTION does, not
			// what a permissive test harness would allow.
			const r = retargetClipToObject(realClip(clipName), rig);
			expect(r.clip, `${label} produced no clip on ${clipName}`).not.toBeNull();
			expect(r.coverage).toBeGreaterThanOrEqual(MIN_COVERAGE);
		});

		it('binds both arms and both legs', () => {
			for (const bone of [
				'LeftArm', 'LeftForeArm', 'RightArm', 'RightForeArm',
				'LeftUpLeg', 'LeftLeg', 'RightUpLeg', 'RightLeg',
			]) {
				expect(map.get(bone), `${label} lost ${bone}`).toBeTruthy();
			}
		});

		it('maps all 30 finger joints', () => {
			const fingers = [...map.keys()].filter((k) => /Hand(Thumb|Index|Middle|Ring|Pinky)[123]$/.test(k));
			expect(fingers.length, `${label} mapped only ${fingers.length} finger joints`).toBe(30);
		});
	});
});

describe('face (morph target) lanes', () => {
	/** A rig with two meshes that share some blendshapes and differ on others. */
	function faceRig() {
		const root = new Object3D();
		root.name = 'Armature';
		const hips = new Bone();
		hips.name = 'Hips';
		root.add(hips);
		const head = new Object3D();
		head.name = 'Wolf3D_Head';
		head.morphTargetDictionary = { browInnerUp: 0, mouthSmileLeft: 1 };
		head.morphTargetInfluences = [0, 0];
		const teeth = new Object3D();
		teeth.name = 'Wolf3D_Teeth';
		teeth.morphTargetDictionary = { mouthSmileLeft: 0 };
		teeth.morphTargetInfluences = [0];
		root.add(head, teeth);
		return root;
	}

	const faceClip = () =>
		new AnimationClip('sign', 1, [
			new QuaternionKeyframeTrack('Hips.quaternion', [0, 1], [0, 0, 0, 1, 0, 0, 0, 1]),
			new NumberKeyframeTrack('Face.morphTargetInfluences[browInnerUp]', [0, 1], [0, 0.8]),
			new NumberKeyframeTrack('Face.morphTargetInfluences[mouthSmileLeft]', [0, 1], [0, 0.5]),
			new NumberKeyframeTrack('Face.morphTargetInfluences[tongueOut]', [0, 1], [0, 1]),
		]);

	it('re-points each face lane at every mesh that owns the shape', () => {
		const root = faceRig();
		const { clip, face } = retargetClipToObject(faceClip(), root);
		const names = clip.tracks.map((t) => t.name);
		// browInnerUp lives on one mesh, mouthSmileLeft on two, tongueOut on none.
		expect(names).toContain('Wolf3D_Head.morphTargetInfluences[browInnerUp]');
		expect(names).toContain('Wolf3D_Head.morphTargetInfluences[mouthSmileLeft]');
		expect(names).toContain('Wolf3D_Teeth.morphTargetInfluences[mouthSmileLeft]');
		expect(names.some((n) => n.includes('tongueOut'))).toBe(false);
		expect(face).toBe(3);
	});

	it('drops the whole face lane on a rig with no blendshapes, keeping the motion', () => {
		const root = new Object3D();
		const hips = new Bone();
		hips.name = 'Hips';
		root.add(hips);
		const { clip, coverage, face } = retargetClipToObject(faceClip(), root);
		expect(face).toBe(0);
		expect(clip.tracks.map((t) => t.name)).toEqual(['Hips.quaternion']);
		// Face lanes must not drag bone coverage down and fail the retarget.
		expect(coverage).toBe(1);
	});

	it('leaves a clip with no face lanes untouched', () => {
		const root = faceRig();
		const plain = new AnimationClip('walk', 1, [
			new QuaternionKeyframeTrack('Hips.quaternion', [0, 1], [0, 0, 0, 1, 0, 0, 0, 1]),
		]);
		const { clip, face } = retargetClipToObject(plain, root);
		expect(face).toBe(0);
		expect(clip.tracks).toHaveLength(1);
	});
});

describe('hipRestLocalHeight', () => {
	// A half-metre chibi rig with real geometry bounds: body spans floor..top,
	// hips partway up. Built like a GLB import: bones + a skinned mesh whose
	// geometry carries the body's vertical extent.
	function makeMeasuredRig({ floorY, topY, hipsY }) {
		const root = new Object3D();
		const hips = new Bone();
		hips.name = 'Hips';
		hips.position.y = hipsY;
		root.add(hips);
		const geo = new BufferGeometry();
		geo.setFromPoints([new Vector3(0, floorY, 0), new Vector3(0, topY, 0)]);
		// Real skin attributes: SkinnedMesh.computeBoundingBox (used by
		// Box3.setFromObject) walks them per vertex.
		geo.setAttribute(
			'skinIndex',
			new Uint16BufferAttribute(new Uint16Array([0, 0, 0, 0, 0, 0, 0, 0]), 4),
		);
		geo.setAttribute(
			'skinWeight',
			new Float32BufferAttribute(new Float32Array([1, 0, 0, 0, 1, 0, 0, 0]), 4),
		);
		const mesh = new SkinnedMesh(geo);
		root.add(mesh);
		// Update world matrices BEFORE bind so the inverse bind matrices capture
		// the true bind pose (as a GLB's authored IBMs would); binding at
		// identity would re-shift every vertex by the hips offset.
		root.updateMatrixWorld(true);
		mesh.bind(new Skeleton([hips]));
		return root;
	}

	it('measures a ground-native rig unchanged (floor at 0)', () => {
		const root = makeMeasuredRig({ floorY: 0, topY: 1, hipsY: 0.24 });
		expect(hipRestLocalHeight(root)).toBeCloseTo(0.24, 5);
	});

	it('measures above the model floor for an origin-centered rig', () => {
		// Same body exported origin-centered: floor at -0.5, hips world at -0.26.
		// Measured from world zero this reads negative and used to skip hip
		// scaling entirely, flinging the rig to the clip's metre-scale height.
		const root = makeMeasuredRig({ floorY: -0.5, topY: 0.5, hipsY: -0.26 });
		expect(hipRestLocalHeight(root)).toBeCloseTo(0.24, 5);
	});

	it('measures above the floor after a viewer recenters the content', () => {
		// Viewer.setContent subtracts the bbox center from the content root; the
		// hips height above the feet must survive that shift.
		const root = makeMeasuredRig({ floorY: 0, topY: 1, hipsY: 0.24 });
		root.position.y -= 0.5;
		root.updateMatrixWorld(true);
		expect(hipRestLocalHeight(root)).toBeCloseTo(0.24, 5);
	});
});

describe('hipGroundLocalY + hip track offset', () => {
	function measuredRig({ floorY, topY, hipsY }) {
		const root = new Object3D();
		const hips = new Bone();
		hips.name = 'Hips';
		hips.position.y = hipsY;
		root.add(hips);
		const geo = new BufferGeometry();
		geo.setFromPoints([new Vector3(0, floorY, 0), new Vector3(0, topY, 0)]);
		geo.setAttribute(
			'skinIndex',
			new Uint16BufferAttribute(new Uint16Array([0, 0, 0, 0, 0, 0, 0, 0]), 4),
		);
		geo.setAttribute(
			'skinWeight',
			new Float32BufferAttribute(new Float32Array([1, 0, 0, 0, 1, 0, 0, 0]), 4),
		);
		const mesh = new SkinnedMesh(geo);
		root.add(mesh);
		root.updateMatrixWorld(true);
		mesh.bind(new Skeleton([hips]));
		return root;
	}

	it('is 0 for a ground-native rig', () => {
		const root = measuredRig({ floorY: 0, topY: 1, hipsY: 0.24 });
		expect(hipGroundLocalY(root)).toBeCloseTo(0, 5);
	});

	it('reports the local floor of an origin-centered rig', () => {
		const root = measuredRig({ floorY: -0.5, topY: 0.5, hipsY: -0.26 });
		expect(hipGroundLocalY(root)).toBeCloseTo(-0.5, 5);
	});

	it('offsets the hip position track Y so the clip ground lands on the rig floor', () => {
		const clip = makeCanonicalClip(); // Hips.position Y keys: 1.0, 1.1
		const map = canonicalNodeMapFromObject(makeRig(CANONICAL_RIG));
		const r = retargetClip(clip, map, { hipScale: 0.24, hipOffsetY: -0.5 });
		const pos = r.clip.tracks.find((t) => t.name === 'Hips.position');
		// scaled then offset: 1.0 * 0.24 - 0.5, 1.1 * 0.24 - 0.5
		expect(pos.values[1]).toBeCloseTo(-0.26, 5);
		expect(pos.values[4]).toBeCloseTo(-0.236, 5);
		// X/Z stay un-offset.
		expect(pos.values[0]).toBeCloseTo(0, 5);
		expect(pos.values[2]).toBeCloseTo(0, 5);
	});
});
