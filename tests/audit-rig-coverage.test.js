/**
 * Unit tests for the rig-coverage audit helpers (scripts/audit-rig-coverage.mjs).
 *
 * The audit is what turns "we think we support these rigs" into a measurement,
 * so its two pure helpers need to be right: the Range-request GLB header parser
 * (it must refuse anything it cannot fully read rather than report a truncated
 * skeleton) and the rig scorer (it decides whether an avatar animates at all).
 */

import { describe, it, expect } from 'vitest';
import { parseGlbJsonChunk, glbJsonChunkEnd, scoreRig } from '../scripts/audit-rig-coverage.mjs';

const GLB_MAGIC = 0x46546c67;
const CHUNK_TYPE_JSON = 0x4e4f534a;

// Build just the leading bytes of a GLB — the audit only ever fetches this much.
function buildHead(jsonObj, { magic = GLB_MAGIC, version = 2, chunkType = CHUNK_TYPE_JSON, truncate = 0 } = {}) {
	let jsonBytes = new TextEncoder().encode(JSON.stringify(jsonObj));
	const pad = (4 - (jsonBytes.length % 4)) % 4;
	if (pad) {
		const padded = new Uint8Array(jsonBytes.length + pad);
		padded.set(jsonBytes);
		for (let i = 0; i < pad; i++) padded[jsonBytes.length + i] = 0x20;
		jsonBytes = padded;
	}
	const ab = new ArrayBuffer(20 + jsonBytes.length - truncate);
	const dv = new DataView(ab);
	const u8 = new Uint8Array(ab);
	dv.setUint32(0, magic, true);
	dv.setUint32(4, version, true);
	dv.setUint32(8, 20 + jsonBytes.length, true);
	dv.setUint32(12, jsonBytes.length, true);
	dv.setUint32(16, chunkType, true);
	u8.set(jsonBytes.subarray(0, jsonBytes.length - truncate), 20);
	return ab;
}

// A skeleton with the given joint names, wired as one skin.
function rigJson(names, extra = {}) {
	return {
		asset: { version: '2.0', ...(extra.generator ? { generator: extra.generator } : {}) },
		nodes: names.map((name) => ({ name })),
		skins: [{ joints: names.map((_, i) => i) }],
	};
}

// A complete canonical humanoid — the shape every ingest lane should produce.
const FULL_RIG = [
	'Hips', 'Spine', 'Spine1', 'Neck', 'Head',
	'LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand',
	'RightShoulder', 'RightArm', 'RightForeArm', 'RightHand',
	'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'LeftToeBase',
	'RightUpLeg', 'RightLeg', 'RightFoot', 'RightToeBase',
];

describe('parseGlbJsonChunk', () => {
	it('reads the JSON chunk out of a GLB head', () => {
		const json = parseGlbJsonChunk(buildHead(rigJson(['Hips'])));
		expect(json?.nodes?.[0]?.name).toBe('Hips');
	});

	it('returns null for anything that is not a GLB v2 JSON chunk', () => {
		expect(parseGlbJsonChunk(null)).toBeNull();
		expect(parseGlbJsonChunk(new ArrayBuffer(8))).toBeNull();
		expect(parseGlbJsonChunk(buildHead(rigJson(['Hips']), { magic: 0xdeadbeef }))).toBeNull();
		expect(parseGlbJsonChunk(buildHead(rigJson(['Hips']), { version: 1 }))).toBeNull();
		expect(parseGlbJsonChunk(buildHead(rigJson(['Hips']), { chunkType: 0x004e4942 }))).toBeNull();
	});

	it('refuses a JSON chunk that runs past the fetched slice', () => {
		// The whole point of the Range request is that we may not have the full
		// chunk. Reporting a truncated skeleton would understate rig coverage, so
		// a short read must be null rather than parsed.
		expect(parseGlbJsonChunk(buildHead(rigJson(FULL_RIG), { truncate: 40 }))).toBeNull();
	});
});

describe('glbJsonChunkEnd', () => {
	it('reports the exact byte count needed for the JSON chunk', () => {
		const head = buildHead(rigJson(FULL_RIG));
		const end = glbJsonChunkEnd(head);
		expect(end).toBe(head.byteLength);
		expect(parseGlbJsonChunk(head.slice(0, end))).not.toBeNull();
	});

	it('still reports the needed length from a SHORT read, so it can be re-requested', () => {
		// This is the whole point: a heavily-authored rig can declare a
		// multi-megabyte JSON chunk. Treating that short read as a dead error
		// silently drops the most complex skeletons from the audit — exactly the
		// ones it exists to measure. The header alone must yield the real length.
		const full = buildHead(rigJson(FULL_RIG));
		const truncated = full.slice(0, 128);
		expect(parseGlbJsonChunk(truncated)).toBeNull();
		expect(glbJsonChunkEnd(truncated)).toBe(full.byteLength);
	});

	it('returns null for anything that is not a GLB v2 JSON chunk', () => {
		expect(glbJsonChunkEnd(null)).toBeNull();
		expect(glbJsonChunkEnd(new ArrayBuffer(8))).toBeNull();
		expect(glbJsonChunkEnd(buildHead(rigJson(['Hips']), { magic: 0xdeadbeef }))).toBeNull();
		expect(glbJsonChunkEnd(buildHead(rigJson(['Hips']), { version: 1 }))).toBeNull();
	});
});

describe('scoreRig', () => {
	it('scores a complete canonical humanoid as animating with full legs', () => {
		const s = scoreRig(rigJson(FULL_RIG, { generator: 'three.ws rig worker' }));
		expect(s.skinned).toBe(true);
		expect(s.animates).toBe(true);
		expect(s.legs).toBe(6);
		expect(s.core).toBe(9);
		expect(s.unmapped).toEqual([]);
		expect(s.generator).toBe('three.ws rig worker');
	});

	it('reports an unskinned model rather than throwing', () => {
		const s = scoreRig({ asset: { version: '2.0' }, nodes: [{ name: 'Cube', mesh: 0 }] });
		expect(s.skinned).toBe(false);
		expect(s.animates).toBe(false);
		expect(s.joints).toBe(0);
	});

	it('does not count a rig with no Hips as animating', () => {
		// The Advanced Skeleton failure exactly: arms and legs resolve, but with no
		// root the retargeter has nothing to anchor to and the avatar never moves.
		const noHips = FULL_RIG.filter((b) => b !== 'Hips');
		const s = scoreRig(rigJson(noHips));
		expect(s.canonical).not.toContain('Hips');
		expect(s.animates).toBe(false);
	});

	it('collects unmapped joint names for the alias-candidate report', () => {
		const s = scoreRig(rigJson([...FULL_RIG, 'Weapon_R', '_rootJoint', 'Palm1.L']));
		expect(s.unmapped.sort()).toEqual(['Palm1.L', 'Weapon_R', '_rootJoint']);
		expect(s.animates).toBe(true); // scaffolding must not drag the score down
	});

	it('counts each canonical bone once even when two joints resolve to it', () => {
		// `left_ankle` and `left_foot` both canonicalize to LeftFoot; the audit must
		// not double-count and report more coverage than the rig actually has.
		const s = scoreRig(rigJson(['Hips', 'left_ankle', 'left_foot']));
		expect(s.canonical.filter((b) => b === 'LeftFoot')).toHaveLength(1);
	});

	it('scores the production rig families the audit unblocked', () => {
		// Sketchfab j_ export: previously mapped zero bones.
		const sketchfab = scoreRig(rigJson([
			'j_pelvis_05', 'j_spine_0_016', 'j_spine_1_017',
			'j_L_hip_06', 'j_L_knee_07', 'j_L_ankle_08',
			'j_R_hip_011', 'j_R_knee_012', 'j_R_ankle_013',
		]));
		expect(sketchfab.canonical).toContain('Hips');
		expect(sketchfab.canonical).toContain('LeftUpLeg');
		expect(sketchfab.canonical).toContain('RightLeg');

		// Advanced Skeleton: had limbs but no root, so it never animated.
		const advSkel = scoreRig(rigJson([
			'Root_M_03', 'Spine1_M_04', 'Neck_M', 'Head_M',
			'Shoulder_L', 'Elbow_L', 'Wrist_L', 'Shoulder_R', 'Elbow_R', 'Wrist_R',
			'Hip_L', 'Knee_L', 'Ankle_L', 'Hip_R', 'Knee_R', 'Ankle_R',
		]));
		expect(advSkel.canonical).toContain('Hips');
		expect(advSkel.animates).toBe(true);
	});

	it('does not credit a constraint-driven control rig with coverage it cannot deliver', () => {
		// Blender Auto-Rig-Pro style: the deform bones are leaves off tracker nodes,
		// so driving them would tear the mesh. Falling back is correct — the score
		// must reflect that, not claim the rig animates.
		const s = scoreRig(rigJson([
			'cwf_pelvis_0', 'def_arm_0.R', 'def_arm_1.R', 'def_leg_0.L', 'def_leg_1.L',
			'fk_leg_0.L', 'c_arm_0_tracker.R', 'cwh_leg_softik_0.L',
		]));
		expect(s.animates).toBe(false);
		expect(s.core).toBe(0);
	});
});
