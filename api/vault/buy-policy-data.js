// GET /api/vault/buy-policy-data?objectId=&buyer=&network=
// ---------------------------------------------------------------------------
// BNB vault track (prompt 12, vault UI): the real GNFD permission-policy
// bytes a buyer's wallet must pass as `buy()`'s second argument. See
// `api/_lib/bnb/vault-policy-data.js`'s docstring for the full wire-format
// provenance and honest caveats. This endpoint just wires it to the listing's
// resolved Greenfield object ref (same `resolveObjectRef` every other vault
// endpoint uses) — it never invents a resourceId, so it 404s honestly for any
// object that hasn't completed a real Greenfield upload yet (true for every
// listing in this campaign as of prompt 12, per prompt 11's own proof).
//
// Response 200: { objectId, buyer, network, policyData: '0x…', resourceId }
// Response 404: not_listed | object_not_found (never uploaded through the real pipeline yet)
// Response 503: chain_unavailable | greenfield_unavailable

import { cors, json, method, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { assertBscAddress, isEvmAddress } from '../_lib/bnb/chains.js';
import { resolveObjectRef } from '../_lib/bnb/vault-store.js';
import { buildBuyPolicyData, VaultPolicyDataError } from '../_lib/bnb/vault-policy-data.js';
import { GreenfieldError } from '../_lib/bnb/greenfield.js';

function normalizeNetwork(raw) {
	const v = String(raw || '')
		.trim()
		.toLowerCase();
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
		return error(
			res,
			400,
			'bad_request',
			`unknown network "${params.get('network')}": use "testnet" or "mainnet"`,
		);
	}
	const objectId = params.get('objectId');
	if (!isBytes32(objectId)) {
		return error(res, 400, 'bad_request', 'objectId must be a 0x-prefixed 32-byte hex value');
	}
	if (!isEvmAddress(params.get('buyer'))) {
		return error(res, 400, 'bad_request', 'buyer must be a valid EVM address');
	}
	const buyer = assertBscAddress(params.get('buyer'));

	let ref;
	try {
		ref = await resolveObjectRef(objectId, { network });
	} catch (err) {
		return error(
			res,
			503,
			'storage_unavailable',
			`could not resolve vault object refs: ${err.message}`,
		);
	}
	if (!ref) {
		return error(
			res,
			404,
			'not_listed',
			'this objectId is not resolvable to a listed Greenfield object',
		);
	}

	try {
		const { policyDataHex, resourceId } = await buildBuyPolicyData({
			bucket: ref.bucket,
			object: ref.glbObject,
			buyer,
			network,
		});
		return json(
			res,
			200,
			{ objectId, buyer, network, policyData: policyDataHex, resourceId },
			{ 'cache-control': 'no-store' },
		);
	} catch (err) {
		if (err instanceof VaultPolicyDataError) {
			const status =
				err.code === 'object_not_found' ? 404 : err.code === 'bad_input' ? 400 : 503;
			return error(res, status, err.code, err.message);
		}
		if (err instanceof GreenfieldError) {
			return error(
				res,
				err.code === 'not_found' ? 404 : 503,
				`greenfield_${err.code}`,
				err.message,
			);
		}
		throw err;
	}
});
