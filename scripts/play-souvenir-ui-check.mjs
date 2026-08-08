// Browser check for the souvenir drop's UI, using the real shipped modules.
//
// The world-level run ([play-souvenir-e2e.mjs](play-souvenir-e2e.mjs)) drives
// the whole of `/play`, which means compiling the entire module graph and
// holding a WebGL scene open. That is the right test and the wrong tool when
// the only questions left are about two DOM components.
//
// This mounts the REAL `SouvenirDrop` card and the REAL `CosmeticsWardrobe`
// panel in a real browser, from the real source files through Vite, and drives
// them the way a player would. No world, no WebGL, no game server, so it runs in
// seconds on a machine too busy to hold `/play` open, and it still catches the
// things only a browser can: does the poster actually load, does the card's
// button fire the equip the scene would forward, does the wardrobe render an
// event souvenir as owned-and-equipped rather than as something to buy, and does
// a player who missed the event get told it is not for sale instead of being
// pointed at a shop that will never stock it.
//
//   node scripts/play-souvenir-ui-check.mjs
//   HEADED=1 node scripts/play-souvenir-ui-check.mjs   # watch it happen
//
// Exit code is 0 only when every check passes and the page logged no errors.

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VITE_PORT = Number(process.env.VITE_PORT || 3121);
const BASE = `http://localhost:${VITE_PORT}`;
const HARNESS_PORT = Number(process.env.HARNESS_PORT || 4611);
const SOUVENIR_ID = 'laurel-meetup';
const SHOT_DIR = path.join(ROOT, '.souvenir-ui');

const t0 = Date.now();
const at = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
const results = [];
function check(name, ok, detail = '') {
	results.push({ name, ok, detail });
	console.log(`${at()} ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `: ${detail}` : ''}`);
	return ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The harness page is served from the Vite origin (via a proxy below) so the
// module imports and the /accessories posters are same-origin, exactly as they
// are on the real page.
const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<style>
:root {
	--cc-panel-solid:#0c0c0c; --cc-bg2:#101010; --cc-bg3:#181818;
	--cc-edge:rgba(255,255,255,.12); --cc-edge-soft:rgba(255,255,255,.07);
	--cc-edge-hi:rgba(255,255,255,.55); --cc-text:#f5f5f6; --cc-dim:#8c8c92;
	--cc-faint:#5a5a60; --cc-radius:4px; --cc-shadow:0 16px 50px rgba(0,0,0,.7);
}
body { margin:0; background:#08080a; font:14px/1.4 system-ui, sans-serif; color:#f5f5f6; }
</style></head><body>
<script type="module">
import { SouvenirDrop } from '/src/game/event-souvenir.js';
import { CosmeticsWardrobe } from '/src/game/cosmetics-wardrobe.js';

window.__EQUIPS__ = [];
window.__WARDROBE_OPENS__ = 0;

window.mountCard = (msg) => {
	window.__card = new SouvenirDrop({
		onEquip: (id) => window.__EQUIPS__.push(id),
		onWardrobe: () => { window.__WARDROBE_OPENS__++; },
	});
	window.__card.show(msg);
};

window.mountWardrobe = (cosmetics) => {
	window.__wardrobe = new CosmeticsWardrobe({
		onEquip: (id) => window.__EQUIPS__.push(id),
		onShop: () => { window.__SHOP_OPENS__ = (window.__SHOP_OPENS__ || 0) + 1; },
	});
	window.__wardrobe.setProfile({ cosmetics });
	window.__wardrobe.open();
};

window.ready = true;
</script></body></html>`;

const procs = [];

async function waitFor(url, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try { if ((await fetch(url)).ok) return true; } catch { /* not up */ }
		if (Date.now() > deadline) return false;
		await sleep(500);
	}
}

async function main() {
	await mkdir(SHOT_DIR, { recursive: true });

	spawnVite();
	if (!await waitFor(BASE, 180_000)) throw new Error('vite never came up');
	console.log(`${at()} vite up on :${VITE_PORT}`);

	// Serve the harness on its own port but proxy everything else to Vite, so the
	// page and the modules it imports share one origin.
	const proxy = createServer(async (req, res) => {
		const url = (req.url || '/').split('?')[0];
		if (url === '/' || url === '/index.html') {
			res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
			res.end(PAGE);
			return;
		}
		try {
			const upstream = await fetch(`${BASE}${req.url}`);
			const body = Buffer.from(await upstream.arrayBuffer());
			res.writeHead(upstream.status, {
				'content-type': upstream.headers.get('content-type') || 'application/octet-stream',
			});
			res.end(body);
		} catch (err) {
			res.writeHead(502).end(String(err.message));
		}
	});
	await new Promise((r) => proxy.listen(HARNESS_PORT, '127.0.0.1', r));

	const browser = await chromium.launch({
		headless: process.env.HEADED !== '1',
		args: ['--disable-dev-shm-usage'],
	});
	const errors = [];
	try {
		const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
		page.on('pageerror', (e) => errors.push(`pageerror: ${e.message.slice(0, 200)}`));
		page.on('console', (m) => {
			if (m.type() !== 'error') return;
			const t = m.text();
			if (/favicon|\[vite\] connect|WebSocket/i.test(t)) return; // dev-server noise
			errors.push(t.slice(0, 200));
		});
		await page.goto(`http://127.0.0.1:${HARNESS_PORT}/`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
		await page.waitForFunction('window.ready === true', null, { timeout: 120_000 });
		console.log(`${at()} harness booted with the real modules`);

		// ── the drop card ──────────────────────────────────────────────────────
		await page.evaluate(([id]) => window.mountCard({
			id, name: 'Meetup Laurel', slot: 'headwear',
			eventId: 'three-first-meetup', eventName: '$THREE Community Day 2026',
		}), [SOUVENIR_ID]);
		await sleep(700);

		const card = await page.evaluate(() => {
			const c = document.querySelector('.es-card');
			if (!c) return null;
			const img = c.querySelector('.es-thumb img');
			return {
				visible: !!c.offsetParent,
				kicker: c.querySelector('.es-kicker')?.textContent.trim(),
				name: c.querySelector('.es-name')?.textContent,
				sub: c.querySelector('.es-sub')?.textContent,
				role: c.getAttribute('role'),
				live: c.getAttribute('aria-live'),
				buttons: [...c.querySelectorAll('button')].map((b) => b.textContent.trim()),
				posterSrc: img?.getAttribute('src') || null,
				posterLoaded: img ? img.complete && img.naturalWidth > 0 : false,
				// A modal would trap the page; this must not.
				isDialog: c.getAttribute('role') === 'dialog',
			};
		});
		check('card renders', !!card?.visible, JSON.stringify(card?.name));
		check('card names the item and the event', card?.name === 'Meetup Laurel' && /Community Day 2026/.test(card?.sub || ''),
			card?.sub);
		check('card announces politely and is not a modal',
			card?.role === 'status' && card?.live === 'polite' && !card?.isDialog,
			`role=${card?.role} live=${card?.live}`);
		check('card shows the real poster, loaded', card?.posterLoaded === true,
			`src=${card?.posterSrc}`);
		check('card offers wearing it and going to the wardrobe',
			card?.buttons?.length === 2 && /wear/i.test(card.buttons[0]) && /fits/i.test(card.buttons[1]),
			JSON.stringify(card?.buttons));
		await page.screenshot({ path: path.join(SHOT_DIR, 'card.png') });

		// Keyboard reachability: both actions must be tabbable.
		const focusables = await page.evaluate(() =>
			[...document.querySelectorAll('.es-card button')].filter((b) => b.tabIndex >= 0).length);
		check('card actions are keyboard reachable', focusables === 2, `tabbable=${focusables}`);

		// "Wear it" fires the equip the scene forwards to the server.
		await page.click('.es-card .es-btn-primary');
		await sleep(300);
		const afterClick = await page.evaluate(() => ({
			equips: window.__EQUIPS__,
			label: document.querySelector('.es-card .es-btn-primary')?.textContent,
			disabled: document.querySelector('.es-card .es-btn-primary')?.disabled,
		}));
		check('"Wear it" requests the equip exactly once',
			afterClick.equips.length === 1 && afterClick.equips[0] === SOUVENIR_ID,
			JSON.stringify(afterClick.equips));
		check('"Wear it" acknowledges the click instead of sitting inert',
			afterClick.disabled === true && /wearing/i.test(afterClick.label || ''),
			`label=${afterClick.label}`);

		// It retires itself rather than becoming furniture.
		await sleep(1600);
		check('card retires itself after the action',
			await page.evaluate(() => !document.querySelector('.es-card')));

		// Escape dismisses a fresh one without touching anything else.
		await page.evaluate(([id]) => window.mountCard({ id, name: 'Meetup Laurel', eventName: 'Test' }), [SOUVENIR_ID]);
		await sleep(500);
		await page.keyboard.press('Escape');
		await sleep(500);
		check('Escape dismisses the card',
			await page.evaluate(() => !document.querySelector('.es-card')));

		// ── the wardrobe, as an owner ──────────────────────────────────────────
		await page.evaluate(([id]) => window.mountWardrobe({
			owned: [id], equipped: { dye: 'dye-none', headwear: id, eyewear: 'eye-none', earrings: 'earring-none', aura: 'aura-none' },
		}), [SOUVENIR_ID]);
		await sleep(700);

		const owned = await page.evaluate(([id]) => {
			const c = document.querySelector(`.cw-card[data-id="${id}"]`);
			if (!c) return null;
			const img = c.querySelector('.cw-thumb-img');
			return {
				tier: c.getAttribute('data-tier'),
				locked: c.classList.contains('cw-locked'),
				equipped: c.classList.contains('cw-equipped'),
				rarity: c.querySelector('.cw-rarity')?.textContent,
				price: c.querySelector('.cw-price')?.textContent,
				tag: c.querySelector('.cw-tag')?.textContent,
				aria: c.getAttribute('aria-label'),
				posterLoaded: img ? img.complete && img.naturalWidth > 0 : false,
			};
		}, [SOUVENIR_ID]);
		check('wardrobe shows the souvenir as an owned event item',
			owned?.tier === 'event' && owned?.locked === false, JSON.stringify(owned));
		check('wardrobe marks it equipped', owned?.equipped === true && /equipped/i.test(owned?.tag || ''),
			`tag=${owned?.tag}`);
		check('wardrobe labels it a souvenir, never a price',
			/souvenir/i.test(owned?.price || '') && !/\$THREE/.test(owned?.price || ''), owned?.price);
		check('wardrobe shows its real poster', owned?.posterLoaded === true);
		check('wardrobe rarity reads legendary', /legendary/i.test(owned?.rarity || ''), owned?.rarity);
		await page.screenshot({ path: path.join(SHOT_DIR, 'wardrobe-owned.png') });

		// The "New" highlight, and that it clears once the panel has been seen.
		await page.evaluate(([id]) => { window.__wardrobe.close(); window.__wardrobe.markNew(id); window.__wardrobe.open(); }, [SOUVENIR_ID]);
		await sleep(600);
		const flagged = await page.evaluate(([id]) => {
			const c = document.querySelector(`.cw-card[data-id="${id}"]`);
			return { isNew: c?.classList.contains('cw-new'), tag: c?.querySelector('.cw-tag')?.textContent };
		}, [SOUVENIR_ID]);
		check('a freshly granted souvenir is highlighted in the wardrobe',
			flagged?.isNew === true, JSON.stringify(flagged));
		await page.evaluate(() => { window.__wardrobe.close(); window.__wardrobe.open(); });
		await sleep(600);
		check('the highlight clears once the panel has been seen',
			await page.evaluate(([id]) => !document.querySelector(`.cw-card[data-id="${id}"]`)?.classList.contains('cw-new'), [SOUVENIR_ID]));

		// ── the wardrobe, as someone who missed it ─────────────────────────────
		await page.evaluate(() => {
			window.__wardrobe.close();
			window.__SHOP_OPENS__ = 0;
			window.__wardrobe.setProfile({ owned: [], equipped: {} });
			window.__wardrobe.open();
		});
		await sleep(700);
		const missed = await page.evaluate(([id]) => {
			const c = document.querySelector(`.cw-card[data-id="${id}"]`);
			return c ? {
				locked: c.classList.contains('cw-locked'),
				price: c.querySelector('.cw-price')?.textContent,
				title: c.getAttribute('title'),
				aria: c.getAttribute('aria-label'),
			} : null;
		}, [SOUVENIR_ID]);
		check('someone who missed it sees it locked', missed?.locked === true, JSON.stringify(missed));
		check('and is told it is not for sale, not shown a price',
			/not for sale/i.test(missed?.price || '') && /event exclusive/i.test(missed?.title || ''),
			`${missed?.price} | ${missed?.title}`);

		// The critical one: clicking a locked souvenir must NOT route to the shop.
		await page.click(`.cw-card[data-id="${SOUVENIR_ID}"]`, { force: true });
		await sleep(400);
		const shopOpens = await page.evaluate(() => window.__SHOP_OPENS__ || 0);
		check('clicking a locked souvenir does not send the player to a shop that will never stock it',
			shopOpens === 0, `shop opens=${shopOpens}`);

		// A locked PREMIUM item still does route to the shop, so the above is a
		// targeted rule and not a broken click handler.
		await page.click('.cw-card[data-id="hat-cowboy"]', { force: true });
		await sleep(400);
		check('a locked premium item still opens the shop',
			await page.evaluate(() => (window.__SHOP_OPENS__ || 0) === 1),
			`shop opens=${await page.evaluate(() => window.__SHOP_OPENS__ || 0)}`);
		await page.screenshot({ path: path.join(SHOT_DIR, 'wardrobe-locked.png') });

		check('no console or page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
	} finally {
		await browser.close().catch(() => {});
		for (const c of procs) { try { c.kill('SIGTERM'); } catch { /* gone */ } }
	}

	console.log(`\n${at()} screenshots in ${SHOT_DIR}`);
	const failed = results.filter((r) => !r.ok);
	console.log(`${at()} ${results.length - failed.length}/${results.length} checks passed`);
	if (failed.length) {
		for (const f of failed) console.log(`  FAIL ${f.name}: ${f.detail}`);
		process.exit(1);
	}
}

function spawnVite() {
	const child = spawn('npx', ['vite', '--port', String(VITE_PORT), '--strictPort'], {
		cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
	});
	procs.push(child);
	child.stderr.setEncoding('utf8');
	child.stderr.on('data', (c) => { if (/error/i.test(c)) console.log(`${at()} [vite] ${c.trim().slice(0, 200)}`); });
	return child;
}

main().catch((err) => {
	console.error(err);
	for (const c of procs) { try { c.kill('SIGTERM'); } catch { /* gone */ } }
	process.exit(1);
});
