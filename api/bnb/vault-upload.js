// POST /api/bnb/vault-upload
// ---------------------------------------------------------------------------
// BNB vault track (prompt 09): a seller lists a 3D model. This endpoint
// encrypts it (08's vault-crypto), ensures a Greenfield bucket, uploads the
// ciphertext object via a Storage Provider (09's greenfield-write), publishes
// the manifest per specs/vault-manifest.md, and returns the refs the vault
// contract (10) and the unlock API (11) will consume. This is where "storage
// you control from a contract" becomes real bytes on Greenfield testnet.
//
// Manifest storage choice: the manifest is a SECOND Greenfield object
// (`<id>.manifest.json`, PUBLIC_READ) sitting next to the ciphertext object
// (`<id>.glb.enc`, PRIVATE) in the same bucket — exactly the layout
// specs/vault-manifest.md illustrates. Chosen over a DB/KV row because (a) the
// manifest is explicitly designed to be publicly readable with no secrets in
// it, so a public object is the natural home, not a new authenticated table;
// (b) it keeps the whole vault self-contained on one backend, matching the
// spec's portability goal; (c) no new DB migration needed. The one genuine
// SECRET this endpoint produces — the raw AES content key — is the opposite:
// it is NEVER put in the manifest or any public object. It is encrypted at
// rest with this platform's existing custodial-secret primitive
// (api/_lib/secret-box.js — the same AES-256-GCM box that already protects
// agent wallet keys and pump.fun creator keys) and persisted in the shared KV
// cache (api/_lib/cache.js — Upstash Redis w/ in-memory fallback, the same
// durability posture forge-cache/pipeline-store already use), keyed by the
// ciphertext object ref, so prompt 11's unlock API can look it up, verify the
// buyer paid on-chain, and wrap a fresh copy to that buyer's public key —
// never re-serving the same wrapped bundle to two buyers.
//
// Body (application/json):
//   {
//     glbUrl?: string,        // fetch bytes from a public https URL (this
//                              // platform's own /api/forge* outputs, or any
//                              // public GLB) — SSRF-guarded (api/_lib/ssrf.js)
//     glbBase64?: string,     // OR raw GLB bytes, base64-encoded. Exactly one
//                              // of glbUrl / glbBase64 is required.
//     sellerAddress: string,  // 0x BSC address that receives sale proceeds
//     priceAtomic?: string,   // USDC atomics; default priceFor('bnb-vault-upload', '100000') = $0.10
//     network?: 'testnet'|'mainnet', // default 'testnet'
//     contractAddress?: string,      // override the recorded vault contract address
//   }
//
// Response 200:
//   { manifestRef: {bucket, object}, glbObjectRef: {bucket, object}, sha256,
//     status: 'stored'|'pending', manifest, contractDeployed: boolean }

import { randomBytes, createHash } from 'node:crypto';

import { cors, json, method, wrap, error, readJson, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { env } from '../_lib/env.js';
import { assertPublicHttpsUrl } from '../_lib/ssrf.js';
import { fetchSafePublicUrlPinned, MaxBytesExceededError } from '../_lib/ssrf-guard.js';
import { assertBscAddress, BNB_CHAINS } from '../_lib/bnb/chains.js';
import { encryptGlb, VAULT_CRYPTO_PARAMS } from '../_lib/bnb/vault-crypto.js';
import { ensureBucket, createObject, GreenfieldWriteError, MAX_VAULT_OBJECT_BYTES } from '../_lib/bnb/greenfield-write.js';
import { vaultContractAddress } from '../_lib/bnb/vault-contract.js';
import { vaultBucketFor, vaultKeyCacheKey, deriveObjectId, storeVaultObjectIndex, VAULT_KEY_TTL_S } from '../_lib/bnb/vault-store.js';
import { priceFor } from '../_lib/x402-prices.js';
import { encryptSecret } from '../_lib/secret-box.js';
import { cacheSet } from '../_lib/cache.js';

const ROUTE = '/api/bnb/vault-upload';
const MAX_INPUT_GLB_BYTES = 64 * 1024 * 1024; // a vault GLB is a 3D asset, not an arbitrary blob
// JSON body cap: base64 inflates raw bytes ~4/3; the +8KB covers the other fields.
const MAX_JSON_BODY_BYTES = Math.ceil((MAX_INPUT_GLB_BYTES * 4) / 3) + 8192;
const MANIFEST_VERSION = 1;

class VaultUploadError extends Error {
	constructor(message, { status = 400, code = 'bad_request', extra } = {}) {
		super(message);
		this.name = 'VaultUploadError';
		this.status = status;
		this.code = code;
		this.extra = extra;
	}
}

// glTF binary magic — first 4 bytes are ASCII "glTF". Mirrors
// api/_lib/material-studio-store.js's isGlbMagic / api/_lib/pipeline-stage.js's
// so a bad input fails the same way everywhere in the 3D pipeline.
function isGlbMagic(bytes) {
	return bytes?.length >= 12 && bytes[0] === 0x67 && bytes[1] === 0x6c && bytes[2] === 0x54 && bytes[3] === 0x46;
}

function assertGlbBytes(buf) {
	if (!buf.length) throw new VaultUploadError('GLB is empty', { status: 400, code: 'empty_glb' });
	if (buf.length > MAX_INPUT_GLB_BYTES) {
		throw new VaultUploadError(`GLB is ${buf.length} bytes; max is ${MAX_INPUT_GLB_BYTES}`, { status: 413, code: 'glb_too_large' });
	}
	if (!isGlbMagic(buf)) {
		throw new VaultUploadError('input is not a binary glTF (.glb) — its bytes lack the "glTF" magic header', {
			status: 415,
			code: 'unsupported_media_type',
		});
	}
}

async function fetchGlbBytes(rawUrl) {
	let safeUrl;
	try {
		safeUrl = await assertPublicHttpsUrl(rawUrl);
	} catch (err) {
		throw new VaultUploadError(`glbUrl rejected: ${err.message}`, { status: 400, code: 'invalid_url' });
	}
	let resp;
	try {
		// Pinned guard fetch: validation alone leaves a validate-then-connect
		// window, and a validated host could redirect to an internal address.
		// The streaming cap keeps an over-limit body from ever buffering.
		resp = await fetchSafePublicUrlPinned(
			safeUrl,
			{ signal: AbortSignal.timeout(30_000) },
			{ maxBytes: MAX_INPUT_GLB_BYTES },
		);
	} catch (err) {
		if (err instanceof MaxBytesExceededError) {
			throw new VaultUploadError(`GLB exceeds the ${MAX_INPUT_GLB_BYTES}-byte limit`, { status: 413, code: 'glb_too_large' });
		}
		if (err?.code === 'ssrf_blocked') {
			throw new VaultUploadError(`glbUrl rejected: ${err.message}`, { status: 400, code: 'invalid_url' });
		}
		throw new VaultUploadError(`could not fetch glbUrl: ${err.message}`, { status: 502, code: 'fetch_failed' });
	}
	if (!resp.ok) {
		throw new VaultUploadError(`glbUrl returned ${resp.status}`, { status: resp.status === 404 ? 404 : 502, code: 'fetch_failed' });
	}
	const buf = Buffer.from(await resp.arrayBuffer());
	assertGlbBytes(buf);
	return buf;
}

function decodeGlbBase64(b64) {
	let buf;
	try {
		buf = Buffer.from(b64, 'base64');
	} catch (err) {
		throw new VaultUploadError('glbBase64 is not valid base64', { status: 400, code: 'bad_base64', extra: { cause: err.message } });
	}
	assertGlbBytes(buf);
	return buf;
}

function normalizeNetwork(raw) {
	const v = String(raw || '').trim().toLowerCase();
	if (v === '' || v === 'testnet' || v === '97' || v === 'bsctestnet') return 'testnet';
	if (v === 'mainnet' || v === '56' || v === 'bscmainnet') return 'mainnet';
	return null;
}

const mapGreenfieldWriteStatus = {
	bad_input: 400,
	too_large: 413,
	no_sp: 502,
	tx_failed: 502,
	upload_failed: 502,
	unavailable: 503,
};

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['POST'])) return;

	const rl = await limits.bnbVaultUploadIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl, 'too many vault uploads');

	if (!env.GREENFIELD_VAULT_OPERATOR_KEY) {
		return error(res, 503, 'vault_not_configured', 'GREENFIELD_VAULT_OPERATOR_KEY is not set — the vault storage account is not provisioned yet');
	}

	let body;
	try {
		body = await readJson(req, MAX_JSON_BODY_BYTES);
	} catch (e) {
		return error(res, e.status || 400, 'bad_body', e.message || 'failed to read JSON body');
	}

	try {
		const network = normalizeNetwork(body?.network);
		if (network === null) {
			return error(res, 400, 'bad_request', `unknown network "${body?.network}" — use "testnet" or "mainnet"`);
		}

		let sellerAddress;
		try {
			sellerAddress = assertBscAddress(body?.sellerAddress);
		} catch (err) {
			return error(res, 400, 'bad_request', `sellerAddress: ${err.message}`);
		}

		const priceAtomic = body?.priceAtomic != null ? String(body.priceAtomic) : priceFor('bnb-vault-upload', '100000');
		if (!/^\d+$/.test(priceAtomic)) {
			return error(res, 400, 'bad_request', 'priceAtomic must be a non-negative integer string (USDC atomics)');
		}

		const hasUrl = typeof body?.glbUrl === 'string' && body.glbUrl.trim();
		const hasBase64 = typeof body?.glbBase64 === 'string' && body.glbBase64.trim();
		if (Boolean(hasUrl) === Boolean(hasBase64)) {
			return error(res, 400, 'bad_request', 'exactly one of glbUrl or glbBase64 is required');
		}

		let glbBytes;
		try {
			glbBytes = hasUrl ? await fetchGlbBytes(body.glbUrl.trim()) : decodeGlbBase64(body.glbBase64.trim());
		} catch (err) {
			if (err instanceof VaultUploadError) return error(res, err.status, err.code, err.message, err.extra);
			throw err;
		}

		// ── 08: encrypt-at-rest. Content key never leaves this function in the clear. ──
		const { ciphertext, contentKey, iv, authTag, sha256OfPlaintext } = encryptGlb(glbBytes);

		const bucket = vaultBucketFor(network);
		const id = randomBytes(8).toString('hex');
		const objectBase = `vaults/${sellerAddress.toLowerCase()}/${id}`;
		const glbObjectName = `${objectBase}.glb.enc`;
		const manifestObjectName = `${objectBase}.manifest.json`;
		const writeOpts = { network, privateKey: env.GREENFIELD_VAULT_OPERATOR_KEY };

		// ── 09: ensure the bucket, then write the ciphertext object. ──
		await ensureBucket(bucket, writeOpts);
		const glbWrite = await createObject(bucket, glbObjectName, ciphertext, {
			...writeOpts,
			contentType: 'application/octet-stream',
			visibility: 'private',
			maxBytes: MAX_VAULT_OBJECT_BYTES,
		});

		// ── Persist the secret content key server-side, NEVER in the manifest. ──
		// Encrypted at rest with the platform's existing custodial-secret box
		// (the same primitive protecting agent wallet keys), keyed by the
		// ciphertext object ref so prompt 11 can look it up post-payment and wrap
		// a fresh copy to the verified buyer's public key.
		const contentKeyCiphertext = await encryptSecret(contentKey.toString('base64'));
		await cacheSet(
			vaultKeyCacheKey(bucket, glbObjectName),
			{ contentKeyCiphertext, sellerAddress, createdAt: new Date().toISOString() },
			VAULT_KEY_TTL_S,
		);

		const { address: contractAddress, deployed: contractDeployed } = vaultContractAddress(network, body?.contractAddress);
		const chainId = BNB_CHAINS[network === 'mainnet' ? 'bscMainnet' : 'bscTestnet'].id;

		const manifest = {
			version: MANIFEST_VERSION,
			glbObjectRef: { bucket, object: glbObjectName },
			encryption: {
				alg: VAULT_CRYPTO_PARAMS.alg,
				iv: iv.toString('hex'),
				authTag: authTag.toString('hex'),
			},
			sha256: sha256OfPlaintext,
			priceAtomic,
			sellerAddress,
			contract: { address: contractAddress, chainId },
			createdAt: new Date().toISOString(),
		};

		// ── Publish the manifest as a public, sibling Greenfield object. ──
		const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2));
		let manifestWrite;
		try {
			manifestWrite = await createObject(bucket, manifestObjectName, manifestBytes, {
				...writeOpts,
				contentType: 'application/json',
				visibility: 'public',
			});
		} catch (err) {
			// The ciphertext IS safely stored (private, unreferenced by any public
			// manifest yet) — surface the ref so a caller can retry the manifest
			// write instead of re-uploading + re-encrypting the whole GLB.
			const extra = { glbObjectRef: { bucket, object: glbObjectName }, sha256: sha256OfPlaintext };
			if (err instanceof GreenfieldWriteError) {
				return error(res, mapGreenfieldWriteStatus[err.code] || 502, err.code, `manifest publish failed: ${err.message}`, extra);
			}
			throw err;
		}

		const status = glbWrite.status === 'stored' && manifestWrite.status === 'stored' ? 'stored' : 'pending';

		// ── Index objectId → object refs so prompt 11's unlock/list/status APIs
		// can resolve a `Listed(objectId, ...)` chain event back to this manifest
		// without needing to reverse a hash — see vault-store.js's deriveObjectId
		// doc comment for why this exists. `objectId` is what a seller passes to
		// `GreenfieldVault.list(objectId, price, seller)` (prompt 12/10).
		const objectId = deriveObjectId(bucket, glbObjectName);
		await storeVaultObjectIndex(objectId, { bucket, glbObject: glbObjectName, manifestObject: manifestObjectName, sellerAddress });

		return json(
			res,
			200,
			{
				objectId,
				manifestRef: { bucket, object: manifestObjectName },
				glbObjectRef: { bucket, object: glbObjectName },
				sha256: sha256OfPlaintext,
				status,
				manifest,
				contractDeployed,
				txHashes: { glb: glbWrite.txHash, manifest: manifestWrite.txHash },
				pollHint: status === 'pending' ? 'object create/upload succeeded; Greenfield is still sealing — GET the manifestRef/glbObjectRef shortly' : undefined,
			},
			{ 'cache-control': 'no-store' },
		);
	} catch (err) {
		if (err instanceof VaultUploadError) return error(res, err.status, err.code, err.message, err.extra);
		if (err instanceof GreenfieldWriteError) return error(res, mapGreenfieldWriteStatus[err.code] || 502, err.code, err.message);
		throw err;
	}
});
