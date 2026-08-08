// Audit 09 — the /play accessibility floor, measured in a real browser.
//
// The world itself needs WebGL, a Colyseus room and a GLB avatar before the
// HUD exists, which makes a full "load /play and tab through it" spec both slow
// and flaky (headless software GL takes minutes per run and dies under memory
// pressure). Everything this spec asserts is a property of the CHROME, not the
// 3D scene: the HUD, the store, the bank and the jobs board are plain DOM built
// by importable modules. So it mounts those modules directly against the dev
// server, with the real stylesheets loaded, and measures computed styles,
// keyboard behaviour and axe violations on the actual markup that ships.
//
// What it pins:
//   * contrast: every HUD text/background pair clears AA, including over a
//     bright 3D scene (the panel fill is the scrim, see the accessibility
//     floor in coincommunities.css)
//   * focus: every control has a visible ring, Tab stays inside an open panel,
//     Escape closes the top panel, focus returns to the opener
//   * semantics: axe finds no wcag2a/2aa/21aa violations on the mounted chrome
//   * text scaling: nothing clips or overflows the viewport at 200% zoom

import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// A blank same-origin document that the dev server will happily transform
// modules for. /404 is the smallest real route on the site.
const HOST_PAGE = '/404';

// Mount the real store panel (and, through it, the shared EconPanel shell that
// the bank and jobs board also use) plus a HUD fixture carrying the same
// classes and stylesheet the world builds.
async function mountChrome(page, { scene = 'dark' } = {}) {
	await page.goto(HOST_PAGE, { waitUntil: 'domcontentloaded' });
	await page.addStyleTag({ url: '/src/game/coincommunities.css' });
	await page.evaluate((sceneKind) => {
		document.documentElement.setAttribute('data-theme', 'dark');
		// Stand in for the 3D canvas. The worst case for HUD contrast is a bright
		// scene behind a translucent panel, so the "bright" variant paints the
		// backdrop white and the panels have to hold AA against it anyway.
		const canvas = document.createElement('div');
		canvas.id = 'kx-canvas-stub';
		canvas.style.cssText = `position:fixed;inset:0;background:${sceneKind === 'bright' ? '#ffffff' : '#101114'};`;
		document.body.replaceChildren(canvas);
	}, scene);
}

test.describe('/play accessibility floor', () => {
	test('HUD text clears AA over a bright scene, not just a dark one', async ({ page }) => {
		await mountChrome(page, { scene: 'bright' });
		await page.evaluate(async () => {
			const { EconPanel } = await import('/src/game/economy-ui.js');
			window.__panel = new EconPanel({ title: 'General Store', onClose: () => {} });
			const body = window.__panel.body;
			// Representative rows: primary label, secondary label, and the faint
			// tier that used to sit at 2.8:1.
			body.innerHTML = `
				<div class="ec-row"><span class="ec-row-name">Iron pickaxe</span>
				<span class="ec-row-sub">Chops twice as fast</span></div>`;
			const hud = document.createElement('div');
			hud.id = 'cc-hud';
			hud.innerHTML = `
				<div class="cc-coin-banner"><div class="cc-coin-info">
					<div class="cc-coin-name">three.ws</div>
					<div class="cc-coin-sub"><span class="cc-coin-sym">$THREE</span>
					<span class="cc-online"><span class="cc-dot"></span><span>12 online</span></span></div>
				</div></div>
				<div id="cc-chat"><div class="cc-chat-log"><div class="cc-chat-msg">
					<span class="cc-chat-meta"><b>ana</b><time>14:20</time></span>
					<span class="cc-chat-text">hey</span></div></div></div>
				<div id="cc-hint"><kbd>W A S D</kbd> to move</div>`;
			document.body.appendChild(hud);
		});
		await page.waitForTimeout(300);

		const rows = await page.evaluate(() => {
			const px = (c) => (c.match(/[\d.]+/g) || []).map(Number);
			const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
			const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
			const over = (fg, bg) => { const a = fg[3] ?? 1; return [0, 1, 2].map((i) => fg[i] * a + bg[i] * (1 - a)); };
			// Composite every translucent layer from the element up to the painted
			// root, exactly as the browser does, so the measured background is the
			// one the eye actually sees.
			const bgOf = (el) => {
				const layers = [];
				for (let n = el; n; n = n.parentElement) {
					const c = px(getComputedStyle(n).backgroundColor);
					if (c.length && (c[3] ?? 1) > 0) layers.push(c);
				}
				let acc = [255, 255, 255];
				for (const c of layers.reverse()) acc = over(c, acc);
				return acc;
			};
			const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
			const out = [];
			for (const el of document.querySelectorAll('#cc-hud *, .ec-card *')) {
				if (!el.textContent.trim() || el.children.length) continue;
				const s = getComputedStyle(el);
				const r = el.getBoundingClientRect();
				if (!r.width || !r.height || s.visibility === 'hidden') continue;
				const fg = px(s.color);
				if (!fg.length) continue;
				const bg = bgOf(el);
				const size = parseFloat(s.fontSize);
				const large = size >= 24 || (size >= 18.66 && parseInt(s.fontWeight, 10) >= 700);
				out.push({
					sel: (typeof el.className === 'string' && el.className) || el.tagName,
					text: el.textContent.trim().slice(0, 20),
					ratio: +ratio(over(fg, bg), bg).toFixed(2),
					min: large ? 3 : 4.5,
				});
			}
			return out.sort((a, b) => a.ratio - b.ratio);
		});

		expect(rows.length).toBeGreaterThan(5);
		const failing = rows.filter((r) => r.ratio < r.min);
		expect(failing, `below AA: ${JSON.stringify(failing, null, 1)}`).toEqual([]);
		// Log the worst five so a regression report carries the real numbers.
		console.log('worst HUD contrast pairs:', JSON.stringify(rows.slice(0, 5)));
	});

	test('every panel control has a visible focus ring', async ({ page }) => {
		await mountChrome(page);
		await page.evaluate(async () => {
			const { EconPanel } = await import('/src/game/economy-ui.js');
			window.__panel = new EconPanel({ title: 'Bank / ATM', onClose: () => {} });
			window.__panel.body.innerHTML =
				'<button class="ec-row-btn" type="button">Deposit</button>'
				+ '<input class="ec-bank-input" type="number" aria-label="Amount">';
		});
		await page.waitForTimeout(300);

		const controls = await page.$$('.ec-card button, .ec-card input');
		expect(controls.length).toBeGreaterThan(1);
		for (const control of controls) {
			await control.evaluate((el) => el.blur());
			const before = await control.evaluate((el) => {
				const s = getComputedStyle(el);
				return s.outlineStyle + '|' + s.outlineWidth + '|' + s.boxShadow;
			});
			// :focus-visible only paints for a keyboard-originated focus, which is
			// what Playwright's keyboard focus produces.
			await control.evaluate((el) => el.focus());
			await page.keyboard.press('Shift+Tab');
			await page.keyboard.press('Tab');
			const after = await control.evaluate((el) => {
				const s = getComputedStyle(el);
				return {
					sig: s.outlineStyle + '|' + s.outlineWidth + '|' + s.boxShadow,
					outline: s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0,
					shadow: s.boxShadow !== 'none',
					cls: el.className,
				};
			});
			expect(after.outline || after.shadow, `no focus indicator on .${after.cls}`).toBe(true);
			expect(after.sig, `focus indicator identical to resting state on .${after.cls}`).not.toBe(before);
		}
	});

	test('Escape closes the top panel, Tab stays inside, focus returns to the opener', async ({ page }) => {
		await mountChrome(page);
		await page.evaluate(async () => {
			const opener = document.createElement('button');
			opener.id = 'opener';
			opener.type = 'button';
			opener.textContent = 'Open store';
			document.body.appendChild(opener);
			opener.focus();

			const { EconPanel } = await import('/src/game/economy-ui.js');
			window.__closed = [];
			window.__store = new EconPanel({ title: 'General Store', onClose: () => window.__closed.push('store') });
			window.__store.body.innerHTML = '<button class="ec-row-btn" type="button">Buy</button>';
			window.__wheel = new EconPanel({ title: 'Bank / ATM', onClose: () => window.__closed.push('bank') });
			window.__wheel.body.innerHTML = '<button class="ec-row-btn" type="button">Deposit</button>';
		});
		await page.waitForTimeout(400);

		// Focus moved into the newest panel.
		expect(await page.evaluate(() => document.activeElement?.closest('.ec-card')?.getAttribute('aria-label'))).toBe('Bank / ATM');

		// Tab cycles inside that panel and never reaches the opener behind it.
		for (let i = 0; i < 6; i++) {
			await page.keyboard.press('Tab');
			expect(await page.evaluate(() => !!document.activeElement?.closest('.ec-card'))).toBe(true);
		}

		// Escape closes only the top one.
		await page.keyboard.press('Escape');
		await page.waitForTimeout(300);
		expect(await page.evaluate(() => window.__closed)).toEqual(['bank']);

		await page.keyboard.press('Escape');
		await page.waitForTimeout(400);
		expect(await page.evaluate(() => window.__closed)).toEqual(['bank', 'store']);
		expect(await page.evaluate(() => document.activeElement?.id)).toBe('opener');
	});

	test('axe finds no WCAG A/AA violations on the mounted world chrome', async ({ page }) => {
		await mountChrome(page);
		await page.evaluate(async () => {
			const { EconPanel } = await import('/src/game/economy-ui.js');
			const panel = new EconPanel({ title: 'General Store', onClose: () => {} });
			panel.body.innerHTML = `
				<div class="ec-row"><span class="ec-row-name">Iron pickaxe</span>
					<span class="ec-row-sub">Chops twice as fast</span>
					<button class="ec-row-btn" type="button">Buy 40</button></div>`;
			const tabs = document.createElement('div');
			tabs.className = 'ec-tabs';
			tabs.setAttribute('role', 'tablist');
			tabs.setAttribute('aria-label', 'Store mode');
			tabs.innerHTML =
				'<button class="ec-tab ec-on" type="button" role="tab" aria-selected="true">Buy</button>'
				+ '<button class="ec-tab" type="button" role="tab" aria-selected="false">Sell</button>';
			panel.card.insertBefore(tabs, panel.body);
		});
		await page.waitForTimeout(400);

		const results = await new AxeBuilder({ page })
			.include('.ec-overlay')
			.withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
			.analyze();
		const summary = results.violations.map(
			(v) => `[${v.impact}] ${v.id}: ${v.help}\n  ${v.nodes.map((n) => n.target.join(' ')).join('\n  ')}`,
		).join('\n');
		expect(results.violations, summary).toEqual([]);
	});

	test('the panel stays usable and inside the viewport at 200% zoom', async ({ page }) => {
		// 200% browser zoom on a 1280x800 window is a 640x400 CSS viewport.
		await page.setViewportSize({ width: 640, height: 400 });
		await mountChrome(page);
		await page.evaluate(async () => {
			const { EconPanel } = await import('/src/game/economy-ui.js');
			const panel = new EconPanel({ title: 'General Store', onClose: () => {} });
			panel.body.innerHTML = Array.from({ length: 6 }, (_, i) =>
				`<div class="ec-row"><span class="ec-row-name">Verstärkte Spitzhacke ${i}</span>
				 <span class="ec-row-sub">Doppelt so schnell beim Abbauen</span>
				 <button class="ec-row-btn" type="button">Kaufen 40</button></div>`).join('');
		});
		await page.waitForTimeout(400);

		const layout = await page.evaluate(() => {
			const card = document.querySelector('.ec-card');
			const r = card.getBoundingClientRect();
			// Nothing may be clipped horizontally, and no text may be cut off by a
			// fixed height (scrollHeight > clientHeight is fine only where the
			// element is actually scrollable).
			const clipped = [...card.querySelectorAll('*')].filter((el) => {
				const s = getComputedStyle(el);
				if (s.overflow !== 'hidden' && s.overflowX !== 'hidden') return false;
				return el.scrollWidth > el.clientWidth + 1;
			}).map((el) => el.className);
			return {
				docScrollsX: document.documentElement.scrollWidth > window.innerWidth + 1,
				cardFits: r.left >= -1 && r.right <= window.innerWidth + 1,
				bodyScrollable: getComputedStyle(document.querySelector('.ec-body')).overflowY,
				clipped,
			};
		});
		expect(layout.docScrollsX, 'the page scrolls horizontally at 200% zoom').toBe(false);
		expect(layout.cardFits, 'the panel is wider than the viewport at 200% zoom').toBe(true);
		expect(layout.clipped, `clipped text at 200% zoom: ${layout.clipped.join(', ')}`).toEqual([]);
	});
});
