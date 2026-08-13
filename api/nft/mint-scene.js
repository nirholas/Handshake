import { env } from '../_lib/env.js';
import { wrap, cors, error, json, readJson, method, rateLimited, respondError } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { mplCore, createV1 } from '@metaplex-foundation/mpl-core';
import { solanaConnection } from '../_lib/solana/connection.js';
import {
	generateSigner,
	publicKey as umiPublicKey,
	signerIdentity,
	createNoopSigner,
} from '@metaplex-foundation/umi';

async function uploadToNftStorage(token, bytes, contentType) {
	const resp = await fetch('https://api.nft.storage/upload', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': contentType,
		},
		body: bytes,
	});
	if (!resp.ok) {
		const txt = await resp.text();
		throw Object.assign(new Error(`NFT.Storage upload failed (${resp.status}): ${txt}`), {
			status: 502,
			code: 'upstream_error',
		});
	}
	const data = await resp.json();
	return `ipfs://${data.value.cid}`;
}

// Strict base64: the scene GLB and its thumbnail arrive base64-encoded, and
// Buffer.from(x, 'base64') never throws. It silently drops every character
// outside the alphabet, so a truncated or accidentally-URL-encoded upload used
// to sail through as a shorter, corrupt buffer that we then pinned to IPFS on
// the platform's own storage token and referenced from a real mint.
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function decodeBase64(value) {
	const compact = value.replace(/\s+/g, '');
	if (!compact || compact.length % 4 !== 0 || !BASE64_RE.test(compact)) return null;
	return Buffer.from(compact, 'base64');
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const storageToken = env.NFT_STORAGE_TOKEN;
	if (!storageToken) return error(res, 503, 'not_configured', 'NFT_STORAGE_TOKEN not configured');

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	// The uploads below run on the platform's NFT.Storage token, never let an
	// anonymous caller push arbitrary blobs to IPFS on our account.
	const session = await getSessionUser(req);
	const bearer = session ? null : await authenticateBearer(extractBearer(req));
	if (!session && !bearer) {
		return error(res, 401, 'unauthorized', 'sign in or provide a valid bearer token');
	}

	// A scene GLB plus its PNG thumbnail, base64-inflated by 4/3, comfortably
	// clears readJson's 1 MB default, which rejected every real mint with a 413
	// before the handler saw a byte. 8 MB matches server/index.mjs BODY_LIMIT, the
	// ceiling express enforces ahead of us anyway.
	const body = await readJson(req, 8 * 1024 * 1024);
	const { ownerPubkey, glbBase64, thumbnailBase64, name, description } = body || {};

	if (!ownerPubkey || typeof ownerPubkey !== 'string')
		return error(res, 400, 'validation_error', 'ownerPubkey required');
	if (!glbBase64 || typeof glbBase64 !== 'string')
		return error(res, 400, 'validation_error', 'glbBase64 required');
	if (!thumbnailBase64 || typeof thumbnailBase64 !== 'string')
		return error(res, 400, 'validation_error', 'thumbnailBase64 required');
	if (!name || typeof name !== 'string' || !name.trim())
		return error(res, 400, 'validation_error', 'name required');

	const glbBytes = decodeBase64(glbBase64);
	if (!glbBytes) return error(res, 400, 'validation_error', 'glbBase64 is not valid base64');
	const thumbBytes = decodeBase64(thumbnailBase64);
	if (!thumbBytes) return error(res, 400, 'validation_error', 'thumbnailBase64 is not valid base64');

	// Resolve the owner key BEFORE anything is pinned. It used to be parsed only
	// after all three IPFS uploads, so a typo'd pubkey burned three writes on the
	// platform's storage token and then answered 400 anyway.
	const rpcUrl = env.SOLANA_RPC_URL;
	const umi = createUmi(solanaConnection({ url: rpcUrl })).use(mplCore());

	let ownerPk;
	try {
		ownerPk = umiPublicKey(ownerPubkey);
	} catch {
		return error(res, 400, 'validation_error', 'invalid ownerPubkey');
	}

	let glbUri, thumbUri;
	try {
		[glbUri, thumbUri] = await Promise.all([
			uploadToNftStorage(storageToken, glbBytes, 'model/gltf-binary'),
			uploadToNftStorage(storageToken, thumbBytes, 'image/png'),
		]);
	} catch (e) {
		console.error('[nft/mint-scene] asset upload failed', e?.message);
		return respondError(res, e.status || 502, e.code || 'upstream_error', e);
	}

	const metadata = {
		name: name.trim(),
		description: (description || '').trim(),
		image: thumbUri,
		animation_url: glbUri,
		properties: {
			files: [
				{ uri: glbUri, type: 'model/gltf-binary' },
				{ uri: thumbUri, type: 'image/png' },
			],
			category: '3d',
		},
	};

	let metadataUri;
	try {
		metadataUri = await uploadToNftStorage(
			storageToken,
			Buffer.from(JSON.stringify(metadata)),
			'application/json',
		);
	} catch (e) {
		console.error('[nft/mint-scene] metadata upload failed', e?.message);
		return respondError(res, e.status || 502, e.code || 'upstream_error', e);
	}

	// The umi instance above uses the failover Connection rather than a bare URL:
	// the mint's getLatestBlockhash and account reads rotate across the endpoint
	// chain, so a single node's malformed/empty 200 body fails over instead of
	// throwing the StructError crash.
	umi.use(signerIdentity(createNoopSigner(ownerPk)));
	const assetSigner = generateSigner(umi);

	const builder = createV1(umi, {
		asset: assetSigner,
		owner: ownerPk,
		name: name.trim(),
		uri: metadataUri,
	});

	// buildAndSign resolves to a umi Transaction object ({message, signatures,
	// serializedMessage}), NOT wire bytes. Handing that straight to Buffer.from
	// threw "The first argument must be of type string or an instance of Buffer,
	// ArrayBuffer, or Array" on every otherwise-successful mint, after the three
	// IPFS uploads had already been paid for. umi.transactions.serialize is the
	// wire encoder, and is what the sibling mint paths
	// (api/agents/onchain/[action].js, api/agents/solana/_handlers.js) use.
	const tx = await builder.buildAndSign(umi);
	const unsignedTxBase64 = Buffer.from(umi.transactions.serialize(tx)).toString('base64');
	const mint = assetSigner.publicKey.toString();

	return json(res, 200, { unsignedTxBase64, metadataUri, mint });
});
