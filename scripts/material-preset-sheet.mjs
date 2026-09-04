#!/usr/bin/env node
/**
 * Material preset contact sheets: renders every `@three-ws/viewer-presets`
 * material preset under EVERY environment the platform viewer ships
 * (src/environments.js: None, Neutral/RoomEnvironment, Venice Sunset,
 * Footprint Court) and writes one PNG per environment.
 *
 * A measured-value preset is only correct if it reads correctly under the
 * lighting a user will actually see it in. Tuning skin roughness against a
 * single studio HDRI and shipping it is how a "measured" value ends up looking
 * like wet plastic at sunset, so this sheet is the gate: look at all of them,
 * then tune.
 *
 * The harness page (scripts/material-preset-sheet.html) runs the SAME renderer
 * configuration src/viewer.js uses (NeutralToneMapping, exposure 0,
 * environmentIntensity 1.15, sRGB output) through real three.js in real
 * Chromium, so nothing here is a stand-in for the viewer.
 *
 * Usage:
 *   npm run dev                                  # the harness is served by Vite
 *   node scripts/material-preset-sheet.mjs
 *   node scripts/material-preset-sheet.mjs --out=docs/assets/material-presets
 *   node scripts/material-preset-sheet.mjs --base=http://localhost:3000 --shape=knot
 *
 * Exits nonzero if any environment failed to render.
 */

import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const args = Object.fromEntries(
	process.argv
		.slice(2)
		.filter((a) => a.startsWith('--'))
		.map((a) => {
			const [k, ...rest] = a.replace(/^--/, '').split('=');
			return [k, rest.length ? rest.join('=') : 'true'];
		}),
);

const BASE = args.base || 'http://localhost:3000';
const OUT_DIR = path.resolve(args.out || 'docs/assets/material-presets');
const SHAPE = args.shape === 'knot' ? 'knot' : 'sphere';
// A 2K EXR decoded and PMREM-filtered under SwiftShader is slow; the sheet also
// renders 20 full-quality frames after that.
const READY_TIMEOUT = Number(args.timeout || 180_000);

// Mirrors src/environments.js. Kept as ids only: the harness page imports the
// real module, so this list just drives which pages to open and what to call
// the files.
const ENV_IDS = [
	{ id: '', file: 'none' },
	{ id: 'neutral', file: 'neutral' },
	{ id: 'venice-sunset', file: 'venice-sunset' },
	{ id: 'footprint-court', file: 'footprint-court' },
];

async function main() {
	await mkdir(OUT_DIR, { recursive: true });
	const browser = await chromium.launch({
		args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
	});
	const failures = [];

	for (const env of ENV_IDS) {
		const page = await browser.newPage({ viewport: { width: 1120, height: 1400 }, deviceScaleFactor: 1 });
		const consoleErrors = [];
		page.on('console', (msg) => {
			if (msg.type() === 'error') consoleErrors.push(msg.text());
		});
		page.on('pageerror', (err) => consoleErrors.push(String(err?.message || err)));

		const url = `${BASE}/scripts/material-preset-sheet.html?env=${encodeURIComponent(env.id)}&shape=${SHAPE}`;
		try {
			await page.goto(url, { waitUntil: 'load', timeout: READY_TIMEOUT });
			await page.waitForSelector('body[data-ready="true"]', { timeout: READY_TIMEOUT });
			const file = path.join(OUT_DIR, `presets-${env.file}.png`);
			await page.screenshot({ path: file, fullPage: true });
			const count = await page.locator('#sheet figure').count();
			console.log(`✓ ${env.file.padEnd(16)} ${count} presets → ${path.relative(process.cwd(), file)}`);
			if (consoleErrors.length) console.warn(`  console: ${consoleErrors.slice(0, 3).join(' | ')}`);
		} catch (err) {
			failures.push({ env: env.file, message: err?.message || String(err), consoleErrors });
			console.error(`✗ ${env.file}: ${err?.message || err}`);
		} finally {
			await page.close();
		}
	}

	await browser.close();
	if (failures.length) {
		console.error(`\n${failures.length} environment(s) failed.`);
		process.exit(1);
	}
	console.log(`\nAll ${ENV_IDS.length} shipped environments rendered into ${path.relative(process.cwd(), OUT_DIR)}.`);
}

main().catch((err) => {
	console.error('[material-preset-sheet] fatal:', err);
	process.exit(1);
});
