// OKX Agent Payments Protocol rail, x402 `exact` + EIP-3009 on X Layer (chain 196).
//
// The OKX.AI marketplace (agents hire agents; A2MCP services) requires sellers
// to speak its x402 v2 dialect on X Layer. The wire contract in
// specs/okx-agent-payments.md is pinned to live captures from approved sellers
// (Onchain Data Explorer, 174 sales) and the `onchainos` buyer CLI:
//
//   1. Unpaid request → HTTP 402. The envelope {x402Version:2, resource:{url,
//      mimeType}, accepts:[…]} ships BOTH as the JSON body and base64-encoded in
//      the `PAYMENT-REQUIRED` response header (plus
//      `access-control-expose-headers: PAYMENT-REQUIRED`).
//   2. The accepts entry: { scheme:'exact', network:'eip155:196', amount:<base
//      units>, payTo, maxTimeoutSeconds:86400, asset:<USD₮0>, extra:{ symbol:
//      'USDT', name:'USD₮0', version:'1', transferMethod:'eip3009' } }.
//      extra.name/version are the token's EIP-712 domain, USD₮0's on-chain
//      domain is name "USD₮0", version "1" (verified via eth_call).
//   3. The buyer replays with `PAYMENT-SIGNATURE: <base64 JSON>` decoding to
//      { x402Version:2, accepted:<chosen accepts entry>, payload:{
//        authorization:{from,to,value,validAfter,validBefore,nonce}, signature },
//      resource }, note `accepted`, not the standard x402 top-level
//      scheme/network fields.
//   4. Verification is seller-side and on-chain: EIP-712 signature recovery
//      first, then ERC-1271/6492 (OKX agentic wallets are EIP-7702 delegated
//      EOAs, so the order matters, see eip3009SignatureIsValid), recipient/
//      amount/time-window checks, unused authorizationState, and a balanceOf
//      check. Insufficient balance re-issues the 402 with top-level
//      error:"insufficient_balance", the exact behavior captured from the
//      approved seller.
//   5. Settlement routes through OKX's official facilitator when OKX SA API
//      credentials are configured, POST https://web3.okx.com/api/v6/pay/x402/
//      settle with syncSettle:true (HMAC-SHA256 auth; the exact client the
//      official @okxweb3/app-x402-core SDK ships). Verification likewise gets
//      a facilitator /verify pass on top of the local checks. Without OKX
//      creds, the seller redeems the authorization DIRECTLY, broadcasts
//      transferWithAuthorization from a relayer key (OKB gas); per the
//      protocol docs "settlement happens on-chain when the recipient redeems
//      the authorization."
//
// This module is the X Layer sibling of x402-bsc-direct.js: verify/settle live
// here, x402-spec.js routes to them by network, and callers keep the exact
// verifyPayment()/settlePayment() surface they already use.

import {
	createPublicClient,
	createWalletClient,
	fallback,
	getAddress,
	http,
	recoverTypedDataAddress,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { xLayer } from 'viem/chains';
import { OKXFacilitatorClient } from '@okxweb3/app-x402-core';

import { env } from './env.js';
import { X402Error } from './x402-errors.js';

export const NETWORK_XLAYER_MAINNET = 'eip155:196';
export const XLAYER_CHAIN_ID = 196;

// USD₮0's EIP-712 domain, verified on-chain (name()/symbol() both return
// "USD₮0") and matched against the live approved-seller 402s (extra.name
// "USD₮0", extra.version "1"). The ₮ is U+20AE, keep it exact: the domain
// separator hashes the byte string.
const USDT0_DOMAIN_NAME = 'USD₮0';
const USDT0_DOMAIN_VERSION = '1';
const USDT0_SYMBOL = 'USDT';

// EIP-3009 typed data, the struct the buyer's wallet signs.
const TRANSFER_WITH_AUTHORIZATION_TYPES = {
	TransferWithAuthorization: [
		{ name: 'from', type: 'address' },
		{ name: 'to', type: 'address' },
		{ name: 'value', type: 'uint256' },
		{ name: 'validAfter', type: 'uint256' },
		{ name: 'validBefore', type: 'uint256' },
		{ name: 'nonce', type: 'bytes32' },
	],
};

const EIP3009_ABI = [
	{
		type: 'function',
		name: 'transferWithAuthorization',
		stateMutability: 'nonpayable',
		inputs: [
			{ name: 'from', type: 'address' },
			{ name: 'to', type: 'address' },
			{ name: 'value', type: 'uint256' },
			{ name: 'validAfter', type: 'uint256' },
			{ name: 'validBefore', type: 'uint256' },
			{ name: 'nonce', type: 'bytes32' },
			{ name: 'signature', type: 'bytes' },
		],
		outputs: [],
	},
	{
		type: 'function',
		name: 'transferWithAuthorization',
		stateMutability: 'nonpayable',
		inputs: [
			{ name: 'from', type: 'address' },
			{ name: 'to', type: 'address' },
			{ name: 'value', type: 'uint256' },
			{ name: 'validAfter', type: 'uint256' },
			{ name: 'validBefore', type: 'uint256' },
			{ name: 'nonce', type: 'bytes32' },
			{ name: 'v', type: 'uint8' },
			{ name: 'r', type: 'bytes32' },
			{ name: 's', type: 'bytes32' },
		],
		outputs: [],
	},
	{
		type: 'function',
		name: 'authorizationState',
		stateMutability: 'view',
		inputs: [
			{ name: 'authorizer', type: 'address' },
			{ name: 'nonce', type: 'bytes32' },
		],
		outputs: [{ type: 'bool' }],
	},
	{
		type: 'function',
		name: 'balanceOf',
		stateMutability: 'view',
		inputs: [{ name: 'account', type: 'address' }],
		outputs: [{ type: 'uint256' }],
	},
];

// RPC failover for chain 196, X Layer is not in the shared erc8004 chain
// registry, so the endpoint list lives here: explicit override first, then
// viem's curated default, then OKX's public node.
function xlayerEndpoints() {
	const urls = [
		env.getRpcUrl(XLAYER_CHAIN_ID),
		xLayer.rpcUrls.default.http[0],
		'https://rpc.xlayer.tech',
	].filter(Boolean);
	return [...new Set(urls)];
}

let cachedClient = null;
export function xlayerClient() {
	if (cachedClient) return cachedClient;
	cachedClient = createPublicClient({
		chain: xLayer,
		transport: fallback(xlayerEndpoints().map((u) => http(u, { retryCount: 1 }))),
	});
	return cachedClient;
}

// Are the OKX SA API credentials for the official facilitator configured?
export function okxFacilitatorConfigured() {
	return Boolean(env.OKX_API_KEY && env.OKX_SECRET_KEY && env.OKX_PASSPHRASE);
}

// Singleton facilitator client (official SDK). syncSettle:true, the seller
// waits for on-chain confirmation before responding, per the SDK's
// recommended seller configuration, so PAYMENT-RESPONSE always carries a
// confirmed transaction.
let cachedFacilitator = null;
function okxFacilitator() {
	if (!cachedFacilitator) {
		cachedFacilitator = new OKXFacilitatorClient({
			apiKey: env.OKX_API_KEY,
			secretKey: env.OKX_SECRET_KEY,
			passphrase: env.OKX_PASSPHRASE,
			syncSettle: true,
		});
	}
	return cachedFacilitator;
}

// Can we actually settle on X Layer right now? Advertise the rail only when
// the receiver, the asset, and a working settlement route (OKX facilitator
// creds, or the direct-redemption relayer key) are all configured, the same
// never-402-then-502 rule baseSettleable()/solanaSettleable() enforce.
export function xlayerSettleable() {
	return Boolean(
		env.X402_PAY_TO_XLAYER &&
			env.X402_ASSET_ADDRESS_XLAYER &&
			(okxFacilitatorConfigured() || env.X402_XLAYER_RELAYER_KEY),
	);
}

// The X Layer accepts[] entry, byte-shaped to the approved-seller captures.
// `amount` is a base-units string (USD₮0 = 6 decimals, same atomic scale as
// USDC, so per-tool USDC atomic prices carry over unchanged).
export function okxXLayerAccept(resourceUrl, amount) {
	return {
		scheme: 'exact',
		network: NETWORK_XLAYER_MAINNET,
		amount: String(amount),
		payTo: env.X402_PAY_TO_XLAYER,
		maxTimeoutSeconds: 86400,
		asset: env.X402_ASSET_ADDRESS_XLAYER,
		...(resourceUrl ? { resource: resourceUrl } : {}),
		extra: {
			symbol: USDT0_SYMBOL,
			name: USDT0_DOMAIN_NAME,
			version: USDT0_DOMAIN_VERSION,
			transferMethod: 'eip3009',
			// Optional-but-recommended (spec Appx H.2): USD₮0 is outside the OKX
			// task system's supported-token list, so omitting decimals triggers a
			// non-fatal tokenResolveError in `onchainos agent x402-check`.
			decimals: 6,
		},
	};
}

// What an unpaid caller on this rail must send back. x402 v2 (which OKX
// implements, and whose SDK reads only `payment-signature`) renamed v1's
// `X-PAYMENT` to `PAYMENT-SIGNATURE`. Our handlers accept either header, so the
// message names both with the v2 name first; the platform-wide default in
// x402-spec.js still names v1 for the v1 rails that earned it.
export const X402_HEADER_ERROR = 'PAYMENT-SIGNATURE header is required (X-PAYMENT is also accepted)';

// Send the OKX-dialect 402: the minimal {x402Version, resource:{url,mimeType},
// accepts[, error]} envelope as BOTH body and base64 PAYMENT-REQUIRED header.
// Deliberately not build402Body(): the OKX validator's reference sellers emit
// exactly this shape (no extensions envelope, no top-level description), and
// the listing contract is "look like an approved seller", not "look like our
// Bazaar catalog".
export function sendOkx402(res, { resourceUrl, accepts, error }) {
	const body = {
		x402Version: 2,
		...(error ? { error } : {}),
		resource: { url: resourceUrl, mimeType: 'application/json' },
		accepts: Array.isArray(accepts) ? accepts : [accepts],
	};
	const encoded = Buffer.from(JSON.stringify(body), 'utf8').toString('base64');
	res.statusCode = 402;
	res.setHeader('content-type', 'application/json; charset=utf-8');
	res.setHeader('cache-control', 'no-store');
	res.setHeader('PAYMENT-REQUIRED', encoded);
	res.setHeader('access-control-expose-headers', 'PAYMENT-REQUIRED, PAYMENT-RESPONSE');
	res.end(JSON.stringify(body));
}

// Pull {authorization, signature} out of either payload dialect:
//   OKX:      { accepted:{…}, payload:{ authorization, signature } }
//   standard: { scheme, network, payload:{ authorization, signature } }
function extractAuthorization(paymentPayload) {
	const inner = paymentPayload?.payload;
	const auth = inner?.authorization;
	const signature = inner?.signature;
	if (!auth || typeof auth !== 'object' || typeof signature !== 'string') {
		throw new X402Error(
			'invalid_payment',
			'X Layer payment must carry payload.authorization + payload.signature (EIP-3009)',
			402,
		);
	}
	return { auth, signature };
}

function asAddress(value, field) {
	try {
		return getAddress(String(value));
	} catch {
		throw new X402Error('invalid_payment', `${field} is not a valid EVM address`, 402);
	}
}

function asBigInt(value, field) {
	try {
		return BigInt(value);
	} catch {
		throw new X402Error('invalid_payment', `${field} must be an integer string`, 402);
	}
}

// Is this EIP-3009 authorization signed by `from`, judged the way USD₮0's own
// transferWithAuthorization judges it: recover the ECDSA signature first, and
// only ask an on-chain contract when recovery does not name the payer.
//
// The order is load-bearing, not a micro-optimisation. Every OKX agentic wallet
// on X Layer is an EIP-7702 delegated EOA: the address holds 23 bytes of
// delegation code (`0xef0100 || implementation`), so viem's verifyTypedData
// takes its contract branch, calls the delegate's ERC-1271 isValidSignature,
// and returns false for a signature the EOA's own key produced. The delegate
// answers 1271 over its own replay-safe wrapper hash, never the raw EIP-712
// digest that EIP-3009 requires. That is what OKX's 2026-08-27 listing QA hit:
// its buyer signed a correct, fully funded authorization from
// 0xbc59eb75C55e3bF1E63aaeE653C2b8E02BFd2033 and we answered a second 402
// ("EIP-3009 signature does not verify for authorization.from"), which the
// review reported as the service failing its payment test. Recovery first
// matches the token: it redeems on ecrecover, so any signature accepted here
// is one the settlement transaction can actually spend.
//
// The ERC-1271/6492 branch stays for real smart accounts, whose proofs are not
// recoverable ECDSA at all.
async function eip3009SignatureIsValid({ client, from, domain, message, signature }) {
	try {
		const recovered = await recoverTypedDataAddress({
			domain,
			types: TRANSFER_WITH_AUTHORIZATION_TYPES,
			primaryType: 'TransferWithAuthorization',
			message,
			signature,
		});
		if (getAddress(recovered) === from) return true;
	} catch {
		// Not a 65-byte ECDSA signature (a smart account's proof can be any
		// length or an ERC-6492 wrapper), so let the on-chain check answer.
	}
	return client.verifyTypedData({
		address: from,
		domain,
		types: TRANSFER_WITH_AUTHORIZATION_TYPES,
		primaryType: 'TransferWithAuthorization',
		message,
		signature,
	});
}

// Verify an OKX/X Layer EIP-3009 payment end to end WITHOUT trusting any
// third party: typed-data signature (ERC-1271-aware via the public client, so
// smart-account agentic wallets verify too), recipient binding, amount, time
// window, unused nonce, and payer balance. Insufficient balance throws the
// exact `insufficient_balance` error string the approved sellers emit.
export async function verifyOkxXLayerPayment({ paymentPayload, requirement }) {
	const { auth, signature } = extractAuthorization(paymentPayload);
	if (!/^0x[0-9a-fA-F]+$/.test(signature)) {
		throw new X402Error('invalid_payment', 'signature must be 0x-prefixed hex', 402);
	}
	if (typeof auth.nonce !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(auth.nonce)) {
		throw new X402Error('invalid_payment', 'authorization.nonce must be 32-byte hex', 402);
	}

	const from = asAddress(auth.from, 'authorization.from');
	const to = asAddress(auth.to, 'authorization.to');
	const value = asBigInt(auth.value, 'authorization.value');
	const validAfter = asBigInt(auth.validAfter ?? '0', 'authorization.validAfter');
	const validBefore = asBigInt(auth.validBefore ?? '0', 'authorization.validBefore');

	const expectedTo = asAddress(requirement.payTo, 'requirement.payTo');
	if (to !== expectedTo) {
		throw new X402Error(
			'invalid_payment',
			`authorization.to ${to} does not match required payTo ${expectedTo}`,
			402,
		);
	}
	const required = asBigInt(requirement.amount, 'requirement.amount');
	if (value < required) {
		throw new X402Error(
			'invalid_payment',
			`authorized amount ${value} is below required ${required}`,
			402,
		);
	}
	const nowSec = BigInt(Math.floor(Date.now() / 1000));
	if (validAfter > nowSec) {
		throw new X402Error('invalid_payment', 'authorization is not yet valid (validAfter in the future)', 402);
	}
	if (validBefore <= nowSec) {
		throw new X402Error('invalid_payment', 'authorization has expired (validBefore in the past)', 402);
	}

	const asset = asAddress(requirement.asset || env.X402_ASSET_ADDRESS_XLAYER, 'requirement.asset');
	const client = xlayerClient();

	// EIP-712 signature check, in the order the TOKEN itself checks it (see
	// eip3009SignatureIsValid): plain ECDSA recovery first, ERC-1271/6492 only
	// when recovery does not name the payer. Domain name/version come from the
	// requirement's extra block (what the buyer signed against) with the
	// on-chain-verified USD₮0 defaults.
	let sigOk = false;
	try {
		sigOk = await eip3009SignatureIsValid({
			client,
			from,
			domain: {
				name: requirement.extra?.name || USDT0_DOMAIN_NAME,
				version: requirement.extra?.version || USDT0_DOMAIN_VERSION,
				chainId: XLAYER_CHAIN_ID,
				verifyingContract: asset,
			},
			message: {
				from,
				to,
				value,
				validAfter,
				validBefore,
				nonce: auth.nonce,
			},
			signature,
		});
	} catch (err) {
		throw new X402Error(
			'verify_failed',
			`X Layer signature verification errored: ${err.shortMessage || err.message}`,
			502,
		);
	}
	if (!sigOk) {
		throw new X402Error('invalid_payment', 'EIP-3009 signature does not verify for authorization.from', 402);
	}

	// On-chain state: the nonce must be unredeemed and the payer funded. These
	// are the checks behind the approved seller's `insufficient_balance` reply.
	let nonceUsed;
	let balance;
	try {
		[nonceUsed, balance] = await Promise.all([
			client.readContract({
				address: asset,
				abi: EIP3009_ABI,
				functionName: 'authorizationState',
				args: [from, auth.nonce],
			}),
			client.readContract({
				address: asset,
				abi: EIP3009_ABI,
				functionName: 'balanceOf',
				args: [from],
			}),
		]);
	} catch (err) {
		throw new X402Error(
			'verify_failed',
			`X Layer RPC state check failed: ${err.shortMessage || err.message}`,
			502,
		);
	}
	if (nonceUsed) {
		throw new X402Error('invalid_payment', 'authorization nonce has already been used', 402);
	}
	if (balance < value) {
		throw new X402Error('invalid_payment', 'insufficient_balance', 402);
	}

	// Facilitator pass, when the OKX SA API creds are configured, the official
	// facilitator gets the final word on validity (it is also the settlement
	// submitter). The local checks above stay as defense-in-depth, mirroring
	// how the CDP/PayAI paths cross-check facilitator answers.
	if (okxFacilitatorConfigured()) {
		let result;
		try {
			result = await okxFacilitator().verify(paymentPayload, requirement);
		} catch (err) {
			throw new X402Error(
				'facilitator_error',
				`OKX facilitator /verify failed: ${err.message}`,
				502,
			);
		}
		if (!result?.isValid) {
			throw new X402Error(
				'invalid_payment',
				`payment rejected by OKX facilitator: ${result?.invalidReason || result?.invalidMessage || 'unknown reason'}`,
				402,
			);
		}
	}

	return {
		isValid: true,
		payer: from,
		amount: value.toString(),
		authorization: { from, to, value: value.toString(), validAfter: validAfter.toString(), validBefore: validBefore.toString(), nonce: auth.nonce },
		signature,
		asset,
	};
}

function relayerAccount() {
	const key = env.X402_XLAYER_RELAYER_KEY;
	if (!key) {
		throw new X402Error(
			'settle_failed',
			'X Layer settlement requires X402_XLAYER_RELAYER_KEY (the relayer that redeems EIP-3009 authorizations)',
			500,
		);
	}
	const hex = key.startsWith('0x') ? key : `0x${key}`;
	try {
		return privateKeyToAccount(hex);
	} catch {
		throw new X402Error('settle_failed', 'X402_XLAYER_RELAYER_KEY is not a valid secp256k1 private key', 500);
	}
}

// Settle the verified payment. Primary route: the official OKX facilitator
// (POST /api/v6/pay/x402/settle, syncSettle:true), it broadcasts the
// EIP-3009 redemption and waits for confirmation. Fallback (no OKX creds):
// redeem directly, broadcast transferWithAuthorization from the relayer
// (OKB gas) and wait for inclusion. Both return the same {success,
// transaction, network, payer} shape the other facilitator paths yield, so
// X-PAYMENT-RESPONSE / PAYMENT-RESPONSE emission is identical.
export async function settleOkxXLayerPayment({ verified, requirement, paymentPayload }) {
	if (!verified?.authorization || !verified?.signature) {
		throw new X402Error('settle_failed', 'X Layer settle requires the verify step to run first', 500);
	}
	if (requirement.network !== NETWORK_XLAYER_MAINNET) {
		throw new X402Error(
			'settle_failed',
			`X Layer settle expected network ${NETWORK_XLAYER_MAINNET}, got ${requirement.network}`,
			500,
		);
	}
	if (okxFacilitatorConfigured()) {
		if (!paymentPayload) {
			throw new X402Error('settle_failed', 'facilitator settle requires the original paymentPayload', 500);
		}
		let result;
		try {
			result = await okxFacilitator().settle(paymentPayload, requirement);
		} catch (err) {
			throw new X402Error(
				'settle_failed',
				`OKX facilitator /settle failed: ${err.message}`,
				502,
			);
		}
		// syncSettle:true → status "success" with a confirmed tx. A "pending"
		// (async facilitator mode) still means the facilitator accepted the
		// settlement, surface it with the tx for /settle/status polling.
		if (!result?.success && result?.status !== 'pending') {
			throw new X402Error(
				'settle_failed',
				`OKX facilitator settle rejected: ${result?.errorReason || 'unknown reason'}`,
				502,
			);
		}
		return {
			success: true,
			transaction: result.transaction,
			network: result.network || NETWORK_XLAYER_MAINNET,
			payer: result.payer || verified.payer,
			...(result.status ? { status: result.status } : {}),
			amount: result.amount || verified.amount,
		};
	}
	const account = relayerAccount();
	const client = xlayerClient();
	const wallet = createWalletClient({
		account,
		chain: xLayer,
		transport: fallback(xlayerEndpoints().map((u) => http(u, { retryCount: 1 }))),
	});
	const a = verified.authorization;
	const baseArgs = [a.from, a.to, BigInt(a.value), BigInt(a.validAfter), BigInt(a.validBefore), a.nonce];
	const sig = verified.signature;
	const variants = [
		{ args: [...baseArgs, sig] },
		{ args: [...baseArgs, ...splitSignature(sig)] },
	];
	let lastErr = null;
	for (const variant of variants) {
		try {
			const { request } = await client.simulateContract({
				account,
				address: verified.asset,
				abi: EIP3009_ABI,
				functionName: 'transferWithAuthorization',
				args: variant.args,
			});
			const hash = await wallet.writeContract(request);
			const receipt = await client.waitForTransactionReceipt({ hash, timeout: 60_000 });
			if (receipt.status !== 'success') {
				throw new X402Error('settle_failed', `transferWithAuthorization reverted in tx ${hash}`, 502);
			}
			return {
				success: true,
				transaction: hash,
				network: NETWORK_XLAYER_MAINNET,
				payer: verified.payer,
				// Direct redemption waited for the receipt, the transfer is
				// confirmed, matching the facilitator's syncSettle "success".
				status: 'success',
				amount: verified.amount,
			};
		} catch (err) {
			if (err instanceof X402Error) throw err;
			lastErr = err;
		}
	}
	throw new X402Error(
		'settle_failed',
		`X Layer transferWithAuthorization failed: ${lastErr?.shortMessage || lastErr?.message || 'unknown'}`,
		502,
	);
}

function splitSignature(signature) {
	const hex = signature.slice(2);
	if (hex.length !== 130) {
		throw new X402Error('settle_failed', 'cannot split a non-65-byte signature into (v,r,s)', 502);
	}
	const r = `0x${hex.slice(0, 64)}`;
	const s = `0x${hex.slice(64, 128)}`;
	let v = parseInt(hex.slice(128, 130), 16);
	if (v < 27) v += 27;
	return [v, r, s];
}

// Live subsystem probe for the free health endpoint (WO-03's "real checks, not
// {ok:true}"): RPC liveness, fee-token readability, and whether the settlement
// relayer is configured + gas-funded. Never throws, health reports state.
export async function xlayerRailHealth() {
	const out = {
		network: NETWORK_XLAYER_MAINNET,
		payTo: env.X402_PAY_TO_XLAYER || null,
		asset: env.X402_ASSET_ADDRESS_XLAYER || null,
		settleable: xlayerSettleable(),
	};
	try {
		const client = xlayerClient();
		const [block, symbol] = await Promise.all([
			client.getBlockNumber(),
			client.readContract({
				address: env.X402_ASSET_ADDRESS_XLAYER,
				abi: [{ type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] }],
				functionName: 'symbol',
			}),
		]);
		out.rpc = { ok: true, block: block.toString() };
		out.token = { ok: true, symbol };
		out.facilitator = { configured: okxFacilitatorConfigured() };
		if (env.X402_XLAYER_RELAYER_KEY) {
			try {
				const relayer = relayerAccount();
				const gas = await client.getBalance({ address: relayer.address });
				out.relayer = { configured: true, address: relayer.address, okbWei: gas.toString(), funded: gas > 0n };
			} catch (err) {
				out.relayer = { configured: true, error: err.message };
			}
		} else {
			out.relayer = { configured: false };
		}
	} catch (err) {
		out.rpc = { ok: false, error: err.shortMessage || err.message };
	}
	return out;
}
