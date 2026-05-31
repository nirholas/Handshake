import { chromium } from 'playwright';
const errors = [];
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
await page.goto('http://localhost:3004/embed', { waitUntil: 'networkidle' });
await page.waitForTimeout(800);

// Open picker, wait for cards (public gallery / demo avatars), select first, confirm CTA
await page.locator('.ee-picker').first().click();
await page.waitForTimeout(1200);
const cards = page.locator('.agp-card');
const cardCount = await cards.count();
let snippet = null, chip = null, urlAfter = null;
if (cardCount > 0) {
  await cards.first().click();
  await page.waitForTimeout(300);
  const cta = page.locator('.agp-cta');
  const ctaDisabled = await cta.isDisabled();
  await cta.click();
  await page.waitForTimeout(600);
  chip = (await page.locator('.ee-picker').first().innerText()).replace(/\s+/g,' ').trim();
  snippet = await page.locator('.ee-snippet').inputValue();
  urlAfter = page.url();
  var info = { cardCount, ctaDisabled, chip, snippetHead: snippet.slice(0,120), hasAvatarParam: /avatar=/.test(snippet) || /avatar-id=/.test(snippet), urlHasAvatar: /avatar=/.test(urlAfter) };
} else {
  var info = { cardCount, note: 'no public cards returned by API in this env' };
}

// Chat mode relabel check (reset selection via manual clear, switch mode)
await page.locator('.ee-seg-btn', { hasText: 'Chat' }).first().click();
await page.waitForTimeout(200);

console.log(JSON.stringify({ ...info, errors }, null, 2));
await browser.close();
