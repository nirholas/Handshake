// GET /api/agent-economy/status
//
// Returns live wallet info for both agents. No auth required, read-only.
//   agentA = the buyer  (AVATAR_WALLET_SECRET keypair)
//   agentB = the seller (AGENT_B_ADDRESS public key only)
//
// Both balances are fetched from Solana mainnet. The seller balance uses a
// public RPC query on the configured address, so no private key is needed.
// Returns configured:false for either agent when their env var is absent.
//
// `configured` reports CONFIGURATION, never RPC health: an agent whose env var
// is set stays configured:true with `sol: null` when the balance read fails, so
// the caller can tell "no wallet set up" apart from "Solana RPC is down". Those
// two used to collapse into the same configured:false, which made an RPC blip
// read as a missing wallet.

import {
	avatarWalletConfig,
	loadAvatarKeypair,
	getConnection,
	getSolBalance,
	solUsdPrice,
	isValidPubkey,
	explorerAccountUrl,
} from '../_lib/avatar-wallet.js';
import { cors, method, wrap } from '../_lib/http.js';

const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

function unfundedShape({ address, network }) {
	return {
		configured: true,
		address,
		sol: null,
		lamports: null,
		usd: null,
		solPriceUsd: null,
		network,
		explorer: explorerAccountUrl(address, network),
	};
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const cfgA = avatarWalletConfig();
	const conn = getConnection(RPC_URL);
	const pricePromise = solUsdPrice().catch(() => 0);

	let agentA = { configured: false };
	let agentB = { configured: false };

	const fetches = [];

	if (cfgA.configured) {
		const addr = loadAvatarKeypair(process.env.AVATAR_WALLET_SECRET).publicKey.toBase58();
		agentA = unfundedShape({ address: addr, network: cfgA.network });
		fetches.push(
			(async () => {
				const [{ sol, lamports }, price] = await Promise.all([
					getSolBalance(conn, addr),
					pricePromise,
				]);
				agentA = {
					...agentA,
					sol,
					lamports,
					usd: price > 0 ? sol * price : null,
					solPriceUsd: price || null,
				};
			})(),
		);
	}

	const bAddr = process.env.AGENT_B_ADDRESS?.trim();
	if (bAddr && isValidPubkey(bAddr)) {
		agentB = unfundedShape({ address: bAddr, network: 'mainnet' });
		fetches.push(
			(async () => {
				const [{ sol, lamports }, price] = await Promise.all([
					getSolBalance(conn, bAddr),
					pricePromise,
				]);
				agentB = {
					...agentB,
					sol,
					lamports,
					usd: price > 0 ? sol * price : null,
					solPriceUsd: price || null,
				};
			})(),
		);
	}

	await Promise.allSettled(fetches);

	res.writeHead(200, {
		'content-type': 'application/json',
		'access-control-allow-origin': '*',
		'cache-control': 'no-store',
	});
	res.end(JSON.stringify({ agentA, agentB }));
});
