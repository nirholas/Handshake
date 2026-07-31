// Real-browser verification of Forge Reel: load /forge, drop a real model into
// the result viewer, open the Reel dialog, record an actual reel, and assert
// the produced files are real bytes of the right type.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const OUT = '/tmp/claude-1000/-workspaces-three-ws/54abdcf2-c800-40d7-8c4b-205b55327f21/scratchpad/reel-shots';
mkdirSync(OUT, { recursive: true });

const errors = [];
const browser = await chromium.launch({
	args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('console', (m) => {
	if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

await page.goto('http://localhost:3000/forge', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);

// Put a real GLB in the result viewer through the page's own hook.
await page.evaluate(() => {
	document.dispatchEvent(
		new CustomEvent('forge:open-creation', {
			detail: {
				creation: {
					id: 'verify-reel',
					prompt: 'a brass lantern',
					glb_url: 'https://three.ws/avatars/default.glb',
					backend: 'trellis_selfhost',
				},
			},
		}),
	);
});

await page.waitForSelector('#viewer[src]', { timeout: 20000 });
await page.waitForFunction(() => document.getElementById('viewer')?.loaded === true, {
	timeout: 60000,
});
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}/01-result.png` });

const triggerVisible = await page.isVisible('#reel-open');
console.log('reel trigger visible:', triggerVisible);

await page.click('#reel-open');
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/02-dialog.png` });

console.log('summary:', await page.textContent('.reel-summary'));

// Shortest reel so verification stays quick.
await page.click('.reel-durations .reel-chip[data-id="4"]');
await page.click('.reel-start');
await page.waitForTimeout(1800);
await page.screenshot({ path: `${OUT}/03-recording.png` });

await page.waitForSelector('.reel-done:not([hidden]) .reel-file, .reel-fallback:not([hidden]) .reel-file', {
	timeout: 60000,
});
await page.waitForTimeout(800);
await page.screenshot({ path: `${OUT}/04-done.png` });

// Pull the real bytes back out and write them to disk so the files can be
// inspected outside the browser.
const files = await page.evaluate(async () => {
	const rows = [...document.querySelectorAll('.reel-file')];
	const out = [];
	for (const row of rows) {
		const blob = await (await fetch(row.href)).blob();
		const buf = new Uint8Array(await blob.arrayBuffer());
		out.push({
			name: row.download,
			type: blob.type,
			size: blob.size,
			head: [...buf.slice(0, 16)],
			b64: btoa(String.fromCharCode(...buf.slice(0, 3_000_000))),
		});
	}
	return out;
});

for (const f of files) {
	writeFileSync(`${OUT}/${f.name}`, Buffer.from(f.b64, 'base64'));
	console.log(`file ${f.name} type=${f.type} size=${f.size}`);
}

// The stage must have been handed back: camera controls restored, no leftover
// fixed positioning, no leftover backdrop.
const restored = await page.evaluate(() => {
	const shell = document.getElementById('viewer-shell');
	const viewer = document.getElementById('viewer');
	return {
		stageClass: shell.classList.contains('is-reel-stage'),
		bodyClass: document.body.classList.contains('forge-reel-capturing'),
		cameraControls: viewer.hasAttribute('camera-controls'),
		autoRotate: viewer.hasAttribute('auto-rotate'),
		shellPosition: getComputedStyle(shell).position,
	};
});
console.log('restored:', JSON.stringify(restored));

// Close with Escape, then confirm the keyboard shortcut reopens it.
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
console.log('closed after Esc:', !(await page.isVisible('.reel-panel')));
await page.keyboard.press('r');
await page.waitForTimeout(400);
console.log('reopened with R:', await page.isVisible('.reel-panel'));
await page.keyboard.press('Escape');

// Narrow viewport: the dialog and the stage must both fit.
await page.setViewportSize({ width: 320, height: 720 });
await page.waitForTimeout(400);
await page.click('#reel-open');
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/05-320.png` });
const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
console.log('320px horizontal overflow:', overflow);

console.log('console errors:', JSON.stringify(errors, null, 2));
await browser.close();
