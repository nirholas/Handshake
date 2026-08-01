#!/usr/bin/env node
/**
 * Browser verification for /economy-lab (the Runway Lab).
 *
 * Loads the page against a running server, asserts the live seed rendered, then
 * drives the real controls and asserts the projection responds: a starved rail
 * must recover when the fee wallet is funded, and the apply panel must emit a
 * command only for knobs that actually differ from live.
 *
 * Fails on ANY console error or page error, because a chart that silently
 * throws still looks like a chart.
 *
 *   node scripts/verify-economy-lab.mjs [baseUrl]     # default http://localhost:3000
 *
 * Screenshots land in reports/economy-lab/ (gitignored) for a visual check.
 */

import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const BASE = process.argv[2] || process.env.BASE_URL || 'http://localhost:3000';
const OUT = resolve(process.cwd(), 'reports/economy-lab');

const problems = [];
const ok = (label) => console.log(`  ok    ${label}`);
const bad = (label, detail) => {
	problems.push(`${label}${detail ? `: ${detail}` : ''}`);
	console.log(`  FAIL  ${label}${detail ? ` (${detail})` : ''}`);
};

function assert(cond, label, detail) {
	if (cond) ok(label);
	else bad(label, detail);
}

const run = async () => {
	mkdirSync(OUT, { recursive: true });
	const browser = await chromium.launch();
	const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

	const consoleErrors = [];
	page.on('console', (m) => {
		if (m.type() === 'error') consoleErrors.push(m.text());
	});
	page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

	console.log(`\n/economy-lab against ${BASE}\n`);
	const res = await page.goto(`${BASE}/economy-lab`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
	assert(res?.status() === 200, 'page returns 200', `got ${res?.status()}`);

	// The verdict banner leaves the loading state only once the live seed lands.
	await page.waitForFunction(
		() => document.getElementById('el-verdict')?.dataset.state !== 'loading',
		null,
		{ timeout: 90_000 },
	).catch(() => {});

	const state = await page.getAttribute('#el-verdict', 'data-state');
	assert(['healthy', 'throttled', 'starved'].includes(state), 'live seed resolved a verdict', `state=${state}`);

	const statCount = await page.locator('#el-stats .el-stat').count();
	assert(statCount === 6, 'live state panel rendered six readings', `got ${statCount}`);

	const skeletons = await page.locator('#el-stats .el-skeleton').count();
	assert(skeletons === 0, 'skeletons were replaced by real values');

	const kpiCount = await page.locator('#el-kpis .el-kpi').count();
	assert(kpiCount === 6, 'projection KPIs rendered', `got ${kpiCount}`);

	const drew = await page.evaluate(() => {
		const c = document.getElementById('el-chart');
		const ctx = c.getContext('2d');
		const d = ctx.getImageData(0, 0, c.width, c.height).data;
		for (let i = 3; i < d.length; i += 4) if (d[i] !== 0) return true;
		return false;
	});
	assert(drew, 'chart painted pixels');

	const leverCount = await page.locator('#el-levers .el-lever').count();
	assert(leverCount === 3, 'three levers solved', `got ${leverCount}`);

	// Untouched, the apply panel must offer nothing: every knob matches live.
	const applyEmpty = await page.locator('#el-apply .el-empty').count();
	assert(applyEmpty === 1, 'no command offered while the config matches live');

	assert(await page.locator('#el-reset').isDisabled(), 'reset is disabled until something changes');

	await page.screenshot({ path: `${OUT}/01-live.png`, fullPage: true });

	// Drive a real change: widen the heartbeat and confirm the command appears.
	await page.evaluate(() => {
		const el = document.getElementById('el-heartbeat');
		el.value = String(Number(el.max));
		el.dispatchEvent(new Event('input', { bubbles: true }));
	});
	await page.waitForTimeout(250);
	const cmd = await page.locator('#el-apply .el-cmd').textContent().catch(() => '');
	assert(/X402_WALLET_FEE_MIN_BUDGET_LAMPORTS=/.test(cmd || ''), 'heartbeat change emits its env var');
	assert(/--update-env-vars/.test(cmd || ''), 'command uses the merging flag');
	assert(!/--set-env-vars/.test(cmd || ''), 'command never uses the replacing flag');
	assert(!(await page.locator('#el-reset').isDisabled()), 'reset enables once a knob is dirty');

	// Funding must move the projection: a rail limited by its floor recovers.
	const before = await page.locator('#el-kpis .el-kpi').first().locator('.el-kpi-value').textContent();
	await page.evaluate(() => {
		const el = document.getElementById('el-balance');
		el.value = String(Number(el.max));
		el.dispatchEvent(new Event('input', { bubbles: true }));
	});
	await page.waitForTimeout(250);
	const after = await page.locator('#el-kpis .el-kpi').first().locator('.el-kpi-value').textContent();
	const n = (s) => Number(String(s).replace(/[^0-9]/g, '')) || 0;
	assert(n(after) > n(before), 'funding the wallet raises projected throughput', `${before} -> ${after}`);

	await page.screenshot({ path: `${OUT}/02-funded.png`, fullPage: true });

	// Reset restores every knob and clears the command.
	await page.click('#el-reset');
	await page.waitForTimeout(250);
	assert((await page.locator('#el-apply .el-empty').count()) === 1, 'reset clears the pending command');

	// Tooltips: keyboard focus alone must open one, and Escape must close it.
	await page.locator('.el-help').first().focus();
	await page.waitForTimeout(150);
	assert(await page.locator('#el-tip').isVisible(), 'tooltip opens on keyboard focus');
	await page.keyboard.press('Escape');
	await page.waitForTimeout(150);
	assert(!(await page.locator('#el-tip').isVisible()), 'Escape closes the tooltip');

	// Narrow viewport: the page must never scroll horizontally.
	await page.setViewportSize({ width: 360, height: 900 });
	await page.waitForTimeout(400);
	const overflow = await page.evaluate(() =>
		document.documentElement.scrollWidth - document.documentElement.clientWidth);
	assert(overflow <= 1, 'no horizontal overflow at 360px', `${overflow}px`);
	await page.screenshot({ path: `${OUT}/03-mobile.png`, fullPage: true });

	assert(consoleErrors.length === 0, 'no console or page errors', consoleErrors.slice(0, 3).join(' | '));

	await browser.close();

	console.log(`\nscreenshots: ${OUT}`);
	if (problems.length) {
		console.error(`\n${problems.length} check(s) failed:\n${problems.map((p) => `  - ${p}`).join('\n')}\n`);
		process.exit(1);
	}
	console.log('\nall checks passed\n');
};

run().catch((err) => {
	console.error(`verification could not run: ${err.message}`);
	process.exit(1);
});
