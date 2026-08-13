#!/usr/bin/env node
// Offline inference-receipt verifier for node operators (Roadmap phase 4).
//
// Proves a three.ws inference receipt is genuine without trusting any server:
// re-derives every committed hash, checks both ed25519 signatures from first
// principles, and (optionally) confirms the settlement transaction on-chain.
//
// Usage:
//   node scripts/inference-receipt-verify.mjs <receipt.json>
//       [--prompt <text> | --prompt-file <path>]
//       [--content <text> | --content-file <path>]
//       [--signer <base58-pubkey>]     pin the receipt issuer
//       [--onchain]                    confirm payment.transaction on-chain
//       [--rpc <url>]                  Solana RPC for --onchain (devnet default)
//       [--json]                       machine-readable verdict
//
// Exit code 0 = every requested check passed; 1 = a check failed; 2 = usage
// error. Spec: specs/inference-receipts.md.

import { readFile } from 'node:fs/promises';

import {
	verifyInferenceReceipt,
	INFERENCE_RECEIPT_TYPE,
} from '../api/_lib/inference-settlement.js';

function usage(exitCode) {
	const msg = `usage: node scripts/inference-receipt-verify.mjs <receipt.json>
              [--prompt <text> | --prompt-file <path>]
              [--content <text> | --content-file <path>]
              [--signer <base58-pubkey>] [--onchain] [--rpc <url>] [--json]`;
	if (exitCode === 0) console.log(msg);
	else console.error(msg);
	process.exit(exitCode);
}

function parseArgs(argv) {
	const args = { onchain: false, json: false };
	const rest = [...argv];
	args.file = rest.shift();
	while (rest.length) {
		const flag = rest.shift();
		if (flag === '--prompt') args.prompt = rest.shift();
		else if (flag === '--prompt-file') args.promptFile = rest.shift();
		else if (flag === '--content') args.content = rest.shift();
		else if (flag === '--content-file') args.contentFile = rest.shift();
		else if (flag === '--signer') args.signer = rest.shift();
		else if (flag === '--onchain') args.onchain = true;
		else if (flag === '--rpc') args.rpc = rest.shift();
		else if (flag === '--json') args.json = true;
		else if (flag === '--help' || flag === '-h') usage(0);
		else {
			console.error(`unknown flag: ${flag}`);
			usage(2);
		}
	}
	return args;
}

// The two public Solana lanes, by CAIP-2 id (the id is `solana:` plus the first
// 32 base58 characters of the cluster's genesis hash). Anything else is a
// private or local lane: it gets named by its id and needs an explicit --rpc,
// because there is no public endpoint to guess.
const SOLANA_LANES = {
	'solana:5eykt4usfv8p8njdtrepy1vzqkqzkvdp': { label: 'Solana mainnet', defaultRpc: 'https://api.mainnet-beta.solana.com' },
	'solana:etwtrabzayq6imfeykouru166vu2xqa1': { label: 'Solana devnet', defaultRpc: 'https://api.devnet.solana.com' },
};

function laneOf(lowercaseNetwork, network) {
	return SOLANA_LANES[lowercaseNetwork] || { label: String(network), defaultRpc: null };
}

// Read-only on-chain confirmation of the settlement transaction. Solana and
// devnet first (the home lane); EVM receipts point the operator at their own
// node because this script deliberately stays dependency-light.
async function confirmOnchain(receipt, rpcUrl) {
	const { network, transaction } = receipt.payment;
	const n = String(network || '').toLowerCase();
	if (!n.startsWith('solana')) {
		return {
			verified: false,
			status: 'unsupported_network',
			detail: `on-chain confirmation in this CLI covers Solana lanes; for ${network} confirm ${transaction} on any ${network} explorer or RPC`,
		};
	}
	// Name the lane from the receipt's own CAIP-2 id. Reporting anything that is
	// not devnet as "mainnet" would tell an operator their payment settled on a
	// chain it never touched, which is the one thing a verifier must never do.
	const { label, defaultRpc } = laneOf(n, network);
	const url = rpcUrl || defaultRpc;
	if (!url) {
		return {
			verified: false,
			status: 'rpc_required',
			detail: `${network} is not a public Solana lane this CLI can assume an RPC for; re-run with --rpc <url>`,
		};
	}
	try {
		const res = await fetch(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'getSignatureStatuses',
				params: [[transaction], { searchTransactionHistory: true }],
			}),
		});
		if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
		const data = await res.json();
		const st = data?.result?.value?.[0];
		if (!st) return { verified: false, status: 'not_found', detail: `signature not found on ${label} (${url})` };
		if (st.err) return { verified: false, status: 'failed', detail: 'transaction failed on-chain', slot: st.slot ?? null };
		const confirmed = st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized';
		return {
			verified: confirmed,
			status: st.confirmationStatus || 'processed',
			detail: confirmed ? `settlement confirmed on ${label}` : 'seen but not yet confirmed',
			slot: st.slot ?? null,
		};
	} catch (err) {
		return { verified: false, status: 'rpc_unavailable', detail: `could not reach ${url}: ${err?.message || err}` };
	}
}

const args = parseArgs(process.argv.slice(2));
if (!args.file) usage(2);

let receipt;
try {
	receipt = JSON.parse(await readFile(args.file, 'utf8'));
} catch (err) {
	console.error(`could not read receipt file ${args.file}: ${err.message}`);
	process.exit(2);
}
if (receipt?.receiptType !== INFERENCE_RECEIPT_TYPE) {
	console.error(`not an inference receipt: receiptType is ${receipt?.receiptType ?? '(missing)'}, want ${INFERENCE_RECEIPT_TYPE}`);
	process.exit(2);
}

const prompt = args.prompt ?? (args.promptFile ? await readFile(args.promptFile, 'utf8') : undefined);
const content = args.content ?? (args.contentFile ? await readFile(args.contentFile, 'utf8') : undefined);

const verdict = verifyInferenceReceipt(receipt, {
	prompt,
	content,
	trustedSigner: args.signer,
});

let settlement = null;
if (args.onchain && receipt.payment?.transaction) {
	settlement = await confirmOnchain(receipt, args.rpc);
}

if (args.json) {
	console.log(JSON.stringify({ ok: verdict.ok && (!settlement || settlement.verified), checks: verdict.checks, settlement }, null, 2));
} else {
	console.log(`receipt:    ${receipt.job?.jobId} on ${receipt.payment?.network}`);
	console.log(`issuer:     ${receipt.signer}`);
	console.log(`node:       ${receipt.responseSigner}`);
	console.log(`payment:    ${receipt.payment?.amountAtomics} atomics of ${receipt.payment?.asset}`);
	console.log(`settlement: ${receipt.payment?.transaction}`);
	for (const c of verdict.checks) {
		console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `: ${c.detail}` : ''}`);
	}
	if (settlement) {
		console.log(`  ${settlement.verified ? 'PASS' : 'FAIL'}  onchain_settlement: ${settlement.detail}`);
	}
	console.log(verdict.ok && (!settlement || settlement.verified) ? 'VERDICT: verified' : `VERDICT: FAILED (${verdict.reason || 'onchain_settlement'})`);
}

process.exit(verdict.ok && (!settlement || settlement.verified) ? 0 : 1);
