// POST /api/vault/unlock
// ---------------------------------------------------------------------------
// BNB vault track (prompt 11): the endpoint where payment (contract, prompt
// 10), storage (Greenfield, prompts 07/09), and crypto (envelope, prompt 08)
// meet. A buyer proves control of their address with a signed message
// (api/_lib/bnb/vault-unlock-auth.js), which ALSO recovers their real
// secp256k1 public key — no separate pubkey-registration step. Only once the
// contract shows a settled purchase (`sales[saleId].status == Granted`) does
// this re-wrap the object's content key to that key
// (`vault-crypto.wrapKey`) and return it. The raw content key and the
// plaintext GLB are NEVER returned — the buyer downloads ciphertext via
// Greenfield (07's `downloadObject`) and decrypts locally with the wrapped
// key this endpoint hands back.
//
// Body (application/json):
//   { objectId: '0x…32-byte', buyer: '0x…EVM address', network?: 'testnet'|'mainnet',
//     message: string, signature: '0x…' }
//   `message` must be exactly `buildVaultUnlockMessage({objectId, buyer, network, nonce, issuedAt})`
//   (api/_lib/bnb/vault-unlock-auth.js) — the buyer's wallet signs it.
//
// Response 200 (unlocked):
//   { state:'unlocked', objectId, buyer, saleId, policyId, glbObjectRef, manifest,
//     wrappedKey: { ephemeralPublicKey, iv, authTag, ciphertext } (all 0x-hex) }
// Response 200 (pending-grant): { state:'pending-grant', pollHint, saleId }
// Response 401: bad/expired/replayed signature.
// Response 403: no purchase found (still listed — buy first).
// Response 404: objectId was never listed.
// Response 410: delisted with no purchase, OR the seller's key record has
//               expired/is unavailable.
// Response 503: contract not deployed yet / chain or Greenfield unreachable.

import { cors, json, method, wrap, error, readJson, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { assertBscAddress, isEvmAddress, BnbRpcError } from '../_lib/bnb/chains.js';
import { vaultContractAddress, vaultClient, readListing, readSaleIdOf, readSale, VaultContractError } from '../_lib/bnb/vault-contract.js';
import { verifyVaultUnlockAuth, VaultUnlockAuthError } from '../_lib/bnb/vault-unlock-auth.js';
import { resolveObjectRef, getVaultKeyRecord, fetchManifest } from '../_lib/bnb/vault-store.js';
import { wrapKey, VaultCryptoError } from '../_lib/bnb/vault-crypto.js';
import { GreenfieldError } from '../_lib/bnb/greenfield.js';
import { decryptSecret } from '../_lib/secret-box.js';
import { encodeVaultDownloadToken } from '../_lib/bnb/vault-download-token.js';

function normalizeNetwork(raw) {
	const v = String(raw || '').trim().toLowerCase();
	if (v === '' || v === 'testnet' || v === '97' || v === 'bsctestnet') return 'testnet';
	if (v === 'mainnet' || v === '56' || v === 'bscmainnet') return 'mainnet';
	return null;
}

function isBytes32(v) {
	return typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v);
}

const AUTH_STATUS = { bad_message: 400, field_mismatch: 400, expired: 401, replay: 401, bad_signature: 401 };

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['POST'])) return;

	const rl = await limits.bnbVaultUnlockIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl, 'too many unlock attempts');

	let body;
	try {
		body = await readJson(req);
	} catch (e) {
		return error(res, e.status || 400, 'bad_body', e.message || 'failed to read JSON body');
	}

	const network = normalizeNetwork(body?.network);
	if (network === null) {
		return error(res, 400, 'bad_request', `unknown network "${body?.network}": use "testnet" or "mainnet"`);
	}
	const objectId = body?.objectId;
	if (!isBytes32(objectId)) {
		return error(res, 400, 'bad_request', 'objectId must be a 0x-prefixed 32-byte hex value');
	}
	if (!isEvmAddress(body?.buyer)) {
		return error(res, 400, 'bad_request', 'buyer must be a valid EVM address');
	}
	const buyer = assertBscAddress(body.buyer);

	// ── Proof of buyer control (also recovers the wrap-recipient public key). ──
	let pubKey;
	try {
		({ pubKey } = await verifyVaultUnlockAuth({ objectId, buyer, network, message: body?.message, signature: body?.signature }));
	} catch (err) {
		if (err instanceof VaultUnlockAuthError) {
			return error(res, AUTH_STATUS[err.code] || 401, err.code, err.message);
		}
		throw err;
	}

	const { address: contractAddress, deployed: contractDeployed } = vaultContractAddress(network);
	if (!contractDeployed) {
		return error(res, 503, 'contract_not_deployed', 'the GreenfieldVault contract is not deployed on this network yet');
	}

	let client;
	try {
		client = vaultClient(network);
	} catch (err) {
		return error(res, 400, 'bad_request', err.message);
	}

	let listing, saleId;
	try {
		[listing, saleId] = await Promise.all([
			readListing(client, contractAddress, objectId),
			readSaleIdOf(client, contractAddress, objectId, buyer),
		]);
	} catch (err) {
		if (err instanceof VaultContractError || err instanceof BnbRpcError) {
			return error(res, 503, 'chain_unavailable', `could not read GreenfieldVault state: ${err.message}`);
		}
		throw err;
	}

	if (saleId === 0n) {
		if (listing.seller === '0x0000000000000000000000000000000000000000') {
			return error(res, 404, 'not_listed', 'this objectId has never been listed on the vault contract');
		}
		if (!listing.active) {
			return error(res, 410, 'delisted', 'this object has been delisted and was never purchased by this buyer');
		}
		return error(res, 403, 'purchase_required', 'this buyer has not purchased this object yet', {
			contractAddress,
			priceAtomic: listing.price.toString(),
			seller: listing.seller,
		});
	}

	let sale;
	try {
		sale = await readSale(client, contractAddress, saleId);
	} catch (err) {
		if (err instanceof VaultContractError || err instanceof BnbRpcError) {
			return error(res, 503, 'chain_unavailable', `could not read GreenfieldVault sale state: ${err.message}`);
		}
		throw err;
	}

	if (sale.status !== 'Granted') {
		// Failed/Revoked clear saleIdOf on-chain, so a non-zero saleId with a
		// non-Granted status here is genuinely the async Greenfield ack still
		// in flight — honest 200, not an error.
		return json(
			res,
			200,
			{ state: 'pending-grant', objectId, buyer, network, saleId: saleId.toString(), saleStatus: sale.status, pollHint: 'Greenfield permission grant is still mirroring cross-chain, poll again shortly' },
			{ 'cache-control': 'no-store' },
		);
	}

	// ── Resolve the manifest/key material for this objectId. ──
	let ref;
	try {
		ref = await resolveObjectRef(objectId, { network });
	} catch (err) {
		return error(res, 503, 'storage_unavailable', `could not resolve vault object refs: ${err.message}`);
	}
	if (!ref) {
		return error(res, 410, 'object_index_missing', 'this object was purchased on-chain but its Greenfield refs could not be resolved (manifest missing or bucket unreachable)');
	}

	let manifest;
	try {
		manifest = await fetchManifest(ref.bucket, ref.manifestObject, { network });
	} catch (err) {
		if (err instanceof GreenfieldError) {
			return error(res, err.code === 'not_found' ? 410 : 503, `manifest_${err.code}`, `could not fetch manifest: ${err.message}`);
		}
		throw err;
	}

	const keyRecord = await getVaultKeyRecord(ref.bucket, ref.glbObject);
	if (!keyRecord?.contentKeyCiphertext) {
		return error(res, 410, 'key_unavailable', 'the content key for this object is no longer available (expired or never uploaded through this platform)');
	}

	let contentKeyB64;
	try {
		contentKeyB64 = await decryptSecret(keyRecord.contentKeyCiphertext);
	} catch (err) {
		return error(res, 500, 'key_decrypt_failed', `could not decrypt the stored content key: ${err.message}`);
	}
	const contentKey = Buffer.from(contentKeyB64, 'base64');

	let wrapped;
	try {
		wrapped = wrapKey(contentKey, pubKey);
	} catch (err) {
		if (err instanceof VaultCryptoError) return error(res, 400, err.code, err.message);
		throw err;
	}

	return json(
		res,
		200,
		{
			state: 'unlocked',
			objectId,
			buyer,
			network,
			saleId: saleId.toString(),
			policyId: sale.policyId.toString(),
			glbObjectRef: { bucket: ref.bucket, object: ref.glbObject },
			manifest,
			wrappedKey: {
				ephemeralPublicKey: `0x${wrapped.ephemeralPublicKey.toString('hex')}`,
				iv: `0x${wrapped.iv.toString('hex')}`,
				authTag: `0x${wrapped.authTag.toString('hex')}`,
				ciphertext: `0x${wrapped.ciphertext.toString('hex')}`,
			},
			// Lets the buyer's client fetch the ciphertext via GET /api/vault/download
			// without signing a second wallet message — see vault-download-token.js.
			downloadToken: encodeVaultDownloadToken({ objectId, buyer, network }),
		},
		{ 'cache-control': 'no-store' },
	);
});
