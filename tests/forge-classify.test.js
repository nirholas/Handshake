// api/_lib/forge-classify.js — prompt → model_category classifier.
//
// Pins the priority ordering (a humanoid subject wins over what it wears/rides)
// and representative coverage per category, plus the graceful 'other' fallback.

import { describe, it, expect } from 'vitest';
import { classifyModelCategory } from '../api/_lib/forge-classify.js';

describe('classifyModelCategory', () => {
	it('classifies people/characters as avatar', () => {
		for (const p of [
			'a medieval knight in ornate armor',
			'a cyberpunk woman with neon hair',
			'a friendly astronaut character',
			'a wizard holding a staff',
			'portrait bust of an old king',
		]) expect(classifyModelCategory(p)).toBe('avatar');
	});

	it('classifies animals/monsters as creature', () => {
		for (const p of [
			'a low-poly red fox, sitting',
			'a fierce dragon with green scales',
			'a cute cartoon octopus',
			'a giant cave spider',
		]) expect(classifyModelCategory(p)).toBe('creature');
	});

	it('classifies craft as vehicle', () => {
		for (const p of [
			'a sci-fi combat spaceship',
			'a vintage red sports car',
			'a wooden sailboat with a striped sail',
			'a military tank, brushed metal',
		]) expect(classifyModelCategory(p)).toBe('vehicle');
	});

	it('classifies places/architecture as scene', () => {
		for (const p of [
			'the gate of an ancient temple',
			'a cozy medieval tavern interior',
			'a small floating island in the clouds',
		]) expect(classifyModelCategory(p)).toBe('scene');
	});

	it('classifies worn/wielded gear as accessory', () => {
		for (const p of [
			'a weathered bronze medieval helmet',
			'an ornate golden crown with rubies',
			'a glowing plasma sword',
			'a round wooden shield with iron rim',
		]) expect(classifyModelCategory(p)).toBe('accessory');
	});

	it('lets a person-word in a compound win for avatar (astronaut helmet → avatar)', () => {
		// A prompt naming a character type is classified as that character even when
		// it also names gear — a deliberate, documented priority, not a bug.
		expect(classifyModelCategory('a weathered bronze astronaut helmet')).toBe('avatar');
	});

	it('classifies everyday objects as item', () => {
		for (const p of [
			'a glazed ceramic teapot',
			'a small ceramic espresso cup, matte white',
			'a carved wooden treasure chest',
		]) expect(classifyModelCategory(p)).toBe('item');
	});

	it('prioritises the humanoid subject over what it holds or rides', () => {
		expect(classifyModelCategory('a knight riding a horse')).toBe('avatar');
		expect(classifyModelCategory('a soldier holding a rifle')).toBe('avatar');
		// A creature wearing gear is still a creature (no avatar keyword present).
		expect(classifyModelCategory('a dragon wearing a golden crown')).toBe('creature');
	});

	it('respects word boundaries (no substring false positives)', () => {
		// "carpet"/"scarf" must not trip the vehicle "car" rule.
		expect(classifyModelCategory('a persian carpet')).not.toBe('vehicle');
		// "background" must not trip anything odd; unmatched → other.
		expect(classifyModelCategory('an abstract swirl')).toBe('other');
	});

	it('falls back to other on empty or unmatched prompts', () => {
		expect(classifyModelCategory('')).toBe('other');
		expect(classifyModelCategory(null)).toBe('other');
		expect(classifyModelCategory('   ')).toBe('other');
		expect(classifyModelCategory('a mysterious glowing whatsit')).toBe('other');
	});
});
