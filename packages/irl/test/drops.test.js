import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIrl, ThreeWsError } from '../src/index.js';

// Same scripted fetch double as irl.test.js: queued responses, recorded calls.
// No network — the SDK's job is request shaping and response parsing.
function stubFetch(responses) {
	const calls = [];
	const queue = [...responses];
	const fetch = async (url, init) => {
		calls.push({ url: new URL(url), init });
		const next = queue.shift();
		if (!next) throw new Error('stubFetch: no more queued responses');
		const { status = 200, body = {}, headers = {} } = next;
		return {
			ok: status >= 200 && status < 300,
			status,
			headers: { get: (k) => headers[k.toLowerCase()] ?? null },
			text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
		};
	};
	return { fetch, calls };
}

const PUBLIC_DROP = {
	id: 'd1', kind: 'drop', asset: 'USDC', amount: '5', amount_atomics: '5000000',
	max_claims: 5, claims_count: 2, claims_left: 3, claim_rule: 'each-once',
	bounty_condition: null, quiz_question: null, title: 'Coffee money', note: null,
	lat: 40.74110, lng: -73.98970, radius_m: 30, network: 'mainnet', status: 'active',
	escrow_address: 'EscRoW1111111111111111111111111111111111111', funding_tx: 'sig1',
	refund_tx: null, expires_at: '2026-07-10T00:00:00Z', created_at: '2026-07-09T00:00:00Z',
	is_mine: false, distance_m: 14,
};

test('nearbyDrops() sends the fix token and shapes drops to camelCase', async () => {
	const { fetch, calls } = stubFetch([{ body: { drops: [PUBLIC_DROP] } }]);
	const client = createIrl({ fetch });
	const presence = { lat: 40.7411, lng: -73.9897, token: 'tok.sig' };
	const drops = await client.nearbyDrops(presence, { radius: 60 });

	assert.equal(calls[0].url.pathname, '/api/irl/drops');
	assert.equal(calls[0].url.searchParams.get('lat'), '40.7411');
	assert.equal(calls[0].url.searchParams.get('radius'), '60');
	assert.equal(calls[0].init.headers['x-irl-fix'], 'tok.sig');
	assert.equal(drops.length, 1);
	assert.equal(drops[0].claimsLeft, 3);
	assert.equal(drops[0].claimRule, 'each-once');
	assert.equal(drops[0].escrowAddress, PUBLIC_DROP.escrow_address);
	assert.equal(drops[0].distanceM, 14);
	assert.equal(drops[0].isMine, false);
	assert.equal(drops[0].raw.amount_atomics, '5000000');
});

test('getDrop() surfaces the coarse flag on a non-owner read', async () => {
	const { fetch, calls } = stubFetch([
		{ body: { drop: { ...PUBLIC_DROP, lat: 40.741, lng: -73.99, coarse: true, distance_m: undefined } } },
	]);
	const client = createIrl({ fetch });
	const drop = await client.getDrop('d1');
	assert.equal(calls[0].url.pathname, '/api/irl/drops/d1');
	assert.equal(drop.coarse, true);
	assert.equal(drop.lat, 40.741);
});

test('myDrops() reads ?mine=1 and shapes claim receipts', async () => {
	const { fetch, calls } = stubFetch([
		{ body: {
			drops: [{ ...PUBLIC_DROP, is_mine: true }],
			claims: [{ id: '7', drop_id: 'd2', title: 'Scout bounty', kind: 'bounty', asset: 'SOL',
				amount: '0.1', signature: 'claimsig', status: 'confirmed', network: 'mainnet',
				created_at: '2026-07-08T00:00:00Z', confirmed_at: '2026-07-08T00:00:10Z' }],
		} },
	]);
	const client = createIrl({ fetch, deviceToken: 'dev-1' });
	const { drops, claims } = await client.myDrops();
	assert.equal(calls[0].url.searchParams.get('mine'), '1');
	assert.equal(calls[0].init.headers['x-irl-device'], 'dev-1');
	assert.equal(drops[0].isMine, true);
	assert.equal(claims[0].dropId, 'd2');
	assert.equal(claims[0].confirmedAt, '2026-07-08T00:00:10Z');
});

test('createDrop() posts the config and returns the escrow funding target', async () => {
	const { fetch, calls } = stubFetch([
		{ status: 201, body: {
			drop: { ...PUBLIC_DROP, status: 'pending_funding', is_mine: true },
			escrow_address: 'EscRoW1111111111111111111111111111111111111',
			fund_atomics: '5000000', fund_amount: '5',
		} },
	]);
	const client = createIrl({ fetch, deviceToken: 'dev-1' });
	const out = await client.createDrop({
		asset: 'usdc', amount: 5, maxClaims: 5, claimRule: 'each-once',
		title: 'Coffee money', lat: 40.7411, lng: -73.9897, radiusM: 30,
	});
	assert.equal(calls[0].init.method, 'POST');
	const sent = JSON.parse(calls[0].init.body);
	assert.equal(sent.asset, 'USDC', 'asset is upper-cased before send');
	assert.equal(sent.maxClaims, 5);
	assert.equal(out.escrowAddress, 'EscRoW1111111111111111111111111111111111111');
	assert.equal(out.fundAmount, '5');
	assert.equal(out.funded, false);
	assert.equal(out.drop.status, 'pending_funding');
});

test('createDrop() with agentId returns the server-funded bounty state', async () => {
	const { fetch } = stubFetch([
		{ status: 201, body: {
			drop: { ...PUBLIC_DROP, kind: 'bounty', status: 'active', is_mine: true },
			escrow_address: 'EscRoW1111111111111111111111111111111111111',
			funding_tx: 'agentfundsig', funded: true,
			agent: { id: 'a1', name: 'Scout' },
		} },
	]);
	const client = createIrl({ fetch, apiKey: 'sess' });
	const out = await client.createDrop({
		agentId: 'a1', kind: 'bounty', asset: 'SOL', amount: 0.1,
		lat: 40.7411, lng: -73.9897, bountyCondition: 'quiz',
		quizQuestion: 'What is the only coin?', quizAnswer: '$THREE',
	});
	assert.equal(out.funded, true);
	assert.equal(out.fundingTx, 'agentfundsig');
	assert.equal(out.agent.name, 'Scout');
});

test('createDrop() validates coordinates, amount, and enums before the network', async () => {
	const { fetch, calls } = stubFetch([]);
	const client = createIrl({ fetch });
	await assert.rejects(() => client.createDrop({ amount: 5 }), /finite/);
	await assert.rejects(() => client.createDrop({ lat: 1, lng: 2, amount: 0 }), /positive/);
	await assert.rejects(() => client.createDrop({ lat: 1, lng: 2, amount: 1, asset: 'DOGE' }), /Invalid asset/);
	await assert.rejects(() => client.createDrop({ lat: 1, lng: 2, amount: 1, claimRule: 'always' }), /Invalid claimRule/);
	assert.equal(calls.length, 0);
});

test('fundDrop() posts the transfer signature and surfaces the 202 pending state', async () => {
	const { fetch, calls } = stubFetch([
		{ status: 202, body: { pending: true, status: 'pending_funding' } },
	]);
	const client = createIrl({ fetch });
	const out = await client.fundDrop({ dropId: 'd1', signature: 'fundsig' });
	assert.equal(calls[0].url.pathname, '/api/irl/drops/d1/fund');
	assert.equal(JSON.parse(calls[0].init.body).signature, 'fundsig');
	assert.equal(out.pending, true);
	await assert.rejects(() => client.fundDrop({ dropId: 'd1' }), /signature/);
});

test('claimDrop() proves presence in the header, posts the point + wallet, returns the release', async () => {
	const wallet = 'C1aimWa11et111111111111111111111111111111111';
	const { fetch, calls } = stubFetch([
		{ body: { ok: true, asset: 'USDC', amount: '1', signature: 'releasesig',
			explorer_url: 'https://solscan.io/tx/releasesig', wallet } },
	]);
	const client = createIrl({ fetch, deviceToken: 'dev-1' });
	const out = await client.claimDrop({
		dropId: 'd1',
		presence: { lat: 40.7411, lng: -73.9897, token: 'tok.sig' },
		wallet,
		answer: '$THREE',
	});
	assert.equal(calls[0].url.pathname, '/api/irl/drops/d1/claim');
	assert.equal(calls[0].init.headers['x-irl-fix'], 'tok.sig');
	assert.equal(calls[0].init.headers['x-irl-device'], 'dev-1');
	const sent = JSON.parse(calls[0].init.body);
	assert.equal(sent.wallet, wallet);
	assert.equal(sent.lat, 40.7411);
	assert.equal(sent.answer, '$THREE');
	assert.equal(out.ok, true);
	assert.equal(out.signature, 'releasesig');
	assert.equal(out.explorerUrl, 'https://solscan.io/tx/releasesig');
});

test('claimDrop() rejects a malformed wallet and a missing presence before the network', async () => {
	const { fetch, calls } = stubFetch([]);
	const client = createIrl({ fetch });
	await assert.rejects(
		() => client.claimDrop({ dropId: 'd1', presence: { lat: 1, lng: 2 }, wallet: 'not-a-wallet' }),
		(e) => { assert.ok(e instanceof ThreeWsError); assert.match(e.message, /wallet/); return true; },
	);
	await assert.rejects(() => client.claimDrop({ dropId: 'd1', wallet: 'C1aimWa11et111111111111111111111111111111111' }), /presence/);
	assert.equal(calls.length, 0);
});

test('claim failure states surface as typed errors (out_of_range, fix_required)', async () => {
	const { fetch } = stubFetch([
		{ status: 403, body: { error: 'out_of_range', message: "you're 210 m away — get within 30 m to claim" } },
	]);
	const client = createIrl({ fetch });
	await assert.rejects(
		() => client.claimDrop({
			dropId: 'd1', presence: { lat: 1, lng: 2, token: 't' },
			wallet: 'C1aimWa11et111111111111111111111111111111111',
		}),
		(e) => { assert.ok(e instanceof ThreeWsError); assert.equal(e.code, 'out_of_range'); assert.equal(e.status, 403); return true; },
	);
});

test('cancelDrop() posts the cancel and shapes the refund receipt', async () => {
	const { fetch, calls } = stubFetch([
		{ body: { ok: true, refunded: true, refund_tx: 'refundsig', explorer_url: 'https://solscan.io/tx/refundsig' } },
	]);
	const client = createIrl({ fetch, deviceToken: 'dev-1' });
	const out = await client.cancelDrop('d1');
	assert.equal(calls[0].url.pathname, '/api/irl/drops/d1/cancel');
	assert.equal(calls[0].init.method, 'POST');
	assert.equal(out.refunded, true);
	assert.equal(out.refundTx, 'refundsig');
});
