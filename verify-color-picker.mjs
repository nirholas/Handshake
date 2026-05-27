import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

console.log('--- Step 1: Navigate and scroll to Playground ---');
await page.goto('http://localhost:3000/pages/home-next.html', { waitUntil: 'load', timeout: 30000 });
await page.waitForTimeout(3000);

// Scroll to the embed/playground section
await page.locator('#embed').scrollIntoViewIfNeeded({ timeout: 10000 });
await page.waitForTimeout(500);
await page.screenshot({ path: '/tmp/ss-01-playground.png', fullPage: false });
console.log('Screenshot: /tmp/ss-01-playground.png');

console.log('--- Step 2: Find the BG control group and color trigger ---');
const colorTrigger = page.locator('#pg-color-trigger');
const triggerVisible = await colorTrigger.isVisible();
console.log('Color trigger visible:', triggerVisible);

// Get its bounding box
const triggerBox = await colorTrigger.boundingBox();
console.log('Trigger bounding box:', triggerBox);

// Scroll to it
await colorTrigger.scrollIntoViewIfNeeded();
await page.waitForTimeout(300);
await page.screenshot({ path: '/tmp/ss-02-bg-controls.png', fullPage: false });
console.log('Screenshot: /tmp/ss-02-bg-controls.png');

console.log('--- Step 3: Click the color trigger to open popover ---');
await colorTrigger.click();
await page.waitForTimeout(300);

const popover = page.locator('#pg-color-popover');
const popoverOpen = await popover.evaluate(el => el.classList.contains('open'));
console.log('Popover open after click:', popoverOpen);
const popoverVisible = await popover.isVisible();
console.log('Popover visible:', popoverVisible);

await page.screenshot({ path: '/tmp/ss-03-popover-open.png', fullPage: false });
console.log('Screenshot: /tmp/ss-03-popover-open.png');

// Check swatches are rendered
const swatchCount = await page.locator('.pg-color-swatch').count();
console.log('Number of color swatches:', swatchCount);

// Check hex input exists
const hexInput = page.locator('#pg-color-hex');
const hexVisible = await hexInput.isVisible();
console.log('Hex input visible:', hexVisible);

console.log('--- Step 4: Click a swatch to pick a color ---');
const thirdSwatch = page.locator('.pg-color-swatch').nth(4); // #e94560 (a red)
const swatchColor = await thirdSwatch.getAttribute('data-color');
console.log('Picking swatch color:', swatchColor);
await thirdSwatch.click();
await page.waitForTimeout(300);

// Check state: trigger should have 'active' and 'has-color' classes
const triggerHasActive = await colorTrigger.evaluate(el => el.classList.contains('active'));
const triggerHasColor = await colorTrigger.evaluate(el => el.classList.contains('has-color'));
console.log('Trigger active:', triggerHasActive, '| has-color:', triggerHasColor);

// Check hex input value
const hexVal = await hexInput.inputValue();
console.log('Hex input value:', hexVal);

// Check BG preset chips are deselected
const activeBgChips = await page.locator('#pg-bg-chips .pg-chip.active').count();
console.log('Active BG preset chips after picking custom color:', activeBgChips);

// Check the swatch has active class
const swatchActive = await thirdSwatch.evaluate(el => el.classList.contains('active'));
console.log('Clicked swatch has active class:', swatchActive);

// Check the generated code includes background attribute
const codeText = await page.locator('#pg-textarea').inputValue();
console.log('Code includes background attr:', codeText.includes('background="' + swatchColor + '"'));

await page.screenshot({ path: '/tmp/ss-04-color-picked.png', fullPage: false });
console.log('Screenshot: /tmp/ss-04-color-picked.png');

console.log('--- Step 5: Click outside to close popover ---');
await page.mouse.click(100, 100);
await page.waitForTimeout(300);
const popoverOpenAfterClick = await popover.evaluate(el => el.classList.contains('open'));
console.log('Popover still open after clicking outside:', popoverOpenAfterClick);
await page.screenshot({ path: '/tmp/ss-05-popover-closed.png', fullPage: false });
console.log('Screenshot: /tmp/ss-05-popover-closed.png');

console.log('--- Step 6: Click "none" preset chip to reset color picker ---');
await page.locator('#pg-color-trigger').scrollIntoViewIfNeeded();
await page.waitForTimeout(200);
const noneChip = page.locator('#pg-bg-chips .pg-chip').first();
await noneChip.click();
await page.waitForTimeout(300);

const triggerStillActive = await colorTrigger.evaluate(el => el.classList.contains('active'));
const triggerStillHasColor = await colorTrigger.evaluate(el => el.classList.contains('has-color'));
console.log('Trigger active after "none" click:', triggerStillActive, '| has-color:', triggerStillHasColor);

const noneChipActive = await noneChip.evaluate(el => el.classList.contains('active'));
console.log('"none" chip is active:', noneChipActive);

const codeAfterReset = await page.locator('#pg-textarea').inputValue();
console.log('Code still has background attr after reset:', codeAfterReset.includes('background='));

await page.screenshot({ path: '/tmp/ss-06-reset.png', fullPage: false });
console.log('Screenshot: /tmp/ss-06-reset.png');

console.log('--- Step 7: Probe - type hex value directly ---');
await colorTrigger.scrollIntoViewIfNeeded();
await colorTrigger.click();
await page.waitForTimeout(300);
const hexInputField = page.locator('#pg-color-hex');
await hexInputField.fill('#00ff88');
await page.waitForTimeout(300);

const triggerAfterHex = await colorTrigger.evaluate(el => el.classList.contains('active'));
console.log('Trigger active after typing hex:', triggerAfterHex);

const codeAfterHex = await page.locator('#pg-textarea').inputValue();
console.log('Code includes typed hex:', codeAfterHex.includes('#00ff88'));

await page.screenshot({ path: '/tmp/ss-07-hex-typed.png', fullPage: false });
console.log('Screenshot: /tmp/ss-07-hex-typed.png');

console.log('--- Step 8: Probe - Enter key in hex input closes popover ---');
await hexInputField.fill('#ff00aa');
await hexInputField.press('Enter');
await page.waitForTimeout(300);
const popoverAfterEnter = await popover.evaluate(el => el.classList.contains('open'));
console.log('Popover closed after Enter:', !popoverAfterEnter);
await page.screenshot({ path: '/tmp/ss-08-enter-close.png', fullPage: false });

console.log('\n=== All Steps Complete ===');

await browser.close();
