// Tests for api/_mcp-studio/safety.js, the content gate that every free 3D
// Studio generation path runs BEFORE any provider work (api/_mcp-studio/tools.js
// calls it on forge_free, text_to_avatar, mesh_forge, forge_avatar and
// refine_model; api/3d/studio.js calls it on the REST lane).
//
// The gate is a synchronous whole-word keyword classifier, so its two failure
// modes are the ones worth pinning:
//   1. FALSE NEGATIVE: a harmful prompt slips through to a provider.
//   2. FALSE POSITIVE: an ordinary modeling prompt is refused, and in the csam
//      category is refused with an accusation. The whole-word matching exists
//      precisely to stop substring collisions ("assassin" is not "ass").

import { describe, it, expect } from 'vitest';
import { checkPromptSafety } from '../../api/_mcp-studio/safety.js';

describe('checkPromptSafety allow path', () => {
	it('lets ordinary creative modeling prompts through', () => {
		const prompts = [
			'a cute robot with round eyes',
			'a low-poly mountain landscape',
			'a knight with a sword and shield',
			'a wizard holding a glowing wand',
			'a vintage racing car',
			'a ceramic teapot on a wooden table',
		];
		for (const p of prompts) {
			expect(checkPromptSafety(p), p).toEqual({ allowed: true });
		}
	});

	it('treats empty, blank, and missing prompts as allowed (validation is the caller job)', () => {
		expect(checkPromptSafety('')).toEqual({ allowed: true });
		expect(checkPromptSafety('   ')).toEqual({ allowed: true });
		expect(checkPromptSafety(null)).toEqual({ allowed: true });
		expect(checkPromptSafety(undefined)).toEqual({ allowed: true });
	});
});

describe('checkPromptSafety refusal path', () => {
	it('refuses each harmful category with its own message and the matched term', () => {
		const cases = [
			{ prompt: 'a nude woman statue', category: 'sexual' },
			{ prompt: 'a decapitated head with gore', category: 'gore' },
			{ prompt: 'a nazi swastika flag', category: 'hate' },
			{ prompt: 'an ar-15 rifle model', category: 'weapon_drug' },
			{ prompt: 'a loli character', category: 'csam' },
		];
		for (const { prompt, category } of cases) {
			const r = checkPromptSafety(prompt);
			expect(r.allowed, prompt).toBe(false);
			expect(r.category, prompt).toBe(category);
			expect(typeof r.message, prompt).toBe('string');
			expect(r.message.length, prompt).toBeGreaterThan(0);
			expect(typeof r.matched, prompt).toBe('string');
		}
	});

	it('checks csam first, so the highest-harm category wins a multi-category prompt', () => {
		expect(checkPromptSafety('underage nude').category).toBe('csam');
	});

	it('matches case-insensitively and through surrounding punctuation', () => {
		expect(checkPromptSafety('PORN').allowed).toBe(false);
		expect(checkPromptSafety('a model, nsfw, please').allowed).toBe(false);
	});
});

describe('checkPromptSafety whole-word matching', () => {
	// The header comment of safety.js promises "assassin" does not trip "ass"
	// and that "scunthorpe" is safe. These are the prompts that regress if
	// someone swaps the boundary regex for a plain substring includes().
	it('does not fire on benign words that merely contain a blocked term', () => {
		const prompts = [
			'an assassin with a hooded cloak',
			'a scunthorpe town hall',
			'a cumulus cloud',
			'a bass guitar',
			'a shiitake mushroom',
			'a cocktail glass',
			'a titmouse bird',
			'a grenadier guard in uniform',
			'a wooden bureau',
		];
		for (const p of prompts) {
			expect(checkPromptSafety(p), p).toEqual({ allowed: true });
		}
	});

	// Regression: the bare abbreviation "cp" used to sit in CSAM_TERMS, so an
	// ordinary retro-computing prompt was refused as child sexual content, the
	// single worst false positive this classifier can produce.
	it('does not accuse ordinary "cp" prompts of child sexual content', () => {
		expect(checkPromptSafety('a CP/M retro computer terminal')).toEqual({ allowed: true });
		expect(checkPromptSafety('a CP violation physics diagram')).toEqual({ allowed: true });
	});

	it('still refuses the spelled-out child-sexual terms', () => {
		for (const p of ['child porn', 'childporn art', 'a child sexual image', 'csam', 'jailbait']) {
			expect(checkPromptSafety(p).category, p).toBe('csam');
		}
	});
});
