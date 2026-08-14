import { env } from '../_lib/env.js';
import { wrap, cors, error, json, readJson, method, rateLimited, respondError } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { mplCore, createV1 } from '@metaplex-foundation/mpl-core';
import { solanaConnection } from '../_lib/solana/connection.js';
import { pinToIPFS, ipfsPinningConfigured } from '../_lib/ipfs-pin.js';
import {
	generateSigner,
	publicKey as umiPublicKey,
	signerIdentity,
	createNoopSigner,
} from '@metaplex-foundation/umi';

// Pin through the platform's shared IPFS transport rather than a second,
// hand-rolled uploader. The old path posted to NFT.Storage on NFT_STORAGE_TOKEN,
// a variable set in no environment (not .env, not .env.local, not the Cloud Run
// service), so every scene mint answered 503 not_configured before it read a
// byte of the body. api/_lib/ipfs-pin.js is the same Pinata/web3.storage chain
// the pump launch lane and the pinning API already run on, and Pinata IS
// configured in production, so this is what makes the endpoint work at all.
//
// A pinned uri is the public gateway URL, not an ipfs:// pointer: wallets,
// marketplaces, and our own chat NFT viewer all fetch it directly, and the
// viewer hands the model URL straight to GLTFLoader, which cannot resolve
// ipfs://.
async function pinAsset(bytes, filename) {
	const pinned = await pinToIPFS(bytes, filename);
	if (!pinned) {
		throw Object.assign(new Error('no IPFS pinning provider configured'), {
			status: 503,
			code: 'not_configured',
		});
	}
	return pinned.uri;
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

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	// The pins below run on the platform's own pinning account, never let an
	// anonymous caller push arbitrary blobs to IPFS on it.
	const session = await getSessionUser(req);
	const bearer = session ? null : await authenticateBearer(extractBearer(req));
	if (!session && !bearer) {
		return error(res, 401, 'unauthorized', 'sign in or provide a valid bearer token');
	}

	// Auth first, then configuration. This check used to run ahead of both the
	// rate limiter and the auth gate, so an anonymous caller was told the exact
	// deployment secret the platform is missing (503 "set PINATA_JWT") and got
	// there without spending a rate-limit token. A signed-in minter is who this
	// message is for.
	if (!ipfsPinningConfigured())
		return error(res, 503, 'not_configured', 'no IPFS pinning provider configured (set PINATA_JWT)');

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

	const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'scene';

	let glbUri, thumbUri;
	try {
		[glbUri, thumbUri] = await Promise.all([
			pinAsset(glbBytes, `${slug}.glb`),
			pinAsset(thumbBytes, `${slug}.png`),
		]);
	} catch (e) {
		console.error('[nft/mint-scene] asset pin failed', e?.message);
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
		metadataUri = await pinAsset(Buffer.from(JSON.stringify(metadata)), `${slug}.json`);
	} catch (e) {
		console.error('[nft/mint-scene] metadata pin failed', e?.message);
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
