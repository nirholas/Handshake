// @vitest-environment jsdom
//
// The ⌘K palette's command grammar (public/search.js). The file is a
// self-mounting classic-script IIFE, so we import it once in a jsdom document
// and exercise the parseCommand seam it exposes on window.__twsSearch.
import { describe, it, expect, beforeAll } from 'vitest';

let parseCommand;

beforeAll(async () => {
	await import('../public/search.js');
	parseCommand = window.__twsSearch.parseCommand;
	expect(typeof parseCommand).toBe('function');
});

describe('palette command grammar', () => {
	it('parses forge with every verb alias and preserves the prompt', () => {
		for (const verb of ['forge', 'make', 'generate', 'imagine']) {
			const m = parseCommand(`${verb} a bronze dragon statue`);
			expect(m?.def.id).toBe('forge');
			expect(m.args.prompt).toBe('a bronze dragon statue');
		}
	});

	it('parses digest triggers', () => {
		for (const q of ['digest', 'briefing', 'what happened today?', 'today']) {
			expect(parseCommand(q)?.def.id).toBe('digest');
		}
	});

	it('parses price with a verb or a $ticker', () => {
		expect(parseCommand('price btc')).toMatchObject({ args: { query: 'btc' } });
		expect(parseCommand('price btc').def.id).toBe('price');
		expect(parseCommand('$sol')).toMatchObject({ args: { query: 'sol' } });
	});

	it('parses ask with an explicit verb and offers it for natural questions', () => {
		expect(parseCommand('ask what is x402?')).toMatchObject({
			args: { question: 'what is x402?' },
		});
		expect(parseCommand('how do agents pay each other?')?.def.id).toBe('ask');
	});

	it('never hijacks a plain search query', () => {
		for (const q of ['marketplace', 'oracle', 'turbo otter', 'forge', 'make', 'price']) {
			// Bare verbs with no argument are searches, not commands.
			expect(parseCommand(q)).toBeNull();
		}
		expect(parseCommand('')).toBeNull();
	});
});
