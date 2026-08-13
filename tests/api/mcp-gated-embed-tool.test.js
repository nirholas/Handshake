// create_gated_embed MCP tool (api/_mcp/tools/embed.js), registered in
// api/_mcp/catalog.js. (get_embed_code's dispatch path is covered end-to-end in
// tests/api/mcp-embed.test.js.)
//
// Verifies: the tool rejects a malformed asset ref before touching the gate
// store; a caller who does not own the asset is told so rather than gating
// someone else's avatar; a missing asset and a foreign asset stay
// indistinguishable to the caller so the tool cannot be used to probe which
// asset ids exist; the gate defaults to the $THREE mint but accepts any SPL
// mint supplied at runtime; the returned snippet points at this deployment's
// embed script; and an invalid gate configuration comes back as an invalid-params
// error instead of a bubbled fault. The gate store, asset resolver, and DB are
// mocked at their module boundary; the tool def runs real.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const THREE_MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
const OTHER_MINT = 'THREEsynthetic1111111111111111111111111111';
const AVATAR_REF = 'avatar:11111111-2222-4333-8444-555555555555';

vi.mock('../../api/_lib/db.js', () => ({ sql: vi.fn(async () => []) }));
vi.mock('../../api/_lib/embed-policy.js', () => ({ readEmbedPolicy: vi.fn(async () => null) }));
vi.mock('../../api/_lib/onchain.js', () => ({
	resolveOnChainAgent: vi.fn(async () => ({ name: 'Agent' })),
	SERVER_CHAIN_META: { 8453: { name: 'Base' } },
}));

const assetState = { asset: { name: 'My Avatar' }, ownership: { ok: true } };
vi.mock('../../api/_lib/embed-asset.js', () => ({
	isEmbedAssetRef: (ref) => /^avatar:[0-9a-f-]{36}$/i.test(ref) || /^\d+:\d+$/.test(ref),
	resolveEmbedAsset: vi.fn(async () => assetState.asset),
}));

const gateState = { error: null };
const createGateMock = vi.fn(async ({ assetId, mint, minAmount, chain }) => {
	if (gateState.error) throw gateState.error;
	return { gateId: 'gate-1', assetId, mint, minAmount, chain };
});
vi.mock('../../api/_lib/embed-gate.js', () => ({
	DEFAULT_GATE_MINT: THREE_MINT,
	createEmbedGate: (...a) => createGateMock(...a),
	checkAssetOwnership: vi.fn(async () => assetState.ownership),
}));

const { toolDefs } = await import('../../api/_mcp/tools/embed.js');

const REQ = { headers: { host: 'three.ws' } };
const AUTH = { userId: 'user-1', rateKey: 'gate-test', scope: 'avatars:write', source: 'oauth' };
const tool = toolDefs.find((t) => t.name === 'create_gated_embed');
const call = (args, auth = AUTH) => tool.handler(args, auth, REQ);

beforeEach(() => {
	assetState.asset = { name: 'My Avatar' };
	assetState.ownership = { ok: true };
	gateState.error = null;
	createGateMock.mockClear();
	delete process.env.APP_ORIGIN;
	delete process.env.PUBLIC_ORIGIN;
	delete process.env.PUBLIC_APP_ORIGIN;
});

describe('create_gated_embed: contract', () => {
	it('is a scoped write tool that names the default mint in its own schema', () => {
		expect(tool.scope).toBe('avatars:write');
		expect(tool.annotations).toEqual({
			readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true,
		});
		expect(tool.inputSchema.required).toEqual(['asset_id', 'min_amount']);
		expect(tool.inputSchema.properties.min_amount.exclusiveMinimum).toBe(0);
		expect(tool.inputSchema.properties.mint.description).toContain(THREE_MINT);
	});
});

describe('create_gated_embed: success path', () => {
	it('gates an owned avatar on $THREE by default and returns a pasteable snippet', async () => {
		const r = await call({ asset_id: AVATAR_REF, min_amount: 1000 });

		expect(createGateMock).toHaveBeenCalledWith({
			assetId: AVATAR_REF, ownerUserId: 'user-1', mint: THREE_MINT,
			minAmount: 1000, chain: 'solana',
		});
		expect(r.isError).toBeUndefined();
		expect(r.structuredContent).toEqual({
			ok: true, gate_id: 'gate-1', asset_id: AVATAR_REF,
			gate: { mint: THREE_MINT, min_amount: 1000, chain: 'solana' },
			embed_snippet: `<script src="https://three.ws/embed/v1.js" async></script>\n<three-d agent="${AVATAR_REF}" interactive></three-d>`,
		});
		// The default mint reads as the ticker, not a raw base58 blob.
		expect(r.content[0].text).toContain('$THREE');
		expect(r.content[0].text).toContain('My Avatar');
	});

	it('accepts any SPL mint supplied at runtime and labels it by address', async () => {
		const r = await call({ asset_id: AVATAR_REF, mint: OTHER_MINT, min_amount: 5 });
		expect(createGateMock.mock.calls[0][0].mint).toBe(OTHER_MINT);
		expect(r.structuredContent.gate.mint).toBe(OTHER_MINT);
		expect(r.content[0].text).toContain(OTHER_MINT);
		expect(r.content[0].text).not.toContain('$THREE');
	});

	it('builds the snippet against this deployment origin, not a hardcoded host', async () => {
		process.env.APP_ORIGIN = 'https://preview.three.ws/';
		const r = await call({ asset_id: AVATAR_REF, min_amount: 1 });
		expect(r.structuredContent.embed_snippet).toContain('https://preview.three.ws/embed/v1.js');
	});
});

describe('create_gated_embed: failure paths', () => {
	it('rejects a malformed asset ref before resolving anything', async () => {
		await expect(call({ asset_id: 'bogus', min_amount: 1 })).rejects.toMatchObject({
			code: -32602,
			message: 'asset_id must be "<chainId>:<agentId>" or "avatar:<uuid>"',
		});
		expect(createGateMock).not.toHaveBeenCalled();
	});

	it('refuses to gate an asset the caller does not own', async () => {
		assetState.ownership = { ok: false, reason: 'not_owner' };
		await expect(call({ asset_id: AVATAR_REF, min_amount: 1 })).rejects.toThrow(/do not own this asset/);
		expect(createGateMock).not.toHaveBeenCalled();
	});

	it('gives an unknown asset and a foreign account the same not-found answer', async () => {
		assetState.asset = null;
		await expect(call({ asset_id: AVATAR_REF, min_amount: 1 })).rejects.toThrow(
			`embed asset "${AVATAR_REF}" not found`,
		);

		assetState.asset = { name: 'Someone else' };
		assetState.ownership = { ok: false, reason: 'no_such_asset' };
		await expect(call({ asset_id: AVATAR_REF, min_amount: 1 })).rejects.toThrow(
			`embed asset "${AVATAR_REF}" not found`,
		);
	});

	it('turns an invalid gate configuration into an invalid-params error', async () => {
		gateState.error = new Error('min_amount must be greater than 0');
		await expect(call({ asset_id: AVATAR_REF, min_amount: 1 })).rejects.toMatchObject({
			code: -32602,
			message: 'min_amount must be greater than 0',
		});
	});
});
