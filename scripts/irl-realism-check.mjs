#!/usr/bin/env node
/**
 * irl-realism-check: headless proof of what /irl actually renders, and whether
 * the shared avatar material realism pass (src/shared/avatar-material-realism.js)
 * is live on that surface.
 *
 * /irl is a camera-AR surface, so this drives it the way a real user would on a
 * device with a camera: Chromium is launched with a synthetic media device
 * (--use-fake-device-for-media-stream) and auto-granted camera permission
 * (--use-fake-ui-for-media-stream), plus SwiftShader for WebGL in headless.
 * The page is never patched to make it testable.
 *
 * Scene readback rides three.js's own devtools hook: every Scene and
 * WebGLRenderer constructor dispatches an `observe` CustomEvent on the global
 * __THREE_DEVTOOLS__ if one exists. Installing an EventTarget there before any
 * page script runs hands us the live scene graph on both the dev server and the
 * minified production bundle, with zero source changes.
 *
 * Usage:
 *   node scripts/irl-realism-check.mjs                       # dev (localhost:3000) + production
 *   node scripts/irl-realism-check.mjs --base=http://localhost:3000
 *   node scripts/irl-realism-check.mjs --only=prod
 *   node scripts/irl-realism-check.mjs --out=/path/to/dir
 *   node scripts/irl-realism-check.mjs --only=prod \
 *     --avatar=https://.../athlete.glb --slug=athlete
 *
 * --avatar places a SPECIFIC avatar on the surface (the ?avatar= the share and
 * AR links carry) instead of the page's default body, and --slug keeps that
 * run's screenshots and JSON from overwriting another avatar's.
 *
 * Exit code is 0 when an avatar rendered on at least one target (the realism
 * pass being absent is a reported finding, not a script failure), 1 otherwise.
 */

import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_OUT = path.resolve(process.cwd(), 'prompts/quality-bar/_generated/10');

const args = Object.fromEntries(
	process.argv.slice(2)
		.filter((a) => a.startsWith('--'))
		.map((a) => {
			const [k, ...rest] = a.replace(/^--/, '').split('=');
			return [k, rest.length ? rest.join('=') : 'true'];
		}),
);

const OUT_DIR = path.resolve(args.out || DEFAULT_OUT);
const ONLY = args.only || 'all'; // all | dev | prod
const DEV_BASE = args.base || 'http://localhost:3000';
// SwiftShader capture of a full-screen WebGL canvas is CPU-bound and slow.
const SHOT_TIMEOUT = Number(args.shotTimeout || 120_000);
const PROD_BASE = args.prod || 'https://three.ws';
// A specific avatar to place on the surface, and the filename discriminator that
// keeps one avatar's evidence from overwriting the next one's. Empty slug keeps
// the historic filenames, so an existing invocation is unaffected.
const AVATAR = typeof args.avatar === 'string' && args.avatar !== 'true' ? args.avatar : null;
const SLUG = typeof args.slug === 'string' && args.slug !== 'true' ? args.slug.replace(/[^a-z0-9-]+/gi, '-') : '';
const suffix = (name) => `${SLUG ? `-${SLUG}` : ''}${name === 'production' ? '-prod' : ''}`;
const irlUrl = (base) => (AVATAR ? `${base}/irl?avatar=${encodeURIComponent(AVATAR)}` : `${base}/irl`);

// The classifier the realism module uses, mirrored here purely as a READ-ONLY
// probe so the checker can name which meshes the module would claim. It never
// mutates anything; the actual before/after mutation below is done by importing
// the real module in the page.
const CLASSIFIER_SRC = `
const SKIN_NAME_RE = /(^|[_\\s-])(skin|body|face|head|torso|arm|leg|hand|feet|foot)(?=[_\\s-]|$)/i;
const WOLF3D_SKIN_RE = /wolf3d_skin|wolf3d_body|wolf3d_head/i;
const EYE_NAME_RE = /(^|[_\\s-])(eye|cornea|iris|sclera)(left|right)?(?=[_\\s-]|$)/i;
const HAIR_NAME_RE = /(^|[_\\s-])(hair|eyebrow|eyelash|beard|fur)(left|right|back|front)?(?=[_\\s-]|$)/i;
const TEETH_NAME_RE = /(^|[_\\s-])(teeth|tongue|mouth)(?=[_\\s-]|$)/i;
function classify(node) {
	const n = (node?.name || '') + ' ' + (node?.material?.name || '');
	if (WOLF3D_SKIN_RE.test(n) || SKIN_NAME_RE.test(n)) return 'skin';
	if (EYE_NAME_RE.test(n)) return 'eye';
	if (HAIR_NAME_RE.test(n)) return 'hair';
	if (TEETH_NAME_RE.test(n)) return 'teeth';
	return null;
}
`;

/** Installed before any page script: three.js dispatches every Scene/WebGLRenderer here. */
function threeDevtoolsProbe() {
	const target = new EventTarget();
	window.__capturedScenes = [];
	window.__capturedRenderers = [];
	target.addEventListener('observe', (e) => {
		const o = e.detail;
		if (!o) return;
		if (o.isScene) window.__capturedScenes.push(o);
		else if (o.isWebGLRenderer || o.domElement instanceof HTMLCanvasElement) window.__capturedRenderers.push(o);
	});
	window.__THREE_DEVTOOLS__ = target;
}

/** Serialize the material fields the realism pass tunes. */
const MATERIAL_READBACK = `
function readMaterial(mat) {
	if (!mat) return null;
	const hex = (c) => (c && typeof c.getHexString === 'function' ? '#' + c.getHexString() : null);
	return {
		name: mat.name || '(unnamed)',
		type: mat.type,
		isMeshPhysicalMaterial: !!mat.isMeshPhysicalMaterial,
		isMeshStandardMaterial: !!mat.isMeshStandardMaterial,
		roughness: mat.roughness ?? null,
		metalness: mat.metalness ?? null,
		sheen: mat.sheen ?? null,
		sheenColor: hex(mat.sheenColor),
		sheenRoughness: mat.sheenRoughness ?? null,
		clearcoat: mat.clearcoat ?? null,
		clearcoatRoughness: mat.clearcoatRoughness ?? null,
		ior: mat.ior ?? null,
		specularIntensity: mat.specularIntensity ?? null,
		envMapIntensity: mat.envMapIntensity ?? null,
		side: mat.side,
		alphaTest: mat.alphaTest ?? null,
		color: hex(mat.color),
	};
}
`;

const SCENE_SNAPSHOT = `
function sceneSnapshot() {
	${CLASSIFIER_SRC}
	${MATERIAL_READBACK}
	const scenes = window.__capturedScenes || [];
	const out = { scenes: scenes.length, meshes: 0, skinnedMeshes: 0, classified: [], sample: [] };
	for (const scene of scenes) {
		scene.traverse((n) => {
			if (!n.isMesh) return;
			out.meshes++;
			if (n.isSkinnedMesh) out.skinnedMeshes++;
			const cls = classify(n);
			if (out.sample.length < 40) out.sample.push({ name: n.name, class: cls, visible: n.visible });
			if (!cls) return;
			const mats = Array.isArray(n.material) ? n.material : [n.material];
			for (const m of mats) {
				if (!m || !('roughness' in m)) continue;
				out.classified.push({ mesh: n.name, class: cls, material: readMaterial(m) });
			}
		});
	}
	return out;
}
`;

function summarize(readback) {
	const upgraded = readback.classified.filter((c) => c.material.isMeshPhysicalMaterial);
	const skin = readback.classified.filter((c) => c.class === 'skin');
	const eye = readback.classified.filter((c) => c.class === 'eye');
	// The realism pass leaves unmistakable fingerprints: skin gets sheen 0.35 +
	// specularIntensity 0.6, eyes get clearcoat 1 + ior 1.376. Absence of BOTH on
	// every classified material means the pass never ran on this scene.
	const skinMarked = skin.some((c) => c.material.sheen === 0.35 && c.material.specularIntensity === 0.6);
	const eyeMarked = eye.some((c) => c.material.clearcoat === 1 && Math.abs((c.material.ior ?? 0) - 1.376) < 1e-6);
	return {
		classifiedCount: readback.classified.length,
		physicalCount: upgraded.length,
		skinCount: skin.length,
		eyeCount: eye.length,
		skinMarked,
		eyeMarked,
		realismActive: skinMarked || eyeMarked,
	};
}

async function runTarget({ name, url, canImportModule, browser }) {
	const result = {
		name, url,
		loaded: false,
		avatarRendered: false,
		consoleErrors: [],
		pageErrors: [],
		screenshots: [],
		readback: null,
		summary: null,
		afterModule: null,
		afterSummary: null,
		cameraAr: null,
		onboarding: [],
		notes: [],
	};

	const context = await browser.newContext({
		viewport: { width: 430, height: 932 }, // iPhone-class portrait, the surface's real target
		// Kept at 1: a 2x buffer of a SwiftShader-rendered WebGL canvas pushes a
		// single capture past two minutes on this CPU-only runner.
		deviceScaleFactor: 1,
		permissions: ['camera'],
		locale: 'en-US',
	});
	await context.addInitScript(threeDevtoolsProbe);
	const page = await context.newPage();

	page.on('console', (msg) => {
		if (msg.type() === 'error') result.consoleErrors.push(msg.text());
	});
	page.on('pageerror', (err) => result.pageErrors.push(String(err?.message || err)));

	try {
		await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
		result.loaded = true;

		// The hero camera button is disabled until loadAvatar() resolves. That is
		// the app's own "avatar is on screen" signal, so wait on it rather than a
		// blind timeout.
		await page.waitForFunction(() => {
			const b = document.getElementById('irl-camera-btn');
			return !!b && !b.disabled;
		}, null, { timeout: 90_000 }).catch(() => {
			result.notes.push('camera button never enabled within 90s, falling back to scene-graph poll');
		});

		// Independently confirm a skinned avatar mesh actually reached the scene.
		await page.waitForFunction(() => {
			const scenes = window.__capturedScenes || [];
			let found = false;
			for (const s of scenes) s.traverse((n) => { if (n.isSkinnedMesh) found = true; });
			return found;
		}, null, { timeout: 60_000 }).catch(() => {
			result.notes.push('no SkinnedMesh observed in any captured scene within 60s');
		});

		// Clear the first-run permission overlay the way a user does: tap through
		// each card, taking the grant when the card offers one and the recovery
		// ("Continue without" / "Skip for now") when the headless profile can't
		// satisfy it (motion sensors, geolocation). Nothing is bypassed in code.
		result.onboarding = [];
		for (let i = 0; i < 12; i++) {
			const step = await page.evaluate(() => {
				const ov = document.getElementById('irl-onboard');
				if (!ov || ov.hidden || !ov.classList.contains('is-open')) return null;
				const pick = ['enable', 'continue', 'skip']
					.map((a) => ov.querySelector(`[data-sk-action="${a}"]`))
					.find(Boolean);
				return pick ? { action: pick.dataset.skAction, label: pick.textContent.trim() } : { action: null, label: null };
			});
			if (!step) break;
			if (!step.action) { await page.waitForTimeout(800); continue; }
			result.onboarding.push(step.label);
			await page.click(`#irl-onboard [data-sk-action="${step.action}"]`, { timeout: 8000 }).catch(() => {});
			await page.waitForTimeout(1200);
		}
		await page.waitForTimeout(1200);

		// First-run discovery explainer sits on the same z-stack. Take its primary
		// "Start exploring" action, exactly as a first-time user would.
		//
		// Dispatched on the button element itself rather than at screen coordinates:
		// the panel animates in continuously, so a coordinate click lands wherever
		// the box happens to be that frame and can fall through to the canvas
		// (which is a tap target of its own: it toggles immersive mode).
		for (let i = 0; i < 6; i++) {
			const done = await page.evaluate(() => {
				const modal = document.getElementById('irl-discovery-explainer');
				if (!modal || !modal.classList.contains('is-open')) return true;
				const btn = modal.querySelector('[data-dx-start]');
				if (!btn) return true;
				btn.click();
				return false;
			});
			if (i === 0 && !done) result.onboarding.push('Start exploring');
			if (done) break;
			await page.waitForTimeout(700);
		}

		// A stray tap on the scene toggles immersive mode (chrome slides away). If
		// anything above landed there, restore the chrome so the dock is on screen.
		await page.evaluate(() => {
			if (document.body.classList.contains('irl-immersive')) {
				document.querySelector('.irl-immersive-toggle')?.click();
			}
		});
		await page.waitForTimeout(800);

		// Let the idle clip settle so the screenshot is a natural pose, not bind pose.
		await page.waitForTimeout(2500);

		result.readback = await page.evaluate(`(() => { ${SCENE_SNAPSHOT} return sceneSnapshot(); })()`);
		result.avatarRendered = result.readback.skinnedMeshes > 0;
		result.summary = summarize(result.readback);

		const shot = path.join(OUT_DIR, `irl-avatar${suffix(name)}.png`);
		await page.screenshot({ path: shot, timeout: SHOT_TIMEOUT });
		result.screenshots.push(shot);

		// Camera AR: the fake media device makes getUserMedia resolve headlessly,
		// so the real "Start camera" path can be exercised end to end.
		try {
			const alreadyAr = await page.evaluate(() => document.body.classList.contains('is-ar'));
			if (!alreadyAr) {
				await page.evaluate(() => document.getElementById('irl-camera-btn')?.click());
			}
			await page.waitForTimeout(4000);
			const arOn = await page.evaluate(() => ({
				bodyIsAr: document.body.classList.contains('is-ar'),
				videoReady: (() => {
					const v = document.getElementById('irl-camera');
					return v ? { readyState: v.readyState, w: v.videoWidth, h: v.videoHeight, hasStream: !!v.srcObject } : null;
				})(),
			}));
			result.cameraAr = arOn;
			const arShot = path.join(OUT_DIR, `irl-avatar-ar${suffix(name)}.png`);
			await page.screenshot({ path: arShot, timeout: SHOT_TIMEOUT });
			result.screenshots.push(arShot);
		} catch (e) {
			result.notes.push(`camera AR click failed: ${e?.message || e}`);
		}

		// Dev only: import the REAL realism module into the live page and apply it
		// to the same scene, so the readback shows the exact delta the surface is
		// missing. This mutates the running page, never the source.
		if (canImportModule) {
			const applied = await page.evaluate(`(async () => {
				${SCENE_SNAPSHOT}
				const mod = await import('/src/shared/avatar-material-realism.js');
				const scenes = window.__capturedScenes || [];
				let looksLike = false;
				const counts = { skin: 0, eye: 0, hair: 0, teeth: 0 };
				for (const s of scenes) {
					if (mod.looksLikeAvatarMesh(s)) looksLike = true;
					const c = mod.applyAvatarMaterialRealism(s);
					for (const k of Object.keys(counts)) counts[k] += c[k];
				}
				return { looksLikeAvatarMesh: looksLike, counts, readback: sceneSnapshot() };
			})()`);
			result.afterModule = applied;
			result.afterSummary = summarize(applied.readback);
			await page.waitForTimeout(600);
			const afterShot = path.join(OUT_DIR, `irl-avatar-realism-applied${SLUG ? `-${SLUG}` : ''}.png`);
			await page.screenshot({ path: afterShot, timeout: SHOT_TIMEOUT });
			result.screenshots.push(afterShot);
		}
	} catch (e) {
		result.notes.push(`fatal: ${e?.message || e}`);
	} finally {
		await context.close();
	}
	return result;
}

function fmtMat(m) {
	return [
		`type=${m.type}`,
		`roughness=${m.roughness}`,
		`metalness=${m.metalness}`,
		`sheen=${m.sheen}`,
		`clearcoat=${m.clearcoat}`,
		`ior=${m.ior}`,
		`specularIntensity=${m.specularIntensity}`,
		`envMapIntensity=${m.envMapIntensity}`,
	].join(' ');
}

function report(results) {
	const lines = [];
	for (const r of results) {
		lines.push(`\n=== ${r.name} :: ${r.url} ===`);
		lines.push(`loaded=${r.loaded} avatarRendered=${r.avatarRendered}`);
		if (r.readback) {
			lines.push(`scenes=${r.readback.scenes} meshes=${r.readback.meshes} skinnedMeshes=${r.readback.skinnedMeshes}`);
		}
		if (r.summary) {
			lines.push(`classified=${r.summary.classifiedCount} physical=${r.summary.physicalCount} skinMarked=${r.summary.skinMarked} eyeMarked=${r.summary.eyeMarked}`);
			lines.push(`REALISM MODULE ACTIVE: ${r.summary.realismActive ? 'YES' : 'NO'}`);
		}
		for (const c of (r.readback?.classified || [])) {
			lines.push(`  [${c.class}] ${c.mesh} :: ${fmtMat(c.material)}`);
		}
		if (r.afterSummary) {
			lines.push(`-- after importing + applying the module in-page --`);
			lines.push(`looksLikeAvatarMesh=${r.afterModule.looksLikeAvatarMesh} counts=${JSON.stringify(r.afterModule.counts)}`);
			lines.push(`classified=${r.afterSummary.classifiedCount} physical=${r.afterSummary.physicalCount} skinMarked=${r.afterSummary.skinMarked} eyeMarked=${r.afterSummary.eyeMarked}`);
			for (const c of (r.afterModule.readback?.classified || [])) {
				lines.push(`  [${c.class}] ${c.mesh} :: ${fmtMat(c.material)}`);
			}
		}
		lines.push(`onboarding taps: ${JSON.stringify(r.onboarding)}`);
		lines.push(`cameraAr=${JSON.stringify(r.cameraAr)}`);
		lines.push(`consoleErrors(${r.consoleErrors.length}):`);
		for (const e of r.consoleErrors) lines.push(`  ! ${e}`);
		lines.push(`pageErrors(${r.pageErrors.length}):`);
		for (const e of r.pageErrors) lines.push(`  !! ${e}`);
		for (const n of r.notes) lines.push(`  note: ${n}`);
		lines.push(`screenshots: ${r.screenshots.join(', ')}`);
	}
	return lines.join('\n');
}

async function main() {
	await mkdir(OUT_DIR, { recursive: true });

	const browser = await chromium.launch({
		args: [
			'--use-fake-ui-for-media-stream',
			'--use-fake-device-for-media-stream',
			'--use-gl=angle',
			'--use-angle=swiftshader',
			'--enable-unsafe-swiftshader',
			'--ignore-gpu-blocklist',
		],
	});

	const targets = [];
	if (ONLY !== 'prod') targets.push({ name: 'dev', url: irlUrl(DEV_BASE), canImportModule: true });
	if (ONLY !== 'dev') targets.push({ name: 'production', url: irlUrl(PROD_BASE), canImportModule: false });

	const results = [];
	for (const t of targets) {
		process.stdout.write(`\n[irl-realism-check] ${t.name} → ${t.url}\n`);
		results.push(await runTarget({ ...t, browser }));
	}
	await browser.close();

	const text = report(results);
	process.stdout.write(text + '\n');
	await writeFile(path.join(OUT_DIR, `irl-realism-check${SLUG ? `-${SLUG}` : ''}.json`), JSON.stringify(results, null, 2));

	const anyAvatar = results.some((r) => r.avatarRendered);
	process.exitCode = anyAvatar ? 0 : 1;
}

main().catch((e) => {
	console.error(e);
	process.exitCode = 1;
});
