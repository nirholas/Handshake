// @vitest-environment jsdom
//
// Build HUD controller — the DOM-facing half of /play's building. Verifies the
// budget meter, durability badge, mode toggle, and enable/disable behaviour the
// scene drives, so regressions in the player-facing build chrome get caught
// without standing up a browser.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

globalThis.self = globalThis;

import { createBuildHud, BLOCK_TYPES, MAX_BLOCKS } from '../src/game/build-voxels.js';

let hud;
afterEach(() => { hud?.dispose(); hud = null; document.body.innerHTML = ''; });

function mount(handlers = {}) {
	hud = createBuildHud(handlers);
	return hud;
}

describe('build HUD', () => {
	it('mounts with the full palette and a place/break default', () => {
		mount();
		expect(document.querySelectorAll('.cc-build-slot').length).toBe(BLOCK_TYPES.length);
		expect(hud.mode).toBe('place');
		expect(hud.active).toBe(false);
		// First slot is selected by default.
		expect(document.querySelector('.cc-build-slot.cc-on')).toBeTruthy();
	});

	it('budget meter scales the fill and escalates warn → full', () => {
		mount();
		const fill = document.querySelector('.cc-build-budget-fill');
		const meter = document.querySelector('.cc-build-budget');

		hud.setBudget(0);
		expect(fill.style.transform).toBe('scaleX(0)');
		expect(meter.classList.contains('cc-warn')).toBe(false);

		hud.setBudget(Math.round(MAX_BLOCKS * 0.5));
		expect(fill.style.transform).toBe('scaleX(0.5)');
		expect(meter.classList.contains('cc-warn')).toBe(false);

		hud.setBudget(Math.round(MAX_BLOCKS * 0.9)); // ≥80% → warn
		expect(meter.classList.contains('cc-warn')).toBe(true);
		expect(meter.classList.contains('cc-full')).toBe(false);

		hud.setBudget(MAX_BLOCKS); // full → red, root flagged, warn cleared
		expect(meter.classList.contains('cc-full')).toBe(true);
		expect(meter.classList.contains('cc-warn')).toBe(false);
		expect(hud.root.classList.contains('cc-build-full')).toBe(true);

		// Clamps an over-cap value rather than overflowing the bar.
		hud.setBudget(MAX_BLOCKS + 500);
		expect(fill.style.transform).toBe('scaleX(1)');
	});

	it('durability badge tells the truth and hides for solo', () => {
		mount();
		const badge = document.querySelector('.cc-build-durability');

		hud.setPersistent(true);
		expect(badge.hidden).toBe(false);
		expect(badge.classList.contains('cc-durable')).toBe(true);
		expect(badge.textContent).toMatch(/saved/i);

		hud.setPersistent(false);
		expect(badge.hidden).toBe(false);
		expect(badge.classList.contains('cc-durable')).toBe(false);
		expect(badge.textContent).toMatch(/session/i);

		hud.setPersistent(null); // solo single-player → no promise either way
		expect(badge.hidden).toBe(true);
	});

	it('mode toggle and selection fire their callbacks', () => {
		const modes = [];
		const picks = [];
		mount({ onModeChange: (m) => modes.push(m), onPick: (i) => picks.push(i) });

		hud.setMode('remove');
		expect(hud.mode).toBe('remove');
		expect(modes).toContain('remove');
		expect(document.querySelector('.cc-build-mode').classList.contains('cc-removing')).toBe(true);

		hud.select(4);
		expect(picks).toContain(4);
		expect(document.querySelectorAll('.cc-build-slot')[4].classList.contains('cc-on')).toBe(true);
	});

	it('setEnabled disables the toggle and collapses an open panel', () => {
		const toggles = [];
		mount({ onToggle: (v) => toggles.push(v) });
		const toggleBtn = document.querySelector('.cc-build-toggle');

		hud.setActive(true);
		expect(hud.active).toBe(true);
		hud.setEnabled(false, 'Connecting…');
		expect(toggleBtn.disabled).toBe(true);
		expect(toggleBtn.title).toBe('Connecting…');
		expect(hud.active).toBe(false); // disabling closed the active panel
		expect(toggles).toContain(false);
	});
});
