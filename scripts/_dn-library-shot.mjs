import { chromium } from 'playwright';

const url = process.argv[2];
const out = process.argv[3];

const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--no-sandbox'] });
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message.slice(0, 220)));
p.on('console',  (m) => { if (m.type() === 'error') errs.push('[err] ' + m.text().slice(0, 220)); });
p.on('requestfailed', (r) => errs.push('REQ FAIL ' + r.url() + ' ' + (r.failure()?.errorText || '')));

const ME = { id: 'u_demo', display_name: 'Nicholas', handle: 'nicholas', email: 'nicholas@three.ws' };

const A1 = {
	id: '11111111-1111-1111-1111-111111111111',
	name: 'Argentina #10',
	skills: ['greet'],
	meta: {
		animations: [
			{ name: 'wave',       url: '/animations/robotexpressive.glb', source: 'preset', loop: false, addedAt: new Date(Date.now()-86400000).toISOString() },
			{ name: 'celebrate',  url: '/animations/robotexpressive.glb', source: 'preset', loop: false, addedAt: new Date(Date.now()-86400000*2).toISOString() },
			{ name: 'my-dance',   url: 'u/u_demo/animations/my-dance.glb', source: 'custom', loop: true,  addedAt: new Date(Date.now()-3600_000).toISOString() },
		],
	},
	voice_provider: 'elevenlabs',
	voice_id: 'EXAVITQu4vr4xnSDxMaL',
	created_at: new Date().toISOString(),
};
const A2 = {
	id: '22222222-2222-2222-2222-222222222222',
	name: 'Rider VR',
	skills: ['greet'],
	meta: { animations: [{ name: 'idle', url: '/animations/robotexpressive.glb', source: 'preset', loop: true }] },
	voice_provider: 'browser',
	voice_id: null,
	created_at: new Date().toISOString(),
};
const AGENTS = { agents: [A1, A2] };

const MEM_A1 = {
	entries: [
		{ id: 'm1', agent_id: A1.id, type: 'project', content: 'Argentina #10 voice & tone tuned for chant cadence. Sound short, sharp, terrace-friendly.', salience: 0.7, createdAt: Date.now()-3600_000 },
		{ id: 'm2', agent_id: A1.id, type: 'feedback', content: 'User prefers replies that end with a question; keep tone confident, not over-eager.', salience: 0.6, createdAt: Date.now()-2*3600_000 },
		{ id: 'm3', agent_id: A1.id, type: 'reference', content: 'Wallet on Base. USDC only for tips. Token CA: FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump', salience: 0.5, createdAt: Date.now()-86400_000 },
	],
};
const MEM_A2 = {
	entries: [
		{ id: 'm4', agent_id: A2.id, type: 'user', content: 'Operates inside Rider VR cabin; gestures are big, hand-tracked, low latency.', salience: 0.55, createdAt: Date.now()-86400_000*3 },
	],
};

const STRATEGY = {
	[A1.id]: { objective: 'engage Boca/River fans, drive tip flow', max_position_sol: 0.5, stop_loss_pct: 20 },
	[A2.id]: { objective: 'in-VR concierge, never breaks character', latency_ms_target: 250 },
};

const VOICES = { enabled: true, voices: [
	{ voice_id: 'EXAVITQu4vr4xnSDxMaL', name: 'Bella',    category: 'premade', labels: { accent: 'american' } },
	{ voice_id: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel',   category: 'premade', labels: { accent: 'american' } },
	{ voice_id: 'TxGEqnHWrfWFTfGW9XjX', name: 'Josh',     category: 'premade', labels: { accent: 'american' } },
]};

async function fulfill(route, body, status = 200) {
	await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

await ctx.route('**/api/auth/me',                 (r) => fulfill(r, ME));
await ctx.route('**/api/csrf-token',              (r) => fulfill(r, { token: 'test' }));
await ctx.route('**/api/agents',                  (r) => fulfill(r, AGENTS));
await ctx.route('**/api/agents/me',               (r) => fulfill(r, { agent: A1 }));
await ctx.route(/\/api\/agent-memory\?agentId=11.*/i, (r) => fulfill(r, MEM_A1));
await ctx.route(/\/api\/agent-memory\?agentId=22.*/i, (r) => fulfill(r, MEM_A2));
await ctx.route('**/api/agent-memory',            (r) => fulfill(r, { entry: { id: 'mnew', agent_id: A1.id, type: 'project', content: 'new memory', salience: 0.6, createdAt: Date.now() } }, 201));
await ctx.route(/\/api\/agent-strategy.*id=11.*/i, (r) => fulfill(r, { data: { strategy: STRATEGY[A1.id] } }));
await ctx.route(/\/api\/agent-strategy.*id=22.*/i, (r) => fulfill(r, { data: { strategy: STRATEGY[A2.id] } }));
await ctx.route('**/api/tts/eleven/voices',       (r) => fulfill(r, VOICES));
await ctx.route('**/api/events*',                 (r) => fulfill(r, {}, 404));

await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await p.waitForSelector('.dn-shell .dn-rail-item', { timeout: 20000 });
await p.waitForSelector('.lib-tab', { timeout: 10000 });
await p.waitForTimeout(2000);
await p.screenshot({ path: out, fullPage: false });
console.log('saved', out);
if (errs.length) {
	console.log('errors:');
	for (const e of errs) console.log(' ' + e);
	process.exitCode = 1;
}
await b.close();
