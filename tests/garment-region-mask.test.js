/**
 * Body-region mask sampler — src/garment-region-mask.js pure logic, plus a
 * pixel-level round-trip against the REAL baked mask
 * (public/avatars/parametric-base.regions.png) so a regenerated mask that
 * drifts from REGION_MASK_VALUES fails here, not in a user's editor.
 */

import { readFile } from 'node:fs/promises';
import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { decodeRegionCode, maskToAlphaRGBA } from '../src/garment-region-mask.js';
import { BODY_REGIONS, REGION_MASK_VALUES } from '../src/garment-taxonomy.js';

describe('decodeRegionCode', () => {
	it('decodes every canonical code', () => {
		for (const region of BODY_REGIONS) {
			expect(decodeRegionCode(REGION_MASK_VALUES[region])).toBe(region);
		}
	});

	it('tolerates resample error up to half the code step', () => {
		expect(decodeRegionCode(REGION_MASK_VALUES.torso + 11)).toBe('torso');
		expect(decodeRegionCode(REGION_MASK_VALUES.torso - 11)).toBe('torso');
	});

	it('rejects 0 and out-of-range codes', () => {
		expect(decodeRegionCode(0)).toBe(null);
		expect(decodeRegionCode(255)).toBe(null);
	});
});

describe('maskToAlphaRGBA', () => {
	it('zeroes only occluded regions; unassigned pixels stay visible', () => {
		const mask = new Uint8Array([
			0,                              // UV gutter → visible
			REGION_MASK_VALUES.torso,       // occluded → hidden
			REGION_MASK_VALUES.scalp,       // not occluded → visible
		]);
		const rgba = maskToAlphaRGBA(mask, ['torso']);
		// green channel is what three.js samples for alphaMap
		expect(rgba[0 * 4 + 1]).toBe(255);
		expect(rgba[1 * 4 + 1]).toBe(0);
		expect(rgba[2 * 4 + 1]).toBe(255);
	});
});

describe('the baked mask on disk', () => {
	it('round-trips: every non-zero pixel decodes to a canonical region', async () => {
		const png = await readFile(new URL('../public/avatars/parametric-base.regions.png', import.meta.url));
		const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
		expect(info.width).toBe(1024);

		const channel = info.channels; // grayscale may decode as 1 or 3 channels
		const counts = new Map();
		let bad = 0;
		for (let i = 0; i < info.width * info.height; i++) {
			const code = data[i * channel];
			if (!code) continue;
			const region = decodeRegionCode(code);
			if (!region) { bad++; continue; }
			counts.set(region, (counts.get(region) || 0) + 1);
		}
		expect(bad).toBe(0);
		// Every region the taxonomy defines is present on the body.
		for (const region of BODY_REGIONS) {
			expect(counts.get(region), `region ${region} absent from baked mask`).toBeGreaterThan(1000);
		}
	});
});
