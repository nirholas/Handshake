#!/usr/bin/env node
// Render the x402 discovery catalog (the same document api/wk.js serves at
// /.well-known/x402.json) to a local JSON file WITHOUT a deploy, so a catalog
// change can be validated offline before it ships:
//
//   node scripts/build-x402-catalog.mjs > /tmp/x402.json
//   node scripts/verify-x402-discovery.mjs --file=/tmp/x402.json
//
// That two-step is the pre-deploy guard for the discovery catalog — a stray
// newline in a payTo or a bazaar.info that fails its own schema delists every
// resource, and waiting to find out from the live crawler is too late.
//
// Usage:
//   node scripts/build-x402-catalog.mjs                  # print JSON to stdout
//   node scripts/build-x402-catalog.mjs --out=path.json  # write to a file

import { config as dotenv } from 'dotenv';

const args = process.argv.slice(2);
const outPath = args.find((a) => a.startsWith('--out='))?.slice('--out='.length) || null;

// Load the local secrets BEFORE importing the discovery builder. Without
// DATABASE_URL the builder logs "agent services unavailable" and silently drops
// every DB-backed agent resource, so the pre-deploy guard validated a strict
// subset of what production actually publishes: a malformed agent listing would
// sail through here and only surface once the crawler delisted it. dotenv never
// overrides an already-set var, so a CI shell or an operator export still wins,
// and a machine with no .env degrades to exactly the previous behavior.
dotenv({ path: new URL('../.env', import.meta.url), quiet: true });
dotenv({ path: new URL('../.env.local', import.meta.url), quiet: true });

// The discovery builder reads these at import time. Use the same well-formed
// placeholders the discovery-parity test uses so both Base and Solana accepts
// are advertised and APP_ORIGIN resolves. No CDP creds means Permit2 siblings
// are omitted, matching production's non-CDP behavior. Real env (in prod/CI
// with secrets, or the .env loaded above) overrides these.
const DEFAULTS = {
	APP_ORIGIN: 'https://three.ws',
	X402_PAY_TO_BASE: '0x0000000000000000000000000000000000000001',
	X402_PAY_TO_SOLANA: 'So11111111111111111111111111111111111111112',
	X402_ASSET_ADDRESS_BASE: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
	X402_ASSET_MINT_SOLANA: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
	X402_ASSET_ADDRESS_ARBITRUM: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
	X402_MAX_AMOUNT_REQUIRED: '1000',
	X402_FEE_PAYER_SOLANA: 'So11111111111111111111111111111111111111112',
};
for (const [k, v] of Object.entries(DEFAULTS)) if (!process.env[k]) process.env[k] = v;

async function main() {
	const mod = await import('../api/wk.js');
	const res = {
		statusCode: 0,
		headers: {},
		setHeader(k, v) {
			this.headers[k.toLowerCase()] = v;
		},
		end(body) {
			this.body = body;
		},
	};
	const req = {
		method: 'GET',
		url: '/.well-known/x402-discovery?name=x402-discovery',
		query: { name: 'x402-discovery' },
		headers: {},
	};
	await mod.default(req, res);
	if (!res.body) throw new Error('discovery handler produced no body');
	// Re-serialize pretty so a committed/inspected snapshot is diff-friendly.
	const pretty = JSON.stringify(JSON.parse(res.body), null, 2);
	if (outPath) {
		const { writeFile } = await import('node:fs/promises');
		await writeFile(outPath, pretty + '\n');
		const doc = JSON.parse(pretty);
		process.stderr.write(`wrote ${doc.resources?.length ?? 0} resources → ${outPath}\n`);
	} else {
		process.stdout.write(pretty + '\n');
	}
}

main().catch((err) => {
	process.stderr.write(`✗ ${err.message}\n`);
	process.exit(1);
});
