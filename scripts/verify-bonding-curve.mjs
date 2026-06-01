import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:3001';
const REAL_MINT = process.env.MINT || '2xmwo8kN1MNMttfBENLkTLo2sFXiDYuReEa3y1eopump';

const cfg = {
	background: '#0a0a0a',
	accent: '#8b5cf6',
	showControls: false,
	autoRotate: true,
	rotationSpeed: 0.4,
	envPreset: 'neutral',
	mint: REAL_MINT,
	network: 'mainnet',
	refreshMs: 15000,
	showUsd: true,
};

// A realistic mid-bonding payload (~34.5%) shaped exactly like /api/pump/curve.
const FIXTURE_34 = {
	mint: REAL_MINT,
	network: 'mainnet',
	curve: {
		virtualTokenReserves: '900000000000000',
		virtualSolReserves: '48000000000',
		realTokenReserves: '519000000000000',
		realSolReserves: '18400000000',
		tokenTotalSupply: '1000000000000000',
		complete: false,
		creator: '2n5AxmKaqKTWMyuBh7nedaj3SwxYSWB9wE3CQa1o92YY',
		isMayhemMode: false,
	},
	price: { buyPricePerToken: '92', sellPricePerToken: '88', marketCap: '92000000000', isGraduated: false },
	graduation: { progressBps: 3450, isGraduated: false, tokensRemaining: '519000000000000', tokensTotal: '793100000000000', solAccumulated: '18400000000' },
};

async function boot(page, { intercept } = {}) {
	if (intercept) {
		await page.route('**/api/pump/curve**', (route) =>
			route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(intercept) }),
		);
	}
	const errors = [];
	page.on('console', (m) => {
		if (m.type() === 'error') errors.push(m.text());
	});
	page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

	const hash = `model=${encodeURIComponent('/avatars/cz.glb')}&kiosk=true&type=bonding-curve`;
	await page.goto(`${BASE}/widget#${hash}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
	// Studio-style: the widget runtime mounts on the first config message.
	await page.waitForTimeout(1200);
	await page.evaluate((c) => window.postMessage({ type: 'widget:config', config: c }, location.origin), cfg);
	return errors;
}

(async () => {
	const browser = await chromium.launch();
	let failed = false;

	// ── Scenario A: real endpoint (proxied to prod) ─────────────────────────
	{
		const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
		const errors = await boot(page);
		await page.waitForSelector('.bcw-card', { timeout: 8000 }).catch(() => {});
		const present = await page.locator('.bcw-card').count();
		const hasCurve = await page.locator('.bcw-curve [data-marker]').count();
		const hasCta = await page.locator('.bcw-cta').count();
		// Give the live fetch a moment to resolve into a real state class.
		await page.waitForTimeout(4000);
		const cls = await page.locator('.bcw-card').getAttribute('class').catch(() => '');
		console.log(`A/real  → card=${present} marker=${hasCurve} cta=${hasCta} state="${cls}"`);
		if (!present || !hasCurve || !hasCta) failed = true;
		const appErrors = errors.filter((e) => /bonding|bcw|curve/i.test(e));
		if (appErrors.length) { console.log('  widget console errors:', appErrors); failed = true; }
		await page.screenshot({ path: 'scripts/.bcw-real.png' });
		await page.close();
	}

	// ── Scenario B: intercepted 34.5% populated render ──────────────────────
	{
		const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
		await boot(page, { intercept: FIXTURE_34 });
		await page.waitForSelector('.bcw-card.is-bonding', { timeout: 9000 });
		await page.waitForTimeout(1400); // let the count-up + marker glide settle
		const pct = (await page.locator('.bcw-pct-num').textContent())?.trim();
		const mc = (await page.locator('[data-mc]').textContent())?.trim();
		const raised = (await page.locator('[data-raised]').textContent())?.trim();
		const price = (await page.locator('[data-price]').textContent())?.trim();
		const marker = await page.locator('[data-marker]').getAttribute('transform');
		const area = await page.locator('[data-area]').getAttribute('d');
		console.log(`B/34.5% → pct=${pct} mc=${mc} raised=${raised} price=${price}`);
		console.log(`         marker=${marker} area.len=${(area || '').length}`);
		const okPct = pct === '34' || pct === '35';
		const okMarker = marker && marker.includes('translate(');
		const okArea = (area || '').endsWith('Z') && (area || '').length > 30;
		if (!okPct || !okMarker || !okArea) { console.log('  ✗ populated assertions failed'); failed = true; }
		await page.screenshot({ path: 'scripts/.bcw-34.png' });
		await page.close();
	}

	// ── Scenario C: graceful empty on 404 ───────────────────────────────────
	{
		const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
		await boot(page, { intercept: undefined });
		await page.route('**/api/pump/curve**', (route) =>
			route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'no_curve' }) }),
		);
		await page.evaluate((c) => window.postMessage({ type: 'widget:config', config: c }, location.origin), cfg);
		await page.waitForSelector('.bcw-card.is-empty', { timeout: 9000 }).catch(() => {});
		const isEmpty = await page.locator('.bcw-card.is-empty').count();
		const msg = await page.locator('.bcw-empty-msg').textContent().catch(() => '');
		console.log(`C/404   → is-empty=${isEmpty} msg="${(msg || '').slice(0, 48)}…"`);
		if (!isEmpty) failed = true;
		await page.close();
	}

	await browser.close();
	console.log(failed ? '\n❌ FAIL' : '\n✅ PASS — bonding-curve widget verified end-to-end');
	process.exit(failed ? 1 : 0);
})();
