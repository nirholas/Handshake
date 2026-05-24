import puppeteer from 'puppeteer';

const browser = await puppeteer.launch({
	headless: 'new',
	args: ['--no-sandbox', '--disable-setuid-sandbox'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });

const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (msg) => {
	if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
});

await page.goto('http://localhost:3000/widgets/', { waitUntil: 'networkidle2', timeout: 30000 });

// Wait for gallery cards to render (not skeletons)
await page.waitForFunction(
	() => document.querySelectorAll('#gallery-grid .showcase:not(.showcase-skeleton)').length >= 8,
	{ timeout: 15000 },
);

const cardCount = await page.$$eval(
	'#gallery-grid .showcase:not(.showcase-skeleton)',
	(els) => els.length,
);
console.log('cards rendered:', cardCount);

const types = await page.$$eval('#gallery-grid .showcase:not(.showcase-skeleton)', (els) =>
	els.map((e) => e.dataset.type),
);
console.log('types:', types.join(', '));

// Check tab presence on first card
const tabCount = await page.$$eval('.frame-tabs .frame-tab', (els) => els.length);
console.log('tabs on first cards:', tabCount, '(expected >= 16 = 8 cards × 2 tabs)');

// Check customize panel + split button presence
const customizeCount = await page.$$eval('.customize', (els) => els.length);
const splitBtnCount = await page.$$eval('.split-btn', (els) => els.length);
console.log('customize panels:', customizeCount, '/ split-btn count:', splitBtnCount);

// Click the Code tab on the first kol-trades card; verify iframe hides + code shows
const kolCard = await page.$('.showcase[data-type="kol-trades"]');
if (kolCard) {
	const tabs = await kolCard.$$('.frame-tab');
	const codeTab = tabs[1];
	await codeTab.click();
	await new Promise((r) => setTimeout(r, 100));
	const codeVisible = await kolCard.$eval('.frame-code-panel', (el) => !el.hidden);
	const frameHidden = await kolCard.$eval('.showcase-frame', (el) => el.hidden);
	console.log('after Code tab click: code visible =', codeVisible, ', frame hidden =', frameHidden);
	const codeText = await kolCard.$eval('.frame-code code', (el) => el.textContent);
	console.log('code panel includes EPjFW USDC mint:', codeText.includes('EPjFWdd5'));

	// Switch back to Preview
	await tabs[0].click();
	await new Promise((r) => setTimeout(r, 100));

	// Open customize and change mint
	const summary = await kolCard.$('.customize > summary');
	await summary.click();
	await new Promise((r) => setTimeout(r, 200));
	const mintInput = await kolCard.$('.knob-row input[type="text"]');
	await mintInput.click({ clickCount: 3 });
	await mintInput.type('NEWMINTaddressXYZ');
	await new Promise((r) => setTimeout(r, 500));
	const snippet = await kolCard.$eval('.snippet code', (el) => el.textContent);
	console.log('after mint change, snippet contains NEWMINTaddressXYZ:', snippet.includes('NEWMINTaddressXYZ'));

	// Open format dropdown
	const toggle = await kolCard.$('.split-btn-toggle');
	await toggle.click();
	await new Promise((r) => setTimeout(r, 100));
	const menuVisible = await kolCard.$eval('.split-btn-menu', (el) => !el.hidden);
	console.log('format menu opens on toggle:', menuVisible);

	// Pick JSX
	const items = await kolCard.$$('.split-btn-menu-item');
	await items[1].click();
	await new Promise((r) => setTimeout(r, 100));
	const jsxSnippet = await kolCard.$eval('.snippet code', (el) => el.textContent);
	console.log('JSX snippet starts with <iframe and contains style={{ :', jsxSnippet.startsWith('<iframe') && jsxSnippet.includes('style={{'));
}

// Verify accent color change updates snippet hash
const turntableCard = await page.$('.showcase[data-type="turntable"]');
if (turntableCard) {
	await turntableCard.$eval('.customize > summary', (el) => el.click());
	await new Promise((r) => setTimeout(r, 200));
	const colorInput = await turntableCard.$('.knob-row input[type="color"]');
	await colorInput.evaluate((el) => {
		el.value = '#ff0080';
		el.dispatchEvent(new Event('input', { bubbles: true }));
	});
	await new Promise((r) => setTimeout(r, 200));
	const snip = await turntableCard.$eval('.snippet code', (el) => el.textContent);
	console.log('turntable snippet after accent change includes accent param:', snip.includes('accent='));
}

console.log('errors:', errors.length === 0 ? 'none' : errors.join('\n  '));
await page.screenshot({ path: '/tmp/widgets-gallery.png', fullPage: false });
console.log('screenshot saved to /tmp/widgets-gallery.png');

await browser.close();
