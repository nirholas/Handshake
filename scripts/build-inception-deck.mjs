#!/usr/bin/env node
/**
 * Render the NVIDIA Inception Capital Connect deck to PDF.
 *
 * The portal accepts a PDF of 15 slides or fewer, under 5MB. This renders
 * docs/fundraising/three-ws-inception-deck.html at exactly 1280x720 per slide
 * (16:9) and fails loudly if either limit is broken, so a bad deck never
 * reaches the upload form.
 */
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { statSync } from 'node:fs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(root, 'docs/fundraising/three-ws-inception-deck.html');
const output = resolve(root, 'docs/fundraising/three-ws-inception-deck.pdf');

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_SLIDES = 15;

const browser = await chromium.launch();
try {
	const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
	await page.goto(`file://${source}`, { waitUntil: 'networkidle' });

	const slides = await page.locator('section.slide').count();
	if (slides > MAX_SLIDES) {
		throw new Error(`deck has ${slides} slides; the portal allows ${MAX_SLIDES}`);
	}

	const overflowing = await page.evaluate(() =>
		Array.from(document.querySelectorAll('section.slide'))
			.map((el, i) => ({ slide: i + 1, over: el.scrollHeight - el.clientHeight }))
			.filter((s) => s.over > 2),
	);
	if (overflowing.length) {
		const detail = overflowing.map((s) => `slide ${s.slide} overflows by ${s.over}px`).join('; ');
		throw new Error(`content does not fit its slide: ${detail}`);
	}

	await page.pdf({
		path: output,
		width: '1280px',
		height: '720px',
		printBackground: true,
		margin: { top: '0', right: '0', bottom: '0', left: '0' },
	});
} finally {
	await browser.close();
}

const bytes = statSync(output).size;
if (bytes > MAX_BYTES) {
	throw new Error(`deck is ${(bytes / 1024 / 1024).toFixed(2)}MB; the portal allows 5MB`);
}
console.log(`deck: ${output} (${(bytes / 1024).toFixed(0)} KB)`);
