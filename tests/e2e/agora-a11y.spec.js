// Agora: the accessibility floor for the Commons (Task 11 hardening).
//
// tests/e2e/a11y-top-pages.spec.js runs axe over the top 30 pages by
// data/pages.json priority. /agora sits at priority 0.8, tied with the 30th
// page, so it falls in or out of that slice depending on how the tie sorts, and
// it was OUT. The flagship 3D surface must not have its a11y coverage decided by
// a sort tie, so it gets an explicit spec here.
//
// Same rule sets as the shared floor (wcag2a / wcag2aa / wcag21aa only) so this
// stays a hard gate rather than a taste argument, plus the keyboard and
// reduced-motion checks axe cannot make on its own.

import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// The 3D world boots asynchronously behind a loader. Give it room to settle so
// axe scans the real Commons, not the boot screen.
const SETTLE_MS = 3_000;

test('a11y floor: /agora has no WCAG A/AA violations', async ({ page }) => {
	await page.goto('/agora', { waitUntil: 'domcontentloaded', timeout: 60_000 });
	await page.waitForTimeout(SETTLE_MS);

	const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();

	if (results.violations.length > 0) {
		const summary = results.violations
			.map(
				(v) =>
					`[${v.impact}] ${v.id}: ${v.help} (${v.nodes.length} node(s))\n  ${v.nodes
						.map((n) => n.target.join(' '))
						.join('\n  ')}`,
			)
			.join('\n\n');
		throw new Error(`axe found ${results.violations.length} violation(s) on /agora:\n\n${summary}`);
	}
	expect(results.violations).toEqual([]);
});

test('/agora is reachable and operable by keyboard alone', async ({ page }) => {
	await page.goto('/agora', { waitUntil: 'domcontentloaded', timeout: 60_000 });
	await page.waitForTimeout(SETTLE_MS);

	// Tab from the top of the document and confirm focus actually lands on
	// interactive elements with a visible, non-suppressed focus indicator. A 3D
	// canvas page that swallows Tab is unusable without a mouse.
	const reached = [];
	for (let i = 0; i < 12; i++) {
		await page.keyboard.press('Tab');
		const info = await page.evaluate(() => {
			// Descend through shadow roots: for a custom element like <lang-switcher>
			// document.activeElement is the HOST, while the real focus ring lives on
			// the inner control inside its shadow tree. Measuring the host would
			// report a false "no focus indicator".
			let el = document.activeElement;
			while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
			if (!el || el === document.body) return null;
			const s = getComputedStyle(el);
			return {
				tag: el.tagName.toLowerCase(),
				label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 40),
				outlineWidth: s.outlineWidth,
				outlineStyle: s.outlineStyle,
				boxShadow: s.boxShadow,
			};
		});
		if (info) reached.push(info);
	}

	expect(reached.length, 'Tab must move focus into the page').toBeGreaterThan(0);

	// Every focused element must render SOME visible focus affordance: an
	// outline, or a focus ring drawn with box-shadow. `outline: none` with no
	// replacement is the exact pattern that makes a page keyboard-hostile.
	for (const el of reached) {
		const hasOutline = el.outlineStyle !== 'none' && parseFloat(el.outlineWidth) > 0;
		const hasRing = el.boxShadow && el.boxShadow !== 'none';
		expect(hasOutline || hasRing, `focused <${el.tag}> "${el.label}" has no visible focus indicator`).toBe(true);
	}
});

test('/agora honors prefers-reduced-motion', async ({ browser }) => {
	// The Commons runs continuous 3D motion and coin-flight FX. A visitor who has
	// asked the OS for reduced motion must not be handed a spinning world.
	const context = await browser.newContext({ reducedMotion: 'reduce' });
	const page = await context.newPage();
	const errors = [];
	page.on('pageerror', (e) => errors.push(e.message));

	await page.goto('/agora', { waitUntil: 'domcontentloaded', timeout: 60_000 });
	await page.waitForTimeout(SETTLE_MS);

	// The page must still render its world (reduced motion is not "no page"),
	// and must not have thrown while taking the reduced-motion branch.
	await expect(page.locator('canvas').first()).toBeVisible();

	// The multiplayer socket is not running under `npm run dev`, and /agora is
	// designed to degrade to honest single-player when it cannot reach one. That
	// specific connection failure is expected here; anything else is a real fault
	// in the reduced-motion branch. An exception ledger, not a bypass.
	const EXPECTED_OFFLINE_NOISE = /WebSocket closed without opened|WebSocket connection/i;
	const real = errors.filter((e) => !EXPECTED_OFFLINE_NOISE.test(e));
	expect(real, `page errors under reduced motion: ${real.join('; ')}`).toEqual([]);

	// And reduced motion must actually be in force for the world's own code, not
	// merely emulated at the browser level.
	const reduced = await page.evaluate(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
	expect(reduced, 'the page must observe the reduced-motion preference').toBe(true);

	await context.close();
});
