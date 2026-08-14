import { chromium } from 'playwright';
const url = process.argv[2];
const b = await chromium.launch({ args: ['--no-sandbox'] });
const p = await b.newPage({ viewport: { width: 1350, height: 940 } });
await p.addInitScript(() => {
  window.__shifts = [];
  new PerformanceObserver((l) => {
    for (const e of l.getEntries()) {
      if (e.hadRecentInput) continue;
      window.__shifts.push({
        value: e.value,
        t: Math.round(e.startTime),
        sources: (e.sources || []).map((s) => {
          const n = s.node;
          if (!n || !n.tagName) return '(detached)';
          return n.tagName.toLowerCase() + (n.id ? '#' + n.id : '') +
            (n.className && typeof n.className === 'string' ? '.' + n.className.trim().split(/\s+/).join('.') : '');
        }),
      });
    }
  }).observe({ type: 'layout-shift', buffered: true });
});
await p.goto(url, { waitUntil: 'load', timeout: 90000 });
await p.waitForTimeout(8000);
const shifts = await p.evaluate(() => window.__shifts);
const total = shifts.reduce((a, s) => a + s.value, 0);
console.log('URL', url, 'CLS', total.toFixed(4));
shifts.sort((a, b) => b.value - a.value).slice(0, 10)
  .forEach((s) => console.log(' ', s.value.toFixed(4), '@' + s.t + 'ms', s.sources.slice(0, 3).join(' | ').slice(0, 160)));
await b.close();
