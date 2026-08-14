// @ts-check
// Coinbase Onramp session tokens.
//
// Coinbase's hosted onramp used to accept the destination wallet directly in the
// checkout URL (`appId` + `destinationWallets`). That initialization path is gone:
// https://pay.coinbase.com/buy/select-asset now requires a `sessionToken` minted
// server-side from the CDP Onramp Session Token API, and the wallet address is
// passed to that API instead of the query string. A URL built the old way lands
// the buyer on an error page, so this module is the only supported way for us to
// send someone to Coinbase with their three.ws wallet pre-filled as the
// destination.
//
// Requires CDP_API_KEY_ID + CDP_API_KEY_SECRET (the same CDP key pair the x402
// facilitator already uses, see api/_lib/x402-spec.js). Tokens are single-use and
// expire after five minutes, so one is minted per checkout link, never cached.
//
// Spec: https://docs.cdp.coinbase.com/onramp/coinbase-hosted-onramp/generating-onramp-url

import { generateJwt } from '@coinbase/cdp-sdk/auth';
import { env } from './env.js';
import { clientIp } from './rate-limit.js';

const CDP_HOST = 'api.developer.coinbase.com';
const TOKEN_PATH = '/onramp/v1/token';
const TOKEN_URL = `https://${CDP_HOST}${TOKEN_PATH}`;

// The token call is on the critical path of a user click, so it fails fast to the
// keyless fallback rather than leaving the "Add funds" button spinning.
const TOKEN_TIMEOUT_MS = 8_000;

// The CDP API rejects private and loopback source addresses, which is exactly what
// a local dev box or a container-internal call reports. Coinbase's own integration
// guide prescribes the RFC 5737 documentation address for that case; it is a
// placeholder for the caller's network location, not for any response data.
const DOCUMENTATION_IP = '192.0.2.1';

const PRIVATE_V4 = [
	/^10\./,
	/^127\./,
	/^169\.254\./,
	/^192\.168\./,
	/^172\.(1[6-9]|2\d|3[01])\./,
	/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
	/^0\./,
];

/**
 * Is this address routable on the public internet? Anything private, loopback,
 * link-local, or unique-local is not, and must not be sent to CDP.
 *
 * @param {string} ip
 * @returns {boolean}
 */
export function isPublicIp(ip) {
	if (!ip || typeof ip !== 'string') return false;
	// A v4-mapped v6 address (::ffff:203.0.113.7) is judged on its v4 half.
	const addr = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
	if (addr.includes(':')) {
		const v6 = addr.toLowerCase();
		if (v6 === '::' || v6 === '::1') return false;
		// fc00::/7 (unique-local) and fe80::/10 (link-local)
		return !/^(f[cd]|fe[89ab])/.test(v6);
	}
	if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(addr)) return false;
	return !PRIVATE_V4.some((re) => re.test(addr));
}

/**
 * The caller's IP in the form CDP accepts. Falls back to the documentation
 * address when the real one is unroutable (local dev, container-internal call),
 * which is what Coinbase's integration guide prescribes.
 *
 * @param {{ headers?: Record<string, unknown>, socket?: { remoteAddress?: string } }} req
 * @returns {string}
 */
export function onrampClientIp(req) {
	const ip = clientIp(req);
	return isPublicIp(ip) ? ip : DOCUMENTATION_IP;
}

/**
 * Are CDP credentials configured for this deployment?
 * @returns {boolean}
 */
export function onrampConfigured() {
	return Boolean(env.CDP_API_KEY_ID && env.CDP_API_KEY_SECRET);
}

export class CoinbaseOnrampError extends Error {
	/**
	 * @param {string} code
	 * @param {string} message
	 * @param {number} [status]
	 */
	constructor(code, message, status = 502) {
		super(message);
		this.name = 'CoinbaseOnrampError';
		this.code = code;
		this.status = status;
	}
}

/**
 * Mint a single-use Coinbase Onramp session token bound to a destination wallet.
 *
 * @param {object} opts
 * @param {string} opts.address       destination wallet address
 * @param {string[]} opts.blockchains chains that address is valid on (e.g. ['solana'])
 * @param {string[]} [opts.assets]    asset tickers to offer (e.g. ['USDC'])
 * @param {string} opts.clientIp      the buyer's public IP, from onrampClientIp()
 * @returns {Promise<string>} the session token
 * @throws {CoinbaseOnrampError} when credentials are absent or CDP rejects the call
 */
export async function createOnrampSessionToken({ address, blockchains, assets, clientIp: ip }) {
	if (!onrampConfigured()) {
		throw new CoinbaseOnrampError(
			'onramp_not_configured',
			'Coinbase Onramp requires CDP_API_KEY_ID + CDP_API_KEY_SECRET',
			503,
		);
	}

	// EC keys are commonly stored with escaped newlines in an env var; the signer
	// needs the real PEM. Ed25519 secrets are plain base64 and pass through.
	const apiKeySecret = String(env.CDP_API_KEY_SECRET).replace(/\\n/g, '\n');

	let jwt;
	try {
		jwt = await generateJwt({
			apiKeyId: String(env.CDP_API_KEY_ID),
			apiKeySecret,
			requestMethod: 'POST',
			requestHost: CDP_HOST,
			requestPath: TOKEN_PATH,
			expiresIn: 120,
		});
	} catch (err) {
		throw new CoinbaseOnrampError(
			'onramp_auth_failed',
			`could not sign the CDP request: ${err?.message || err}`,
			500,
		);
	}

	let response;
	try {
		response = await fetch(TOKEN_URL, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				accept: 'application/json',
				authorization: `Bearer ${jwt}`,
			},
			body: JSON.stringify({
				addresses: [{ address, blockchains }],
				...(assets?.length ? { assets } : {}),
				clientIp: ip,
			}),
			signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
		});
	} catch (err) {
		throw new CoinbaseOnrampError(
			'onramp_unreachable',
			`CDP session token request failed: ${err?.message || err}`,
		);
	}

	const body = await response.text();
	if (!response.ok) {
		throw new CoinbaseOnrampError(
			'onramp_rejected',
			`CDP session token request returned ${response.status}: ${body.slice(0, 300)}`,
			response.status === 401 || response.status === 403 ? 500 : 502,
		);
	}

	let parsed;
	try {
		parsed = JSON.parse(body);
	} catch {
		throw new CoinbaseOnrampError('onramp_bad_response', 'CDP session token response was not JSON');
	}
	const token = parsed?.token || parsed?.data?.token;
	if (typeof token !== 'string' || !token) {
		throw new CoinbaseOnrampError('onramp_bad_response', 'CDP session token response carried no token');
	}
	return token;
}
