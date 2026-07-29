#!/usr/bin/env node
// Probe every EVM RPC endpoint the platform would use for a chain, in the exact
// priority order api/_lib/evm/rpc.js resolves them, and report which ones
// actually answer a keyless server-side POST.
//
// This exists because a dead endpoint pinned at the front of the list is
// invisible in normal operation (failover hides it) right up until a
// multi-call flow runs out of timeout budget. That is exactly how
// GET /api/v1/resolve?name=<x>.eth started 503ing in production: the operator's
// RPC_URL_ETHEREUM pointed at a host that Cloudflare bot-walls with a 403, so
// every ENS round trip burned a failed request before doing real work.
//
// Usage:
//   node scripts/probe-evm-rpc.mjs                 # chain 1 (Ethereum mainnet)
//   node scripts/probe-evm-rpc.mjs --chain 8453    # Base
//   node scripts/probe-evm-rpc.mjs --chain 1 --ens # also time a real ENS lookup
//
// Load env first so operator overrides and Alchemy keys are honored:
//   node --env-file=.env scripts/probe-evm-rpc.mjs
//
// Exit code is 1 if any endpoint that is NOT demoted fails, so this can gate a
// deploy or run from an ops check.

import { evmRpcEndpoints, evmTransport, isDemotedEndpoint } from '../api/_lib/evm/rpc.js';
import { env } from '../api/_lib/env.js';

const args = process.argv.slice(2);
const chainId = Number(args[args.indexOf('--chain') + 1]) || 1;
const withEns = args.includes('--ens');
const TIMEOUT_MS = 8000;

function redact(url) {
	return url.replace(/\/v2\/[^/?]+/, '/v2/***').replace(/(api[_-]?key=)[^&]+/i, '$1***');
}

async function probe(url) {
	const started = Date.now();
	try {
		const res = await fetch(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		const ms = Date.now() - started;
		const body = await res.json().catch(() => null);
		if (!res.ok) return { ok: false, ms, detail: `HTTP ${res.status}` };
		// Some hosts answer 200 with a JSON-RPC error (keyless Ankr says
		// "Unauthorized"), which is a failure that only shows up after parsing.
		if (body?.error) return { ok: false, ms, detail: `rpc error: ${String(body.error.message).slice(0, 60)}` };
		if (!body?.result) return { ok: false, ms, detail: 'no result field' };
		return { ok: true, ms, detail: `block ${parseInt(body.result, 16)}` };
	} catch (err) {
		return { ok: false, ms: Date.now() - started, detail: err.message };
	}
}

const primaryUrl = chainId === 1 ? env.MAINNET_RPC_URL : null;
const urls = evmRpcEndpoints(chainId, primaryUrl);
console.log(`chain ${chainId}: ${urls.length} endpoint(s), in resolution order\n`);

let answered = 0;
let regressions = 0;
for (const [i, url] of urls.entries()) {
	const { ok, ms, detail } = await probe(url);
	const demoted = isDemotedEndpoint(url);
	if (ok) answered += 1;
	// A demoted endpoint failing is the documented status quo, not news. A
	// healthy-listed endpoint failing is what this check exists to catch.
	else if (!demoted) regressions += 1;
	const label = ok ? 'ok  ' : demoted ? 'dead' : 'FAIL';
	const suffix = demoted ? '  (demoted, last resort)' : '';
	console.log(`${label} ${String(i + 1).padStart(2)}. ${redact(url).padEnd(52)} ${String(ms).padStart(5)}ms  ${detail}${suffix}`);
}

if (withEns) {
	const { createPublicClient } = await import('viem');
	const { mainnet } = await import('viem/chains');
	const { normalize } = await import('viem/ens');
	const client = createPublicClient({
		chain: mainnet,
		transport: evmTransport(1, { primaryUrl, timeout: 2500, retryCount: 0 }),
	});
	const started = Date.now();
	const address = await client.getEnsAddress({ name: normalize('vitalik.eth') });
	console.log(`\nENS vitalik.eth -> ${address} (${Date.now() - started}ms)`);
}

console.log(`\n${answered}/${urls.length} endpoints answered${regressions ? `, ${regressions} unexpected failure(s)` : ''}.`);
// Fail only on an unexpected failure, or when nothing answers at all.
process.exit(regressions > 0 || answered === 0 ? 1 : 0);
