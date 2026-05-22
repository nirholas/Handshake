// Headless smoke test for /agent/new?avatar_id=... and /agent/<uuid>/edit.
// Verifies the create-from-avatar flow lands on agent-edit.html and that the
// edit page correctly resolves agentId from the canonical clean URL.
// Run while `npm run dev` is up on port 3000 (override with PORT=3001).
import puppeteer from 'puppeteer';

const PORT = process.env.PORT || '3000';
const BASE = `http://localhost:${PORT}`;
const AVATAR_ID = '89ae91e6-89cb-444e-a83e-368bbfce9388';
const AVATAR_NAME = 'Soldier (three.js)';
const AVATAR_GLB = 'https://pub-2534e921bf9c4314addcd4d8a6e98b7b.r2.dev/u/86985f55-ad3d-4a06-a8c7-056704645dc0/soldier-threejs/mojcl8lp.glb';
const FAKE_EDIT_UUID = '11111111-2222-3333-4444-555555555555';

const browser = await puppeteer.launch({
	executablePath: '/home/codespace/.cache/puppeteer/chrome/linux-148.0.7778.97/chrome-linux64/chrome',
	args: ['--no-sandbox', '--disable-dev-shm-usage'],
	defaultViewport: { width: 1280, height: 800 },
});

const consoleErrors = [];
const apiCalls = [];

function attach(page, label) {
	page.on('console', msg => {
		const t = msg.type();
		if (t === 'error') consoleErrors.push(`[${label}] ${msg.text()}`);
		if (process.env.LOG_ALL) console.log(`[${label} ${t}] ${msg.text()}`);
	});
	page.on('pageerror', err => consoleErrors.push(`[${label}] pageerror: ${err.message}`));
	page.on('request', req => {
		const url = req.url();
		if (url.includes('/api/agents')) apiCalls.push(`[${label}] ${req.method()} ${url.replace(BASE, '')}`);
	});
}

async function close(reason, ok) {
	await browser.close();
	if (!ok) {
		console.error(`\nFAIL: ${reason}`);
		process.exit(1);
	}
	console.log(`\nOK: ${reason}`);
}

// ── Case 1: /agent/new with avatar params → should serve agent-edit.html ──
console.log('Case 1: /agent/new?avatar_id=… → should serve agent-edit.html');
const p1 = await browser.newPage();
attach(p1, 'agent/new');
const url1 = `${BASE}/agent/new?avatar_id=${AVATAR_ID}&avatar_name=${encodeURIComponent(AVATAR_NAME)}&avatar_glb=${encodeURIComponent(AVATAR_GLB)}`;
await p1.goto(url1, { waitUntil: 'domcontentloaded', timeout: 15000 });
const title1 = await p1.title();
const isEditPage = title1.startsWith('Edit Agent');
console.log(`  title: ${title1}`);
console.log(`  is agent-edit.html: ${isEditPage}`);
if (!isEditPage) await close('/agent/new served the wrong page (regressed to agent-home)', false);

// Give the script a moment to run loadAgent() and attempt the POST. We don't
// require it to succeed (no signed-in session in headless) — we only require
// that the create flow was *attempted*, proving avatar params were read.
await new Promise(r => setTimeout(r, 1500));
const sawPost = apiCalls.some(c => c.includes('POST /api/agents'));
console.log(`  /api/agents POST attempted: ${sawPost}`);
console.log(`  api calls: ${apiCalls.join(' | ') || '(none)'}`);
if (!sawPost) await close('agent-edit.js did not POST to /api/agents — avatar params were not consumed', false);

// ── Case 2: /agent/<uuid>/edit → resolver must extract UUID from pathname ──
console.log('\nCase 2: /agent/<uuid>/edit → resolver must extract UUID from pathname');
apiCalls.length = 0;
const p2 = await browser.newPage();
attach(p2, 'agent/edit');
await p2.goto(`${BASE}/agent/${FAKE_EDIT_UUID}/edit`, { waitUntil: 'domcontentloaded', timeout: 15000 });
await new Promise(r => setTimeout(r, 1500));
const sawGet = apiCalls.some(c => c.includes(`GET /api/agents/${FAKE_EDIT_UUID}`));
console.log(`  GET /api/agents/<uuid> attempted: ${sawGet}`);
console.log(`  api calls: ${apiCalls.join(' | ') || '(none)'}`);
if (!sawGet) await close('agent-edit.js did not GET /api/agents/<uuid> — pathname resolver broken', false);

// ── Case 3: console errors check (ignore expected ones) ──
console.log('\nCase 3: console errors');
const ignorable = [
	'SES',
	'lockdown-install',
	'buffer.Buffer',
	'externalized for browser compatibility',
	'401', // expected when signed out
	'Failed to load resource',
	'net::ERR_',
	'login_redirect',
];
const real = consoleErrors.filter(e => !ignorable.some(ig => e.includes(ig)));
if (real.length) {
	console.error('  unexpected console errors:');
	real.forEach(e => console.error(`    - ${e}`));
	await close('console errors detected', false);
}
console.log(`  (${consoleErrors.length} total, all ignorable noise — 401/SES/buffer)`);

await close('routing + resolver verified for both flows', true);
