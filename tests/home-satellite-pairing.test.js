// Pairing codes, and the streaming resampler the satellite's microphone needs.
//
// A pairing code is typed by a person off one screen into another, and it buys
// a microphone in a house. Both halves of that sentence show up here: the code
// alphabet exists so nobody mistypes it, and the normalizer exists so the four
// ways people paste it are all the same code.

import { describe, expect, it } from 'vitest';

import { generateCode, normalizeCode, CODE_TTL_MINUTES } from '../api/_lib/home/satellites.js';
import { PcmDownsampler, floatTo16kPcm } from '../src/voice/mic-capture.js';

describe('pairing codes', () => {
	it('generates a readable, hyphenated code', () => {
		for (let i = 0; i < 200; i += 1) {
			const code = generateCode();
			expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
			// The characters people confuse are the ones that turn a working setup
			// into "pairing failed", so they are not in the alphabet at all.
			expect(code).not.toMatch(/[O0I1L]/);
		}
	});

	it('generates distinct codes', () => {
		const codes = new Set(Array.from({ length: 500 }, generateCode));
		expect(codes.size).toBe(500);
	});

	it('accepts every way somebody pastes the same code', () => {
		const canonical = normalizeCode('RH23-KSW5');
		expect(canonical).toBe('RH23-KSW5');
		expect(normalizeCode('rh23ksw5')).toBe(canonical);
		expect(normalizeCode('  RH23 KSW5 \n')).toBe(canonical);
		expect(normalizeCode('RH23_KSW5')).toBe(canonical);
	});

	it('rejects a code that is the wrong length or uses excluded characters', () => {
		expect(normalizeCode('RH23-KSW')).toBeNull();
		expect(normalizeCode('RH23-KSW55')).toBeNull();
		expect(normalizeCode('RH23-KSW0')).toBeNull();
		expect(normalizeCode('RH23-KSWI')).toBeNull();
		expect(normalizeCode('')).toBeNull();
		expect(normalizeCode(null)).toBeNull();
	});

	it('expires in minutes, not hours', () => {
		expect(CODE_TTL_MINUTES).toBeLessThanOrEqual(30);
		expect(CODE_TTL_MINUTES).toBeGreaterThan(0);
	});
});

describe('the streaming resampler', () => {
	const tone = (samples, rate, hz) => Float32Array.from({ length: samples }, (_, i) => Math.sin((2 * Math.PI * hz * i) / rate));

	it('produces roughly the right number of samples for a 48 kHz device', () => {
		const down = new PcmDownsampler(48000);
		let produced = 0;
		// 128-sample frames, the size an AudioWorklet actually delivers.
		for (let i = 0; i < 375; i += 1) produced += down.push(tone(128, 48000, 220).subarray(0)).length;
		// One second of 48 kHz audio is 16000 samples at 16 kHz. Allow a frame of
		// slack for the sample carried across the final boundary.
		expect(produced).toBeGreaterThan(15980);
		expect(produced).toBeLessThanOrEqual(16000);
	});

	it('does not drop a fraction of a sample on every frame', () => {
		// 128 samples at 48 kHz is 42.67 output samples. A stateless resample
		// floors that 375 times a second, loses 250 samples, and turns a sentence
		// into a click track.
		const stateless = Math.floor(128 / 3) * 375;
		const down = new PcmDownsampler(48000);
		let streamed = 0;
		for (let i = 0; i < 375; i += 1) streamed += down.push(tone(128, 48000, 220)).length;
		expect(streamed).toBeGreaterThan(stateless);
	});

	it('passes 16 kHz through without resampling loss', () => {
		const down = new PcmDownsampler(16000);
		const out = down.push(tone(1600, 16000, 300));
		expect(out.length).toBeGreaterThan(1590);
		expect(out).toBeInstanceOf(Int16Array);
	});

	it('quantizes to signed 16-bit and clamps', () => {
		const down = new PcmDownsampler(16000);
		const out = down.push(Float32Array.from({ length: 64 }, () => 2));
		for (const sample of out) expect(sample).toBe(32767);
	});

	it('returns nothing for an empty frame', () => {
		expect(new PcmDownsampler(48000).push(new Float32Array(0))).toHaveLength(0);
		expect(new PcmDownsampler(48000).push(null)).toHaveLength(0);
	});

	it('forgets its carried state on reset', () => {
		const down = new PcmDownsampler(48000);
		down.push(tone(4096, 48000, 220));
		down.reset();
		expect(down._tail).toHaveLength(0);
		expect(down._phase).toBe(0);
	});

	it('agrees with the one-shot conversion the WAV builder uses', () => {
		const samples = tone(48000, 48000, 200);
		const oneShot = floatTo16kPcm(samples, 48000);
		const down = new PcmDownsampler(48000);
		let streamed = 0;
		for (let i = 0; i < samples.length; i += 128) streamed += down.push(samples.subarray(i, i + 128)).length;
		expect(Math.abs(streamed - oneShot.length)).toBeLessThan(4);
	});
});
