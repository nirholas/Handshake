import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:3001';
const out = '/tmp/claude-1000/-workspaces-three-ws/f216c4ab-6247-4f9c-8f52-1a394cf0f0bc/scratchpad';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const logs = [];
page.on('console', (m) => logs.push(`${m.type()}: ${m.text()}`));
page.on('pageerror', (e) => logs.push('PAGEERROR: ' + e.message));

await page.goto(`${BASE}/docs/world`, { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(9000);

const facts = await page.evaluate(() => {
	const w = window.__docsWorld;
	if (!w) return { error: 'no __docsWorld handle' };
	const root = w.player.root;
	let skinned = 0;
	let meshes = 0;
	let bones = 0;
	const names = [];
	root.traverse((o) => {
		if (o.isSkinnedMesh) skinned++;
		if (o.isMesh) meshes++;
		if (o.isBone) bones++;
		if (o.name && names.length < 8) names.push(o.name);
	});
	return {
		playerChildren: root.children.length,
		meshes,
		skinnedMeshes: skinned,
		bones,
		sampleNames: names,
		playerPos: root.position.toArray().map((n) => +n.toFixed(2)),
		playerHeight: +w.player.height.toFixed(2),
	};
});
console.log('PLAYER', JSON.stringify(facts, null, 1));

// Move the camera to look at the avatar so it is actually visible in frame.
await page.evaluate(() => {
	const w = window.__docsWorld;
	const p = w.player.root.position;
	const cam = w.world?.camera || w.controls?.camera;
	if (cam) {
		cam.position.set(p.x + 2.4, 1.9, p.z + 3.4);
		cam.lookAt(p.x, 1.0, p.z);
	}
});
await page.waitForTimeout(2500);
await page.screenshot({ path: `${out}/world-avatar-closeup.png` });

console.log('DOCSWORLD_LOGS', JSON.stringify(logs.filter((l) => /docs-world|avatar|clip|anim/i.test(l)), null, 1));
await browser.close();
