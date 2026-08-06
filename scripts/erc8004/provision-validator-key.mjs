#!/usr/bin/env node
/**
 * Provision the platform ValidationRegistry validator key.
 *
 * Generates a fresh EVM keypair used to sign glTF/schema validation
 * attestations (validationResponse). The PRIVATE KEY is printed to STDERR only and
 * is NEVER written to the repo: capture it from the terminal and store it as the
 * `VALIDATOR_PRIVATE_KEY` secret on the three-ws-api Cloud Run service (and
 * .env.local for local runs).
 *
 * The ADDRESS is printed to STDOUT. The deployed registry has no allowlist, so
 * there is nothing to add it to: fund it with gas on each chain it attests on,
 * record it in DEPLOYMENTS.md, and have agent owners either request it or approve
 * it as an operator (see docs/erc8004/validation-attestation.md).
 *
 * Usage:
 *   node scripts/erc8004/provision-validator-key.mjs            # generate fresh
 *   node scripts/erc8004/provision-validator-key.mjs --address  # print address of an existing key
 *     VALIDATOR_PRIVATE_KEY=0x… node scripts/erc8004/provision-validator-key.mjs --address
 */

import { Wallet } from 'ethers';

const addressOnly = process.argv.includes('--address');

if (addressOnly) {
	const pk = process.env.VALIDATOR_PRIVATE_KEY || process.env.ERC8004_VALIDATOR_PRIVATE_KEY;
	if (!pk) {
		console.error('Set VALIDATOR_PRIVATE_KEY to print its address.');
		process.exit(1);
	}
	const w = new Wallet(pk.trim());
	process.stdout.write(`${w.address}\n`);
	process.exit(0);
}

const wallet = Wallet.createRandom();

// Secret → stderr only. Do not pipe stderr into any committed file.
console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.error(' PLATFORM VALIDATOR KEY (SECRET — store in Vercel, never commit)');
console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.error(`  VALIDATOR_PRIVATE_KEY=${wallet.privateKey}`);
console.error(`  mnemonic:             ${wallet.mnemonic?.phrase || '(n/a)'}`);
console.error('');
console.error(' Next steps:');
console.error('  1. vercel env add VALIDATOR_PRIVATE_KEY  (production + preview)');
console.error('  2. Fund the address with gas on each ValidationRegistry chain.');
console.error('  3. As the registry owner, allow-list it on each chain:');
console.error(`        cast send <ValidationRegistry> "addValidator(address)" ${wallet.address} --rpc-url <chain>`);
console.error('  4. Record the address in contracts/DEPLOYMENTS.md.');
console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

// Address → stdout (safe to capture/log).
process.stdout.write(`${wallet.address}\n`);
