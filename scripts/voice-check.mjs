// Drives /voice in a real browser: catalog load, filters, provider pills,
// preview, "use this voice", and a playground synthesis end to end.
import { chromium } from 'playwright';

const BASE = 'http://127.0.0.1:3010';
const out = (...a) => console.log(...a);

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();

const consoleErrors = [];
const failedRequests = [];
page.on('console', (m) => {
	if (m.type() === 'error' || m.type() === 'warning') consoleErrors.push(`${m.type()}: ${m.text()}`);
});
page.on('requestfailed', (r) => failedRequests.push(`${r.method()} ${r.url()} ${r.failure()?.errorText}`));
page.on('response', (r) => {
	if (r.url().includes('/api/tts/') ) out(`  [net] ${r.status()} ${r.request().method()} ${r.url().replace(BASE, '')}`);
});

await page.goto(`${BASE}/voice`, { waitUntil: 'domcontentloaded' });

// 1. Catalog loads and the grid fills.
await page.waitForSelector('.vb-card:not(.vb-skeleton)', { timeout: 30000 });
const cardCount = await page.locator('.vb-card').count();
const status = await page.locator('#vbStatus').textContent();
out(`1. grid rendered: ${cardCount} cards · status "${status}"`);

// 2. Provider pills reflect availability.
const pills = await page.locator('.vb-pill').evaluateAll((els) =>
	els.map((e) => ({
		label: e.textContent.trim(),
		active: e.classList.contains('active'),
		disabled: e.classList.contains('disabled'),
		title: e.title,
	})),
);
out('2. pills:');
for (const p of pills) out(`   ${p.active ? '*' : ' '} ${p.label}${p.disabled ? '  [disabled: ' + p.title + ']' : ''}`);

// 3. Search narrows the grid.
await page.fill('#vbSearch', 'sonia');
await page.waitForTimeout(600);
const searched = await page.locator('.vb-card').count();
const firstName = await page.locator('.vb-card-name').first().textContent();
out(`3. search "sonia": ${searched} cards, first = ${firstName}`);
await page.fill('#vbSearch', '');
await page.waitForTimeout(600);

// 4. Language filter.
const langOptions = await page.locator('#vbLanguage option').count();
await page.selectOption('#vbLanguage', 'ja');
await page.waitForTimeout(600);
const jaCount = await page.locator('.vb-card').count();
out(`4. language select has ${langOptions} options; "ja" -> ${jaCount} cards`);
await page.selectOption('#vbLanguage', '');
await page.waitForTimeout(600);

// 5. Switch to the Gemini lane.
await page.click('.vb-pill[data-provider="gemini"]');
await page.waitForTimeout(400);
const gemCount = await page.locator('.vb-card').count();
const gemTags = await page.locator('.vb-card').first().locator('.vb-tag').allTextContents();
out(`5. gemini lane: ${gemCount} cards, first card tags = ${JSON.stringify(gemTags)}`);

// 6. Preview a Gemini voice (real synthesis through the local API).
await page.locator('.vb-card').first().locator('[data-act="preview"]').click();
await page.waitForFunction(() => {
	const t = document.querySelector('#vbStatus')?.textContent || '';
	return t.includes('Preview') || t.includes('failed');
}, { timeout: 60000 });
out(`6. preview status: "${await page.locator('#vbStatus').textContent()}"`);

// 7. "Use this voice" pushes it into the playground and reveals the controls.
await page.locator('.vb-card').first().locator('[data-act="use"]').click();
await page.waitForTimeout(500);
const sel = await page.locator('#pgVoice').inputValue();
const modelHidden = await page.locator('#pgModelField').isHidden();
const dirHidden = await page.locator('#pgDirectionRow').isHidden();
const modelOpts = await page.locator('#pgModel option').allTextContents();
out(`7. playground voice = ${sel} · model field ${modelHidden ? 'hidden' : 'shown ' + JSON.stringify(modelOpts)} · direction ${dirHidden ? 'hidden' : 'shown'}`);

// 8. Speed control.
await page.locator('#pgSpeed').fill('1.25');
await page.dispatchEvent('#pgSpeed', 'input');
out(`8. speed label = ${await page.locator('#pgSpeedVal').textContent()}`);

// 9. Speak with a direction.
await page.fill('#pgDirection', 'Bright and quick');
await page.fill('#pgText', 'The voice lab now speaks on every provider.');
await page.click('#pgSpeak');
await page.waitForFunction(() => {
	const t = document.querySelector('#pgHint')?.textContent || '';
	return t.includes('KB') || t.startsWith('Error');
}, { timeout: 60000 });
out(`9. playground hint = "${await page.locator('#pgHint').textContent()}"`);
out(`   audio element src set: ${await page.locator('#pgAudio').evaluate((a) => !!a.src)}`);

// 10. A free lane the model select must hide.
await page.click('.vb-pill[data-provider="edge"]');
await page.waitForTimeout(400);
await page.locator('.vb-card').first().locator('[data-act="use"]').click();
await page.waitForTimeout(400);
out(`10. edge selected -> model field hidden: ${await page.locator('#pgModelField').isHidden()} · direction hidden: ${await page.locator('#pgDirectionRow').isHidden()}`);

// 11. A disabled lane explains itself instead of showing an empty grid.
await page.click('.vb-pill[data-provider="elevenlabs-library"]');
await page.waitForTimeout(1500);
out(`11. library tab empty-state: "${(await page.locator('#vbGrid').textContent()).trim().slice(0, 140)}"`);

// 12. Responsive check.
for (const width of [320, 768, 1440]) {
	await page.setViewportSize({ width, height: 900 });
	await page.waitForTimeout(200);
	const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
	out(`12. ${width}px horizontal overflow: ${overflow}`);
}

out(`\nconsole errors/warnings (${consoleErrors.length}):`);
consoleErrors.slice(0, 12).forEach((e) => out('   ' + e.slice(0, 200)));
out(`failed requests (${failedRequests.length}):`);
failedRequests.slice(0, 8).forEach((e) => out('   ' + e.slice(0, 200)));

await page.setViewportSize({ width: 1440, height: 1200 });
await page.click('.vb-pill[data-provider="all"]');
await page.waitForTimeout(600);
await page.screenshot({ path: '/tmp/claude-1000/-workspaces-three-ws/0501e0b4-b027-43d3-81a7-f9f80ab469a3/scratchpad/voice-page.png', fullPage: false });

await browser.close();
