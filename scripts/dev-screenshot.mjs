import { chromium } from 'playwright';
const OUT = process.env.SHOT_DIR || process.cwd();
const b = await chromium.launch();
for (const t of process.argv.slice(2)) {
  const [url, name, w] = t.split('::');
  const p = await b.newPage({ viewport: { width: Number(w) || 1440, height: 1400 } });
  const errs = [];
  p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('WebSocket')) errs.push('err: ' + m.text().slice(0, 160)); });
  await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch((e) => console.log('nav', e.message.split('\n')[0]));
  await p.waitForTimeout(7000);
  await p.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
  console.log('--- ' + name + ' | ' + p.url());
  errs.slice(0, 6).forEach((e) => console.log('   ' + e));
  await p.close();
}
await b.close();
