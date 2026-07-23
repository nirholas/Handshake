import { PublicKey } from '@solana/web3.js';
import { solanaConnection } from '../_lib/solana/connection.js';
import { cors, json, method, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { TOKEN_MINT as THREE_MINT } from '../_lib/token/config.js';
const RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.authedReadIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const address = req.query?.address?.trim();
	if (!address) return error(res, 400, 'validation_error', 'address required');

	let owner;
	try {
		owner = new PublicKey(address);
	} catch {
		return error(res, 400, 'validation_error', 'invalid Solana address');
	}

	const connection = solanaConnection({ url: RPC, commitment: 'confirmed' });
	// Filter by MINT, not by token program: $THREE is a Token-2022 mint, so a
	// classic-program-only query never sees it (every holder read as balance 0).
	// The mint filter matches the holder's account under whichever program owns
	// the mint, and returns only that account instead of the whole wallet.
	const accounts = await connection.getParsedTokenAccountsByOwner(owner, {
		mint: new PublicKey(THREE_MINT),
	});

	const balance = accounts.value.reduce(
		(sum, a) => sum + Number(a.account.data.parsed.info.tokenAmount.uiAmount ?? 0),
		0,
	);

	return json(res, 200, {
		has_pass: balance > 0,
		balance,
		mint: THREE_MINT,
	});
});
