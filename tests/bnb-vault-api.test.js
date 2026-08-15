/**
 * `api/vault/{list,status,unlock,download,buy-policy-data}.js` integration tests.
 *
 * The signature/auth boundary (`api/_lib/bnb/vault-unlock-auth.js`), the crypto
 * boundary (`api/_lib/bnb/vault-crypto.js` wrapKey/unwrapKey, `secret-box.js`
 * encryptSecret/decryptSecret), the download-token HMAC codec
 * (`vault-download-token.js`) and the protobuf policy encoder
 * (`vault-policy-data.js`) all run for REAL: a synthetic viem account signs a
 * real EIP-191 message, the handler recovers the real public key from it,
 * `wrapKey`/`unwrapKey` round-trip a real content key, and the emitted
 * `policyData` bytes are decoded back through the real generated codec. That
 * mirrors this campaign's "real crypto, mocked chain/storage" test convention
 * (tests/bnb-mpp-server.test.js, tests/bnb-vault-crypto.test.js). Only what
 * needs live infra this sandbox has no egress for is mocked: the on-chain reads
 * (`vault-contract.js`), the off-chain index and manifest reads
 * (`vault-store.js`), the object-metadata read (`greenfield.js` getObjectMeta),
 * and the authenticated SP fetch (`greenfield-write.js` downloadPrivateObject).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

process.env.WALLET_ENCRYPTION_KEY ||= 'vitest-ephemeral-wallet-key-000000000000000000';
process.env.JWT_SECRET ||= 'vitest-ephemeral-jwt-secret-00000000000000';
// download.js refuses with 503 vault_not_configured when no operator key exists, so
// the authorization path below can only be exercised with one present. Ephemeral and
// never used to sign: the Greenfield fetch it would authenticate is mocked out.
process.env.GREENFIELD_VAULT_OPERATOR_KEY ||= '0x' + '7'.repeat(64);

const OBJECT_ID = '0x' + '11'.repeat(32);
const OTHER_OBJECT_ID = '0x' + '22'.repeat(32);
const NEVER_LISTED_ID = '0x' + '33'.repeat(32);
const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
const SELLER = '0x000000000000000000000000000000000000dEaD';
const CONTRACT = '0x00000000000000000000000000000000000C0DE1';

const rl = { ok: true };
vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: {
		bnbVaultReadIp: vi.fn(async () => ({ success: rl.ok, reset: Date.now() + 60_000 })),
		bnbVaultUnlockIp: vi.fn(async () => ({ success: rl.ok, reset: Date.now() + 60_000 })),
	},
	clientIp: () => '127.0.0.1',
}));

// ── vault-contract.js: on-chain reads, fully mocked (deterministic, no RPC). ──
const chain = {
	deployed: true,
	listings: new Map(), // objectId -> {seller, price, active}
	saleIdOf: new Map(), // `${objectId}:${buyer}` -> saleId (bigint)
	sales: new Map(), // saleId -> {objectId, buyer, seller, price, policyId, status}
	logs: [],
};
vi.mock('../api/_lib/bnb/vault-contract.js', async () => {
	const actual = await vi.importActual('../api/_lib/bnb/vault-contract.js');
	return {
		...actual,
		vaultContractAddress: vi.fn((network, override) => (override ? { address: override, deployed: true } : { address: CONTRACT, deployed: chain.deployed })),
		vaultClient: vi.fn(() => ({})),
		readListing: vi.fn(async (_c, _a, objectId) => chain.listings.get(objectId) || { seller: ZERO_ADDR, price: 0n, active: false }),
		readSaleIdOf: vi.fn(async (_c, _a, objectId, buyer) => chain.saleIdOf.get(`${objectId}:${buyer.toLowerCase()}`) || 0n),
		readSale: vi.fn(async (_c, _a, saleId) => chain.sales.get(saleId.toString())),
		getVaultLogs: vi.fn(async () => ({ logs: chain.logs, fromBlock: 0n, toBlock: 100n })),
	};
});

// ── vault-store.js: Greenfield index + manifest reads, mocked. ──
const store = {
	refs: new Map(), // objectId -> {bucket, glbObject, manifestObject}
	manifests: new Map(), // manifestObject -> manifest JSON
	keyRecords: new Map(), // `${bucket}:${glbObject}` -> {contentKeyCiphertext, sellerAddress}
	refError: null, // when set, resolveObjectRef rejects with it
};
vi.mock('../api/_lib/bnb/vault-store.js', async () => {
	const actual = await vi.importActual('../api/_lib/bnb/vault-store.js');
	return {
		...actual,
		resolveObjectRef: vi.fn(async (objectId) => {
			if (store.refError) throw store.refError;
			return store.refs.get(objectId) || null;
		}),
		fetchManifest: vi.fn(async (_bucket, manifestObject) => {
			const m = store.manifests.get(manifestObject);
			if (!m) throw new (await import('../api/_lib/bnb/greenfield.js')).GreenfieldError('not found', 'not_found');
			return m;
		}),
		getVaultKeyRecord: vi.fn(async (bucket, glbObject) => store.keyRecords.get(`${bucket}:${glbObject}`) || null),
	};
});

// ── greenfield.js: only the object-metadata read buy-policy-data.js needs. The
// protobuf policy encoder itself runs for REAL against it (same "real crypto /
// real wire format, mocked network" split the rest of this file uses).
const greenfield = { meta: null, error: null };
vi.mock('../api/_lib/bnb/greenfield.js', async () => {
	const actual = await vi.importActual('../api/_lib/bnb/greenfield.js');
	return {
		...actual,
		getObjectMeta: vi.fn(async () => {
			if (greenfield.error) throw greenfield.error;
			return greenfield.meta;
		}),
	};
});

// ── greenfield-write.js: the authenticated SP fetch download.js relays. ──
const sp = { bytes: null, error: null };
vi.mock('../api/_lib/bnb/greenfield-write.js', async () => {
	const actual = await vi.importActual('../api/_lib/bnb/greenfield-write.js');
	return {
		...actual,
		downloadPrivateObject: vi.fn(async () => {
			if (sp.error) throw sp.error;
			return { bytes: sp.bytes };
		}),
	};
});

const { default: listHandler } = await import('../api/vault/list.js');
const { default: statusHandler } = await import('../api/vault/status.js');
const { default: unlockHandler } = await import('../api/vault/unlock.js');
const { default: downloadHandler } = await import('../api/vault/download.js');
const { default: policyDataHandler } = await import('../api/vault/buy-policy-data.js');
const { encodeVaultDownloadToken } = await import('../api/_lib/bnb/vault-download-token.js');
const { GreenfieldError } = await import('../api/_lib/bnb/greenfield.js');
const { GreenfieldWriteError } = await import('../api/_lib/bnb/greenfield-write.js');
const { buildVaultUnlockMessage } = await import('../api/_lib/bnb/vault-unlock-auth.js');
const { encryptGlb } = await import('../api/_lib/bnb/vault-crypto.js');
const { unwrapKey } = await import('../api/_lib/bnb/vault-crypto.js');
const { encryptSecret } = await import('../api/_lib/secret-box.js');

function makeReq(method, url, body) {
	const req = { method, url, headers: { origin: 'https://three.ws', host: 'x', 'content-type': 'application/json' }, socket: { remoteAddress: '127.0.0.1' } };
	if (body !== undefined) req.body = JSON.stringify(body);
	return req;
}
function makeRes() {
	const r = { statusCode: 200, _h: {}, _b: null };
	r.setHeader = (k, v) => { r._h[k] = v; };
	r.getHeader = (k) => r._h[k];
	// download.js streams its success path through writeHead + end(Buffer) rather
	// than json(), so the fake has to honor both shapes.
	r.writeHead = (code, headers) => { r.statusCode = code; Object.assign(r._h, headers || {}); return r; };
	r.end = (b) => { r._b = b; };
	Object.defineProperty(r, '_s', { get() { return this.statusCode; } });
	Object.defineProperty(r, 'json', { value: () => JSON.parse(r._b) });
	return r;
}
async function get(handler, url) {
	const req = makeReq('GET', url);
	const res = makeRes();
	await handler(req, res);
	return res;
}
async function post(handler, url, body) {
	const req = makeReq('POST', url, body);
	const res = makeRes();
	await handler(req, res);
	return res;
}

beforeEach(() => {
	rl.ok = true;
	chain.deployed = true;
	chain.listings.clear();
	chain.saleIdOf.clear();
	chain.sales.clear();
	chain.logs = [];
	store.refs.clear();
	store.manifests.clear();
	store.keyRecords.clear();
	store.refError = null;
	greenfield.meta = null;
	greenfield.error = null;
	sp.bytes = null;
	sp.error = null;
});
afterEach(() => {
	vi.clearAllMocks();
});

describe('GET /api/vault/list', () => {
	it('contract not deployed → empty state, not an error', async () => {
		chain.deployed = false;
		const r = await get(listHandler, '/api/vault/list');
		expect(r._s).toBe(200);
		const body = r.json();
		expect(body.contractDeployed).toBe(false);
		expect(body.listings).toEqual([]);
		expect(body.count).toBe(0);
	});

	it('bad network → 400', async () => {
		const r = await get(listHandler, '/api/vault/list?network=ethereum');
		expect(r._s).toBe(400);
	});

	it('folds Listed/Delisted logs into active listings, joins manifest, surfaces unresolved', async () => {
		chain.logs = [
			{ eventName: 'Listed', blockNumber: 10n, logIndex: 0, args: { objectId: OBJECT_ID, seller: SELLER, price: 100000n } },
			{ eventName: 'Listed', blockNumber: 11n, logIndex: 0, args: { objectId: OTHER_OBJECT_ID, seller: SELLER, price: 50000n } },
			{ eventName: 'Delisted', blockNumber: 12n, logIndex: 0, args: { objectId: OTHER_OBJECT_ID, seller: SELLER } },
		];
		store.refs.set(OBJECT_ID, { bucket: 'b', glbObject: 'o.glb.enc', manifestObject: 'o.manifest.json' });
		store.manifests.set('o.manifest.json', { version: 1, sha256: 'deadbeef', priceAtomic: '100000', createdAt: '2026-07-08T00:00:00.000Z' });
		// OTHER_OBJECT_ID delisted → must not appear even though it has no ref.

		const r = await get(listHandler, '/api/vault/list?network=testnet');
		expect(r._s).toBe(200);
		const body = r.json();
		expect(body.count).toBe(1);
		expect(body.listings[0].objectId).toBe(OBJECT_ID);
		expect(body.listings[0].priceAtomic).toBe('100000');
		expect(body.listings[0].sha256).toBe('deadbeef');
		expect(body.unresolved).toEqual([]);
	});

	it('0 listings → empty array, not an error', async () => {
		const r = await get(listHandler, '/api/vault/list');
		expect(r._s).toBe(200);
		expect(r.json()).toMatchObject({ count: 0, listings: [] });
	});

	it('a listed objectId with no resolvable manifest lands in unresolved, not silently dropped', async () => {
		chain.logs = [{ eventName: 'Listed', blockNumber: 1n, logIndex: 0, args: { objectId: OBJECT_ID, seller: SELLER, price: 1n } }];
		const r = await get(listHandler, '/api/vault/list');
		const body = r.json();
		expect(body.count).toBe(0);
		expect(body.unresolved).toEqual([OBJECT_ID]);
	});

	it('rate limited → 429', async () => {
		rl.ok = false;
		const r = await get(listHandler, '/api/vault/list');
		expect(r._s).toBe(429);
	});

	it('a Greenfield miss while resolving refs lands in unresolved, not a 5xx', async () => {
		chain.logs = [{ eventName: 'Listed', blockNumber: 1n, logIndex: 0, args: { objectId: OBJECT_ID, seller: SELLER, price: 1n } }];
		store.refError = new GreenfieldError('bucket unreachable', 'unavailable');
		const r = await get(listHandler, '/api/vault/list');
		expect(r._s).toBe(200);
		expect(r.json().unresolved).toEqual([OBJECT_ID]);
	});

	it('an object-index outage → 503, never a listing silently reported as manifest-less', async () => {
		chain.logs = [{ eventName: 'Listed', blockNumber: 1n, logIndex: 0, args: { objectId: OBJECT_ID, seller: SELLER, price: 1n } }];
		store.refError = new Error('index db connection refused'); // not a GreenfieldError
		const r = await get(listHandler, '/api/vault/list');
		expect(r._s).toBe(503);
		expect(r.json().error).toBe('storage_unavailable');
	});
});

describe('GET /api/vault/status', () => {
	it('bad objectId / buyer → 400', async () => {
		expect((await get(statusHandler, `/api/vault/status?objectId=${OBJECT_ID}&buyer=not-an-address`))._s).toBe(400);
		expect((await get(statusHandler, `/api/vault/status?objectId=bad&buyer=${SELLER}`))._s).toBe(400);
	});

	it('contract not deployed → state unlisted', async () => {
		chain.deployed = false;
		const r = await get(statusHandler, `/api/vault/status?objectId=${OBJECT_ID}&buyer=${SELLER}`);
		expect(r._s).toBe(200);
		expect(r.json().state).toBe('unlisted');
	});

	it('active listing, no purchase → state available', async () => {
		chain.listings.set(OBJECT_ID, { seller: SELLER, price: 100n, active: true });
		const r = await get(statusHandler, `/api/vault/status?objectId=${OBJECT_ID}&buyer=${SELLER}`);
		const body = r.json();
		expect(body.state).toBe('available');
		expect(body.purchased).toBe(false);
	});

	it('never listed, no purchase → state unlisted', async () => {
		const r = await get(statusHandler, `/api/vault/status?objectId=${NEVER_LISTED_ID}&buyer=${SELLER}`);
		expect(r.json().state).toBe('unlisted');
	});

	it('purchased, policy still Pending → state pending-grant (200, not an error)', async () => {
		chain.listings.set(OBJECT_ID, { seller: SELLER, price: 100n, active: true });
		chain.saleIdOf.set(`${OBJECT_ID}:${SELLER.toLowerCase()}`, 1n);
		chain.sales.set('1', { objectId: OBJECT_ID, buyer: SELLER, seller: SELLER, price: 100n, policyId: 0n, status: 'Pending' });
		const r = await get(statusHandler, `/api/vault/status?objectId=${OBJECT_ID}&buyer=${SELLER}`);
		expect(r._s).toBe(200);
		const body = r.json();
		expect(body.state).toBe('pending-grant');
		expect(body.purchased).toBe(true);
		expect(body.policySettled).toBe(false);
	});

	it('purchased, policy Granted → state unlocked', async () => {
		chain.listings.set(OBJECT_ID, { seller: SELLER, price: 100n, active: true });
		chain.saleIdOf.set(`${OBJECT_ID}:${SELLER.toLowerCase()}`, 2n);
		chain.sales.set('2', { objectId: OBJECT_ID, buyer: SELLER, seller: SELLER, price: 100n, policyId: 777n, status: 'Granted' });
		const r = await get(statusHandler, `/api/vault/status?objectId=${OBJECT_ID}&buyer=${SELLER}`);
		const body = r.json();
		expect(body.state).toBe('unlocked');
		expect(body.policySettled).toBe(true);
		expect(body.policyId).toBe('777');
	});
});

describe('POST /api/vault/unlock', () => {
	const buyerPrivateKey = generatePrivateKey();
	const buyerAccount = privateKeyToAccount(buyerPrivateKey);
	const buyer = buyerAccount.address;
	const network = 'testnet';

	async function signedUnlockBody(objectId, { nonce = 'n-' + Math.random().toString(36).slice(2), issuedAt = new Date().toISOString(), overrideBuyer } = {}) {
		const message = buildVaultUnlockMessage({ objectId, buyer: overrideBuyer || buyer, network, nonce, issuedAt });
		const signature = await buyerAccount.signMessage({ message });
		return { objectId, buyer, network, message, signature };
	}

	it('bad request shape → 400 (missing objectId)', async () => {
		const r = await post(unlockHandler, '/api/vault/unlock', { buyer, network, message: 'x', signature: '0x00' });
		expect(r._s).toBe(400);
	});

	it('wrong signer → 401 bad_signature', async () => {
		const other = privateKeyToAccount(generatePrivateKey());
		const message = buildVaultUnlockMessage({ objectId: OBJECT_ID, buyer, network, nonce: 'nonce-wrong-signer-1', issuedAt: new Date().toISOString() });
		const signature = await other.signMessage({ message }); // signed by a DIFFERENT key than `buyer`
		const r = await post(unlockHandler, '/api/vault/unlock', { objectId: OBJECT_ID, buyer, network, message, signature });
		expect(r._s).toBe(401);
		expect(r.json().error).toBe('bad_signature');
	});

	it('expired message → 401 expired', async () => {
		const body = await signedUnlockBody(OBJECT_ID, { issuedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() });
		const r = await post(unlockHandler, '/api/vault/unlock', body);
		expect(r._s).toBe(401);
		expect(r.json().error).toBe('expired');
	});

	it('replayed message+signature → second call 401 replay', async () => {
		chain.listings.set(OBJECT_ID, { seller: SELLER, price: 100n, active: true }); // not purchased, but auth runs first
		const body = await signedUnlockBody(OBJECT_ID, { nonce: 'replay-nonce-1' });
		const first = await post(unlockHandler, '/api/vault/unlock', body);
		expect(first._s).not.toBe(401);
		const second = await post(unlockHandler, '/api/vault/unlock', body);
		expect(second._s).toBe(401);
		expect(second.json().error).toBe('replay');
	});

	it('never listed → 404 not_listed', async () => {
		const body = await signedUnlockBody(NEVER_LISTED_ID);
		const r = await post(unlockHandler, '/api/vault/unlock', body);
		expect(r._s).toBe(404);
		expect(r.json().error).toBe('not_listed');
	});

	it('listed, not purchased by this buyer → 403 purchase_required (proves a NON-buyer gets 403)', async () => {
		chain.listings.set(OBJECT_ID, { seller: SELLER, price: 100000n, active: true });
		const body = await signedUnlockBody(OBJECT_ID);
		const r = await post(unlockHandler, '/api/vault/unlock', body);
		expect(r._s).toBe(403);
		expect(r.json().error).toBe('purchase_required');
	});

	it('delisted, never purchased → 410 delisted', async () => {
		chain.listings.set(OBJECT_ID, { seller: SELLER, price: 100000n, active: false });
		const body = await signedUnlockBody(OBJECT_ID);
		const r = await post(unlockHandler, '/api/vault/unlock', body);
		expect(r._s).toBe(410);
		expect(r.json().error).toBe('delisted');
	});

	it('purchased, grant still Pending → 200 pending-grant (not an error)', async () => {
		chain.listings.set(OBJECT_ID, { seller: SELLER, price: 1n, active: true });
		chain.saleIdOf.set(`${OBJECT_ID}:${buyer.toLowerCase()}`, 5n);
		chain.sales.set('5', { objectId: OBJECT_ID, buyer, seller: SELLER, price: 1n, policyId: 0n, status: 'Pending' });
		const body = await signedUnlockBody(OBJECT_ID);
		const r = await post(unlockHandler, '/api/vault/unlock', body);
		expect(r._s).toBe(200);
		expect(r.json().state).toBe('pending-grant');
	});

	it('purchased + Granted + real key material → 200 unlocked with a wrapped key that unwraps to the real content key', async () => {
		const SYNTH_GLB = Buffer.concat([Buffer.from('glTF'), Buffer.alloc(16, 9)]);
		const { contentKey, sha256OfPlaintext } = encryptGlb(SYNTH_GLB);
		const contentKeyCiphertext = await encryptSecret(contentKey.toString('base64'));

		chain.listings.set(OBJECT_ID, { seller: SELLER, price: 1n, active: true });
		chain.saleIdOf.set(`${OBJECT_ID}:${buyer.toLowerCase()}`, 9n);
		chain.sales.set('9', { objectId: OBJECT_ID, buyer, seller: SELLER, price: 1n, policyId: 42n, status: 'Granted' });
		store.refs.set(OBJECT_ID, { bucket: 'three-ws-vault-testnet', glbObject: 'vaults/x/1.glb.enc', manifestObject: 'vaults/x/1.manifest.json' });
		store.manifests.set('vaults/x/1.manifest.json', { version: 1, sha256: sha256OfPlaintext, priceAtomic: '1' });
		store.keyRecords.set('three-ws-vault-testnet:vaults/x/1.glb.enc', { contentKeyCiphertext, sellerAddress: SELLER });

		const body = await signedUnlockBody(OBJECT_ID);
		const r = await post(unlockHandler, '/api/vault/unlock', body);
		expect(r._s).toBe(200);
		const res = r.json();
		expect(res.state).toBe('unlocked');
		expect(res.saleId).toBe('9');
		expect(res.policyId).toBe('42');
		expect(res.manifest.sha256).toBe(sha256OfPlaintext);
		expect(res.wrappedKey.ephemeralPublicKey).toMatch(/^0x[0-9a-f]{66}$/);

		// Real round trip: the buyer's own private key unwraps the SAME content key.
		const wrapped = {
			ephemeralPublicKey: Buffer.from(res.wrappedKey.ephemeralPublicKey.slice(2), 'hex'),
			iv: Buffer.from(res.wrappedKey.iv.slice(2), 'hex'),
			authTag: Buffer.from(res.wrappedKey.authTag.slice(2), 'hex'),
			ciphertext: Buffer.from(res.wrappedKey.ciphertext.slice(2), 'hex'),
		};
		const recovered = unwrapKey(wrapped, buyerPrivateKey);
		expect(Buffer.compare(recovered, contentKey)).toBe(0);

		// The raw content key is never returned.
		expect(JSON.stringify(res)).not.toContain(contentKey.toString('hex'));
	});
});

describe('GET /api/vault/download', () => {
	const buyer = '0x2222222222222222222222222222222222222222';
	const CIPHERTEXT = Buffer.from('vault-ciphertext-bytes-not-plaintext-glb');
	const REF = { bucket: 'three-ws-vault-testnet', glbObject: 'vaults/d/1.glb.enc', manifestObject: 'vaults/d/1.manifest.json' };

	function token(over = {}) {
		return encodeVaultDownloadToken({ objectId: OBJECT_ID, buyer, network: 'testnet', ...over });
	}
	function url(over = {}) {
		const p = { objectId: OBJECT_ID, buyer, token: token(), ...over };
		return `/api/vault/download?${new URLSearchParams(p)}`;
	}
	/** Chain + storage state of a settled, granted purchase for `buyer`. */
	function grantPurchase(status = 'Granted') {
		chain.listings.set(OBJECT_ID, { seller: SELLER, price: 100n, active: true });
		chain.saleIdOf.set(`${OBJECT_ID}:${buyer.toLowerCase()}`, 3n);
		chain.sales.set('3', { objectId: OBJECT_ID, buyer, seller: SELLER, price: 100n, policyId: 7n, status });
		store.refs.set(OBJECT_ID, REF);
		sp.bytes = CIPHERTEXT;
	}

	it('purchased + Granted → 200 streams the raw ciphertext bytes', async () => {
		grantPurchase();
		const r = await get(downloadHandler, url());
		expect(r._s).toBe(200);
		expect(r._h['content-type']).toBe('application/octet-stream');
		expect(r._h['content-length']).toBe(String(CIPHERTEXT.length));
		expect(r._h['cache-control']).toBe('no-store');
		expect(Buffer.compare(r._b, CIPHERTEXT)).toBe(0);
	});

	it('no token → 401 bad_token (the bytes gate is never open by default)', async () => {
		grantPurchase();
		const r = await get(downloadHandler, '/api/vault/download?objectId=' + OBJECT_ID + '&buyer=' + buyer);
		expect(r._s).toBe(401);
		expect(r.json().error).toBe('bad_token');
	});

	it('a valid token for one buyer cannot fetch the bytes of a different buyer', async () => {
		grantPurchase();
		const other = '0x4444444444444444444444444444444444444444';
		chain.saleIdOf.set(`${OBJECT_ID}:${other.toLowerCase()}`, 3n); // other bought it too
		const r = await get(downloadHandler, url({ buyer: other })); // token still says `buyer`
		expect(r._s).toBe(401);
		expect(r.json().error).toBe('bad_token');
	});

	it('a token minted for another objectId is rejected', async () => {
		grantPurchase();
		const r = await get(downloadHandler, url({ token: token({ objectId: OTHER_OBJECT_ID }) }));
		expect(r._s).toBe(401);
	});

	it('a tampered signature is rejected', async () => {
		grantPurchase();
		const r = await get(downloadHandler, url({ token: token() + 'x' }));
		expect(r._s).toBe(401);
	});

	it('an expired token is rejected even with a settled purchase', async () => {
		grantPurchase();
		const stale = token();
		vi.useFakeTimers();
		vi.setSystemTime(Date.now() + 16 * 60 * 1000); // TTL is 15 minutes
		const r = await get(downloadHandler, url({ token: stale }));
		vi.useRealTimers();
		expect(r._s).toBe(401);
		expect(r.json().error).toBe('bad_token');
	});

	it('valid token but no purchase → 403 purchase_required (the token is not the authorization)', async () => {
		chain.listings.set(OBJECT_ID, { seller: SELLER, price: 100n, active: true });
		store.refs.set(OBJECT_ID, REF);
		sp.bytes = CIPHERTEXT;
		const r = await get(downloadHandler, url());
		expect(r._s).toBe(403);
		expect(r.json().error).toBe('purchase_required');
	});

	it('valid token but the grant is still Pending → 403 grant_pending', async () => {
		grantPurchase('Pending');
		const r = await get(downloadHandler, url());
		expect(r._s).toBe(403);
		expect(r.json().error).toBe('grant_pending');
	});

	it('never listed → 404 not_listed', async () => {
		const r = await get(downloadHandler, url({ objectId: NEVER_LISTED_ID, token: token({ objectId: NEVER_LISTED_ID }) }));
		expect(r._s).toBe(404);
		expect(r.json().error).toBe('not_listed');
	});

	it('delisted with no purchase → 410 delisted', async () => {
		chain.listings.set(OBJECT_ID, { seller: SELLER, price: 100n, active: false });
		const r = await get(downloadHandler, url());
		expect(r._s).toBe(410);
		expect(r.json().error).toBe('delisted');
	});

	it('purchased but refs unresolvable → 410 object_index_missing', async () => {
		grantPurchase();
		store.refs.clear();
		const r = await get(downloadHandler, url());
		expect(r._s).toBe(410);
		expect(r.json().error).toBe('object_index_missing');
	});

	it('the SP losing the object → 410, and a transport failure → 503', async () => {
		grantPurchase();
		sp.error = new GreenfieldWriteError('object gone', { code: 'not_found' });
		expect((await get(downloadHandler, url()))._s).toBe(410);
		sp.error = new GreenfieldWriteError('sp unreachable', { code: 'unavailable' });
		expect((await get(downloadHandler, url()))._s).toBe(503);
	});

	it('contract not deployed → 503, never bytes', async () => {
		grantPurchase();
		chain.deployed = false;
		const r = await get(downloadHandler, url());
		expect(r._s).toBe(503);
		expect(r.json().error).toBe('contract_not_deployed');
	});

	it('bad objectId / buyer / network → 400', async () => {
		expect((await get(downloadHandler, url({ objectId: 'nope' })))._s).toBe(400);
		expect((await get(downloadHandler, url({ buyer: 'nope' })))._s).toBe(400);
		expect((await get(downloadHandler, url({ network: 'ethereum' })))._s).toBe(400);
	});

	it('rate limited → 429 carrying retry-after, not a bare refusal', async () => {
		rl.ok = false;
		const r = await get(downloadHandler, url());
		expect(r._s).toBe(429);
		expect(r._h['retry-after']).toBeTruthy();
		expect(r.json().retry_after).toBeGreaterThan(0);
	});
});

describe('GET /api/vault/buy-policy-data', () => {
	const buyer = '0x5555555555555555555555555555555555555555';
	const url = (over = {}) => `/api/vault/buy-policy-data?${new URLSearchParams({ objectId: OBJECT_ID, buyer, ...over })}`;

	it('a real Greenfield resource id → real protobuf policy bytes', async () => {
		store.refs.set(OBJECT_ID, { bucket: 'three-ws-vault-testnet', glbObject: 'vaults/p/1.glb.enc', manifestObject: 'vaults/p/1.manifest.json' });
		greenfield.meta = { id: '18446744073709551', owner: SELLER };
		const r = await get(policyDataHandler, url());
		expect(r._s).toBe(200);
		const body = r.json();
		expect(body.resourceId).toBe('18446744073709551');
		expect(body.policyData).toMatch(/^0x[0-9a-f]+$/);
		expect(body.buyer.toLowerCase()).toBe(buyer.toLowerCase());
		// The bytes are a real `greenfield.permission.Policy`: decoding them back
		// must yield this buyer as principal and this object as the resource.
		const { createRequire } = await import('node:module');
		const require = createRequire(import.meta.url);
		const { Policy } = require('@bnb-chain/greenfield-cosmos-types/greenfield/permission/types.js');
		const decoded = Policy.decode(Buffer.from(body.policyData.slice(2), 'hex'));
		expect(decoded.principal.value.toLowerCase()).toBe(buyer.toLowerCase());
		expect(decoded.resourceId).toBe('18446744073709551');
		expect(decoded.statements).toHaveLength(1);
	});

	it('an objectId with no resolvable Greenfield ref → 404 not_listed, never invented bytes', async () => {
		const r = await get(policyDataHandler, url());
		expect(r._s).toBe(404);
		expect(r.json().error).toBe('not_listed');
	});

	it('an object never mirrored to Greenfield → 404 object_not_found, never a fabricated resourceId', async () => {
		store.refs.set(OBJECT_ID, { bucket: 'b', glbObject: 'o.glb.enc', manifestObject: 'o.manifest.json' });
		greenfield.error = new GreenfieldError('head_object 404', 'not_found');
		const r = await get(policyDataHandler, url());
		expect(r._s).toBe(404);
		expect(r.json().error).toBe('object_not_found');
	});

	it('metadata with a zero resource id → 404, never a policy bound to id 0', async () => {
		store.refs.set(OBJECT_ID, { bucket: 'b', glbObject: 'o.glb.enc', manifestObject: 'o.manifest.json' });
		greenfield.meta = { id: '0' };
		const r = await get(policyDataHandler, url());
		expect(r._s).toBe(404);
		expect(r.json().error).toBe('object_not_found');
	});

	it('Greenfield unreachable → 503, not a 404 that reads as "never uploaded"', async () => {
		store.refs.set(OBJECT_ID, { bucket: 'b', glbObject: 'o.glb.enc', manifestObject: 'o.manifest.json' });
		greenfield.error = new GreenfieldError('lcd timeout', 'unavailable');
		const r = await get(policyDataHandler, url());
		expect(r._s).toBe(503);
		expect(r.json().error).toBe('greenfield_unavailable');
	});

	it('bad objectId / buyer / network → 400', async () => {
		expect((await get(policyDataHandler, url({ objectId: 'nope' })))._s).toBe(400);
		expect((await get(policyDataHandler, url({ buyer: 'nope' })))._s).toBe(400);
		expect((await get(policyDataHandler, url({ network: 'ethereum' })))._s).toBe(400);
	});

	it('rate limited → 429', async () => {
		rl.ok = false;
		expect((await get(policyDataHandler, url()))._s).toBe(429);
	});
});
