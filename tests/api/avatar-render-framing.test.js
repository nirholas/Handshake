// /api/avatar/render regression locks for the two 2026-07-21 defects:
//
// 1. Pose parameter silently dropped. The old in-page applier used a
//    hand-rolled alias table whose Mixamo entries kept the ':' that
//    GLTFLoader strips from node names, so on mixamorig rigs zero joints
//    matched and every render came out in bind pose. The fix ships the pose
//    studio's real modules (pose-rig / glb-canonicalize / pose-mannequin)
//    into the headless page as data: URL modules and applies presets via
//    world-delta retargeting. These tests lock that wiring.
//
// 2. Portrait/headshot crops decapitated the model: the camera aimed at a
//    fraction of the bounding-box CENTER with a radius multiplier, which put
//    the top of the visible frustum below the crown. computeCameraFraming is
//    the pure replacement (vertical band + width fit); these tests assert the
//    head band always fits the frustum across scenes and aspect ratios.

import { describe, it, expect } from 'vitest';
import {
	SCENE_PRESETS,
	computeCameraFraming,
	resolveRenderParams,
	poseRuntimeModules,
	sceneViewerHtml,
} from '../../api/_lib/avatar-render.js';

// A typical rigged human: 1.7 units tall, arms at sides.
const HUMAN_BOX = { min: { x: -0.3, y: 0, z: -0.15 }, max: { x: 0.3, y: 1.7, z: 0.15 } };
// The same human bound in a T-pose: arm span roughly equals height.
const TPOSE_BOX = { min: { x: -0.85, y: 0, z: -0.15 }, max: { x: 0.85, y: 1.7, z: 0.15 } };
const FOV = 28;
const ASPECTS = [0.5, 0.75, 1, 16 / 9, 2];

function verticalHalfCoverage(distance, fovDeg) {
	return distance * Math.tan((fovDeg * Math.PI) / 360);
}
function horizontalHalfCoverage(distance, fovDeg, aspect) {
	return verticalHalfCoverage(distance, fovDeg) * aspect;
}

describe('SCENE_PRESETS bands', () => {
	it('every scene band tops out above the crown (headroom baked in)', () => {
		for (const [name, preset] of Object.entries(SCENE_PRESETS)) {
			expect(Array.isArray(preset.band), `${name} has a band`).toBe(true);
			expect(preset.band[1], `${name} band top`).toBeGreaterThanOrEqual(1.02);
			expect(preset.band[0], `${name} band order`).toBeLessThan(preset.band[1]);
		}
	});

	it('keeps the phi/theta the public endpoint catalog exposes', () => {
		for (const preset of Object.values(SCENE_PRESETS)) {
			expect(Number.isFinite(preset.phi)).toBe(true);
			expect(Number.isFinite(preset.theta)).toBe(true);
		}
	});
});

describe('computeCameraFraming', () => {
	it('keeps the head band inside the vertical frustum for every scene and aspect', () => {
		for (const [name, preset] of Object.entries(SCENE_PRESETS)) {
			for (const aspect of ASPECTS) {
				for (const box of [HUMAN_BOX, TPOSE_BOX]) {
					const f = computeCameraFraming(box, preset, aspect, FOV, { theta: preset.theta, phi: preset.phi });
					const sizeY = box.max.y - box.min.y;
					const bandTop = box.min.y + sizeY * preset.band[1];
					const covered = f.target.y + verticalHalfCoverage(f.distance, FOV);
					// The frustum top at the target plane must clear the band top,
					// which itself is above the crown, no decapitation possible.
					expect(covered, `${name} @ aspect ${aspect}`).toBeGreaterThanOrEqual(bandTop);
					expect(bandTop).toBeGreaterThanOrEqual(box.max.y);
					expect(f.distance).toBeGreaterThan(0);
				}
			}
		}
	});

	it('full-body fits the entire T-pose arm span horizontally at every aspect', () => {
		const preset = SCENE_PRESETS['full-body'];
		for (const aspect of ASPECTS) {
			const f = computeCameraFraming(TPOSE_BOX, preset, aspect, FOV, null);
			const halfSpan = (TPOSE_BOX.max.x - TPOSE_BOX.min.x) / 2;
			expect(horizontalHalfCoverage(f.distance, FOV, aspect), `aspect ${aspect}`).toBeGreaterThanOrEqual(halfSpan);
		}
	});

	it('crop scenes zoom tighter than full-body on a square render', () => {
		const order = ['full-body', 'upper-body', 'portrait', 'headshot'];
		const distances = order.map(
			(name) => computeCameraFraming(HUMAN_BOX, SCENE_PRESETS[name], 1, FOV, null).distance,
		);
		for (let i = 1; i < distances.length; i++) {
			expect(distances[i], `${order[i]} tighter than ${order[i - 1]}`).toBeLessThan(distances[i - 1]);
		}
	});

	it('aims the camera at the band center, elevated per phi', () => {
		const preset = SCENE_PRESETS['portrait'];
		const f = computeCameraFraming(HUMAN_BOX, preset, 1, FOV, null);
		const sizeY = HUMAN_BOX.max.y - HUMAN_BOX.min.y;
		const expectedLookY = HUMAN_BOX.min.y + (sizeY * (preset.band[0] + preset.band[1])) / 2;
		expect(f.target.y).toBeCloseTo(expectedLookY, 6);
		// phi < 90 puts the camera above the look-at point.
		expect(f.position.y).toBeGreaterThan(f.target.y);
	});

	it('orbit overrides beat preset angles, including a legitimate 0', () => {
		const preset = SCENE_PRESETS['portrait']; // theta 8
		const overridden = computeCameraFraming(HUMAN_BOX, preset, 1, FOV, { theta: 0, phi: 90 });
		// theta 0 + phi 90 → camera straight down +Z from the target, same height.
		expect(overridden.position.x).toBeCloseTo(overridden.target.x, 6);
		expect(overridden.position.y).toBeCloseTo(overridden.target.y, 6);
		expect(overridden.position.z).toBeGreaterThan(overridden.target.z);
	});

	it('survives a degenerate zero-size box without NaNs', () => {
		const point = { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } };
		const f = computeCameraFraming(point, SCENE_PRESETS['full-body'], 1, FOV, null);
		for (const v of [f.distance, f.position.x, f.position.y, f.position.z, f.target.x, f.target.y, f.target.z]) {
			expect(Number.isFinite(v)).toBe(true);
		}
	});
});

describe('pose runtime modules (world-delta retarget in the headless page)', () => {
	it('ships pose-rig, glb-canonicalize, and pose-mannequin as data: URL ESM', () => {
		const mods = poseRuntimeModules();
		expect(Object.keys(mods).sort()).toEqual(['glb-canonicalize', 'pose-mannequin', 'pose-rig']);
		for (const url of Object.values(mods)) {
			expect(url.startsWith('data:text/javascript;base64,')).toBe(true);
		}
	});

	it('rewrites pose-rig relative imports to bare specifiers the import map resolves', () => {
		const mods = poseRuntimeModules();
		const decode = (url) => Buffer.from(url.split(',')[1], 'base64').toString('utf8');
		const poseRig = decode(mods['pose-rig']);
		expect(poseRig).toContain("from 'glb-canonicalize'");
		expect(poseRig).toContain("from 'pose-mannequin'");
		expect(poseRig).toContain('export function poseFromMannequinPreset');
		expect(poseRig).toContain('export function makeGltfRig');
		expect(/from\s+['"]\.{1,2}\//.test(poseRig)).toBe(false);
		const canon = decode(mods['glb-canonicalize']);
		expect(canon).toContain('export function canonicalizeBoneName');
		const mannequin = decode(mods['pose-mannequin']);
		expect(mannequin).toContain('export class Mannequin');
	});
});

describe('sceneViewerHtml wiring', () => {
	const params = resolveRenderParams({ scene: 'portrait', width: 384, height: 512, pose: 'wave' }).params;

	it('embeds the requested pose and the pose-rig retarget path', () => {
		const html = sceneViewerHtml({
			glbUrl: 'https://cdn.example/avatar.glb',
			width: params.width,
			height: params.height,
			background: 'transparent',
			pose: { shoulderR: { x: 0, y: 0, z: -2.45 } },
			cameraOrbit: { theta: params.scenePreset.theta, phi: params.scenePreset.phi, radius: null },
			expression: null,
			scenePreset: params.scenePreset,
		});
		expect(html).toContain("import { makeGltfRig, poseFromMannequinPreset } from 'pose-rig'");
		expect(html).toContain('"pose-rig": "data:text/javascript;base64,');
		expect(html).toContain('poseFromMannequinPreset(poseMap)');
		expect(html).toContain('"shoulderR"');
		expect(html).toContain('function computeCameraFraming');
		// The retired alias table must not resurface: it never matched Mixamo
		// rigs (GLTFLoader strips the ':' its entries relied on).
		expect(html).not.toContain('mixamorig:leftshoulder');
		// The rule from the pose-preset retarget fix: never skeleton.pose().
		expect(html).not.toContain('skeleton.pose(');
	});

	it('still validates pose ids at the param layer', () => {
		expect(resolveRenderParams({ pose: 'wave' }).params.posePresetId).toBe('wave');
		expect(resolveRenderParams({ pose: 'nope' }).error.code).toBe('unknown_pose');
	});
});
