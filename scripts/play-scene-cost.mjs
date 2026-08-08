// Scene-cost probe for a /play world: how many objects the renderer has to
// submit per frame, and how much geometry/texture memory the world holds.
//
//   node scripts/play-scene-cost.mjs "<url>" [settleSeconds]
//
// These are the numbers that decide frame rate on a real GPU, and unlike a
// frames-per-second reading they are hardware-independent: a draw call is a
// draw call whether the rasterizer is a laptop GPU or the software fallback CI
// runs on. Deliberately small viewport and short run so it finishes in a minute
// even under swiftshader; use scripts/play-perf-audit.mjs for network, frame
// timing and heap growth.
import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';

const TARGET = process.argv[2] || 'http://localhost:3000/play';
const SETTLE_MS = Number(process.argv[3] || 25) * 1000;
const LABEL = process.env.LABEL || 'scene';

const browser = await chromium.launch({
	args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
const t0 = Date.now();
const at = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
const notes = [];
page.on('console', (m) => {
	const t = m.text();
	// The world environment reports its own batching totals; capture them.
	if (/\[world-env]/.test(t)) notes.push(t.slice(0, 200));
	if (m.type() === 'error') notes.push('[error] ' + t.slice(0, 160));
});
page.on('pageerror', (e) => notes.push('[pageerror] ' + String(e).slice(0, 200)));

await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 240000 });
console.log(at(), 'domcontentloaded');

try {
	await page.waitForSelector('.pi-btn-primary', { timeout: 30000 });
	await page.click('.pi-btn-primary');
} catch { /* deep link drops straight in */ }

// The environment is the last thing world entry builds before it waits on the
// room socket, so it is the right readiness signal for a scene-cost read: it
// does not depend on multiplayer being reachable from wherever this runs.
await page.waitForFunction(() => !!window.__CC__?.env, null, { timeout: 240000 });
console.log(at(), 'world environment built');
await page.waitForTimeout(SETTLE_MS);

const cost = await page.evaluate(() => {
	const g = window.__CC__;
	const r = g.renderer;
	const geoms = new Set(), mats = new Set(), texes = new Set();
	let meshes = 0, instanced = 0, instances = 0, skinned = 0, lights = 0, sprites = 0, shadowCasters = 0;
	let attrBytes = 0, texPixels = 0;
	g.scene.traverse((o) => {
		if (o.isLight) lights++;
		if (o.isSprite) sprites++;
		if (o.isInstancedMesh) { instanced++; instances += o.count; }
		else if (o.isSkinnedMesh) skinned++;
		else if (o.isMesh) meshes++;
		if (o.castShadow && (o.isMesh || o.isInstancedMesh)) shadowCasters++;
		if (o.geometry && !geoms.has(o.geometry.uuid)) {
			geoms.add(o.geometry.uuid);
			for (const a of Object.values(o.geometry.attributes || {})) attrBytes += a?.array?.byteLength || 0;
			attrBytes += o.geometry.index?.array?.byteLength || 0;
		}
		for (const m of Array.isArray(o.material) ? o.material : o.material ? [o.material] : []) {
			if (mats.has(m.uuid)) continue;
			mats.add(m.uuid);
			for (const v of Object.values(m)) {
				if (v?.isTexture && !texes.has(v.uuid)) {
					texes.add(v.uuid);
					if (v.image?.width) texPixels += v.image.width * v.image.height;
				}
			}
		}
	});
	return {
		drawCalls: r.info.render.calls,
		triangles: r.info.render.triangles,
		programs: r.info.programs?.length || 0,
		geometriesResident: r.info.memory.geometries,
		texturesResident: r.info.memory.textures,
		sceneObjects: (() => { let n = 0; g.scene.traverse(() => n++); return n; })(),
		meshes, instancedMeshes: instanced, instances, skinnedMeshes: skinned,
		lights, sprites, shadowCasters,
		uniqueGeometries: geoms.size,
		uniqueMaterials: mats.size,
		uniqueTextures: texes.size,
		geometryMB: +(attrBytes / 1048576).toFixed(2),
		textureMB: +((texPixels * 4) / 1048576).toFixed(2),
		biome: g.env?.biome?.id || null,
		phase: g.phase,
	};
});

console.log(`\n===== SCENE COST (${LABEL}) =====`);
for (const [k, v] of Object.entries(cost)) console.log('  ' + k.padEnd(20), v);
if (notes.length) {
	console.log('\n--- console ---');
	for (const n of [...new Set(notes)].slice(0, 10)) console.log('  ' + n);
}

// Frame the same vantage in every run before capturing, so two runs are
// comparable pixel for pixel. The follow camera is driven from localPos/camYaw
// every frame, so steering those is the only way to aim it from outside; the
// pause lets the camera's own smoothing settle.
if (process.env.SHOT) {
	await page.evaluate(() => {
		const g = window.__CC__;
		g.localPos.set(0, 0, 0);
		g.camYaw = Math.PI * 0.75;
		g.camPitch = 0.12;
	});
	await page.waitForTimeout(6000);
}

// Capture through CDP rather than page.screenshot(): the world runs a rAF loop
// forever, so Playwright's wait-for-stability never settles on a busy main
// thread and the capture times out with the numbers already in hand.
if (process.env.SHOT) {
	try {
		const cdp = await page.context().newCDPSession(page);
		const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
		await writeFile(process.env.SHOT, Buffer.from(data, 'base64'));
		console.log('\nscreenshot →', process.env.SHOT);
	} catch (err) {
		console.log('\nscreenshot failed:', String(err).slice(0, 120));
	}
}
await browser.close();
