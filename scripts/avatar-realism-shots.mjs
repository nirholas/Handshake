#!/usr/bin/env node
/**
 * Avatar material realism, proven in the real viewer at real breakpoints.
 *
 * Loads an avatar GLB in the actual /viewer page, waits for the model, and
 * screenshots it at 320, 768 and 1440 px wide. Alongside each shot it reports
 * what `src/shared/avatar-material-realism.js` actually did to the loaded
 * scene: how many skin / eye / hair / teeth materials it upgraded, and the
 * physical values that landed on each class. A screenshot alone cannot tell
 * you whether the pass ran; the readback can.
 *
 * The readback rides three.js's own devtools hook (the same technique
 * scripts/irl-realism-check.mjs uses): every Scene constructor dispatches an
 * `observe` event on a global `__THREE_DEVTOOLS__` when one exists, so
 * installing an EventTarget there before any page script runs hands us the live
 * scene graph without a single source change.
 *
 * Usage:
 *   npm run dev
 *   node scripts/avatar-realism-shots.mjs
 *   node scripts/avatar-realism-shots.mjs --src=/avatars/selfie-girl.glb
 *   node scripts/avatar-realism-shots.mjs --base=http://localhost:3000 --out=docs/assets/avatar-realism
 *
 * Exits nonzero when no skin or eye material was upgraded: that means the pass
 * did not reach the model, which is exactly the regression worth failing on.
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
const SRC = args.src || '/avatars/realistic-male.glb';
const OUT_DIR = path.resolve(args.out || 'docs/assets/avatar-realism');
// SwiftShader has to rasterize a skinned avatar under IBL; a cold first paint
// on the 1440px viewport is the slow case.
const LOAD_TIMEOUT = Number(args.timeout || 240_000);

const BREAKPOINTS = [
	{ label: '320', width: 320, height: 640 },
	{ label: '768', width: 768, height: 1024 },
	{ label: '1440', width: 1440, height: 900 },
];

// Installed before any page script: three.js dispatches `observe` on this for
// every Scene and WebGLRenderer it constructs.
const DEVTOOLS_HOOK = `
window.__THREE_DEVTOOLS__ = new EventTarget();
window.__qb04_scenes = [];
window.__THREE_DEVTOOLS__.addEventListener('observe', (event) => {
	const obj = event.detail;
	if (obj && obj.isScene) window.__qb04_scenes.push(obj);
});
`;

// Runs in the page: walks every observed scene and reports the physical values
// the realism pass leaves behind, per class.
const READBACK = `(() => {
	const SKIN = /(^|[_\\s-])(skin|body|face|head|torso|arm|leg|hand|feet|foot)(?=[_\\s-]|$)/i;
	const WOLF = /wolf3d_(skin|body|head)/i;
	const EYE = /(^|[_\\s-])(eye|cornea|iris|sclera)(left|right)?(?=[_\\s-]|$)/i;
	const HAIR = /(^|[_\\s-])(hair|eyebrow|eyelash|beard|fur)(left|right|back|front)?(?=[_\\s-]|$)/i;
	const TEETH = /(^|[_\\s-])(teeth|tongue|mouth)(?=[_\\s-]|$)/i;
	const out = { meshes: 0, classes: {} };
	for (const scene of window.__qb04_scenes || []) {
		scene.traverse((node) => {
			if (!node.isMesh || !node.material) return;
			const n = (node.name || '') + ' ' + (node.material.name || '');
			let cls = null;
			if (WOLF.test(n) || SKIN.test(n)) cls = 'skin';
			else if (EYE.test(n)) cls = 'eye';
			else if (HAIR.test(n)) cls = 'hair';
			else if (TEETH.test(n)) cls = 'teeth';
			if (!cls) return;
			out.meshes++;
			const mats = Array.isArray(node.material) ? node.material : [node.material];
			for (const m of mats) {
				if (!m || !('roughness' in m)) continue;
				(out.classes[cls] = out.classes[cls] || []).push({
					mesh: node.name,
					physical: !!m.isMeshPhysicalMaterial,
					roughness: Number(m.roughness?.toFixed?.(3) ?? m.roughness),
					metalness: m.metalness,
					sheen: m.sheen ?? null,
					clearcoat: m.clearcoat ?? null,
					ior: m.ior ?? null,
					specularIntensity: m.specularIntensity ?? null,
					doubleSided: m.side === 2,
					alphaTest: m.alphaTest ?? null,
				});
			}
		});
	}
	return out;
})()`;

async function main() {
	await mkdir(OUT_DIR, { recursive: true });
	const browser = await chromium.launch({
		args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
	});
	const report = { src: SRC, base: BASE, capturedAt: new Date().toISOString(), shots: [] };
	let sawUpgrade = false;

	for (const bp of BREAKPOINTS) {
		const page = await browser.newPage({ viewport: { width: bp.width, height: bp.height }, deviceScaleFactor: 1 });
		await page.addInitScript(DEVTOOLS_HOOK);
		const consoleErrors = [];
		page.on('console', (msg) => {
			if (msg.type() === 'error') consoleErrors.push(msg.text());
		});
		page.on('pageerror', (err) => consoleErrors.push(String(err?.message || err)));

		const url = `${BASE}/viewer?src=${encodeURIComponent(SRC)}`;
		await page.goto(url, { waitUntil: 'load', timeout: LOAD_TIMEOUT });
		// The realism pass runs inside setContent(), right after the GLB loads, so
		// poll the scene graph rather than guessing at a fixed delay.
		await page
			.waitForFunction(
				`() => (window.__qb04_scenes || []).some((s) => { let hit = false; s.traverse((n) => { if (n.isMesh) hit = true; }); return hit; })`,
				{ timeout: LOAD_TIMEOUT },
			)
			.catch(() => {});
		const readback = await page.evaluate(READBACK);
		if ((readback.classes.skin?.length || 0) + (readback.classes.eye?.length || 0) > 0) sawUpgrade = true;

		const file = path.join(OUT_DIR, `avatar-realism-${bp.label}.png`);
		await page.screenshot({ path: file });
		report.shots.push({ breakpoint: bp.label, viewport: `${bp.width}x${bp.height}`, file: path.relative(process.cwd(), file), readback, consoleErrors });
		console.log(
			`✓ ${String(bp.label).padEnd(5)} ${readback.meshes} classified mesh(es); ` +
				Object.entries(readback.classes)
					.map(([k, v]) => `${k}=${v.length}`)
					.join(' ') +
				(consoleErrors.length ? `  [${consoleErrors.length} console error(s)]` : ''),
		);
		await page.close();
	}

	await browser.close();
	const jsonFile = path.join(OUT_DIR, 'avatar-realism-readback.json');
	await writeFile(jsonFile, `${JSON.stringify(report, null, '\t')}\n`);
	console.log(`\nReadback → ${path.relative(process.cwd(), jsonFile)}`);
	if (!sawUpgrade) {
		console.error('No skin or eye material was upgraded: the realism pass did not reach this model.');
		process.exit(1);
	}
}

main().catch((err) => {
	console.error('[avatar-realism-shots] fatal:', err);
	process.exit(1);
});
