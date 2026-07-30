// Real paid x402 call with @three-ws/x402-fetch.
//
// Wraps a private-key wallet in withX402() and calls a live three.ws Market
// Data endpoint. On the 402 challenge the wrapper signs a USDC-on-Base
// EIP-3009 authorization and retries with the X-PAYMENT header, so the await
// below resolves with the unlocked data.
//
// THIS SPENDS REAL MONEY: $0.001 USDC from the wallet behind PRIVATE_KEY.
// The wallet needs USDC on Base mainnet. Run it with:
//
//   PRIVATE_KEY=0x... node examples/paid-call.mjs
//
// Installed consumers import from '@three-ws/x402-fetch' instead of ../src/.

import { withX402, privateKeyToWallet } from '../src/index.js';

const pk = process.env.PRIVATE_KEY;
if (!pk) {
	console.error('PRIVATE_KEY is not set.');
	console.error('Export a funded Base-mainnet private key (0x-hex, holds USDC) and rerun:');
	console.error('  PRIVATE_KEY=0x... node examples/paid-call.mjs');
	console.error('This example makes a real $0.001 USDC payment; there is no dry-run mode.');
	process.exit(1);
}

const ENDPOINT = process.env.X402_ENDPOINT || 'https://three.ws/api/x402/market-global';

const pay = withX402(privateKeyToWallet(pk), {
	// Hard spend ceiling per request. The endpoint costs $0.001; anything above
	// this limit throws instead of paying.
	maxPaymentUsd: 0.01,
	onPayment: ({ amount, to, requestUrl }) => {
		console.log(`paying $${amount} USDC to ${to} for ${requestUrl}`);
	},
});

console.log(`GET ${ENDPOINT} (auto-paying on 402)`);
const res = await pay(ENDPOINT);
console.log(`HTTP ${res.status} ${res.statusText}`);

const receipt = res.headers.get('x-payment-response');
if (receipt) console.log(`settle receipt (base64): ${receipt.slice(0, 60)}...`);

const data = await res.json();
console.log('\nUnlocked payload:');
console.log(JSON.stringify(data, null, 2));
