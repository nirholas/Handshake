import puppeteer from 'puppeteer';

const browser = await puppeteer.launch({
	headless: 'new',
	args: ['--no-sandbox', '--disable-setuid-sandbox'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 1080 });

const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (msg) => {
	if (msg.type() === 'error') {
		const t = msg.text();
		// Suppress noisy network errors from production proxy (auth-required endpoints)
		if (/Failed to load|net::ERR_/.test(t)) return;
		errors.push(`console.error: ${t}`);
	}
});

await page.goto('http://localhost:3000/widgets/', { waitUntil: 'domcontentloaded', timeout: 30000 });

await page.waitForFunction(
	() => document.querySelectorAll('#gallery-grid .showcase:not(.showcase-skeleton)').length >= 8,
	{ timeout: 15000 },
);

const summary = await page.evaluate(() => {
	const cards = [...document.querySelectorAll('#gallery-grid .showcase:not(.showcase-skeleton)')];
	return {
		count: cards.length,
		types: cards.map((c) => c.dataset.type),
		tabs: document.querySelectorAll('.frame-tabs .frame-tab').length,
		customize: document.querySelectorAll('.customize').length,
		splitBtn: document.querySelectorAll('.split-btn').length,
	};
});
console.log(JSON.stringify(summary, null, 2));

// Live test: change mint on kol-trades and verify snippet updates
const result = await page.evaluate(() => {
	const card = document.querySelector('.showcase[data-type="kol-trades"]');
	if (!card) return { error: 'no kol-trades card' };
	card.querySelector('.customize > summary').click();
	const mintInput = card.querySelector('.knob-row input[type="text"]');
	mintInput.value = 'NEWMINTaddressABC';
	mintInput.dispatchEvent(new Event('input', { bubbles: true }));
	const snippet = card.querySelector('.snippet code').textContent;

	// Switch to JSX
	const items = card.querySelectorAll('.split-btn-menu-item');
	items[1].click();
	const jsxSnippet = card.querySelector('.snippet code').textContent;

	// Switch to URL
	items[2].click();
	const urlSnippet = card.querySelector('.snippet code').textContent;

	return {
		iframeSnippetHasMint: snippet.includes('NEWMINTaddressABC'),
		jsxStartsWithIframe: jsxSnippet.startsWith('<iframe'),
		jsxHasStyleObject: jsxSnippet.includes('style={{'),
		urlIsShareUrl: urlSnippet.startsWith('http') && urlSnippet.includes('NEWMINTaddressABC'),
	};
});
console.log('customize+format tests:', JSON.stringify(result, null, 2));

// Test accent color change adds &accent= to URL
const accentResult = await page.evaluate(() => {
	const card = document.querySelector('.showcase[data-type="turntable"]');
	card.querySelector('.customize > summary').click();
	const colorInput = card.querySelector('.knob-row input[type="color"]');
	colorInput.value = '#ff0080';
	colorInput.dispatchEvent(new Event('input', { bubbles: true }));
	return card.querySelector('.snippet code').textContent;
});
console.log('turntable snippet has accent param:', accentResult.includes('accent='));

console.log('errors:', errors.length === 0 ? 'none' : errors.join('\n  '));

await page.screenshot({ path: '/tmp/widgets-gallery.png', fullPage: false });
console.log('screenshot saved');

await browser.close();
