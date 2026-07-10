import { env } from '../_lib/env.js';
import { wrap, cors, error, json, readJson, method, rateLimited, serverError } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { cacheGet, cacheSet } from '../_lib/cache.js';

// NFT metadata is effectively immutable, but the Helius `getAsset` (DAS) and
// Alchemy `getNFTMetadata` calls behind this endpoint are billed per request and
// were re-resolved on every call — a bot re-requesting the same mint paid the
// upstream every time. Cache the resolved descriptor by chain:id so a given
// asset is fetched from the provider at most once per TTL.
const RESOLVE_TTL_SECONDS = 6 * 60 * 60; // 6h
// Last-known-good copy kept far longer, read ONLY when the upstream provider is
// unreachable. NFT metadata is effectively immutable, so serving a long-stale
// descriptor during a Helius/Alchemy outage is correct — far better than a 502.
const RESOLVE_STALE_TTL_SECONDS = 30 * 24 * 60 * 60; // 30d

export default wrap(async (req, res) => {
	if (cors(req, res)) return;
	if (!method(req, res, ['POST'])) return;

	const rl = await limits.authedReadIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const body = await readJson(req);
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

	// Only a cache MISS reaches the billed upstream — gate that on the shared DAS
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
			console.warn('[nft/resolve] upstream unreachable — serving last-known-good for %s', cacheKey);
			return json(res, 200, { ...lastGood, stale: true });
		}
		return onMiss();
	};

	if (chain === 'solana') {
		let resp;
		try {
			resp = await fetch(env.SOLANA_RPC_URL, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAsset', params: { id } }),
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
		const data = await resp.json();
		if (data.error) {
			const msg = data.error.message || JSON.stringify(data.error);
			return error(res, 404, 'not_found', `Asset not found: ${msg}`);
		}
		const asset = data.result;
		const name = asset?.content?.metadata?.name || asset?.id || id;
		const files = asset?.content?.files || [];
		const modelFile = files.find((f) => f.mime && f.mime.startsWith('model/'));
		const imageUrl =
			asset?.content?.links?.image ||
			files.find((f) => f.mime && f.mime.startsWith('image/'))?.uri ||
			null;
		const result = await store({
			name,
			image: imageUrl,
			model: modelFile?.uri || null,
			mime: modelFile?.mime || null,
			source: 'helius',
		});
		return json(res, 200, result);
	}

	// EVM: id is "contract:tokenId" or "chainId:contract:tokenId"
	const parts = id.split(':');
	let contractAddress, tokenId;
	if (parts.length === 2) {
		[contractAddress, tokenId] = parts;
	} else if (parts.length === 3) {
		[, contractAddress, tokenId] = parts;
	} else {
		return error(res, 400, 'bad_request', 'evm id must be "contract:tokenId" or "chainId:contract:tokenId"');
	}

	const apiKey = env.ALCHEMY_API_KEY;
	const url = `https://eth-mainnet.g.alchemy.com/nft/v3/${apiKey}/getNFTMetadata?contractAddress=${encodeURIComponent(contractAddress)}&tokenId=${encodeURIComponent(tokenId)}`;
	let resp;
	try {
		resp = await fetch(url);
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
	const data = await resp.json();
	const name = data.name || data.contract?.name || id;
	const animationUrl = data.raw?.metadata?.animation_url || null;
	const imageUrl = data.image?.cachedUrl || data.media?.[0]?.gateway || null;

	// animation_url may be a glTF/GLB
	let model = null;
	let mime = null;
	if (animationUrl && /\.(glb|gltf)(\?|$)/i.test(animationUrl)) {
		model = animationUrl;
		mime = animationUrl.toLowerCase().endsWith('.gltf') ? 'model/gltf+json' : 'model/gltf-binary';
	}

	const result = await store({ name, image: imageUrl, model, mime, source: 'alchemy' });
	return json(res, 200, result);
});
