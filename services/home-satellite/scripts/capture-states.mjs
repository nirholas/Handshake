#!/usr/bin/env node
/**
 * Drive the satellite view in a real browser and capture every state it can be
 * in, as a picture and as the text the page was actually showing.
 *
 * It is a verification harness, not a test: it opens Chromium against a running
 * three.ws, a running satellite and a running Home Assistant, speaks into the
 * pipeline through Chromium's own microphone, and screenshots what happens. The
 * microphone audio is a real WAV; Chromium plays it into `getUserMedia` with
 * --use-file-for-fake-audio-capture, so the page's capture path, resampler and
 * WebSocket all run exactly as they do for a person.
 *
 *   node scripts/capture-states.mjs \
 *     --base http://127.0.0.1:3000 --satellite-id <uuid> --session <sid cookie> \
 *     --audio /tmp/say.wav --out /tmp/states
 *
 * Every file it writes is named for the state it shows, so a reviewer can line
 * the ten states up against the ten designs without reading this script.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
	const i = args.indexOf(`--${name}`);
	return i === -1 ? fallback : args[i + 1];
};

const BASE = arg('base', 'http://127.0.0.1:3000').replace(/\/+$/, '');
const SATELLITE_ID = arg('satellite-id', '');
const SESSION = arg('session', '');
const AUDIO = arg('audio', '');
const OUT = arg('out', './satellite-states');
const VIDEO = args.includes('--video');

mkdirSync(OUT, { recursive: true });
const log = (...a) => console.error('[capture]', ...a);
const shots = [];

const capture = async (page, name, note) => {
	const file = join(OUT, `${name}.png`);
	await page.screenshot({ path: file, fullPage: false });
	const badge = await page.locator('.hs-badge').first().textContent().catch(() => null);
	const said = await page.locator('.hs-said').first().textContent().catch(() => null);
	const answered = await page.locator('.hs-answered').first().textContent().catch(() => null);
	const status = await page.locator('.hs-live-status').first().textContent().catch(() => null);
	const body = await page.locator('#hs-root').first().innerText().catch(() => null);
	shots.push({ state: name, note, file, badge, said, answered, status, text: (body || '').slice(0, 400) });
	log(`${name}: ${badge || (body || '').split('\n')[0] || ''}`);
};

const main = async () => {
	const browser = await chromium.launch({
		args: [
			'--use-fake-ui-for-media-stream',
			'--use-fake-device-for-media-stream',
			...(AUDIO ? [`--use-file-for-fake-audio-capture=${AUDIO}`] : []),
			'--autoplay-policy=no-user-gesture-required',
			'--enable-features=WebRTC-Audio',
		],
	});
	const context = await browser.newContext({
		viewport: { width: 1280, height: 900 },
		permissions: ['microphone'],
		...(VIDEO ? { recordVideo: { dir: OUT, size: { width: 1280, height: 900 } } } : {}),
	});
	if (SESSION) {
		const url = new URL(BASE);
		await context.addCookies([{ name: 'sid', value: SESSION, domain: url.hostname, path: '/', httpOnly: true, secure: false }]);
	}

	const page = await context.newPage();
	const consoleErrors = [];
	page.on('console', (message) => {
		if (message.type() === 'error') consoleErrors.push(message.text());
	});
	page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

	// 1 and 2: the manage view, where a satellite is paired.
	await page.goto(`${BASE}/smart-home/satellite`, { waitUntil: 'domcontentloaded' });
	await page.waitForSelector('#hs-root [class*="hs-panel"]', { timeout: 30_000 });
	await page.waitForTimeout(1200);
	await capture(page, '01-unpaired', 'the manage view: no satellite paired yet');

	const pairButton = page.getByRole('button', { name: /pairing code/i });
	if (await pairButton.count()) {
		await pairButton.first().click();
		await page.waitForSelector('.hs-code', { timeout: 20_000 }).catch(() => {});
		await page.waitForTimeout(600);
		await capture(page, '02-pairing', 'a single-use pairing code and the exact command to run');
	}

	if (!SATELLITE_ID) {
		log('no --satellite-id, stopping after the manage view');
		writeFileSync(join(OUT, 'states.json'), `${JSON.stringify({ shots, consoleErrors }, null, '\t')}\n`);
		await context.close();
		await browser.close();
		return;
	}

	// 3 to 10: the live view.
	await page.goto(`${BASE}/smart-home/satellite?id=${SATELLITE_ID}`, { waitUntil: 'domcontentloaded' });
	await page.waitForSelector('.hs-badge', { timeout: 30_000 });
	await page.waitForFunction(() => document.querySelector('.hs-badge')?.dataset.state === 'idle', null, { timeout: 30_000 })
		.catch(() => log('did not reach idle; capturing whatever state it is in'));
	await page.waitForTimeout(2500);
	await capture(page, '03-idle', 'paired, Home Assistant connected, waiting');

	// Watch the badge and grab each state the moment it appears. The pipeline
	// moves quickly, so polling from the outside would miss most of them.
	const seen = new Set();
	const watcher = (async () => {
		const deadline = Date.now() + 75_000;
		while (Date.now() < deadline) {
			const state = await page.locator('.hs-badge').first().getAttribute('data-state').catch(() => null);
			if (state && !seen.has(state) && ['wake', 'listening', 'thinking', 'speaking', 'error'].includes(state)) {
				seen.add(state);
				const index = { wake: '04', listening: '05', thinking: '06', speaking: '07', error: '08' }[state];
				await capture(page, `${index}-${state}`, `pipeline state: ${state}`);
			}
			if (seen.has('speaking')) break;
			await page.waitForTimeout(120);
		}
	})();

	await page.getByRole('button', { name: /talk now/i }).click();
	await page.waitForTimeout(4200);
	await page.getByRole('button', { name: /^done$/i }).click().catch(() => {});
	await watcher;
	await page.waitForTimeout(1500);
	await capture(page, '09-after', 'the transcript and the answer, after the run');

	// 10: the satellite goes away. The page has to say so, and has to say the
	// voice assistant is unaffected.
	log('now stop the satellite process to capture the disconnected state');
	await page.waitForTimeout(Number(arg('disconnect-wait', 0)) * 1000);
	const state = await page.locator('.hs-badge').first().getAttribute('data-state').catch(() => null);
	await capture(page, `10-${state || 'offline'}`, 'the satellite is gone; the assistant is not');

	// The display going to sleep is a state too, and the page is written to keep
	// the socket while it does.
	await page.evaluate(() => {
		Object.defineProperty(document, 'visibilityState', { get: () => 'hidden', configurable: true });
		document.dispatchEvent(new Event('visibilitychange'));
	});
	await page.waitForTimeout(700);
	await capture(page, '11-asleep', 'screen resting: the pipeline keeps running');

	writeFileSync(join(OUT, 'states.json'), `${JSON.stringify({ shots, consoleErrors }, null, '\t')}\n`);
	console.log(JSON.stringify({ captured: shots.map((s) => s.state), consoleErrors }, null, '\t'));

	await context.close();
	await browser.close();
};

main().catch((err) => {
	console.error(`[capture] failed: ${err.message}`);
	process.exit(1);
});
