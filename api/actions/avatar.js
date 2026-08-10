// Solana Blink: "Claim Your 3D Avatar"
//
// GET  /api/actions/avatar[?avatar=<id>]
//   → ActionGetResponse: title, description, icon (server-rendered PNG), CTA button
//
// POST /api/actions/avatar[?avatar=<id>]
//   Body: { "account": "<wallet pubkey>" }
//   → ActionPostResponse: base64 VersionedTransaction (SPL Memo claim)
//
// The icon URL resolves to /api/actions/avatar-icon which renders the avatar
// GLB via headless chromium so X shows a live 3D-rendered portrait in the card.

import { cors, json, error, readJson, wrap } from '../_lib/http.js';
import { solanaConnection } from '../_lib/solana/connection.js';
import { env } from '../_lib/env.js';
import { getAvatar } from '../_lib/avatars.js';
import { isUuid } from '../_lib/validate.js';

export const maxDuration = 10;

const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const SOLANA_MAINNET_GENESIS = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const ACTION_VERSION = '2.1.3';

function setActionVersionHeaders(res) {
	res.setHeader('x-action-version', ACTION_VERSION);
	res.setHeader('x-blockchain-ids', SOLANA_MAINNET_GENESIS);
}

function exposeActionHeaders(res) {
	// Extend the expose list set by cors() to include action-specific headers.
	res.setHeader(
		'access-control-expose-headers',
		'x-action-version, x-blockchain-ids, x-payment-response, x-payment-network, x-payment-tx, link',
	);
}

// Blink clients render ActionError.message, not our standard error envelope, so
// action errors carry both shapes.
function actionError(res, status, code, message) {
	return error(res, status, code, message, { message });
}

export default wrap(async (req, res) => {
	// The Actions spec expects the version headers on every response from an
	// action endpoint, the OPTIONS preflight included, so they are set before
	// cors() can short-circuit it.
	setActionVersionHeaders(res);
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', origins: '*' })) return;
	exposeActionHeaders(res);

	if (req.method !== 'GET' && req.method !== 'POST') {
		return actionError(res, 405, 'method_not_allowed', 'GET or POST required');
	}

	const url = new URL(req.url, 'http://x');
	const avatarId = url.searchParams.get('avatar') || 'default';
	// The id is echoed into the card and written into the on-chain memo, so only
	// the two forms that can name a real avatar are accepted. Without this an
	// arbitrary string rides into a transaction that presents itself as a
	// three.ws claim.
	if (avatarId !== 'default' && !isUuid(avatarId)) {
		return actionError(res, 400, 'bad_request', 'avatar must be "default" or an avatar id');
	}

	// A public Blink resolves as an anonymous viewer would: getAvatar returns
	// null for a private or deleted avatar, which is a 404 here rather than a
	// card advertising something the claimer cannot see.
	let avatar = null;
	if (avatarId !== 'default') {
		avatar = await getAvatar({ id: avatarId }).catch(() => null);
		if (!avatar) return actionError(res, 404, 'not_found', 'That avatar is not available.');
	}

	if (req.method === 'GET') return handleGet(res, avatarId, avatar);
	return handlePost(req, res, avatarId);
});

function handleGet(res, avatarId, avatar) {
	const origin = env.APP_ORIGIN;
	const iconUrl = `${origin}/api/actions/avatar-icon?avatar=${encodeURIComponent(avatarId)}`;
	const actionHref = `/api/actions/avatar?avatar=${encodeURIComponent(avatarId)}`;
	const name = typeof avatar?.name === 'string' ? avatar.name.trim().slice(0, 60) : '';

	return json(res, 200, {
		type: 'action',
		icon: iconUrl,
		label: 'Claim Avatar',
		title: name ? `${name} on three.ws` : 'My 3D Avatar on three.ws',
		description:
			'Register your Solana wallet to this 3D avatar. Your claim is written on-chain via SPL Memo and links your wallet to your three.ws identity.',
		links: {
			actions: [
				{
					type: 'transaction',
					label: 'Claim This Avatar',
					href: actionHref,
				},
			],
		},
	}, { 'cache-control': 'public, max-age=60, s-maxage=300' });
}

async function handlePost(req, res, avatarId) {
	let body;
	try {
		body = await readJson(req, 4_000);
	} catch (e) {
		return actionError(res, 400, 'bad_request', e.message);
	}

	const account = typeof body?.account === 'string' ? body.account.trim() : '';
	if (!account) return actionError(res, 400, 'bad_request', 'account is required');

	const { PublicKey, TransactionMessage, VersionedTransaction } =
		await import('@solana/web3.js');

	let payer;
	try {
		payer = new PublicKey(account);
		// A curve-off point is a PDA: it has no private key, so a transaction
		// built for it can never be signed. Reject it here rather than handing
		// the wallet a transaction it will fail on.
		if (!PublicKey.isOnCurve(payer.toBytes())) throw new Error('off-curve');
	} catch {
		return actionError(res, 400, 'bad_request', 'invalid account pubkey');
	}

	const rpc =
		process.env.SOLANA_MAINNET_RPC || 'https://api.mainnet-beta.solana.com';
	const connection = solanaConnection({ url: rpc, commitment: 'confirmed' });
	let blockhash;
	try {
		({ blockhash } = await connection.getLatestBlockhash());
	} catch (err) {
		// maxDuration is 10s: a stalled or rate-limited RPC has to surface as an
		// actionable error, not as a timeout the Blink client renders as a hang.
		return actionError(
			res,
			503,
			'rpc_unavailable',
			`Solana RPC did not return a blockhash: ${err?.message || err}`,
		);
	}

	const memo = JSON.stringify({
		v: 1,
		action: 'avatar-claim',
		avatar: avatarId,
		site: 'three.ws',
	});

	const memoInstruction = {
		programId: new PublicKey(MEMO_PROGRAM_ID),
		keys: [{ pubkey: payer, isSigner: true, isWritable: false }],
		data: Buffer.from(memo, 'utf8'),
	};

	const message = new TransactionMessage({
		payerKey: payer,
		recentBlockhash: blockhash,
		instructions: [memoInstruction],
	}).compileToV0Message();

	const tx = new VersionedTransaction(message);
	const txBase64 = Buffer.from(tx.serialize()).toString('base64');

	return json(res, 200, {
		type: 'transaction',
		transaction: txBase64,
		message: 'Your 3D avatar identity is now recorded on Solana. Welcome to three.ws.',
	}, { 'cache-control': 'no-store' });
}
