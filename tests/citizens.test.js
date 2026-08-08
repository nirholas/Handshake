// The citizen identity layer that turns /play's ambient crowd into people you
// can meet. These are the pure-logic guards: which gallery records count as a
// real identity someone can be introduced by.
//
// The stakes are concrete. A live sample of the first 96 public avatars was 62
// copies of the onboarding default "My First Agent"; drawn straight, two thirds
// of the plaza would be identically-named clones wearing a stranger's bio.
import { describe, it, expect } from 'vitest';
import { isCitizen } from '../src/game/npc/citizens.js';

const record = (over = {}) => ({
	url: 'https://cdn.example/model.glb',
	bytes: 1024,
	avatarId: 'a1',
	name: 'Avery',
	description: null,
	altText: null,
	tags: [],
	viewCount: 0,
	thumbnailUrl: null,
	agentId: null,
	wallet: null,
	onchain: null,
	...over,
});

describe('isCitizen', () => {
	it('accepts a record with a real display name', () => {
		expect(isCitizen(record({ name: 'Avery' }))).toBe(true);
		expect(isCitizen(record({ name: 'jessica' }))).toBe(true);
		expect(isCitizen(record({ name: 'Raidah' }))).toBe(true);
		expect(isCitizen(record({ name: 'Drake' }))).toBe(true);
	});

	it('rejects a missing or empty name', () => {
		expect(isCitizen(null)).toBe(false);
		expect(isCitizen(undefined)).toBe(false);
		expect(isCitizen(record({ name: null }))).toBe(false);
	});

	// The onboarding defaults an untouched agent still wears. Mirrors
	// PLACEHOLDER_NAMES in api/agents/public.js, which keeps the same rows off
	// the live agent wall.
	it('rejects onboarding placeholder names, case-insensitively', () => {
		for (const name of [
			'My First Agent', 'my first agent', 'MY FIRST AGENT',
			'Agent', 'Avatar', 'My Avatar', 'My Agent',
			'Untitled Agent', 'New Agent', 'Untitled', 'Character', 'Model',
		]) {
			expect(isCitizen(record({ name })), name).toBe(false);
		}
	});

	it('rejects generated avatar labels that identify nobody', () => {
		expect(isCitizen(record({ name: 'Avatar #e6f105' }))).toBe(false);
		expect(isCitizen(record({ name: 'Avatar_2' }))).toBe(false);
		expect(isCitizen(record({ name: 'Avatar-9' }))).toBe(false);
	});

	it('rejects raw export filenames from the generation lanes', () => {
		expect(isCitizen(record({ name: 'model (11)' }))).toBe(false);
		expect(isCitizen(record({ name: 'model(3)' }))).toBe(false);
		expect(isCitizen(record({ name: 'Meshy_AI_Go_Fund_Yourself_biped_Meshy_Merged_Animations' }))).toBe(false);
		// Anything long enough to be a filename rather than a display name.
		expect(isCitizen(record({ name: 'x'.repeat(41) }))).toBe(false);
	});

	it('keeps names that merely contain a placeholder word', () => {
		// "Agent" alone is a placeholder; a real character named around it is not.
		expect(isCitizen(record({ name: 'Agent Ada' }))).toBe(true);
		expect(isCitizen(record({ name: 'Secret Agent' }))).toBe(true);
		expect(isCitizen(record({ name: 'Modelo' }))).toBe(true);
		// A 40-character name is still plausibly a display name; 41 is not.
		expect(isCitizen(record({ name: 'y'.repeat(40) }))).toBe(true);
	});
});
