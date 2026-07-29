#!/usr/bin/env node
/**
 * Mobile input-ergonomics audit (prompts/quality-bar/08 task 4).
 *
 * Loads pages in a real mobile Playwright context (default Pixel 5) and reads
 * the LIVE, computed DOM. Nothing here is inferred from source greps, so every
 * finding is a measured box or a resolved computed style.
 *
 * It reports four classes of defect:
 *
 *  1. Touch targets below 44x44 CSS px. Per WCAG 2.5.5 / the Apple and Material
 *     guidance, control targets need ~44 px. Inline links that sit inside a run
 *     of text are exempt (WCAG 2.5.8 "inline" exception) and are counted
 *     separately as `inlineExempt` rather than reported as defects.
 *  2. Canvases and viewer containers whose computed `touch-action` is `auto`.
 *     A WebGL viewer that calls preventDefault on pointer moves while
 *     touch-action stays `auto` makes orbit gestures fight page scroll; the fix
 *     is an explicit `touch-action` (`none` for full orbit control, `pan-y` for
 *     a viewer embedded in a scrolling page).
 *  3. Safe-area handling: whether the viewport meta opts into
 *     `viewport-fit=cover` (without it `env(safe-area-inset-*)` always resolves
 *     to 0), and which bottom-anchored fixed/sticky bars have no CSS rule
 *     mentioning `safe-area-inset` applying to them. Those bars land under the
 *     iOS home indicator.
 *  4. Horizontal overflow at the mobile viewport width (scrollWidth > clientWidth).
 *
 * Usage:
 *   node scripts/mobile-touch-audit.mjs                    # top-15 preset
 *   node scripts/mobile-touch-audit.mjs --pages /,/forge
 *   node scripts/mobile-touch-audit.mjs --json out.json --md out.md
 *   node scripts/mobile-touch-audit.mjs --base http://localhost:3000
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const C = {
	g: (s) => `\x1b[32m${s}\x1b[0m`,
	r: (s) => `\x1b[31m${s}\x1b[0m`,
	y: (s) => `\x1b[33m${s}\x1b[0m`,
	d: (s) => `\x1b[2m${s}\x1b[0m`,
	b: (s) => `\x1b[1m${s}\x1b[0m`,
	c: (s) => `\x1b[36m${s}\x1b[0m`,
};

const THREE_MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';

const DEFAULT_PAGES = [
	'/',
	'/forge',
	'/markets',
	'/news',
	'/marketplace',
	`/coin/${THREE_MINT}`,
	'/dashboard',
	'/walk',
	'/irl',
	'/ar',
	'/play',
	'/launches',
	'/changelog',
	'/docs/start-here',
];

const MIN_TARGET = 44;

function parseArgs(argv) {
	const out = {
		base: 'https://three.ws',
		pages: null,
		device: 'Pixel 5',
		settle: 6000,
		timeout: 60000,
		json: null,
		md: null,
		label: '',
		gesture: true,
	};
	for (let i = 2; i < argv.length; i++) {
		const a = argv[i];
		const next = () => argv[++i];
		if (a === '--no-gesture') out.gesture = false;
		else if (a === '--base') out.base = next().replace(/\/+$/, '');
		else if (a === '--pages') out.pages = next();
		else if (a === '--device') out.device = next();
		else if (a === '--settle') out.settle = Math.max(0, Number(next()) || 0);
		else if (a === '--timeout') out.timeout = Math.max(5000, Number(next()) || 5000);
		else if (a === '--json') out.json = next();
		else if (a === '--md') out.md = next();
		else if (a === '--label') out.label = next();
	}
	return out;
}

// ── Runs inside the page ─────────────────────────────────────────────────────
function auditDom(minTarget) {
	const describe = (el) => {
		const id = el.id ? `#${el.id}` : '';
		const cls =
			typeof el.className === 'string' && el.className.trim()
				? `.${el.className.trim().split(/\s+/).slice(0, 3).join('.')}`
				: '';
		return `${el.tagName.toLowerCase()}${id}${cls}`;
	};

	const isVisible = (el, cs, box) =>
		cs.display !== 'none' &&
		cs.visibility !== 'hidden' &&
		Number(cs.opacity) > 0.01 &&
		box.width > 0 &&
		box.height > 0;

	// Collect same-origin CSS rules once so we can ask "does any rule that
	// matches this element mention safe-area-inset?".
	const rules = [];
	for (const sheet of Array.from(document.styleSheets)) {
		let list;
		try {
			list = sheet.cssRules;
		} catch {
			continue; // cross-origin sheet, not readable
		}
		const walk = (ruleList) => {
			for (const rule of Array.from(ruleList || [])) {
				if (rule.cssRules) walk(rule.cssRules);
				else if (rule.selectorText && rule.cssText) rules.push(rule);
			}
		};
		walk(list);
	}
	const safeAreaRules = rules.filter((r) => /safe-area-inset/.test(r.cssText));
	const matchesSafeArea = (el) =>
		safeAreaRules.some((r) => {
			try {
				return el.matches(r.selectorText);
			} catch {
				return false;
			}
		});

	const INTERACTIVE =
		'a[href], button, input, select, textarea, summary, [role="button"], [role="link"], [role="tab"], [role="switch"], [role="checkbox"], [role="menuitem"], [onclick], [tabindex]:not([tabindex="-1"])';

	const smallTargets = [];
	let inlineExempt = 0;
	let checked = 0;

	for (const el of Array.from(document.querySelectorAll(INTERACTIVE))) {
		const cs = getComputedStyle(el);
		const box = el.getBoundingClientRect();
		if (!isVisible(el, cs, box)) continue;
		if (el.closest('[aria-hidden="true"]')) continue;
		checked++;
		const w = box.width;
		const h = box.height;
		if (w >= minTarget && h >= minTarget) continue;

		// WCAG 2.5.8 inline exception: a link inside a sentence.
		const inlineDisplay = cs.display.startsWith('inline');
		const parent = el.parentElement;
		const parentHasText =
			!!parent &&
			Array.from(parent.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim().length > 0);
		if (el.tagName === 'A' && inlineDisplay && parentHasText) {
			inlineExempt++;
			continue;
		}

		smallTargets.push({
			sel: describe(el),
			w: Math.round(w),
			h: Math.round(h),
			text: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 40),
			inNav: !!el.closest('nav, header, footer, [role="navigation"]'),
			fixed: cs.position === 'fixed' || cs.position === 'sticky',
			path: (() => {
				const chain = [];
				let n = el.parentElement;
				for (let i = 0; n && i < 3; i++, n = n.parentElement) chain.unshift(describe(n));
				return chain.join(' > ');
			})(),
		});
	}

	// Canvases and their scroll-gesture posture.
	const canvases = Array.from(document.querySelectorAll('canvas')).map((el) => {
		const cs = getComputedStyle(el);
		const box = el.getBoundingClientRect();
		const wrap = el.parentElement;
		return {
			sel: describe(el),
			w: Math.round(box.width),
			h: Math.round(box.height),
			visible: isVisible(el, cs, box),
			touchAction: cs.touchAction,
			parentSel: wrap ? describe(wrap) : '',
			parentTouchAction: wrap ? getComputedStyle(wrap).touchAction : '',
		};
	});

	// Bottom-anchored bars and their safe-area posture.
	const viewportMeta = document.querySelector('meta[name="viewport"]')?.getAttribute('content') || '';
	const bottomBars = [];
	for (const el of Array.from(document.body.querySelectorAll('*'))) {
		const cs = getComputedStyle(el);
		if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
		const box = el.getBoundingClientRect();
		if (!isVisible(el, cs, box)) continue;
		const distanceFromBottom = window.innerHeight - box.bottom;
		// A real bottom bar hugs the bottom edge, spans most of the width, and is
		// short. The height ceiling is what keeps full-screen fixed overlays and
		// backdrop layers (which also end at the bottom edge) out of the list.
		if (
			distanceFromBottom > 4 ||
			box.height < 24 ||
			box.height > window.innerHeight * 0.4 ||
			box.width < window.innerWidth * 0.5
		)
			continue;
		bottomBars.push({
			sel: describe(el),
			h: Math.round(box.height),
			paddingBottom: cs.paddingBottom,
			bottom: cs.bottom,
			hasSafeAreaRule: matchesSafeArea(el),
		});
	}

	// Horizontal overflow. `scrollWidth > clientWidth` alone over-reports: the
	// site-wide `overflow-x: clip` guard in mobile.css leaves scrollWidth wide
	// while making the page genuinely unscrollable sideways. So also try to
	// scroll and see whether it takes.
	const doc = document.documentElement;
	const overflowPx = Math.max(0, doc.scrollWidth - doc.clientWidth);
	let canScrollX = false;
	if (overflowPx > 0) {
		const before = window.scrollX;
		window.scrollTo({ left: 40, top: window.scrollY, behavior: 'instant' });
		canScrollX = window.scrollX > before;
		window.scrollTo({ left: before, top: window.scrollY, behavior: 'instant' });
	}

	return {
		title: document.title,
		overflowXStyle: getComputedStyle(doc).overflowX,
		canScrollX,
		checked,
		inlineExempt,
		smallTargets,
		canvases,
		viewportMeta,
		viewportFitCover: /viewport-fit\s*=\s*cover/.test(viewportMeta),
		safeAreaRuleCount: safeAreaRules.length,
		bottomBars,
		overflowX: overflowPx,
		innerWidth: window.innerWidth,
	};
}

/**
 * Real gesture probe. `touch-action: auto` on a canvas is only a defect if the
 * viewer actually swallows the swipe, so instead of trusting the computed style
 * we dispatch a genuine vertical touch drag through CDP and measure how far the
 * document scrolled. A control swipe over ordinary page content in the same
 * session gives the "this page can scroll at all" reference.
 */
async function probeScrollGestures(page, cdp, canvases) {
	const results = [];
	const vh = await page.evaluate(() => window.innerHeight);
	const send = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points });
	const swipeUp = async (x, y) => {
		const before = await page.evaluate(() => window.scrollY);
		await send('touchStart', [{ x, y }]);
		for (let i = 1; i <= 6; i++) {
			await send('touchMove', [{ x, y: y - i * 30 }]);
			await page.waitForTimeout(30);
		}
		await send('touchEnd', []);
		await page.waitForTimeout(700);
		const after = await page.evaluate(() => window.scrollY);
		return Math.round(after - before);
	};

	// Control: from the top of the document, swipe over ordinary page content at
	// the left edge. Establishes that this document scrolls by touch at all.
	let control = 0;
	try {
		await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
		await page.waitForTimeout(400);
		control = await swipeUp(6, Math.round(vh * 0.7));
	} catch {
		control = 0;
	}

	const findCanvas = (sel) => {
		const el = Array.from(document.querySelectorAll('canvas')).find((n) => {
			const id = n.id ? `#${n.id}` : '';
			const cls =
				typeof n.className === 'string' && n.className.trim()
					? `.${n.className.trim().split(/\s+/).slice(0, 3).join('.')}`
					: '';
			return `canvas${id}${cls}` === sel;
		});
		if (!el) return null;
		el.scrollIntoView({ block: 'center', behavior: 'instant' });
		const r = el.getBoundingClientRect();
		return {
			x: Math.round(r.x + r.width / 2),
			y: Math.round(Math.min(Math.max(r.y + r.height / 2, 40), window.innerHeight - 40)),
			scrollY: Math.round(window.scrollY),
			headroom: Math.round(document.documentElement.scrollHeight - window.innerHeight - window.scrollY),
		};
	};

	for (const c of canvases) {
		if (!c.visible || c.w < 100 || c.h < 100) continue;
		try {
			const box = await page.evaluate(findCanvas, c.sel);
			if (!box) continue;
			await page.waitForTimeout(400);
			const moved = await swipeUp(box.x, box.y);
			results.push({
				sel: c.sel,
				touchAction: c.touchAction,
				scrolled: moved,
				headroom: box.headroom,
				// Only a canvas with real scroll headroom under it that refuses to
				// move the page is actually fighting page scroll.
				swallowed: box.headroom > 200 && Math.abs(moved) < 5,
			});
		} catch {
			/* canvas vanished between audit and probe */
		}
	}
	return { control, canvases: results };
}

async function auditPage(browser, deviceDescriptor, url, opts) {
	const context = await browser.newContext({ ...deviceDescriptor, serviceWorkers: 'block' });
	const page = await context.newPage();
	let error = null;
	let status = 0;
	try {
		const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: opts.timeout });
		status = res?.status() ?? 0;
		await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {});
		await page.waitForTimeout(opts.settle);
	} catch (err) {
		error = String(err.message).split('\n')[0].slice(0, 200);
	}
	let dom = null;
	let gesture = null;
	if (!error) {
		try {
			dom = await page.evaluate(auditDom, MIN_TARGET);
		} catch (err) {
			error = `audit failed: ${String(err.message).slice(0, 160)}`;
		}
	}
	if (dom && opts.gesture && (dom.canvases || []).some((c) => c.visible && c.w >= 100 && c.h >= 100)) {
		try {
			const cdp = await context.newCDPSession(page);
			gesture = await probeScrollGestures(page, cdp, dom.canvases);
		} catch (err) {
			gesture = { error: String(err.message).slice(0, 160) };
		}
	}
	await context.close().catch(() => {});
	return { url, status, error, gesture, ...(dom || {}) };
}

function renderMarkdown(report) {
	const { config, results } = report;
	const rows = [...results]
		.sort((a, b) => (b.smallTargets?.length ?? 0) - (a.smallTargets?.length ?? 0))
		.map((r) => {
			const canvasNoTouch = (r.canvases || []).filter((c) => c.visible && c.touchAction === 'auto').length;
			const barsNoSafe = (r.bottomBars || []).filter((b) => !b.hasSafeAreaRule).length;
			return `| \`${r.path}\` | ${r.smallTargets?.length ?? '-'} | ${r.checked ?? '-'} | ${
				r.inlineExempt ?? '-'
			} | ${canvasNoTouch}/${(r.canvases || []).filter((c) => c.visible).length} | ${
				r.viewportFitCover ? 'yes' : 'NO'
			} | ${barsNoSafe}/${(r.bottomBars || []).length} | ${r.overflowX ?? '-'} px |`;
		});

	const detail = [...results]
		.sort((a, b) => (b.smallTargets?.length ?? 0) - (a.smallTargets?.length ?? 0))
		.filter((r) => (r.smallTargets?.length || 0) > 0 || (r.bottomBars?.length || 0) > 0 || r.overflowX > 0)
		.map((r) => {
			const groups = new Map();
			for (const t of r.smallTargets || []) {
				const key = `${t.sel} ${t.w}x${t.h}`;
				groups.set(key, (groups.get(key) || 0) + 1);
			}
			const lines = [...groups.entries()]
				.sort((a, b) => b[1] - a[1])
				.slice(0, 12)
				.map(([k, n]) => `  - ${n}x \`${k}\``);
			const bars = (r.bottomBars || []).map(
				(b) => `  - \`${b.sel}\` h=${b.h} padding-bottom=${b.paddingBottom} safe-area-rule=${b.hasSafeAreaRule}`,
			);
			const cans = (r.canvases || [])
				.filter((c) => c.visible)
				.map((c) => `  - \`${c.sel}\` ${c.w}x${c.h} touch-action=${c.touchAction} (parent ${c.parentTouchAction})`);
			return `### \`${r.path}\`

${lines.length ? `- undersized targets:\n${lines.join('\n')}\n` : '- undersized targets: none\n'}${
				cans.length ? `- visible canvases:\n${cans.join('\n')}\n` : ''
			}${bars.length ? `- bottom-anchored bars:\n${bars.join('\n')}\n` : ''}${
				r.overflowX > 0
					? `- horizontal overflow: ${r.overflowX} px beyond ${r.innerWidth} px viewport (html overflow-x: ${r.overflowXStyle}, actually scrolls sideways: ${r.canScrollX})\n`
					: ''
			}${
				r.gesture && !r.gesture.error
					? `- vertical swipe test (px the document scrolled; control swipe off-canvas moved ${r.gesture.control} px):\n${
							r.gesture.canvases.length
								? r.gesture.canvases
										.map(
											(g) =>
												`  - \`${g.sel}\` touch-action=${g.touchAction} -> page scrolled ${g.scrolled} px (headroom ${g.headroom} px)${
													g.swallowed ? ' **swallowed the swipe**' : ''
												}`,
										)
										.join('\n')
								: '  - no canvas large enough to probe'
						}\n`
					: ''
			}`;
		});

	return `# Mobile input-ergonomics audit${config.label ? ` - ${config.label}` : ''}

Measured with \`scripts/mobile-touch-audit.mjs\` against ${config.base} in a real
${config.device} Playwright context (Chromium). Every value below is a live computed style or a
measured bounding box, not a source grep.

- Minimum target size checked: ${MIN_TARGET}x${MIN_TARGET} CSS px
- Inline text links are exempt (WCAG 2.5.8) and counted separately
- Measured: ${config.startedAt}

| path | undersized targets | interactive checked | inline-exempt | canvases touch-action:auto / visible | viewport-fit=cover | bottom bars w/o safe-area / total | overflow-x |
|---|---|---|---|---|---|---|---|
${rows.join('\n')}

## Detail

${detail.join('\n')}
`;
}

async function main() {
	const opts = parseArgs(process.argv);
	const deviceDescriptor = devices[opts.device];
	if (!deviceDescriptor) {
		console.error(C.r(`unknown --device "${opts.device}"`));
		process.exit(2);
	}
	const paths = (opts.pages ? opts.pages.split(',').map((p) => p.trim()).filter(Boolean) : DEFAULT_PAGES).map((p) =>
		p.startsWith('/') ? p : `/${p}`,
	);

	const config = {
		base: opts.base,
		device: opts.device,
		label: opts.label,
		startedAt: new Date().toISOString(),
		harness: 'scripts/mobile-touch-audit.mjs',
		minTarget: MIN_TARGET,
	};

	console.log(C.b('\nmobile-touch-audit') + C.d(`  ${config.base} @ ${config.device}\n`));
	const browser = await chromium.launch({ headless: true });
	const results = [];
	try {
		for (const path of paths) {
			const r = await auditPage(browser, deviceDescriptor, `${opts.base}${path}`, opts);
			r.path = path;
			results.push(r);
			if (r.error) {
				console.log(`  ${C.c(path.padEnd(52))} ${C.r(r.error)}`);
			} else {
				const canvasNoTouch = (r.canvases || []).filter((c) => c.visible && c.touchAction === 'auto').length;
				const barsNoSafe = (r.bottomBars || []).filter((b) => !b.hasSafeAreaRule).length;
				const bad = r.smallTargets.length + canvasNoTouch + barsNoSafe + (r.overflowX > 0 ? 1 : 0);
				console.log(
					`  ${C.c(path.padEnd(52))} ${bad === 0 ? C.g('clean') : C.y(`${r.smallTargets.length} small targets`)}` +
						C.d(
							`  canvas-auto ${canvasNoTouch}  bottombars-unsafe ${barsNoSafe}  overflowX ${r.overflowX}  vfc ${r.viewportFitCover}`,
						),
				);
			}
		}
	} finally {
		await browser.close().catch(() => {});
	}

	const report = { config, results };
	if (opts.json) {
		const p = resolve(ROOT, opts.json);
		mkdirSync(dirname(p), { recursive: true });
		writeFileSync(p, JSON.stringify(report, null, 2));
		console.log(C.g(`\n  wrote ${p}`));
	}
	if (opts.md) {
		const p = resolve(ROOT, opts.md);
		mkdirSync(dirname(p), { recursive: true });
		writeFileSync(p, renderMarkdown(report));
		console.log(C.g(`  wrote ${p}`));
	}
	process.exit(results.some((r) => !r.error) ? 0 : 1);
}

main().catch((err) => {
	console.error(C.r(`mobile-touch-audit failed: ${err.stack || err.message}`));
	process.exit(1);
});
