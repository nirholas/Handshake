import { chromium } from 'playwright';

const browser = await chromium.launch({
	args: [
		'--use-gl=swiftshader',
		'--enable-unsafe-swiftshader',
		'--no-sandbox',
		'--disable-dev-shm-usage',
		'--disable-gpu-sandbox',
	],
});

const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();
await page.goto('http://localhost:3000/app-next', { waitUntil: 'load' });

await page.waitForFunction(() => !!document.getElementById('nxt-deploy-btn'), { timeout: 5000 });

// Reveal both un-deployed surfaces.
await page.evaluate(() => {
	const src = document.getElementById('deploy-onchain-btn');
	src.setAttribute('href', '/deploy?agent=demo-agent');
	src.hidden = false;
});
await page.waitForTimeout(300);
await page.screenshot({ path: 'scratch/app-next-deploy-undeployed.png', fullPage: false });
console.log('saved scratch/app-next-deploy-undeployed.png');

// Open share popover.
await page.click('#nxt-share-btn');
await page.waitForTimeout(400);
await page.screenshot({ path: 'scratch/app-next-deploy-share.png', fullPage: false });
console.log('saved scratch/app-next-deploy-share.png');

// Now flip to deployed.
await page.click('#nxt-share-close');
await page.evaluate(() => {
	const src = document.getElementById('deploy-onchain-btn');
	src.classList.add('is-deployed');
	src.setAttribute('href', 'https://basescan.org/token/0xabc');
	src.setAttribute('target', '_blank');
	src.querySelector('[data-state-label]').textContent = 'Deployed ✓ Base';
});
await page.waitForTimeout(300);
await page.screenshot({ path: 'scratch/app-next-deploy-deployed.png', fullPage: false });
console.log('saved scratch/app-next-deploy-deployed.png');

await browser.close();
