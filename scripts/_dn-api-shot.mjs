import { chromium } from 'playwright';
const url = process.argv[2] || 'http://127.0.0.1:3010/dashboard-next/api';
const out = process.argv[3] || '/tmp/dn-api.png';
const b = await chromium.launch({ args: ['--use-gl=swiftshader','--no-sandbox'] });
const ctx = await b.newContext({ viewport: { width: 1440, height: 1600 } });
await ctx.route('**/api/auth/me', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ user: { id: '00000000-0000-0000-0000-000000000001', display_name: 'Test', email: 'test@three.ws' } }) }));
await ctx.route('**/api/csrf-token', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ token: 'dummy' }) }));
await ctx.route('**/api/keys', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ keys: [
  { id: 'k1', name: 'Production', prefix: 'sk_live_abc123', scope: 'avatars:read avatars:write', created_at: new Date(Date.now() - 86400000*5).toISOString(), expires_at: null, last_used_at: new Date(Date.now() - 3600000).toISOString(), revoked_at: null },
  { id: 'k2', name: 'CI tests', prefix: 'sk_test_def456', scope: 'avatars:read profile', created_at: new Date(Date.now() - 86400000*30).toISOString(), expires_at: null, last_used_at: null, revoked_at: null },
] }) }));
await ctx.route('**/api/avatars*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ avatars: [ { id: 'ava-001', name: 'Hero avatar' }, { id: 'ava-002', name: 'Side avatar' } ] }) }));
await ctx.route('**/api/widgets', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ widgets: [ { id: 'wdgt_abc', name: 'Landing chat', avatar_id: 'ava-001' } ] }) }));
await ctx.route('**/api/agents', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ agents: [
  { id: '11111111-1111-1111-1111-111111111111', name: 'Hero agent', avatar_id: 'ava-001' },
  { id: '22222222-2222-2222-2222-222222222222', name: 'Sales agent', avatar_id: 'ava-002' },
] }) }));
await ctx.route('**/api/agents/**/embed-policy', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ policy: { version: 1, origins: { mode: 'allowlist', hosts: ['example.com'] }, surfaces: { script: true, iframe: true, widget: true, mcp: false }, brain: { mode: 'we-pay', proxy_url: null, monthly_quota: 1000, rate_limit_per_min: 10, model: 'meta-llama/llama-3.3-70b-instruct:free' }, storage: { primary: 'r2', pinned_ipfs: false, onchain_attested: false } } }) }));

const p = await ctx.newPage();
const all = [];
p.on('pageerror', e => all.push('PAGEERROR ' + e.message.slice(0, 300)));
p.on('console',  m => { if (m.type() === 'error') all.push('[err] ' + m.text().slice(0, 300)); });
p.on('response', r => { if (r.status() >= 400) all.push(`HTTP ${r.status()} ${r.url()}`); });
p.on('requestfailed', r => { const u = r.url(); if (!/embed\.js|model\.gltf|\.glb|\.png$|\.jpg$|cdn/i.test(u)) all.push('REQ FAIL ' + u + ' ' + r.failure()?.errorText); });
await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await p.waitForTimeout(3000);
await p.screenshot({ path: out, fullPage: true });
console.log('saved', out);
for (const e of all) console.log(' ' + e);
await b.close();
