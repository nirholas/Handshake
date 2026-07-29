#!/usr/bin/env node
// Read-only preview of the master → USDC-engine topup (api/_lib/economy-usdc-topup.js).
//
// Prints live master + engine USDC balances and the exact plan the next
// treasury-topup tick would execute, without signing anything. Run from the repo
// root: `node scripts/dry-usdc-topup.mjs`.
import { readFileSync } from 'node:fs';

for (const line of readFileSync('.env', 'utf8').split('\n')) {
	const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
	if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { solanaConnection } = await import('../api/_lib/solana/connection.js');
const { topUpUsdcEngines } = await import('../api/_lib/economy-usdc-topup.js');

const connection = solanaConnection({ url: process.env.SOLANA_RPC_URL, network: 'mainnet', commitment: 'confirmed' });
const out = await topUpUsdcEngines({ connection, network: 'mainnet', dryRun: true });
console.log(JSON.stringify(out, null, 2));
