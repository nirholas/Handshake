// BNB testnet: preflight, deploy, and live-prove WorldMoves + GreenfieldVault.
// ---------------------------------------------------------------------------
// One command for the whole of backlog work order 07. The two contracts are
// code-complete and dry-run verified; the only thing that has ever been missing
// is a funded deployer key, so this script does everything around that step and
// makes the funded moment a single invocation.
//
// Modes:
//   node scripts/bnb-testnet-deploy-prove.mjs
//       Preflight only. Resolves the deployer, reads its live tBNB balance,
//       simulates BOTH deploy scripts against the public BSC testnet RPC, and
//       renders the spend-confirmation table CLAUDE.md's gate 1 requires.
//       Never signs anything. Exit 3 when the deployer is unfunded.
//
//   node scripts/bnb-testnet-deploy-prove.mjs --broadcast
//       Runs the preflight, then broadcasts both deploys with the REAL,
//       unmodified contracts/script/Deploy*.s.sol, then runs the live proof
//       against the address it just deployed.
//
//   node scripts/bnb-testnet-deploy-prove.mjs --prove-only --address 0x...
//       Skips deployment and proves the sender / reader / ghost paths against
//       an already-deployed WorldMoves.
//
// The proof exercises the real production modules, not reimplementations:
//   sender  api/_lib/bnb/world-moves.js  sendJoin / sendMove / sendLeave
//   reader  src/bnb/world-presence-reader.js  watchWorldPresence
//   ghost   src/bnb/onchain-ghosts.js  createGhostTracker
//
// Flags: --world-id <n> (default 1), --moves <n> (default 3), --out <file.json>

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatEther, createPublicClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACTS_DIR = resolve(REPO_ROOT, 'contracts');

/** Load `contracts/.env` then the repo `.env`, never overriding the shell. */
function loadEnvFiles() {
	for (const file of [resolve(CONTRACTS_DIR, '.env'), resolve(REPO_ROOT, '.env')]) {
		try {
			for (const line of readFileSync(file, 'utf8').split('\n')) {
				const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
				if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
			}
		} catch {
			/* absent file is fine; the shell environment may already carry the vars */
		}
	}
}

loadEnvFiles();

const { BNB_CHAINS, getPublicClient } = await import(`${REPO_ROOT}/api/_lib/bnb/chains.js`);
const TESTNET = BNB_CHAINS.bscTestnet;

function parseArgs(argv) {
	const out = { broadcast: false, proveOnly: false, address: null, worldId: 1, moves: 3, outFile: null };
	for (let i = 0; i < argv.length; i += 1) {
		const a = argv[i];
		if (a === '--broadcast') out.broadcast = true;
		else if (a === '--prove-only') out.proveOnly = true;
		else if (a === '--address') out.address = argv[++i];
		else if (a === '--world-id') out.worldId = Number(argv[++i]);
		else if (a === '--moves') out.moves = Number(argv[++i]);
		else if (a === '--out') out.outFile = argv[++i];
		else throw new Error(`unknown flag ${a}; see the header of ${'scripts/bnb-testnet-deploy-prove.mjs'}`);
	}
	if (!Number.isInteger(out.worldId) || out.worldId < 0) throw new Error('--world-id must be a non-negative integer');
	if (!Number.isInteger(out.moves) || out.moves < 1) throw new Error('--moves must be a positive integer');
	return out;
}

/** First BSC testnet RPC that answers `eth_chainId` with 97. */
async function pickRpc() {
	const candidates = [process.env.BSC_TESTNET_RPC_URL, ...TESTNET.rpcs].filter(Boolean);
	const tried = [];
	for (const url of candidates) {
		try {
			const client = createPublicClient({ transport: http(url, { timeout: 8000 }) });
			const id = await client.getChainId();
			if (id === 97) return url;
			tried.push(`${url} (chainId ${id})`);
		} catch (err) {
			tried.push(`${url} (${err.shortMessage || err.message})`);
		}
	}
	throw new Error(`no reachable BSC testnet RPC. Tried:\n  ${tried.join('\n  ')}`);
}

function deployerAccount() {
	const raw = (process.env.BNB_TESTNET_DEPLOYER_KEY || process.env.DEPLOYER_PK || '').trim();
	if (!raw) {
		throw new Error(
			'BNB_TESTNET_DEPLOYER_KEY is not set. Generate one with `cast wallet new`, write it to contracts/.env ' +
				'(gitignored), and fund it at https://www.bnbchain.org/en/testnet-faucet (reCAPTCHA, so a human must do it).',
		);
	}
	const pk = raw.startsWith('0x') ? raw : `0x${raw}`;
	if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) throw new Error('BNB_TESTNET_DEPLOYER_KEY must be a 32-byte hex private key');
	return privateKeyToAccount(pk);
}

function forgeScript(scriptRef, { rpcUrl, broadcast, privateKey }) {
	const args = ['script', scriptRef, '--rpc-url', rpcUrl, '--json'];
	if (broadcast) args.push('--broadcast', '--private-key', privateKey, '--slow');
	const stdout = execFileSync('forge', args, {
		cwd: CONTRACTS_DIR,
		encoding: 'utf8',
		maxBuffer: 64 * 1024 * 1024,
		env: { ...process.env, BSC_TESTNET_RPC_URL: rpcUrl },
	});
	// `--json` emits one JSON object per line interleaved with plain log lines.
	const objects = [];
	for (const line of stdout.split('\n')) {
		const t = line.trim();
		if (!t.startsWith('{')) continue;
		try {
			objects.push(JSON.parse(t));
		} catch {
			/* a non-JSON brace line, e.g. a console.log of a struct */
		}
	}
	return { stdout, objects };
}

/** Pull the cost estimate out of a forge `--json` simulation. */
function estimateFrom(objects) {
	const est = objects.find((o) => o && o.estimated_total_gas_used !== undefined);
	const run = objects.find((o) => o && o.gas_used !== undefined && o.success !== undefined);
	if (!est) return null;
	return {
		simulationSucceeded: run ? !!run.success : null,
		constructorGas: run ? Number(run.gas_used) : null,
		totalGas: Number(est.estimated_total_gas_used),
		gasPriceGwei: Number(est.estimated_gas_price),
		amount: `${est.estimated_amount_required} ${est.token_symbol}`,
	};
}

/** Deployed address + receipt facts, read from the broadcast artifact forge writes. */
function deployedAddress(scriptFile) {
	const artifact = resolve(CONTRACTS_DIR, 'broadcast', scriptFile, '97', 'run-latest.json');
	const run = JSON.parse(readFileSync(artifact, 'utf8'));
	const create = run.transactions.find((t) => t.transactionType === 'CREATE');
	if (!create) throw new Error(`no CREATE transaction in ${artifact}`);
	const receipt = (run.receipts || []).find((r) => r.transactionHash === create.hash) || {};
	return {
		address: create.contractAddress,
		txHash: create.hash,
		blockNumber: receipt.blockNumber ? Number(BigInt(receipt.blockNumber)) : null,
		gasUsed: receipt.gasUsed ? Number(BigInt(receipt.gasUsed)) : null,
		status: receipt.status ?? null,
	};
}

function bscscan(kind, value) {
	return `${TESTNET.explorer}/${kind}/${value}`;
}

/**
 * Exercise the three live paths against a real deployment. The reader is
 * started BEFORE the sender fires so every event is observed live rather than
 * backfilled, and the ghost tracker is driven purely from reader callbacks.
 */
async function proveLivePaths({ address, worldId, moves, account, rpcUrl }) {
	const { sendJoin, sendMove, sendLeave } = await import(`${REPO_ROOT}/api/_lib/bnb/world-moves.js`);
	const { watchWorldPresence } = await import(`${REPO_ROOT}/src/bnb/world-presence-reader.js`);
	const { createGhostTracker } = await import(`${REPO_ROOT}/src/bnb/onchain-ghosts.js`);

	const observed = { moved: [], joined: [], left: [], errors: [] };
	const ghosts = createGhostTracker();

	// Pin reader AND sender to the one RPC that answered the preflight, so the
	// proof cannot silently split across endpoints (or, on an anvil fork, leak
	// sends onto the public testnet).
	const publicClient = getPublicClient('bscTestnet', { rpcs: [rpcUrl], cache: false });
	const sendOpts = { address, publicClient };
	const watcher = await watchWorldPresence({
		worldId,
		address,
		network: 'bscTestnet',
		publicClient,
		pollMs: 700,
		backfillBlocks: 0n,
		onMove: (ev) => {
			observed.moved.push({ ...ev, blockNumber: Number(ev.blockNumber), timestamp: Number(ev.timestamp) });
			// Wall clock, not the block timestamp: staleness here means "how long
			// since we saw this player", and it is what src/agora/onchain-presence.js
			// feeds the tracker in production (upsert with no explicit timestamp).
			ghosts.upsert(ev.player, { x: ev.x, y: ev.y, z: ev.z, facing: ev.facing });
		},
		onJoin: (ev) => observed.joined.push({ player: ev.player, timestamp: Number(ev.timestamp) }),
		onLeave: (ev) => {
			observed.left.push({ player: ev.player, timestamp: Number(ev.timestamp) });
			ghosts.remove(ev.player);
		},
		onError: (err) => observed.errors.push(err.shortMessage || err.message),
	});

	const sent = [];
	try {
		const join = await sendJoin({ account, worldId, network: 'bscTestnet' }, sendOpts);
		sent.push({ call: 'join', ...join });
		console.log(`  join      ${join.hash}  (${join.mode})`);

		for (let i = 0; i < moves; i += 1) {
			const pos = { x: 1000 + i * 250, y: 0, z: -500 + i * 125 };
			const facing = (i * 9000) % 36000;
			const res = await sendMove({ account, worldId, pos, facing, network: 'bscTestnet' }, sendOpts);
			sent.push({ call: 'move', pos, facing, ...res });
			console.log(`  move #${i + 1}   ${res.hash}  (${res.mode})  pos=${JSON.stringify(pos)} facing=${facing}`);
		}

		// Give the reader's poll loop time to see the last move before `leave`
		// removes the ghost, so the ghost path is observed populated then empty.
		await waitFor(() => observed.moved.length >= moves, 45_000, 'reader never observed every Moved event');

		ghosts.tick(1 / 60, Date.now());
		const beforeLeave = [...ghosts.values()].map((g) => ({
			player: g.player,
			interpolated: { x: round(g.x), y: round(g.y), z: round(g.z), facing: round(g.facing) },
			target: { x: round(g.target.x), y: round(g.target.y), z: round(g.target.z), facing: round(g.target.facing) },
			moves: g.moves,
		}));

		const leave = await sendLeave({ account, worldId, network: 'bscTestnet' }, sendOpts);
		sent.push({ call: 'leave', ...leave });
		console.log(`  leave     ${leave.hash}  (${leave.mode})`);

		await waitFor(() => observed.left.length >= 1, 45_000, 'reader never observed the Left event');

		return { sent, observed, ghostsBeforeLeave: beforeLeave, ghostsAfterLeave: ghosts.size };
	} finally {
		watcher.stop();
	}
}

const round = (n) => Math.round(n * 100) / 100;

async function waitFor(predicate, timeoutMs, message) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((r) => setTimeout(r, 400));
	}
	throw new Error(`${message} (waited ${timeoutMs}ms)`);
}

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	const rpcUrl = await pickRpc();
	const account = deployerAccount();
	const client = createPublicClient({ transport: http(rpcUrl, { timeout: 15_000 }) });
	const balance = await client.getBalance({ address: account.address });

	const report = {
		network: 'bscTestnet',
		chainId: TESTNET.id,
		rpcUrl,
		deployer: account.address,
		deployerBalanceWei: balance.toString(),
		deployerBalanceBnb: formatEther(balance),
		explorer: TESTNET.explorer,
		ranAt: new Date().toISOString(),
	};

	console.log(`network       BNB Smart Chain Testnet (chainId ${TESTNET.id})`);
	console.log(`rpc           ${rpcUrl}`);
	console.log(`deployer      ${account.address}`);
	console.log(`balance       ${formatEther(balance)} tBNB   ${bscscan('address', account.address)}`);
	console.log('');

	if (!opts.proveOnly) {
		console.log('simulating both deploy scripts against the live testnet RPC (no broadcast)...');
		const sims = {
			GreenfieldVault: estimateFrom(
				forgeScript('script/DeployGreenfieldVault.s.sol:DeployGreenfieldVault', { rpcUrl, broadcast: false }).objects,
			),
			WorldMoves: estimateFrom(
				forgeScript('script/DeployWorldMoves.s.sol:DeployWorldMoves', { rpcUrl, broadcast: false }).objects,
			),
		};
		report.simulation = sims;
		for (const [name, s] of Object.entries(sims)) {
			const ok = s?.simulationSucceeded ? 'ok ' : 'FAIL';
			console.log(
				`  ${name.padEnd(16)} ${ok}  gas ${String(s?.totalGas ?? 'n/a').padStart(9)} @ ${s?.gasPriceGwei ?? '?'} gwei   cost ${s?.amount ?? 'n/a'}`,
			);
		}
		console.log('');
	}

	if (balance === 0n && !opts.proveOnly) {
		console.log('DEPLOYER IS UNFUNDED. Nothing was signed.');
		console.log(`Fund ${account.address} with tBNB at https://www.bnbchain.org/en/testnet-faucet`);
		console.log('(the faucet is reCAPTCHA-gated, so a human has to complete it), then re-run with --broadcast.');
		if (opts.outFile) writeFileSync(opts.outFile, JSON.stringify(report, null, 2));
		process.exit(3);
	}

	if (!opts.broadcast && !opts.proveOnly) {
		console.log('Preflight only. Re-run with --broadcast to deploy (this SPENDS testnet funds from the key above).');
		if (opts.outFile) writeFileSync(opts.outFile, JSON.stringify(report, null, 2));
		return;
	}

	let worldMoves = opts.address;
	if (opts.broadcast) {
		console.log('broadcasting GreenfieldVault...');
		forgeScript('script/DeployGreenfieldVault.s.sol:DeployGreenfieldVault', {
			rpcUrl,
			broadcast: true,
			privateKey: process.env.BNB_TESTNET_DEPLOYER_KEY,
		});
		const vault = deployedAddress('DeployGreenfieldVault.s.sol');
		report.greenfieldVault = { ...vault, explorer: bscscan('address', vault.address) };
		console.log(`  GreenfieldVault ${vault.address}  tx ${vault.txHash}  block ${vault.blockNumber}`);

		console.log('broadcasting WorldMoves...');
		forgeScript('script/DeployWorldMoves.s.sol:DeployWorldMoves', {
			rpcUrl,
			broadcast: true,
			privateKey: process.env.BNB_TESTNET_DEPLOYER_KEY,
		});
		const wm = deployedAddress('DeployWorldMoves.s.sol');
		report.worldMoves = { ...wm, explorer: bscscan('address', wm.address) };
		worldMoves = wm.address;
		console.log(`  WorldMoves      ${wm.address}  tx ${wm.txHash}  block ${wm.blockNumber}`);
		console.log('');
	}

	if (!worldMoves) throw new Error('--prove-only needs --address <deployed WorldMoves>');

	console.log(`proving sender / reader / ghost against ${worldMoves} (worldId ${opts.worldId})...`);
	report.proof = await proveLivePaths({
		address: worldMoves,
		worldId: opts.worldId,
		moves: opts.moves,
		account,
		rpcUrl,
	});
	console.log('');
	console.log(`  reader observed  ${report.proof.observed.joined.length} Joined, ${report.proof.observed.moved.length} Moved, ${report.proof.observed.left.length} Left`);
	console.log(`  ghost tracker    ${report.proof.ghostsBeforeLeave.length} ghost(s) before leave, ${report.proof.ghostsAfterLeave} after`);
	if (report.proof.observed.errors.length) console.log(`  reader errors    ${report.proof.observed.errors.join('; ')}`);
	console.log('');
	console.log('Next: set the address on the service, then confirm the public endpoint flips to deployed:true');
	console.log(`  gcloud run services update three-ws-api --region us-central1 --project aerial-vehicle-466722-p5 \\`);
	console.log(`    --update-env-vars WORLD_MOVES_ADDRESS_TESTNET=${worldMoves}`);
	console.log('  curl -s "https://three.ws/api/bnb/world-config?network=testnet" | python3 -m json.tool');

	if (opts.outFile) {
		writeFileSync(opts.outFile, JSON.stringify(report, null, 2));
		console.log(`\nevidence written to ${opts.outFile}`);
	}
}

main().catch((err) => {
	console.error(`\n${err.message}`);
	process.exit(1);
});
