import { chromium } from 'playwright';
const BASE = 'http://localhost:8080';
const RH_COIN = '0x6b21b4567EfAd992B65f8a92457B45a74ed59486';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.on('response', (res) => {
  if (res.status() >= 400) console.log(res.status(), res.url());
});
await page.goto(`${BASE}/temporary?coin=${RH_COIN}&name=E2ETester`, { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForTimeout(6000);
await browser.close();
