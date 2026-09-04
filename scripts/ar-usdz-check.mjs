#!/usr/bin/env node
/**
 * ar-usdz-check: headless proof that a finished avatar reaches Apple Quick Look.
 *
 * /ar/view is the only surface that hands iOS a real USDZ: <model-viewer> does
 * NOT convert a GLB on its own, so src/ar-view.js downloads the GLB, bakes a
 * USDZ in the page (three.js USDZExporter, via src/usdz-pipeline.js) and sets
 * the result as the viewer's `ios-src`. That bake is the step that silently
 * broke before and left iOS visitors on the plain WebGL viewer, so this script
 * asserts the three things that make Quick Look real:
 *
 *   1. the page loads the avatar and the AR launch button becomes enabled,
 *   2. `ios-src` is set to a live blob URL (not the GLB, not empty),
 *   3. that blob is a non-trivial USDZ (a zip, `usdc`/`usda` entry inside).
 *
 * It also captures a screenshot of the staged avatar per model, which is the
 * "does this read as a person standing there" evidence a report needs.
 *
 * Usage:
 *   node scripts/ar-usdz-check.mjs --avatars=<glb>[,<glb>...] [--slugs=a,b,c]
 *     [--base=https://three.ws] [--out=<dir>]
 *
 * Exit code is 0 only when every avatar produced a valid USDZ.
 */

import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const args = Object.fromEntries(
	process.argv.slice(2)
		.filter((a) => a.startsWith('--'))
		.map((a) => {
			const [k, ...rest] = a.replace(/^--/, '').split('=');
			return [k, rest.length ? rest.join('=') : 'true'];
		}),
);

const BASE = args.base || 'https://three.ws';
const OUT_DIR = path.resolve(args.out || 'prompts/quality-bar/_generated/10');
const AVATARS = String(args.avatars || '').split(',').map((s) => s.trim()).filter(Boolean);
const SLUGS = String(args.slugs || '').split(',').map((s) => s.trim()).filter(Boolean);
// SwiftShader draws the staged model on CPU, so a capture is slow rather than instant.
const SHOT_TIMEOUT = Number(args.shotTimeout || 120_000);
// The bake reads the whole GLB and walks every mesh; a 200k-triangle High-tier
// avatar takes far longer than the viewer's own load.
const BAKE_TIMEOUT = Number(args.bakeTimeout || 180_000);

if (!AVATARS.length) {
	console.error('ar-usdz-check: pass --avatars=<glb url>[,<glb url>...]');
	process.exit(2);
}

/** Read the blob behind an object URL back into the runner as bytes. */
const READ_BLOB = `async (src) => {
	const res = await fetch(src);
	const buf = new Uint8Array(await res.arrayBuffer());
	// Only the header and a window of the central directory are needed to prove
	// the file is a zip carrying a USD payload; shipping megabytes back through
	// the CDP bridge would just be slow.
	return { bytes: buf.length, head: Array.from(buf.slice(0, 4)), text: new TextDecoder('latin1').decode(buf.slice(0, 4096)) };
}`;

async function runAvatar(browser, { glbUrl, slug }) {
	const url = `${BASE}/ar/view?src=${encodeURIComponent(glbUrl)}`;
	const result = {
		slug,
		glbUrl,
		url,
		loaded: false,
		launchEnabled: false,
		iosSrc: null,
		usdz: null,
		valid: false,
		screenshot: null,
		consoleErrors: [],
		pageErrors: [],
		notes: [],
	};

	const context = await browser.newContext({
		viewport: { width: 430, height: 932 }, // iPhone-class portrait: Quick Look's real audience
		deviceScaleFactor: 1,
		locale: 'en-US',
	});
	const page = await context.newPage();
	page.on('console', (msg) => {
		if (msg.type() === 'error') result.consoleErrors.push(msg.text());
	});
	page.on('pageerror', (err) => result.pageErrors.push(String(err?.message || err)));

	try {
		await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
		result.loaded = true;

		// The page's own readiness signal: generateUsdz() enables the launch button
		// only after the bake resolved, so waiting on it beats a blind sleep.
		await page.waitForFunction(() => {
			const b = document.getElementById('ar-launch-btn');
			return !!b && !b.disabled;
		}, null, { timeout: BAKE_TIMEOUT }).catch(() => {
			result.notes.push('AR launch button never enabled within the bake timeout');
		});
		result.launchEnabled = await page.evaluate(() => {
			const b = document.getElementById('ar-launch-btn');
			return !!b && !b.disabled;
		});

		result.iosSrc = await page.evaluate(() => document.getElementById('ar-viewer')?.getAttribute('ios-src') || null);
		if (result.iosSrc && result.iosSrc.startsWith('blob:')) {
			const probe = await page.evaluate(READ_BLOB, result.iosSrc);
			// A USDZ is an uncompressed zip: "PK\3\4" magic, with a .usdc or .usda
			// entry named in the local file header right after it.
			const isZip = probe.head[0] === 0x50 && probe.head[1] === 0x4b;
			const hasUsd = /\.usd[ac]?/.test(probe.text);
			result.usdz = { bytes: probe.bytes, isZip, hasUsd };
			result.valid = isZip && hasUsd && probe.bytes > 1024;
		} else if (result.iosSrc) {
			result.notes.push(`ios-src is not a baked blob: ${result.iosSrc.slice(0, 120)}`);
		} else {
			result.notes.push('ios-src was never set, so iOS would fall back to the plain WebGL viewer');
		}

		// Let the viewer settle on a framed pose before the capture.
		await page.waitForTimeout(2500);
		const shot = path.join(OUT_DIR, `ar-usdz-${slug}.png`);
		await page.screenshot({ path: shot, timeout: SHOT_TIMEOUT });
		result.screenshot = shot;
	} catch (err) {
		result.notes.push(`run failed: ${err?.message || err}`);
	} finally {
		await context.close();
	}
	return result;
}

function report(results) {
	const lines = ['', 'avatar                     launch  ios-src   usdz bytes   verdict'];
	for (const r of results) {
		const kind = r.iosSrc ? (r.iosSrc.startsWith('blob:') ? 'blob' : 'other') : 'none';
		lines.push(
			`${r.slug.padEnd(26)} ${(r.launchEnabled ? 'yes' : 'no').padEnd(7)} ${kind.padEnd(9)} ` +
			`${String(r.usdz?.bytes ?? '-').padStart(10)}   ${r.valid ? 'PASS' : 'FAIL'}`,
		);
		for (const n of r.notes) lines.push(`  note: ${n}`);
	}
	const ok = results.filter((r) => r.valid).length;
	lines.push('', `${ok}/${results.length} avatars bake a real USDZ for Quick Look.`);
	return lines.join('\n');
}

async function main() {
	await mkdir(OUT_DIR, { recursive: true });
	const browser = await chromium.launch({
		args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
	});
	const results = [];
	for (const [i, glbUrl] of AVATARS.entries()) {
		const slug = SLUGS[i] || `avatar-${i + 1}`;
		process.stdout.write(`\n[ar-usdz-check] ${slug} -> ${glbUrl}\n`);
		results.push(await runAvatar(browser, { glbUrl, slug }));
	}
	await browser.close();

	const text = report(results);
	process.stdout.write(text + '\n');
	await writeFile(path.join(OUT_DIR, 'ar-usdz-check.json'), JSON.stringify(results, null, 2));
	process.exitCode = results.every((r) => r.valid) ? 0 : 1;
}

main().catch((e) => {
	console.error(e);
	process.exitCode = 1;
});
