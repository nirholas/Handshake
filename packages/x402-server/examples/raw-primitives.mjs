// Drive the four primitives directly — no paid() middleware.
//
// Use this when you need full control of the request lifecycle (a custom
// framework, a queue worker, a non-HTTP transport). The order is load-bearing:
// verify → run the work → settle. Settlement is always last, so a handler that
// throws never charges.
//
// Run:  node examples/raw-primitives.mjs   (prints the challenge this route emits)

import {
	buildChallenge,
	verifyPayment,
	settlePayment,
	feeSplit,
} from '@three-ws/x402-server';

const PAY_TO = { solana: 'THREEsynthetic1111111111111111111111111PayTo' };
const FEE_PAYER = 'THREEsynthetic1111111111111111111111FeePayer';
const TREASURY = 'TREASURYsynthetic111111111111111111111Treasury';

// The exact 402 envelope this resource would emit on an unpaid request.
const challenge = buildChallenge({
	price: '50000',            // $0.05 USDC
	asset: 'usdc',
	payTo: PAY_TO,
	feePayer: FEE_PAYER,
	feeBps: 250,               // 2.5% platform fee, carved OUT of the price
	feeTo: TREASURY,
	resourceUrl: 'https://your.api/summarize',
	description: 'Document summarization',
});

console.log('402 challenge envelope:\n', JSON.stringify(challenge, null, 2));
console.log('\nfee split on this price:', feeSplit('50000', 250, TREASURY));

// The request handler you'd wire into your framework.
export async function handle(req, res) {
	const header = req.headers['x-payment'];

	// 1 — no payment yet → answer with the challenge (body + base64 header).
	if (!header) {
		res.statusCode = 402;
		res.setHeader('PAYMENT-REQUIRED', Buffer.from(JSON.stringify(challenge)).toString('base64'));
		res.setHeader('content-type', 'application/json');
		return res.end(JSON.stringify(challenge));
	}

	// 2 — verify against the same accepts we advertised. No work runs unless ok.
	const verified = await verifyPayment({ paymentHeader: header, requirements: challenge.accepts });
	if (!verified.ok) {
		res.statusCode = verified.status || 402;
		return res.end(JSON.stringify(verified.body));
	}

	// 3 — run the work, THEN settle. Never settle before the work succeeds.
	const summary = await summarize(req.body?.text ?? '');
	const receipt = await settlePayment({ verified });

	res.setHeader('X-PAYMENT-RESPONSE', Buffer.from(JSON.stringify(receipt)).toString('base64'));
	res.setHeader('content-type', 'application/json');
	res.end(JSON.stringify({ summary, payer: verified.payer, tx: receipt.transaction }));
}

async function summarize(text) {
	return String(text).split(/\s+/).slice(0, 12).join(' ') + (text ? ' …' : '');
}
