/**
 * BNB Greenfield WRITE client — bucket/object creation + ciphertext upload,
 * built on `@bnb-chain/greenfield-js-sdk`. Composed by the vault upload
 * pipeline (prompt 09); pairs with the read-only `greenfield.js` (prompt 07).
 *
 * Why the SDK here (unlike greenfield.js's plain-`fetch` read path): creating
 * a bucket/object is NOT a plain REST call — it is a signed Greenfield
 * transaction (broadcast to the chain) that requires Reed-Solomon
 * erasure-coded checksums computed client-side up front, followed by a
 * separate authenticated PUT of the actual bytes to a Storage Provider. The
 * SDK exists specifically to save every caller from hand-rolling that
 * protobuf/EIP-712/erasure-coding dance, so per this prompt's brief it is
 * used directly rather than reimplemented (contrast with 00-CONTEXT's
 * "wrap the minimal REST yourself" default, which applies to the READ path
 * only). Reference implementation this module mirrors line-for-line:
 * bnb-chain/greenfield-js-sdk `examples/nodejs-file-management/storage.js`.
 *
 * Two-phase, asynchronous by protocol design (00-CONTEXT: "cross-chain /
 * storage ops settle async — poll for effect, never assume same-block"):
 *   1. `createObject` broadcasts a Greenfield tx that lands the object as
 *      `OBJECT_STATUS_CREATED` (metadata only, no bytes yet).
 *   2. `uploadObject` PUTs the real bytes to the primary Storage Provider,
 *      which seals the object (`OBJECT_STATUS_SEALED`) some time later.
 * `createObject()` below polls the read client's `getObjectMeta` with bounded
 * exponential backoff and returns `status:'pending'` honestly if sealing
 * hasn't landed inside the budget — never a lie that the bytes are ready.
 *
 * The platform (not the seller) holds the Greenfield signing account — sellers
 * only ever hold a BSC address for payment (recorded in the vault manifest as
 * `sellerAddress`), never a Greenfield keypair. This is a managed-storage
 * model: `GREENFIELD_VAULT_OPERATOR_KEY` (api/_lib/env.js) is the platform's
 * own account, reused across every seller's uploads. Every write helper here
 * also accepts an explicit `privateKey`/`client` in `opts` for tests and for
 * a future self-custodied mode — see `tests/bnb-greenfield-write.test.js`.
 */

import { createRequire } from 'node:module';
import { ReedSolomon } from '@bnb-chain/reed-solomon';
import { privateKeyToAccount } from 'viem/accounts';

import { greenfieldNetwork, headBucket, getObjectMeta, GreenfieldError } from './greenfield.js';

// `@bnb-chain/greenfield-js-sdk`'s ESM build (dist/esm) has broken internal
// deep-import specifiers into `@bnb-chain/greenfield-cosmos-types` (missing
// `.js` extensions) — confirmed live against this repo's Node runtime:
// `ERR_MODULE_NOT_FOUND: Cannot find module '.../greenfield-cosmos-types/
// google/protobuf/any'`. Bundler-based consumers (webpack/Vite/esbuild) paper
// over this by auto-resolving extensions, which is why the SDK's own tests
// never hit it — but this codebase's production runtime (server/index.mjs on
// Cloud Run) is plain Node, not a bundle, so a static `import` of the ESM
// entrypoint would crash this module at import time in production. The
// package's CJS build (dist/cjs) exports the identical public API with no
// such issue, so this loads it via `createRequire` — the standard Node
// interop for "the ESM build of a dependency is broken, the CJS build isn't."
const require = createRequire(import.meta.url);
const { Client, Long, VisibilityType, RedundancyType, bytesFromBase64 } = require('@bnb-chain/greenfield-js-sdk');

// Fallback gas price when the chain's own simulate() doesn't return one (the
// exact fallback the official SDK example uses — 5 gwei-equivalent in GNFD's
// smallest denom).
const DEFAULT_GAS_PRICE = '5000000000';
const DEFAULT_GAS_DENOM = 'BNB'; // Greenfield's native gas token (bridged from BSC) — SDK's own DEFAULT_DENOM.

// A vault GLB is a 3D asset, not an arbitrary blob — this caps abuse (someone
// trying to park a huge unrelated file behind the vault) while comfortably
// covering any GLB this platform's own forge pipeline produces.
export const MAX_VAULT_OBJECT_BYTES = 200 * 1024 * 1024;

const DEFAULT_POLL_INTERVAL_MS = 1500;
const DEFAULT_POLL_TIMEOUT_MS = 20_000;
const MAX_POLL_INTERVAL_MS = 8_000;

/** Typed error. `code` ∈ bad_input | too_large | no_sp | tx_failed | upload_failed | unavailable. */
export class GreenfieldWriteError extends Error {
	constructor(message, info = {}) {
		super(message);
		this.name = 'GreenfieldWriteError';
		this.code = info.code || 'unavailable';
		this.txHash = info.txHash;
		if (info.cause) this.cause = info.cause;
	}
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

const clientCache = new Map();

/** Build (or reuse) an SDK `Client` for a network. Tests inject `opts.client` to bypass this entirely. */
function resolveClient(network, opts) {
	if (opts.client) return opts.client;
	const key = network === 'mainnet' ? 'mainnet' : 'testnet';
	if (!clientCache.has(key)) {
		const { lcd, evmChainId } = greenfieldNetwork(key);
		clientCache.set(key, Client.create(lcd, String(evmChainId)));
	}
	return clientCache.get(key);
}

/** Normalize a hex/0x-hex private key and derive its 0x address (secp256k1 — same curve/derivation as a BSC EOA). */
function accountFromPrivateKey(privateKey) {
	if (typeof privateKey !== 'string' || !privateKey) {
		throw new GreenfieldWriteError('privateKey is required for a Greenfield write', { code: 'bad_input' });
	}
	const pk = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
	let account;
	try {
		account = privateKeyToAccount(pk);
	} catch (err) {
		throw new GreenfieldWriteError('privateKey is not a valid secp256k1 private key', { code: 'bad_input', cause: err });
	}
	return { privateKey: pk, address: account.address };
}

/** Simulate + broadcast an SDK tx handle (the `{simulate, broadcast}` shape every `client.bucket.*`/`client.object.*` write returns). */
async function broadcastTx(tx, address, privateKey) {
	let sim;
	try {
		sim = await tx.simulate({ denom: DEFAULT_GAS_DENOM });
	} catch (err) {
		throw new GreenfieldWriteError(`Greenfield tx simulation failed: ${err.message}`, { code: 'tx_failed', cause: err });
	}
	let res;
	try {
		res = await tx.broadcast({
			denom: DEFAULT_GAS_DENOM,
			gasLimit: Number(sim?.gasLimit) || undefined,
			gasPrice: sim?.gasPrice || DEFAULT_GAS_PRICE,
			payer: address,
			granter: '',
			privateKey,
		});
	} catch (err) {
		throw new GreenfieldWriteError(`Greenfield tx broadcast failed: ${err.message}`, { code: 'tx_failed', cause: err });
	}
	if (res.code !== 0) {
		throw new GreenfieldWriteError(`Greenfield tx rejected (code ${res.code}): ${res.rawLog || 'no rawLog'}`, {
			code: 'tx_failed',
			txHash: res.transactionHash,
		});
	}
	return res;
}

/** Pick the primary Storage Provider to host a new bucket. */
async function primaryStorageProvider(client) {
	let sp;
	try {
		sp = await client.sp.getInServiceSP();
	} catch (err) {
		throw new GreenfieldWriteError(`could not resolve an in-service Storage Provider: ${err.message}`, { code: 'no_sp', cause: err });
	}
	if (!sp?.operatorAddress) {
		throw new GreenfieldWriteError('no in-service Greenfield Storage Provider available', { code: 'no_sp' });
	}
	return sp;
}

/**
 * Ensure a bucket exists, creating it if absent. Idempotent: a bucket that
 * already exists (from a prior call, or created concurrently between our
 * existence check and the create broadcast) is a no-op success, never an
 * error — the "bucket already exists → reuse, don't fail" state from 09.
 *
 * @param {string} bucketName
 * @param {{ network?: string, privateKey?: string, client?: object, visibility?: 'public'|'private', fetchImpl?: Function }} [opts]
 * @returns {Promise<{ bucket: string, network: string, created: boolean, txHash?: string, primarySp?: string, owner?: string|null }>}
 */
export async function ensureBucket(bucketName, opts = {}) {
	const network = opts.network === 'mainnet' ? 'mainnet' : 'testnet';

	try {
		const info = await headBucket(bucketName, { network, fetchImpl: opts.fetchImpl });
		return { bucket: bucketName, network, created: false, owner: info.owner || info.Owner || null };
	} catch (err) {
		if (!(err instanceof GreenfieldError) || err.code !== 'not_found') throw err;
	}

	const { address, privateKey } = accountFromPrivateKey(opts.privateKey);
	const client = resolveClient(network, opts);
	const sp = await primaryStorageProvider(client);

	const visibility = opts.visibility === 'public' ? VisibilityType.VISIBILITY_TYPE_PUBLIC_READ : VisibilityType.VISIBILITY_TYPE_PRIVATE;

	let tx;
	try {
		tx = await client.bucket.createBucket({
			bucketName,
			creator: address,
			visibility,
			chargedReadQuota: Long.fromString('0'),
			primarySpAddress: sp.operatorAddress,
			paymentAddress: address,
		});
	} catch (err) {
		throw new GreenfieldWriteError(`could not build createBucket tx: ${err.message}`, { code: 'tx_failed', cause: err });
	}

	try {
		const res = await broadcastTx(tx, address, privateKey);
		return { bucket: bucketName, network, created: true, txHash: res.transactionHash, primarySp: sp.operatorAddress };
	} catch (err) {
		// A concurrent creator (another request, or this call racing its own retry)
		// can land the bucket between our headBucket miss and this broadcast —
		// Greenfield rejects that as "already exists". Treat it the same as the
		// pre-check hit: idempotent success, not a failure.
		if (/already exists|repeated/i.test(err.message || '')) {
			const info = await headBucket(bucketName, { network, fetchImpl: opts.fetchImpl }).catch(() => null);
			return { bucket: bucketName, network, created: false, owner: info?.owner || info?.Owner || null };
		}
		throw err;
	}
}

/** True once the read client sees the object as sealed (bytes durably stored, not just CREATED metadata). */
function isSealed(objectInfo) {
	const status = objectInfo?.object_status ?? objectInfo?.objectStatus ?? objectInfo?.ObjectStatus;
	if (status == null) return false;
	return String(status).toUpperCase() === 'OBJECT_STATUS_SEALED' || Number(status) === 1;
}

/** Bounded-backoff poll for an object to become sealed. Never assumes same-block settlement. */
async function pollForSeal(bucket, object, { network, fetchImpl, pollIntervalMs, pollTimeoutMs }) {
	const timeoutMs = pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
	const baseInterval = pollIntervalMs || DEFAULT_POLL_INTERVAL_MS;
	const deadline = Date.now() + timeoutMs;
	let attempt = 0;
	for (;;) {
		try {
			const info = await getObjectMeta(bucket, object, { network, fetchImpl });
			if (isSealed(info)) return true;
		} catch (err) {
			if (!(err instanceof GreenfieldError) || err.code !== 'not_found') throw err;
			// not_found: the create tx hasn't mirrored into the SP's index yet — keep polling.
		}
		if (Date.now() >= deadline) return false;
		attempt++;
		await sleep(Math.min(baseInterval * 2 ** Math.min(attempt, 3), MAX_POLL_INTERVAL_MS));
	}
}

/**
 * Create an object (bucket must already exist — call `ensureBucket` first)
 * and upload its bytes to the primary Storage Provider. Computes the
 * Reed-Solomon erasure-coding checksums the chain requires, broadcasts the
 * `MsgCreateObject` tx, PUTs the bytes, then polls for the SP to seal the
 * object. Returns `status:'pending'` (not a lie of `'stored'`) if sealing
 * hasn't landed inside the poll budget.
 *
 * @param {string} bucketName
 * @param {string} objectName
 * @param {Uint8Array|Buffer} bytes
 * @param {{ network?: string, privateKey?: string, client?: object, contentType?: string,
 *   visibility?: 'public'|'private', maxBytes?: number, pollIntervalMs?: number,
 *   pollTimeoutMs?: number, fetchImpl?: Function }} [opts]
 * @returns {Promise<{ bucket: string, object: string, network: string, txHash: string, sp: string, status: 'stored'|'pending' }>}
 */
export async function createObject(bucketName, objectName, bytes, opts = {}) {
	const network = opts.network === 'mainnet' ? 'mainnet' : 'testnet';
	// Validate size BEFORE materializing a copy: Uint8Array.from() on a non-typed
	// array-like walks it element by element, so converting an oversized input
	// first would burn minutes of CPU (and a 200MB allocation) just to reject it.
	const byteLength = bytes?.length ?? 0;
	if (byteLength === 0) {
		throw new GreenfieldWriteError('object bytes must not be empty', { code: 'bad_input' });
	}
	const maxBytes = opts.maxBytes || MAX_VAULT_OBJECT_BYTES;
	if (byteLength > maxBytes) {
		throw new GreenfieldWriteError(`object is ${byteLength} bytes, exceeds the ${maxBytes}-byte vault limit`, { code: 'too_large' });
	}
	const payload = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);

	const { address, privateKey } = accountFromPrivateKey(opts.privateKey);
	const client = resolveClient(network, opts);

	const rs = new ReedSolomon();
	let checksumsB64;
	try {
		checksumsB64 = rs.encode(payload);
	} catch (err) {
		throw new GreenfieldWriteError(`Reed-Solomon checksum encoding failed: ${err.message}`, { code: 'bad_input', cause: err });
	}
	const expectChecksums = checksumsB64.map((c) => bytesFromBase64(c));
	const contentType = opts.contentType || 'application/octet-stream';
	const visibility = opts.visibility === 'public' ? VisibilityType.VISIBILITY_TYPE_PUBLIC_READ : VisibilityType.VISIBILITY_TYPE_PRIVATE;

	let tx;
	try {
		tx = await client.object.createObject({
			bucketName,
			objectName,
			creator: address,
			visibility,
			contentType,
			redundancyType: RedundancyType.REDUNDANCY_EC_TYPE,
			payloadSize: Long.fromInt(payload.length),
			expectChecksums,
		});
	} catch (err) {
		throw new GreenfieldWriteError(`could not build createObject tx: ${err.message}`, { code: 'tx_failed', cause: err });
	}
	const createRes = await broadcastTx(tx, address, privateKey);

	try {
		await client.object.uploadObject(
			{
				bucketName,
				objectName,
				body: { name: objectName, type: contentType, size: payload.length, content: Buffer.from(payload) },
				txnHash: createRes.transactionHash,
			},
			{ type: 'ECDSA', privateKey },
		);
	} catch (err) {
		// SP upload failed after the on-chain CREATE landed — never leave a
		// half-object a manifest could reference. Best-effort cancel the pending
		// create so a retry starts clean; the original upload error still wins.
		try {
			const cancelTx = await client.object.cancelCreateObject({ operator: address, bucketName, objectName });
			await broadcastTx(cancelTx, address, privateKey);
		} catch {
			// Best-effort only — surfacing the cancel failure would mask the real
			// (upload) error below, and the CREATED-but-unsealed object safely
			// expires on its own if cancellation didn't land either.
		}
		throw new GreenfieldWriteError(`Storage Provider upload failed: ${err.message}`, { code: 'upload_failed', cause: err, txHash: createRes.transactionHash });
	}

	const sp = await primaryStorageProvider(client);
	const sealed = await pollForSeal(bucketName, objectName, {
		network,
		fetchImpl: opts.fetchImpl,
		pollIntervalMs: opts.pollIntervalMs,
		pollTimeoutMs: opts.pollTimeoutMs,
	});

	return {
		bucket: bucketName,
		object: objectName,
		network,
		txHash: createRes.transactionHash,
		sp: sp.operatorAddress,
		status: sealed ? 'stored' : 'pending',
	};
}

/**
 * Authenticated download of a PRIVATE Greenfield object, signed by the
 * platform's operator key (the same account `createObject` used to write it —
 * see the module doc comment on the managed-storage model: sellers/buyers
 * never hold a Greenfield keypair). Used by `GET /api/vault/download`
 * (prompt 12/13) to fetch a vault's ciphertext object on an authorized
 * buyer's behalf, after that buyer's on-chain purchase + Greenfield grant
 * (`sales[saleId].status == Granted`) has already been re-verified fresh by
 * the caller — this function itself does no authorization, only the signed
 * SP fetch (mirrors `createObject`'s `client.object.uploadObject(...,
 * {type:'ECDSA', privateKey})` auth shape, the SDK's `client.object.getObject`
 * counterpart for reads).
 *
 * @param {string} bucketName @param {string} objectName
 * @param {{ network?: string, privateKey?: string, client?: object }} [opts]
 * @returns {Promise<{ bytes: Buffer, contentType: string|null }>}
 */
export async function downloadPrivateObject(bucketName, objectName, opts = {}) {
	const network = opts.network === 'mainnet' ? 'mainnet' : 'testnet';
	const { privateKey } = accountFromPrivateKey(opts.privateKey);
	const client = resolveClient(network, opts);

	let result;
	try {
		result = await client.object.getObject({ bucketName, objectName }, { type: 'ECDSA', privateKey });
	} catch (err) {
		throw new GreenfieldWriteError(`Greenfield getObject request failed: ${err.message}`, { code: 'unavailable', cause: err });
	}
	if (result.code !== 0 || !result.body) {
		const status = result.statusCode;
		const code = status === 404 ? 'not_found' : status === 403 ? 'upload_failed' : 'unavailable';
		throw new GreenfieldWriteError(result.message || 'Greenfield getObject failed', { code });
	}

	const blob = result.body;
	const arrayBuffer = typeof blob.arrayBuffer === 'function' ? await blob.arrayBuffer() : blob;
	return {
		bytes: Buffer.from(arrayBuffer),
		contentType: blob.type || 'application/octet-stream',
	};
}
