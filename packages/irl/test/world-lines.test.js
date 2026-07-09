import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIrl, ThreeWsError } from '../src/index.js';

// Same scripted fetch double as irl.test.js: queued responses, recorded calls.
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

const WL = {
	id: '22222222-2222-2222-2222-222222222222',
	agent_id: 'a1', signer_pubkey: 'SignerPubkey11111111111111111111111111111111',
	pin_id: 'p1', coarse_cell: 'dr5reg', title: 'Meet the courier',
	prompt: 'Find me by the fountain', challenge: { kind: 'quiz', prompt: null, question: 'What coin?', choices: ['$THREE', 'other'] },
	reward_kind: 'collectible', reward_ref: null, difficulty: 'easy',
	max_completions: 100, completion_count: 4,
	created_at: '2026-07-01T00:00:00Z', expires_at: '2026-07-31T00:00:00Z',
};

test('nearbyWorldLines() sends the fix token and shapes quests', async () => {
	const { fetch, calls } = stubFetch([
		{ body: { world_lines: [{ ...WL, distance_m: 200, completed_by_me: false, capacity_reached: false }] } },
	]);
	const client = createIrl({ fetch });
	const quests = await client.nearbyWorldLines({ lat: 40.7411, lng: -73.9897, token: 'tok.sig' }, { radius: 400 });

	assert.equal(calls[0].url.pathname, '/api/irl/world-lines/nearby');
	assert.equal(calls[0].url.searchParams.get('radius'), '400');
	assert.equal(calls[0].init.headers['x-irl-fix'], 'tok.sig');
	assert.equal(quests[0].distanceM, 200);
	assert.equal(quests[0].completedByMe, false);
	assert.equal(quests[0].signerPubkey, WL.signer_pubkey);
	assert.equal(quests[0].challenge.question, 'What coin?');
});

test('browseWorldLines() with no region returns the shaped roll-up', async () => {
	const { fetch, calls } = stubFetch([
		{ body: { regions: [{ region_cell: 'dr5re', quests: 7, hard: 2, completions: 31 }] } },
	]);
	const client = createIrl({ fetch });
	const out = await client.browseWorldLines();
	assert.equal(calls[0].url.pathname, '/api/irl/world-lines/browse');
	assert.equal(out.regions[0].regionCell, 'dr5re');
	assert.equal(out.regions[0].completions, 31);
});

test('browseWorldLines() with a region lists that region and validates the cell', async () => {
	const { fetch, calls } = stubFetch([
		{ body: { region: 'dr5re', quests: [{ id: WL.id, title: WL.title, reward_kind: 'collectible', difficulty: 'easy', completion_count: 4, capacity_reached: false }] } },
	]);
	const client = createIrl({ fetch });
	const out = await client.browseWorldLines({ region: 'dr5re', difficulty: 'easy' });
	assert.equal(calls[0].url.searchParams.get('region'), 'dr5re');
	assert.equal(calls[0].url.searchParams.get('difficulty'), 'easy');
	assert.equal(out.quests[0].completionCount, 4);
	await assert.rejects(() => client.browseWorldLines({ region: 'NOPE' }), /precision-5/);
	await assert.rejects(() => client.browseWorldLines({ difficulty: 'impossible' }), /Invalid difficulty/);
});

test('getWorldLine() passes the presence for the co-located detail', async () => {
	const { fetch, calls } = stubFetch([
		{ body: { world_line: { ...WL, challenge: { ...WL.challenge, answer: 0 } }, colocated: true } },
	]);
	const client = createIrl({ fetch });
	const out = await client.getWorldLine(WL.id, { presence: { lat: 40.7411, lng: -73.9897, token: 'tok.sig' } });
	assert.equal(calls[0].url.pathname, `/api/irl/world-lines/${WL.id}`);
	assert.equal(calls[0].url.searchParams.get('lat'), '40.7411');
	assert.equal(calls[0].init.headers['x-irl-fix'], 'tok.sig');
	assert.equal(out.colocated, true);
	assert.equal(out.worldLine.challenge.answer, 0, 'co-located detail carries the full spec');
});

test('createWorldLine() validates the challenge client-side and maps field names', async () => {
	const { fetch, calls } = stubFetch([
		{ status: 201, body: { world_line: WL } },
	]);
	const client = createIrl({ fetch, apiKey: 'sess' });
	const { worldLine } = await client.createWorldLine({
		pinId: 'p1', title: 'Meet the courier', prompt: 'Find me by the fountain',
		challenge: { kind: 'quiz', question: 'What coin?', choices: ['$THREE', 'other'], answer: 0 },
		rewardRef: 'Courier badge', lifetimeDays: 30, maxCompletions: 100, difficulty: 'easy',
	});
	assert.equal(calls[0].init.method, 'POST');
	assert.equal(calls[0].init.headers.authorization, 'Bearer sess');
	const sent = JSON.parse(calls[0].init.body);
	assert.equal(sent.reward_ref, 'Courier badge', 'reward_ref rides snake_case (server reads only that form)');
	assert.equal(sent.lifetime_days, 30, 'lifetime_days rides snake_case');
	assert.equal(sent.challenge.answer, 0);
	assert.equal(worldLine.id, WL.id);

	await assert.rejects(() => client.createWorldLine({ pinId: 'p1', title: 'x', challenge: { kind: 'quiz', question: 'q', choices: ['a'] } }), /two `choices`/);
	await assert.rejects(() => client.createWorldLine({ pinId: 'p1', title: 'x', challenge: { kind: 'phrase' } }), /passphrase/);
	await assert.rejects(() => client.createWorldLine({ title: 'x' }), /pinId/);
	await assert.rejects(() => client.createWorldLine({ pinId: 'p1' }), /title/);
});

test('challengeWorldLine() proves presence and returns the nonce + revealed spec', async () => {
	const { fetch, calls } = stubFetch([
		{ body: { nonce: 'n0nce.sig', expires_in: 120,
			challenge: { kind: 'quiz', question: 'What coin?', choices: ['$THREE', 'other'], answer: 0 },
			agent_id: 'a1', world_line: { id: WL.id, title: WL.title } } },
	]);
	const client = createIrl({ fetch, deviceToken: 'dev-5' });
	const out = await client.challengeWorldLine({
		worldLineId: WL.id,
		presence: { lat: 40.7411, lng: -73.9897, token: 'tok.sig' },
	});
	assert.equal(calls[0].url.pathname, '/api/irl/world-lines/challenge');
	assert.equal(JSON.parse(calls[0].init.body).world_line_id, WL.id);
	assert.equal(calls[0].init.headers['x-irl-fix'], 'tok.sig');
	assert.equal(calls[0].init.headers['x-irl-device'], 'dev-5');
	assert.equal(out.alreadyCompleted, false);
	assert.equal(out.nonce, 'n0nce.sig');
	assert.equal(out.challenge.answer, 0);
});

test('challengeWorldLine() surfaces the already-completed state instead of a nonce', async () => {
	const { fetch } = stubFetch([
		{ body: { already_completed: true, proof_id: 'pr1', collectible_mint: 'presence:pr1' } },
	]);
	const client = createIrl({ fetch });
	const out = await client.challengeWorldLine({
		worldLineId: WL.id, presence: { lat: 1, lng: 2, token: 't' },
	});
	assert.equal(out.alreadyCompleted, true);
	assert.equal(out.proofId, 'pr1');
	assert.equal(out.collectibleMint, 'presence:pr1');
});

test('completeWorldLine() runs the proof ceremony and shapes proof + collectible', async () => {
	const { fetch, calls } = stubFetch([
		{ status: 201, body: { ok: true,
			proof: { id: 'pr1', world_line_id: WL.id, agent_id: 'a1', signer_pubkey: WL.signer_pubkey,
				coarse_cell: 'dr5reg', signature: 'edsig', signed_message: 'three.ws/world-line-presence:v1|wl=…',
				signature_scheme: 'ed25519', completed_at: '2026-07-09T00:00:00Z',
				verify_url: '/api/irl/world-lines/verify/pr1' },
			collectible: { mint: 'presence:pr1', name: 'Meet the courier — proof of presence',
				kind: 'proof-of-presence', reward_kind: 'collectible',
				signer_pubkey: WL.signer_pubkey, signature: 'edsig', proof_id: 'pr1' } } },
	]);
	const client = createIrl({ fetch });
	const out = await client.completeWorldLine({
		worldLineId: WL.id, nonce: 'n0nce.sig',
		presence: { lat: 40.7411, lng: -73.9897, token: 'tok.sig' },
		answer: 0,
	});
	const sent = JSON.parse(calls[0].init.body);
	assert.equal(calls[0].url.pathname, '/api/irl/world-lines/complete');
	assert.equal(sent.nonce, 'n0nce.sig');
	assert.equal(sent.answer, 0);
	assert.equal(out.ok, true);
	assert.equal(out.proof.verifyUrl, '/api/irl/world-lines/verify/pr1');
	assert.equal(out.collectible.mint, 'presence:pr1');
	await assert.rejects(() => client.completeWorldLine({ worldLineId: WL.id, presence: { lat: 1, lng: 2 } }), /nonce/);
});

test('a remote completion attempt surfaces not_colocated as a typed error', async () => {
	const { fetch } = stubFetch([
		{ status: 403, body: { error: 'not_colocated', error_description: 'travel to the quest to complete it', within_m: 80 } },
	]);
	const client = createIrl({ fetch });
	await assert.rejects(
		() => client.completeWorldLine({ worldLineId: WL.id, nonce: 'n', presence: { lat: 0, lng: 0, token: 't' } }),
		(e) => { assert.ok(e instanceof ThreeWsError); assert.equal(e.code, 'not_colocated'); assert.equal(e.status, 403); return true; },
	);
});

test('myWorldLines() shapes the dashboard + heatmap; myCollectibles() the earned proofs', async () => {
	const { fetch, calls } = stubFetch([
		{ body: { world_lines: [{ ...WL, expired: false, hidden: false }],
			heatmap: [{ world_line_id: WL.id, coarse_cell: 'dr5reg', completions: 4 }] } },
		{ body: { collectibles: [{ mint: 'presence:pr1', name: 'Meet the courier — proof of presence',
			kind: 'proof-of-presence', reward_kind: 'collectible', signer_pubkey: WL.signer_pubkey,
			signature: 'edsig', proof_id: 'pr1', world_line_id: WL.id, world_line_title: WL.title,
			difficulty: 'easy', coarse_cell: 'dr5reg', earned_at: '2026-07-09T00:00:00Z',
			verify_url: '/api/irl/world-lines/verify/pr1' }] } },
	]);
	const client = createIrl({ fetch, apiKey: 'sess', deviceToken: 'dev-5' });
	const mine = await client.myWorldLines();
	assert.equal(calls[0].url.pathname, '/api/irl/world-lines/mine');
	assert.equal(mine.worldLines[0].hidden, false);
	assert.equal(mine.heatmap[0].completions, 4);

	const earned = await client.myCollectibles();
	assert.equal(calls[1].url.pathname, '/api/irl/world-lines/collectibles');
	assert.equal(calls[1].init.headers['x-irl-device'], 'dev-5');
	assert.equal(earned[0].worldLineTitle, WL.title);
	assert.equal(earned[0].verifyUrl, '/api/irl/world-lines/verify/pr1');
});

test('verifyProof() re-checks the signature publicly', async () => {
	const { fetch, calls } = stubFetch([
		{ body: { verified: true, proof: { id: 'pr1', world_line_id: WL.id, world_line_title: WL.title,
			agent_id: 'a1', signer_pubkey: WL.signer_pubkey, coarse_cell: 'dr5reg',
			signed_message: 'three.ws/world-line-presence:v1|wl=…', signature: 'edsig',
			signature_scheme: 'ed25519', collectible_mint: 'presence:pr1',
			collectible_name: 'Meet the courier — proof of presence', completed_at: '2026-07-09T00:00:00Z' } } },
	]);
	const client = createIrl({ fetch });
	const out = await client.verifyProof('pr1');
	assert.equal(calls[0].url.pathname, '/api/irl/world-lines/verify/pr1');
	assert.equal(out.verified, true);
	assert.equal(out.proof.signatureScheme, 'ed25519');
	assert.equal(out.proof.collectibleMint, 'presence:pr1');
	await assert.rejects(() => client.verifyProof(''), /needs an id/);
});
