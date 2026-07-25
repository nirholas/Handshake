// Screenshot the sign-preview contact sheet.
// usage: node scripts/.scratch/shoot.mjs "<query>" <outfile>
import { chromium } from 'playwright';

const query = process.argv[2] || '';
const out = process.argv[3] || '/tmp/sign.png';
const browser = await chromium.launch({
	args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 1200 } });
const errors = [];
page.on('console', (m) => errors.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`http://localhost:3000/scripts/.scratch/sign-preview.html?${query}`, { waitUntil: 'load' });
try {
	await page.waitForFunction(() => document.title === 'ready', null, { timeout: 45000 });
} catch {
	console.error('TIMEOUT waiting for render');
}
await page.waitForTimeout(400);
const canvas = await page.$('canvas');
const box = canvas ? await canvas.boundingBox() : null;
await page.screenshot({ path: out, clip: box ? { x: 0, y: 0, width: box.width, height: box.height } : undefined });
if (errors.length) console.error('page errors:\n' + errors.join('\n'));
console.log('wrote', out);
await browser.close();
