// Shared helpers for the x402 pay-per-call pump.fun launcher
// (api/x402/pump-launch.js).
//
// The buyer pays USDC through the 402 challenge; a single server-held keypair
// (env.PUMP_X402_LAUNCHER_SECRET_KEY_B64) fronts the ~0.022 SOL deploy cost and
// signs the create-coin transaction. The buyer never needs SOL or a three.ws
// account — they hand us metadata, we mint the token, and (by default) assign
// pump.fun creator rewards to a wallet they nominate.
//
// Three pieces live here so the route file stays declarative:
//   • loadLauncherKeypair()  — decode + validate the funded server keypair.
//   • uploadPumpMetadata()   — pin image + descriptor to pump.fun's IPFS.
//   • launchPumpToken()      — grind the mint (optional vanity), build the
//                              create-only instruction, send + confirm.

import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { env } from './env.js';
import { solanaConnection } from './agent-pumpfun.js';
import { grindMintKeypair } from './pump-vanity.js';

const PUMP_IPFS_ENDPOINT = 'https://pump.fun/api/ipfs';

// Image guardrails for the upload path. pump.fun renders square images up to a
// few hundred KB; we cap fetch size so a hostile imageUrl can't exhaust the
// lambda, and only allow the formats pump.fun's CDN actually serves.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED_IMAGE_MIME = new Set([
	'image/png',
	'image/jpeg',
	'image/gif',
	'image/webp',
]);

function launchError(status, code, message) {
	return Object.assign(new Error(message), { status, code });
}

/**
 * Decode the funded launcher keypair from env. Throws a 503 when unconfigured
 * so the route can surface a clean "not_configured" instead of a 500.
 *
 * @returns {Keypair}
 */
export function loadLauncherKeypair() {
	const b64 = env.PUMP_X402_LAUNCHER_SECRET_KEY_B64;
	if (!b64) {
		throw launchError(
			503,
			'not_configured',
			'pump.fun launcher is not configured (PUMP_X402_LAUNCHER_SECRET_KEY_B64 unset)',
		);
	}
	let secret;
	try {
		secret = Buffer.from(b64, 'base64');
	} catch {
		throw launchError(500, 'misconfigured', 'launcher secret is not valid base64');
	}
	if (secret.length !== 64) {
		throw launchError(
			500,
			'misconfigured',
			`launcher secret must decode to 64 bytes, got ${secret.length}`,
		);
	}
	try {
		return Keypair.fromSecretKey(new Uint8Array(secret));
	} catch {
		throw launchError(500, 'misconfigured', 'launcher secret is not a valid ed25519 keypair');
	}
}

/**
 * Fetch an image by URL and pin it + a token descriptor to pump.fun's IPFS,
 * returning the metadataUri a create-coin tx points at.
 *
 * @param {object} opts
 * @param {string} opts.imageUrl    — https URL of the token image to pin.
 * @param {string} [opts.name]
 * @param {string} [opts.symbol]
 * @param {string} [opts.description]
 * @param {string} [opts.twitter]
 * @param {string} [opts.telegram]
 * @param {string} [opts.website]
 * @param {boolean} [opts.showName]
 * @returns {Promise<{ metadataUri: string, image: string|null }>}
 */
export async function uploadPumpMetadata({
	imageUrl,
	name = '',
	symbol = '',
	description = '',
	twitter = '',
	telegram = '',
	website = '',
	showName = true,
}) {
	let parsed;
	try {
		parsed = new URL(imageUrl);
	} catch {
		throw launchError(400, 'invalid_image_url', 'imageUrl is not a valid URL');
	}
	if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
		throw launchError(400, 'invalid_image_url', 'imageUrl must be http(s)');
	}

	let imgRes;
	try {
		imgRes = await fetch(parsed, { redirect: 'follow' });
	} catch (err) {
		throw launchError(502, 'image_fetch_failed', `could not fetch imageUrl: ${err.message}`);
	}
	if (!imgRes.ok) {
		throw launchError(502, 'image_fetch_failed', `imageUrl returned ${imgRes.status}`);
	}
	const mime = (imgRes.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
	if (!ALLOWED_IMAGE_MIME.has(mime)) {
		throw launchError(
			400,
			'unsupported_image',
			`imageUrl content-type "${mime || 'unknown'}" not supported (png, jpeg, gif, webp)`,
		);
	}
	const bytes = Buffer.from(await imgRes.arrayBuffer());
	if (bytes.length === 0) {
		throw launchError(400, 'empty_image', 'imageUrl returned an empty body');
	}
	if (bytes.length > MAX_IMAGE_BYTES) {
		throw launchError(
			413,
			'image_too_large',
			`image is ${bytes.length} bytes, max ${MAX_IMAGE_BYTES}`,
		);
	}

	const ext = mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1] || 'png';
	const form = new FormData();
	form.append('file', new Blob([bytes], { type: mime }), `image.${ext}`);
	form.append('name', name);
	form.append('symbol', symbol);
	form.append('description', description);
	form.append('twitter', twitter);
	form.append('telegram', telegram);
	form.append('website', website);
	form.append('showName', showName ? 'true' : 'false');

	let pinRes;
	try {
		pinRes = await fetch(PUMP_IPFS_ENDPOINT, { method: 'POST', body: form });
	} catch (err) {
		throw launchError(502, 'ipfs_upload_failed', `pump.fun IPFS upload failed: ${err.message}`);
	}
	if (!pinRes.ok) {
		const detail = await pinRes.text().catch(() => '');
		throw launchError(
			502,
			'ipfs_upload_failed',
			`pump.fun IPFS upload returned ${pinRes.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`,
		);
	}
	const out = await pinRes.json().catch(() => null);
	const metadataUri = out?.metadataUri || out?.metadata_uri || out?.uri;
	if (!metadataUri) {
		throw launchError(502, 'ipfs_upload_failed', 'pump.fun IPFS response had no metadataUri');
	}
	return { metadataUri, image: out?.metadata?.image || out?.image || null };
}

/**
 * Create a pump.fun token (bonding-curve only — no dev buy) signed + paid by
 * the launcher keypair. Optionally grinds a vanity mint address.
 *
 * @param {object} opts
 * @param {Keypair} opts.launcher       — funded server keypair (payer + user).
 * @param {string}  opts.name
 * @param {string}  opts.symbol
 * @param {string}  opts.uri            — metadataUri.
 * @param {string}  [opts.creator]      — base58 pubkey to receive creator
 *                                        rewards; defaults to the launcher.
 * @param {string}  [opts.vanityPrefix]
 * @param {string}  [opts.vanitySuffix]
 * @param {boolean} [opts.vanityIgnoreCase]
 * @param {('mainnet'|'devnet')} [opts.network]
 * @returns {Promise<{ mint:string, signature:string, creator:string,
 *                      vanityIterations:number, vanityDurationMs:number }>}
 */
export async function launchPumpToken({
	launcher,
	name,
	symbol,
	uri,
	creator,
	vanityPrefix,
	vanitySuffix,
	vanityIgnoreCase = false,
	network = 'mainnet',
}) {
	let creatorPk;
	if (creator) {
		try {
			creatorPk = new PublicKey(creator);
		} catch {
			throw launchError(400, 'invalid_creator', 'creator is not a valid Solana pubkey');
		}
	} else {
		creatorPk = launcher.publicKey;
	}

	const { keypair: mint, iterations: vanityIterations, durationMs: vanityDurationMs } =
		await grindMintKeypair({
			prefix: vanityPrefix,
			suffix: vanitySuffix,
			ignoreCase: vanityIgnoreCase,
		});

	const { PumpSdk } = await import('@pump-fun/pump-sdk');
	const sdk = new PumpSdk();
	const conn = solanaConnection(network);

	let instructions;
	try {
		const ix = await sdk.createV2Instruction({
			mint: mint.publicKey,
			name,
			symbol,
			uri,
			creator: creatorPk,
			user: launcher.publicKey,
			mayhemMode: false,
		});
		instructions = Array.isArray(ix) ? ix : [ix];
	} catch (err) {
		throw launchError(422, 'build_failed', err.message || 'could not build create instruction');
	}

	const tx = new Transaction().add(...instructions);
	tx.feePayer = launcher.publicKey;
	const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
	tx.recentBlockhash = blockhash;
	tx.sign(launcher, mint);

	let signature;
	try {
		signature = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
		await conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
	} catch (err) {
		throw launchError(502, 'rpc_error', err.message || 'create-coin transaction failed');
	}

	return {
		mint: mint.publicKey.toBase58(),
		signature,
		creator: creatorPk.toBase58(),
		vanityIterations,
		vanityDurationMs,
	};
}
