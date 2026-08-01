// Real-browser verification of the tutorial figure system.
import { chromium, devices } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:3000';
const SLUGS = ['getting-started', 'text-to-3d', 'render-avatar-images'];

const browser = await chromium.launch({ args: ['--no-sandbox'] });
let failures = 0;
const note = (ok, msg) => {
	if (!ok) failures++;
	console.log(`${ok ? '  ok  ' : ' FAIL '} ${msg}`);
};

for (const slug of SLUGS) {
	console.log(`\n=== /tutorials/${slug} (desktop 1280) ===`);
	const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
	const page = await ctx.newPage();
	const errors = [];
	page.on('console', (m) => {
		if (m.type() === 'error') { const t = m.text(); if (!/\[vite\]|WebSocket|__vite_ping/.test(t)) errors.push(t); }
	});
	page.on('pageerror', (e) => errors.push(String(e)));
	await page.goto(`${BASE}/tutorials/${slug}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
	await page.waitForSelector('.tfig', { timeout: 20000 }).catch(() => {});
	await page.waitForTimeout(3500);

	const stats = await page.evaluate(() => ({
		figures: document.querySelectorAll('figure.tfig').length,
		leftover: document.querySelectorAll('img[src^="figure:"]').length,
		captions: [...document.querySelectorAll('.tfig-caption .tfig-text')].map((n) => n.textContent.slice(0, 40)),
		nums: [...document.querySelectorAll('.tfig-num')].map((n) => n.textContent),
		imgsLoaded: [...document.querySelectorAll('.tfig-img')].map((i) => i.naturalWidth > 0),
		viewers: document.querySelectorAll('.tfig-frame-live model-viewer').length,
		altsPresent: [...document.querySelectorAll('.tfig-img')].every((i) => (i.getAttribute('alt') || '').length > 5),
		zoomBtns: document.querySelectorAll('.tfig-zoom').length,
		lightbox: !!document.querySelector('.tfig-lightbox'),
		inParagraph: document.querySelectorAll('p > figure.tfig').length,
	}));
	console.log(JSON.stringify(stats, null, 1));
	note(stats.figures > 0, `${stats.figures} figure(s) mounted`);
	note(stats.leftover === 0, 'no unresolved figure: placeholders remain');
	note(stats.imgsLoaded.every(Boolean), `all ${stats.imgsLoaded.length} static image(s) decoded`);
	note(stats.altsPresent, 'every static image carries real alt text');
	note(stats.inParagraph === 0, 'no <figure> is trapped inside a <p>');
	note(stats.nums.every((n) => /^Figure \d+$/.test(n)), `captions numbered: ${stats.nums.join(', ')}`);

	// Keyboard: tab to a zoom button, Enter to open, arrows, Escape to close.
	if (stats.zoomBtns > 0) {
		await page.locator('.tfig-zoom').first().focus();
		await page.keyboard.press('Enter');
		await page.waitForTimeout(500);
		const opened = await page.evaluate(() => {
			const lb = document.querySelector('.tfig-lightbox');
			return {
				visible: lb && !lb.hidden,
				focusInside: lb ? lb.contains(document.activeElement) : false,
				imgSrc: document.querySelector('.tfig-lb-img')?.getAttribute('src') || '',
				scrollLocked: getComputedStyle(document.documentElement).overflow === 'hidden',
				role: lb?.getAttribute('role'),
				modal: lb?.getAttribute('aria-modal'),
			};
		});
		note(opened.visible, 'Enter on the zoom control opens the lightbox');
		note(opened.focusInside, 'focus moves inside the dialog');
		note(!!opened.imgSrc, `lightbox shows ${opened.imgSrc.split('/').pop()}`);
		note(opened.scrollLocked, 'background scroll is locked while modal');
		note(opened.role === 'dialog' && opened.modal === 'true', 'dialog carries role + aria-modal');

		await page.keyboard.press('Escape');
		await page.waitForTimeout(400);
		const closed = await page.evaluate(() => ({
			hidden: document.querySelector('.tfig-lightbox')?.hidden,
			focusReturned: document.activeElement?.classList.contains('tfig-zoom'),
			scrollFree: getComputedStyle(document.documentElement).overflow !== 'hidden',
		}));
		note(closed.hidden === true, 'Escape closes the lightbox');
		note(closed.focusReturned, 'focus returns to the control that opened it');
		note(closed.scrollFree, 'scroll is released on close');
	}

	// Layout stability: the reserved box must match the decoded image.
	const cls = await page.evaluate(() => {
		const f = document.querySelector('.tfig-frame-img');
		if (!f) return null;
		const img = f.querySelector('img');
		const declared = getComputedStyle(f).aspectRatio;
		return { declared, natural: `${img.naturalWidth} / ${img.naturalHeight}` };
	});
	if (cls) note(cls.declared.replace(/\s/g, '') === cls.natural.replace(/\s/g, ''), `reserved box ${cls.declared} matches natural ${cls.natural}`);

	note(errors.length === 0, errors.length ? `console errors: ${errors.slice(0, 3).join(' | ')}` : 'no console errors');
	await ctx.close();
}

// Mobile: 320px, the narrowest viewport we support.
console.log('\n=== /tutorials/text-to-3d (320px) ===');
const mob = await browser.newContext({ ...devices['iPhone SE'], viewport: { width: 320, height: 640 } });
const mp = await mob.newPage();
await mp.goto(`${BASE}/tutorials/text-to-3d`, { waitUntil: 'domcontentloaded', timeout: 120000 });
await mp.waitForSelector('.tfig', { timeout: 20000 }).catch(() => {});
await mp.waitForTimeout(3000);
const mobile = await mp.evaluate(() => {
	const doc = document.documentElement;
	const over = [...document.querySelectorAll('.tfig, .tfig-body, .tfig-caption')].filter(
		(el) => el.getBoundingClientRect().right > window.innerWidth + 1,
	);
	return {
		hOverflow: doc.scrollWidth > doc.clientWidth,
		scrollWidth: doc.scrollWidth,
		clientWidth: doc.clientWidth,
		overflowing: over.map((e) => e.className),
		zoomAlwaysVisible: getComputedStyle(document.querySelector('.tfig-zoom') || document.body).opacity,
	};
});
console.log(JSON.stringify(mobile, null, 1));
note(!mobile.hOverflow, `no horizontal page overflow at 320px (${mobile.scrollWidth} vs ${mobile.clientWidth})`);
note(mobile.overflowing.length === 0, 'no figure element spills past the viewport');
await mob.close();

await browser.close();
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
