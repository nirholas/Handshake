#!/usr/bin/env node
// Check on-chain skill ownership against the live three.ws read endpoint, with
// no wallet, no signer, and no RPC of your own. Run it:
//
//   node example/verify-license.mjs [holder] [agentMint] [skill]
//
// Defaults to clearly-synthetic (but real 32-byte base58) placeholders, so the
// example runs as-is and answers "no license here" honestly. Swap in a real
// holder wallet and the agent's skill-collection mint to check a real license.

import { getLicense, skillSeed, verifyLicense, PROGRAM_ID } from '../src/index.js';

const [holder = 'HoLDeRwa11et1111111111111111111111111111111', agent = 'THREEsynthetic11111111111111111111111111111', skill = 'web-search'] =
	process.argv.slice(2);

console.log(`program  ${PROGRAM_ID}`);
console.log(`holder   ${holder}`);
console.log(`agent    ${agent}`);
console.log(`skill    ${skill}`);
console.log(`seed     sha256(skill) = ${await skillSeed(skill)}`);

// The headline check: one boolean, straight from chain state.
const owned = await verifyLicense({ holder, agent, skill });
console.log(`owned    ${owned}`);

// The full record. `null` means the PDA was never created (never purchased).
const license = await getLicense({ holder, agent, skill });
if (!license) {
	console.log('license  none on-chain for this triple (never purchased)');
} else {
	console.log(`license  ${license.license}`);
	console.log(`nftMint  ${license.nftMint}`);
	console.log(`revoked  ${license.revoked}`);
	console.log(`bought   ${license.purchaseDate}`);
	console.log(`explorer ${license.explorer}`);
}
