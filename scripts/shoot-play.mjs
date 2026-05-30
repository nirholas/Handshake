// Self-contained: boot Vite as a child, screenshot the /play lobby, an in-world
// shot (entering a coin), and a mobile lobby shot. Logs each step + any console
// errors to /tmp/shoot.txt, then tears down. Throwaway.
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { setTimeout as sleep } from 'node:timers/promises';
import { appendFileSync, writeFileSync } from 'node:fs';

writeFileSync('/tmp/shoot.txt', '');
const log = (m) => appendFileSync('/tmp/shoot.txt', m + '\n');

const vite = spawn('node_modules/.bin/vite', ['--port', '4400', '--strictPort'], {
	cwd: process.cwd(),
	stdio: ['ignore', 'pipe', 'pipe'],
});
let booted = false;
vite.stdout.on('data', (d) => { if (/4400|ready in/i.test(String(d))) booted = true; });
vite.stderr.on('data', (d) => log('vite-err: ' + String(d).trim()));

log('waiting for vite');
for (let i = 0; i < 60 && !booted; i++) await sleep(500);
log('booted=' + booted);
if (!booted) { vite.kill('SIGKILL'); process.exit(1); }
await sleep(1200);

const BASE = 'http://localhost:4400';
const errors = [];
const browser = await chromium.launch({
	args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
});

async function shoot(label, { mobile = false, deepLink = '', enterCoin = false } = {}) {
	const page = await browser.newPage({
		viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
		deviceScaleFactor: 2,
	});
	page.on('console', (m) => { if (m.type() === 'error') errors.push(`[${label}] console: ` + m.text()); });
	page.on('pageerror', (e) => errors.push(`[${label}] pageerror: ` + e.message));
	try {
		log(`goto ${label}`);
		await page.goto(`${BASE}/play${deepLink}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
		// Wait for the lobby to paint real coin cards (skeletons resolve to cards).
		await page.waitForSelector('.cc-card:not(.cc-skeleton)', { timeout: 20000 }).catch(() => log(`${label}: no real card`));
		await sleep(2500);
		if (enterCoin) {
			const card = await page.$('.cc-card:not(.cc-skeleton)');
			if (card) { await card.click(); log(`${label}: clicked coin`); await sleep(9000); }
			else errors.push(`[${label}] no coin card to enter`);
		}
		await page.screenshot({ path: `/tmp/play-${label}.png` });
		log(`${label}: shot saved`);
	} catch (e) { errors.push(`[${label}] nav: ` + e.message); }
	await page.close();
}

await shoot('lobby');
await shoot('world', { enterCoin: true });
await shoot('mobile', { mobile: true });

log('ERRORS: ' + (errors.length ? '\n' + errors.join('\n') : 'none'));
await browser.close();
vite.kill('SIGKILL');
log('done');
process.exit(0);
