// 3D tokenization MCP tools (api/_mcp/tools/tokenize.js), registered in
// api/_mcp/catalog.js.
//
// Verifies: mint_3d_asset only ever declares a collected mint fee for a genuine
// per-call x402 settlement (an OAuth bearer and an unpaid x402 principal both
// declare zero, so a remix royalty can never split a fee nobody paid); the
// caller's arguments reach the minting lib under their internal names; a
// pending mint tells the agent to read it back rather than reporting a mint
// address it does not have; a handled boundary error becomes a clean isError
// result while an unexpected fault still bubbles for the dispatcher to
// sanitize; and get_3d_asset_onchain returns the live asset for a real mint and
// a designed error for a malformed one.
//
// The Solana minting lib is mocked at its module boundary, so no test ever
// signs or settles on-chain. The tool defs and their fee logic run real.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mintMock = vi.fn();
const readMock = vi.fn();
const ROYALTY_CAP_BPS = 1000;

vi.mock('../../api/_lib/tokenize-3d.js', () => ({
	mintTokenized3dAsset: (...a) => mintMock(...a),
	readTokenized3dAsset: (...a) => readMock(...a),
	TOKENIZE_3D_ROYALTY_CAP_BPS: ROYALTY_CAP_BPS,
}));

vi.mock('../../api/_lib/pump-pricing.js', () => ({
	priceFor: (name) => (name === 'mint_3d_asset' ? { amount_usdc: 0.25 } : null),
}));

const { toolDefs } = await import('../../api/_mcp/tools/tokenize.js');

const MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
const AVATAR_ID = '11111111-2222-4333-8444-555555555555';
const call = (name, args, auth) => toolDefs.find((t) => t.name === name).handler(args, auth, {});

const MINTED = {
	status: 'minted', idempotent: false, name: 'Test Avatar', network: 'devnet', mint: MINT,
	explorer_asset_url: 'https://explorer.test/asset', explorer_tx_url: 'https://explorer.test/tx',
	viewer_url: 'https://three.ws/viewer', provenance_ledger: { action_id: 42, signed: true },
	royalty: { percent: 5, cap_basis_points: ROYALTY_CAP_BPS, capped: false, requested_basis_points: 500 },
};

beforeEach(() => {
	mintMock.mockReset();
	readMock.mockReset();
	mintMock.mockResolvedValue(MINTED);
});

describe('tokenize MCP tools: registration', () => {
	it('registers a write tool and a read tool with the royalty cap in their contract', () => {
		const byName = Object.fromEntries(toolDefs.map((t) => [t.name, t]));
		expect(Object.keys(byName)).toEqual(['mint_3d_asset', 'get_3d_asset_onchain']);
		expect(byName.mint_3d_asset.annotations).toEqual({
			readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true,
		});
		expect(byName.get_3d_asset_onchain.annotations.readOnlyHint).toBe(true);
		expect(byName.mint_3d_asset.inputSchema.properties.seller_fee_basis_points.maximum).toBe(ROYALTY_CAP_BPS);
		expect(byName.mint_3d_asset.inputSchema.properties.network.default).toBe('devnet');
		expect(byName.get_3d_asset_onchain.inputSchema.required).toEqual(['mint']);
	});
});

describe('mint_3d_asset: collected-fee accounting', () => {
	it('declares the collected fee only for a settled per-call x402 payment', async () => {
		await call('mint_3d_asset', { avatar_id: AVATAR_ID }, { source: 'x402', x402Paid: true, userId: null });
		expect(mintMock.mock.calls[0][0].mintFeeAtomicsCollected).toBe(250_000n);
	});

	it('declares zero for an OAuth bearer and for an unpaid x402 principal', async () => {
		await call('mint_3d_asset', { avatar_id: AVATAR_ID }, { source: 'oauth', userId: 'user-1' });
		expect(mintMock.mock.calls[0][0].mintFeeAtomicsCollected).toBe(0n);

		mintMock.mockClear();
		await call('mint_3d_asset', { avatar_id: AVATAR_ID }, { source: 'x402', x402Paid: false, userId: null });
		expect(mintMock.mock.calls[0][0].mintFeeAtomicsCollected).toBe(0n);
	});
});

describe('mint_3d_asset: argument and result mapping', () => {
	it('forwards every caller argument under its internal name', async () => {
		await call('mint_3d_asset', {
			glb_url: 'https://cdn.test/model.glb', owner_wallet: 'OwnerWallet111',
			name: 'Remix', description: 'a remix', network: 'mainnet',
			seller_fee_basis_points: 500, royalty_recipient: 'RoyaltyWallet111',
			parent_mint: 'ParentMint111', prompt: 'a chrome robot',
			generation_model: 'model-x', generation_provider: 'provider-y',
			idempotency_key: 'key-1',
		}, { source: 'oauth', userId: 'user-1' });

		expect(mintMock.mock.calls[0][0]).toMatchObject({
			avatarId: undefined, glbUrl: 'https://cdn.test/model.glb', ownerWallet: 'OwnerWallet111',
			requesterId: 'user-1', name: 'Remix', description: 'a remix', network: 'mainnet',
			sellerFeeBasisPoints: 500, royaltyRecipient: 'RoyaltyWallet111', parentMint: 'ParentMint111',
			prompt: 'a chrome robot', generationModel: 'model-x', generationProvider: 'provider-y',
			idempotencyKey: 'key-1',
		});
	});

	it('defaults to devnet and a null requester for an anonymous payer', async () => {
		await call('mint_3d_asset', { glb_url: 'https://cdn.test/m.glb' }, { source: 'x402', x402Paid: true });
		expect(mintMock.mock.calls[0][0]).toMatchObject({ network: 'devnet', requesterId: null });
	});

	it('summarizes a completed mint with its explorer, viewer, royalty, and provenance links', async () => {
		const r = await call('mint_3d_asset', { avatar_id: AVATAR_ID }, { source: 'oauth', userId: 'user-1' });
		expect(r.isError).toBeUndefined();
		expect(r.structuredContent).toEqual(MINTED);
		const text = r.content[0].text;
		expect(text).toContain(`Mint: ${MINT}`);
		expect(text).toContain('https://explorer.test/tx');
		expect(text).toContain('Royalty: 5% (cap 10%)');
		expect(text).toContain('ledger action #42 (signed)');
	});

	it('reports a clamped royalty and a paid remix split', async () => {
		mintMock.mockResolvedValue({
			...MINTED, idempotent: true,
			royalty: { percent: 10, cap_basis_points: ROYALTY_CAP_BPS, capped: true, requested_basis_points: 5000 },
			remix_royalty: { paid: true, creator_usd: '0.05', creator_tx: 'TxSig111' },
		});
		const r = await call('mint_3d_asset', { avatar_id: AVATAR_ID }, { source: 'oauth', userId: 'user-1' });
		expect(r.content[0].text).toContain('Already minted');
		expect(r.content[0].text).toContain('requested 50%, clamped');
		expect(r.content[0].text).toContain('0.05 USDC paid to the source creator (TxSig111)');
	});

	it('tells the agent to read a pending mint back instead of naming a mint it lacks', async () => {
		mintMock.mockResolvedValue({ status: 'pending' });
		const r = await call('mint_3d_asset', { avatar_id: AVATAR_ID }, { source: 'oauth', userId: 'user-1' });
		expect(r.content[0].text).toContain('get_3d_asset_onchain');
		expect(r.content[0].text).not.toContain('Mint: undefined');
	});
});

describe('tokenize MCP tools: failure paths', () => {
	it('turns a handled boundary error into a clean tool error', async () => {
		mintMock.mockRejectedValue(Object.assign(new Error('provide either avatar_id or glb_url'), {
			status: 400, code: 'invalid_request',
		}));
		const r = await call('mint_3d_asset', {}, { source: 'oauth', userId: 'user-1' });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toBe('Error: provide either avatar_id or glb_url');
	});

	it('lets an unexpected fault bubble to the dispatcher instead of masking it', async () => {
		mintMock.mockRejectedValue(new Error('connection terminated unexpectedly'));
		await expect(call('mint_3d_asset', { avatar_id: AVATAR_ID }, { source: 'oauth', userId: 'user-1' }))
			.rejects.toThrow('connection terminated unexpectedly');
	});

	it('resolves a mint to its live asset and errors cleanly on a malformed one', async () => {
		readMock.mockResolvedValue({ mint: MINT, holder: 'HolderWallet111', viewer_url: 'https://three.ws/viewer' });
		const ok = await call('get_3d_asset_onchain', { mint: MINT, network: 'mainnet' }, { source: 'x402' });
		expect(readMock).toHaveBeenCalledWith({ mint: MINT, network: 'mainnet' });
		expect(ok.structuredContent.holder).toBe('HolderWallet111');
		expect(JSON.parse(ok.content[0].text).mint).toBe(MINT);

		readMock.mockRejectedValue(Object.assign(new Error('mint is not a valid Solana address'), {
			status: 400, code: 'invalid_mint',
		}));
		const bad = await call('get_3d_asset_onchain', { mint: 'nope' }, { source: 'x402' });
		expect(bad.isError).toBe(true);
		expect(bad.content[0].text).toBe('Error: mint is not a valid Solana address');
	});

	it('defaults the read network to devnet', async () => {
		readMock.mockResolvedValue({ mint: MINT });
		await call('get_3d_asset_onchain', { mint: MINT }, { source: 'x402' });
		expect(readMock).toHaveBeenCalledWith({ mint: MINT, network: 'devnet' });
	});
});
