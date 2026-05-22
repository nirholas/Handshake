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
import { env } from '../_lib/env.js';

export const maxDuration = 10;

const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const SOLANA_MAINNET_GENESIS = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const ACTION_VERSION = '2.1.3';

function setActionHeaders(res) {
	res.setHeader('x-action-version', ACTION_VERSION);
	res.setHeader('x-blockchain-ids', SOLANA_MAINNET_GENESIS);
	// Extend the expose list set by cors() to include action-specific headers.
	res.setHeader(
		'access-control-expose-headers',
		'x-action-version, x-blockchain-ids, x-payment-response, x-payment-network, x-payment-tx, link',
	);
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', origins: '*' })) return;

	const url = new URL(req.url, 'http://x');
	const avatarId = url.searchParams.get('avatar') || 'default';

	if (req.method === 'GET') return handleGet(req, res, avatarId);
	if (req.method === 'POST') return handlePost(req, res, avatarId);
	return error(res, 405, 'method_not_allowed', 'GET or POST required');
});

async function handleGet(_req, res, avatarId) {
	const origin = env.APP_ORIGIN;
	const iconUrl = `${origin}/api/actions/avatar-icon?avatar=${encodeURIComponent(avatarId)}`;
	const actionHref = `/api/actions/avatar?avatar=${encodeURIComponent(avatarId)}`;

	setActionHeaders(res);
	return json(res, 200, {
		icon: iconUrl,
		label: 'Claim Avatar',
		title: 'My 3D Avatar — three.ws',
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
		return error(res, 400, 'bad_request', e.message);
	}

	const account = typeof body?.account === 'string' ? body.account.trim() : '';
	if (!account) return error(res, 400, 'bad_request', 'account is required');

	const { PublicKey, TransactionMessage, VersionedTransaction, Connection } =
		await import('@solana/web3.js');

	let payer;
	try {
		payer = new PublicKey(account);
	} catch {
		return error(res, 400, 'bad_request', 'invalid account pubkey');
	}

	const rpc =
		process.env.SOLANA_MAINNET_RPC || 'https://api.mainnet-beta.solana.com';
	const connection = new Connection(rpc, 'confirmed');
	const { blockhash } = await connection.getLatestBlockhash();

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

	setActionHeaders(res);
	return json(res, 200, {
		transaction: txBase64,
		message: 'Your 3D avatar identity is now recorded on Solana. Welcome to three.ws.',
	});
}
