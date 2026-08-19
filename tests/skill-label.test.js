/**
 * skill-label: the one place a machine skill slug becomes something a person
 * reads. Pins the cases that made three surfaces disagree before it existed.
 */
import { describe, it, expect } from 'vitest';
import { skillLabel } from '../src/shared/skill-label.js';

describe('skillLabel', () => {
	it('title-cases a hyphenated slug', () => {
		expect(skillLabel('portfolio-track')).toBe('Portfolio Track');
	});

	it('title-cases an underscored slug', () => {
		expect(skillLabel('deep_diligence_card')).toBe('Deep Diligence Card');
	});

	it('uppercases acronyms instead of title-casing them', () => {
		expect(skillLabel('nft-lookup')).toBe('NFT Lookup');
		expect(skillLabel('api_calls')).toBe('API Calls');
		expect(skillLabel('mcp-bridge')).toBe('MCP Bridge');
		expect(skillLabel('x402-settle')).toBe('X402 Settle');
	});

	it('leaves a deliberately mixed-case token alone', () => {
		expect(skillLabel('watsonx-orchestrate')).toBe('Watsonx Orchestrate');
		expect(skillLabel('iOS-share')).toBe('iOS Share');
	});

	it('normalises shouty and mixed separators', () => {
		expect(skillLabel('TRENDING')).toBe('Trending');
		expect(skillLabel('quick signal_card')).toBe('Quick Signal Card');
		expect(skillLabel('  spaced--out  ')).toBe('Spaced Out');
	});

	it('falls back rather than rendering an empty label', () => {
		expect(skillLabel('')).toBe('Skill');
		expect(skillLabel(null)).toBe('Skill');
		expect(skillLabel(undefined, 'Other')).toBe('Other');
	});
});
