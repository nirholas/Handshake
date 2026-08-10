// Browser check for the /go bounty board after routing its API calls through
// apiFetch (CSRF). Signs in as a real account, posts a bounty, submits proof on
// it from the same session, toggles a like, and fails on any console error.
//
// Usage:
//   QA_EMAIL=... QA_PASSWORD=... QA_BASE=http://localhost:3199 \
//     node scripts/qa-go-bounty-browser.mjs

import { chromium } from 'playwright';

const BASE = process.env.QA_BASE || 'http://localhost:3199';
const EMAIL = process.env.QA_EMAIL;
const PASSWORD = process.env.QA_PASSWORD;
if (!EMAIL || !PASSWORD) {
	console.error('QA_EMAIL and QA_PASSWORD are required');
	process.exit(2);
}

const browser = await chromium.launch();
const page = await browser.newPage();
const consoleErrors = [];
// Vite's dev-server HMR socket cannot reach a forwarded Codespaces port; that
// noise is the harness, not the page.
const IGNORE = /\[vite\]|WebSocket|walletconnect|privy/i;
page.on('console', (m) => {
	if (m.type() === 'error' && !IGNORE.test(m.text())) consoleErrors.push(m.text());
});
page.on('pageerror', (e) => {
	if (!IGNORE.test(e.message)) consoleErrors.push('pageerror: ' + e.message);
});

const failures = [];
function check(label, ok, detail = '') {
	console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ' :: ' + detail : ''}`);
	if (!ok) failures.push(label);
}

await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.fill('#email', EMAIL);
await page.fill('#password', PASSWORD);
await page.click('form button[type="submit"]');
await page.waitForURL((u) => !/\/login/.test(u.pathname), { timeout: 45_000 });
check('signed in', !/\/login/.test(new URL(page.url()).pathname), page.url());

await page.goto(`${BASE}/go`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#create-btn', { timeout: 20_000 });
// #create-btn is static markup, so wait for the chip loadUser() reveals before
// asserting on it.
await page.waitForSelector('#user-btn:visible', { timeout: 20_000 }).catch(() => {});
check(
	'user chip shows the signed-in display name',
	(await page.textContent('#user-btn')) === 'qa-poster',
	await page.textContent('#user-btn'),
);

const posts = [];
page.on('response', (r) => {
	if (r.request().method() === 'POST' && r.url().includes('/api/bounties'))
		posts.push(`${r.status()} ${new URL(r.url()).pathname}`);
});

const title = `QA browser bounty ${Date.now()}`;
await page.click('#create-btn');
await page.fill('#c-title', title);
await page.fill('#c-desc', 'Posted by scripts/qa-go-bounty-browser.mjs');
await page.fill('#c-sol', '0.01');
await page.click('#create-submit');
await page
	.waitForFunction(
		() => {
			const err = document.getElementById('create-error');
			const modal = document.getElementById('create-modal');
			return (
				(err && err.style.display !== 'none' && err.textContent.trim()) ||
				(modal && !modal.classList.contains('open'))
			);
		},
		{ timeout: 30_000 },
	)
	.catch(() => {});
const createErrVisible = await page.isVisible('#create-error').catch(() => false);
const createErr = createErrVisible ? (await page.textContent('#create-error')) || '' : '';
check('bounty POST accepted', posts.some((p) => p.startsWith('201')), posts.join(', '));
check('create form shows no error', !createErrVisible, createErr.trim());

await page.waitForTimeout(2000);
const listed = await page.locator(`text=${title}`).count();
check('new bounty rendered in the feed', listed > 0, `${listed} match(es)`);

// Submit proof on the bounty just posted, then like it: both are CSRF-gated
// POSTs that must now carry a token.
const submitBtn = page.locator(`[data-action="submit"][data-title="${title}"]`).first();
if (await submitBtn.count()) {
	await submitBtn.click();
	await page.fill('#s-content', 'QA browser proof');
	await page.click('#submit-proof-btn');
	await page.waitForTimeout(3000);
	check('proof POST accepted', posts.some((p) => p.includes('/submissions') && p.startsWith('201')), posts.join(', '));
} else {
	check('proof POST accepted', false, 'no submit button on the new card');
}

check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

await page.screenshot({ path: process.env.QA_SHOT || '/tmp/qa-go.png', fullPage: false });
await browser.close();

if (failures.length) {
	console.error('FAILURES: ' + failures.join(', '));
	process.exit(1);
}
console.log('all checks passed');
