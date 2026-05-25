import { chromium } from 'playwright';
const url = process.argv[2]; const out = process.argv[3];
const b = await chromium.launch({ args: ['--use-gl=swiftshader','--no-sandbox'] });
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', e => errs.push('PAGEERROR ' + e.message.slice(0, 200)));
p.on('console',  m => { if (m.type() === 'error') errs.push('[err] ' + m.text().slice(0, 200)); });

// Stub auth + data endpoints so the page actually renders. This is
// verification-only — never shipped to users.
const ME = { id: 'u_demo', display_name: 'Nicholas', handle: 'nicholas', email: 'nicholas@three.ws', plan: 'pro' };
const AVATARS = {
  avatars: [
    { id: 'a1', name: 'Argentina #10',  slug: 'arg-10',  created_at: new Date(Date.now()-86400000).toISOString() },
    { id: 'a2', name: 'Rider VR',       slug: 'rider',   created_at: new Date(Date.now()-2*86400000).toISOString() },
    { id: 'a3', name: 'Producer',       slug: 'producer',created_at: new Date(Date.now()-3*86400000).toISOString() },
    { id: 'a4', name: 'Wanderer',       slug: 'wander',  created_at: new Date(Date.now()-4*86400000).toISOString() },
    { id: 'a5', name: 'Casino Host',    slug: 'casino',  created_at: new Date(Date.now()-5*86400000).toISOString() },
    { id: 'a6', name: 'Studio Avatar',  slug: 'studio',  created_at: new Date(Date.now()-6*86400000).toISOString() },
  ],
  next_cursor: null,
  total: 6,
};
const WIDGETS = { widgets: [{}, {}, {}] };
const REVENUE = {
  summary: { gross_total: 12_500_000, fee_total: 500_000, net_total: 12_000_000, payment_count: 18 },
  by_skill: [],
  timeseries: Array.from({ length: 14 }, (_, i) => ({ period: new Date(Date.now()-(13-i)*86400000).toISOString().slice(0,10), net_total: Math.round(200_000 + Math.random()*1_200_000), count: i+1 })),
};
const SUBS = { data: [{ status:'active' }, { status:'active' }, { status:'canceled' }] };

async function fulfill(route, body, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}
await ctx.route('**/api/auth/me',          (r) => fulfill(r, ME));
await ctx.route('**/api/csrf-token',       (r) => fulfill(r, { token: 'test' }));
await ctx.route('**/api/avatars*',         (r) => fulfill(r, AVATARS));
await ctx.route('**/api/widgets*',         (r) => fulfill(r, WIDGETS));
await ctx.route('**/api/billing/revenue*', (r) => fulfill(r, REVENUE));
await ctx.route('**/api/subscriptions*',   (r) => fulfill(r, SUBS));
await ctx.route('**/api/events*',          (r) => r.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not_found"}' }));

await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await p.waitForSelector('.dn-shell .dn-rail-item', { timeout: 20000 });
// Give cards / avatar component a moment to paint
await p.waitForTimeout(3500);
await p.screenshot({ path: out, fullPage: true });
console.log('saved', out);
if (errs.length) { console.log('errors:'); for (const e of errs) console.log(' ' + e); }
await b.close();
