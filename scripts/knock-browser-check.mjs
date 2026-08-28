// Real-browser verification of the two Knock pages, then a full cleanup.
import { readFileSync } from 'node:fs';
for (const f of ['.env.local', '.env']) {
	try {
		for (const line of readFileSync(f, 'utf8').split('\n')) {
			const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
			if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
		}
	} catch {}
}
const { neon } = await import('@neondatabase/serverless');
const { chromium } = await import('playwright');
const sql = neon(process.env.DATABASE_URL);

const BASE = 'http://localhost:3077';
const USER = 'ab2aabd2-39f7-493b-8191-c9f174af62ab';
const HANDLE = 'qa-knock-probe';

const readUsername = (await sql`select username from users where id = ${USER}`)[0]?.username ?? null;
// A previous aborted run may have left the probe handle behind; never 'restore' to it.
const priorUsername = readUsername === HANDLE ? null : readUsername;
await sql`update users set username = ${HANDLE} where id = ${USER}`;
await sql`
	insert into knock_doors (user_id, open, price_atomics, headline, greeting, listed, daily_cap, max_chars)
	values (${USER}, true, 0, 'QA probe door', 'Ask me anything while this probe runs.', true, 25, 400)
	on conflict (user_id) do update set open = true, price_atomics = 0, listed = true,
		headline = 'QA probe door', greeting = 'Ask me anything while this probe runs.', max_chars = 400
`;

const browser = await chromium.launch();
const problems = [];
const seen = [];
try {

async function visit(path, width = 1440) {
	const page = await browser.newPage({ viewport: { width, height: 900 } });
	page.on('console', (m) => {
		if (m.type() === 'error' || m.type() === 'warning') problems.push(`[${path} ${width}px] console.${m.type()}: ${m.text()}`);
	});
	page.on('pageerror', (e) => problems.push(`[${path} ${width}px] pageerror: ${e.message}`));
	page.on('requestfailed', (r) => {
		const u = r.url();
		if (u.includes('/api/')) problems.push(`[${path}] request failed: ${u} ${r.failure()?.errorText}`);
	});
	await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
	return page;
}

// 1. The hub, signed out.
{
	const page = await visit('/knock');
	await page.waitForSelector('#directory', { state: 'visible', timeout: 25000 });
	const signedOut = await page.isVisible('#signed-out');
	const dirVisible = await page.isVisible('#directory');
	const cards = await page.locator('.door-card').count();
	const probeCard = await page.locator(`a[href="/knock/${HANDLE}"]`).count();
	seen.push({ page: '/knock', signedOutCta: signedOut, directoryVisible: dirVisible, cards, probeListed: probeCard === 1 });
	await page.screenshot({ path: 'knock-hub.png', fullPage: true });
	await page.close();
}

// 2. The public door, desktop.
{
	const page = await visit(`/knock/${HANDLE}`);
	await page.waitForSelector('#door-card:not([hidden])', { timeout: 20000 });
	const price = await page.textContent('#price-badge');
	const greeting = await page.textContent('#greeting');
	const counter0 = await page.textContent('#counter');
	const submitLabel = await page.textContent('#submit');

	// Client-side guard.
	await page.fill('#from', 'Playwright');
	await page.fill('#message', 'hi');
	await page.click('#submit');
	await page.waitForSelector('#form-error:not([hidden])', { timeout: 8000 });
	const shortError = (await page.textContent('#form-error')).trim();

	// Counter tracks the door's own limit.
	await page.fill('#message', 'x'.repeat(50));
	const counter50 = await page.textContent('#counter');

	// A real knock, end to end through the browser.
	await page.fill('#subject', 'Checking the door renders');
	await page.fill('#message', 'This message was sent by a real browser against the real handler.');
	await page.click('#submit');
	await page.waitForSelector('#sent:not([hidden])', { timeout: 20000 });
	const sentLine = (await page.textContent('#sent-line')).trim();
	const receipt = (await page.textContent('#receipt-url')).trim();

	// The receipt readback.
	await page.click('#check-reply');
	await page.waitForSelector('#reply-box:not([hidden])', { timeout: 15000 });
	const replyState = (await page.textContent('#reply-box')).trim();

	// The agent panel renders real snippets.
	await page.click('#agent-panel summary');
	const endpoint = (await page.textContent('#agent-endpoint')).trim();
	const curl = (await page.textContent('#curl-snippet')).trim();

	seen.push({
		page: `/knock/${HANDLE}`, price, greeting, counter0, counter50, submitLabel,
		shortError, sentLine, receiptLooksRight: /token=/.test(receipt), replyState,
		endpoint, curlMentionsSend: curl.includes('/api/knock/send'),
	});
	await page.screenshot({ path: 'knock-door.png', fullPage: true });
	await page.close();
}

// 3. Priced door: the page must quote the price and offer the wallet path.
{
	await sql`update knock_doors set price_atomics = 50000, pay_to_solana = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump' where user_id = ${USER}`;
	const page = await visit(`/knock/${HANDLE}`, 390);
	await page.waitForSelector('#door-card:not([hidden])', { timeout: 20000 });
	const price = await page.textContent('#price-badge');
	const note = (await page.textContent('#price-note')).trim();
	const submitLabel = (await page.textContent('#submit')).trim();
	const endpoint = (await page.textContent('#agent-endpoint')).trim();
	const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
	seen.push({ page: 'priced door @390px', price, note, submitLabel, endpoint, horizontalOverflow: overflow });
	await page.screenshot({ path: 'knock-door-mobile.png', fullPage: true });
	await page.close();
}

// 4. A handle nobody has a door for.
{
	const page = await visit('/knock/definitely-not-a-real-handle');
	await page.waitForSelector('#not-found:not([hidden])', { timeout: 20000 });
	const msg = (await page.textContent('#not-found [data-msg]')).trim();
	seen.push({ page: '/knock/<unknown>', emptyState: msg });
	await page.close();
}

await browser.close();
} catch (err) {
	problems.push(`FATAL: ${err.message}`);
	try { await browser.close(); } catch {}
}

console.log(JSON.stringify(seen, null, 1));
console.log('\nCONSOLE PROBLEMS:', problems.length ? `\n  ${problems.join('\n  ')}` : 'none');

await sql`delete from knock_messages where recipient_user_id = ${USER}`;
await sql`delete from companion_events where user_id = ${USER} and source_kind = 'knock'`;
await sql`delete from user_notifications where user_id = ${USER} and type = 'knock_received'`;
await sql`delete from knock_doors where user_id = ${USER}`;
await sql`update users set username = ${priorUsername} where id = ${USER}`;
console.log('\ncleanup:', {
	doors: (await sql`select count(*)::int c from knock_doors`)[0].c,
	knocks: (await sql`select count(*)::int c from knock_messages`)[0].c,
	username: (await sql`select username from users where id = ${USER}`)[0].username,
});
