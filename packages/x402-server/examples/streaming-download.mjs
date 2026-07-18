// A paid file download with streaming:true (settle-then-stream).
//
// Some responses can't be buffered — a large binary, an SSE stream, a res.pipe.
// For those, set `streaming: true`: the wrapper settles the payment FIRST, emits
// the X-PAYMENT-RESPONSE receipt header up-front, then hands you the raw response
// to write however you like. Your handler is paid by construction before the
// first byte ships.
//
// Run:  node examples/streaming-download.mjs
//   curl -i http://localhost:3001/download        → 402 challenge
//   (a paid retry streams the file with the receipt header already set)

import http from 'node:http';
import { paid } from '@three-ws/x402-server';

const PAY_TO = { base: '0x00000000000000000000000000000000DeaDBeef' };

const handler = paid(
	{
		price: '100000',            // $0.10 USDC
		asset: 'usdc',
		payTo: PAY_TO,
		network: ['base'],
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

http.createServer(handler).listen(3001, () =>
	console.log('paid streaming download on http://localhost:3001/download'),
);
