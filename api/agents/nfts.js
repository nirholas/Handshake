/**
 * GET /api/agents/nfts
 * --------------------
 * Returns the NFT portfolio for a Solana wallet using Helius DAS API.
 * Backs the `nft-portfolio` agent skill.
 *
 * Query:
 *   ?wallet=<base58>  — required Solana wallet address
 *   &limit=20         — max items (1-50, default 20)
 *   &page=1           — pagination page (default 1)
 *
 * Auth: session OR bearer (scope `mcp` or `profile`).
 * Requires HELIUS_API_KEY env var.
 */

import { cors, json, method, error, wrap } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { getSessionUser, authenticateBearer, extractBearer, hasScope } from '../_lib/auth.js';

const HELIUS_RPC = () => {
	const url = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
	return url;
};

const RECENT_TX_URL = () => {
	const k = process.env.HELIUS_API_KEY;
	if (!k) throw Object.assign(new Error('HELIUS_API_KEY not configured'), { status: 503, code: 'not_configured' });
	return `https://api.helius.xyz/v0/addresses/{address}/transactions?api-key=${k}`;
};

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const session = await getSessionUser(req);
	const bearer = session ? null : await authenticateBearer(extractBearer(req));
	if (!session && !bearer) return error(res, 401, 'unauthorized', 'sign in required');
	if (bearer && !hasScope(bearer.scope, 'mcp') && !hasScope(bearer.scope, 'profile')) {
		return error(res, 403, 'insufficient_scope', 'requires mcp or profile scope');
	}

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const op = req.query.op || 'portfolio';

	if (op === 'portfolio') return handlePortfolio(req, res);
	if (op === 'activity') return handleActivity(req, res);
	return error(res, 400, 'bad_request', 'op must be portfolio or activity');
});

async function handlePortfolio(req, res) {
	const wallet = String(req.query.wallet || '').trim();
	if (!wallet) return error(res, 400, 'bad_request', 'wallet required');

	const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
	const page = Math.max(1, parseInt(req.query.page) || 1);

	let rpcUrl;
	try {
		rpcUrl = HELIUS_RPC();
	} catch (e) {
		return error(res, e.status || 503, e.code || 'not_configured', e.message);
	}

	const resp = await fetch(rpcUrl, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			jsonrpc: '2.0',
			id: 1,
			method: 'getAssetsByOwner',
			params: {
				ownerAddress: wallet,
				page,
				limit,
				displayOptions: {
					showFungible: false,
					showNativeBalance: false,
					showCollectionMetadata: true,
					showUnverifiedCollections: false,
					showZeroBalance: false,
				},
			},
		}),
	});

	if (!resp.ok) {
		const txt = await resp.text().catch(() => resp.status.toString());
		return error(res, 502, 'upstream_error', `Helius DAS error ${resp.status}: ${txt}`);
	}

	const data = await resp.json();
	if (data.error) {
		return error(res, 502, 'upstream_error', data.error.message || JSON.stringify(data.error));
	}

	const raw = data.result || {};
	const items = (raw.items || []).map((a) => ({
		id: a.id,
		name: a.content?.metadata?.name || a.id,
		symbol: a.content?.metadata?.symbol || '',
		description: a.content?.metadata?.description || '',
		image: a.content?.links?.image || a.content?.files?.find((f) => f.mime?.startsWith('image/'))?.uri || null,
		model: a.content?.files?.find((f) => f.mime?.startsWith('model/'))?.uri || null,
		collection: a.grouping?.find((g) => g.group_key === 'collection')?.group_value || null,
		collectionName: a.grouping?.find((g) => g.group_key === 'collection')?.collection_metadata?.name || null,
		compressed: a.compression?.compressed ?? false,
		burnt: a.burnt ?? false,
	}));

	return json(res, 200, {
		wallet,
		total: raw.total ?? items.length,
		page: raw.page ?? page,
		limit: raw.limit ?? limit,
		items,
	});
}

async function handleActivity(req, res) {
	const wallet = String(req.query.wallet || '').trim();
	if (!wallet) return error(res, 400, 'bad_request', 'wallet required');

	const limit = Math.min(20, Math.max(1, parseInt(req.query.limit) || 10));

	let baseUrl;
	try {
		baseUrl = RECENT_TX_URL();
	} catch (e) {
		return error(res, e.status || 503, e.code || 'not_configured', e.message);
	}

	const url = baseUrl.replace('{address}', encodeURIComponent(wallet)) + `&limit=${limit}`;
	const resp = await fetch(url);

	if (!resp.ok) {
		const txt = await resp.text().catch(() => resp.status.toString());
		return error(res, 502, 'upstream_error', `Helius enhanced tx error ${resp.status}: ${txt}`);
	}

	const txns = await resp.json();
	const items = (Array.isArray(txns) ? txns : []).map((tx) => ({
		signature: tx.signature,
		type: tx.type || 'unknown',
		timestamp: tx.timestamp,
		description: tx.description || '',
		fee: tx.fee,
		feePayer: tx.feePayer,
		tokenTransfers: tx.tokenTransfers || [],
		nativeTransfers: tx.nativeTransfers || [],
	}));

	return json(res, 200, { wallet, items });
}
