// Verify the a11y floor on the pages that were failing, restarting the dev
// server whenever this loaded box OOM-kills it mid-sweep.
import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { spawn } from 'node:child_process';

const PORT = 3311;
const BASE = `http://localhost:${PORT}`;
const PAGES = process.argv.slice(2);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function up() {
	try {
		const res = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(3000) });
		return res.ok;
	} catch {
		return false;
	}
}

async function ensureServer() {
	if (await up()) return;
	spawn('npx', ['vite', '--port', String(PORT)], { detached: true, stdio: 'ignore' }).unref();
	for (let i = 0; i < 60; i++) {
		await sleep(3000);
		if (await up()) return;
	}
	throw new Error('dev server would not start');
}

const browser = await chromium.launch();
const results = [];
for (const path of PAGES) {
	let done = false;
	for (let attempt = 1; attempt <= 3 && !done; attempt++) {
		await ensureServer();
		const ctx = await browser.newContext();
		const page = await ctx.newPage();
		try {
			await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
			await page.waitForTimeout(700);
			const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
			console.log(`${path}: ${violations.length ? violations.map((v) => `${v.id}(${v.nodes.length})`).join(', ') : 'clean'}`);
			for (const v of violations) {
				for (const n of v.nodes.slice(0, 3)) {
					console.log(`    ${v.id} :: ${n.target.join(' ')}`);
					console.log(`      ${(n.failureSummary || '').replace(/\n/g, ' ').slice(0, 220)}`);
				}
			}
			results.push({ path, violations: violations.length });
			done = true;
		} catch (err) {
			if (attempt === 3) {
				console.log(`${path}: ERROR ${err.message.split('\n')[0]}`);
				results.push({ path, violations: -1 });
			}
		} finally {
			await ctx.close();
		}
	}
}
await browser.close();
const bad = results.filter((r) => r.violations !== 0);
console.log(`\n${results.length - bad.length}/${results.length} clean` + (bad.length ? `; still failing: ${bad.map((b) => b.path).join(', ')}` : ''));
