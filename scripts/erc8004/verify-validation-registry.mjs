#!/usr/bin/env node
/**
 * Prove that the ValidationRegistry address we configure per chain really answers
 * the interface our code calls.
 *
 * This check exists because an address that looks right is not proof: the ERC-8004
 * reference registries and our own contracts/src/ValidationRegistry.sol both use
 * 0x8004-vanity addresses, and for a while the platform pointed at the reference
 * deployment while calling our contract's functions. Every call reverted, and the
 * read path treats a revert as "no attestation yet", so the feature looked idle
 * instead of broken.
 *
 * What it does, per chain in api/_lib/erc8004-chains.js that carries a registry:
 *   1. eth_getCode the address (following an ERC-1967 proxy to its implementation).
 *   2. Assert every function selector in VALIDATION_REGISTRY_ABI is present in the
 *      implementation bytecode.
 *   3. Exercise the two read calls the badge depends on, live.
 *
 * Usage:
 *   node scripts/erc8004/verify-validation-registry.mjs               # every configured chain
 *   node scripts/erc8004/verify-validation-registry.mjs 84532 11155111
 *
 * Exit code 0 = every configured registry matches; 1 = at least one mismatch.
 */

import { Contract, Interface, JsonRpcProvider, Network, id as keccakId } from 'ethers';

import { CHAINS, VALIDATION_REGISTRY_ABI } from '../../api/_lib/erc8004-chains.js';

// ERC-1967 implementation slot: keccak256("eip1967.proxy.implementation") - 1.
const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const ZERO = '0x0000000000000000000000000000000000000000';

const iface = new Interface(VALIDATION_REGISTRY_ABI);
const FUNCTIONS = iface.fragments
	.filter((f) => f.type === 'function')
	.map((f) => ({ signature: f.format('sighash'), selector: keccakId(f.format('sighash')).slice(2, 10) }));

const wanted = process.argv.slice(2).map(Number).filter(Boolean);
const targets = CHAINS.filter((c) => c.validationRegistry && (!wanted.length || wanted.includes(c.id)));
const skipped = CHAINS.filter((c) => !c.validationRegistry && (!wanted.length || wanted.includes(c.id)));

if (!targets.length) {
	console.log('No chain in the table has a ValidationRegistry address configured. Nothing to verify.');
	process.exit(0);
}

let failures = 0;

for (const chain of targets) {
	const label = `${chain.name} (${chain.id})`;
	const network = Network.from(chain.id);
	let provider;
	try {
		provider = new JsonRpcProvider(chain.rpcUrls[0], network, { staticNetwork: network });
	} catch (err) {
		console.log(`SKIP ${label}: no usable RPC (${err.message})`);
		continue;
	}

	let code;
	try {
		code = await provider.getCode(chain.validationRegistry);
	} catch (err) {
		console.log(`SKIP ${label}: RPC unreachable (${err.shortMessage || err.message})`);
		continue;
	}
	if (!code || code === '0x') {
		console.log(`FAIL ${label}: no contract at ${chain.validationRegistry}`);
		failures++;
		continue;
	}

	// Follow a proxy so the selector scan sees the real implementation.
	let scanned = chain.validationRegistry;
	const slot = await provider.getStorage(chain.validationRegistry, IMPL_SLOT).catch(() => null);
	if (slot && slot !== `0x${'0'.repeat(64)}`) {
		const impl = `0x${slot.slice(26)}`;
		if (impl !== ZERO) {
			scanned = impl;
			code = await provider.getCode(impl);
		}
	}

	const missing = FUNCTIONS.filter((f) => !code.includes(f.selector));
	if (missing.length) {
		console.log(`FAIL ${label}: ${chain.validationRegistry} (impl ${scanned}) is missing ${missing.length} of ${FUNCTIONS.length} functions:`);
		for (const m of missing) console.log(`       ${m.signature}`);
		failures++;
		continue;
	}

	// Live reads, so a selector that exists but decodes differently still fails.
	const registry = new Contract(chain.validationRegistry, VALIDATION_REGISTRY_ABI, provider);
	try {
		const list = await registry.getAgentValidations(1n);
		const summary = await registry.getSummary(1n, [], 'glb-schema');
		console.log(
			`OK   ${label}: ${chain.validationRegistry} answers all ${FUNCTIONS.length} functions ` +
				`(agent 1: ${list.length} validations, summary count ${summary[0]})`,
		);
	} catch (err) {
		console.log(`FAIL ${label}: reads do not decode (${err.shortMessage || err.message})`);
		failures++;
	}
}

for (const chain of skipped) {
	console.log(`----  ${chain.name} (${chain.id}): no registry configured, badge renders nothing there`);
}

if (failures) {
	console.error(`\n${failures} chain(s) do not match VALIDATION_REGISTRY_ABI. Fix the address or the ABI before shipping.`);
	process.exit(1);
}
console.log('\nEvery configured ValidationRegistry matches the ABI this platform calls.');
