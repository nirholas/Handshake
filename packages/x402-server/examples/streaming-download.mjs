// A paid file download with streaming:true (settle-then-stream).
//
// Some responses can't be buffered — a large binary, an SSE stream, a res.pipe.
// For those, set `streaming: true`: the wrapper settles the payment FIRST, emits
// the X-PAYMENT-RESPONSE receipt header up-front, then hands you the raw response
// to write however you like. Your handler is paid by construction before the
// first byte ships.
//
// Run:  node examples/streaming-download.mjs        (PORT=3111 to move it)
//   curl -i http://localhost:3001/download        → 402 challenge
//   (a paid retry streams the file with the receipt header already set)

import http from 'node:http';
import { paid } from '@three-ws/x402-server';

// Synthetic accounts so the example runs as-is. Replace with your own funded
// ones before taking real payments.
const PAY_TO = {
	solana: 'THREEsynthetic1111111111111111111111111PayTo',
	base: '0x00000000000000000000000000000000DeaDBeef',
};
const FEE_PAYER = 'THREEsynthetic1111111111111111111111FeePayer';

const handler = paid(
	{
		price: '100000',            // $0.10 USDC
		asset: 'usdc',
		payTo: PAY_TO,
		feePayer: FEE_PAYER,        // required for the Solana accept
		network: ['solana', 'base'], // Solana leads, Base follows
		streaming: true,            // settle up-front, then stream the body
		description: 'Dataset export (CSV)',
	},
	async (_req, res) => {
		// The X-PAYMENT-RESPONSE header is already set — just stream.
		res.setHeader('content-type', 'text/csv');
		res.setHeader('content-disposition', 'attachment; filename="export.csv"');
		res.write('id,value\n');
		for (let i = 0; i < 5; i++) res.write(`${i},${(i * 1.5).toFixed(2)}\n`);
		res.end();
	},
);

const PORT = Number(process.env.PORT || 3001);

http
	.createServer(handler)
	.listen(PORT, () => console.log(`paid streaming download on http://localhost:${PORT}/download`))
	.on('error', (err) => {
		// A busy port is the one failure that reads like a bug in the package.
		if (err.code === 'EADDRINUSE') {
			console.error(`port ${PORT} is already in use. Rerun with PORT=<free port>`);
			process.exit(1);
		}
		throw err;
	});
