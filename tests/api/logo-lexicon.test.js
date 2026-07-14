// Tests for the brand-mark lexicon (mcp-server/src/tools/_logo-lexicon.js) :
// the deterministic resolver that turns "pumpfun logo"-class prompts into a
// concrete geometric description of the real mark before any generation lane
// runs. Without it, text→image→3D reconstructs niche brand marks as a generic
// badge covered in garbled lettering (no LLM in the chain knows the mark).
//
// Pins three contracts:
//   1. Matching: brand + mark word (or a bare unambiguous brand name) resolves;
//      anything carrying extra subject intent falls through to the director.
//   2. Spec hygiene: no emitted spec ever contains the brand name (the image
//      model letters any name it sees onto the mesh as noise) and every spec
//      ends in the director's composition constraints.
//   3. Directive export: the shared BRAND_MARK_DIRECTIVE both director copies
//      embed is a non-empty instruction that forbids invented lettering.

import { describe, it, expect } from 'vitest';
import {
	resolveLogoPrompt,
	BRAND_MARK_DIRECTIVE,
} from '../../mcp-server/src/tools/_logo-lexicon.js';

describe('resolveLogoPrompt: matching', () => {
	it('resolves the reported case: "pumpfun logo"', () => {
		const hit = resolveLogoPrompt('pumpfun logo');
		expect(hit).not.toBeNull();
		expect(hit.brand).toBe('pump.fun');
		expect(hit.prompt).toMatch(/capsule/i);
		expect(hit.prompt).toMatch(/green/i);
	});

	it('resolves punctuation and spacing variants of the brand', () => {
		for (const p of ['pump.fun logo', 'pump fun logo', 'PUMP-FUN LOGO', 'the pump.fun icon', '$pump logo']) {
			expect(resolveLogoPrompt(p)?.brand).toBe('pump.fun');
		}
	});

	it('resolves a bare unambiguous brand name with filler around it', () => {
		expect(resolveLogoPrompt('pumpfun')?.brand).toBe('pump.fun');
		expect(resolveLogoPrompt('make a 3d model of the pumpfun logo')?.brand).toBe('pump.fun');
		expect(resolveLogoPrompt('bitcoin')?.brand).toBe('bitcoin');
	});

	it('resolves ticker aliases only alongside an explicit mark word', () => {
		expect(resolveLogoPrompt('btc logo')?.brand).toBe('bitcoin');
		expect(resolveLogoPrompt('eth icon')?.brand).toBe('ethereum');
		expect(resolveLogoPrompt('sol emblem')?.brand).toBe('solana');
		// Bare short tickers are too ambiguous to hijack.
		expect(resolveLogoPrompt('btc')).toBeNull();
		expect(resolveLogoPrompt('sol')).toBeNull();
		expect(resolveLogoPrompt('eth')).toBeNull();
	});

	it('falls through when the prompt carries extra subject intent', () => {
		expect(resolveLogoPrompt('pumpfun logo on a spaceship')).toBeNull();
		expect(resolveLogoPrompt('astronaut holding the bitcoin logo')).toBeNull();
		expect(resolveLogoPrompt('solana logo tattoo on an arm')).toBeNull();
	});

	it('ignores prompts with no known brand', () => {
		expect(resolveLogoPrompt('a pill')).toBeNull();
		expect(resolveLogoPrompt('logo')).toBeNull();
		expect(resolveLogoPrompt('my company logo')).toBeNull();
		expect(resolveLogoPrompt('')).toBeNull();
		expect(resolveLogoPrompt(null)).toBeNull();
	});
});

describe('resolveLogoPrompt: spec hygiene', () => {
	const KNOWN = ['pumpfun logo', 'bitcoin logo', 'ethereum logo', 'solana logo', 'dogecoin logo'];

	it('never emits the brand name inside a spec (letterforms reconstruct as noise)', () => {
		for (const p of KNOWN) {
			const hit = resolveLogoPrompt(p);
			expect(hit).not.toBeNull();
			const name = p.split(' ')[0];
			expect(hit.prompt.toLowerCase()).not.toContain(name);
		}
	});

	it('every spec carries the director composition constraints', () => {
		for (const p of KNOWN) {
			const { prompt } = resolveLogoPrompt(p);
			expect(prompt).toMatch(/plain neutral background/);
			expect(prompt).toMatch(/no text or watermark/);
			expect(prompt).toMatch(/no second subject/);
		}
	});
});

describe('resolveLogoPrompt: reference views', () => {
	it('pump.fun carries a reference view that exists under public/', async () => {
		const hit = resolveLogoPrompt('pumpfun logo');
		expect(hit.imagePath).toBe('/marks/pump-fun.png');
		const { existsSync } = await import('node:fs');
		const { fileURLToPath } = await import('node:url');
		const path = await import('node:path');
		const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
		expect(existsSync(path.join(root, 'public', hit.imagePath))).toBe(true);
	});

	it('marks without a reference view return imagePath null', () => {
		expect(resolveLogoPrompt('bitcoin logo').imagePath).toBeNull();
	});
});

describe('BRAND_MARK_DIRECTIVE', () => {
	it('is embedded in both mesh director copies and forbids invented lettering', async () => {
		expect(BRAND_MARK_DIRECTIVE).toMatch(/never invent lettering/i);
		const { MESH_DIRECTOR } = await import('../../api/_lib/forge-director-prompts.js');
		expect(MESH_DIRECTOR).toContain(BRAND_MARK_DIRECTIVE.trim());
	});
});
