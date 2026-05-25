// Browser-safe Solana JSON-RPC proxy.
//
// Public RPC (api.mainnet-beta.solana.com) returns 403 to many browser
// requests, breaking /studio's launch panel (balance polling, tx send,
// confirmation). This proxy forwards JSON-RPC POSTs to Helius when
// HELIUS_API_KEY is set, otherwise to the public RPC server-side (which
// the Solana Labs nodes don't block from datacentre IPs the same way).
//
// Usage from browser:
//   new Connection('/api/solana-rpc')            -> mainnet
//   new Connection('/api/solana-rpc?net=devnet') -> devnet

import { cors, method, json, error } from './_lib/http.js';

const PUBLIC_MAINNET = 'https://api.mainnet-beta.solana.com';
const PUBLIC_DEVNET  = 'https://api.devnet.solana.com';

function upstreamUrl(network) {
	if (network === 'devnet') {
		return process.env.SOLANA_RPC_URL_DEVNET || PUBLIC_DEVNET;
	}
	return process.env.SOLANA_RPC_URL || PUBLIC_MAINNET;
}

export default async function handler(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: false })) return;
	if (!method(req, res, ['POST'])) return;

	const url = new URL(req.url, 'http://x');
	const network = url.searchParams.get('net') === 'devnet' ? 'devnet' : 'mainnet';

	let bodyText;
	try {
		const chunks = [];
		for await (const c of req) chunks.push(c);
		bodyText = Buffer.concat(chunks).toString('utf8');
	} catch (e) {
		return error(res, 400, 'bad_body', 'failed to read body');
	}
	if (!bodyText) return error(res, 400, 'empty_body', 'empty body');

	try {
		const r = await fetch(upstreamUrl(network), {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: bodyText,
		});
		const text = await r.text();
		res.statusCode = r.status;
		res.setHeader('content-type', 'application/json; charset=utf-8');
		res.setHeader('cache-control', 'no-store');
		res.end(text);
	} catch (e) {
		return error(res, 502, 'upstream_error', e.message || 'rpc upstream failed');
	}
}
