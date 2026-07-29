// Reproduce the "GLTFLoader: Couldn't load texture blob:" console error seen on
// production pages, and determine whether it is a real user-facing failure or an
// artifact of the headless audit environment.
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage();

const errors = [];
page.on('console', (m) => {
	if (m.type() === 'error') errors.push(m.text().slice(0, 140));
});
page.on('pageerror', (e) => errors.push('PAGEERROR ' + String(e).slice(0, 140)));

await page.goto('https://three.ws/avatar-sdk', { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForTimeout(12000);

// Probe the environment directly: can this browser decode a real JPEG blob from
// the same GLB the page loads, via both createImageBitmap and <img>?
const probe = await page.evaluate(async () => {
	const out = {};
	const res = await fetch('/avatars/default.glb');
	const buf = new Uint8Array(await res.arrayBuffer());
	const dv = new DataView(buf.buffer);
	const jsonLen = dv.getUint32(12, true);
	const json = JSON.parse(new TextDecoder().decode(buf.subarray(20, 20 + jsonLen)));
	const binOff = 20 + jsonLen + 8;
	const img = json.images[1];
	const bv = json.bufferViews[img.bufferView];
	const data = buf.subarray(binOff + (bv.byteOffset || 0), binOff + (bv.byteOffset || 0) + bv.byteLength);
	out.mimeType = img.mimeType;
	out.firstBytes = Array.from(data.slice(0, 3)).map((b) => b.toString(16)).join(' ');

	const blob = new Blob([data], { type: img.mimeType });
	const url = URL.createObjectURL(blob);
	out.hasCreateImageBitmap = typeof createImageBitmap === 'function';
	try {
		const bmp = await createImageBitmap(blob);
		out.imageBitmap = `ok ${bmp.width}x${bmp.height}`;
	} catch (e) {
		out.imageBitmap = 'FAIL ' + String(e).slice(0, 100);
	}
	out.imgTag = await new Promise((resolve) => {
		const el = new Image();
		el.onload = () => resolve(`ok ${el.naturalWidth}x${el.naturalHeight}`);
		el.onerror = (e) => resolve('FAIL ' + (e?.message || 'load error'));
		el.src = url;
		setTimeout(() => resolve('TIMEOUT'), 8000);
	});
	// Blob with an EMPTY mime type: the shape a stripped mimeType would produce.
	const bare = URL.createObjectURL(new Blob([data]));
	out.imgTagNoMime = await new Promise((resolve) => {
		const el = new Image();
		el.onload = () => resolve(`ok ${el.naturalWidth}x${el.naturalHeight}`);
		el.onerror = () => resolve('FAIL');
		el.src = bare;
		setTimeout(() => resolve('TIMEOUT'), 8000);
	});
	return out;
});

console.log('--- console errors captured ---');
const counts = new Map();
for (const e of errors) {
	const key = e.replace(/blob:https?:\/\/\S+/, 'BLOB').replace(/https?:\/\/\S+/, 'URL');
	counts.set(key, (counts.get(key) || 0) + 1);
}
for (const [k, v] of [...counts.entries()].sort((a, b) => b[1] - a[1])) console.log(v + 'x', k);
console.log('--- environment probe ---');
console.log(JSON.stringify(probe, null, 2));

await browser.close();
