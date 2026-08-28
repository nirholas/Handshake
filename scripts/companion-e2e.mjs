// End-to-end exercise of the companion against the REAL database and the REAL
// handlers, with no HTTP server in between: it calls the exported handlers with
// mock req/res objects exactly as the Cloud Run router does, on a throwaway
// user it deletes afterwards.
//
//   npm run companion:e2e
//
// It needs DATABASE_URL (.env.local), writes only rows it owns, and exits
// non-zero on the first failed check, so it is safe to run against production
// and useful as a post-deploy proof that the whole path still works: settings
// provisioning, the bridge endpoint, triage, contact attribution, quiet hours,
// idempotency, the feed, and the live SSE stream.

const { sql } = await import('../api/_lib/db.js');

// A throwaway user, cleaned up at the end.
const email = `companion-e2e-${Date.now()}@example.test`;
const [user] = await sql`
	insert into users (email, username, password_hash)
	values (${email}, ${`ce2e${Date.now()}`}, 'x')
	returning id, email
`;
console.log('user', user.id);

function mockRes() {
	const res = {
		statusCode: 0,
		headers: {},
		body: '',
		writableEnded: false,
		setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
		getHeader(k) { return this.headers[k.toLowerCase()]; },
		removeHeader(k) { delete this.headers[k.toLowerCase()]; },
		writeHead(code, hdrs) { this.statusCode = code; Object.assign(this.headers, hdrs || {}); return this; },
		write(chunk) { this.body += chunk; return true; },
		end(chunk) { if (chunk) this.body += chunk; this.writableEnded = true; return this; },
		on() {},
		json() { try { return JSON.parse(this.body); } catch { return this.body; } },
	};
	return res;
}

function mockReq({ method = 'GET', url = '/', body = null, headers = {}, query = {} } = {}) {
	const payload = body ? JSON.stringify(body) : '';
	const req = {
		method,
		url,
		query,
		headers: { host: 'three.ws', 'content-type': 'application/json', ...headers },
		socket: { remoteAddress: '127.0.0.1' },
		on(event, handler) {
			if (event === 'data' && payload) handler(Buffer.from(payload));
			if (event === 'end') handler();
			return req;
		},
		[Symbol.asyncIterator]: async function* () { if (payload) yield Buffer.from(payload); },
	};
	return req;
}

async function call(modulePath, options) {
	const mod = await import(modulePath);
	const res = mockRes();
	await mod.default(mockReq(options), res);
	return { status: res.statusCode, data: res.json() };
}

const results = [];
function check(name, ok, detail = '') {
	results.push({ name, ok, detail });
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}

try {
	// 1. Settings provisioning (this is what a first page load does).
	const { getSettings, upsertContact, listEvents } = await import('../api/_lib/companion/store.js');
	const settings = await getSettings(user.id);
	check('settings provision a bridge token', /^cmp_/.test(settings.ingest_token), settings.ingest_token.slice(0, 12) + '…');
	check('default threshold is 60', settings.threshold === 60);

	// 2. The bridge endpoint, with the real token, through the real handler.
	const low = await call('../api/companion/ingest.js', {
		method: 'POST',
		url: '/api/companion/ingest',
		headers: { authorization: `Bearer ${settings.ingest_token}` },
		body: { title: 'Weekly newsletter: 10 things to read', sender: 'Digest', sender_id: 'noreply@digest.example', app: 'Email' },
	});
	check('a newsletter is stored, not spoken', low.status === 201 && low.data.event.delivered === false, `score ${low.data?.event?.importance}`);

	const high = await call('../api/companion/ingest.js', {
		method: 'POST',
		url: '/api/companion/ingest',
		headers: { authorization: `Bearer ${settings.ingest_token}` },
		body: { title: 'Your verification code is 449201', sender: 'Bank', sender_id: 'security@bank.example', app: 'Messages', priority: 'high' },
	});
	check('a one-time code is delivered', high.status === 201 && high.data.event.delivered === true, `score ${high.data?.event?.importance}`);

	// 3. Idempotency: the same id twice is one delivery.
	const once = await call('../api/companion/ingest.js', {
		method: 'POST', url: '/api/companion/ingest',
		headers: { authorization: `Bearer ${settings.ingest_token}` },
		body: { id: 'stable-1', title: 'Sarah is at the door', sender: 'Sarah' },
	});
	const twice = await call('../api/companion/ingest.js', {
		method: 'POST', url: '/api/companion/ingest',
		headers: { authorization: `Bearer ${settings.ingest_token}` },
		body: { id: 'stable-1', title: 'Sarah is at the door', sender: 'Sarah' },
	});
	check('a retry is a duplicate, not a second delivery', once.status === 201 && twice.data.duplicate === true);

	// 4. A bad token is refused.
	const refused = await call('../api/companion/ingest.js', {
		method: 'POST', url: '/api/companion/ingest',
		headers: { authorization: 'Bearer cmp_not_a_real_token' },
		body: { title: 'should not land' },
	});
	check('an unknown token is refused', refused.status === 401);

	// 5. Contacts change who delivers, and how loudly.
	const contact = await upsertContact(user.id, {
		identifier: '@sarah',
		display_name: 'Sarah',
		avatar_glb_url: 'https://three.ws/avatars/michelle.glb',
		voice: 'nova',
		priority_boost: 30,
	});
	const fromContact = await call('../api/companion/ingest.js', {
		method: 'POST', url: '/api/companion/ingest',
		headers: { authorization: `Bearer ${settings.ingest_token}` },
		body: { title: 'downstairs, cannot find your door', sender: 'Sarah', sender_id: '@sarah', app: 'Telegram' },
	});
	check('a saved contact clears the bar', fromContact.data?.event?.delivered === true, `score ${fromContact.data?.event?.importance}`);
	const [stored] = await sql`select contact_id from companion_events where user_id = ${user.id} and title like '%cannot find%'`;
	check('the delivery is attributed to the contact', stored?.contact_id === contact.id);

	// 6. Quiet hours silence even a loud message.
	const { updateSettings } = await import('../api/_lib/companion/store.js');
	const hour = new Date().getUTCHours();
	await updateSettings(user.id, { quiet_start: hour, quiet_end: (hour + 2) % 24, timezone: 'UTC' });
	const quiet = await call('../api/companion/ingest.js', {
		method: 'POST', url: '/api/companion/ingest',
		headers: { authorization: `Bearer ${settings.ingest_token}` },
		body: { title: 'URGENT: emergency, call me now', sender: 'Sarah', sender_id: '@sarah', priority: 'high' },
	});
	check('quiet hours hold a loud message', quiet.data?.event?.delivered === false, `score ${quiet.data?.event?.importance}`);
	await updateSettings(user.id, { quiet_start: null, quiet_end: null });

	// 7. The feed reads back with scores and reasons.
	const feed = await listEvents(user.id, { limit: 20 });
	check('the feed holds every message, loud and quiet', feed.length === 5, `${feed.length} events`);
	check('every event carries a reason', feed.every((e) => e.reason && e.spoken_line));

	// 8. Source validation refuses a bad credential before storing it.
	const badSource = await call('../api/companion/sources/index.js', {
		method: 'POST', url: '/api/companion/sources',
		body: { kind: 'calendar', ics_url: 'https://example.com/not-a-calendar' },
	});
	check('an unauthenticated source connect is refused', badSource.status === 401);

	// 9. The SSE stream authenticates with the bridge token and replays.
	const streamMod = await import('../api/companion/stream.js');
	const res = mockRes();
	const req = mockReq({
		method: 'GET',
		url: `/api/companion/stream?since=${encodeURIComponent(new Date(Date.now() - 3600_000).toISOString())}`,
		headers: { authorization: `Bearer ${settings.ingest_token}` },
	});
	const handled = streamMod.default(req, res);
	await new Promise((r) => setTimeout(r, 1200));
	res.writableEnded = true;
	check('the stream says hello and replays deliveries', res.body.includes('event: hello') && res.body.includes('event: delivery'),
		`${(res.body.match(/event: delivery/g) || []).length} deliveries`);
	await handled?.catch?.(() => {});
} finally {
	await sql`delete from companion_events where user_id = ${user.id}`;
	await sql`delete from companion_contacts where user_id = ${user.id}`;
	await sql`delete from companion_sources where user_id = ${user.id}`;
	await sql`delete from companion_settings where user_id = ${user.id}`;
	await sql`delete from users where id = ${user.id}`;
	console.log('\ncleaned up');
	const failed = results.filter((r) => !r.ok);
	console.log(`${results.length - failed.length}/${results.length} checks passed`);
	process.exit(failed.length ? 1 : 0);
}
