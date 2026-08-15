// GET /api/sns?...&domains=1 (api/sns.js).
//
// The regression this pins: @three-ws/names has always mapped `all_domains` and
// `favorite_domain` off this endpoint's envelope, but nothing ever put them
// there, so both fields were permanently empty while the SDK README documented
// them as populated. They are now real, opt-in, and off the default path: a
// plain resolve must stay one cache-friendly URL with no SNS-index round trip,
// because the reverse lookup here runs on every page load.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const resolveSnsName = vi.fn();
const reverseLookupAddress = vi.fn();
const snsOwnerDomains = vi.fn();

vi.mock('../../src/solana/sns.js', () => ({
	resolveSnsName: (...a) => resolveSnsName(...a),
	reverseLookupAddress: (...a) => reverseLookupAddress(...a),
	snsOwnerDomains: (...a) => snsOwnerDomains(...a),
}));
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: { snsResolve: async () => ({ success: true }) },
	clientIp: () => '127.0.0.1',
}));

const { default: handler, _internals } = await import('../../api/sns.js');

const OWNER = 'THREEsynthetic1111111111111111111111111111';

function call(url) {
	const res = {
		statusCode: 0,
		body: null,
		headers: {},
		setHeader(k, v) {
			this.headers[k.toLowerCase()] = v;
		},
		getHeader(k) {
			return this.headers[k.toLowerCase()];
		},
		end(b) {
			this.body = b ? JSON.parse(b) : null;
		},
		get headersSent() {
			return this.body !== null;
		},
		get writableEnded() {
			return this.body !== null;
		},
	};
	const req = { method: 'GET', url, headers: { host: 'three.ws' } };
	return handler(req, res).then(() => res);
}

beforeEach(() => {
	resolveSnsName.mockReset();
	reverseLookupAddress.mockReset();
	snsOwnerDomains.mockReset();
	// Module-level caches are shared across tests in this file; a stale entry
	// would make a later assertion pass for the wrong reason.
	_internals.forwardCache.clear();
	_internals.reverseCache.clear();
	_internals.domainsCache.clear();
});

afterEach(() => {
	_internals.domainsCache.clear();
});

describe('GET /api/sns', () => {
	it('leaves the domain list off a plain forward resolve', async () => {
		resolveSnsName.mockResolvedValue(OWNER);
		const res = await call('/api/sns?name=three.sol');

		expect(res.statusCode).toBe(200);
		expect(res.body.data).toEqual({
			name: 'three.sol',
			address: OWNER,
			network: 'solana',
			resolved: true,
		});
		expect(snsOwnerDomains).not.toHaveBeenCalled();
	});

	it('adds the owner domain list and favorite when domains=1', async () => {
		resolveSnsName.mockResolvedValue(OWNER);
		snsOwnerDomains.mockResolvedValue({
			allDomains: ['three.sol', 'threews.sol'],
			favoriteDomain: 'three.sol',
			truncated: false,
		});
		const res = await call('/api/sns?name=three.sol&domains=1');

		expect(res.statusCode).toBe(200);
		expect(snsOwnerDomains).toHaveBeenCalledWith(OWNER);
		expect(res.body.data.all_domains).toEqual(['three.sol', 'threews.sol']);
		expect(res.body.data.favorite_domain).toBe('three.sol');
		expect(res.body.data.domains_truncated).toBe(false);
	});

	it('accepts the truthy spellings of the flag and ignores anything else', async () => {
		resolveSnsName.mockResolvedValue(OWNER);
		snsOwnerDomains.mockResolvedValue({ allDomains: ['three.sol'], favoriteDomain: null, truncated: false });

		for (const flag of ['1', 'true', 'TRUE', 'yes']) {
			_internals.forwardCache.clear();
			const res = await call(`/api/sns?name=three.sol&domains=${flag}`);
			expect(res.body.data.all_domains, `flag=${flag}`).toEqual(['three.sol']);
		}

		snsOwnerDomains.mockClear();
		_internals.forwardCache.clear();
		const off = await call('/api/sns?name=three.sol&domains=0');
		expect(off.body.data.all_domains).toBeUndefined();
		expect(snsOwnerDomains).not.toHaveBeenCalled();
	});

	it('caches the owner lookup so a second resolve of the same owner is free', async () => {
		resolveSnsName.mockResolvedValue(OWNER);
		snsOwnerDomains.mockResolvedValue({ allDomains: ['three.sol'], favoriteDomain: 'three.sol', truncated: false });

		await call('/api/sns?name=three.sol&domains=1');
		_internals.forwardCache.clear();
		await call('/api/sns?name=three.sol&domains=1');

		expect(snsOwnerDomains).toHaveBeenCalledTimes(1);
	});

	it('still answers with the plain envelope when the SNS index is down', async () => {
		resolveSnsName.mockResolvedValue(OWNER);
		snsOwnerDomains.mockRejectedValue(new Error('sns index 503'));
		const res = await call('/api/sns?name=three.sol&domains=1');

		expect(res.statusCode).toBe(200);
		expect(res.body.data.address).toBe(OWNER);
		expect(res.body.data.all_domains).toBeUndefined();
	});

	it('lists a wallet holding domains but no favorite on a reverse miss', async () => {
		reverseLookupAddress.mockResolvedValue(null);
		snsOwnerDomains.mockResolvedValue({ allDomains: ['three.sol'], favoriteDomain: null, truncated: false });
		const res = await call(`/api/sns?address=${OWNER}&domains=1`);

		expect(res.statusCode).toBe(200);
		expect(res.body.data.resolved).toBe(false);
		expect(res.body.data.name).toBeNull();
		expect(res.body.data.all_domains).toEqual(['three.sol']);
	});

	it('adds the list to a resolved reverse lookup too', async () => {
		reverseLookupAddress.mockResolvedValue('three.sol');
		snsOwnerDomains.mockResolvedValue({ allDomains: ['three.sol'], favoriteDomain: 'three.sol', truncated: true });
		const res = await call(`/api/sns?address=${OWNER}&domains=1`);

		expect(res.body.data.name).toBe('three.sol');
		expect(res.body.data.domains_truncated).toBe(true);
	});
});
