import { chromium } from 'playwright';

const PORT = process.env.PORT || '3000';
const browser = await chromium.launch({
	args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
});

async function probeEmbed(query, label) {
	const ctx = await browser.newContext({ viewport: { width: 360, height: 540 } });
	const page = await ctx.newPage();
	const errs = [];
	page.on('pageerror', (e) => errs.push(e.message));
	await page.goto(`http://localhost:${PORT}/walk-embed${query}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
	await page.waitForTimeout(4500);
	const info = await page.evaluate(() => {
		const w = window;
		const r = w.__walkRenderer || null;
		return {
			// Read the live three.js scene state via the canvas pixel as a proxy:
			// sample the center-top pixel (sky region) of the WebGL canvas.
			topPixel: (() => {
				const c = document.getElementById('walk-canvas');
				if (!c) return null;
				// Use a 2d snapshot via drawImage into an offscreen canvas.
				const off = document.createElement('canvas');
				off.width = c.width; off.height = c.height;
				const g = off.getContext('2d');
				g.drawImage(c, 0, 0);
				const px = g.getImageData(Math.floor(c.width/2), 6, 1, 1).data;
				return { r: px[0], g: px[1], b: px[2], a: px[3] };
			})(),
			status: document.getElementById('walk-status')?.textContent || null,
		};
	});
	const fatal = errs.filter((m) => !/swiftshader|webgl|GroupMarker|TextureProxy|GL_/i.test(m));
	console.log(label.padEnd(26), JSON.stringify(info.topPixel), 'errs:', fatal.length ? fatal : 'none');
	await ctx.close();
}

await probeEmbed('?env=studio', 'studio (transparent)');
await probeEmbed('?env=beach', 'beach (sky blue)');
await probeEmbed('?env=sunset', 'sunset (orange)');
await probeEmbed('?env=night', 'night (dark)');
await probeEmbed('?bg=%23101820&env=beach', 'bg #101820 + env=beach');

await browser.close();
