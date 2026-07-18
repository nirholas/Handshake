// End-to-end, offline: a paid server + a buyer, wired to a LOCAL stub
// facilitator so the whole 402 → verify → work → settle → receipt loop runs on
// your machine with no accounts, keys, or network. This is a learning harness
// (the package's own tests use the same local-facilitator technique), not a
// production setup — real deployments point `facilitator` at a live settlement
// service that moves real funds.
//
// Run:  node examples/loopback-demo.mjs

import http from 'node:http';
import { createX402Server } from '@three-ws/x402-server';

const NETWORK = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const PAY_TO = 'THREEsynthetic1111111111111111111111111PayTo';
const FEE_PAYER = 'THREEsynthetic1111111111111111111111FeePayer';

// 1) A local stand-in for the settlement facilitator. It always approves; a real
//    facilitator verifies the signed payment on-chain and settles it.
const facilitator = http.createServer((req, res) => {
	let raw = '';
	req.on('data', (c) => (raw += c));
	req.on('end', () => {
		const body =
			req.url === '/verify'
				? { isValid: true, payer: 'BuyerWallet1111111111111111111111111111111' }
				: { success: true, transaction: 'LOCAL_TX_SIGNATURE', network: NETWORK, payer: 'BuyerWallet1111111111111111111111111111111' };
		res.setHeader('content-type', 'application/json');
		res.end(JSON.stringify(body));
	});
});

// 2) The paid resource, pointed at the local facilitator.
async function main() {
	const facUrl = await listen(facilitator);
	const server = createX402Server({ facilitator: facUrl });

	const paidHandler = server.paid(
		{
			price: '50000', // $0.05 USDC
			asset: 'usdc',
			payTo: { solana: PAY_TO },
			feePayer: FEE_PAYER,
			description: 'Premium data',
			onSettled: (receipt) => console.log('  [server] settled tx:', receipt.transaction),
		},
		async (req, res, payment) => {
			console.log('  [server] work runs for payer:', payment.payer);
			res.json = (o) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
			res.json({ good: 'the premium data', paidBy: payment.payer });
		},
	);

	const app = http.createServer(paidHandler);
	const appUrl = await listen(app);
	const resource = `${appUrl}/api/premium`;

	// 3) Buyer, round one: no payment → receives the 402 challenge.
	console.log('\n[buyer] GET with no payment…');
	const challengeRes = await fetch(resource);
	const challenge = await challengeRes.json();
	console.log(`  [buyer] ${challengeRes.status} — accepts ${challenge.accepts.length} lane(s):`,
		challenge.accepts.map((a) => `${a.extra.name} on ${a.network.split(':')[0]}`).join(', '));

	// 4) Buyer, round two: attach an X-PAYMENT header and retry. (A real buyer
	//    signs the on-chain payment here — e.g. via @three-ws/x402-fetch. We hand
	//    the stub facilitator a placeholder payload.)
	const xPayment = Buffer.from(
		JSON.stringify({ x402Version: 2, network: NETWORK, payload: { transaction: 'signed-by-buyer-wallet' } }),
	).toString('base64');

	console.log('\n[buyer] retrying with X-PAYMENT…');
	const paidRes = await fetch(resource, { headers: { 'x-payment': xPayment } });
	const good = await paidRes.json();
	const receipt = JSON.parse(Buffer.from(paidRes.headers.get('x-payment-response'), 'base64').toString());

	console.log(`  [buyer] ${paidRes.status} — good:`, good);
	console.log('  [buyer] X-PAYMENT-RESPONSE receipt tx:', receipt.transaction);

	facilitator.close();
	app.close();
	console.log('\nDone. verify → work → settle → receipt, all local.');
}

function listen(srv) {
	return new Promise((resolve) => srv.listen(0, () => resolve(`http://127.0.0.1:${srv.address().port}`)));
}

main().catch((err) => { console.error(err); process.exit(1); });
