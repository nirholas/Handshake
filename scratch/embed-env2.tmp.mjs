import { chromium } from 'playwright';
const PORT = process.env.PORT || '3000';

async function probe(query, label) {
	const browser = await chromium.launch({
		args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
	});
	const page = await browser.newPage();
	const errs = [];
	page.on('pageerror', (e) => errs.push(e.message));
	await page.goto(`http://localhost:${PORT}/walk-embed${query}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
	await page.waitForTimeout(4500);
	const px = await page.evaluate(() => {
		const c = document.getElementById('walk-canvas');
		const off = document.createElement('canvas');
		off.width = c.width; off.height = c.height;
		const g = off.getContext('2d');
		g.drawImage(c, 0, 0);
		const p = g.getImageData(Math.floor(c.width/2), 6, 1, 1).data;
		return { r: p[0], g: p[1], b: p[2], a: p[3] };
	});
	const fatal = errs.filter((m) => !/swiftshader|webgl|GroupMarker|TextureProxy|GL_/i.test(m));
	console.log(label.padEnd(26), JSON.stringify(px), 'errs:', fatal.length ? fatal : 'none');
	await browser.close();
}

await probe('?env=night', 'night → 0x10141f');
await probe('?bg=%23ff0000&env=beach', 'bg=red wins over env');
