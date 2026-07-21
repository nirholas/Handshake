#!/usr/bin/env node
/**
 * Render a motion-swap clip as a fixed-camera filmstrip PNG so we can LOOK at
 * the actual pose (lean/bend/fold/drift) instead of trusting clip math.
 *
 *   node scripts/motion-filmstrip.mjs <clip.json> [out.png] [--count=10] [--views=front,side,q]
 *
 * Reuses a Vite dev server on --port (default 3312) so the site's own retarget
 * engine and preview avatar render exactly as in the product.
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const args = process.argv.slice(2);
const flags = Object.fromEntries(
	args.filter((a) => a.startsWith('--')).map((a) => {
		const m = a.match(/^--([^=]+)(?:=(.*))?$/);
		return [m[1], m[2] ?? true];
	}),
);
const positional = args.filter((a) => !a.startsWith('--'));
const CLIP = positional[0];
if (!CLIP) {
	console.error('usage: motion-filmstrip.mjs <clip.json> [out.png]');
	process.exit(1);
}
const OUT = positional[1] || CLIP.replace(/\.json$/, '') + '.filmstrip.png';
const PORT = Number(flags.port) || 3312;
const COUNT = flags.count ? Number(flags.count) : 10;
const VIEWS = (typeof flags.views === 'string' ? flags.views : 'front,side').split(',');

async function listening(port) {
	try {
		return (await fetch(`http://localhost:${port}/scripts/motion-filmstrip-harness.html`)).ok;
	} catch {
		return false;
	}
}
async function ensureServer() {
	if (await listening(PORT)) return null;
	const proc = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
		cwd: ROOT,
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	const deadline = Date.now() + 60_000;
	while (Date.now() < deadline) {
		if (await listening(PORT)) return proc;
		await new Promise((r) => setTimeout(r, 500));
	}
	proc.kill();
	throw new Error('vite did not come up');
}

(async () => {
	const { chromium } = await import('playwright');
	const clipJson = JSON.parse(readFileSync(CLIP, 'utf8'));
	const server = await ensureServer();
	const browser = await chromium.launch({
		args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader'],
	});
	try {
		const page = await browser.newPage({ viewport: { width: 400, height: 500 } });
		page.on('pageerror', (e) => console.warn('  [page]', e.message));
		page.on('console', (m) => m.type() === 'error' && console.warn('  [console]', m.text()));
		await page.goto(`http://localhost:${PORT}/scripts/motion-filmstrip-harness.html`, {
			waitUntil: 'domcontentloaded',
		});
		const boot = await page.evaluate(() => window.__film.ready);
		console.log(`harness ready — ${boot.bones} bones, ${boot.canonical} canonical, height ${boot.height.toFixed(2)}m`);
		const { dataUrl, coverage, duration } = await page.evaluate(
			({ clipJson, count, views }) =>
				window.__film.renderFilmstrip(clipJson, 'debug', { count, views }),
			{ clipJson, count: COUNT, views: VIEWS },
		);
		writeFileSync(OUT, Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64'));
		console.log(`wrote ${OUT} — coverage ${(coverage * 100).toFixed(0)}%, duration ${duration.toFixed(1)}s, ${COUNT}×${VIEWS.length} frames`);
	} finally {
		await browser.close();
		if (server) server.kill();
	}
	process.exit(0);
})();
