import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNames, ThreeWsError, PaymentRequiredError } from '../src/index.js';

// A scripted fetch double: each call shifts the next queued response and records
// the request. No network, no real endpoints — we assert on request shaping and
// response parsing, which is all the SDK is responsible for.
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

const SYNTH_OWNER = 'THREEsynthetic1111111111111111111111111111';
const SYNTH_PAYER = 'THREEsynthpayer11111111111111111111111111111';

test('resolve() routes a .sol name to /api/sns and camelCases the envelope', async () => {
	const { fetch, calls } = stubFetch([
		{ body: { data: { name: 'bonfida.sol', address: SYNTH_OWNER, network: 'solana', resolved: true } } },
	]);
	const client = createNames({ fetch, baseUrl: 'https://three.ws' });
	const res = await client.resolve('bonfida.sol');

	assert.equal(calls[0].url.pathname, '/api/sns');
	assert.equal(calls[0].url.searchParams.get('name'), 'bonfida.sol');
	assert.equal(calls[0].init.method, 'GET');
	// The owner's domain list costs two extra SNS-index lookups server-side, so
	// a plain resolve must not ask for it.
	assert.equal(calls[0].url.searchParams.has('domains'), false);
	assert.equal(res.address, SYNTH_OWNER);
	assert.equal(res.network, 'solana');
	assert.equal(res.resolved, true);
	assert.deepEqual(res.allDomains, []);
	assert.equal(res.favoriteDomain, null);
	assert.ok(res.raw, 'keeps a raw escape hatch');
});

test('resolve({ domains: true }) asks for the owner list and maps it', async () => {
	const { fetch, calls } = stubFetch([
		{ body: { data: { name: 'bonfida.sol', address: SYNTH_OWNER, network: 'solana', resolved: true, all_domains: ['bonfida.sol', 'naming.sol'], favorite_domain: 'bonfida.sol', domains_truncated: true } } },
	]);
	const client = createNames({ fetch });
	const res = await client.resolve('bonfida.sol', { domains: true });

	assert.equal(calls[0].url.searchParams.get('domains'), '1');
	assert.deepEqual(res.allDomains, ['bonfida.sol', 'naming.sol']);
	assert.equal(res.favoriteDomain, 'bonfida.sol');
	assert.equal(res.domainsTruncated, true);
});

test('resolve() routes a .eth name to the ENS endpoint', async () => {
	const { fetch, calls } = stubFetch([
		{ body: { name: 'vitalik.eth', address: '0xd8da6bf26964af9d7eed9e03e53415d37aa96045', agents: [{ id: 'agt_1' }] } },
	]);
	const client = createNames({ fetch });
	const res = await client.resolve('vitalik.eth');

	assert.equal(calls[0].url.pathname, '/api/agents/ens/vitalik.eth');
	assert.equal(res.network, 'ethereum');
	assert.equal(res.resolved, true);
	assert.equal(res.address, '0xd8da6bf26964af9d7eed9e03e53415d37aa96045');
	assert.equal(res.agents.length, 1);
});

test('resolve() treats a .sol miss (resolved:false) as data, not an error', async () => {
	const { fetch } = stubFetch([
		{ body: { data: { name: 'nope.sol', address: null, network: 'solana', resolved: false } } },
	]);
	const client = createNames({ fetch });
	const res = await client.resolve('nope');
	assert.equal(res.resolved, false);
	assert.equal(res.address, null);
});

test('resolve() treats an unregistered .eth (a 404) as data, not an error', async () => {
	// The ENS endpoint reports "no such name" as a 404 while the .sol lane reports
	// the same miss as resolved:false at 200. One resolve(), one contract: a caller
	// must never have to try/catch to ask whether a name exists.
	const { fetch, calls } = stubFetch([
		{ status: 404, body: { error: 'not_found', error_description: 'nobody.eth does not resolve to an address' } },
	]);
	const client = createNames({ fetch });
	const res = await client.resolve('NOBODY.eth');

	assert.equal(calls[0].url.pathname, '/api/agents/ens/nobody.eth', 'the name is lowercased for the registry');
	assert.equal(res.resolved, false);
	assert.equal(res.address, null);
	assert.equal(res.name, 'nobody.eth');
	assert.equal(res.network, 'ethereum');
	assert.deepEqual(res.agents, []);
	assert.equal(res.raw.error, 'not_found', 'raw stays the untouched wire envelope');
});

test('resolve() still rejects a real ENS fault (a 503 timeout is not a miss)', async () => {
	const { fetch } = stubFetch([
		{ status: 503, body: { error: 'ens_timeout', error_description: 'ENS RPC exceeded 3s' } },
	]);
	const client = createNames({ fetch });
	await assert.rejects(() => client.resolve('slow.eth'), (err) => {
		assert.ok(err instanceof ThreeWsError);
		assert.equal(err.code, 'ens_timeout');
		assert.equal(err.status, 503);
		return true;
	});
});

test('resolve() rejects an empty / malformed name before any network call', async () => {
	const { fetch, calls } = stubFetch([]);
	const client = createNames({ fetch });
	await assert.rejects(() => client.resolve(''), /needs a non-empty name/);
	await assert.rejects(() => client.resolve('not a name!'), /Invalid name/);
	assert.equal(calls.length, 0);
});

test('reverseLookup() queries by address and validates base58 first', async () => {
	const { fetch, calls } = stubFetch([
		{ body: { data: { name: 'bonfida.sol', address: SYNTH_OWNER, network: 'solana', resolved: true } } },
	]);
	const client = createNames({ fetch });
	const res = await client.reverseLookup(SYNTH_OWNER);
	assert.equal(calls[0].url.searchParams.get('address'), SYNTH_OWNER);
	assert.equal(calls[0].url.searchParams.has('domains'), false);
	assert.equal(res.name, 'bonfida.sol');

	await assert.rejects(() => client.reverseLookup('xyz'), /base58 Solana address/);
});

test('reverseLookup({ domains: true }) lists a wallet that has no favorite yet', async () => {
	const { fetch, calls } = stubFetch([
		{ body: { data: { name: null, address: SYNTH_OWNER, network: 'solana', resolved: false, all_domains: ['naming.sol'], favorite_domain: null } } },
	]);
	const client = createNames({ fetch });
	const res = await client.reverseLookup(SYNTH_OWNER, { domains: true });

	assert.equal(calls[0].url.searchParams.get('domains'), '1');
	assert.equal(res.resolved, false, 'no primary domain is not an error');
	assert.deepEqual(res.allDomains, ['naming.sol']);
	assert.equal(res.domainsTruncated, false);
});

test('checkSubdomain() reads availability and maps full_name → fullName', async () => {
	const { fetch, calls } = stubFetch([
		{ body: { data: { label: 'alice', parent: 'threews.sol', full_name: 'alice.threews.sol', available: true, owner: null } } },
	]);
	const client = createNames({ fetch });
	const res = await client.checkSubdomain('alice');
	assert.equal(calls[0].url.pathname, '/api/sns-subdomain');
	assert.equal(calls[0].url.searchParams.get('label'), 'alice');
	assert.equal(res.available, true);
	assert.equal(res.fullName, 'alice.threews.sol');
});

test('mintSubdomain() POSTs agent_id + bearer token and shapes the result', async () => {
	const { fetch, calls } = stubFetch([
		{ body: { data: { ok: true, agent_id: 'agt_7', full_name: 'alice.threews.sol', parent: 'threews.sol', owner: SYNTH_OWNER, signature: 'sigSynthetic', explorer: 'https://solscan.io/tx/sigSynthetic', url_record: 'https://three.ws/a/agt_7', agent_url: 'https://three.ws/a/agt_7' } } },
	]);
	const client = createNames({ fetch });
	const res = await client.mintSubdomain({ agentId: 'agt_7', label: 'alice', token: 'tkn_123' });

	assert.equal(calls[0].url.pathname, '/api/sns-subdomain');
	assert.equal(calls[0].init.method, 'POST');
	assert.equal(calls[0].init.headers.authorization, 'Bearer tkn_123');
	const sent = JSON.parse(calls[0].init.body);
	assert.equal(sent.agent_id, 'agt_7');
	assert.equal(sent.label, 'alice');
	assert.equal(res.ok, true);
	assert.equal(res.fullName, 'alice.threews.sol');
	assert.equal(res.agentId, 'agt_7');
});

test('mintSubdomain() rejects a missing agentId and a bad space before network', async () => {
	const { fetch, calls } = stubFetch([]);
	const client = createNames({ fetch });
	await assert.rejects(() => client.mintSubdomain({}), /needs an `agentId`/);
	await assert.rejects(() => client.mintSubdomain({ agentId: 'a', space: 500 }), /space must be/);
	await assert.rejects(() => client.mintSubdomain({ agentId: 'a', ownerAddress: 'bad' }), /base58/);
	assert.equal(calls.length, 0);
});

test('mintSubdomain() surfaces a 503 config_missing as a typed ThreeWsError', async () => {
	const { fetch } = stubFetch([{ status: 503, body: { error: 'config_missing', message: 'platform owner key not configured' } }]);
	const client = createNames({ fetch });
	await assert.rejects(() => client.mintSubdomain({ agentId: 'agt_7', token: 't' }), (e) => {
		assert.ok(e instanceof ThreeWsError);
		assert.equal(e.code, 'config_missing');
		assert.equal(e.status, 503);
		return true;
	});
});

test('claimSubdomain() POSTs to /api/threews/subdomain with the username label', async () => {
	const { fetch, calls } = stubFetch([
		{ body: { data: { id: 'sub_1', label: 'nick', parent: 'threews', owner_wallet: SYNTH_OWNER, url_record: 'https://three.ws/u/nick', signature: 'sigSynth', full: 'nick.threews.sol', showcase_url: 'https://three.ws/u/nick', created_at: '2026-01-01' } } },
	]);
	const client = createNames({ fetch, apiKey: 'client_tkn' });
	const res = await client.claimSubdomain({ label: 'nick' });
	assert.equal(calls[0].url.pathname, '/api/threews/subdomain');
	assert.equal(calls[0].init.headers.authorization, 'Bearer client_tkn');
	assert.equal(res.fullName, 'nick.threews.sol');
	assert.equal(res.label, 'nick');
});

test('releaseSubdomain() DELETEs with the label query param', async () => {
	const { fetch, calls } = stubFetch([
		{ body: { data: { released: { id: 'sub_1', label: 'nick', parent: 'threews' }, note: 'on-chain ownership unchanged' } } },
	]);
	const client = createNames({ fetch, token: 't' });
	const res = await client.releaseSubdomain('nick');
	assert.equal(calls[0].init.method, 'DELETE');
	assert.equal(calls[0].url.searchParams.get('label'), 'nick');
	assert.equal(res.released.label, 'nick');
});

test('resolvePayee() resolves-only via GET and shapes the payee', async () => {
	const { fetch, calls } = stubFetch([
		{ body: { data: { address: SYNTH_OWNER, source: 'sns', resolved: 'alice.threews.sol', claim: { user_id: 'u1', username: 'alice', display_name: 'Alice' } } } },
	]);
	const client = createNames({ fetch });
	const res = await client.resolvePayee('alice.threews.sol');
	assert.equal(calls[0].url.pathname, '/api/x402/pay-by-name');
	assert.equal(calls[0].url.searchParams.get('name'), 'alice.threews.sol');
	assert.equal(res.address, SYNTH_OWNER);
	assert.equal(res.source, 'sns');
	assert.equal(res.name, 'alice.threews.sol');
	assert.equal(res.claim.username, 'alice');
});

test('a payee that resolves nowhere is a typed not_found, and `resolved` is a name not a flag', async () => {
	const { fetch } = stubFetch([
		{ body: { data: { address: SYNTH_OWNER, source: 'username', resolved: '@alice' } } },
		{ status: 404, body: { error: 'not_found', error_description: 'could not resolve "ghost"' } },
	]);
	const client = createNames({ fetch });

	// Unlike resolve()'s boolean, a Payee's `resolved` carries the canonical form
	// of the name that matched: @handle here, a .sol domain for an SNS hit.
	const hit = await client.resolvePayee('alice');
	assert.equal(hit.resolved, '@alice');
	assert.equal(hit.name, hit.resolved);
	assert.equal(hit.source, 'username');

	await assert.rejects(() => client.resolvePayee('ghost'), (err) => {
		assert.ok(err instanceof ThreeWsError);
		assert.equal(err.code, 'not_found');
		assert.equal(err.status, 404);
		return true;
	});
});

test('payByName() prep builds an unsigned tx and sends payer_wallet', async () => {
	const { fetch, calls } = stubFetch([
		{ body: { data: { recipient: { address: SYNTH_OWNER, source: 'sns', resolved: 'alice.threews.sol' }, amount_usdc: 5, tx_base64: 'AQID', blockhash: 'bh', last_valid_block_height: 123, mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' } } },
	]);
	const client = createNames({ fetch });
	const res = await client.payByName('alice.threews.sol', '5', { payerWallet: SYNTH_PAYER });

	assert.equal(calls[0].init.method, 'POST');
	const sent = JSON.parse(calls[0].init.body);
	assert.equal(sent.mode, 'prep');
	assert.equal(sent.name, 'alice.threews.sol');
	assert.equal(sent.amount_usdc, '5');
	assert.equal(sent.payer_wallet, SYNTH_PAYER);
	assert.equal(res.mode, 'prep');
	assert.equal(res.txBase64, 'AQID');
	assert.equal(res.lastValidBlockHeight, 123);
	assert.equal(res.recipient.address, SYNTH_OWNER);
});

test('payByName() send forwards agent_id + expected_address and maps the signature', async () => {
	const { fetch, calls } = stubFetch([
		{ body: { data: { recipient: { address: SYNTH_OWNER, source: 'sns', resolved: 'alice.threews.sol' }, payer: SYNTH_PAYER, amount_usdc: 5, signature: 'sigSynthetic', mode: 'send' } } },
	]);
	const client = createNames({ fetch });
	const res = await client.payByName('alice.threews.sol', 5, {
		mode: 'send', agentId: 'agt_7', expectedAddress: SYNTH_OWNER, token: 'tkn',
	});
	const sent = JSON.parse(calls[0].init.body);
	assert.equal(sent.mode, 'send');
	assert.equal(sent.agent_id, 'agt_7');
	assert.equal(sent.expected_address, SYNTH_OWNER);
	assert.equal(calls[0].init.headers.authorization, 'Bearer tkn');
	assert.equal(res.mode, 'send');
	assert.equal(res.signature, 'sigSynthetic');
	assert.equal(res.payer, SYNTH_PAYER);
});

test('payByName() validation runs before any network call', async () => {
	const { fetch, calls } = stubFetch([]);
	const client = createNames({ fetch });
	await assert.rejects(() => client.payByName('alice.sol', '0'), /amountUsdc must be/);
	await assert.rejects(() => client.payByName('alice.sol', '5'), /needs a base58 `payerWallet`/);
	await assert.rejects(() => client.payByName('alice.sol', '5', { mode: 'send' }), /needs an `agentId`/);
	await assert.rejects(() => client.payByName('alice.sol', '5', { mode: 'wire' }), /Invalid mode/);
	assert.equal(calls.length, 0);
});

test('payByName() send maps a 409 recipient_changed to a typed ThreeWsError', async () => {
	const { fetch } = stubFetch([{ status: 409, body: { error: 'recipient_changed', message: 're-preview before sending' } }]);
	const client = createNames({ fetch });
	await assert.rejects(
		() => client.payByName('alice.sol', '5', { mode: 'send', agentId: 'agt_7', token: 't' }),
		(e) => {
			assert.ok(e instanceof ThreeWsError);
			assert.equal(e.code, 'recipient_changed');
			assert.equal(e.status, 409);
			return true;
		},
	);
});

test('a 402 on payByName surfaces as PaymentRequiredError carrying accepts', async () => {
	const accepts = [{ scheme: 'exact', asset: 'USDC', network: 'solana', maxAmountRequired: '5000000' }];
	const { fetch } = stubFetch([{ status: 402, body: { error: 'payment_required', message: 'pay', accepts } }]);
	const client = createNames({ fetch });
	await assert.rejects(() => client.payByName('alice.sol', '5', { payerWallet: SYNTH_PAYER }), (e) => {
		assert.ok(e instanceof PaymentRequiredError);
		assert.deepEqual(e.accepts, accepts);
		return true;
	});
});
