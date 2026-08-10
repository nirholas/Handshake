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
 * Requires HELIUS_API_KEY env var: both ops are Helius-only surfaces (DAS
 * `getAssetsByOwner` and the enhanced-transactions REST API). A plain Solana RPC
 * does not implement DAS, so the endpoint reports 503 not_configured rather than
 * forwarding a call that can only fail upstream.
 */

import { cors, json, method, error, wrap, rateLimited, serverError } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { getSessionUser, authenticateBearer, extractBearer, hasScope } from '../_lib/auth.js';
import { dasRpcUrl } from '../_lib/nft-gate.js';

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// DAS (`getAssetsByOwner`) is a Helius extension, not core Solana JSON-RPC.
// dasRpcUrl() resolves HELIUS_API_KEY (or a SOLANA_RPC_URL that already points at
// Helius) and returns null when neither is set — which is a configuration fault,
// not a client error, so it maps to 503.
const DAS_RPC = () => {
	const url = dasRpcUrl();
	if (!url) throw Object.assign(new Error('HELIUS_API_KEY not configured'), { status: 503, code: 'not_configured' });
	return url;
};

const RECENT_TX_URL = () => {
	const k = process.env.HELIUS_API_KEY;
	if (!k) throw Object.assign(new Error('HELIUS_API_KEY not configured'), { status: 503, code: 'not_configured' });
	return `https://api.helius.xyz/v0/addresses/{address}/transactions?api-key=${k}`;
};

// Both ops address a wallet by public key. Validate the shape here so a typo
// returns an actionable 400 instead of an opaque 502 from the upstream provider.
function walletParam(req, res) {
	const wallet = String(req.query.wallet || '').trim();
	if (!wallet) {
		error(res, 400, 'bad_request', 'wallet required');
		return null;
	}
	if (!BASE58_RE.test(wallet)) {
		error(res, 400, 'validation_error', 'wallet must be a base58 Solana address');
		return null;
	}
	return wallet;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const session = await getSessionUser(req);
	const bearer = session ? null : await authenticateBearer(extractBearer(req));
	if (!session && !bearer) return error(res, 401, 'unauthorized', 'sign in required');
	if (bearer && !hasScope(bearer.scope, 'mcp') && !hasScope(bearer.scope, 'profile')) {
		return error(res, 403, 'insufficient_scope', 'requires mcp or profile scope');
	}

	const rl = await limits.authedReadIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const op = req.query.op || 'portfolio';

	if (op === 'portfolio') return handlePortfolio(req, res);
	if (op === 'activity') return handleActivity(req, res);
	return error(res, 400, 'bad_request', 'op must be portfolio or activity');
});

async function handlePortfolio(req, res) {
	const wallet = walletParam(req, res);
	if (!wallet) return;

	const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
	const page = Math.max(1, parseInt(req.query.page) || 1);

	let rpcUrl;
	try {
		rpcUrl = DAS_RPC();
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
		console.error('[agents/nfts] Helius DAS error', resp.status, txt);
		return serverError(res, 502, 'upstream_error', new Error(`Helius DAS error ${resp.status}`));
	}

	const data = await resp.json();
	if (data.error) {
		console.error('[agents/nfts] Helius DAS rpc error', data.error?.message || data.error);
		return serverError(res, 502, 'upstream_error', new Error('Helius DAS rpc error'));
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
	const wallet = walletParam(req, res);
	if (!wallet) return;

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
		console.error('[agents/nfts] Helius enhanced tx error', resp.status, txt);
		return serverError(res, 502, 'upstream_error', new Error(`Helius enhanced tx error ${resp.status}`));
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
