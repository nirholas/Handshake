import { describe, it, expect } from 'vitest';
import { classify, filterByAudience } from '../src/classify.js';

const commit = (message, over = {}) => ({
	sha: 'a'.repeat(40),
	parents: [{ sha: 'p' }],
	commit: { message, author: { name: 'nirholas', date: '2026-08-27T10:00:00Z' } },
	...over,
});

describe('classify', () => {
	it('puts a substantive feature in front of holders', () => {
		const r = classify(commit('feat(wallet): let a user withdraw without a second signature'));
		expect(r.audience).toBe('holder');
		expect(r.signal).toBeGreaterThan(0.6);
		expect(r.noise).toBe(false);
	});

	it('treats dependency chores as internal noise', () => {
		const r = classify(commit('chore(deps): bump ws to 8.21'));
		expect(r.audience).toBe('internal');
		expect(r.noise).toBe(true);
	});

	it('treats merge commits as noise regardless of their subject', () => {
		const r = classify(commit('Merge pull request #4 from a/b'));
		expect(r.noise).toBe(true);
		expect(r.signal).toBe(0);
	});

	it('marks a lockfile-only change as noise when files are supplied', () => {
		const r = classify(
			commit('chore: refresh the lockfile', { files: [{ filename: 'package-lock.json' }] }),
		);
		expect(r.noise).toBe(true);
		expect(r.reasons.some((x) => x.rule === 'files:lockfile-only')).toBe(true);
	});

	it('raises a breaking change out of the internal bucket', () => {
		const r = classify(commit('refactor(sdk)!: rename every export'));
		expect(r.audience).not.toBe('internal');
		expect(r.reasons.some((x) => x.rule === 'breaking')).toBe(true);
	});

	it('keeps reverts visible', () => {
		const r = classify(commit('revert: roll back the prior change'));
		expect(r.audience).not.toBe('internal');
	});

	it('rewards a named product scope', () => {
		const plain = classify(commit('fix(forge): stop a stalled provider holding the request'));
		const named = classify(commit('fix(forge): stop a stalled provider holding the request'), {
			productScopes: ['forge'],
		});
		expect(named.signal).toBeGreaterThan(plain.signal);
	});

	it('explains every point it awarded', () => {
		const r = classify(commit('feat(forge): paint concept images across five providers'));
		expect(r.reasons.length).toBeGreaterThan(1);
		for (const reason of r.reasons) {
			expect(typeof reason.rule).toBe('string');
			expect(typeof reason.note).toBe('string');
			expect(Number.isFinite(reason.delta)).toBe(true);
		}
	});

	it('never returns a signal outside 0..1', () => {
		const messages = [
			'feat(core)!: a very long and explanatory description of a breaking product change',
			'style: x',
			'chore(deps): y',
		];
		for (const m of messages) {
			const { signal } = classify(commit(m), { productScopes: ['core'] });
			expect(signal).toBeGreaterThanOrEqual(0);
			expect(signal).toBeLessThanOrEqual(1);
		}
	});
});

describe('filterByAudience', () => {
	const commits = [
		commit('feat(wallet): let a user withdraw without a second signature'),
		commit('docs: explain the withdrawal flow for integrators'),
		commit('chore(deps): bump ws'),
	];

	it('keeps everything at the internal floor', () => {
		expect(filterByAudience(commits, 'internal')).toHaveLength(3);
	});

	it('drops machinery at the developer floor', () => {
		expect(filterByAudience(commits, 'developer')).toHaveLength(2);
	});

	it('keeps only product news at the holder floor', () => {
		expect(filterByAudience(commits, 'holder')).toHaveLength(1);
	});
});
