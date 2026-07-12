import { chromium } from 'playwright';
const BASE = 'http://localhost:8080';
// A real, well-known pump.fun-style mint format (not necessarily live) just to
// compare error surface with a Solana-chain world — control group.
const CONTROL_MINT = '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.on('response', (res) => { if (res.status() >= 400) console.log(res.status(), res.url()); });
await page.goto(`${BASE}/temporary?coin=${CONTROL_MINT}&name=CtrlTester`, { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForTimeout(6000);
await browser.close();
