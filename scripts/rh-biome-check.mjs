import { chromium } from 'playwright';
const BASE = 'http://localhost:8080';
const RH_COIN = '0x6b21b4567EfAd992B65f8a92457B45a74ed59486';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(`${BASE}/play?coin=${RH_COIN}&name=BiomeCheck`, { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForTimeout(5000);
// Dismiss the controls overlay if present (Esc closes it per the HUD legend).
await page.keyboard.press('Escape').catch(() => {});
await page.waitForTimeout(500);
const biomeId = await page.evaluate(() => window.__CC__?.env?.biome?.id || null);
const biomeLabel = await page.evaluate(() => window.__CC__?.env?.biome?.label || null);
console.log('biome.id =', biomeId, '| label =', biomeLabel);
await page.screenshot({ path: '/tmp/claude-1000/-workspaces-three-ws/bbd67923-b6d3-4593-92c8-9acb04d85900/scratchpad/rh-world-clean.png' });
await browser.close();
