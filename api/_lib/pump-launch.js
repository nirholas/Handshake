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

import { Keypair, PublicKey } from '@solana/web3.js';
import { env } from './env.js';
import { solanaConnection } from './agent-pumpfun.js';
import { submitProtected } from './execution-engine.js';
import { grindMintKeypair } from './pump-vanity.js';
import { fetchSafePublicUrlPinned, SsrfBlockedError } from './ssrf-guard.js';
import {
	claimMatchingPattern,
	peekReservedSecret,
	releaseReservation,
	reserveAndReveal,
	isDbUnavailableError,
} from './vanity-inventory-store.js';
import { openSecret } from './vanity-vault.js';

import { fetchUpstream } from './upstream-fetch.js';
import { pinToIPFS, pinJsonToIPFS, ipfsPinningConfigured } from './ipfs-pin.js';

const PUMP_IPFS_ENDPOINT = 'https://pump.fun/api/ipfs';
// pump.fun's pinning endpoint is a third party we cannot fail over inside; a
// stalled socket there used to hold the launch until Cloud Run killed it.
const PUMP_IPFS_TIMEOUT_MS = 30_000;

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
	let imgRes;
	try {
		imgRes = await fetchSafePublicUrlPinned(imageUrl, {}, { allowHttp: false });
	} catch (err) {
		if (err instanceof SsrfBlockedError) {
			throw launchError(400, 'invalid_image_url', `imageUrl blocked: ${err.message}`);
		}
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

	let pinRes = null;
	let pumpFailure = null;
	try {
		pinRes = await fetchUpstream(
			PUMP_IPFS_ENDPOINT,
			{ method: 'POST', body: form },
			{ name: 'pump-ipfs', timeoutMs: PUMP_IPFS_TIMEOUT_MS, attempts: 2, okWhen: () => true },
		);
	} catch (err) {
		pumpFailure = `pump.fun IPFS upload failed: ${err.message}`;
	}
	if (pinRes && !pinRes.ok) {
		const detail = await pinRes.text().catch(() => '');
		pumpFailure = `pump.fun IPFS upload returned ${pinRes.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`;
	}
	let out = null;
	if (!pumpFailure) {
		out = await pinRes.json().catch(() => null);
		if (!(out?.metadataUri || out?.metadata_uri || out?.uri)) {
			pumpFailure = 'pump.fun IPFS response had no metadataUri';
		}
	}
	if (pumpFailure) {
		return pinMetadataViaProviderChain({
			bytes,
			mime,
			ext,
			name,
			symbol,
			description,
			twitter,
			telegram,
			website,
			showName,
			pumpFailure,
		});
	}
	const metadataUri = out.metadataUri || out.metadata_uri || out.uri;
	return { metadataUri, image: out?.metadata?.image || out?.image || null };
}

/**
 * Fallback for uploadPumpMetadata when pump.fun's own IPFS endpoint is down:
 * pin the image and then a pump.fun-shaped metadata document through the
 * platform's provider chain (api/_lib/ipfs-pin.js: Pinata, then web3.storage).
 * The returned gateway URI is consumed exactly like pump's `metadataUri`: it
 * becomes the on-chain `uri` of the create instruction, and wallets resolve
 * it to the same {name, symbol, description, image, ...} document pump's
 * frontend writes.
 */
async function pinMetadataViaProviderChain({
	bytes,
	mime,
	ext,
	name,
	symbol,
	description,
	twitter,
	telegram,
	website,
	showName,
	pumpFailure,
}) {
	if (!ipfsPinningConfigured()) {
		throw launchError(502, 'ipfs_upload_failed', `${pumpFailure}; no fallback IPFS provider is configured`);
	}
	console.warn(`[pump-launch] ${pumpFailure}; pinning metadata through the provider chain instead`);
	let image;
	let metadata;
	try {
		image = await pinToIPFS(bytes, `image.${ext}`);
		const doc = {
			name,
			symbol,
			description,
			image: image.uri,
			showName: Boolean(showName),
			createdOn: 'https://pump.fun',
		};
		if (twitter) doc.twitter = twitter;
		if (telegram) doc.telegram = telegram;
		if (website) doc.website = website;
		metadata = await pinJsonToIPFS(doc, 'metadata.json');
	} catch (err) {
		throw launchError(502, 'ipfs_upload_failed', `${pumpFailure}; fallback IPFS pin failed: ${err.message}`);
	}
	return { metadataUri: metadata.uri, image: image.uri, mime, provider: metadata.provider };
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
 * @param {Keypair} [opts.mintKeypair]     pre-resolved mint (e.g. claimed from
 *                                         inventory) — skips grinding entirely
 *                                         when supplied.
 * @param {('mainnet'|'devnet')} [opts.network]
 * @returns {Promise<{ mint:string, signature:string, creator:string,
 *                      vanityIterations:number, vanityDurationMs:number,
 *                      vanitySource:('inventory'|'ground'|null) }>}
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
	mintKeypair = null,
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

	let mint, vanityIterations, vanityDurationMs, vanitySource;
	if (mintKeypair) {
		// Instant path: a pre-ground address from vanity inventory already
		// matches the requested pattern — no grinding needed.
		mint = mintKeypair;
		vanityIterations = 0;
		vanityDurationMs = 0;
		vanitySource = 'inventory';
	} else {
		({ keypair: mint, iterations: vanityIterations, durationMs: vanityDurationMs } =
			await grindMintKeypair({
				prefix: vanityPrefix,
				suffix: vanitySuffix,
				ignoreCase: vanityIgnoreCase,
			}));
		vanitySource = vanityPrefix || vanitySuffix ? 'ground' : null;
	}

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

	let signature;
	try {
		// Protected send: the launcher pays + signs, the new mint co-signs. Priority
		// fee + CU estimate, rebroadcast with blockhash refresh, hard throw on revert.
		({ signature } = await submitProtected({
			network,
			connection: conn,
			payer: launcher,
			instructions,
			opts: { extraSigners: [mint] },
		}));
	} catch (err) {
		throw launchError(502, 'rpc_error', err.message || 'create-coin transaction failed');
	}

	return {
		mint: mint.publicKey.toBase58(),
		signature,
		creator: creatorPk.toBase58(),
		vanityIterations,
		vanityDurationMs,
		vanitySource,
	};
}

/**
 * Instant vanity-mint upsell: try to fulfill a vanityPrefix/vanitySuffix
 * request for pump-launch from the pre-ground inventory instead of grinding
 * live. Shares the exact same atomic claim + single-use reveal path premium
 * buys use (api/_lib/vanity-inventory-store.js) — a hit is reserved,
 * decrypted, and (once the caller has actually used the key to launch the
 * token — i.e. it's committed on-chain no matter what) revealed and
 * destroyed so it can never be handed out again. No price ceiling is applied
 * here (unlike vanity.js's live-grind tier): pump-launch already charges one
 * flat fee regardless of how hard the requested vanity pattern is to grind,
 * so serving from inventory is strictly cheaper for the server and no worse
 * for the buyer than the live grind it replaces.
 *
 * Returns null on any miss or failure — DB down, no match, decrypt error —
 * so the caller falls straight through to launchPumpToken()'s live grind,
 * unchanged.
 *
 * @param {object} opts
 * @param {string} [opts.prefix]
 * @param {string} [opts.suffix]
 * @param {boolean} [opts.ignoreCase]
 * @param {string} opts.paymentId  unique per launch attempt (any locally
 *                                 unique string — only used to correlate this
 *                                 claim's reserve → decrypt → reveal steps).
 * @param {string} [opts.purchaser]
 * @returns {Promise<{ mintKeypair:Keypair, address:string, reveal:Function, release:Function } | null>}
 */
export async function claimVanityMintFromInventory({ prefix, suffix, ignoreCase = false, paymentId, purchaser }) {
	if ((!prefix && !suffix) || !paymentId) return null;

	let claim;
	try {
		claim = await claimMatchingPattern({ prefix, suffix, ignoreCase, format: 'keypair', paymentId, purchaser });
	} catch (err) {
		if (!isDbUnavailableError(err)) {
			console.error('[pump-launch] inventory claim lookup failed; falling back to grind', err?.message || err);
		}
		return null;
	}
	if (!claim.ok) return null;

	const item = claim.item;
	try {
		const peek = await peekReservedSecret(item.address, { paymentId });
		if (!peek.ok) throw new Error(peek.reason);
		const bundle = JSON.parse(await openSecret(peek.ciphertext, peek.scheme));
		const mintKeypair = Keypair.fromSecretKey(Uint8Array.from(bundle.secretKey));
		if (mintKeypair.publicKey.toBase58() !== item.address) {
			throw new Error('decrypted key does not match the claimed inventory address');
		}
		return {
			mintKeypair,
			address: item.address,
			// The caller invokes these AFTER using (or failing to use) the key,
			// so the reservation is only ever finalized once the outcome is known.
			reveal: () => reserveAndReveal(item.address, { paymentId }),
			release: () => releaseReservation(item.address, { paymentId }),
		};
	} catch (err) {
		console.error('[pump-launch] inventory decrypt failed; releasing + falling back to grind', err?.message || err);
		await releaseReservation(item.address, { paymentId }).catch(() => {});
		return null;
	}
}
