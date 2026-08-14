import { wrap, cors, error, json, readJson, method, rateLimited, serverError } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { cacheGet, cacheSet } from '../_lib/cache.js';
import { dasRpcUrl } from '../_lib/nft-gate.js';
import { resolveGateway } from '../_lib/solana-agents-normalize.js';

// NFT metadata is effectively immutable, but the Helius `getAsset` (DAS) and
// Alchemy `getNFTMetadata` calls behind this endpoint are billed per request and
// were re-resolved on every call, a bot re-requesting the same mint paid the
// upstream every time. Cache the resolved descriptor by chain:id so a given
// asset is fetched from the provider at most once per TTL.
const RESOLVE_TTL_SECONDS = 6 * 60 * 60; // 6h
// Last-known-good copy kept far longer, read ONLY when the upstream provider is
// unreachable. NFT metadata is effectively immutable, so serving a long-stale
// descriptor during a Helius/Alchemy outage is correct, far better than a 502.
const RESOLVE_STALE_TTL_SECONDS = 30 * 24 * 60 * 60; // 30d

// Alchemy NFT API host per EVM chainId. An id of the form
// "chainId:contract:tokenId" (exactly what api/users/[username]/collectibles.js
// emits for every EVM collectible) used to have its chainId parsed and then
// thrown away, so a Base or Polygon NFT was always looked up on Ethereum
// mainnet and came back as a 404 or, worse, as an unrelated Ethereum token that
// happens to share the contract/tokenId pair. Keep this list aligned with the
// hosts in api/_lib/evm/rpc.js ALCHEMY_SUBDOMAIN.
// A provider that answers but never finishes must not hold the request open
// until the platform's own timeout fires; both upstreams are read-only lookups.
const UPSTREAM_TIMEOUT_MS = 15000;

// Read a JSON body without letting a non-JSON 200 (Helius answers quota refusals
// and maintenance pages as plain text) escape as an unhandled parse crash. This
// is a boundary, so it returns null instead of throwing.
async function readJsonBody(resp) {
	try {
		return await resp.json();
	} catch {
		return null;
	}
}

const ALCHEMY_NFT_HOST = {
	1: 'eth-mainnet',
	10: 'opt-mainnet',
	56: 'bnb-mainnet',
	137: 'polygon-mainnet',
	324: 'zksync-mainnet',
	8453: 'base-mainnet',
	42161: 'arb-mainnet',
	43114: 'avax-mainnet',
	59144: 'linea-mainnet',
	534352: 'scroll-mainnet',
	84532: 'base-sepolia',
	421614: 'arb-sepolia',
	11155111: 'eth-sepolia',
	11155420: 'opt-sepolia',
};

export default wrap(async (req, res) => {
	if (cors(req, res)) return;
	if (!method(req, res, ['POST'])) return;

	const rl = await limits.authedReadIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	// A bare `null` JSON body parses to null, and reading `.chain` off it threw a
	// TypeError that surfaced as an opaque 500 instead of the 400 every other
	// malformed body gets.
	const body = (await readJson(req)) || {};
	const chain = String(body.chain || '').toLowerCase();
	const id = String(body.id || '').trim();

	if (!['solana', 'evm'].includes(chain)) {
		return error(res, 400, 'bad_request', 'chain must be solana or evm');
	}
	if (!id) return error(res, 400, 'bad_request', 'id required');

	const cacheKey = `nft-resolve:${chain}:${id}`;
	const staleKey = `nft-resolve-stale:${chain}:${id}`;
	const cached = await cacheGet(cacheKey).catch(() => null);
	if (cached) return json(res, 200, cached);

	// Only a cache MISS reaches the billed upstream, gate that on the shared DAS
	// cost ceiling so a bot resolving thousands of distinct ids can't run up the
	// Helius/Alchemy bill past a fixed hourly cap.
	const ceiling = await limits.heliusDasGlobal();
	if (!ceiling.success) return rateLimited(res, ceiling);

	// Persist a resolved descriptor to both the fresh and long-lived stale tiers.
	const store = async (result) => {
		await cacheSet(cacheKey, result, RESOLVE_TTL_SECONDS).catch(() => {});
		await cacheSet(staleKey, result, RESOLVE_STALE_TTL_SECONDS).catch(() => {});
		return result;
	};
	// Provider unreachable → serve the last-known-good descriptor if we have one,
	// else fall through to the caller's error. Immutable metadata makes this safe.
	const serveStaleOr = async (onMiss) => {
		const lastGood = await cacheGet(staleKey).catch(() => null);
		if (lastGood) {
			console.warn('[nft/resolve] upstream unreachable, serving last-known-good for %s', cacheKey);
			return json(res, 200, { ...lastGood, stale: true });
		}
		return onMiss();
	};

	if (chain === 'solana') {
		// `getAsset` is a DAS method, and Helius is the only provider in our stack
		// that serves it. Reading SOLANA_RPC_URL here pointed the call at whatever
		// general-purpose RPC was configured (production runs magicblock), which
		// answers a JSON-RPC -32601 that the code below then reported to the user as
		// "Asset not found": a real, resolvable NFT read as nonexistent. dasRpcUrl()
		// is the same resolver api/_lib/nft-gate.js gates on, and prefers the
		// dedicated HELIUS_API_KEY.
		const rpcUrl = dasRpcUrl();
		if (!rpcUrl) {
			return error(
				res,
				503,
				'not_configured',
				'HELIUS_API_KEY not configured; solana nft resolution is unavailable',
			);
		}
		let resp;
		try {
			resp = await fetch(rpcUrl, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAsset', params: { id } }),
				signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
			});
		} catch (err) {
			console.error('[nft/resolve] Helius network error', err?.message);
			return serveStaleOr(() =>
				serverError(res, 502, 'upstream_error', new Error('Helius unreachable')),
			);
		}
		if (!resp.ok) {
			const txt = await resp.text().catch(() => '');
			console.error('[nft/resolve] Helius error', resp.status, txt);
			return serveStaleOr(() =>
				serverError(res, 502, 'upstream_error', new Error(`Helius error ${resp.status}`)),
			);
		}
		const data = await readJsonBody(resp);
		if (!data) {
			console.error('[nft/resolve] Helius returned a non-JSON body');
			return serveStaleOr(() =>
				serverError(res, 502, 'upstream_error', new Error('Helius returned a non-JSON body')),
			);
		}
		if (data.error) {
			const msg = data.error.message || JSON.stringify(data.error);
			// -32601 is "the endpoint does not implement this method", an operator
			// misconfiguration. Only a real DAS miss is a 404.
			if (data.error.code === -32601) {
				console.error('[nft/resolve] configured RPC does not serve DAS getAsset');
				return serveStaleOr(() =>
					serverError(res, 502, 'upstream_error', new Error(`DAS getAsset unsupported: ${msg}`)),
				);
			}
			return error(res, 404, 'not_found', `Asset not found: ${msg}`);
		}
		const asset = data.result;
		if (!asset) return error(res, 404, 'not_found', `Asset not found: ${id}`);
		const name = asset?.content?.metadata?.name || asset?.id || id;
		const files = asset?.content?.files || [];
		const modelFile = files.find((f) => f.mime && f.mime.startsWith('model/'));
		const imageUrl =
			asset?.content?.links?.image ||
			files.find((f) => f.mime && f.mime.startsWith('image/'))?.uri ||
			null;
		// The chat NFT viewer hands `model` and `image` straight to GLTFLoader and an
		// <img>, and a browser cannot fetch an ipfs:// URI. Metadata that stores raw
		// ipfs:// pointers rendered as a blank canvas; resolveGateway is the same
		// normalizer the Solana agent index uses and leaves https URLs untouched.
		const result = await store({
			name,
			image: resolveGateway(imageUrl),
			model: resolveGateway(modelFile?.uri) || null,
			mime: modelFile?.mime || null,
			source: 'helius',
		});
		return json(res, 200, result);
	}

	// EVM: id is "contract:tokenId" (Ethereum mainnet) or "chainId:contract:tokenId"
	const parts = id.split(':');
	let contractAddress, tokenId, chainId;
	if (parts.length === 2) {
		[contractAddress, tokenId] = parts;
		chainId = 1;
	} else if (parts.length === 3) {
		[, contractAddress, tokenId] = parts;
		chainId = Number(parts[0]);
	} else {
		return error(res, 400, 'bad_request', 'evm id must be "contract:tokenId" or "chainId:contract:tokenId"');
	}

	const host = ALCHEMY_NFT_HOST[chainId];
	if (!host) {
		return error(res, 400, 'bad_request', `unsupported evm chainId ${parts[0]}`);
	}

	// `env` exposes no ALCHEMY getter, so the previous `env.ALCHEMY_API_KEY` read
	// was undefined in every environment: the whole EVM branch built a URL with a
	// literal "undefined" key and answered 502 on a 401 from Alchemy, configured
	// or not. Read the raw var (the same way collectibles.js, balances.js and
	// scene/gate-check.js do) and say plainly when it is missing.
	const apiKey = process.env.ALCHEMY_API_KEY;
	if (!apiKey) {
		return error(res, 503, 'not_configured', 'ALCHEMY_API_KEY not configured; evm nft resolution is unavailable');
	}
	const url = `https://${host}.g.alchemy.com/nft/v3/${apiKey}/getNFTMetadata?contractAddress=${encodeURIComponent(contractAddress)}&tokenId=${encodeURIComponent(tokenId)}`;
	let resp;
	try {
		resp = await fetch(url, { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
	} catch (err) {
		console.error('[nft/resolve] Alchemy network error', err?.message);
		return serveStaleOr(() =>
			serverError(res, 502, 'upstream_error', new Error('Alchemy unreachable')),
		);
	}
	if (!resp.ok) {
		const txt = await resp.text().catch(() => '');
		if (resp.status === 404) {
			return error(res, 404, 'not_found', `Alchemy error ${resp.status}: ${txt}`);
		}
		console.error('[nft/resolve] Alchemy error', resp.status, txt);
		return serveStaleOr(() =>
			serverError(res, 502, 'upstream_error', new Error(`Alchemy error ${resp.status}`)),
		);
	}
	const data = await readJsonBody(resp);
	if (!data) {
		console.error('[nft/resolve] Alchemy returned a non-JSON body');
		return serveStaleOr(() =>
			serverError(res, 502, 'upstream_error', new Error('Alchemy returned a non-JSON body')),
		);
	}
	const name = data.name || data.contract?.name || id;
	const animationUrl = resolveGateway(data.raw?.metadata?.animation_url);
	const imageUrl = data.image?.cachedUrl || data.media?.[0]?.gateway || null;

	// animation_url may be a glTF/GLB. Test the extension on the path only: a
	// gateway URL carries a query string, and ".glb?filename=x" ends in neither.
	let model = null;
	let mime = null;
	if (animationUrl && /\.(glb|gltf)(\?|$)/i.test(animationUrl)) {
		model = animationUrl;
		mime = /\.gltf(\?|$)/i.test(animationUrl) ? 'model/gltf+json' : 'model/gltf-binary';
	}

	const result = await store({ name, image: imageUrl, model, mime, source: 'alchemy' });
	return json(res, 200, result);
});
