/**
 * POST /api/bnb/vault-upload — integration tests.
 *
 * `../api/_lib/bnb/greenfield-write.js` is mocked (a real bucket/object write
 * needs a funded Greenfield account — see PROGRESS.md's prompt 09 entry for
 * the real, unfunded-key probe against live testnet) so this suite proves the
 * pipeline logic deterministically: GLB in → manifest out matching
 * specs/vault-manifest.md, ciphertext object referenced, the raw/wrapped
 * content key NEVER present in the manifest, `pending` surfaced honestly when
 * Greenfield hasn't sealed yet, and every input-validation / error-mapping
 * branch. `encryptGlb`/`secret-box` and the rate limiter run for REAL (fast,
 * synchronous-ish, no network) so the crypto boundary is genuinely exercised.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// secret-box.js (the content-key-at-rest envelope) needs a master secret —
// same ephemeral test convention as tests/vanity-premium-inventory.test.js.
process.env.WALLET_ENCRYPTION_KEY ||= 'vitest-ephemeral-wallet-key-000000000000000000';
process.env.JWT_SECRET ||= 'vitest-ephemeral-jwt-secret-00000000000000';

const SELLER = '0x000000000000000000000000000000000000dEaD';
const OPERATOR_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'; // Hardhat's published account #0, public by design (check-secrets allowlists it)
const SYNTH_GLB = Buffer.concat([Buffer.from('glTF'), Buffer.alloc(16, 7), Buffer.from('synthetic-vault-fixture')]);

const rl = { ok: true };
vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: { bnbVaultUploadIp: vi.fn(async () => ({ success: rl.ok, reset: Date.now() + 60_000 })) },
	clientIp: () => '127.0.0.1',
}));

const gfState = { bucketExists: false, objectStatus: 'stored', failManifest: false, glbError: null };
vi.mock('../api/_lib/bnb/greenfield-write.js', async () => {
	const actual = await vi.importActual('../api/_lib/bnb/greenfield-write.js');
	return {
		...actual,
		ensureBucket: vi.fn(async (bucket) => ({ bucket, network: 'testnet', created: !gfState.bucketExists, txHash: gfState.bucketExists ? undefined : '0xBUCKETTX' })),
		createObject: vi.fn(async (bucket, object) => {
			if (object.endsWith('.manifest.json') && gfState.failManifest) {
				throw new actual.GreenfieldWriteError('manifest SP upload failed', { code: 'upload_failed' });
			}
			if (!object.endsWith('.manifest.json') && gfState.glbError) {
				throw gfState.glbError;
			}
			return { bucket, object, network: 'testnet', txHash: '0xOBJECTTX', sp: '0xSPOPERATOR', status: gfState.objectStatus };
		}),
	};
});

// ssrf.js's assertPublicHttpsUrl does a REAL DNS lookup, which the sandbox has
// no egress for — mock it to a pass-through so the glbUrl branch's OWN logic
// (fetch + GLB-magic validation) is what's under test here, not DNS resolution
// (already covered by ssrf.js's own suite).
vi.mock('../api/_lib/ssrf.js', async () => {
	const actual = await vi.importActual('../api/_lib/ssrf.js');
	return { ...actual, assertPublicHttpsUrl: vi.fn(async (url) => url) };
});

// ssrf-guard.js's pinned fetch opens raw sockets (no sandbox egress either).
// Route it through the per-test global.fetch stub so those stubs keep driving
// the glbUrl branch, and enforce opts.maxBytes the way the real guard does so
// the handler's MaxBytesExceededError → 413 mapping is genuinely exercised.
vi.mock('../api/_lib/ssrf-guard.js', async () => {
	const actual = await vi.importActual('../api/_lib/ssrf-guard.js');
	return {
		...actual,
		fetchSafePublicUrlPinned: vi.fn(async (url, init, opts) => {
			const resp = await global.fetch(url, init);
			if (opts?.maxBytes == null) return resp;
			const buf = await resp.arrayBuffer();
			if (buf.byteLength > opts.maxBytes) {
				throw new actual.MaxBytesExceededError(buf.byteLength, opts.maxBytes);
			}
			return {
				ok: resp.ok,
				status: resp.status,
				headers: resp.headers ?? new Headers(),
				arrayBuffer: async () => buf,
				text: async () => Buffer.from(buf).toString('utf8'),
			};
		}),
	};
});

const { default: handler } = await import('../api/bnb/vault-upload.js');
const { GreenfieldWriteError } = await import('../api/_lib/bnb/greenfield-write.js');
const { cacheGet } = await import('../api/_lib/cache.js');
const { decryptSecret } = await import('../api/_lib/secret-box.js');

function makeReq(body, { method = 'POST' } = {}) {
	return {
		method,
		url: '/api/bnb/vault-upload',
		headers: { origin: 'https://three.ws', 'content-type': 'application/json' },
		socket: { remoteAddress: '127.0.0.1' },
		body: JSON.stringify(body),
	};
}
function makeRes() {
	const r = { statusCode: 200, _h: {}, _b: null };
	r.setHeader = (k, v) => { r._h[k] = v; };
	r.getHeader = (k) => r._h[k];
	r.end = (b) => { r._b = b; };
	Object.defineProperty(r, '_s', { get() { return this.statusCode; } });
	Object.defineProperty(r, 'json', { value: () => JSON.parse(r._b) });
	return r;
}
async function call(body, opts) {
	const req = makeReq(body, opts);
	const res = makeRes();
	await handler(req, res);
	return res;
}

beforeEach(() => {
	rl.ok = true;
	gfState.bucketExists = false;
	gfState.objectStatus = 'stored';
	gfState.failManifest = false;
	gfState.glbError = null;
	process.env.GREENFIELD_VAULT_OPERATOR_KEY = OPERATOR_KEY;
	delete process.env.GREENFIELD_VAULT_ADDRESS_TESTNET;
});
afterEach(() => {
	vi.clearAllMocks();
	delete process.env.GREENFIELD_VAULT_OPERATOR_KEY;
});

describe('POST /api/bnb/vault-upload — success', () => {
	it('encrypts the GLB, writes the ciphertext + manifest objects, and returns a manifest matching the spec', async () => {
		const r = await call({ glbBase64: SYNTH_GLB.toString('base64'), sellerAddress: SELLER, priceAtomic: '250000' });
		expect(r._s).toBe(200);
		const body = r.json();

		expect(body.status).toBe('stored');
		expect(body.glbObjectRef.object).toMatch(/^vaults\/0x0+dead\/[0-9a-f]{16}\.glb\.enc$/);
		expect(body.manifestRef.object).toBe(body.glbObjectRef.object.replace(/\.glb\.enc$/, '.manifest.json'));

		const m = body.manifest;
		expect(m.version).toBe(1);
		expect(m.glbObjectRef).toEqual(body.glbObjectRef);
		expect(m.encryption.alg).toBe('AES-256-GCM');
		expect(m.encryption.iv).toMatch(/^[0-9a-f]{24}$/);
		expect(m.encryption.authTag).toMatch(/^[0-9a-f]{32}$/);
		expect(m.sha256).toBe(body.sha256);
		expect(m.priceAtomic).toBe('250000');
		expect(m.sellerAddress.toLowerCase()).toBe(SELLER.toLowerCase());
		expect(m.contract).toHaveProperty('address');
		expect(m.contract).toHaveProperty('chainId', 97);

		// The manifest is the wire spec's public contract — it must NEVER carry
		// the raw or wrapped content key, only iv/authTag/sha256.
		const manifestKeys = Object.keys(m).join(',');
		expect(manifestKeys).not.toMatch(/contentKey|wrappedKey|privateKey/i);
		expect(JSON.stringify(m)).not.toContain('contentKey');
	});

	it('persists the encrypted content key server-side, retrievable by the ciphertext object ref, never in plaintext', async () => {
		const r = await call({ glbBase64: SYNTH_GLB.toString('base64'), sellerAddress: SELLER });
		const body = r.json();
		const cached = await cacheGet(`bnb:vault:key:${body.glbObjectRef.bucket}:${body.glbObjectRef.object}`);
		expect(cached).toBeTruthy();
		expect(cached.contentKeyCiphertext).toMatch(/^v2:/); // secret-box AES-256-GCM envelope, not plaintext
		expect(cached.sellerAddress.toLowerCase()).toBe(SELLER.toLowerCase());
		const recoveredKeyB64 = await decryptSecret(cached.contentKeyCiphertext);
		expect(Buffer.from(recoveredKeyB64, 'base64')).toHaveLength(32); // AES-256 content key
	});

	it('accepts glbUrl as an alternative to glbBase64', async () => {
		const origFetch = global.fetch;
		global.fetch = vi.fn(async () => ({ ok: true, status: 200, arrayBuffer: async () => SYNTH_GLB.buffer.slice(SYNTH_GLB.byteOffset, SYNTH_GLB.byteOffset + SYNTH_GLB.byteLength) }));
		try {
			const r = await call({ glbUrl: 'https://r2.three.ws/forge/synthetic.glb', sellerAddress: SELLER });
			expect(r._s).toBe(200);
		} finally {
			global.fetch = origFetch;
		}
	});

	it('a bucket that already exists is reused, not re-created (ensureBucket idempotent)', async () => {
		gfState.bucketExists = true;
		const r = await call({ glbBase64: SYNTH_GLB.toString('base64'), sellerAddress: SELLER });
		expect(r._s).toBe(200);
		const { ensureBucket } = await import('../api/_lib/bnb/greenfield-write.js');
		expect(ensureBucket).toHaveBeenCalledTimes(1);
	});

	it('surfaces status:"pending" honestly (not a lie of "stored") when Greenfield has not sealed yet', async () => {
		gfState.objectStatus = 'pending';
		const r = await call({ glbBase64: SYNTH_GLB.toString('base64'), sellerAddress: SELLER });
		const body = r.json();
		expect(body.status).toBe('pending');
		expect(body.pollHint).toBeTruthy();
	});

	it('marks contractDeployed:false and uses the documented placeholder when no vault contract address is configured', async () => {
		const r = await call({ glbBase64: SYNTH_GLB.toString('base64'), sellerAddress: SELLER });
		const body = r.json();
		expect(body.contractDeployed).toBe(false);
		expect(body.manifest.contract.address).toBe('0x0000000000000000000000000000000000dEaD');
	});

	it('honors an explicit contractAddress override and reports contractDeployed:true', async () => {
		const CONTRACT = '0x1234567890123456789012345678901234567890';
		const r = await call({ glbBase64: SYNTH_GLB.toString('base64'), sellerAddress: SELLER, contractAddress: CONTRACT });
		const body = r.json();
		expect(body.contractDeployed).toBe(true);
		expect(body.manifest.contract.address.toLowerCase()).toBe(CONTRACT.toLowerCase());
	});
});

describe('POST /api/bnb/vault-upload — input validation', () => {
	it('400 on a missing sellerAddress', async () => {
		const r = await call({ glbBase64: SYNTH_GLB.toString('base64') });
		expect(r._s).toBe(400);
	});
	it('400 on a Solana address for sellerAddress (wrong chain)', async () => {
		const r = await call({ glbBase64: SYNTH_GLB.toString('base64'), sellerAddress: 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump' });
		expect(r._s).toBe(400);
	});
	it('400 when neither glbUrl nor glbBase64 is given', async () => {
		const r = await call({ sellerAddress: SELLER });
		expect(r._s).toBe(400);
	});
	it('400 when BOTH glbUrl and glbBase64 are given', async () => {
		const r = await call({ sellerAddress: SELLER, glbUrl: 'https://r2.three.ws/x.glb', glbBase64: SYNTH_GLB.toString('base64') });
		expect(r._s).toBe(400);
	});
	it('415 when the decoded bytes are not a real GLB (no glTF magic header)', async () => {
		const r = await call({ sellerAddress: SELLER, glbBase64: Buffer.from('not a glb at all').toString('base64') });
		expect(r._s).toBe(415);
	});
	it('400 on an empty GLB', async () => {
		const r = await call({ sellerAddress: SELLER, glbBase64: '' });
		expect(r._s).toBe(400);
	});
	it('400 on an unknown network', async () => {
		const r = await call({ sellerAddress: SELLER, glbBase64: SYNTH_GLB.toString('base64'), network: 'nonsense' });
		expect(r._s).toBe(400);
	});
	it('400 on a non-numeric priceAtomic', async () => {
		const r = await call({ sellerAddress: SELLER, glbBase64: SYNTH_GLB.toString('base64'), priceAtomic: 'not-a-number' });
		expect(r._s).toBe(400);
	});
	it('413 for an oversized GLB fetched via glbUrl', async () => {
		const origFetch = global.fetch;
		global.fetch = vi.fn(async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(64 * 1024 * 1024 + 1) }));
		try {
			const r = await call({ sellerAddress: SELLER, glbUrl: 'https://r2.three.ws/forge/huge.glb' });
			expect(r._s).toBe(413);
		} finally {
			global.fetch = origFetch;
		}
	});
});

describe('POST /api/bnb/vault-upload — upstream failure', () => {
	it('the ciphertext ref is still surfaced when only the manifest publish fails, so a retry need not re-upload the GLB', async () => {
		gfState.failManifest = true;
		const r = await call({ glbBase64: SYNTH_GLB.toString('base64'), sellerAddress: SELLER });
		expect(r._s).toBe(502);
		const body = r.json();
		expect(body.glbObjectRef).toBeTruthy();
		expect(body.sha256).toBeTruthy();
	});

	it('503 when the vault operator key is not configured (no silent fake signer)', async () => {
		delete process.env.GREENFIELD_VAULT_OPERATOR_KEY;
		const r = await call({ glbBase64: SYNTH_GLB.toString('base64'), sellerAddress: SELLER });
		expect(r._s).toBe(503);
	});

	it('maps a too_large GreenfieldWriteError on the ciphertext write to 413', async () => {
		gfState.glbError = new GreenfieldWriteError('object exceeds the vault limit', { code: 'too_large' });
		const r = await call({ glbBase64: SYNTH_GLB.toString('base64'), sellerAddress: SELLER });
		expect(r._s).toBe(413);
		expect(r.json().error).toBe('too_large');
	});

	it('maps a tx_failed GreenfieldWriteError on the ciphertext write to 502', async () => {
		gfState.glbError = new GreenfieldWriteError('chain rejected the tx', { code: 'tx_failed' });
		const r = await call({ glbBase64: SYNTH_GLB.toString('base64'), sellerAddress: SELLER });
		expect(r._s).toBe(502);
		expect(r.json().error).toBe('tx_failed');
	});
});

describe('POST /api/bnb/vault-upload — rate limiting + method', () => {
	it('429 when the IP bucket is exhausted', async () => {
		rl.ok = false;
		const r = await call({ glbBase64: SYNTH_GLB.toString('base64'), sellerAddress: SELLER });
		expect(r._s).toBe(429);
	});
	it('405 on GET', async () => {
		const r = await call({}, { method: 'GET' });
		expect(r._s).toBe(405);
	});
});
