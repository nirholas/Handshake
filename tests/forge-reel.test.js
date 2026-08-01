// Forge Reel's pure core: the camera sampler, the codec choice, the filenames
// and the stage fit. Everything here is a decision that would be invisible in
// the recorded file until someone watched it back and found the camera inside
// the model, so each boundary is pinned.
import { describe, it, expect } from 'vitest';
import {
	REEL_PRESETS,
	REEL_ASPECTS,
	REEL_MIME_CANDIDATES,
	sampleTrack,
	pickVideoFormat,
	reelFilename,
	formatBytes,
	reelFrameCount,
	fitRadius,
	REEL_FPS,
} from '../src/forge-reel.js';

const track = [
	{ t: 0, theta: 0, phi: 80, radius: 2, fov: 1, ease: 'linear' },
	{ t: 1, theta: 100, phi: 60, radius: 1, fov: 0.5, ease: 'linear' },
];

describe('sampleTrack', () => {
	it('returns the first keyframe at t=0 and the last at t=1', () => {
		expect(sampleTrack(track, 0)).toEqual({ theta: 0, phi: 80, radius: 2, fov: 1 });
		expect(sampleTrack(track, 1)).toEqual({ theta: 100, phi: 60, radius: 1, fov: 0.5 });
	});

	it('interpolates linearly across a linear segment', () => {
		expect(sampleTrack(track, 0.5)).toEqual({ theta: 50, phi: 70, radius: 1.5, fov: 0.75 });
	});

	// Extrapolation is the failure that puts the camera inside the mesh, so out
	// of range input clamps rather than continuing the line.
	it('clamps rather than extrapolating outside 0..1', () => {
		expect(sampleTrack(track, -3)).toEqual(sampleTrack(track, 0));
		expect(sampleTrack(track, 9)).toEqual(sampleTrack(track, 1));
	});

	it('eases toward the keyframe that declares the curve', () => {
		const eased = [
			{ t: 0, theta: 0, phi: 0, radius: 1, fov: 1, ease: 'linear' },
			{ t: 1, theta: 100, phi: 0, radius: 1, fov: 1, ease: 'out' },
		];
		// An ease-out is past the halfway mark at the halfway time.
		expect(sampleTrack(eased, 0.5).theta).toBeGreaterThan(50);
	});

	it('picks the right segment in a multi-keyframe track', () => {
		const three = [
			{ t: 0, theta: 0, phi: 0, radius: 1, fov: 1, ease: 'linear' },
			{ t: 0.5, theta: 10, phi: 0, radius: 1, fov: 1, ease: 'linear' },
			{ t: 1, theta: 110, phi: 0, radius: 1, fov: 1, ease: 'linear' },
		];
		expect(sampleTrack(three, 0.25).theta).toBeCloseTo(5);
		expect(sampleTrack(three, 0.75).theta).toBeCloseTo(60);
	});

	it('refuses an empty track instead of returning a silent default', () => {
		expect(() => sampleTrack([], 0.5)).toThrow();
	});
});

describe('presets', () => {
	it('every preset starts at 0, ends at 1, and has ascending keyframes', () => {
		for (const preset of REEL_PRESETS) {
			expect(preset.track[0].t).toBe(0);
			expect(preset.track[preset.track.length - 1].t).toBe(1);
			for (let i = 1; i < preset.track.length; i++) {
				expect(preset.track[i].t).toBeGreaterThan(preset.track[i - 1].t);
			}
		}
	});

	it('every preset takes its stills from a point on its own track', () => {
		for (const preset of REEL_PRESETS) {
			expect(preset.heroT).toBeGreaterThanOrEqual(0);
			expect(preset.heroT).toBeLessThanOrEqual(1);
		}
	});

	// The turntable is the one shot users will loop, so its last frame has to
	// land back on its first. A non-multiple of 360 would visibly jump.
	it('the turntable loops seamlessly', () => {
		const turntable = REEL_PRESETS.find((p) => p.id === 'turntable');
		const start = sampleTrack(turntable.track, 0);
		const end = sampleTrack(turntable.track, 1);
		expect((end.theta - start.theta) % 360).toBe(0);
		expect(end.phi).toBe(start.phi);
		expect(end.radius).toBe(start.radius);
	});

	it('keeps every camera above the ground and outside the model', () => {
		for (const preset of REEL_PRESETS) {
			for (let t = 0; t <= 1; t += 0.05) {
				const s = sampleTrack(preset.track, t);
				expect(s.phi).toBeGreaterThan(0);
				expect(s.phi).toBeLessThan(180);
				expect(s.radius).toBeGreaterThan(0.5);
			}
		}
	});
});

describe('pickVideoFormat', () => {
	it('prefers MP4 when the browser can encode it', () => {
		const chosen = pickVideoFormat((mime) => mime.startsWith('video/mp4'));
		expect(chosen.ext).toBe('mp4');
	});

	it('falls back to VP9 WebM when MP4 is unavailable', () => {
		const chosen = pickVideoFormat((mime) => mime.includes('vp9'));
		expect(chosen).toEqual({ mime: 'video/webm;codecs=vp9', ext: 'webm' });
	});

	// A null return is a real state the UI renders (stills only), not an error
	// to swallow, so it must not degrade into a guess.
	it('returns null when nothing is supported', () => {
		expect(pickVideoFormat(() => false)).toBeNull();
		expect(pickVideoFormat(undefined)).toBeNull();
	});

	it('treats a browser that throws on an unknown codec as a no', () => {
		const chosen = pickVideoFormat((mime) => {
			if (mime.startsWith('video/mp4')) throw new TypeError('bad codec');
			return mime.includes('vp9');
		});
		expect(chosen.ext).toBe('webm');
	});

	it('offers only candidates with a matching container extension', () => {
		for (const candidate of REEL_MIME_CANDIDATES) {
			expect(candidate.mime.startsWith(`video/${candidate.ext}`)).toBe(true);
		}
	});
});

describe('reelFilename', () => {
	it('keeps the model name and drops its extension', () => {
		expect(reelFilename('brass-lantern.glb', 'hero', 'reel', 'mp4')).toBe(
			'brass-lantern-hero-reel.mp4',
		);
	});

	it('strips characters a filesystem would reject', () => {
		expect(reelFilename('a knight / "armor"', 'turntable', 'square', 'png')).toBe(
			'a-knight-armor-turntable-square.png',
		);
	});

	it('falls back to a usable name when nothing survives', () => {
		expect(reelFilename('///', 'hero', 'reel', 'webm')).toBe('forge-hero-reel.webm');
		expect(reelFilename('', 'hero', 'reel', 'webm')).toBe('forge-hero-reel.webm');
	});
});

describe('formatBytes', () => {
	it('scales the unit to the number', () => {
		expect(formatBytes(900)).toBe('900 B');
		expect(formatBytes(2048)).toBe('2 KB');
		expect(formatBytes(3.5 * 1024 * 1024)).toBe('3.5 MB');
		expect(formatBytes(42 * 1024 * 1024)).toBe('42 MB');
	});
});

describe('reelFrameCount', () => {
	// The reel is rendered frame by frame, so this number is the whole shot.
	it('is duration multiplied by the framerate', () => {
		expect(reelFrameCount(4)).toBe(4 * REEL_FPS);
		expect(reelFrameCount(12)).toBe(12 * REEL_FPS);
	});

	it('never returns fewer than the two frames motion needs', () => {
		expect(reelFrameCount(0)).toBe(2);
		expect(reelFrameCount(-5)).toBe(2);
		expect(reelFrameCount(undefined)).toBe(2);
	});

	it('accepts a different framerate', () => {
		expect(reelFrameCount(2, 60)).toBe(120);
	});
});

describe('fitRadius', () => {
	// A portrait frame is limited by its horizontal field of view. Ignoring
	// that is exactly how a 9:16 reel crops the subject's head off.
	it('pulls further back for a narrower frame', () => {
		const wide = fitRadius(1, 38, 1280 / 720);
		const tall = fitRadius(1, 38, 720 / 1280);
		expect(tall).toBeGreaterThan(wide);
	});

	it('scales linearly with the subject, so model scale is irrelevant', () => {
		const one = fitRadius(1, 38, 1);
		const ten = fitRadius(10, 38, 1);
		expect(ten / one).toBeCloseTo(10, 6);
	});

	it('keeps the whole bounding sphere inside the frame', () => {
		for (const aspect of [16 / 9, 1, 9 / 16]) {
			const distance = fitRadius(1, 38, aspect, 1);
			// At this distance the sphere subtends exactly the limiting field of
			// view, so any margin above 1 leaves air around it.
			const vFov = (38 * Math.PI) / 180;
			const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
			const limiting = Math.min(vFov, hFov);
			expect(Math.asin(1 / distance) * 2).toBeCloseTo(limiting, 6);
		}
	});

	it('stays finite for a degenerate model or aspect', () => {
		expect(Number.isFinite(fitRadius(0, 38, 1))).toBe(true);
		expect(Number.isFinite(fitRadius(1, 38, 0))).toBe(true);
	});
});

describe('aspects', () => {
	it('declares the three orientations the labels promise', () => {
		const byId = Object.fromEntries(REEL_ASPECTS.map((a) => [a.id, a]));
		expect(byId.wide.width).toBeGreaterThan(byId.wide.height);
		expect(byId.square.width).toBe(byId.square.height);
		expect(byId.tall.height).toBeGreaterThan(byId.tall.width);
	});

	it('uses even dimensions, which every H.264 encoder requires', () => {
		for (const aspect of REEL_ASPECTS) {
			expect(aspect.width % 2).toBe(0);
			expect(aspect.height % 2).toBe(0);
		}
	});
});
