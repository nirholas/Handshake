import { chromium } from 'playwright';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const GLB_PATH = resolve(process.cwd(), 'public/avatars/default.glb');

const step = (m) => console.log(`\n── ${m}`);

(async () => {
	const browser = await chromium.launch();
	const ctx = await browser.newContext();
	const page = await ctx.newPage();
	const consoleErrors = [];
	page.on('console', (m) => {
		if (m.type() === 'error') consoleErrors.push(m.text());
	});
	page.on('pageerror', (e) => consoleErrors.push(`[pageerror] ${e.message}`));

	try {
		step('1. /create loads anonymously, cards enabled');
		await page.goto(`${BASE}/create`, { waitUntil: 'networkidle' });
		await page.waitForFunction(() => window.__authed !== undefined, null, { timeout: 10000 });
		const authed = await page.evaluate(() => window.__authed);
		console.log(`   __authed = ${authed}`);
		if (authed) throw new Error('expected anonymous; dev API proxy returned an authed user');
		const cards = await page.$$eval('[role="button"][id^="card-"]', (els) =>
			els.map((el) => ({ id: el.id, disabled: el.getAttribute('aria-disabled') })),
		);
		console.log('   cards:', Object.fromEntries(cards.map((c) => [c.id, c.disabled || 'enabled'])));
		const upload = cards.find((c) => c.id === 'card-upload-glb');
		if (upload?.disabled === 'true') throw new Error('upload card disabled while unauthed');

		step('2. upload a real GLB → stage → navigate to /create-review');
		const glbBytes = readFileSync(GLB_PATH);
		console.log(`   GLB = ${glbBytes.length} bytes`);
		const navPromise = page.waitForURL(/\/create-review/, { timeout: 15000 });
		const fileInput = await page.$('#glb-input');
		if (!fileInput) throw new Error('#glb-input not found');
		await fileInput.setInputFiles({
			name: 'test-avatar.glb',
			mimeType: 'model/gltf-binary',
			buffer: glbBytes,
		});
		await navPromise;
		console.log('   ✓ landed on /create-review');

		step('3. review page renders the blob');
		await page.waitForSelector('#content:not([hidden])', { timeout: 5000 });
		await page.waitForFunction(
			() => {
				const mv = document.getElementById('mv');
				return mv && mv.src && mv.style.visibility !== 'hidden';
			},
			null,
			{ timeout: 15000 },
		);
		const src = await page.$eval('#mv', (el) => el.src);
		if (!src?.startsWith('blob:')) throw new Error(`expected blob: src, got ${src}`);
		console.log(`   ✓ #mv.src = ${src.slice(0, 50)}…`);
		console.log(`   tag-size = ${await page.$eval('#tag-size', (el) => el.textContent)}`);

		step('4. guest CTA flips to "Sign in to save"');
		await page.waitForFunction(() => window.__authed === false, null, { timeout: 5000 });
		await page.waitForFunction(
			() => document.querySelector('#save-btn')?.textContent.trim() === 'Sign in to save',
			null,
			{ timeout: 5000 },
		);
		const guestVisible = await page.$eval('#guest-note', (el) => !el.hidden);
		if (!guestVisible) throw new Error('#guest-note hidden for unauthed user');
		console.log('   ✓ save btn + guest note correct');

		step('5. IDB record matches uploaded bytes');
		const idb = await page.evaluate(async () => {
			return new Promise((resolve) => {
				const r = indexedDB.open('three-ws-guest', 1);
				r.onsuccess = () => {
					const db = r.result;
					const g = db.transaction('avatars', 'readonly').objectStore('avatars').get('pending');
					g.onsuccess = () =>
						resolve(
							g.result
								? { id: g.result.id, size: g.result.size, blobSize: g.result.blob?.size }
								: null,
						);
					g.onerror = () => resolve(null);
				};
				r.onerror = () => resolve(null);
			});
		});
		console.log('   IDB:', idb);
		if (!idb?.id) throw new Error('no IDB record at three-ws-guest/pending');
		if (idb.blobSize !== glbBytes.length) {
			throw new Error(`IDB blob size mismatch: ${idb.blobSize} vs ${glbBytes.length}`);
		}

		step('6. Start over clears IDB + returns to /create');
		page.once('dialog', (d) => d.accept());
		const back = page.waitForURL(/\/create(\?|$)/, { timeout: 5000 });
		await page.click('#start-over-btn');
		await back;
		const cleared = await page.evaluate(async () => {
			return new Promise((resolve) => {
				const r = indexedDB.open('three-ws-guest', 1);
				r.onsuccess = () => {
					const db = r.result;
					const g = db.transaction('avatars', 'readonly').objectStore('avatars').get('pending');
					g.onsuccess = () => resolve(g.result || null);
					g.onerror = () => resolve(null);
				};
				r.onerror = () => resolve(null);
			});
		});
		if (cleared) throw new Error('IDB not cleared after Start over');
		console.log('   ✓ IDB cleared');

		step('7. /create-review with nothing staged → empty state');
		await page.goto(`${BASE}/create-review`, { waitUntil: 'networkidle' });
		await page.waitForSelector('#empty-card:not([hidden])', { timeout: 5000 });
		if (!(await page.$eval('#content', (el) => el.hidden))) {
			throw new Error('expected #content hidden when nothing staged');
		}
		console.log('   ✓ empty state shown');

		const fatal = consoleErrors.filter(
			(e) =>
				!/model-viewer|webxr|favicon|@vite|\/api\/|Failed to load resource/.test(e),
		);
		if (fatal.length) {
			console.log('\n── fatal console errors:');
			for (const e of fatal) console.log('  ' + e);
			throw new Error(`${fatal.length} fatal console error(s)`);
		}
		console.log(`\n   (${consoleErrors.length} non-fatal console messages filtered)`);
		console.log('\n✓ all checks passed');
	} finally {
		await browser.close();
	}
})().catch((err) => {
	console.error('\n✗ verification failed:', err.message);
	process.exitCode = 1;
});
