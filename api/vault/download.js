// GET /api/vault/download?objectId=&buyer=&network=&token=
// ---------------------------------------------------------------------------
// BNB vault track (prompt 12/13): stream a vault's ciphertext bytes to an
// authorized buyer. The buyer's browser has no Greenfield keypair (the
// platform holds the one operator key that can auth-fetch a PRIVATE object —
// see greenfield-write.js's module doc), so a direct browser->SP fetch is
// impossible for a private object; this endpoint fetches it server-side with
// the operator key and relays the bytes, gated on the SAME on-chain purchase
// check `unlock.js` performs (re-read fresh, never cached — a revoked grant
// stops working here immediately even with a still-unexpired token).
//
// `token` comes from a prior `POST /api/vault/unlock` response
// (`downloadToken`) — see vault-download-token.js for why a second wallet
// signature isn't required here.
//
// Response: `content-type: application/octet-stream`, raw ciphertext bytes.
// Errors mirror unlock.js's status codes (401 bad/expired token, 403 not
// purchased, 404 not listed, 410 delisted/unavailable, 503 upstream).

import { cors, method, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { assertBscAddress, isEvmAddress, BnbRpcError } from '../_lib/bnb/chains.js';
import { vaultContractAddress, vaultClient, readListing, readSaleIdOf, readSale, VaultContractError } from '../_lib/bnb/vault-contract.js';
import { decodeVaultDownloadToken } from '../_lib/bnb/vault-download-token.js';
import { resolveObjectRef } from '../_lib/bnb/vault-store.js';
import { downloadPrivateObject, GreenfieldWriteError } from '../_lib/bnb/greenfield-write.js';
import { env } from '../_lib/env.js';

function normalizeNetwork(raw) {
	const v = String(raw || '').trim().toLowerCase();
	if (v === '' || v === 'testnet' || v === '97' || v === 'bsctestnet') return 'testnet';
	if (v === 'mainnet' || v === '56' || v === 'bscmainnet') return 'mainnet';
	return null;
}

function isBytes32(v) {
	return typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v);
}

const mapGreenfieldWriteStatus = { not_found: 410, upload_failed: 502, unavailable: 503 };

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	// Same tight budget as unlock: this also spends real bandwidth and SP calls.
	// `rateLimited` (not a hand-rolled 429) so the retry-after / RateLimit headers
	// and the limiter's own `reason` survive. This bucket is `critical: true`, so a
	// Redis outage fails it closed with `rate_limiter_unavailable`, and a client that
	// never sees that reason misreads a limiter outage as its own quota being spent.
	const rl = await limits.bnbVaultUnlockIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl, 'too many vault downloads');

	const params = new URL(req.url, `http://${req.headers?.host || 'x'}`).searchParams;
	const network = normalizeNetwork(params.get('network'));
	if (network === null) {
		return error(res, 400, 'bad_request', `unknown network "${params.get('network')}": use "testnet" or "mainnet"`);
	}
	const objectId = params.get('objectId');
	if (!isBytes32(objectId)) {
		return error(res, 400, 'bad_request', 'objectId must be a 0x-prefixed 32-byte hex value');
	}
	if (!isEvmAddress(params.get('buyer'))) {
		return error(res, 400, 'bad_request', 'buyer must be a valid EVM address');
	}
	const buyer = assertBscAddress(params.get('buyer'));

	const claim = decodeVaultDownloadToken(params.get('token'));
	if (!claim || claim.objectId !== objectId || claim.buyer !== buyer.toLowerCase() || claim.network !== network) {
		return error(res, 401, 'bad_token', 'missing, expired, or mismatched download token; unlock again to get a fresh one');
	}

	if (!env.GREENFIELD_VAULT_OPERATOR_KEY) {
		return error(res, 503, 'vault_not_configured', 'GREENFIELD_VAULT_OPERATOR_KEY is not set; the vault storage account is not provisioned yet');
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
		if (listing.seller === '0x0000000000000000000000000000000000000000') return error(res, 404, 'not_listed', 'this objectId has never been listed');
		if (!listing.active) return error(res, 410, 'delisted', 'this object has been delisted and was never purchased by this buyer');
		return error(res, 403, 'purchase_required', 'this buyer has not purchased this object yet');
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
		return error(res, 403, 'grant_pending', 'the Greenfield permission grant has not settled yet; poll GET /api/vault/status');
	}

	let ref;
	try {
		ref = await resolveObjectRef(objectId, { network });
	} catch (err) {
		return error(res, 503, 'storage_unavailable', `could not resolve vault object refs: ${err.message}`);
	}
	if (!ref) {
		return error(res, 410, 'object_index_missing', 'this object was purchased on-chain but its Greenfield refs could not be resolved');
	}

	let file;
	try {
		file = await downloadPrivateObject(ref.bucket, ref.glbObject, { network, privateKey: env.GREENFIELD_VAULT_OPERATOR_KEY });
	} catch (err) {
		if (err instanceof GreenfieldWriteError) {
			return error(res, mapGreenfieldWriteStatus[err.code] || 502, err.code, `could not fetch ciphertext: ${err.message}`);
		}
		throw err;
	}

	res.writeHead(200, {
		'content-type': 'application/octet-stream',
		'content-length': String(file.bytes.length),
		'cache-control': 'no-store',
		'access-control-allow-origin': '*',
	});
	res.end(file.bytes);
});
