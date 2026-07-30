import { describe, it, expect } from 'vitest';
import { SLOTS, DEFAULT_ANIMATION_MAP, resolveSlot } from '../../src/runtime/animation-slots.js';

describe('SLOTS', () => {
	it('is an array of slot names', () => {
		expect(Array.isArray(SLOTS)).toBe(true);
		expect(SLOTS.length).toBeGreaterThanOrEqual(10);
	});

	it('contains expected slot names', () => {
		const expected = [
			'idle',
			'wave',
			'nod',
			'shake',
			'think',
			'celebrate',
			'concern',
			'bow',
			'point',
			'shrug',
			'fidget',
			'dance',
			'inspect',
			'present',
			'sign',
			'curiosity',
			'patience',
			'manipulate',
			'conjure',
		];
		expect(SLOTS).toEqual(expected);
	});

	it('has no duplicate entries', () => {
		expect(new Set(SLOTS).size).toBe(SLOTS.length);
	});
});

describe('DEFAULT_ANIMATION_MAP', () => {
	it('has an entry for every slot', () => {
		for (const slot of SLOTS) {
			expect(DEFAULT_ANIMATION_MAP).toHaveProperty(slot);
			expect(typeof DEFAULT_ANIMATION_MAP[slot]).toBe('string');
		}
	});

	it('maps idle to idle', () => {
		expect(DEFAULT_ANIMATION_MAP.idle).toBe('idle');
	});

	it('maps celebrate to celebrate', () => {
		expect(DEFAULT_ANIMATION_MAP.celebrate).toBe('celebrate');
	});
});

describe('resolveSlot', () => {
	it('returns default mapping when no override given', () => {
		expect(resolveSlot('idle', null)).toBe('idle');
		expect(resolveSlot('celebrate', null)).toBe('celebrate');
		expect(resolveSlot('wave', null)).toBe(DEFAULT_ANIMATION_MAP.wave);
	});

	it('uses override map when slot is present', () => {
		const overrides = { wave: 'custom_wave_clip' };
		expect(resolveSlot('wave', overrides)).toBe('custom_wave_clip');
	});

	it('falls through to default when override does not contain slot', () => {
		const overrides = { wave: 'custom_wave_clip' };
		expect(resolveSlot('nod', overrides)).toBe(DEFAULT_ANIMATION_MAP.nod);
	});

	it('returns the slot name itself for unknown slots', () => {
		expect(resolveSlot('unknown_slot', null)).toBe('unknown_slot');
	});

	it('returns the slot name for unknown slots even with overrides', () => {
		const overrides = { wave: 'something' };
		expect(resolveSlot('mystery', overrides)).toBe('mystery');
	});

	it('handles empty override map', () => {
		expect(resolveSlot('think', {})).toBe(DEFAULT_ANIMATION_MAP.think);
	});

	it('override takes priority over default even if default exists', () => {
		const overrides = { idle: 'breathing_idle' };
		expect(resolveSlot('idle', overrides)).toBe('breathing_idle');
	});
});
