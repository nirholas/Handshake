import { describe, it, expect, vi, beforeEach } from 'vitest';

const resolveMock = vi.fn();
const getFavoriteDomainMock = vi.fn();

vi.mock('@bonfida/spl-name-service', () => ({
	resolve: (...a) => resolveMock(...a),
	getFavoriteDomain: (...a) => getFavoriteDomainMock(...a),
}));

vi.mock('@solana/web3.js', () => {
	class PublicKey {
		constructor(value) {
			this._value = String(value);
		}
		toBase58() {
			return this._value;
		}
	}
	class Connection {}
	return { Connection, PublicKey };
});

const { resolveSnsName, reverseLookupAddress, resolveSolanaRecipient } = await import('../src/solana/sns.js');

describe('resolveSnsName', () => {
	beforeEach(() => {
		resolveMock.mockReset();
	});

	it('returns base58 address for a known domain', async () => {
		const fakeKey = { toBase58: () => 'HKKp49zUBeaABFMpBWKCJPoNDLiR4AEEr8FJKuZPn6Nk' };
		resolveMock.mockResolvedValue(fakeKey);
		const result = await resolveSnsName('bonfida.sol');
		expect(result).toBe('HKKp49zUBeaABFMpBWKCJPoNDLiR4AEEr8FJKuZPn6Nk');
		expect(resolveMock).toHaveBeenCalledWith(expect.anything(), 'bonfida');
	});

	it('strips the .sol suffix before calling resolve', async () => {
		resolveMock.mockResolvedValue({ toBase58: () => 'AAA' });
		await resolveSnsName('test.sol');
		expect(resolveMock).toHaveBeenCalledWith(expect.anything(), 'test');
	});

	it('accepts a name without .sol suffix', async () => {
		resolveMock.mockResolvedValue({ toBase58: () => 'BBB' });
		await resolveSnsName('test');
		expect(resolveMock).toHaveBeenCalledWith(expect.anything(), 'test');
	});

	it('returns null for a non-existent domain', async () => {
		resolveMock.mockRejectedValue(new Error('DomainDoesNotExist'));
		const result = await resolveSnsName('nope-not-real-domain-xyz.sol');
		expect(result).toBeNull();
	});

	it('returns null on any resolution error', async () => {
		resolveMock.mockRejectedValue(new Error('network error'));
		expect(await resolveSnsName('anything.sol')).toBeNull();
	});
});

describe('reverseLookupAddress', () => {
	beforeEach(() => {
		getFavoriteDomainMock.mockReset();
	});

	it('returns .sol domain for a known address', async () => {
		getFavoriteDomainMock.mockResolvedValue({ reverse: 'bonfida', stale: false });
		const result = await reverseLookupAddress('HKKp49zUBeaABFMpBWKCJPoNDLiR4AEEr8FJKuZPn6Nk');
		expect(result).toBe('bonfida.sol');
	});

	it('appends .sol when the reverse result omits it', async () => {
		getFavoriteDomainMock.mockResolvedValue({ reverse: 'myname', stale: false });
		expect(await reverseLookupAddress('someaddr')).toBe('myname.sol');
	});

	it('does not double-append .sol when reverse already includes it', async () => {
		getFavoriteDomainMock.mockResolvedValue({ reverse: 'already.sol', stale: false });
		expect(await reverseLookupAddress('someaddr')).toBe('already.sol');
	});

	it('returns null when no favourite domain is found', async () => {
		getFavoriteDomainMock.mockRejectedValue(new Error('FavouriteDomainNotFoundError'));
		const result = await reverseLookupAddress('HKKp49zUBeaABFMpBWKCJPoNDLiR4AEEr8FJKuZPn6Nk');
		expect(result).toBeNull();
	});

	it('returns null on any reverse-lookup error', async () => {
		getFavoriteDomainMock.mockRejectedValue(new Error('network error'));
		expect(await reverseLookupAddress('someaddr')).toBeNull();
	});
});

describe('resolveSolanaRecipient', () => {
	beforeEach(() => {
		resolveMock.mockReset();
	});

	const VALID_ADDR = 'HKKp49zUBeaABFMpBWKCJPoNDLiR4AEEr8FJKuZPn6Nk';

	it('passes a raw base58 address through unchanged', async () => {
		const out = await resolveSolanaRecipient(VALID_ADDR);
		expect(out).toEqual({ address: VALID_ADDR, resolved_from: null });
		expect(resolveMock).not.toHaveBeenCalled();
	});

	it('resolves a .sol name and reports what it resolved from', async () => {
		resolveMock.mockResolvedValue({ toBase58: () => VALID_ADDR });
		const out = await resolveSolanaRecipient('bonfida.sol');
		expect(out).toEqual({ address: VALID_ADDR, resolved_from: 'bonfida.sol' });
		expect(resolveMock).toHaveBeenCalledWith(expect.anything(), 'bonfida');
	});

	it('resolves a bare label without the .sol suffix', async () => {
		resolveMock.mockResolvedValue({ toBase58: () => VALID_ADDR });
		const out = await resolveSolanaRecipient('bonfida');
		expect(out.address).toBe(VALID_ADDR);
		expect(out.resolved_from).toBe('bonfida.sol');
	});

	it('returns null address when the name does not resolve', async () => {
		resolveMock.mockResolvedValue(null);
		const out = await resolveSolanaRecipient('does-not-exist.sol');
		expect(out).toEqual({ address: null, resolved_from: null });
	});

	it('returns null address for malformed input', async () => {
		const out = await resolveSolanaRecipient('NOT*A*NAME');
		expect(out.address).toBeNull();
		expect(resolveMock).not.toHaveBeenCalled();
	});

	it('does not blindly trust a non-base58 result from the SNS sdk', async () => {
		resolveMock.mockResolvedValue({ toBase58: () => '!!not-base58!!' });
		const out = await resolveSolanaRecipient('weird.sol');
		expect(out.address).toBeNull();
	});

	it('handles dotted subdomain SNS names', async () => {
		resolveMock.mockResolvedValue({ toBase58: () => VALID_ADDR });
		const out = await resolveSolanaRecipient('nich.threews.sol');
		expect(out.address).toBe(VALID_ADDR);
		expect(out.resolved_from).toBe('nich.threews.sol');
		expect(resolveMock).toHaveBeenCalledWith(expect.anything(), 'nich.threews');
	});
});
