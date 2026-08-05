#!/usr/bin/env node
/**
 * Deploy three.ws agents on-chain as Metaplex Core assets — CLI runner.
 * ---------------------------------------------------------------------------
 * The mint logic lives in api/_lib/onchain-deploy.js, so every caller of it
 * produces identical on-chain assets.
 *
 * Start small (a 2-3 agent canary), verify on Solscan, then scale up.
 *
 * Usage (env comes from .env via Node's --env-file):
 *   # preview which agents would deploy — no SOL, no writes:
 *   node --env-file=.env scripts/deploy-agents-onchain.mjs --limit 3 --dry-run
 *
 *   # real devnet run:
 *   node --env-file=.env scripts/deploy-agents-onchain.mjs --network devnet --limit 3 --confirm
 *
 *   # real mainnet run (spends SOL — requires --confirm):
 *   node --env-file=.env scripts/deploy-agents-onchain.mjs --limit 3 --confirm
 *
 * Re-runs are safe: already-deployed agents are skipped automatically.
 */

import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import {
	authoritySecret,
	buildAuthorityUmi,
	funderLamports,
	fetchUndeployedAgents,
	resolveAgentCollection,
	loadCollectionAsset,
	deployAgentOnce,
	explorerUrl,
	EST_MINT_LAMPORTS,
} from '../api/_lib/onchain-deploy.js';

function arg(name, fallback) {
	const i = process.argv.indexOf(name);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
function flag(name) {
	return process.argv.includes(name);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sol = (lamports) => (lamports / LAMPORTS_PER_SOL).toFixed(4);

async function main() {
	const network = arg('--network', 'mainnet') === 'devnet' ? 'devnet' : 'mainnet';
	const limit = Math.min(500, Math.max(1, Number(arg('--limit', '3'))));
	const dryRun = flag('--dry-run');
	const confirmed = flag('--confirm');

	console.log('\nthree.ws — on-chain agent deploy (Metaplex Core)');
	console.log(`  network: ${network}   limit: ${limit}   ${dryRun ? 'DRY RUN' : 'LIVE'}`);

	if (!authoritySecret()) {
		console.error('\n✗ Set SOLANA_AGENT_COLLECTION_AUTHORITY_KEY (or LAUNCH_FUNDER_SECRET) in .env.');
		process.exit(1);
	}

	const { umi, authoritySigner } = buildAuthorityUmi(network);
	const authorityPk = authoritySigner.publicKey;
	const balance = await funderLamports(umi, authorityPk);
	console.log(`  funder:  ${authorityPk.toString()}  (${sol(balance)} SOL)\n`);

	const agents = await fetchUndeployedAgents(network, limit);
	console.log(`Found ${agents.length} agent(s) without an on-chain identity on ${network}:`);
	for (const a of agents) console.log(`  • ${a.name || 'Agent'}  (${String(a.id).slice(0, 8)})`);

	if (agents.length === 0) {
		console.log('\nNothing to do — every agent is already on-chain.');
		return;
	}

	if (dryRun) {
		console.log('\nDry run — no SOL spent, no writes. Re-run with --confirm to deploy.');
		return;
	}

	if (!confirmed) {
		console.error('\n✗ Refusing a live run without --confirm (it spends real SOL). Add --confirm to proceed.');
		process.exit(1);
	}

	// Resolve (or deploy) the collection up front.
	const collectionAddr = await resolveAgentCollection({
		umi,
		authoritySigner,
		network,
		onEvent: (_t, d) => console.log(`Collection [${d.source}]: ${d.address}${d.signature ? `  (deploy sig ${d.signature.slice(0, 12)}…)` : ''}`),
	});
	const collectionAsset = await loadCollectionAsset(umi, collectionAddr);
	console.log('');

	let deployed = 0, errors = 0;
	for (const agent of agents) {
		const name = agent.name || 'Agent';
		const bal = await funderLamports(umi, authorityPk);
		if (bal < EST_MINT_LAMPORTS + 5000) {
			console.log(`\n⏸ Paused — funder low on SOL (${sol(bal)}). Top up and re-run.`);
			break;
		}
		process.stdout.write(`[${deployed + errors + 1}/${agents.length}] ${name} … `);
		try {
			const r = await deployAgentOnce({
				umi, authoritySigner, collectionAddr, collectionAsset, agent, network,
				onEvent: (type, d) => {
					if (type === 'registered') console.log(`        ↳ registry: ${d.identity_pda}${d.already_registered ? ' (already)' : ''}`);
					else if (type === 'registry_error') console.log(`        ↳ registry skipped: ${d.error} (back-fill later)`);
				},
			});
			deployed++;
			console.log(`✓ ${r.asset}`);
			console.log(`        ${explorerUrl(r.asset, network)}`);
		} catch (err) {
			errors++;
			console.log(`✗ ${err.message}`);
		}
		await sleep(400);
	}

	console.log(`\nDone — deployed: ${deployed}, errors: ${errors}.`);
	if (deployed > 0) console.log(`Collection: ${explorerUrl(collectionAddr, network)}`);
}

main().catch((err) => {
	console.error('\n✗ Fatal:', err?.stack || err?.message || err);
	process.exit(1);
});
