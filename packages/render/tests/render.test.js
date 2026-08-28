// End-to-end renders of a real avatar, with no GPU and no browser.
//
// These run the whole path: meshopt-compressed GLB in, CPU-skinned triangles,
// mip-mapped texture sampling, tonemapped RGBA out. They use the default avatar
// that ships with the site, so a regression in loading, skinning, framing or
// rasterization fails here rather than in production OG cards.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { AvatarModel } from '../src/model.js';
import { renderFrame, renderFrames, frameCamera, PRESETS } from '../src/render.js';
import { parseClipJson } from '../src/clips.js';
import { encodePng, encodeApng } from '../src/encode.js';
import { decodePng } from '../src/image.js';

const AVATAR = 'public/avatars/default.glb';
const CLIP = 'public/animations/clips/idle.json';

let model;

beforeAll(async () => {
	model = await AvatarModel.load(AVATAR);
}, 60_000);

/** Fraction of pixels that carry any alpha. */
function coverage(frame) {
	let filled = 0;
	for (let i = 3; i < frame.data.length; i += 4) if (frame.data[i] > 8) filled++;
	return filled / (frame.width * frame.height);
}

/** Mean channel value over covered pixels, as a cheap "is it lit" probe. */
function meanLuma(frame) {
	let sum = 0;
	let n = 0;
	for (let i = 0; i < frame.data.length; i += 4) {
		if (frame.data[i + 3] <= 8) continue;
		sum += 0.2126 * frame.data[i] + 0.7152 * frame.data[i + 1] + 0.0722 * frame.data[i + 2];
		n++;
	}
	return n ? sum / n : 0;
}

describe('AvatarModel', () => {
	it('loads a meshopt-compressed, quantized avatar', () => {
		expect(model.meshes.length).toBeGreaterThan(0);
		expect(model.meshes.some((m) => m.skeleton)).toBe(true);
	});

	it('decodes its textures into mip pyramids', () => {
		expect(model.textures.size).toBeGreaterThan(0);
		for (const mips of model.textures.values()) {
			expect(mips.length).toBeGreaterThan(1);
			// A pyramid always bottoms out at a single texel.
			const last = mips[mips.length - 1];
			expect(last.width).toBe(1);
			expect(last.height).toBe(1);
		}
	});

	it('measures a plausible humanoid bounding box', () => {
		const height = model.bounds.max[1] - model.bounds.min[1];
		expect(height).toBeGreaterThan(1);
		expect(height).toBeLessThan(3);
	});
});

describe('renderFrame', () => {
	it('renders the avatar, textured and lit', () => {
		const frame = renderFrame(model, { width: 96, height: 96, supersample: 1, background: 'transparent' });
		expect(frame.width).toBe(96);
		expect(coverage(frame)).toBeGreaterThan(0.05);
		// A washed-out render (inverted winding, dead normals) pins the mean
		// near the rim colour. A correct one lands in the midtones.
		const luma = meanLuma(frame);
		expect(luma).toBeGreaterThan(20);
		expect(luma).toBeLessThan(215);
	});

	it('is deterministic', () => {
		const options = { width: 64, height: 64, supersample: 1 };
		const a = renderFrame(model, options);
		const b = renderFrame(model, options);
		expect(Buffer.from(a.data)).toEqual(Buffer.from(b.data));
	});

	it('fills the frame with an opaque background and keeps alpha without one', () => {
		const opaque = renderFrame(model, { width: 48, height: 48, supersample: 1, background: '#101820' });
		expect(coverage(opaque)).toBe(1);
		const clear = renderFrame(model, { width: 48, height: 48, supersample: 1, background: 'transparent' });
		expect(coverage(clear)).toBeLessThan(1);
	});

	it('frames a head closer than a full body', () => {
		const full = frameCamera(model.bounds, { focus: 'full' });
		const head = frameCamera(model.bounds, { focus: 'head' });
		expect(head.distance).toBeLessThan(full.distance);
		// The head shot looks at the top of the model, not its middle.
		expect(head.target[1]).toBeGreaterThan(full.target[1]);
	});

	it('covers more of the frame when focused on the head', () => {
		const full = renderFrame(model, { width: 64, height: 64, supersample: 1, background: 'transparent' });
		const head = renderFrame(model, { width: 64, height: 64, supersample: 1, background: 'transparent', focus: 'head' });
		expect(coverage(head)).toBeGreaterThan(coverage(full));
	});

	it('honours a radial backdrop', () => {
		const frame = renderFrame(model, {
			width: 64,
			height: 64,
			supersample: 1,
			background: { inner: '#ffffff', outer: '#000000' },
		});
		const centre = (32 * 64 + 32) * 4;
		const corner = 0;
		expect(frame.data[corner]).toBeLessThan(frame.data[centre]);
	});

	it('exposes named lighting presets', () => {
		expect(Object.keys(PRESETS)).toContain('studio');
		for (const preset of Object.values(PRESETS)) {
			expect(preset.lights.length).toBeGreaterThan(0);
			expect(preset.ambient).toHaveLength(3);
		}
	});
});

describe('animation', () => {
	it('retargets a library clip onto the avatar rig and moves it', async () => {
		const posed = await AvatarModel.load(AVATAR);
		const clip = parseClipJson(JSON.parse(readFileSync(CLIP, 'utf8')));
		expect(posed.addClips([clip])).toBe(1);
		expect(posed.play(clip.name)).toBeTruthy();

		posed.setTime(0);
		const first = renderFrame(posed, { width: 64, height: 64, supersample: 1, background: 'transparent' });
		posed.setTime(1.5);
		const later = renderFrame(posed, { width: 64, height: 64, supersample: 1, background: 'transparent' });
		expect(Buffer.from(first.data)).not.toEqual(Buffer.from(later.data));
	}, 60_000);

	it('renders a turntable where every frame differs', async () => {
		const frames = await renderFrames(model, {
			width: 48,
			height: 48,
			supersample: 1,
			background: 'transparent',
			frames: 4,
			spin: 360,
		});
		expect(frames).toHaveLength(4);
		const hashes = new Set(frames.map((f) => createHash('sha256').update(Buffer.from(f.data)).digest('hex')));
		expect(hashes.size).toBe(4);
	}, 60_000);
});

describe('encoders', () => {
	it('writes a PNG that decodes back to the same pixels', () => {
		const frame = renderFrame(model, { width: 32, height: 32, supersample: 1, background: '#123456' });
		const decoded = decodePng(new Uint8Array(encodePng(frame)));
		expect(decoded.width).toBe(32);
		expect(Buffer.from(decoded.data)).toEqual(Buffer.from(frame.data));
	});

	it('writes an APNG with one control chunk per frame', async () => {
		const frames = await renderFrames(model, { width: 24, height: 24, supersample: 1, frames: 3, spin: 90 });
		const png = encodeApng(frames, { fps: 12 });
		const text = png.toString('latin1');
		expect(text.slice(1, 4)).toBe('PNG');
		expect(text.split('acTL').length - 1).toBe(1);
		expect(text.split('fcTL').length - 1).toBe(3);
		// Frame 0 rides in IDAT; the rest are fdAT.
		expect(text.split('fdAT').length - 1).toBe(2);
	}, 60_000);

	it('refuses frames of mismatched size', () => {
		const a = { width: 4, height: 4, data: new Uint8ClampedArray(64) };
		const b = { width: 8, height: 4, data: new Uint8ClampedArray(128) };
		expect(() => encodeApng([a, b])).toThrow(/share the first frame size/);
	});
});
