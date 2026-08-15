// Audit 09: the /play accessibility floor, measured in a real browser.
//
// The world itself needs WebGL, a Colyseus join and a pile of GLB downloads
// before its HUD exists, which makes "open /play and look" a 2-minute,
// flaky-in-headless proposition. But the chrome under audit here is plain DOM:
// `CommunityUI` builds the entire lobby + in-world HUD in its constructor, and
// `EconPanel` builds the store/bank/jobs shell in its own, neither of which
// touches the renderer. So this mounts those modules directly against the real
// stylesheet and measures what a keyboard or low-vision player actually gets:
// computed contrast, visible focus rings, Escape/Tab behaviour, and axe.
//
// Anything that needs the live world (peer avatars, the 3D scene) is out of
// scope here and covered by the world's own specs.

import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Relative luminance + WCAG contrast, computed in the page against the styles
// the browser actually resolved (tokens, alpha compositing, inherited colour).
const CONTRAST_HELPERS = `
	window.__wcag = {
		parse(c) { const m = (c || '').match(/[\\d.]+/g); return m ? m.map(Number) : null; },
		lum([r, g, b]) {
			const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
			return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
		},
		over(fg, bg) { const a = fg[3] ?? 1; return [0, 1, 2].map((i) => fg[i] * a + bg[i] * (1 - a)); },
		ratio(a, b) { const [x, y] = [window.__wcag.lum(a), window.__wcag.lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); },
		// The floor under every HUD panel is the 3D scene, whose brightness we do
		// not control. Measure against the worst case a player can actually hit:
		// a white sky / snow biome / white plaza.
		effectiveBg(el, scene) {
			let acc = scene.slice();
			const chain = [];
			for (let n = el; n; n = n.parentElement) chain.push(n);
			for (const n of chain.reverse()) {
				const c = window.__wcag.parse(getComputedStyle(n).backgroundColor);
				if (!c || (c[3] ?? 1) === 0) continue;
				acc = window.__wcag.over(c, acc);
			}
			return acc;
		},
	};
`;

// Load /play, then drive the real UI object the page already built.
//
// `CommunityUI` is constructed during boot, well before the world connects, and
// the app parks it on `window.__CC__` (see the bottom of coincommunities.js).
// So the HUD under audit is the production one, populated through its own public
// setters, without waiting on WebGL, a Colyseus join, or any avatar download.
// A plain `/play` (no `?coin=`) stays in the lobby and never starts the scene.
async function mountHud(page) {
	await page.goto('/play', { waitUntil: 'commit' });
	await page.waitForFunction(() => window.__CC__?.ui?.hud, null, { timeout: 180_000 });
	await page.evaluate(CONTRAST_HELPERS);
	await page.evaluate(() => {
		const ui = window.__CC__.ui;
		window.__ui = ui;
		// Boot loader and the cold-open intro both overlay the HUD; this audit is
		// about the in-world chrome, so clear them and switch the UI to its world
		// view through its own public entry point.
		document.getElementById('kx-loading')?.remove();
		document.querySelector('.pi-overlay, #cc-intro')?.remove();
		// The scene is still in its lobby phase and would flip the HUD back off
		// when the trending grid lands; pin it so the audit measures a stable HUD.
		window.__CC__.phase = 'world';
		ui.showLobby = () => {};
		ui.enterWorld({ name: 'three.ws', symbol: 'three', mint: 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump' });
		ui.setOnline(42);
		ui.setStatus('online');
		ui.setEmotes([
			{ name: 'wave', label: 'Wave', icon: '👋' },
			{ name: 'dance', label: 'Dance', icon: '💃' },
		]);
		ui.setReactions?.([{ emoji: '🎉', label: 'Celebrate' }, { emoji: '🔥', label: 'Fire' }]);
		ui.toggleChat(false);
		ui.addChat({ name: 'holder', text: 'gm from the plaza', mine: false });
		ui.addChat({ name: 'you', text: 'gm', mine: true });
	});
	await page.waitForFunction(() => {
		const h = document.getElementById('cc-hud');
		return h && !h.hidden && h.getBoundingClientRect().height > 0;
	}, null, { timeout: 30_000 });
}

// Budget for the polls that wait on /play's own state to settle. See the note at
// the focus poll below: the 5s default measures the machine, not the product.
const PANEL_WAIT = { timeout: 60_000 };

test.describe('/play accessibility floor', () => {
	test('every HUD text pair clears WCAG AA over the worst-case scene', async ({ page }) => {
		await mountHud(page);
		const rows = await page.evaluate(() => {
			const W = window.__wcag;
			const WHITE_SCENE = [255, 255, 255]; // noon sky / snow / white plaza
			// Emoji glyphs render in their own native full colour regardless of the
			// CSS `color` value (the same reason axe-core's colour-contrast rule
			// exempts them), so measuring "text colour vs background" for a cell
			// that is only emoji is a false signal, not a real legibility problem.
			const EMOJI_ONLY = /^[\p{Extended_Pictographic}\p{Emoji_Presentation}\s‍️]+$/u;
			const out = [];
			for (const el of document.querySelectorAll('#cc-hud *')) {
				if (el.children.length || !el.textContent.trim()) continue;
				if (EMOJI_ONLY.test(el.textContent.trim())) continue;
				const r = el.getBoundingClientRect();
				if (!r.width || !r.height) continue;
				const s = getComputedStyle(el);
				if (s.visibility === 'hidden' || s.display === 'none') continue;
				const fg = W.parse(s.color);
				if (!fg) continue;
				// Composite from the element itself, not just its ancestors: a leaf
				// control that paints its own opaque background (e.g. the white
				// .cc-chat-send button) is what visually sits behind its own text,
				// and starting one level up skipped that background entirely,
				// reading the HUD panel's dark background behind it instead.
				const bg = W.effectiveBg(el, WHITE_SCENE);
				const size = parseFloat(s.fontSize);
				const large = size >= 24 || (size >= 18.66 && parseInt(s.fontWeight, 10) >= 700);
				out.push({
					sel: (typeof el.className === 'string' && el.className) || el.tagName,
					text: el.textContent.trim().slice(0, 28),
					fg: s.color, bg: `rgb(${bg.map(Math.round).join(',')})`, size, large,
					ratio: +W.ratio(W.over(fg, bg), bg).toFixed(2),
					need: large ? 3 : 4.5,
				});
			}
			return out.sort((a, b) => a.ratio - b.ratio);
		});

		expect(rows.length, 'HUD rendered no measurable text').toBeGreaterThan(8);
		const failing = rows.filter((r) => r.ratio < r.need);
		expect(
			failing,
			`below AA:\n${failing.map((f) => `  ${f.sel} "${f.text}" ${f.ratio}:1 (need ${f.need}) fg=${f.fg} bg=${f.bg}`).join('\n')}`,
		).toEqual([]);
	});

	test('every interactive HUD control has a visible keyboard focus indicator', async ({ page }) => {
		await mountHud(page);
		const bad = await page.evaluate(() => {
			const W = window.__wcag;
			const controls = [...document.querySelectorAll('#cc-hud a[href],#cc-hud button,#cc-hud input,#cc-hud [tabindex]:not([tabindex="-1"]),#cc-hud [role="button"]')]
				.filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
			const snap = (el) => { const s = getComputedStyle(el); return `${s.outlineStyle}|${s.outlineWidth}|${s.outlineColor}|${s.boxShadow}|${s.borderColor}`; };
			const out = [];
			for (const el of controls) {
				const before = snap(el);
				// :focus-visible only matches a keyboard-ish focus; the harness fakes
				// that by focusing after a key event, which is how the browser decides.
				el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
				el.focus();
				const after = snap(el);
				if (before === after) out.push((typeof el.className === 'string' && el.className) || el.tagName);
				el.blur();
			}
			return out;
		});
		expect(bad, `no focus indicator changes on: ${bad.join(', ')}`).toEqual([]);
	});

	test('Tab reaches every HUD control, and the world canvas is a keyboard stop', async ({ page }) => {
		await mountHud(page);
		// The canvas is the world's own tab stop, with a label describing how to
		// drive it. This is the entry point a screen-reader user lands on.
		const canvas = page.locator('#kx-canvas');
		await expect(canvas).toHaveAttribute('role', 'application');
		await expect(canvas).toHaveAttribute('tabindex', '0');
		expect(await canvas.getAttribute('aria-label')).toMatch(/W A S D/);

		const names = await page.evaluate(() => {
			const acc = (el) => (el.getAttribute('aria-label') || el.textContent.trim() || el.getAttribute('title') || el.getAttribute('placeholder') || '').trim();
			return [...document.querySelectorAll('#cc-hud button,#cc-hud [role="button"],#cc-hud input')]
				.filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
				.map((el) => ({ cls: (typeof el.className === 'string' && el.className) || el.tagName, name: acc(el) }));
		});
		expect(names.length).toBeGreaterThan(8);
		const unnamed = names.filter((n) => !n.name);
		expect(unnamed, `controls with no accessible name: ${unnamed.map((u) => u.cls).join(', ')}`).toEqual([]);
	});

	test('chat announces incoming messages and is a labelled region', async ({ page }) => {
		await mountHud(page);
		const log = page.locator('.cc-chat-log');
		await expect(log).toHaveAttribute('role', 'log');
		await expect(log).toHaveAttribute('aria-live', 'polite');
		await expect(page.locator('#cc-chat')).toHaveAttribute('role', 'region');
		// Collapsed chat is display:none, so a hidden live region would never be
		// spoken; the standalone announcer covers that case.
		await page.evaluate(() => { window.__ui.toggleChat(true); window.__ui.addChat({ name: 'peer', text: 'still here?', mine: false }); });
		await expect(page.locator('.cc-sr-live[aria-live="polite"]')).toContainText('still here?');
	});

	test('the store panel traps focus, announces itself, and Escape closes it', async ({ page }) => {
		await mountHud(page);
		await page.evaluate(async () => {
			const { EconPanel } = await import('/src/game/economy-ui.js');
			window.__closed = false;
			window.__panel = new EconPanel({ title: 'General Store', onClose: () => { window.__closed = true; } });
		});
		const card = page.locator('.ec-card');
		await expect(card).toHaveAttribute('role', 'dialog');
		await expect(card).toHaveAttribute('aria-modal', 'true');
		// Focus moved into the dialog rather than being left behind it. The poll
		// carries its own budget because expect.poll's 5s default is a stopwatch on
		// /play, not an assertion about the panel: this page boots a WebGL scene and
		// its focus transitions settle well past 5s when the full suite is competing
		// for the box. The failure artifact showed the Close button holding focus by
		// the time the snapshot was taken, i.e. the right end state arriving late.
		await expect
			.poll(() => page.evaluate(() => document.querySelector('.ec-card')?.contains(document.activeElement)), PANEL_WAIT)
			.toBe(true);
		// The title reaches a screen reader even though the card renders empty.
		await expect(page.locator('.cc-sr-live[aria-live="polite"]')).toContainText('General Store');

		// Tab cannot escape the card.
		for (let i = 0; i < 6; i++) await page.keyboard.press('Tab');
		expect(await page.evaluate(() => document.querySelector('.ec-card')?.contains(document.activeElement))).toBe(true);

		await page.keyboard.press('Escape');
		await expect.poll(() => page.evaluate(() => window.__closed), PANEL_WAIT).toBe(true);
	});

	test('reduced motion stops the decorative animation on the HUD', async ({ page }) => {
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await mountHud(page);
		const animated = await page.evaluate(() =>
			[...document.querySelectorAll('#cc-hud *')]
				.filter((el) => {
					const s = getComputedStyle(el);
					if (s.animationName === 'none') return false;
					// Anything still running has to be effectively instant.
					return parseFloat(s.animationDuration) > 0.05;
				})
				.map((el) => `${el.className}:${getComputedStyle(el).animationName}`));
		expect(animated, `still animating under prefers-reduced-motion: ${animated.join(', ')}`).toEqual([]);
	});

	test('the HUD stays usable and unclipped at 200% text scaling', async ({ page }) => {
		// 200% browser zoom on a 1280x720 window is a 640x360 CSS viewport.
		await page.setViewportSize({ width: 640, height: 360 });
		await mountHud(page);
		const problems = await page.evaluate(() => {
			const out = [];
			const doc = document.documentElement;
			if (doc.scrollWidth > doc.clientWidth + 1) out.push(`page scrolls horizontally (${doc.scrollWidth} > ${doc.clientWidth})`);
			for (const el of document.querySelectorAll('#cc-hud button, #cc-hud .cc-coin-name, #cc-hud .cc-chat-msg')) {
				const r = el.getBoundingClientRect();
				if (!r.width || !r.height) continue;
				if (r.right > innerWidth + 1 || r.left < -1) out.push(`${el.className} escapes the viewport`);
				// A label clipped by its own box is the classic zoom failure.
				if (el.scrollWidth > el.clientWidth + 2 && getComputedStyle(el).overflow === 'hidden' && getComputedStyle(el).textOverflow !== 'ellipsis') {
					out.push(`${el.className} clips its label`);
				}
			}
			return out;
		});
		expect(problems, problems.join('\n')).toEqual([]);
	});

	test('axe finds no WCAG A/AA violations in the mounted HUD', async ({ page }) => {
		await mountHud(page);
		const results = await new AxeBuilder({ page })
			.include('#cc-hud')
			.withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
			.analyze();
		const summary = results.violations
			.map((v) => `[${v.impact}] ${v.id}: ${v.help}\n  ${v.nodes.map((n) => n.target.join(' ')).join('\n  ')}`)
			.join('\n\n');
		expect(results.violations, summary).toEqual([]);
	});
});
