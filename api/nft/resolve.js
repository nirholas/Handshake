import { wrap, cors, error, json, readJson, method, rateLimited, serverError } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { cacheGet, cacheSet } from '../_lib/cache.js';
import { dasRpcUrl } from '../_lib/nft-gate.js';
import { resolveGateway } from '../_lib/solana-agents-normalize.js';
import { fetchTokenMeta } from '../_lib/solana-token-meta.js';
import { evmFallbackProvider } from '../_lib/evm/rpc.js';

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

// Metadata documents are small JSON files; anything larger is not one.
const MAX_METADATA_BYTES = 512 * 1024;

/**
 * Read an NFT metadata document from a token `uri`.
 *
 * Handles the three forms in the wild: an https URL, a decentralized pointer
 * (ipfs:// or ar://, normalized to a gateway), and a fully on-chain
 * `data:application/json` URI. Returns null on anything unreadable, so callers
 * treat a bad document the same as a missing one.
 */
async function fetchMetadataDoc(uri) {
	if (!uri) return null;
	const raw = String(uri).trim();
	if (raw.startsWith('data:application/json')) {
		const comma = raw.indexOf(',');
		if (comma < 0) return null;
		const payload = raw.slice(comma + 1);
		const body = /;base64/i.test(raw.slice(0, comma))
			? Buffer.from(payload, 'base64').toString('utf8')
			: decodeURIComponent(payload);
		try {
			return JSON.parse(body);
		} catch {
			return null;
		}
	}
	const url = resolveGateway(raw);
	if (!url || !/^https?:\/\//i.test(url)) return null;
	let resp;
	try {
		resp = await fetch(url, {
			redirect: 'follow',
			headers: { accept: 'application/json' },
			signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
		});
	} catch {
		return null;
	}
	if (!resp.ok) return null;
	if (Number(resp.headers.get('content-length') || 0) > MAX_METADATA_BYTES) return null;
	const text = await resp.text().catch(() => '');
	if (!text || text.length > MAX_METADATA_BYTES) return null;
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/**
 * Pick the 3D model out of a metadata document.
 *
 * `properties.files[]` with a `model/*` type is the Metaplex convention our own
 * mints write; `animation_url` pointing at a .glb/.gltf is what most EVM
 * collections use. Test the extension against the path only, since a gateway
 * URL carries a query string after it.
 */
function pickModel(doc) {
	const files = Array.isArray(doc?.properties?.files) ? doc.properties.files : [];
	const modelFile = files.find((f) => {
		const t = f?.type || f?.mime;
		return typeof t === 'string' && t.startsWith('model/') && f?.uri;
	});
	if (modelFile) return { model: resolveGateway(modelFile.uri), mime: modelFile.type || modelFile.mime };
	const animation = typeof doc?.animation_url === 'string' ? doc.animation_url : null;
	if (animation && /\.(glb|gltf)(\?|$)/i.test(animation)) {
		return {
			model: resolveGateway(animation),
			mime: /\.gltf(\?|$)/i.test(animation) ? 'model/gltf+json' : 'model/gltf-binary',
		};
	}
	return { model: null, mime: null };
}

// Alchemy NFT API host per EVM chainId. An id of the form
// "chainId:contract:tokenId" (exactly what api/users/[username]/collectibles.js
// emits for every EVM collectible) used to have its chainId parsed and then
// thrown away, so a Base or Polygon NFT was always looked up on Ethereum
// mainnet and came back as a 404 or, worse, as an unrelated Ethereum token that
// happens to share the contract/tokenId pair.
//
// This map is also the endpoint's supported-chain gate: a chainId missing here
// is rejected 400 before either rung runs, so an omission costs the caller the
// keyless on-chain read too, which needs no Alchemy key at all. Keep it aligned
// with api/_lib/evm/rpc.js ALCHEMY_SUBDOMAIN, which is what let polygon-amoy and
// avax-fuji drop out: both are in that map and in the chain registry with public
// RPCs, and both answered "unsupported evm chainId" here regardless.
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
	// testnets
	84532: 'base-sepolia',
	421614: 'arb-sepolia',
	43113: 'avax-fuji',
	80002: 'polygon-amoy',
	11155111: 'eth-sepolia',
	11155420: 'opt-sepolia',
};

/**
 * Keyless Solana rung: read the Metaplex metadata account over the platform's
 * ordinary RPC failover chain and follow its `uri`.
 *
 * Helius DAS is metered, and on 2026-08-14 the account was capped ("max usage
 * reached" on every getAsset), which took this endpoint to a blanket 502 with
 * no way back. An NFT's metadata is public data on a public chain: nothing about
 * reading it requires a billed indexer. This rung is slower (an account read
 * plus a document fetch instead of one indexed call), so it runs only after DAS
 * has failed.
 *
 * @returns {Promise<object|null>} the resolved descriptor, or null when the
 *   token exists but names no metadata document.
 */
async function resolveSolanaOnChain(id) {
	const meta = await fetchTokenMeta(id, { includeImage: false });
	const doc = meta.raw;
	if (!doc && !meta.name) return null;
	const { model, mime } = pickModel(doc);
	return {
		name: meta.name || id,
		image: resolveGateway(meta.imageUrl) || null,
		model: model || null,
		mime: mime || null,
		source: 'solana-rpc',
	};
}

// ERC-721 and ERC-1155 both expose the metadata pointer, under different names.
// Probing tokenURI first matches the far more common standard for 3D collectibles.
const NFT_URI_ABI = [
	'function tokenURI(uint256 tokenId) view returns (string)',
	'function uri(uint256 id) view returns (string)',
	'function name() view returns (string)',
];

/**
 * Keyless EVM rung: read the token's own metadata pointer through the chain's
 * RPC failover list, for the same reason as the Solana rung above (Alchemy
 * answered "Monthly capacity limit exceeded" on every getNFTMetadata call).
 *
 * @returns {Promise<object|null>} the resolved descriptor, or null when neither
 *   metadata interface answers.
 */
async function resolveEvmOnChain(chainId, contractAddress, tokenId) {
	const { Contract } = await import('ethers');
	const provider = await evmFallbackProvider(chainId);
	const contract = new Contract(contractAddress, NFT_URI_ABI, provider);

	let uri = null;
	for (const method of ['tokenURI', 'uri']) {
		try {
			uri = await contract[method](tokenId);
			if (uri) break;
		} catch {
			uri = null;
		}
	}
	if (!uri) return null;

	// ERC-1155 metadata URIs carry a literal {id} placeholder the client must
	// substitute with the zero-padded 64-hex token id.
	if (uri.includes('{id}')) {
		uri = uri.replace('{id}', BigInt(tokenId).toString(16).padStart(64, '0'));
	}

	const doc = await fetchMetadataDoc(uri);
	if (!doc) return null;
	const { model, mime } = pickModel(doc);
	let collection = null;
	try {
		collection = await contract.name();
	} catch {
		collection = null;
	}
	return {
		name: doc.name || collection || `${contractAddress}:${tokenId}`,
		image: resolveGateway(doc.image || doc.image_url) || null,
		model: model || null,
		mime: mime || null,
		source: 'evm-rpc',
	};
}

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
	// Indexer unusable (unreachable, capped, or misconfigured) → in order: read the
	// chain directly, then serve the last-known-good descriptor, then surface the
	// caller's error. The direct read comes first because it is authoritative and
	// current; the stale tier is safe only because metadata is effectively
	// immutable, so it is the second choice, not the first.
	const rescue = async (onChain, onMiss) => {
		try {
			const direct = await onChain();
			if (direct) return json(res, 200, await store(direct));
		} catch (err) {
			if (err?.code === 'mint_not_found' || err?.code === 'invalid_mint') {
				return error(res, err.status === 400 ? 400 : 404, err.status === 400 ? 'bad_request' : 'not_found', err.message);
			}
			console.error('[nft/resolve] direct chain read failed', err?.message);
		}
		const lastGood = await cacheGet(staleKey).catch(() => null);
		if (lastGood) {
			console.warn('[nft/resolve] upstream unreachable, serving last-known-good for %s', cacheKey);
			return json(res, 200, { ...lastGood, stale: true });
		}
		return onMiss();
	};

	if (chain === 'solana') {
		const solanaRescue = (onMiss) => rescue(() => resolveSolanaOnChain(id), onMiss);

		// `getAsset` is a DAS method, and Helius is the only provider in our stack
		// that serves it. Reading SOLANA_RPC_URL here pointed the call at whatever
		// general-purpose RPC was configured (production runs magicblock), which
		// answers a JSON-RPC -32601 that the code below then reported to the user as
		// "Asset not found": a real, resolvable NFT read as nonexistent. dasRpcUrl()
		// is the same resolver api/_lib/nft-gate.js gates on, and prefers the
		// dedicated HELIUS_API_KEY.
		const rpcUrl = dasRpcUrl();
		if (!rpcUrl) {
			return solanaRescue(() =>
				error(
					res,
					503,
					'not_configured',
					'HELIUS_API_KEY not configured and the token names no readable metadata',
				),
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
			return solanaRescue(() =>
				serverError(res, 502, 'upstream_error', new Error('Helius unreachable')),
			);
		}
		if (!resp.ok) {
			const txt = await resp.text().catch(() => '');
			console.error('[nft/resolve] Helius error', resp.status, txt);
			return solanaRescue(() =>
				serverError(res, 502, 'upstream_error', new Error(`Helius error ${resp.status}`)),
			);
		}
		const data = await readJsonBody(resp);
		if (!data) {
			console.error('[nft/resolve] Helius returned a non-JSON body');
			return solanaRescue(() =>
				serverError(res, 502, 'upstream_error', new Error('Helius returned a non-JSON body')),
			);
		}
		if (data.error) {
			const msg = data.error.message || JSON.stringify(data.error);
			// -32601 is "the endpoint does not implement this method", an operator
			// misconfiguration. Only a real DAS miss is a 404.
			if (data.error.code === -32601) {
				console.error('[nft/resolve] configured RPC does not serve DAS getAsset');
				return solanaRescue(() =>
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
	// Both the Alchemy call and the on-chain rung take these verbatim, so reject a
	// malformed pair here rather than paying an upstream round-trip to be told.
	if (!/^0x[0-9a-fA-F]{40}$/.test(contractAddress)) {
		return error(res, 400, 'bad_request', 'evm contract must be a 0x-prefixed 20-byte address');
	}
	if (!/^(0x[0-9a-fA-F]+|\d+)$/.test(tokenId)) {
		return error(res, 400, 'bad_request', 'evm tokenId must be decimal or 0x-hex');
	}

	const evmRescue = (onMiss) =>
		rescue(() => resolveEvmOnChain(chainId, contractAddress, tokenId), onMiss);

	// `env` exposes no ALCHEMY getter, so the previous `env.ALCHEMY_API_KEY` read
	// was undefined in every environment: the whole EVM branch built a URL with a
	// literal "undefined" key and answered 502 on a 401 from Alchemy, configured
	// or not. Read the raw var (the same way collectibles.js, balances.js and
	// scene/gate-check.js do) and say plainly when it is missing.
	const apiKey = process.env.ALCHEMY_API_KEY;
	if (!apiKey) {
		return evmRescue(() =>
			error(
				res,
				503,
				'not_configured',
				'ALCHEMY_API_KEY not configured and the token names no readable metadata',
			),
		);
	}
	const url = `https://${host}.g.alchemy.com/nft/v3/${apiKey}/getNFTMetadata?contractAddress=${encodeURIComponent(contractAddress)}&tokenId=${encodeURIComponent(tokenId)}`;
	let resp;
	try {
		resp = await fetch(url, { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
	} catch (err) {
		console.error('[nft/resolve] Alchemy network error', err?.message);
		return evmRescue(() =>
			serverError(res, 502, 'upstream_error', new Error('Alchemy unreachable')),
		);
	}
	if (!resp.ok) {
		const txt = await resp.text().catch(() => '');
		if (resp.status === 404) {
			return error(res, 404, 'not_found', `Alchemy error ${resp.status}: ${txt}`);
		}
		console.error('[nft/resolve] Alchemy error', resp.status, txt);
		return evmRescue(() =>
			serverError(res, 502, 'upstream_error', new Error(`Alchemy error ${resp.status}`)),
		);
	}
	const data = await readJsonBody(resp);
	if (!data) {
		console.error('[nft/resolve] Alchemy returned a non-JSON body');
		return evmRescue(() =>
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
