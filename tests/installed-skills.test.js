/**
 * Installed marketplace skills → chat context (api/_lib/installed-skills.js).
 *
 * Installing a skill from /marketplace must actually change the user's agent:
 * loadInstalledSkills pulls the user's installed knowledge skills and
 * skillsPromptBlock renders them into the /api/chat system prompt under hard
 * budgets, so a pile of huge skills can never crowd out the persona or the
 * user's message. We mock only the DB boundary.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const H = vi.hoisted(() => ({ rows: [] }));

vi.mock('../api/_lib/db.js', () => ({
	sql: vi.fn(async () => H.rows),
}));

import { loadInstalledSkills, skillsPromptBlock } from '../api/_lib/installed-skills.js';
import { sql } from '../api/_lib/db.js';

beforeEach(() => {
	H.rows = [];
	vi.clearAllMocks();
});

describe('loadInstalledSkills', () => {
	it('returns [] for anonymous callers without touching the DB', async () => {
		expect(await loadInstalledSkills(null)).toEqual([]);
		expect(await loadInstalledSkills(undefined)).toEqual([]);
		expect(sql).not.toHaveBeenCalled();
	});

	it('maps rows to {slug, name, content}', async () => {
		H.rows = [
			{ slug: 'whale-wallet-tracking', name: 'whale-wallet-tracking', content: '# Whale' },
			{ slug: 'defi-yield', name: 'DeFi Yield', content: '# Yield' },
		];
		const skills = await loadInstalledSkills('00000000-0000-0000-0000-000000000001');
		expect(skills).toEqual([
			{ slug: 'whale-wallet-tracking', name: 'whale-wallet-tracking', content: '# Whale' },
			{ slug: 'defi-yield', name: 'DeFi Yield', content: '# Yield' },
		]);
	});
});

describe('skillsPromptBlock', () => {
	it('returns empty string for no skills', () => {
		expect(skillsPromptBlock([])).toBe('');
		expect(skillsPromptBlock(null)).toBe('');
		expect(skillsPromptBlock(undefined)).toBe('');
	});

	it('renders each skill under a slug header with the framing preamble', () => {
		const block = skillsPromptBlock([
			{ slug: 'whale-wallet-tracking', name: 'Whale', content: 'Track whales.' },
			{ slug: 'defi-yield', name: 'Yield', content: 'Chase yield safely.' },
		]);
		expect(block).toContain('Installed skills:');
		expect(block).toContain('--- skill: whale-wallet-tracking ---\nTrack whales.');
		expect(block).toContain('--- skill: defi-yield ---\nChase yield safely.');
	});

	it('clips a single oversized skill and marks the truncation', () => {
		const block = skillsPromptBlock([
			{ slug: 'huge', name: 'Huge', content: 'x'.repeat(50000) },
		]);
		expect(block.length).toBeLessThan(10000);
		expect(block).toContain('[…skill truncated]');
	});

	it('bounds the whole block even across many large skills', () => {
		const skills = Array.from({ length: 8 }, (_, i) => ({
			slug: `s${i}`,
			name: `S${i}`,
			content: 'y'.repeat(6000),
		}));
		const block = skillsPromptBlock(skills);
		// 24k content budget + headers/preamble slack.
		expect(block.length).toBeLessThan(26000);
		// The newest installs (front of the list) always make it in.
		expect(block).toContain('--- skill: s0 ---');
	});

	it('drops trailing skills rather than including a sliver', () => {
		const skills = [
			{ slug: 'a', name: 'A', content: 'a'.repeat(6000) },
			{ slug: 'b', name: 'B', content: 'b'.repeat(6000) },
			{ slug: 'c', name: 'C', content: 'c'.repeat(6000) },
			{ slug: 'd', name: 'D', content: 'd'.repeat(6000) },
			{ slug: 'e', name: 'E', content: 'e'.repeat(6000) },
		];
		const block = skillsPromptBlock(skills);
		expect(block).toContain('--- skill: d ---');
		// e would only get a <500-char sliver, so it is omitted entirely.
		expect(block).not.toContain('--- skill: e ---');
	});
});
