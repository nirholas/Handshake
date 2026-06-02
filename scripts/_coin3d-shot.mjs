import puppeteer from 'puppeteer';
const url = 'http://localhost:3000/coin3d?mint=DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1200, height: 800 });
const errors = [], warns = [];
page.on('console', m => { if (m.type()==='error') errors.push(m.text()); if (m.type()==='warning') warns.push(m.text()); });
page.on('pageerror', e => errors.push('PAGEERROR: '+e.message));
await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
await page.waitForFunction(() => {
  const hud = document.getElementById('hud'); const st = document.getElementById('status');
  return (hud && !hud.hidden) || (st && st.dataset.kind === 'error');
}, { timeout: 20000 }).catch(()=>{});
await new Promise(r => setTimeout(r, 2500));
const state = await page.evaluate(() => ({
  hudVisible: !document.getElementById('hud').hidden,
  statusKind: document.getElementById('status')?.dataset.kind || null,
  statusHidden: document.getElementById('status')?.hidden,
  title: document.title,
  hudText: document.getElementById('hud')?.innerText?.replace(/\s+/g,' ').slice(0,220),
}));
await page.screenshot({ path: 'scripts/_coin3d.png' });
console.log('STATE', JSON.stringify(state));
console.log('ERRORS', errors.length, JSON.stringify(errors.slice(0,8)));
console.log('WARNS', warns.length, JSON.stringify(warns.slice(0,4)));
await browser.close();
