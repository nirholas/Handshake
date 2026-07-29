/**
 * Progressive disclosure — the Simple ⇄ Everything tier.
 *
 * A first-time visitor used to land on 100+ nav destinations and ten homepage
 * sections covering trading, token launches and payment protocols before they
 * had made anything. The lite tier fixes that: nav-data.js tags the power-user
 * surfaces `tier: 'advanced'`, the homepage tags its deep sections
 * `data-tier="advanced"`, and one class on <html> hides both until the visitor
 * asks for them.
 *
 * The mechanism is split across four files that have no import edge between
 * them (nav-data.js, public/nav.js, public/nav.css, pages/home.html +
 * public/home.css), so nothing but these tests stops the storage key, the class
 * name or a chip's target id from drifting apart and silently breaking the
 * reveal. That drift is exactly what they pin.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { NAV_GROUPS, NAV_LINKS } from '../public/nav-data.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');

const navJs = read('public/nav.js');
const navCss = read('public/nav.css');
const homeHtml = read('pages/home.html');
const homeCss = read('public/home.css');

/** Every menu item, with the tier it resolves to (group → column → item). */
function allItems() {
	const out = [];
	for (const group of NAV_GROUPS) {
		const cols = group.columns || [{ label: group.label, items: group.items || [] }];
		for (const col of cols) {
			for (const item of col.items || []) {
				const advanced =
					group.tier === 'advanced' || col.tier === 'advanced' || item.tier === 'advanced';
				out.push({ ...item, group: group.label, column: col.label, advanced });
			}
		}
	}
	return out;
}

const items = allItems();
const lite = items.filter((i) => !i.advanced);
const liteHrefs = new Set(lite.map((i) => i.href));

describe('nav tiering', () => {
	it("only ever uses the 'advanced' tier value", () => {
		const seen = new Set();
		for (const group of NAV_GROUPS) {
			if (group.tier) seen.add(group.tier);
			for (const col of group.columns || []) {
				if (col.tier) seen.add(col.tier);
				for (const item of col.items || []) if (item.tier) seen.add(item.tier);
			}
		}
		expect([...seen]).toEqual(['advanced']);
	});

	it('keeps the lite menu small enough to scan', () => {
		// The whole point: a first-time visitor sees a menu they can read, not a
		// directory. Well under the ~100 destinations the full nav carries.
		expect(lite.length).toBeGreaterThan(10);
		expect(lite.length).toBeLessThanOrEqual(30);
		expect(items.length - lite.length).toBeGreaterThan(50);
	});

	it('keeps the core journey — make an avatar, build an agent, publish it — in the lite tier', () => {
		for (const href of ['/create', '/create-agent', '/forge', '/create/selfie', '/docs', '/avatar-sdk']) {
			expect(liteHrefs.has(href), `${href} must stay in the simple menu`).toBe(true);
		}
	});

	it('moves the power-user surfaces out of the first-run menu', () => {
		for (const href of ['/pay', '/crypto', '/mirror', '/swarms', '/pulse', '/clash']) {
			expect(liteHrefs.has(href), `${href} belongs to the advanced tier`).toBe(false);
		}
	});

	it('hides the whole Launch menu — trading and token launches are not a first-run concern', () => {
		const launch = NAV_GROUPS.find((g) => g.label === 'Launch');
		expect(launch?.tier).toBe('advanced');
	});

	it('leaves every top-level link in the lite tier so the nav bar never empties', () => {
		expect(NAV_LINKS.length).toBeGreaterThan(0);
		expect(NAV_LINKS.every((l) => l.tier !== 'advanced')).toBe(true);
	});

	it('never hides a group that has no other way in', () => {
		// A wholly-advanced group disappears from the nav bar in lite mode, so
		// its contents must be reachable from the tier control rather than from
		// a trigger that is no longer rendered. renderGroup skips the footer for
		// those groups precisely because it could only ever collapse the menu
		// the visitor is reading.
		expect(navJs).toContain("const hidden = group.tier === 'advanced' ? 0 : advancedCount(group);");
	});
});

describe('tier mechanism wiring', () => {
	it('agrees on one storage key across the nav and the homepage', () => {
		expect(navJs).toContain("var TIER_KEY = 'tws:tier'");
		// The homepage's pre-paint boot script and its gate runtime read the same key.
		expect(homeHtml.match(/'tws:tier'/g)?.length).toBeGreaterThanOrEqual(2);
	});

	it('agrees on one html class across the nav and the homepage', () => {
		expect(navJs).toContain("classList.toggle('tws-lite', lite)");
		expect(homeHtml).toContain("classList.add('tws-lite')");
		expect(homeHtml).toContain("classList.contains('tws-lite')");
	});

	it('hides advanced surfaces from CSS, so the tier never flashes in and out', () => {
		expect(navCss).toMatch(/html\.tws-lite \.nav \[data-tier="advanced"\]/);
		expect(navCss).toMatch(/html\.tws-lite \.nav-drawer \[data-tier="advanced"\]/);
		expect(homeCss).toMatch(/html\.tws-lite \[data-tier="advanced"\]\s*\{\s*display:\s*none/);
	});

	it('re-lays a mega menu whose column count changes in the lite tier', () => {
		// Hiding a column would otherwise leave an empty grid track.
		expect(navJs).toContain('lite-cols-');
		for (const n of [1, 2, 3]) {
			expect(navCss).toContain(`html.tws-lite .nav-pop.mega.lite-cols-${n}`);
		}
	});

	it('keeps both tier surfaces in sync through one event', () => {
		expect(navJs).toContain("new CustomEvent('tws:tier-change'");
		expect(homeHtml).toContain("window.addEventListener('tws:tier-change'");
	});

	it('defaults a brand-new visitor to the lite tier', () => {
		// Anything other than an explicit opt-in to 'full' means lite, so a
		// cleared or unreadable localStorage lands on the simple experience.
		expect(navJs).toContain("localStorage.getItem(TIER_KEY) !== 'full'");
		expect(homeHtml).toContain("localStorage.getItem('tws:tier')!=='full'");
	});
});

describe('homepage lite path', () => {
	it('offers exactly the three promised steps, in order', () => {
		const steps = [...homeHtml.matchAll(/class="start-step"[^>]*href="([^"]+)"/g)].map((m) => m[1]);
		expect(steps).toEqual(['/create/prompt', '/create-agent', '#embed']);
	});

	it('places the start path above the advanced gate', () => {
		const path = homeHtml.indexOf('class="start-path"');
		const gate = homeHtml.indexOf('id="advanced-gate"');
		expect(path).toBeGreaterThan(-1);
		expect(gate).toBeGreaterThan(path);
	});

	it('points every advanced-gate chip at a section that exists', () => {
		const ids = new Set(
			[...homeHtml.matchAll(/<section[^>]*id="([^"]+)"[^>]*data-tier="advanced"/g)].map((m) => m[1]),
		);
		const chips = [...homeHtml.matchAll(/class="adv-topic" href="#([^"]+)"/g)].map((m) => m[1]);
		expect(chips.length).toBeGreaterThan(0);
		for (const target of chips) {
			expect(ids.has(target), `#${target} has no advanced section to reveal`).toBe(true);
		}
	});

	it('gates every deep section behind the tier, and no shallow one', () => {
		const gated = [...homeHtml.matchAll(/<section[^>]*id="([^"]+)"[^>]*data-tier="advanced"/g)].map(
			(m) => m[1],
		);
		expect(gated).toContain('home-sniper');
		expect(gated).toContain('home-x402');
		expect(gated).toContain('home-token-economy');
		// The forge and the embed demo are the product's first magic — they stay.
		expect(gated).not.toContain('home-forge');
		expect(gated).not.toContain('embed');
	});

	it('keeps the first screen to the two promises a newcomer can act on', () => {
		// The hero's third bullet names a payment protocol before the visitor has
		// made anything; Create and Embed are the journey and always show.
		const bullets = [...homeHtml.matchAll(/<li([^>]*)data-i18n-html="home\.bullet_(\w+)"/g)].map(
			(m) => ({ key: m[2], advanced: m[1].includes('data-tier="advanced"') }),
		);
		expect(bullets.map((b) => b.key)).toEqual(['create', 'embed', 'earn']);
		expect(bullets.find((b) => b.key === 'create').advanced).toBe(false);
		expect(bullets.find((b) => b.key === 'embed').advanced).toBe(false);
		expect(bullets.find((b) => b.key === 'earn').advanced).toBe(true);
	});

	it('reveals a gated section when the URL points into it', () => {
		// A shared link to #home-x402 must not land on a blank page.
		expect(homeHtml).toContain("el.closest('[data-tier=\"advanced\"]')");
		expect(homeHtml).toContain("window.addEventListener('hashchange', revealForHash)");
		// The gated sections are parsed after this script, so the load-time
		// check has to wait for the document.
		expect(homeHtml).toContain("document.addEventListener('DOMContentLoaded', revealForHash)");
	});

	it('jumps instantly on reveal instead of animating across the whole page', () => {
		expect(homeHtml).toContain("scrollIntoView({ block: 'start', behavior: 'auto' })");
	});
});
