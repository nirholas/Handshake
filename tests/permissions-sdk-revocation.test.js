// The SDK's on-chain revocation check is the last gate before an agent honours a
// delegation, and it was failing open twice over: it eth_call'd a selector
// (0xa1a5bdd0) that matches no method on the DelegationManager, and it read a
// missing `result` as "not disabled". A revoked delegation therefore came back
// valid. These tests pin the real selector and that an unanswered check raises
// instead of returning valid.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { id as keccakId } from 'ethers';

import { isDelegationValid, PermissionError } from '../sdk/src/permissions/toolkit.js';

const CHAIN = 84532;
const MANAGER = '0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3';
const HASH = '0x' + 'ab'.repeat(32);
const DISABLED_SELECTOR = keccakId('disabledDelegations(bytes32)').slice(0, 10);

const originalFetch = global.fetch;
let lastBody = null;

function mockRpc(response) {
	global.fetch = async (_url, opts) => {
		lastBody = JSON.parse(opts.body);
		return { json: async () => response };
	};
}

beforeEach(() => {
	lastBody = null;
	process.env[`THREE_WS_DELEGATION_MANAGER_${CHAIN}`] = MANAGER;
});

afterEach(() => {
	global.fetch = originalFetch;
	delete process.env[`THREE_WS_DELEGATION_MANAGER_${CHAIN}`];
});

describe('sdk isDelegationValid', () => {
	it('calls disabledDelegations(bytes32) with the delegation hash', async () => {
		mockRpc({ jsonrpc: '2.0', id: 1, result: '0x' + '0'.repeat(64) });
		const out = await isDelegationValid({ hash: HASH, chainId: CHAIN, rpcUrl: 'http://rpc.test' });
		expect(out).toEqual({ valid: true });
		expect(lastBody.method).toBe('eth_call');
		expect(lastBody.params[0].to).toBe(MANAGER);
		expect(lastBody.params[0].data.slice(0, 10)).toBe(DISABLED_SELECTOR);
		expect(lastBody.params[0].data.slice(10)).toBe(HASH.slice(2));
	});

	it('reports a disabled delegation as revoked', async () => {
		mockRpc({ jsonrpc: '2.0', id: 1, result: '0x' + '0'.repeat(63) + '1' });
		const out = await isDelegationValid({ hash: HASH, chainId: CHAIN, rpcUrl: 'http://rpc.test' });
		expect(out).toEqual({ valid: false, reason: 'delegation_revoked' });
	});

	it('throws rather than failing open when the node returns an error', async () => {
		mockRpc({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'execution reverted' } });
		await expect(
			isDelegationValid({ hash: HASH, chainId: CHAIN, rpcUrl: 'http://rpc.test' }),
		).rejects.toThrow(PermissionError);
	});

	it('throws rather than failing open when the node returns no result', async () => {
		mockRpc({ jsonrpc: '2.0', id: 1 });
		await expect(
			isDelegationValid({ hash: HASH, chainId: CHAIN, rpcUrl: 'http://rpc.test' }),
		).rejects.toMatchObject({ code: 'rpc_error' });
	});

	it('refuses to guess a manager address for a chain with no deployment', async () => {
		delete process.env[`THREE_WS_DELEGATION_MANAGER_${CHAIN}`];
		mockRpc({ jsonrpc: '2.0', id: 1, result: '0x' + '0'.repeat(64) });
		await expect(
			isDelegationValid({ hash: HASH, chainId: CHAIN, rpcUrl: 'http://rpc.test' }),
		).rejects.toMatchObject({ code: 'chain_not_supported' });
	});
});
