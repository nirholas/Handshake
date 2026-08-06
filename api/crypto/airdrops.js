// GET /api/crypto/airdrops - airdrop eligibility checker for any wallet.
//
// One call scans the wallet's real on-chain activity (Solana keyless via the
// rotating RPC chain; EVM via Etherscan V2 behind ETHERSCAN_API_KEY) and
// scores it against the registry in data/airdrops.json. The response carries
// the measured activity, per-airdrop scores with met/missing/manual criteria,
// and a summary for the hero band. Registry entries from the other chain
// family come back unevaluated so the page can say "check this with your
// other wallet" instead of rendering a fake zero.
//
// GET with no address returns the registry alone (the page's pre-lookup
// directory view). Free-endpoint family conventions per api/crypto/wallet.js.

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cors, method, wrap, error } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { isValidAddressForChain } from '../_lib/splits.js';
import { walletActivity } from '../_lib/wallet-activity.js';
import { evaluateRegistry, summarize, QUALIFIED_SCORE, IN_PROGRESS_SCORE } from '../_lib/airdrop-eligibility.js';

const REGISTRY_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../../data/airdrops.json');

let _registry = null;
function registry() {
	if (!_registry) _registry = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));
	return _registry;
}

export default wrap(async function handler(req, res) {
	if (cors(req, res, { origins: '*', methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	const ip = clientIp(req);
	const [ipRl, globalRl] = await Promise.all([limits.cryptoDataIp(ip), limits.cryptoDataGlobal()]);
	if (!ipRl.success || !globalRl.success) {
		return error(res, 429, 'rate_limited', 'too many requests - slow down and retry shortly', {
			retryAfter: 60,
		});
	}

	const url = new URL(req.url, 'http://x');
	const address = (url.searchParams.get('address') || '').trim();
	const reg = registry();

	if (!address) {
		res.setHeader('cache-control', 'public, s-maxage=300, stale-while-revalidate=900');
		res.statusCode = 200;
		res.setHeader('content-type', 'application/json; charset=utf-8');
		return res.end(JSON.stringify({
			registry: reg.airdrops,
			updated: reg.updated,
			thresholds: { qualified: QUALIFIED_SCORE, inProgress: IN_PROGRESS_SCORE },
		}));
	}

	const family = isValidAddressForChain(address, 'solana') ? 'solana'
		: isValidAddressForChain(address, 'evm') ? 'evm'
		: null;
	if (!family) {
		return error(res, 400, 'invalid_address', 'not a valid Solana or EVM address', {
			example: '/api/crypto/airdrops?address=<wallet>',
		});
	}

	let activity;
	try {
		activity = await walletActivity(family, address);
	} catch (err) {
		if (err?.code === 'not_configured') {
			return error(res, 503, 'not_configured', 'EVM activity scanning requires an explorer key that is not set on this deployment - Solana wallets work keyless', {
				family,
			});
		}
		res.setHeader('retry-after', '15');
		return error(res, 503, 'upstream_unavailable', 'activity data sources are temporarily unavailable - retry shortly', {
			retryAfter: 15,
		});
	}

	const { evaluated, otherFamily } = evaluateRegistry(reg.airdrops, activity, family);
	const body = {
		address,
		family,
		activity,
		opportunities: evaluated,
		otherFamily,
		summary: summarize(evaluated),
		thresholds: { qualified: QUALIFIED_SCORE, inProgress: IN_PROGRESS_SCORE },
		registryUpdated: reg.updated,
		ts: new Date().toISOString(),
	};

	res.setHeader('cache-control', 'public, s-maxage=120, stale-while-revalidate=300');
	res.statusCode = 200;
	res.setHeader('content-type', 'application/json; charset=utf-8');
	res.end(JSON.stringify(body));
});
