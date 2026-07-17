// @vitest-environment jsdom
//
// "More like this" turns one result into a one-tap exploration of its material
// space. Two things must hold: the variation grammar keeps the same subject
// while never re-offering a material the prompt already names, and the decoupled
// client only shows for text-mode results and hands a real prompt back to
// forge.js via `forge:run-prompt`. Both are pinned here.

import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
	deriveVariations,
	composeVariation,
	VARIATION_FACETS,
} from '../src/shared/forge-variations.js';

// Deterministic rng: cycles through a fixed sequence so selections are stable.
function seededRng(seq) {
	let i = 0;
	return () => seq[i++ % seq.length];
}

describe('deriveVariations', () => {
	it('returns the requested count of distinct variations', () => {
		const v = deriveVariations('a glazed ceramic teapot', { count: 3, rng: seededRng([0.1, 0.4, 0.7, 0.2]) });
		expect(v).toHaveLength(3);
		expect(new Set(v.map((x) => x.key)).size).toBe(3);
		for (const x of v) {
			expect(x.prompt.startsWith('a glazed ceramic teapot,')).toBe(true);
			expect(typeof x.label).toBe('string');
			expect(x.swatch).toMatch(/^#[0-9a-f]{6}$/i);
		}
	});

	it('never re-offers a material the prompt already names', () => {
		// Try every facet's own keyword; that facet must be absent from results.
		for (const facet of VARIATION_FACETS) {
			const prompt = `a small ${facet.match[0]} figurine`;
			const keys = deriveVariations(prompt, { count: 8 }).map((x) => x.key);
			expect(keys).not.toContain(facet.key);
		}
	});

	it('is deterministic for a given seed', () => {
		const a = deriveVariations('a red fox', { count: 3, rng: seededRng([0.3, 0.6, 0.9, 0.1]) });
		const b = deriveVariations('a red fox', { count: 3, rng: seededRng([0.3, 0.6, 0.9, 0.1]) });
		expect(a.map((x) => x.key)).toEqual(b.map((x) => x.key));
	});

	it('returns nothing for an empty or whitespace prompt', () => {
		expect(deriveVariations('')).toEqual([]);
		expect(deriveVariations('   ')).toEqual([]);
		expect(deriveVariations(null)).toEqual([]);
	});

	it('never produces a variation longer than the forge 1000-char limit', () => {
		const nearLimit = 'a ' + 'x'.repeat(966); // 968 chars: some facets fit, some do not
		const v = deriveVariations(nearLimit, { count: 8 });
		expect(v.length).toBeGreaterThan(0);
		for (const x of v) expect(x.prompt.length).toBeLessThanOrEqual(1000);
	});

	it('returns nothing when the prompt is already at the character limit', () => {
		expect(deriveVariations('x'.repeat(1000))).toEqual([]);
	});
});

describe('composeVariation', () => {
	it('appends the facet phrase and strips a trailing separator', () => {
		const facet = VARIATION_FACETS.find((f) => f.key === 'brass');
		expect(composeVariation('a sci-fi helmet.', facet)).toBe('a sci-fi helmet, in brushed brass');
		expect(composeVariation('a sci-fi helmet, ', facet)).toBe('a sci-fi helmet, in brushed brass');
	});
});

describe('forge-more-like-this client', () => {
	// The module reads #state-result at import time, so build the DOM first, then
	// re-execute the module fresh for each test.
	async function mountFreshModule() {
		vi.resetModules();
		return import('../src/forge-more-like-this.js');
	}

	function buildDom({ textMode = true } = {}) {
		document.head.innerHTML = '';
		document.body.innerHTML = `
			<button id="tab-text" role="tab" aria-selected="${textMode ? 'true' : 'false'}"></button>
			<div id="state-result">
				<div class="result-bar"><span class="label"></span></div>
			</div>`;
	}

	beforeEach(() => {
		document.head.innerHTML = '';
		document.body.innerHTML = '';
	});

	it('renders three chips + a reshuffle when a text result lands', async () => {
		buildDom({ textMode: true });
		await mountFreshModule();
		document.dispatchEvent(
			new CustomEvent('forge:model-ready', { detail: { label: 'a glazed ceramic teapot' } }),
		);
		const row = document.querySelector('#state-result .mlt');
		expect(row).toBeTruthy();
		expect(row.hidden).toBe(false);
		expect(row.querySelectorAll('.mlt-chip')).toHaveLength(3);
		expect(row.querySelector('.mlt-reshuffle')).toBeTruthy();
		expect(row.querySelector('.mlt-label').textContent).toBe('More like this');
	});

	it('hands a real derived prompt back via forge:run-prompt on tap', async () => {
		buildDom({ textMode: true });
		await mountFreshModule();
		document.dispatchEvent(
			new CustomEvent('forge:model-ready', { detail: { label: 'a low-poly red fox' } }),
		);
		const spy = vi.fn();
		document.addEventListener('forge:run-prompt', (e) => spy(e.detail.prompt));
		const chip = document.querySelector('.mlt-chip');
		chip.click();
		expect(spy).toHaveBeenCalledTimes(1);
		const sent = spy.mock.calls[0][0];
		expect(sent.startsWith('a low-poly red fox,')).toBe(true);
		// The tapped chip's title carries the exact prompt it dispatches.
		expect(sent).toBe(chip.title);
	});

	it('reshuffle swaps in a new set of chips', async () => {
		buildDom({ textMode: true });
		await mountFreshModule();
		document.dispatchEvent(
			new CustomEvent('forge:model-ready', { detail: { label: 'a brass astrolabe' } }),
		);
		const before = [...document.querySelectorAll('.mlt-chip')].map((c) => c.title);
		// Reshuffle enough times that at least one draw differs from the first.
		let changed = false;
		for (let i = 0; i < 12 && !changed; i++) {
			document.querySelector('.mlt-reshuffle').click();
			const after = [...document.querySelectorAll('.mlt-chip')].map((c) => c.title);
			if (after.join('|') !== before.join('|')) changed = true;
		}
		expect(changed).toBe(true);
	});

	it('stays hidden for a non-text-mode result', async () => {
		buildDom({ textMode: false });
		await mountFreshModule();
		document.dispatchEvent(
			new CustomEvent('forge:model-ready', { detail: { label: 'uploaded-photo.png' } }),
		);
		const row = document.querySelector('#state-result .mlt');
		expect(row.hidden).toBe(true);
	});

	it('hides when a later result has no usable prompt', async () => {
		buildDom({ textMode: true });
		await mountFreshModule();
		document.dispatchEvent(
			new CustomEvent('forge:model-ready', { detail: { label: 'a glazed ceramic teapot' } }),
		);
		expect(document.querySelector('.mlt').hidden).toBe(false);
		document.dispatchEvent(new CustomEvent('forge:model-ready', { detail: { label: '' } }));
		expect(document.querySelector('.mlt').hidden).toBe(true);
	});
});
