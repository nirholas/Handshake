// Shared-studio coordinate + room-key helpers (src/ar/studio-coords.js).
//
// The contract: local scene transforms and shared logical transforms round-trip
// exactly (so a model placed on one phone lands at the matching spot on another),
// angles normalize without NaN leaks, and room codes are unambiguous, URL-safe,
// and strictly validated (a mistyped code is rejected, never silently accepted).

import { describe, expect, it } from 'vitest';

import {
	generateRoomCode,
	localToShared,
	normalizeRoomCode,
	normDeg,
	normRad,
	roomKeyForCode,
	roomShareUrl,
	sharedToLocal,
} from '../src/ar/studio-coords.js';

describe('angle normalization', () => {
	it('wraps radians into [0, 2π) and degrees into [0, 360)', () => {
		expect(normRad(-Math.PI / 2)).toBeCloseTo(1.5 * Math.PI, 9);
		expect(normRad(3 * Math.PI)).toBeCloseTo(Math.PI, 9);
		expect(normDeg(-90)).toBe(270);
		expect(normDeg(450)).toBe(90);
	});
	it('collapses non-finite input to 0', () => {
		expect(normRad(NaN)).toBe(0);
		expect(normDeg(Infinity)).toBe(0);
	});
});

describe('local <-> shared frame round trip', () => {
	it('maps forward (-z) to north and right (+x) to east', () => {
		const s = localToShared({ x: 2, z: -3, yaw: 0, scale: 1 });
		expect(s.relEast).toBe(2);
		expect(s.relNorth).toBe(3); // -z forward → +north
	});

	it('round-trips a placement exactly (position, yaw, scale)', () => {
		const local = { x: 1.5, z: -2.25, yaw: Math.PI / 3, scale: 1.4, height: 1.7 };
		const back = sharedToLocal(localToShared(local));
		expect(back.x).toBeCloseTo(local.x, 6);
		expect(back.z).toBeCloseTo(local.z, 6);
		expect(back.yaw).toBeCloseTo(local.yaw, 6);
		expect(back.scale).toBeCloseTo(local.scale, 6);
	});

	it('round-trips a yaw near the wrap boundary without spinning', () => {
		const local = { x: 0, z: 0, yaw: normRad(-0.05), scale: 1 };
		const back = sharedToLocal(localToShared(local));
		expect(Math.cos(back.yaw)).toBeCloseTo(Math.cos(local.yaw), 6);
		expect(Math.sin(back.yaw)).toBeCloseTo(Math.sin(local.yaw), 6);
	});

	it('degrades garbage transforms to a valid origin placement', () => {
		const s = localToShared({ x: NaN, z: undefined, yaw: NaN, scale: 0 });
		expect(s).toEqual({ relEast: 0, relNorth: 0, yawDeg: 0, scale: 1, height: 0 });
	});
});

describe('room codes', () => {
	it('generates a 6-char code from the unambiguous alphabet', () => {
		const seq = [0.01, 0.2, 0.4, 0.6, 0.8, 0.99];
		let i = 0;
		const code = generateRoomCode(() => seq[i++ % seq.length]);
		expect(code).toHaveLength(6);
		expect(code).toMatch(/^[A-HJ-NP-Z2-9]+$/); // no O/I/L/0/1
	});

	it('normalizes a bare code, ignoring case, spaces, and hyphens', () => {
		const raw = generateRoomCode(() => 0.5);
		expect(normalizeRoomCode(` ${raw.toLowerCase()} `)).toBe(raw);
		expect(normalizeRoomCode(`${raw.slice(0, 3)}-${raw.slice(3)}`)).toBe(raw);
	});

	it('extracts the code from a pasted share URL', () => {
		const code = generateRoomCode(() => 0.3);
		expect(normalizeRoomCode(`https://three.ws/ar/studio?room=${code}&x=1`)).toBe(code);
	});

	it('rejects wrong length or ambiguous/foreign characters', () => {
		expect(normalizeRoomCode('ABC')).toBe('');       // too short
		expect(normalizeRoomCode('ABCDEFG')).toBe('');   // too long
		expect(normalizeRoomCode('ABCDE0')).toBe('');    // contains 0
		expect(normalizeRoomCode('ABCDEI')).toBe('');    // contains I
		expect(normalizeRoomCode('!!!!!!')).toBe('');
		expect(normalizeRoomCode('')).toBe('');
		expect(normalizeRoomCode(null)).toBe('');
	});

	it('derives a stable filterBy key and a valid share URL', () => {
		const code = generateRoomCode(() => 0.42);
		expect(roomKeyForCode(code)).toBe(`c-${code}`);
		expect(roomShareUrl('https://three.ws', code)).toBe(`https://three.ws/ar/studio?room=${code}`);
		expect(roomShareUrl('https://three.ws', 'bad')).toBe('https://three.ws/ar/studio');
	});
});
