// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import {
	ensureGuestAgent,
	peekGuestAgent,
	updateGuestAgent,
	clearGuestAgent,
} from '../src/agents/guest-agent.js';
import { ADJECTIVES, NOUNS } from '../src/shared/agent-names.js';

const KEY = '3dagent:guest-agent';
const WALK_AVATAR_KEY = 'walk:companion:avatar';

describe('guest-agent draft store', () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it('mints a named draft on first ensure and is idempotent after', () => {
		const first = ensureGuestAgent();
		expect(first.id).toMatch(/^[0-9a-f]{16}$/);
		const [adj, noun] = first.name.split(' ');
		expect(ADJECTIVES).toContain(adj);
		expect(NOUNS).toContain(noun);
		expect(first.avatarId).toBeTruthy();
		expect(first.createdAt).toBeGreaterThan(0);

		const second = ensureGuestAgent();
		expect(second).toEqual(first);
	});

	it('seeds the companion avatar key without clobbering an existing choice', () => {
		localStorage.setItem(WALK_AVATAR_KEY, 'my-custom-avatar');
		ensureGuestAgent();
		expect(localStorage.getItem(WALK_AVATAR_KEY)).toBe('my-custom-avatar');

		localStorage.clear();
		const rec = ensureGuestAgent();
		expect(localStorage.getItem(WALK_AVATAR_KEY)).toBe(rec.avatarId);
	});

	it('peek returns null before minting and the record after', () => {
		expect(peekGuestAgent()).toBeNull();
		const rec = ensureGuestAgent();
		expect(peekGuestAgent()).toEqual(rec);
	});

	it('update merges a patch; clear drops the draft', () => {
		ensureGuestAgent();
		const renamed = updateGuestAgent({ name: 'Chrome Koi' });
		expect(renamed.name).toBe('Chrome Koi');
		expect(peekGuestAgent().name).toBe('Chrome Koi');

		clearGuestAgent();
		expect(peekGuestAgent()).toBeNull();
		expect(localStorage.getItem(KEY)).toBeNull();
	});

	it('rejects a corrupted record instead of returning garbage', () => {
		localStorage.setItem(KEY, '{not json');
		expect(peekGuestAgent()).toBeNull();
		localStorage.setItem(KEY, JSON.stringify({ id: 'x' })); // missing name
		expect(peekGuestAgent()).toBeNull();
	});
});
