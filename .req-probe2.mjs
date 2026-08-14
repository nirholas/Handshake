import { chromium } from 'playwright';
const url = process.argv[2];
const watch = process.argv.slice(3);
const b = await chromium.launch({ args: ['--no-sandbox'] });
const p = await b.newPage({ viewport: { width: 1350, height: 940 } });
const reqs = [];
p.on('request', (r) => reqs.push(r.url()));
await p.goto(url, { waitUntil: 'load', timeout: 90000 });
await p.waitForTimeout(5000);
const report = (label) => {
  console.log('---', label, '(requests:', reqs.length + ')');
  for (const w of watch) console.log('   ', reqs.some(u => u.includes(w)) ? 'LOADED  ' : 'deferred', w);
};
report('at load+5s');
// Progressive scroll, the way a human reads the page.
for (let i = 0; i < 40; i++) {
  await p.evaluate(() => window.scrollBy(0, innerHeight * 0.9));
  await p.waitForTimeout(350);
}
await p.waitForTimeout(4000);
report('after progressive scroll to bottom');
const vis = await p.evaluate(() => {
  const g = (id) => { const e = document.getElementById(id); if (!e) return 'absent'; const r = e.getBoundingClientRect(); return { h: Math.round(r.height), hidden: e.hidden, display: getComputedStyle(e).display }; };
  return { dragon: g('dragon-canvas-wrap'), community: g('home-community-forge') };
});
console.log('section state:', JSON.stringify(vis));
await b.close();
