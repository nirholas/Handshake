// Deep audit: stub *every* /api/* call with realistic data so we surface
// real page-level bugs (not auth failures). Visits every dashboard-next
// page and reports console errors, page errors, failed network requests,
// and HTTP >=400 from the dev origin.
//
// Usage: node scripts/_dn-deep-audit.mjs [baseUrl] [outDir]

import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://127.0.0.1:3013';
const OUT_DIR = process.argv[3] || '/tmp';

const PAGES = [
	{ name: 'home',      path: '/dashboard-next' },
	{ name: 'avatars',   path: '/dashboard-next/avatars' },
	{ name: 'library-animations', path: '/dashboard-next/library#tab=animations' },
	{ name: 'library-memory',     path: '/dashboard-next/library#tab=memory' },
	{ name: 'library-strategy',   path: '/dashboard-next/library#tab=strategy' },
	{ name: 'library-voice',      path: '/dashboard-next/library#tab=voice' },
	{ name: 'widgets',   path: '/dashboard-next/widgets' },
	{ name: 'api',       path: '/dashboard-next/api' },
	{ name: 'monetize',  path: '/dashboard-next/monetize' },
	{ name: 'account',   path: '/dashboard-next/account' },
];

const ME = { id: 'u_demo', display_name: 'Nicholas', handle: 'nicholas', username: 'nicholas', email: 'nicholas@three.ws', plan: 'pro', created_at: new Date(Date.now() - 90*86400_000).toISOString() };

const AGENT_A = { id: '11111111-1111-1111-1111-111111111111', name: 'Argentina #10', skills: ['greet'], voice_id: 'EXAVITQu4vr4xnSDxMaL', voice_provider: 'elevenlabs', meta: { animations: [
	{ name: 'wave',      url: '/animations/robotexpressive.glb', source: 'preset', loop: false, addedAt: new Date(Date.now()-86400_000).toISOString() },
	{ name: 'celebrate', url: '/animations/robotexpressive.glb', source: 'preset', loop: false },
]}, created_at: new Date().toISOString() };
const AGENT_B = { id: '22222222-2222-2222-2222-222222222222', name: 'Rider VR', skills: ['greet'], voice_id: null, voice_provider: 'browser', meta: { animations: [] }, created_at: new Date().toISOString() };

const AVATAR_1 = { id: 'av1', name: 'Argentina #10', slug: 'arg-10', visibility: 'public', model_url: 'https://three.ws/animations/soldier.glb', thumbnail_url: null, created_at: new Date(Date.now()-86400_000).toISOString() };

const WIDGET_1 = { id: 'w_demo1', name: 'Greeter', kind: 'agent', status: 'active', visibility: 'public', created_at: new Date(Date.now()-86400_000).toISOString(), config: { agent_id: AGENT_A.id }, embed_url: '/widget?id=w_demo1' };

const REVENUE = {
	summary: { gross_total: 12_500_000, fee_total: 500_000, net_total: 12_000_000, payment_count: 18 },
	by_skill: [],
	timeseries: Array.from({ length: 14 }, (_, i) => ({ period: new Date(Date.now()-(13-i)*86400_000).toISOString().slice(0,10), net_total: Math.round(200_000 + Math.random()*1_200_000), count: i+1 })),
};

const STUBS = [
	[/\/api\/auth\/me$/,             () => ME],
	[/\/api\/csrf-token$/,           () => ({ token: 'audit' })],
	[/\/api\/auth\/wallets/,         () => ({ wallets: [] })],
	[/\/api\/avatars(\?|$)/,         () => ({ avatars: [AVATAR_1], next_cursor: null, total: 1 })],
	[/\/api\/avatars\/[^/]+$/,       () => ({ avatar: AVATAR_1 })],
	[/\/api\/agents(\?|$)/,          () => ({ agents: [AGENT_A, AGENT_B] })],
	[/\/api\/agents\/me$/,           () => ({ agent: AGENT_A })],
	[/\/api\/agent-memory\?agentId=11.*/, () => ({ entries: [
		{ id: 'm1', agent_id: AGENT_A.id, type: 'project', content: 'Argentina #10 voice tuned for chant cadence.', salience: 0.7, createdAt: Date.now()-3600_000 },
	]})],
	[/\/api\/agent-memory\?agentId=22.*/, () => ({ entries: [] })],
	[/\/api\/agent-memory$/,         () => ({ entry: { id: 'mnew', agent_id: AGENT_A.id, type: 'project', content: 'new', salience: 0.6, createdAt: Date.now() }})],
	[/\/api\/agent-strategy.*id=11.*/, () => ({ data: { strategy: { objective: 'engage', max_position_sol: 0.5 } } })],
	[/\/api\/agent-strategy.*id=22.*/, () => ({ data: { strategy: null } })],
	[/\/api\/tts\/eleven\/voices$/,  () => ({ enabled: true, voices: [
		{ voice_id: 'EXAVITQu4vr4xnSDxMaL', name: 'Bella', category: 'premade', labels: {} },
		{ voice_id: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel', category: 'premade', labels: {} },
	]})],
	[/\/api\/widgets(\?|$)/,         () => ({ widgets: [WIDGET_1] })],
	[/\/api\/widgets\/[^/]+\/stats/, () => ({ stats: { views_7d: 412, turns_7d: 87, last_seen: new Date().toISOString() } })],
	[/\/api\/widgets\/[^/]+\/transcripts/, () => ({ transcripts: [] })],
	[/\/api\/widgets\/[^/]+\/og/,    () => ({ image_url: null })],
	[/\/api\/widgets\/[^/]+$/,       () => ({ widget: WIDGET_1 })],
	[/\/api\/keys$/,                 () => ({ keys: [{ id: 'k1', name: 'Production', prefix: 'sk_live', scopes: ['avatars:read', 'avatars:write'], created_at: new Date(Date.now()-86400_000).toISOString(), last_used_at: new Date().toISOString() }] })],
	[/\/api\/animations.*/,          () => ({ animations: [] })],
	[/\/api\/billing\/revenue/,      () => REVENUE],
	[/\/api\/billing\/withdrawals/,  () => ({ withdrawals: [] })],
	[/\/api\/billing\/payout-wallets/, () => ({ wallets: [{ id: 'w1', address: '0xabc', chain_id: 8453, label: 'Base ops' }] })],
	[/\/api\/billing\/summary/,      () => ({ plan: 'pro', limits: {}, usage: {} })],
	[/\/api\/subscriptions\/mine/,   () => ({ subscriptions: [] })],
	[/\/api\/subscriptions\/plans/,  () => ({ plans: [] })],
	[/\/api\/subscriptions(\?|$)/,   () => ({ subscriptions: [] })],
	[/\/api\/users\/me\/earnings/,   () => ({ pending_usd: 12.34, paid_total_usd: 100, currency: 'usd' })],
	[/\/api\/users\/me/,             () => ({ user: ME })],
	[/\/api\/audit-log/,             () => ({ events: [], next_cursor: null })],
	[/\/api\/notifications/,         () => ({ notifications: [] })],
	[/\/api\/events/,                () => ({ events: [] })],
	[/\/api\/agents\/[^/]+\/payments/, () => ({ payments: [], next_cursor: null })],
	[/\/api\/agents\/[^/]+\/voice/,    () => ({ voice_provider: 'browser', voice_id: null, voice_cloned_at: null })],
	[/\/api\/_mcp\/embed-policy/,      () => ({ policy: null })],
];

async function maybeStub(route) {
	const url = route.request().url();
	for (const [re, fn] of STUBS) {
		if (re.test(url)) {
			const body = fn();
			return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
		}
	}
	return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'unstubbed', url: url.replace(BASE, '') }) });
}

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--no-sandbox'] });
const summary = [];

for (const page of PAGES) {
	const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
	const p = await ctx.newPage();
	const errs = { page: [], req: [], http: [], unstubbed: [] };
	p.on('pageerror',     (e) => errs.page.push('PAGEERROR ' + e.message.slice(0, 260)));
	p.on('console',       (m) => { if (m.type() === 'error') errs.page.push('CONSOLE ' + m.text().slice(0, 260)); });
	p.on('requestfailed', (r) => {
		const u = r.url();
		if (u.includes('posthog') || u.includes('analytics')) return;
		errs.req.push(`${u.replace(BASE, '')} ${r.failure()?.errorText || ''}`);
	});
	p.on('response', async (r) => {
		const u = r.url();
		if (!u.includes('/api/')) return;
		if (r.status() >= 400) {
			try {
				const txt = await r.text();
				if (txt.includes('unstubbed')) errs.unstubbed.push(`${r.status()} ${u.replace(BASE, '')}`);
				else                            errs.http.push(`${r.status()} ${u.replace(BASE, '')}`);
			} catch { errs.http.push(`${r.status()} ${u.replace(BASE, '')}`); }
		}
	});

	await ctx.route('**/api/**', maybeStub);

	const url = BASE + page.path;
	try {
		await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
		await p.waitForSelector('.dn-shell .dn-rail-item', { timeout: 20_000 });
		await p.waitForTimeout(3500);
		await p.screenshot({ path: `${OUT_DIR}/dn-audit-${page.name}.png`, fullPage: false });
	} catch (e) {
		errs.page.push('NAV_FAIL ' + e.message.slice(0, 200));
	}
	summary.push({ page: page.name, url: page.path, ...errs });
	await ctx.close();
}

await browser.close();

let totalProblems = 0;
for (const s of summary) {
	console.log(`\n=== ${s.page}  (${s.url}) ===`);
	if (s.page.length)     { console.log('  page errors:');       for (const e of s.page) console.log('   - ' + e); totalProblems += s.page.length; }
	if (s.req.length)      { console.log('  failed requests:');   for (const e of s.req)  console.log('   - ' + e); totalProblems += s.req.length; }
	if (s.http.length)     { console.log('  http >=400:');        for (const e of s.http) console.log('   - ' + e); totalProblems += s.http.length; }
	if (s.unstubbed.length){ console.log('  unstubbed routes:');  for (const e of s.unstubbed) console.log('   - ' + e); totalProblems += s.unstubbed.length; }
	if (!s.page.length && !s.req.length && !s.http.length && !s.unstubbed.length) console.log('  clean');
}
console.log(`\n${totalProblems} problems across ${summary.length} pages.`);
process.exit(totalProblems ? 1 : 0);
