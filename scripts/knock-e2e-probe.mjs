// End-to-end exercise of the free knock lane against the real database and the
// real HTTP handlers, then a full cleanup of everything it created.
import { readFileSync } from 'node:fs';
for (const f of ['.env.local', '.env']) {
	try {
		for (const line of readFileSync(f, 'utf8').split('\n')) {
			const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
			if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
		}
	} catch {}
}
const { neon } = await import('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);
const BASE = 'http://localhost:3099';
const USER = 'ab2aabd2-39f7-493b-8191-c9f174af62ab';
const HANDLE = 'qa-knock-probe';

const step = (n, v) => console.log(`\n== ${n} ==\n`, typeof v === 'string' ? v : JSON.stringify(v, null, 1));

const priorUsername = (await sql`select username from users where id = ${USER}`)[0]?.username ?? null;
await sql`update users set username = ${HANDLE} where id = ${USER}`;
await sql`
	insert into knock_doors (user_id, open, price_atomics, headline, greeting, listed, daily_cap)
	values (${USER}, true, 0, 'QA probe door', 'Free while this probe runs.', false, 25)
	on conflict (user_id) do update set open = true, price_atomics = 0, listed = false,
		headline = 'QA probe door', greeting = 'Free while this probe runs.'
`;

step('GET /api/knock/door', await (await fetch(`${BASE}/api/knock/door?handle=${HANDLE}`)).json());

const send = async (body) => {
	const res = await fetch(`${BASE}/api/knock/send`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	});
	return { status: res.status, body: await res.json() };
};

step('POST /api/knock/send (too short)', await send({ to: HANDLE, from: 'Ada', message: 'hi' }));
step('POST /api/knock/send (bad url)', await send({ to: HANDLE, from: 'Ada', message: 'a real message here', url: 'javascript:alert(1)' }));
step('POST /api/knock/send (no sender)', await send({ to: HANDLE, from: '', message: 'a real message here' }));

const first = await send({
	to: HANDLE,
	from: 'Ada (research agent)',
	subject: 'Your x402 settle path',
	message: 'I index x402 endpoints and yours is the only one settling on Solana. Two questions about the facilitator.',
	url: 'https://example.com/ada',
	sender_kind: 'agent',
	request_id: 'qa-probe-001',
});
step('POST /api/knock/send (accepted)', first);

const retry = await send({
	to: HANDLE,
	from: 'Ada (research agent)',
	subject: 'Your x402 settle path',
	message: 'I index x402 endpoints and yours is the only one settling on Solana. Two questions about the facilitator.',
	request_id: 'qa-probe-001',
});
step('POST /api/knock/send (same request_id, must be duplicate)', retry);

const knockId = first.body.knock_id;
const evRows = await sql`
	select source_kind, sender, title, importance, spoken_line, triage_engine
	from companion_events where user_id = ${USER} and source_kind = 'knock'
`;
step('companion_events row (what the avatar will say)', evRows);

const notif = await sql`
	select type, payload->>'title' as title, payload->>'spoken_line' as spoken
	from user_notifications where user_id = ${USER} and type = 'knock_received'
`;
step('user_notifications row (what the herald announces)', notif);

const receipt = first.body.receipt_url.replace('https://three.ws', BASE).replace('http://localhost:3099', BASE);
step('GET receipt before a reply', await (await fetch(receipt)).json());

await sql`update knock_messages set status = 'replied', reply_text = 'Ask away, DM open.', replied_at = now() where id = ${knockId}`;
step('GET receipt after a reply', await (await fetch(receipt)).json());
step('GET receipt with a wrong token', {
	status: (await fetch(`${BASE}/api/knock/reply?id=${knockId}&token=${'x'.repeat(32)}`)).status,
});

// x402 lane: a priced door must refuse the free lane and quote the price.
await sql`update knock_doors set price_atomics = 50000, pay_to_solana = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump' where user_id = ${USER}`;
step('POST /api/knock/send on a priced door', await send({ to: HANDLE, from: 'Ada', message: 'this should be quoted a price' }));
const challenge = await fetch(`${BASE}/api/x402/knock?to=${HANDLE}`, {
	method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
});
const chBody = await challenge.json();
step('POST /api/x402/knock (challenge)', {
	status: challenge.status,
	accepts: chBody.accepts?.map((a) => ({ network: a.network, amount: a.amount, payTo: a.payTo, asset: a.asset })),
	error: chBody.error,
});
const refused = await fetch(`${BASE}/api/x402/knock?to=${HANDLE}`, {
	method: 'POST', headers: { 'content-type': 'application/json' },
	body: JSON.stringify({ from: 'Ada', message: 'x'.repeat(5000) }),
});
step('POST /api/x402/knock (over-long message is refused BEFORE any 402)', { status: refused.status, body: await refused.json() });

step('GET /api/knock/directory (door is unlisted, so it must not appear)', await (await fetch(`${BASE}/api/knock/directory`)).json());

// Cleanup: remove everything this probe created.
const ids = evRows.map((r) => r.id).filter(Boolean);
await sql`delete from knock_messages where recipient_user_id = ${USER}`;
await sql`delete from companion_events where user_id = ${USER} and source_kind = 'knock'`;
await sql`delete from user_notifications where user_id = ${USER} and type = 'knock_received'`;
await sql`delete from knock_blocks where user_id = ${USER}`;
await sql`delete from knock_doors where user_id = ${USER}`;
await sql`update users set username = ${priorUsername} where id = ${USER}`;
void ids;
step('cleanup', {
	knocks: (await sql`select count(*)::int c from knock_messages where recipient_user_id = ${USER}`)[0].c,
	events: (await sql`select count(*)::int c from companion_events where user_id = ${USER} and source_kind='knock'`)[0].c,
	doors: (await sql`select count(*)::int c from knock_doors where user_id = ${USER}`)[0].c,
	username_restored: (await sql`select username from users where id = ${USER}`)[0].username,
});
