import puppeteer from 'puppeteer';
const browser = await puppeteer.launch({
  headless: 'new',
  executablePath: '/home/codespace/.cache/puppeteer/chrome/linux-148.0.7778.97/chrome-linux64/chrome',
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
const errors = [];
const consoleMsgs = [];
page.on('console', (m) => consoleMsgs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('requestfailed', (r) => errors.push(`reqfailed: ${r.url()} - ${r.failure()?.errorText}`));

await page.goto('http://localhost:3001/marketplace', { waitUntil: 'networkidle2', timeout: 30000 });
await new Promise((r) => setTimeout(r, 600));

await page.screenshot({ path: '/tmp/snap-marketplace-grid.png', fullPage: false });

// Simulate opening a time-pass purchase by directly invoking helpers from window scope.
// Helpers aren't exported, so we exercise via DOM only: open the payment modal manually
// to confirm the new chrome renders.
await page.evaluate(() => {
  document.getElementById('payment-modal-title').textContent = 'Get 2h access';
  const lede = document.getElementById('payment-modal-lede'); if (lede) lede.textContent = 'You are renting temporary access to this skill:';
  const fromLbl = document.getElementById('payment-item-from'); if (fromLbl) fromLbl.textContent = 'on agent';
  const badge = document.getElementById('payment-modal-badge');
  badge.hidden = false;
  badge.className = 'payment-modal-badge warn';
  badge.innerHTML = '<span class="payment-modal-badge-icon" aria-hidden="true">⏱</span><span>Access expires 2 hours after purchase. Not a permanent unlock.</span>';
  document.getElementById('payment-skill-name').textContent = 'web-search';
  document.getElementById('payment-agent-name').textContent = 'MyResearchAgent';
  document.getElementById('payment-price-display').textContent = '0.50 USDC';
  document.getElementById('payment-confirm-btn').textContent = 'Pay & unlock 2h access';
  document.getElementById('payment-modal-overlay').hidden = false;
});
await new Promise((r) => setTimeout(r, 400));
await page.screenshot({ path: '/tmp/snap-marketplace-timepass-modal.png', fullPage: false });

// Now show success card
await page.evaluate(() => {
  const body = document.getElementById('payment-modal-body');
  const success = document.getElementById('payment-modal-success');
  body.hidden = true;
  success.hidden = false;
  success.innerHTML = `
    <div class="ps-check" aria-hidden="true">✓</div>
    <h3 class="ps-title">2h access unlocked</h3>
    <p class="ps-sub">web-search is now usable. Access ends 2 hours from now.</p>
    <div class="ps-actions">
      <button type="button" class="btn-secondary" data-success-close>Done</button>
    </div>`;
});
await new Promise((r) => setTimeout(r, 300));
await page.screenshot({ path: '/tmp/snap-marketplace-success.png', fullPage: false });

// Now show verify-again
await page.evaluate(() => {
  const body = document.getElementById('payment-modal-body');
  const success = document.getElementById('payment-modal-success');
  body.hidden = false;
  success.hidden = true;
  document.getElementById('payment-confirm-btn').hidden = true;
  const status = document.getElementById('payment-status');
  status.className = 'payment-status';
  status.innerHTML = `
    <div class="payment-modal-retry">
      <p>Payment is on-chain but the server hasn't seen it yet. Re-verify below.</p>
      <div class="retry-tx">Tx: <a href="https://solscan.io/tx/abcdef" target="_blank" rel="noopener">abcdef012345…</a></div>
      <div class="retry-actions">
        <button type="button" class="retry-primary" data-retry-verify>Verify again</button>
        <button type="button" class="retry-secondary" data-retry-close>Close</button>
      </div>
    </div>`;
});
await new Promise((r) => setTimeout(r, 300));
await page.screenshot({ path: '/tmp/snap-marketplace-retry.png', fullPage: false });

console.log('--- console msgs ---');
for (const m of consoleMsgs.slice(-20)) console.log(m);
console.log('--- errors ---');
for (const e of errors) console.log(e);
await browser.close();
