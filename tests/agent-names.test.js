import { describe, it, expect } from 'vitest';
import { randomAgentName, ADJECTIVES, NOUNS } from '../src/shared/agent-names.js';

describe('agent-names', () => {
	it('produces "Adjective Noun" from the wordlists', () => {
		const name = randomAgentName();
		const [adj, noun] = name.split(' ');
		expect(ADJECTIVES).toContain(adj);
		expect(NOUNS).toContain(noun);
	});

	it('is deterministic under an injected RNG', () => {
		expect(randomAgentName(() => 0)).toBe(`${ADJECTIVES[0]} ${NOUNS[0]}`);
		expect(randomAgentName(() => 0.999999)).toBe(
			`${ADJECTIVES[ADJECTIVES.length - 1]} ${NOUNS[NOUNS.length - 1]}`,
		);
	});

	it('never returns an out-of-range pick even when rand returns 1', () => {
		const name = randomAgentName(() => 1);
		expect(name).not.toContain('undefined');
	});
});
