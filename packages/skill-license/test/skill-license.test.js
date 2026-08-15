import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSkillLicense, skillSeed, PROGRAM_ID, ThreeWsError, PaymentRequiredError } from '../src/index.js';

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

// Synthetic, off-platform placeholders — never a real third-party address.
const HOLDER = 'HoLDeRwa11et1111111111111111111111111111111';
const AGENT = 'THREEsynthetic11111111111111111111111111111';
const LICENSE_PDA = 'LiCenSepda11111111111111111111111111111111';
const NFT_MINT = 'NftM1nt1111111111111111111111111111111111';

test('verifyLicense() queries by agent_mint and returns the owned boolean', async () => {
	const { fetch, calls } = stubFetch([
		{ body: { data: { owned: true, exists: true, revoked: false, deployed: true } } },
	]);
	const client = createSkillLicense({ fetch, baseUrl: 'https://three.ws' });
	const owns = await client.verifyLicense({ holder: HOLDER, agent: AGENT, skill: 'web-search' });

	assert.equal(calls[0].url.pathname, '/api/skills/license-onchain');
	assert.equal(calls[0].init.method, 'GET');
	assert.equal(calls[0].url.searchParams.get('wallet'), HOLDER);
	assert.equal(calls[0].url.searchParams.get('agent_mint'), AGENT);
	assert.equal(calls[0].url.searchParams.get('skill'), 'web-search');
	assert.ok(!calls[0].url.searchParams.has('agent_id'), 'agent wins over agentId');
	assert.equal(owns, true);
});

test('verifyLicense() resolves agentId to agent_id and reads false when not owned', async () => {
	const { fetch, calls } = stubFetch([
		{ body: { data: { owned: false, exists: false, revoked: false, deployed: true } } },
	]);
	const client = createSkillLicense({ fetch });
	const owns = await client.verifyLicense({
		holder: HOLDER,
		agentId: '3b1f0000-0000-4000-8000-000000000000',
		skill: 'web-search',
		network: 'devnet',
	});

	assert.equal(calls[0].url.searchParams.get('agent_id'), '3b1f0000-0000-4000-8000-000000000000');
	assert.equal(calls[0].url.searchParams.get('network'), 'devnet');
	assert.equal(owns, false);
});

test('getLicense() shapes the full record to camelCase', async () => {
	const { fetch } = stubFetch([
		{
			body: {
				data: {
					owned: true,
					exists: true,
					revoked: false,
					deployed: true,
					license: LICENSE_PDA,
					nft_mint: NFT_MINT,
					owner_token_account: 'ATA11111111111111111111111111111111111111',
					program_id: PROGRAM_ID,
					agent_mint: AGENT,
					skill: 'web-search',
					network: 'mainnet',
					explorer: `https://explorer.solana.com/address/${LICENSE_PDA}`,
					record: {
						authority: HOLDER,
						agentMint: AGENT,
						nftMint: NFT_MINT,
						skillHash: 'a'.repeat(64),
						purchaseDate: 1700000000,
						revokedAt: 0,
						skillName: 'web-search',
					},
				},
			},
		},
	]);
	const client = createSkillLicense({ fetch });
	const lic = await client.getLicense({ holder: HOLDER, agent: AGENT, skill: 'web-search' });

	assert.ok(lic);
	assert.equal(lic.owned, true);
	assert.equal(lic.nftMint, NFT_MINT);
	assert.equal(lic.ownerTokenAccount, 'ATA11111111111111111111111111111111111111');
	assert.equal(lic.purchaseDate, 1700000000);
	assert.equal(lic.revokedAt, 0);
	assert.equal(lic.license, LICENSE_PDA);
	assert.equal(lic.skillHash, 'a'.repeat(64));
	assert.equal(lic.programId, PROGRAM_ID);
	assert.equal(lic.raw.skill, 'web-search');
});

test('getLicense() returns null when no PDA exists', async () => {
	const { fetch } = stubFetch([
		{ body: { data: { owned: false, exists: false, revoked: false, deployed: true, license: LICENSE_PDA } } },
	]);
	const client = createSkillLicense({ fetch });
	const lic = await client.getLicense({ holder: HOLDER, agent: AGENT, skill: 'never-bought' });
	assert.equal(lic, null);
});

test('mintLicense() posts the snake_case body and attaches the per-call bearer', async () => {
	const { fetch, calls } = stubFetch([
		{
			status: 201,
			body: {
				data: {
					nftMint: NFT_MINT,
					signature: '4xKpPurchaseSig11111111111111111111111111111111111111111111111111',
					network: 'mainnet',
					skill: 'web-search',
					agent_id: '3b1f0000-0000-4000-8000-000000000000',
					purchase_id: 'p1',
					already_minted: false,
				},
			},
		},
	]);
	const client = createSkillLicense({ fetch });
	const res = await client.mintLicense({
		agentId: '3b1f0000-0000-4000-8000-000000000000',
		skill: 'web-search',
		buyer: HOLDER,
		txSignature: '4xKpPurchaseSig11111111111111111111111111111111111111111111111111',
		apiKey: 'tw_test_key',
	});

	assert.equal(calls[0].url.pathname, '/api/skills/mint');
	assert.equal(calls[0].init.method, 'POST');
	assert.equal(calls[0].init.headers.authorization, 'Bearer tw_test_key');
	const sent = JSON.parse(calls[0].init.body);
	assert.equal(sent.agent_id, '3b1f0000-0000-4000-8000-000000000000');
	assert.equal(sent.skill_name, 'web-search');
	assert.equal(sent.user_wallet, HOLDER);
	assert.equal(sent.transaction_signature, '4xKpPurchaseSig11111111111111111111111111111111111111111111111111');
	assert.equal(res.nftMint, NFT_MINT);
	assert.equal(res.agentId, '3b1f0000-0000-4000-8000-000000000000');
	assert.equal(res.alreadyMinted, false);
});

test('inputs are validated before any network call', async () => {
	const { fetch, calls } = stubFetch([]);
	const client = createSkillLicense({ fetch });
	await assert.rejects(() => client.verifyLicense({ holder: HOLDER, skill: 'x' }), /agent.*or.*agentId/i);
	await assert.rejects(() => client.verifyLicense({ holder: HOLDER, agent: AGENT }), /skill is required/);
	await assert.rejects(() => client.verifyLicense({ holder: HOLDER, agent: AGENT, skill: 'x', network: 'testnet' }), /Invalid network/);
	await assert.rejects(() => client.mintLicense({ skill: 'x', buyer: HOLDER }), /agentId is required/);
	assert.equal(calls.length, 0);
});

test('mint payment_pending (402) surfaces as PaymentRequiredError', async () => {
	const accepts = [{ scheme: 'exact', asset: 'USDC', network: 'solana', maxAmountRequired: '500000' }];
	const { fetch } = stubFetch([
		{ status: 402, body: { error: 'payment_pending', message: 'payment is pending; cannot mint until confirmed', accepts } },
	]);
	const client = createSkillLicense({ fetch });
	await assert.rejects(
		() => client.mintLicense({ agentId: '3b1f0000-0000-4000-8000-000000000000', skill: 'web-search', buyer: HOLDER, apiKey: 'k' }),
		(e) => {
			assert.ok(e instanceof PaymentRequiredError);
			assert.equal(e.code, 'payment_pending');
			assert.deepEqual(e.accepts, accepts);
			return true;
		},
	);
});

test('wallet_not_linked (403) surfaces as a typed ThreeWsError', async () => {
	const { fetch } = stubFetch([
		{ status: 403, body: { error: 'wallet_not_linked', message: 'user_wallet must be a Solana wallet linked to your account' } },
	]);
	const client = createSkillLicense({ fetch });
	await assert.rejects(
		() => client.mintLicense({ agentId: '3b1f0000-0000-4000-8000-000000000000', skill: 'web-search', buyer: HOLDER, apiKey: 'k' }),
		(e) => {
			assert.ok(e instanceof ThreeWsError);
			assert.equal(e.code, 'wallet_not_linked');
			assert.equal(e.status, 403);
			return true;
		},
	);
});

test('skillSeed() matches the Rust skill_seed (sha256 hex)', async () => {
	// sha256("web-search") — the deterministic third PDA seed both sides derive.
	const hash = await skillSeed('web-search');
	assert.match(hash, /^[0-9a-f]{64}$/);
	const { createHash } = await import('node:crypto');
	const expected = createHash('sha256').update('web-search', 'utf8').digest('hex');
	assert.equal(hash, expected);
});
