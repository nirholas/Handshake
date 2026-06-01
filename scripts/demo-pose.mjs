#!/usr/bin/env node
// Record a hands-free product demo of the Pose Studio (/pose).
//
// Drives the *real* UI with Playwright — applies preset poses, FK-rotates a
// bone, switches to IK, tweaks the environment, drops a prop, then builds and
// plays a keyframed animation on the timeline. A synthetic cursor is rendered
// into the page so the recording shows the pointer gliding and clicking like a
// person is doing it live. Playwright records native webm; we transcode to mp4.
//
// Output: pose-demo.mp4 at the repo root.
//
// Prereqs: dev server running at http://localhost:3000 (`npm run dev`)
// Usage:   node scripts/demo-pose.mjs
//          node scripts/demo-pose.mjs --url http://localhost:3000/pose

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const ROOT = path.resolve(import.meta.dirname, '..');
const argv = Object.fromEntries(
	process.argv.slice(2).reduce((acc, cur, i, arr) => {
		if (cur.startsWith('--')) acc.push([cur.slice(2), arr[i + 1]]);
		return acc;
	}, []),
);

const URL = argv.url || 'http://localhost:3000/pose';
const WIDTH = parseInt(argv.width || '1440', 10);
const HEIGHT = parseInt(argv.height || '900', 10);
const VIDEO_DIR = path.join(ROOT, '.pose-demo-raw');
const OUT_MP4 = path.join(ROOT, 'pose-demo.mp4');

// ── Synthetic cursor: injected before page scripts so it tracks every real
// mouse event Playwright dispatches. Renders a ring + dot and a click ripple. ──
const CURSOR_SCRIPT = `
(() => {
	function mount() {
		if (!document.body || document.getElementById('__demo_cursor')) return;
		const style = document.createElement('style');
		style.textContent = \`
			#__demo_cursor{position:fixed;left:0;top:0;width:26px;height:26px;
				margin:-13px 0 0 -13px;border-radius:50%;
				border:2px solid rgba(255,255,255,.9);
				box-shadow:0 0 0 1px rgba(0,0,0,.45), 0 2px 10px rgba(0,0,0,.5);
				background:rgba(255,255,255,.08);z-index:2147483647;pointer-events:none;
				transition:transform .08s ease;will-change:left,top;}
			#__demo_cursor::after{content:"";position:absolute;left:50%;top:50%;
				width:5px;height:5px;margin:-2.5px 0 0 -2.5px;border-radius:50%;
				background:#fff;}
			#__demo_cursor.__down{transform:scale(.8);background:rgba(255,255,255,.25);}
			.__demo_ripple{position:fixed;width:14px;height:14px;margin:-7px 0 0 -7px;
				border-radius:50%;border:2px solid rgba(120,220,255,.9);
				z-index:2147483646;pointer-events:none;animation:__demo_rip .5s ease-out forwards;}
			@keyframes __demo_rip{from{transform:scale(.4);opacity:.9;}
				to{transform:scale(3.4);opacity:0;}}
		\`;
		document.head.appendChild(style);
		const cur = document.createElement('div');
		cur.id = '__demo_cursor';
		cur.style.left = (window.innerWidth/2)+'px';
		cur.style.top = (window.innerHeight/2)+'px';
		document.body.appendChild(cur);
		addEventListener('mousemove', (e) => {
			cur.style.left = e.clientX+'px';
			cur.style.top = e.clientY+'px';
		}, true);
		addEventListener('mousedown', (e) => {
			cur.classList.add('__down');
			const r = document.createElement('div');
			r.className = '__demo_ripple';
			r.style.left = e.clientX+'px'; r.style.top = e.clientY+'px';
			document.body.appendChild(r);
			setTimeout(() => r.remove(), 520);
		}, true);
		addEventListener('mouseup', () => cur.classList.remove('__down'), true);
	}
	if (document.body) mount();
	else addEventListener('DOMContentLoaded', mount);
	new MutationObserver(mount).observe(document.documentElement, {childList:true,subtree:true});
})();
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pageRef = null;
let cursor = { x: WIDTH / 2, y: HEIGHT / 2 };

// Glide the mouse from its current position to (x,y) with eased steps so the
// motion reads as human, not a teleport.
async function glide(x, y, steps = 26) {
	const sx = cursor.x, sy = cursor.y;
	for (let i = 1; i <= steps; i++) {
		const t = i / steps;
		const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; // easeInOutQuad
		await pageRef.mouse.move(sx + (x - sx) * e, sy + (y - sy) * e);
		await sleep(8);
	}
	cursor = { x, y };
}

// Resolve a selector to the centre of its bounding box (first visible match).
async function boxCenter(selector) {
	const el = pageRef.locator(selector).first();
	const box = await el.boundingBox();
	if (!box) throw new Error(`no box for ${selector}`);
	return { x: box.x + box.width / 2, y: box.y + box.height / 2, box };
}

// Move to a selector and click it. Returns false (and logs) if it's missing,
// so the tour keeps flowing rather than aborting on one stray control.
async function clickSel(selector, { pause = 320, label } = {}) {
	try {
		const c = await boxCenter(selector);
		await glide(c.x, c.y);
		await sleep(140);
		await pageRef.mouse.down();
		await sleep(70);
		await pageRef.mouse.up();
		if (label) log(`  · ${label}`);
		await sleep(pause);
		return true;
	} catch (e) {
		log(`  ! skip ${label || selector} (${e.message.slice(0, 60)})`);
		return false;
	}
}

// Drag a range slider's thumb to a fraction of its track (0..1), live.
async function dragSlider(selector, frac) {
	try {
		const { box } = await boxCenter(selector);
		const y = box.y + box.height / 2;
		const startX = box.x + 8;
		const endX = box.x + 8 + (box.width - 16) * frac;
		await glide(startX, y);
		await pageRef.mouse.down();
		const steps = 22;
		for (let i = 1; i <= steps; i++) {
			const cx = startX + (endX - startX) * (i / steps);
			await pageRef.mouse.move(cx, y);
			await sleep(18);
		}
		cursor = { x: endX, y };
		await pageRef.mouse.up();
		await sleep(260);
		return true;
	} catch (e) {
		log(`  ! slider ${selector} (${e.message.slice(0, 50)})`);
		return false;
	}
}

// A camera orbit: press-drag across the 3D canvas to spin the view.
async function orbit(dx, dy) {
	const { box } = await boxCenter('#pose-canvas');
	const cx = box.x + box.width / 2;
	const cy = box.y + box.height / 2;
	await glide(cx, cy);
	await pageRef.mouse.down();
	const steps = 30;
	for (let i = 1; i <= steps; i++) {
		await pageRef.mouse.move(cx + (dx * i) / steps, cy + (dy * i) / steps);
		await sleep(16);
	}
	cursor = { x: cx + dx, y: cy + dy };
	await pageRef.mouse.up();
	await sleep(200);
}

// Set a value on a native input we can't realistically drag (color pickers),
// then fire input/change so the 3D scene reacts. Cursor hovers it for context.
async function setInput(selector, value) {
	try {
		const c = await boxCenter(selector);
		await glide(c.x, c.y);
		await sleep(120);
		await pageRef.locator(selector).first().evaluate((el, v) => {
			el.value = v;
			el.dispatchEvent(new Event('input', { bubbles: true }));
			el.dispatchEvent(new Event('change', { bubbles: true }));
		}, value);
		await sleep(300);
	} catch (e) {
		log(`  ! setInput ${selector} (${e.message.slice(0, 50)})`);
	}
}

const logs = [];
function log(m) {
	logs.push(m);
	console.log(m);
}

async function main() {
	await fs.rm(VIDEO_DIR, { recursive: true, force: true });
	await fs.mkdir(VIDEO_DIR, { recursive: true });

	const browser = await chromium.launch({
		args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
	});
	const context = await browser.newContext({
		viewport: { width: WIDTH, height: HEIGHT },
		deviceScaleFactor: 1,
		recordVideo: { dir: VIDEO_DIR, size: { width: WIDTH, height: HEIGHT } },
	});
	await context.addInitScript(CURSOR_SCRIPT);
	const page = await context.newPage();
	pageRef = page;
	page.on('pageerror', (e) => log(`PAGEERROR: ${e.message.slice(0, 200)}`));

	log(`→ ${URL}  (${WIDTH}x${HEIGHT})`);
	await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

	// Wait until the mannequin is rendered (status leaves the "Loading…" state).
	await page.waitForSelector('#pose-canvas', { timeout: 20000 });
	await page
		.waitForFunction(
			() => {
				const s = document.getElementById('pose-status');
				return s && !/loading/i.test(s.textContent || '');
			},
			{ timeout: 20000 },
		)
		.catch(() => log('  (status never cleared; continuing)'));
	await sleep(1400);

	// Discover the real preset / bone ids present in the DOM so we never click
	// a control that doesn't exist.
	const presets = await page.$$eval('[data-preset]', (els) =>
		els.map((e) => e.getAttribute('data-preset')),
	);
	const bones = await page.$$eval('[data-bone]', (els) =>
		els.map((e) => e.getAttribute('data-bone')),
	);
	log(`  presets: ${presets.length} · bones: ${bones.length}`);
	const pick = (...wanted) => wanted.filter((w) => presets.includes(w));
	const armBone = bones.find((b) => /upper.?arm.?l|shoulderl|arml/i.test(b)) || bones.find((b) => /arm/i.test(b)) || bones[0];

	// ── Act 1 — preset poses, with a camera orbit to show it's real 3D ──────
	log('Act 1: preset poses');
	for (const p of pick('contrapposto', 'hands-on-hips', 'wave', 'dance')) {
		await clickSel(`[data-preset="${p}"]`, { label: `preset ${p}`, pause: 950 });
	}
	await orbit(150, -30);
	await orbit(-220, 20);
	for (const p of pick('run', 'jump')) {
		await clickSel(`[data-preset="${p}"]`, { label: `preset ${p}`, pause: 950 });
	}

	// ── Act 2 — FK: select a bone, rotate it with a slider ──────────────────
	log('Act 2: FK posing');
	await clickSel('[data-posemode="fk"]', { label: 'FK mode' });
	if (armBone) {
		await clickSel(`[data-bone="${armBone}"]`, { label: `select ${armBone}`, pause: 600 });
		const slider = '#pose-controls-host input[type="range"]';
		await dragSlider(slider, 0.85);
		await dragSlider(slider, 0.2);
	}

	// ── Act 3 — IK mode ─────────────────────────────────────────────────────
	log('Act 3: IK mode');
	await clickSel('[data-posemode="ik"]', { label: 'IK mode', pause: 700 });
	await orbit(120, 0);
	await clickSel('[data-posemode="fk"]', { label: 'back to FK', pause: 400 });

	// ── Act 4 — environment + prop ──────────────────────────────────────────
	log('Act 4: environment & props');
	await dragSlider('#pose-fov', 0.7);
	await dragSlider('#pose-light-intensity', 0.85);
	await setInput('#pose-bg', '#101826');
	await setInput('#pose-skin', '#c98a5a');
	await clickSel('[data-prop="chair"]', { label: 'prop chair', pause: 500 });
	if (pick('sit').length) await clickSel('[data-preset="sit"]', { label: 'preset sit', pause: 1100 });
	await clickSel('[data-prop="none"]', { label: 'clear prop', pause: 300 });

	// ── Act 5 — build a keyframed animation on the timeline, then play it ────
	log('Act 5: timeline animation');
	await clickSel('#pose-reset', { label: 'reset pose', pause: 500 });
	const trackBox = (await boxCenter('#tl-track')).box;
	const seekTrack = async (frac) => {
		const x = trackBox.x + 14 + (trackBox.width - 28) * frac;
		const y = trackBox.y + trackBox.height - 14;
		await glide(x, y);
		await pageRef.mouse.down();
		await sleep(60);
		await pageRef.mouse.up();
		cursor = { x, y };
		await sleep(260);
	};

	const beats = [
		{ frac: 0.0, preset: pick('relaxed', 'apose', 'tpose')[0] },
		{ frac: 0.33, preset: pick('wave', 'hands-up')[0] },
		{ frac: 0.66, preset: pick('run', 'walk-step')[0] },
		{ frac: 1.0, preset: pick('jump', 'dance')[0] },
	].filter((b) => b.preset);

	for (const b of beats) {
		await seekTrack(b.frac);
		await clickSel(`[data-preset="${b.preset}"]`, { label: `pose ${b.preset} @${Math.round(b.frac * 100)}%`, pause: 350 });
		await clickSel('#tl-add-key', { label: 'add keyframe', pause: 450 });
	}

	// Rewind and play the finished clip a couple of loops.
	await clickSel('#tl-start', { label: 'rewind' });
	await clickSel('#tl-play', { label: '▶ play', pause: 200 });
	await sleep(8200);
	await clickSel('#tl-play', { label: '⏸ pause', pause: 400 });
	await orbit(180, -20);
	await sleep(1200);

	log('Closing — finalizing video…');
	await context.close(); // flushes the webm
	await browser.close();

	const files = (await fs.readdir(VIDEO_DIR)).filter((f) => f.endsWith('.webm'));
	if (!files.length) throw new Error('no webm produced');
	const webm = path.join(VIDEO_DIR, files[0]);

	log('Transcoding → pose-demo.mp4');
	await new Promise((resolve, reject) => {
		const ff = spawn(
			'ffmpeg',
			[
				'-y',
				'-i', webm,
				'-c:v', 'libx264',
				'-preset', 'medium',
				'-crf', '20',
				'-pix_fmt', 'yuv420p',
				'-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
				'-movflags', '+faststart',
				OUT_MP4,
			],
			{ stdio: ['ignore', 'ignore', 'inherit'] },
		);
		ff.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`ffmpeg exit ${c}`))));
	});

	await fs.rm(VIDEO_DIR, { recursive: true, force: true });
	const st = await fs.stat(OUT_MP4);
	log(`\n✓ ${path.relative(ROOT, OUT_MP4)} — ${(st.size / 1024 / 1024).toFixed(1)} MB · ${WIDTH}x${HEIGHT}`);
}

main().catch((e) => {
	console.error('\nFAILED:', e);
	process.exit(1);
});
