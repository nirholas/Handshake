// Headless verification: /app-next deploy-on-chain wiring.
//
// Boots the page, waits for the viewer, then drives #deploy-onchain-btn (the
// hidden host that /src/app.js owns) and confirms the Next overlay mirrors it
// into:
//   • #nxt-deploy-btn        — pill in the secondary action bar
//   • #nxt-share-deploy      — row in the share popover
//
// Captures console errors as a hard failure.

import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const URL = `${BASE}/app-next`;

const browser = await chromium.launch({
	args: [
		'--use-gl=swiftshader',
		'--enable-unsafe-swiftshader',
		'--no-sandbox',
		'--disable-dev-shm-usage',
		'--disable-gpu-sandbox',
	],
});

const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
const errors = [];
page.on('console', (msg) => {
	if (msg.type() === 'error') errors.push(`[console.error] ${msg.text()}`);
});
page.on('pageerror', (err) => errors.push(`[pageerror] ${err.message}`));

console.log(`→ goto ${URL}`);
await page.goto(URL, { waitUntil: 'load', timeout: 30000 });

// Wait for the overlay's wireDeployMirror() to bind. It runs at DOMContentLoaded,
// then immediately runs sync() once. We confirm the mirror is wired by reading
// initial hidden state.
await page.waitForFunction(() => !!document.getElementById('nxt-deploy-btn'), { timeout: 5000 });
await page.waitForFunction(
	() => !!document.getElementById('deploy-onchain-btn'),
	{ timeout: 5000 },
);

// 1) Both mirrors should be hidden initially (no agent in scope).
const initial = await page.evaluate(() => ({
	srcHidden: document.getElementById('deploy-onchain-btn').hidden,
	pillHidden: document.getElementById('nxt-deploy-btn').hidden,
	rowHidden: document.getElementById('nxt-share-deploy').hidden,
}));
console.log('initial state:', initial);
if (!initial.srcHidden || !initial.pillHidden || !initial.rowHidden) {
	throw new Error('Expected all deploy surfaces hidden before app.js reveals the host.');
}

// 2) Simulate app.js revealing the host with an un-deployed agent.
console.log('→ simulating un-deployed agent in scope');
await page.evaluate(() => {
	const src = document.getElementById('deploy-onchain-btn');
	src.setAttribute('href', '/deploy?agent=test-agent-123');
	src.querySelector('[data-state-label]').textContent = 'Deploy on-chain';
	src.hidden = false;
});

await page.waitForFunction(
	() => document.getElementById('nxt-deploy-btn').hidden === false,
	{ timeout: 2000 },
);

const afterUndeployed = await page.evaluate(() => ({
	pillHidden: document.getElementById('nxt-deploy-btn').hidden,
	pillHref: document.getElementById('nxt-deploy-btn').getAttribute('href'),
	pillLabel: document.getElementById('nxt-deploy-label').textContent.trim(),
	pillIsDeployedClass: document.getElementById('nxt-deploy-btn').classList.contains('is-deployed'),
	rowHidden: document.getElementById('nxt-share-deploy').hidden,
	rowHref: document.getElementById('nxt-share-deploy').getAttribute('href'),
	rowLabel: document.getElementById('nxt-share-deploy-label').textContent.trim(),
	rowSub: document.getElementById('nxt-share-deploy-sub').textContent.trim(),
	dividerHidden: document.getElementById('nxt-share-deploy-divider').hidden,
}));
console.log('after un-deployed state:', afterUndeployed);
if (
	afterUndeployed.pillHidden ||
	afterUndeployed.rowHidden ||
	afterUndeployed.dividerHidden ||
	afterUndeployed.pillHref !== '/deploy?agent=test-agent-123' ||
	afterUndeployed.rowHref !== '/deploy?agent=test-agent-123' ||
	!/Deploy on-chain/i.test(afterUndeployed.pillLabel) ||
	!/Deploy on-chain/i.test(afterUndeployed.rowLabel) ||
	afterUndeployed.pillIsDeployedClass ||
	!/Register/i.test(afterUndeployed.rowSub)
) {
	throw new Error('Mirror did not propagate un-deployed state correctly.');
}

// 3) Simulate the deployed-state update (app.js sets is-deployed + new href).
console.log('→ simulating deployed agent');
await page.evaluate(() => {
	const src = document.getElementById('deploy-onchain-btn');
	src.classList.add('is-deployed');
	src.setAttribute('href', 'https://basescan.org/token/0xabc?a=42');
	src.setAttribute('target', '_blank');
	src.setAttribute('rel', 'noopener');
	src.querySelector('[data-state-label]').textContent = 'Deployed ✓ Base';
});

await page.waitForFunction(
	() =>
		document
			.getElementById('nxt-deploy-btn')
			.classList.contains('is-deployed'),
	{ timeout: 2000 },
);

const afterDeployed = await page.evaluate(() => ({
	pillHref: document.getElementById('nxt-deploy-btn').getAttribute('href'),
	pillTarget: document.getElementById('nxt-deploy-btn').getAttribute('target'),
	pillRel: document.getElementById('nxt-deploy-btn').getAttribute('rel'),
	pillLabel: document.getElementById('nxt-deploy-label').textContent.trim(),
	rowIsDeployedClass: document
		.getElementById('nxt-share-deploy')
		.classList.contains('is-deployed'),
	rowSub: document.getElementById('nxt-share-deploy-sub').textContent.trim(),
}));
console.log('after deployed state:', afterDeployed);
if (
	!/Deployed/i.test(afterDeployed.pillLabel) ||
	afterDeployed.pillHref !== 'https://basescan.org/token/0xabc?a=42' ||
	afterDeployed.pillTarget !== '_blank' ||
	afterDeployed.pillRel !== 'noopener' ||
	!afterDeployed.rowIsDeployedClass ||
	!/live on-chain/i.test(afterDeployed.rowSub)
) {
	throw new Error('Mirror did not propagate deployed state correctly.');
}

// 4) Open the share popover and confirm the row is reachable.
console.log('→ opening share popover');
await page.click('#nxt-share-btn');
const popOpen = await page.evaluate(() => !document.getElementById('nxt-share-popover').hidden);
if (!popOpen) throw new Error('Share popover did not open.');
const rowReachable = await page.evaluate(() => {
	const row = document.getElementById('nxt-share-deploy');
	if (!row || row.hidden) return false;
	const cs = getComputedStyle(row);
	return cs.display !== 'none' && cs.visibility !== 'hidden';
});
if (!rowReachable) throw new Error('Deploy row not reachable inside open share popover.');

console.log(`→ console errors collected: ${errors.length}`);
if (errors.length) {
	for (const e of errors) console.log(' ', e);
	throw new Error(`Page produced ${errors.length} console error(s).`);
}

await browser.close();
console.log('\nOK — /app-next deploy-on-chain wiring verified.');
