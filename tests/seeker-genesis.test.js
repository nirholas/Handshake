// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
	isSeekerGenesisMint,
	findSeekerGenesisToken,
	SGT_TOKEN_2022_PROGRAM,
	SGT_MINT_AUTHORITY,
	SGT_GROUP,
} from '../api/_lib/seeker-genesis.js';

const WALLET = 'THREEsynthetic1111111111111111111111111111';
const SGT_MINT = 'THREEsyntheticSgtMint111111111111111111111';
const OTHER_MINT = 'THREEsyntheticOtherMint1111111111111111111';
const RPC_URL = 'https://rpc.test/';

function mintAccount({ authority = SGT_MINT_AUTHORITY, pointer = SGT_GROUP, group = SGT_GROUP, omitMember = false } = {}) {
	const extensions = [{ extension: 'metadataPointer', state: { authority: SGT_MINT_AUTHORITY, metadataAddress: pointer } }];
	if (!omitMember) extensions.push({ extension: 'tokenGroupMember', state: { mint: SGT_MINT, group, memberNumber: 7 } });
	return {
		owner: SGT_TOKEN_2022_PROGRAM,
		data: { program: 'spl-token-2022', parsed: { type: 'mint', info: { mintAuthority: authority, supply: '1', decimals: 0, extensions } } },
	};
}

function tokenAccount(pubkey, mint, amount = '1') {
	return { pubkey, account: { data: { parsed: { type: 'account', info: { mint, tokenAmount: { amount, decimals: 0 } } } } } };
}

function stubFetch(responder) {
	const calls = [];
	const fetchImpl = async (url, init) => {
		const req = JSON.parse(init.body);
		calls.push(req);
		const out = responder(req, calls.length);
		return { ok: true, json: async () => ({ jsonrpc: '2.0', id: req.id, ...out }) };
	};
	return { fetchImpl, calls };
}

describe('isSeekerGenesisMint', () => {
	it('accepts a mint with the SGT authority, pointer, and group member', () => {
		expect(isSeekerGenesisMint(mintAccount())).toBe(true);
	});
	it('rejects the wrong mint authority', () => {
		expect(isSeekerGenesisMint(mintAccount({ authority: WALLET }))).toBe(false);
	});
	it('rejects a mint without a token-group-member extension', () => {
		expect(isSeekerGenesisMint(mintAccount({ omitMember: true }))).toBe(false);
	});
	it('rejects a member of another group', () => {
		expect(isSeekerGenesisMint(mintAccount({ group: OTHER_MINT }))).toBe(false);
	});
	it('rejects a metadata pointer aimed elsewhere', () => {
		expect(isSeekerGenesisMint(mintAccount({ pointer: OTHER_MINT }))).toBe(false);
	});
	it('rejects null and non-mint accounts', () => {
		expect(isSeekerGenesisMint(null)).toBe(false);
		expect(isSeekerGenesisMint({ data: { parsed: { type: 'account', info: {} } } })).toBe(false);
	});
});

describe('findSeekerGenesisToken', () => {
	it('finds the SGT across two pages of token accounts', async () => {
		const { fetchImpl, calls } = stubFetch((req) => {
			if (req.method === 'getTokenAccountsByOwnerV2') {
				const opts = req.params[2];
				expect(req.params[0]).toBe(WALLET);
				expect(req.params[1]).toEqual({ programId: SGT_TOKEN_2022_PROGRAM });
				expect(opts.encoding).toBe('jsonParsed');
				expect(opts.limit).toBe(1000);
				if (!opts.paginationKey) {
					return { result: { accounts: [tokenAccount('ta1', OTHER_MINT)], paginationKey: 'page2' } };
				}
				expect(opts.paginationKey).toBe('page2');
				return { result: { accounts: [tokenAccount('ta2', SGT_MINT)], paginationKey: null } };
			}
			if (req.method === 'getMultipleAccounts') {
				expect(req.params[0]).toEqual([OTHER_MINT, SGT_MINT]);
				expect(req.params[1]).toEqual({ encoding: 'jsonParsed' });
				return { result: { value: [mintAccount({ authority: WALLET }), mintAccount()] } };
			}
			throw new Error(`unexpected method ${req.method}`);
		});
		const hit = await findSeekerGenesisToken(WALLET, { fetchImpl, rpcUrl: RPC_URL });
		expect(hit).toEqual({ mint: SGT_MINT, tokenAccount: 'ta2' });
		expect(calls.map((c) => c.method)).toEqual(['getTokenAccountsByOwnerV2', 'getTokenAccountsByOwnerV2', 'getMultipleAccounts']);
	});

	it('returns null when no held mint is an SGT', async () => {
		const { fetchImpl } = stubFetch((req) => {
			if (req.method === 'getTokenAccountsByOwnerV2') return { result: { accounts: [tokenAccount('ta1', OTHER_MINT)], paginationKey: null } };
			return { result: { value: [mintAccount({ group: OTHER_MINT })] } };
		});
		expect(await findSeekerGenesisToken(WALLET, { fetchImpl, rpcUrl: RPC_URL })).toBeNull();
	});

	it('ignores zero-balance token accounts and skips the mint lookup', async () => {
		const { fetchImpl, calls } = stubFetch(() => ({ result: { accounts: [tokenAccount('ta1', SGT_MINT, '0')], paginationKey: null } }));
		expect(await findSeekerGenesisToken(WALLET, { fetchImpl, rpcUrl: RPC_URL })).toBeNull();
		expect(calls).toHaveLength(1);
	});

	it('throws on a JSON-RPC error envelope instead of returning false', async () => {
		const { fetchImpl } = stubFetch(() => ({ error: { code: -32005, message: 'rate limited' } }));
		await expect(findSeekerGenesisToken(WALLET, { fetchImpl, rpcUrl: RPC_URL })).rejects.toThrow(/rate limited/);
	});

	it('throws on a non-200 transport response', async () => {
		const fetchImpl = async () => ({ ok: false, status: 503, json: async () => ({}) });
		await expect(findSeekerGenesisToken(WALLET, { fetchImpl, rpcUrl: RPC_URL })).rejects.toThrow(/503/);
	});

	it('throws when no RPC endpoint is configured', async () => {
		await expect(findSeekerGenesisToken(WALLET, { fetchImpl: async () => ({}), rpcUrl: null })).rejects.toThrow(/HELIUS_API_KEY/);
	});
});
