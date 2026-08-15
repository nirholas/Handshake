// Zero-spend x402 discovery probe.
//
// Requests a live paid three.ws endpoint WITHOUT a payment header, receives the
// HTTP 402 challenge, and prints what the server wants: price, network, asset,
// and pay-to address for every payment rail it accepts. No wallet, no key, no
// money moves. Run it with:
//
//   node examples/discover.mjs
//
// The endpoint below is one of the three.ws Market Data endpoints; the full
// catalog is free at https://three.ws/api/x402/market

const ENDPOINT = process.env.X402_ENDPOINT || 'https://three.ws/api/x402/market-global';

const res = await fetch(ENDPOINT);
console.log(`GET ${ENDPOINT}`);
console.log(`HTTP ${res.status} ${res.statusText}`);

if (res.status !== 402) {
	console.log('No payment challenge returned; the endpoint answered without one.');
	console.log(await res.text());
	process.exit(0);
}

// three.ws ships the x402 v2 envelope both as the JSON body and, base64-encoded,
// in the PAYMENT-REQUIRED response header. The body is the easy path here.
const challenge = await res.json();

console.log(`\nx402 version: ${challenge.x402Version}`);
console.log(`resource:     ${challenge.resource?.url}`);
console.log(`description:  ${challenge.resource?.description?.slice(0, 120)}...`);
console.log(`\naccepts[] (${challenge.accepts.length} payment rails):\n`);

for (const accept of challenge.accepts) {
	const decimals = Number(accept.extra?.decimals ?? 6);
	const token = accept.extra?.name ?? 'unknown';
	const units = Number(accept.amount) / 10 ** decimals;
	// Only a dollar-pegged stablecoin's atomic units convert straight to USD; a
	// non-stable accept (e.g. $THREE) is priced in its own token, so printing a
	// "$" in front of it would be a lie about what the call costs.
	const priced = /^usd/i.test(token) ? `$${units}` : `${units} ${token}`;
	const method =
		accept.extra?.assetTransferMethod ||
		(String(accept.network).startsWith('eip155:') ? 'eip3009 (default)' : 'native to network');
	console.log(`  scheme:  ${accept.scheme}`);
	console.log(`  network: ${accept.network}`);
	console.log(`  asset:   ${accept.asset} (${token})`);
	console.log(`  amount:  ${accept.amount} atomic units = ${priced} (${decimals} decimals)`);
	console.log(`  payTo:   ${accept.payTo}`);
	console.log(`  method:  ${method}`);
	console.log('');
}

console.log('Nothing was paid. See paid-call.mjs to actually answer the challenge.');
