// Tests for the pure create-agent draft helpers — the "is there anything worth
// saving?" and "is this draft still fresh?" logic behind guest draft autosave.

import { describe, it, expect } from 'vitest';
import { DRAFT_TTL_MS, draftHasContent, isDraftFresh } from '../src/create-agent-draft.js';

// Minimal state matching the wizard's shape at its untouched default.
function emptyState() {
	return {
		name: '',
		description: '',
		tags: [],
		greeting: '',
		persona: '',
		category: '',
		model: { mode: 'starter', starterId: '' },
	};
}

describe('draftHasContent', () => {
	it('is false for an untouched wizard (no empty-draft autosave)', () => {
		expect(draftHasContent(emptyState())).toBe(false);
	});

	it('is false for whitespace-only text fields', () => {
		const s = emptyState();
		s.name = '   ';
		s.persona = '\n\t ';
		expect(draftHasContent(s)).toBe(false);
	});

	it('is true once any real field is set', () => {
		for (const mut of [
			(s) => (s.name = 'Nova'),
			(s) => (s.description = 'a guide'),
			(s) => (s.tags = ['alpha']),
			(s) => (s.greeting = 'hi'),
			(s) => (s.persona = 'You are Nova.'),
			(s) => (s.category = 'education'),
		]) {
			const s = emptyState();
			mut(s);
			expect(draftHasContent(s)).toBe(true);
		}
	});

	it('is true when the model is no longer the untouched default', () => {
		const picked = emptyState();
		picked.model = { mode: 'starter', starterId: 'cz' };
		expect(draftHasContent(picked)).toBe(true);

		const uploaded = emptyState();
		uploaded.model = { mode: 'upload', starterId: '' };
		expect(draftHasContent(uploaded)).toBe(true);
	});

	it('handles a missing/garbage state without throwing', () => {
		expect(draftHasContent(null)).toBe(false);
		expect(draftHasContent(undefined)).toBe(false);
		expect(draftHasContent({})).toBe(false);
	});
});

describe('isDraftFresh', () => {
	const now = 1_000_000_000_000;

	it('treats a just-saved draft as fresh', () => {
		expect(isDraftFresh({ savedAt: now }, now)).toBe(true);
		expect(isDraftFresh({ savedAt: now - 60_000 }, now)).toBe(true);
	});

	it('treats a draft exactly at the TTL boundary as fresh', () => {
		expect(isDraftFresh({ savedAt: now - DRAFT_TTL_MS }, now)).toBe(true);
	});

	it('treats a draft past the TTL as stale', () => {
		expect(isDraftFresh({ savedAt: now - DRAFT_TTL_MS - 1 }, now)).toBe(false);
	});

	it('treats a legacy draft with no timestamp as fresh (never drops old data blindly)', () => {
		expect(isDraftFresh({ name: 'Nova' }, now)).toBe(true);
		expect(isDraftFresh(null, now)).toBe(true);
	});

	it('DRAFT_TTL_MS is 7 days', () => {
		expect(DRAFT_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
	});
});
