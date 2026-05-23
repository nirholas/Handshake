#!/usr/bin/env node
// Mirror a single x402 service as a real on-chain AgenC task.
//
// Usage:
//   node scripts/agenc-mirror-x402-service.mjs \
//     --resource https://three.ws/api/x402/agent-reputation \
//     --reward 5000000 \
//     --deadline-hours 24 \
//     --keypair ./creator.json \
//     [--cluster devnet]
//
// The task description packs `x402:<resource>` so any AgenC worker that
// claims the task knows where to call. The reward is whatever you choose
// to escrow on AgenC — it does not have to match the x402 endpoint price.
//
// Re-running with the same resource is idempotent: the task id is derived
// deterministically from the resource URL so the same PDA is targeted. If
// the task already exists in a non-terminal state, the script exits without
// re-creating.

import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { Keypair } from "@solana/web3.js";
import {
	createAgenCClient,
	createAgenCTask,
	getAgenCTask,
	registerAgenCAgent,
	getAgenCAgent,
	deriveAgenCAgentPda,
	toAgenCAgentId,
	formatTaskState,
} from "@three-ws/solana-agent";

function arg(name, def) {
	const flag = `--${name}`;
	const i = process.argv.indexOf(flag);
	if (i === -1) return def;
	return process.argv[i + 1];
}

function flag(name) {
	return process.argv.includes(`--${name}`);
}

function usage(msg) {
	if (msg) console.error(`error: ${msg}\n`);
	console.error(`Usage: agenc-mirror-x402-service.mjs --resource <url> --reward <lamports> --keypair <path> [--cluster devnet|mainnet] [--deadline-hours N] [--label "agent label"] [--capability-bit N]`);
	process.exit(msg ? 1 : 0);
}

async function main() {
	if (flag("help")) usage();

	const resource = arg("resource");
	const rewardArg = arg("reward");
	const keypairPath = arg("keypair");
	if (!resource) usage("--resource is required");
	if (!rewardArg) usage("--reward (lamports) is required");
	if (!keypairPath) usage("--keypair is required");

	const reward = BigInt(rewardArg);
	const cluster = arg("cluster", "devnet");
	if (cluster !== "devnet" && cluster !== "mainnet") usage("--cluster must be devnet or mainnet");

	const deadlineHours = Number(arg("deadline-hours", "24"));
	if (!Number.isFinite(deadlineHours) || deadlineHours <= 0) usage("--deadline-hours must be a positive number");

	const agentLabel = arg("label", "three-ws-x402-creator");
	const capabilityBit = Number(arg("capability-bit", "0"));

	const secret = Uint8Array.from(JSON.parse(await fs.readFile(keypairPath, "utf8")));
	const creator = Keypair.fromSecretKey(secret);

	const client = createAgenCClient({ cluster, signer: creator });
	console.log(`cluster   : ${cluster}`);
	console.log(`programId : ${client.programId.toBase58()}`);
	console.log(`creator   : ${creator.publicKey.toBase58()}`);
	console.log(`resource  : ${resource}`);

	// Ensure the creator is registered as an AgenC agent.
	const creatorAgentId = toAgenCAgentId(`${agentLabel}-${creator.publicKey.toBase58()}`);
	const creatorAgentPda = deriveAgenCAgentPda(client, creatorAgentId);
	const existingAgent = await getAgenCAgent(client, creatorAgentPda);
	if (!existingAgent) {
		console.log("\nregistering creator as AgenC agent…");
		const reg = await registerAgenCAgent(client, {
			agentId: creatorAgentId,
			capabilities: 0n,
			endpoint: "https://three.ws/agenc/x402-bridge",
			metadataUri: `https://three.ws/api/agenc/x402-services`,
			stakeAmount: 1_000_000,
		});
		console.log(`  agentPda: ${reg.agentPda.toBase58()}`);
		console.log(`  tx     : https://explorer.solana.com/tx/${reg.txSignature}?cluster=${cluster}`);
	} else {
		console.log(`\ncreator already registered (agentPda=${creatorAgentPda.toBase58()})`);
	}

	// Deterministic taskId derived from the resource URL — re-runs are idempotent.
	const taskId = createHash("sha256")
		.update("AgenC/three.ws/x402/v1\0", "utf8")
		.update(resource, "utf8")
		.digest();
	const taskIdHex = "0x" + taskId.toString("hex");
	console.log(`\ntaskId    : ${taskIdHex}`);

	// Try the existing task at this PDA first — re-creating an active task
	// will fail at the protocol level, so we bail out cleanly when one is live.
	const description = `x402:${resource}`;
	const deadline = Math.floor(Date.now() / 1000) + Math.round(deadlineHours * 3600);

	const result = await createAgenCTask(client, {
		taskId,
		creatorAgentId,
		requiredCapabilities: 1n << BigInt(capabilityBit),
		description,
		rewardAmount: reward,
		maxWorkers: 1,
		deadline,
		taskType: "Exclusive",
		minReputation: 0,
	}).catch(async (err) => {
		const msg = String(err?.message || err);
		if (msg.includes("already in use") || msg.toLowerCase().includes("custom program error: 0x0")) {
			console.log("task account already exists for this resource — re-fetching state…");
			const { deriveTaskPda } = await import("@tetsuo-ai/sdk");
			const pda = deriveTaskPda(creator.publicKey, taskId, client.programId);
			const existing = await getAgenCTask(client, pda);
			if (!existing) throw err;
			console.log(`  taskPda: ${pda.toBase58()}`);
			console.log(`  state  : ${formatTaskState(existing.state)}`);
			console.log(`  workers: ${existing.currentWorkers}/${existing.maxWorkers}`);
			return null;
		}
		throw err;
	});
	if (!result) return;

	console.log(`taskPda   : ${result.taskPda.toBase58()}`);
	console.log(`tx        : https://explorer.solana.com/tx/${result.txSignature}?cluster=${cluster}`);
	console.log(`account   : https://explorer.solana.com/address/${result.taskPda.toBase58()}?cluster=${cluster}`);
	console.log(`reward    : ${Number(reward) / 1e9} SOL`);
	console.log(`deadline  : ${new Date(deadline * 1000).toISOString()}`);
}

main().catch((err) => {
	console.error(`\nFATAL: ${err.stack || err.message || err}`);
	process.exit(1);
});
