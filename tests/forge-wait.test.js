// @vitest-environment jsdom
//
// The "while it forges" tips turn dead wait time into prompt-craft coaching. The
// grammar must stay well-formed, and the client must start rotating only while
// the generating panel is visible, stop when it hides, and never fight the real
// progress UI. Motion-safe behaviour (no timer) is pinned too.

import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';
import { FORGE_TIPS, tipOrder } from '../src/shared/forge-tips.js';

describe('forge tips content', () => {
	it('every tip has non-empty text and an optional string example', () => {
		expect(FORGE_TIPS.length).toBeGreaterThanOrEqual(6);
		for (const t of FORGE_TIPS) {
			expect(typeof t.tip).toBe('string');
			expect(t.tip.trim().length).toBeGreaterThan(10);
			expect(t.example === null || typeof t.example === 'string').toBe(true);
		}
	});

	it('tipOrder is a permutation of all indices and deterministic under a seed', () => {
		const rng = () => 0.42;
		const a = tipOrder(rng);
		const b = tipOrder(() => 0.42);
		expect(a).toEqual(b);
		expect([...a].sort((x, y) => x - y)).toEqual(FORGE_TIPS.map((_, i) => i));
	});
});

describe('forge-wait client', () => {
	async function mountFreshModule() {
		vi.resetModules();
		return import('../src/forge-wait.js');
	}

	function buildDom({ hidden = true } = {}) {
		document.head.innerHTML = '';
		document.body.innerHTML = `
			<div class="panel gen ${hidden ? 'is-hidden' : ''}" id="state-generating">
				<div class="gen-preview"></div>
				<div class="gen-steps">
					<div class="gen-meta">Elapsed 0s</div>
					<p class="gen-leave-hint">Feel free to leave this page.</p>
					<button id="cancel">Cancel</button>
				</div>
			</div>`;
	}

	beforeEach(() => {
		vi.useFakeTimers();
		// Default: motion allowed.
		window.matchMedia = vi.fn().mockReturnValue({ matches: false });
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('injects the tips card into the steps column, above the leave hint', async () => {
		buildDom({ hidden: true });
		await mountFreshModule();
		const card = document.querySelector('#state-generating .gen-steps .forge-wait');
		expect(card).toBeTruthy();
		// Sits immediately before the leave-hint.
		expect(card.nextElementSibling.classList.contains('gen-leave-hint')).toBe(true);
		expect(card.querySelector('.forge-wait-eyebrow').textContent).toContain('while it forges');
		// A tip is painted even before the panel opens.
		expect(card.querySelector('.forge-wait-tip').textContent.length).toBeGreaterThan(0);
	});

	it('rotates tips only while the panel is visible', async () => {
		buildDom({ hidden: true });
		await mountFreshModule();
		const panel = document.getElementById('state-generating');
		const tipEl = document.querySelector('.forge-wait-tip');

		// Reveal the panel — rotation should begin.
		panel.classList.remove('is-hidden');
		await Promise.resolve(); // let the MutationObserver microtask flush
		const first = tipEl.textContent;

		// Advance one interval + the crossfade swap delay.
		vi.advanceTimersByTime(7000);
		vi.advanceTimersByTime(320);
		const second = tipEl.textContent;
		expect(second).not.toBe(first);

		// Hide the panel — rotation must stop (content frozen).
		panel.classList.add('is-hidden');
		await Promise.resolve();
		const frozen = tipEl.textContent;
		vi.advanceTimersByTime(7000 * 3);
		expect(tipEl.textContent).toBe(frozen);
	});

	it('shows a tip but starts no timer under reduced motion', async () => {
		window.matchMedia = vi.fn().mockReturnValue({ matches: true });
		buildDom({ hidden: false }); // already generating
		await mountFreshModule();
		const tipEl = document.querySelector('.forge-wait-tip');
		const first = tipEl.textContent;
		expect(first.length).toBeGreaterThan(0);
		// No auto-rotation: advancing time changes nothing.
		vi.advanceTimersByTime(7000 * 5 + 320);
		expect(tipEl.textContent).toBe(first);
	});

	it('renders the example line only when a tip has one', async () => {
		buildDom({ hidden: false });
		await mountFreshModule();
		const ex = document.querySelector('.forge-wait-example');
		const tip = FORGE_TIPS.find((t) => t.example);
		// Force a known tip with an example onto the card via a fresh paint cycle:
		// the first painted tip is order[0]; assert the example element is coherent.
		if (!ex.hidden) {
			expect(ex.textContent).toContain('Try:');
		} else {
			expect(ex.textContent).toBe('');
		}
		// At least one tip in the deck carries an example.
		expect(tip).toBeTruthy();
	});
});
