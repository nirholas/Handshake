// Drives the REAL copy panel module in a real browser against the REAL local API
// server (localhost:3100), signed in as the QA account. Captures every console
// message so a warning from our own code fails the check.
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const SCRATCH = process.env.SCRATCH;
const API = 'http://localhost:3100';
const VITE = 'http://localhost:3001';
const LEADER_OK = '6287faf3-d41b-43cb-97bb-d305c1ac6e45';   // Crosshair, 249 closes
const LEADER_THIN = '15e98de5-2695-427b-b746-4558a0933a4e'; // Swarm 7, 1 close

const user = readFileSync(`${SCRATCH}/qa-user.txt`, 'utf8').trim();
const pass = readFileSync(`${SCRATCH}/qa-pass.txt`, 'utf8').trim();

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });

// Sign in through the real login endpoint so the panel sees a real session.
// A username-registered account carries a derived email; that is what login takes.
const login = await ctx.request.post(`${API}/api/auth/login`, {
	data: { email: `${user.toLowerCase().replace(/[^a-z0-9_-]/g, '_')}@users.three.ws.local`, password: pass },
});
if (!login.ok()) throw new Error(`login failed: ${login.status()} ${await login.text()}`);

const page = await ctx.newPage();
const problems = [];
page.on('console', (m) => {
	if (m.type() === 'error' || m.type() === 'warning') problems.push(`[${m.type()}] ${m.text()}`);
});
page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));

// A minimal host page served from Vite so the module graph and the real CSS load
// exactly as they do on /trader/:id, with /api pointed at our local server.
await page.route('**/api/**', (route) => {
	const u = new URL(route.request().url());
	route.continue({ url: API + u.pathname + u.search });
});

const host = `${VITE}/trader?probe=1`;
await page.goto(host, { waitUntil: 'domcontentloaded' });

const shot = async (name) => {
	await page.screenshot({ path: `${SCRATCH}/panel-${name}.png` });
	console.log(`  screenshot: panel-${name}.png`);
};

async function mount(leaderId, leaderName) {
	await page.evaluate(async ({ leaderId, leaderName }) => {
		document.body.innerHTML = '<main style="max-width:640px;margin:40px auto;padding:0 20px"><section id="probe"></section></main>';
		const { mountCopyPanel } = await import('/src/copy-panel.js');
		await mountCopyPanel(document.getElementById('probe'), { leaderAgentId: leaderId, leaderName, network: 'mainnet' });
	}, { leaderId, leaderName });
	await page.waitForTimeout(700);
}

console.log('\n1. Form state on an eligible leader (drawdown control present)');
// Stop copying first so the form renders rather than the active summary.
await ctx.request.delete(`${API}/api/copy/subscriptions?id=${process.env.SUB_ID}`, {
	headers: { 'x-csrf-token': (await (await ctx.request.get(`${API}/api/csrf-token`)).json()).token },
});
await mount(LEADER_OK, 'Crosshair');
const ddField = await page.locator('#cp-dd').count();
const ddLabel = await page.locator('label:has(#cp-dd) .cp-label').textContent().catch(() => null);
const ddHint = await page.locator('label:has(#cp-dd) .cp-hint').textContent().catch(() => null);
console.log('  #cp-dd present:', ddField === 1, '| label:', JSON.stringify(ddLabel));
console.log('  hint:', JSON.stringify((ddHint || '').slice(0, 80) + '…'));
await shot('form');

console.log('\n2. Copyable-bar refusal renders as a checklist');
await mount(LEADER_THIN, 'Swarm 7');
await page.fill('#cp-wallet', 'So11111111111111111111111111111111111111112');
page.on('response', async (r) => {
	if (r.url().includes('/api/copy/subscriptions') && r.request().method() === 'POST') {
		console.log('  POST response:', r.status(), (await r.text().catch(() => '')).slice(0, 200));
	}
});
await page.click('#cp-submit');
await page.waitForTimeout(2500);
console.log('  #cp-err text:', JSON.stringify((await page.locator('#cp-err').textContent()).slice(0, 200)));
await page.waitForSelector('.cp-unmet li', { timeout: 8000 });
const items = await page.locator('.cp-unmet li').allTextContents();
const headline = await page.locator('#cp-err strong').textContent();
console.log('  headline:', JSON.stringify(headline));
console.log('  unmet items:', items);
await shot('not-copyable');

console.log('\n3. Auto-paused state after the breaker trips');
// Subscribe with a 1% limit, then run the real guard so the row is genuinely
// auto-paused by the same code the cron runs.
const csrf = async () => (await (await ctx.request.get(`${API}/api/csrf-token`)).json()).token;
const sub = await ctx.request.post(`${API}/api/copy/subscriptions`, {
	headers: { 'x-csrf-token': await csrf() },
	data: {
		leader_agent_id: LEADER_OK, copier_wallet: 'So11111111111111111111111111111111111111112',
		sizing_rule: 'fixed', fixed_sol: 0.05, per_trade_cap_sol: 0.1, daily_budget_sol: 0.2,
		max_drawdown_pct: 1,
	},
});
const subId = (await sub.json()).subscription.id;
console.log('  subscription:', subId, '(1% limit vs the leader\'s real 5.54% drawdown)');
const { activeSubscriptionsByLeader } = await import('/workspaces/three.ws/api/cron/copy-fanout.js');
const stats = {};
await activeSubscriptionsByLeader([LEADER_OK], 'mainnet', stats);
console.log('  fanout guard stats:', stats);

await mount(LEADER_OK, 'Crosshair');
const tripped = await page.locator('.cp-tripped').textContent().catch(() => null);
const tag = await page.locator('h2').textContent();
console.log('  heading:', JSON.stringify(tag.trim()));
console.log('  notice:', JSON.stringify((tripped || '').replace(/\s+/g, ' ').trim().slice(0, 150) + '…'));
await shot('auto-paused');

console.log('\n4. Resume is refused with the real reason, not a dead button');
await page.click('#cp-toggle');
await page.waitForSelector('#cp-toggle-err:not([hidden])', { timeout: 8000 });
console.log('  error shown:', JSON.stringify(await page.locator('#cp-toggle-err').textContent()));
console.log('  button re-enabled:', !(await page.locator('#cp-toggle').isDisabled()));
await shot('resume-refused');

console.log('\nconsole errors/warnings:', problems.length ? problems : 'none');
process.env.SUB_ID_OUT && console.log(subId);
await browser.close();
if (problems.length) process.exitCode = 1;
