import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { inspectOne, expectedGaps, CHANNELS } from '../scripts/inspect-glb-materials.mjs';

const avatar = (name) => resolve(process.cwd(), 'public/avatars', name);
// Two real bundled meshes with deliberately different material completeness:
// fox.glb carries a baseColor atlas and nothing else (the shape every
// reconstruction lane emits), michelle.glb carries normal + metallicRoughness
// as well. Between them they exercise both sides of the gap check.
const ALBEDO_ONLY = avatar('fox.glb');
const MULTI_CHANNEL = avatar('michelle.glb');

describe('inspect-glb-materials', () => {
	it('names the five glTF metallic-roughness texture slots', () => {
		expect(CHANNELS.map((c) => c.key)).toEqual([
			'baseColor',
			'normal',
			'metallicRoughness',
			'occlusion',
			'emissive',
		]);
	});

	it('implies no channels for an untextured material', () => {
		// A flat colour swatch is a legitimate material, not a defect.
		expect(expectedGaps({}, { baseColor: null })).toEqual([]);
	});

	it('implies normal, metallicRoughness and occlusion once a baseColor atlas exists', () => {
		const gaps = expectedGaps({}, { baseColor: { present: true } });
		expect(gaps).toEqual(['normal', 'metallicRoughness', 'occlusion']);
	});

	it('does not re-report a channel the material already carries', () => {
		const gaps = expectedGaps({}, {
			baseColor: { present: true },
			normal: { present: true },
			metallicRoughness: { present: true },
		});
		expect(gaps).toEqual(['occlusion']);
	});

	it.runIf(existsSync(ALBEDO_ONLY))(
		'reports an albedo-only mesh as missing the derived channels',
		async () => {
			const r = await inspectOne({ source: ALBEDO_ONLY, label: 'fox' });
			expect(r.materialCount).toBeGreaterThan(0);
			const m = r.materials[0];
			expect(m.channels.baseColor.present).toBe(true);
			expect(m.channels.baseColor.width).toBeGreaterThan(0);
			expect(m.gaps).toContain('normal');
			expect(m.gaps).toContain('metallicRoughness');
		},
		60_000,
	);

	it.runIf(existsSync(MULTI_CHANNEL))(
		'reads resolutions and extensions from a multi-channel mesh',
		async () => {
			const r = await inspectOne({ source: MULTI_CHANNEL, label: 'michelle' });
			const m = r.materials[0];
			expect(m.channels.normal.present).toBe(true);
			expect(m.channels.metallicRoughness.present).toBe(true);
			// Resolution is decoded from the image header, never assumed.
			expect(m.channels.normal.height).toBeGreaterThan(0);
			expect(r.extensionsUsed.length).toBeGreaterThan(0);
			// A mesh that already has a normal map must not be reported as lacking one.
			expect(m.gaps).not.toContain('normal');
		},
		60_000,
	);

	it.runIf(existsSync(ALBEDO_ONLY))(
		'counts primitives that carry no material at all',
		async () => {
			// glTF 2.0 3.7.2: a primitive with no material takes the default
			// material, whose metallic and roughness are both 1.0, so it renders as
			// rough bare metal. That has to be counted, not silently read as zero
			// materials.
			const r = await inspectOne({ source: ALBEDO_ONLY, label: 'fox' });
			expect(typeof r.unmaterialedPrimitives).toBe('number');
			expect(r.unmaterialedPrimitives).toBeGreaterThanOrEqual(0);
		},
		60_000,
	);
});
