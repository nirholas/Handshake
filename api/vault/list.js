// GET /api/vault/list
// ---------------------------------------------------------------------------
// BNB vault track (prompt 11): browse active listings. Source of truth is
// the on-chain GreenfieldVault contract's `Listed`/`Delisted` events (never
// a copy that could drift); each active objectId is then joined with its
// Greenfield-hosted manifest (prompt 09) for display metadata (price,
// seller, sha256, object refs). An objectId the index can't resolve to a
// manifest is surfaced honestly in `unresolved`, never silently dropped.
//
// Query: ?network=testnet|mainnet (default testnet) &contractAddress=0x…
//        (override; mirrors vault-upload.js's same escape hatch for tests)
// Response 200:
//   { network, contractAddress, contractDeployed, count, listings: [
//       { objectId, seller, priceAtomic, glbObjectRef, manifestRef, sha256, createdAt }
//     ], unresolved: [objectId, …] }

import { cors, json, method, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { BnbRpcError } from '../_lib/bnb/chains.js';
import { vaultContractAddress, vaultClient, getVaultLogs, VaultContractError } from '../_lib/bnb/vault-contract.js';
import { resolveObjectRef, fetchManifest } from '../_lib/bnb/vault-store.js';
import { GreenfieldError } from '../_lib/bnb/greenfield.js';

function normalizeNetwork(raw) {
	const v = String(raw || '').trim().toLowerCase();
	if (v === '' || v === 'testnet' || v === '97' || v === 'bsctestnet') return 'testnet';
	if (v === 'mainnet' || v === '56' || v === 'bscmainnet') return 'mainnet';
	return null;
}

/** Fold Listed/Delisted logs (in block/log order) into the currently-active objectId set. */
function activeListingsFromLogs(logs) {
	const sorted = [...logs].sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : Number(a.blockNumber - b.blockNumber)));
	const state = new Map(); // objectId -> { seller, price, active }
	for (const log of sorted) {
		const objectId = log.args.objectId;
		if (log.eventName === 'Listed') {
			state.set(objectId, { seller: log.args.seller, price: log.args.price, active: true });
		} else if (log.eventName === 'Delisted') {
			const existing = state.get(objectId);
			if (existing) existing.active = false;
			else state.set(objectId, { seller: log.args.seller, price: 0n, active: false });
		}
	}
	return [...state.entries()].filter(([, v]) => v.active);
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

	const { address: contractAddress, deployed: contractDeployed } = vaultContractAddress(network, params.get('contractAddress'));
	if (!contractDeployed) {
		// Honest empty state: nothing can be listed on a contract that isn't live yet.
		return json(res, 200, { network, contractAddress, contractDeployed, count: 0, listings: [], unresolved: [] }, { 'cache-control': 'no-store' });
	}

	let client;
	try {
		client = vaultClient(network);
	} catch (err) {
		return error(res, 400, 'bad_request', err.message);
	}

	let logsResult;
	try {
		logsResult = await getVaultLogs(client, contractAddress, { network });
	} catch (err) {
		if (err instanceof VaultContractError || err instanceof BnbRpcError) {
			return error(res, 503, 'chain_unavailable', `could not read GreenfieldVault logs: ${err.message}`);
		}
		throw err;
	}

	const active = activeListingsFromLogs(logsResult.logs);
	const listings = [];
	const unresolved = [];

	for (const [objectId, chainListing] of active) {
		let ref;
		try {
			ref = await resolveObjectRef(objectId, { network });
		} catch (err) {
			// A Greenfield miss is a genuine "no manifest for this listing" and belongs
			// in `unresolved`. Anything else (the object index being down, a programmer
			// error) is an outage, and reporting it as "this listing has no manifest"
			// would be a lie about real chain state. Same split the manifest fetch below
			// makes, and the same 503 the other vault endpoints return for it.
			if (!(err instanceof GreenfieldError)) {
				return error(res, 503, 'storage_unavailable', `could not resolve vault object refs: ${err.message}`);
			}
			ref = null;
		}
		if (!ref) {
			unresolved.push(objectId);
			continue;
		}
		let manifest = null;
		try {
			manifest = await fetchManifest(ref.bucket, ref.manifestObject, { network });
		} catch (err) {
			// Manifest gone/unreachable — still surface the on-chain listing (never
			// hide real chain state), just without the off-chain metadata.
			if (!(err instanceof GreenfieldError)) throw err;
		}
		listings.push({
			objectId,
			seller: chainListing.seller,
			priceAtomic: chainListing.price.toString(),
			glbObjectRef: { bucket: ref.bucket, object: ref.glbObject },
			manifestRef: { bucket: ref.bucket, object: ref.manifestObject },
			sha256: manifest?.sha256 ?? null,
			manifestPriceAtomic: manifest?.priceAtomic ?? null,
			createdAt: manifest?.createdAt ?? null,
		});
	}

	return json(
		res,
		200,
		{
			network,
			contractAddress,
			contractDeployed,
			fromBlock: logsResult.fromBlock.toString(),
			toBlock: logsResult.toBlock.toString(),
			count: listings.length,
			listings,
			unresolved,
		},
		{ 'cache-control': 'public, max-age=5, s-maxage=10, stale-while-revalidate=30' },
	);
});
