// POST /api/bnb/register-agent
// ---------------------------------------------------------------------------
// Gas-free ERC-8004 agent registration on BSC — the campaign's headline demo:
// a brand-new, zero-balance wallet mints its on-chain agent identity from the
// first click via MegaFuel (BEP-414 paymaster), no faucet, no funding.
//
// The client signs a legacy `register()` / `register(string)` transaction
// against the Identity Registry entirely in the browser (a connected wallet
// or an in-page ephemeral key — either way the private key never leaves it)
// and POSTs only the raw signed bytes here. This endpoint never signs and
// never touches a key — see api/_lib/bnb/erc8004-gasless.js for the full
// sponsored/self-pay/declined state machine.
//
// Body:     { signedRegisterTx: '0x…', network?: 'bscTestnet'|'bscMainnet' }
// Response: { mode: 'sponsored'|'self-pay', hash, agentId, pending,
//             explorerUrl, ... }
//         | { mode: 'declined', reason, hint, address, network }
//         | { alreadyRegistered: true, agentId, address, network, explorerUrl }

import { cors, json, method, wrap, error, readJson, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { relayGaslessRegistration, RegisterRelayError } from '../_lib/bnb/erc8004-gasless.js';
import { BNB_CHAINS } from '../_lib/bnb/chains.js';

// erc8004-gasless.js's own normalizer maps anything it does not recognize to
// bscTestnet, which is the right default for an absent value but the wrong
// answer for a typo: `network: "bscTestnett"` would quietly register on a
// chain the caller never asked for. Validate at the boundary instead, and pass
// undefined through untouched so the lib keeps owning the default.
function normalizeNetworkParam(raw) {
	if (raw == null || raw === '') return undefined;
	const v = String(raw).trim().toLowerCase();
	if (v === 'testnet' || v === '97' || v === 'bsctestnet') return 'bscTestnet';
	if (v === 'mainnet' || v === '56' || v === 'bsc' || v === 'bscmainnet') return 'bscMainnet';
	return null;
}

function withExplorerUrl(result) {
	const explorer = BNB_CHAINS[result.network]?.explorer;
	if (!explorer) return result;
	if (result.hash) return { ...result, explorerUrl: `${explorer}/tx/${result.hash}` };
	if (result.address) return { ...result, explorerUrl: `${explorer}/address/${result.address}` };
	return result;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['POST'])) return;

	const rl = await limits.bnbRegisterIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl, 'too many registration attempts');

	let body;
	try {
		body = await readJson(req);
	} catch (e) {
		return error(res, e.status || 400, 'bad_body', 'failed to read JSON body');
	}

	const signedRegisterTx = body?.signedRegisterTx;

	if (!signedRegisterTx || typeof signedRegisterTx !== 'string') {
		return error(res, 400, 'bad_request', 'signedRegisterTx (a 0x-prefixed signed raw transaction) is required');
	}

	const network = normalizeNetworkParam(body?.network);
	if (network === null) {
		return error(res, 400, 'bad_request', `unknown network "${String(body?.network).slice(0, 64)}", use "bscTestnet" or "bscMainnet"`);
	}

	try {
		const result = await relayGaslessRegistration({ signedRegisterTx, network });
		return json(res, 200, withExplorerUrl(result), { 'cache-control': 'no-store' });
	} catch (err) {
		if (err instanceof RegisterRelayError) {
			return error(res, err.status || 400, err.code || 'bad_request', err.message);
		}
		throw err;
	}
});
