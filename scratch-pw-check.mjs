import { chromium } from 'playwright';

const pages = [
  { url: 'http://localhost:3000/markets/robinhood', name: 'hub' },
  { url: 'http://localhost:3000/markets/robinhood/stock/AAPL', name: 'stock-detail' },
  { url: 'http://localhost:3000/markets/robinhood/coin/0x955b339944cbd4834156366d766c260c80956b44', name: 'coin-detail' },
];

const browser = await chromium.launch();
for (const p of pages) {
  const page = await browser.newPage();
  const errors = [];
  const consoleMsgs = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  page.on('console', (msg) => { if (msg.type() === 'error') consoleMsgs.push(msg.text()); });
  await page.goto(p.url, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);
  const bodyText = await page.textContent('body');
  console.log(`\n=== ${p.name} (${p.url}) ===`);
  console.log('pageerrors:', errors.length ? errors : 'none');
  console.log('console.error:', consoleMsgs.length ? consoleMsgs : 'none');
  console.log('has AAPL text:', bodyText.includes('AAPL') || bodyText.includes('Apple'));
  console.log('body length:', bodyText.length);
  await page.screenshot({ path: `/workspaces/three.ws/scratch-${p.name}.png`, fullPage: true }).catch(()=>{});
  await page.close();
}
await browser.close();
