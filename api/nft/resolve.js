import { env } from '../_lib/env.js';
import { wrap, cors, error, json, readJson, method } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';

export default wrap(async (req, res) => {
	if (cors(req, res)) return;
	if (!method(req, res, ['POST'])) return;

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const body = await readJson(req);
	const chain = String(body.chain || '').toLowerCase();
	const id = String(body.id || '').trim();

	if (!['solana', 'evm'].includes(chain)) {
		return error(res, 400, 'bad_request', 'chain must be solana or evm');
	}
	if (!id) return error(res, 400, 'bad_request', 'id required');

	if (chain === 'solana') {
		const resp = await fetch(env.SOLANA_RPC_URL, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAsset', params: { id } }),
		});
		if (!resp.ok) {
			const txt = await resp.text();
			return error(res, 502, 'upstream_error', `Helius error ${resp.status}: ${txt}`);
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
		return json(res, 200, {
			name,
			image: imageUrl,
			model: modelFile?.uri || null,
			mime: modelFile?.mime || null,
			source: 'helius',
		});
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
	const resp = await fetch(url);
	if (!resp.ok) {
		const txt = await resp.text();
		return error(res, resp.status === 404 ? 404 : 502, resp.status === 404 ? 'not_found' : 'upstream_error', `Alchemy error ${resp.status}: ${txt}`);
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

	return json(res, 200, { name, image: imageUrl, model, mime, source: 'alchemy' });
});
