// GET /api/vault/status?objectId=&buyer=&network=
// ---------------------------------------------------------------------------
// BNB vault track (prompt 11): is this buyer's purchase on-chain, and has
// the Greenfield permission grant settled? Reads GreenfieldVault's
// `saleIdOf`/`sales`/`listings` mappings directly — always current chain
// state, never a cached copy. The `pending-grant` state (Greenfield's
// cross-chain ack settles asynchronously, per 00-CONTEXT) is represented
// honestly, not glossed over.
//
// Response 200:
//   { objectId, buyer, network, contractAddress, contractDeployed,
//     listing: { seller, priceAtomic, active } | null,
//     saleId, purchased, policySettled, saleStatus,
//     state: 'unlisted'|'available'|'pending-grant'|'unlocked', pollHint? }

import { cors, json, method, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { assertBscAddress, isEvmAddress, BnbRpcError } from '../_lib/bnb/chains.js';
import { vaultContractAddress, vaultClient, readListing, readSaleIdOf, readSale, VaultContractError } from '../_lib/bnb/vault-contract.js';

function normalizeNetwork(raw) {
	const v = String(raw || '').trim().toLowerCase();
	if (v === '' || v === 'testnet' || v === '97' || v === 'bsctestnet') return 'testnet';
	if (v === 'mainnet' || v === '56' || v === 'bscmainnet') return 'mainnet';
	return null;
}

function isBytes32(v) {
	return typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v);
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.bnbVaultReadIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl, 'too many vault reads');

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

	const { address: contractAddress, deployed: contractDeployed } = vaultContractAddress(network);
	if (!contractDeployed) {
		return json(
			res,
			200,
			{ objectId, buyer, network, contractAddress, contractDeployed, listing: null, saleId: '0', purchased: false, policySettled: false, state: 'unlisted' },
			{ 'cache-control': 'no-store' },
		);
	}

	let client;
	try {
		client = vaultClient(network);
	} catch (err) {
		return error(res, 400, 'bad_request', err.message);
	}

	try {
		const [listing, saleId] = await Promise.all([
			readListing(client, contractAddress, objectId),
			readSaleIdOf(client, contractAddress, objectId, buyer),
		]);

		const listingOut = { seller: listing.seller, priceAtomic: listing.price.toString(), active: listing.active };

		if (saleId === 0n) {
			const state = listing.active ? 'available' : 'unlisted';
			return json(
				res,
				200,
				{ objectId, buyer, network, contractAddress, contractDeployed, listing: listingOut, saleId: '0', purchased: false, policySettled: false, state },
				{ 'cache-control': 'no-store' },
			);
		}

		const sale = await readSale(client, contractAddress, saleId);
		const policySettled = sale.status === 'Granted';
		// Failed/Revoked clear saleIdOf on-chain (a retry/resell becomes possible),
		// so reaching a non-zero saleId here with a non-Granted status can only be
		// the genuinely in-flight Greenfield ack (Pending) — surfaced honestly, not
		// as an error.
		const state = policySettled ? 'unlocked' : 'pending-grant';

		return json(
			res,
			200,
			{
				objectId,
				buyer,
				network,
				contractAddress,
				contractDeployed,
				listing: listingOut,
				saleId: saleId.toString(),
				policyId: sale.policyId.toString(),
				purchased: true,
				policySettled,
				saleStatus: sale.status,
				state,
				pollHint: state === 'pending-grant' ? 'Greenfield permission grant is still mirroring cross-chain, poll again shortly' : undefined,
			},
			{ 'cache-control': 'no-store' },
		);
	} catch (err) {
		if (err instanceof VaultContractError || err instanceof BnbRpcError) {
			return error(res, 503, 'chain_unavailable', `could not read GreenfieldVault state: ${err.message}`);
		}
		throw err;
	}
});
