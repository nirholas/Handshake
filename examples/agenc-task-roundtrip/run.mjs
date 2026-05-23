#!/usr/bin/env node
// End-to-end AgenC task roundtrip on Solana devnet.
//
// Demonstrates a three.ws-flavored agent (worker) discovering, claiming, and
// completing a task posted by a creator on the public AgenC coordination
// protocol (agenc.tech, by Tetsuo Corp). The full lifecycle runs against the
// devnet program 6UcJzbTEemBz3aY5wK5qKHGMD7bdRsmR4smND29gB2ab — no mocks.
//
// On the first run, fresh creator + worker keypairs are generated and cached
// under .cache/, then airdropped 1 SOL each from the public devnet faucet.
// Subsequent runs reuse the same keypairs and only airdrop when balances run
// low. `npm run reset` wipes the cache to start clean.
//
// Output is an annotated log with Solana Explorer URLs for every on-chain
// step so the run can be inspected externally.

import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
	createAgenCClient,
	registerAgenCAgent,
	getAgenCAgent,
	createAgenCTask,
	claimAgenCTask,
	completeAgenCTask,
	getAgenCTask,
	formatTaskState,
	deriveAgenCAgentPda,
	toAgenCAgentId,
} from "@three-ws/solana-agent";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, ".cache");
const CREATOR_PATH = path.join(CACHE_DIR, "creator.json");
const WORKER_PATH = path.join(CACHE_DIR, "worker.json");

const MIN_STAKE_LAMPORTS = 1_000_000; // protocol minAgentStake on devnet
const TASK_REWARD_LAMPORTS = 5_000_000; // 0.005 SOL — well above min
const TARGET_BALANCE = LAMPORTS_PER_SOL; // top up to 1 SOL when below 0.2
const TOPUP_THRESHOLD = 0.2 * LAMPORTS_PER_SOL;
const AIRDROP_AMOUNT = LAMPORTS_PER_SOL;

function step(label) {
	console.log(`\n── ${label} ──`);
}

function explorerTx(sig) {
	return `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
}

function explorerAccount(pubkey) {
	return `https://explorer.solana.com/address/${pubkey.toBase58()}?cluster=devnet`;
}

async function loadOrCreateKeypair(filePath, label) {
	try {
		const raw = await fs.readFile(filePath, "utf8");
		const secret = Uint8Array.from(JSON.parse(raw));
		const kp = Keypair.fromSecretKey(secret);
		console.log(`  [${label}] reusing ${kp.publicKey.toBase58()}`);
		return kp;
	} catch (err) {
		if (err.code !== "ENOENT") throw err;
		await fs.mkdir(CACHE_DIR, { recursive: true });
		const kp = Keypair.generate();
		await fs.writeFile(filePath, JSON.stringify(Array.from(kp.secretKey)));
		console.log(`  [${label}] generated ${kp.publicKey.toBase58()} → ${path.relative(__dirname, filePath)}`);
		return kp;
	}
}

async function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

async function airdropOnce(connection, kp, lamports) {
	const sig = await connection.requestAirdrop(kp.publicKey, lamports);
	await connection.confirmTransaction(sig, "confirmed");
	return sig;
}

async function ensureBalance(connection, kp, label) {
	const bal = await connection.getBalance(kp.publicKey);
	if (bal >= TOPUP_THRESHOLD) {
		console.log(`  [${label}] balance ${(bal / LAMPORTS_PER_SOL).toFixed(4)} SOL — sufficient`);
		return;
	}
	console.log(`  [${label}] balance ${(bal / LAMPORTS_PER_SOL).toFixed(4)} SOL — requesting airdrop…`);

	// Public devnet faucet is heavily rate-limited. Try a few smaller chunks
	// with backoff before surfacing a manual-funding error. This is the same
	// pattern used by @solana/web3.js's own example scripts.
	const chunks = [AIRDROP_AMOUNT, AIRDROP_AMOUNT / 2, AIRDROP_AMOUNT / 4, AIRDROP_AMOUNT / 10];
	let lastErr = null;
	for (let attempt = 0; attempt < chunks.length; attempt++) {
		const lamports = Math.max(chunks[attempt], LAMPORTS_PER_SOL / 100);
		try {
			const sig = await airdropOnce(connection, kp, lamports);
			const newBal = await connection.getBalance(kp.publicKey);
			console.log(`  [${label}] airdrop ${lamports / LAMPORTS_PER_SOL} SOL confirmed: ${explorerTx(sig)}`);
			console.log(`  [${label}] new balance: ${(newBal / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
			if (newBal >= TOPUP_THRESHOLD) return;
		} catch (err) {
			lastErr = err;
			const waitMs = 2000 * (attempt + 1);
			console.log(`  [${label}] airdrop attempt ${attempt + 1} failed (${err.message || err}); retrying in ${waitMs}ms`);
			await sleep(waitMs);
		}
	}
	throw new Error(
		`[${label}] devnet airdrop exhausted retries — the public faucet is rate-limited. Fund ${kp.publicKey.toBase58()} manually at https://faucet.solana.com (or set AGENC_DEVNET_RPC_URL to a private RPC) and re-run. Underlying: ${lastErr?.message || lastErr}`,
	);
}

async function ensureAgentRegistered(client, kp, label, opts) {
	const agentId = toAgenCAgentId(opts.label);
	const pda = deriveAgenCAgentPda(client, agentId);
	const existing = await getAgenCAgent(client, pda);
	if (existing) {
		console.log(`  [${label}] already registered → agentPda ${pda.toBase58()}`);
		console.log(`            status=${existing.status}, reputation=${existing.reputation}, activeTasks=${existing.activeTasks}`);
		return { agentPda: pda, agentId };
	}
	const result = await registerAgenCAgent(
		{ ...client, signer: kp },
		{
			agentId,
			capabilities: opts.capabilities,
			endpoint: opts.endpoint,
			metadataUri: opts.metadataUri ?? null,
			stakeAmount: MIN_STAKE_LAMPORTS,
		},
	);
	console.log(`  [${label}] registered → agentPda ${result.agentPda.toBase58()}`);
	console.log(`            tx: ${explorerTx(result.txSignature)}`);
	return { agentPda: result.agentPda, agentId };
}

async function main() {
	console.log("AgenC task roundtrip — devnet");
	console.log(`programId: 6UcJzbTEemBz3aY5wK5qKHGMD7bdRsmR4smND29gB2ab\n`);

	step("0. load / generate keypairs");
	const creator = await loadOrCreateKeypair(CREATOR_PATH, "creator");
	const worker = await loadOrCreateKeypair(WORKER_PATH, "worker");

	const rpcUrl = (process.env.AGENC_DEVNET_RPC_URL || "").trim() || undefined;
	if (rpcUrl) console.log(`  using custom devnet RPC: ${rpcUrl}`);
	const readClient = createAgenCClient({ cluster: "devnet", rpcUrl });
	const creatorClient = createAgenCClient({ cluster: "devnet", rpcUrl, signer: creator });
	const workerClient = createAgenCClient({ cluster: "devnet", rpcUrl, signer: worker });

	step("1. ensure devnet SOL balance");
	await ensureBalance(readClient.connection, creator, "creator");
	await ensureBalance(readClient.connection, worker, "worker");

	step("2. register both wallets as AgenC agents");
	const creatorAgent = await ensureAgentRegistered(creatorClient, creator, "creator", {
		label: `three-ws-creator-${creator.publicKey.toBase58()}`,
		capabilities: 0n,
		endpoint: "https://three.ws/agents/demo-creator",
		metadataUri: "https://three.ws/agents/demo-creator/manifest.json",
	});
	const workerAgent = await ensureAgentRegistered(workerClient, worker, "worker", {
		label: `three-ws-worker-${worker.publicKey.toBase58()}`,
		capabilities: 1n, // bit 0: "can answer text prompts" — capability bitmap is freeform
		endpoint: "https://three.ws/agents/demo-worker",
		metadataUri: "https://three.ws/agents/demo-worker/manifest.json",
	});

	step("3. creator posts a public task");
	const deadline = Math.floor(Date.now() / 1000) + 60 * 60; // 1 hour from now
	const taskDescription = `Render greeting via three.ws @ ${new Date().toISOString()}`;
	const created = await createAgenCTask(creatorClient, {
		creatorAgentId: creatorAgent.agentId,
		requiredCapabilities: 1n, // worker must advertise bit 0
		description: taskDescription,
		rewardAmount: TASK_REWARD_LAMPORTS,
		maxWorkers: 1,
		deadline,
		taskType: "Exclusive",
		minReputation: 0,
	});
	console.log(`  taskPda: ${created.taskPda.toBase58()}`);
	console.log(`  taskId : ${Buffer.from(created.taskId).toString("hex")}`);
	console.log(`  tx     : ${explorerTx(created.txSignature)}`);
	console.log(`  account: ${explorerAccount(created.taskPda)}`);

	step("4. worker claims the task");
	const claim = await claimAgenCTask(workerClient, {
		taskPda: created.taskPda,
		workerAgentId: workerAgent.agentId,
	});
	console.log(`  tx: ${explorerTx(claim.txSignature)}`);

	const afterClaim = await getAgenCTask(readClient, created.taskPda);
	console.log(`  state: ${afterClaim ? formatTaskState(afterClaim.state) : "(no account)"}`);
	console.log(`  workers: ${afterClaim?.currentWorkers}/${afterClaim?.maxWorkers}`);

	step("5. worker executes + submits proof");
	// Worker performs a real, verifiable unit of work: query the three.ws
	// AgenC ↔ x402 bridge for the live bazaar service count, then return a
	// signed receipt that binds the task description + worker pubkey + live
	// bazaar fingerprint. The proof is sha256(result) — any verifier can
	// re-query the bridge and recompute the same fingerprint at this height.
	const bridgeUrl = process.env.AGENC_BRIDGE_URL || "https://three.ws/api/agenc/x402-services?maxItems=5";
	let bridgeSummary;
	try {
		const r = await fetch(bridgeUrl);
		if (!r.ok) throw new Error(`bridge ${r.status}`);
		const payload = await r.json();
		const fingerprint = createHash("sha256")
			.update(
				JSON.stringify(payload.tasks?.map((t) => t.taskIdSeed) ?? []),
				"utf8",
			)
			.digest("hex");
		bridgeSummary = {
			count: payload.count ?? 0,
			fingerprint,
			facilitators: payload.sources?.map((s) => s.facilitator) ?? [],
		};
	} catch (err) {
		throw new Error(`worker bridge call failed: ${err.message || err}`);
	}
	const result = JSON.stringify({
		worker: worker.publicKey.toBase58(),
		taskPda: created.taskPda.toBase58(),
		completedAt: new Date().toISOString(),
		bridge: bridgeSummary,
		instruction: taskDescription,
	});
	const proofHash = createHash("sha256").update(result, "utf8").digest();
	console.log(`  bridge   : ${bridgeUrl}`);
	console.log(`  result   : ${result}`);
	console.log(`  proofHash: 0x${proofHash.toString("hex")}`);

	const completion = await completeAgenCTask(workerClient, {
		taskPda: created.taskPda,
		workerAgentId: workerAgent.agentId,
		proofHash,
		resultData: Buffer.from(result.padEnd(64, " ").slice(0, 64), "utf8"),
	});
	console.log(`  tx: ${explorerTx(completion.txSignature)}`);

	step("6. verify final on-chain state");
	const final = await getAgenCTask(readClient, created.taskPda);
	if (!final) {
		console.log("  no task account (creator may have cancelled before completion)");
		return;
	}
	console.log(`  state       : ${formatTaskState(final.state)}`);
	console.log(`  currentWorkers: ${final.currentWorkers}/${final.maxWorkers}`);
	console.log(`  completedAt : ${final.completedAt ? new Date(final.completedAt * 1000).toISOString() : "(unset)"}`);

	const finalWorker = await getAgenCAgent(readClient, workerAgent.agentPda);
	console.log(`  worker reputation: ${finalWorker?.reputation ?? "?"}`);
	console.log(`  worker active tasks: ${finalWorker?.activeTasks ?? "?"}`);

	console.log(`\nDone. Creator: ${explorerAccount(creator.publicKey)}`);
	console.log(`     Worker : ${explorerAccount(worker.publicKey)}`);
	console.log(`     Task   : ${explorerAccount(created.taskPda)}`);
}

main().catch((err) => {
	console.error(`\nFATAL: ${err.stack || err.message || err}`);
	process.exit(1);
});
