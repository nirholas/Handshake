// Meter an existing Express API with x402 — the one-liner path.
//
// Run:  node examples/express-metered-api.mjs        (PORT=3100 to move it)
// Then a buyer using @three-ws/x402-fetch calls /v1/embed with a plain fetch and
// the 402 is paid automatically. An unpaid curl shows the challenge:
//
//   curl -i http://localhost:3000/v1/embed -X POST \
//        -H 'content-type: application/json' -d '{"text":"hello"}'
//   → HTTP/1.1 402 Payment Required   (with a PAYMENT-REQUIRED header + accepts[])
//
// This points at the real platform facilitator. Swap payTo/feePayer for your own
// accounts (Solana needs a facilitator sponsor fee-payer; see the README).

import express from 'express';
import { paid } from '@three-ws/x402-server';

const app = express();
app.use(express.json());

// A synthetic pay-to + fee-payer so the example runs as-is. Replace with your
// own funded accounts before taking real payments.
const PAY_TO = { solana: 'THREEsynthetic1111111111111111111111111PayTo' };
const FEE_PAYER = 'THREEsynthetic1111111111111111111111FeePayer';

app.post(
	'/v1/embed',
	paid(
		{
			price: '2000',            // $0.002 in 6-decimal USDC atomics
			asset: 'usdc',
			payTo: PAY_TO,
			feePayer: FEE_PAYER,      // required for the Solana accept
			description: 'Text embedding',
			serviceName: 'Acme Embed',
			onSettled: (receipt) => console.log('settled:', receipt.transaction),
		},
		// Deliver-then-settle: write your response normally. The wrapper buffers
		// it, settles the payment, then flushes the 200 with the X-PAYMENT-RESPONSE
		// receipt attached — the buyer never gets the good before settlement.
		async (req, res, payment) => {
			const vector = await embed(req.body?.text ?? '');
			res.json({ vector, billedTo: payment.payer });
		},
	),
);

const PORT = Number(process.env.PORT || 3000);

app
	.listen(PORT, () => console.log(`paid embed API on http://localhost:${PORT}/v1/embed`))
	.on('error', (err) => {
		// A busy port is the one failure that reads like a bug in the package.
		if (err.code === 'EADDRINUSE') {
			console.error(`port ${PORT} is already in use. Rerun with PORT=<free port>`);
			process.exit(1);
		}
		throw err;
	});

// Stand-in for your real model call. Replace with the actual work.
async function embed(text) {
	const seed = [...String(text)].reduce((a, c) => a + c.charCodeAt(0), 0);
	return Array.from({ length: 8 }, (_, i) => Number((Math.sin(seed + i) / 2 + 0.5).toFixed(4)));
}
