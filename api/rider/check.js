import { Connection, PublicKey } from '@solana/web3.js';
import { cors, json, method, wrap, error } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { TOKEN_MINT as THREE_MINT } from '../_lib/token/config.js';
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const address = req.query?.address?.trim();
	if (!address) return error(res, 400, 'validation_error', 'address required');

	let owner;
	try {
		owner = new PublicKey(address);
	} catch {
		return error(res, 400, 'validation_error', 'invalid Solana address');
	}

	const connection = new Connection(RPC, 'confirmed');
	const accounts = await connection.getParsedTokenAccountsByOwner(owner, {
		programId: TOKEN_PROGRAM,
	});

	const threeAccount = accounts.value.find((a) => a.account.data.parsed.info.mint === THREE_MINT);
	const balance = threeAccount
		? Number(threeAccount.account.data.parsed.info.tokenAmount.uiAmount ?? 0)
		: 0;

	return json(res, 200, {
		has_pass: balance > 0,
		balance,
		mint: THREE_MINT,
	});
});
