// Shared AgenC read-only client used by the agenc-* MCP tools.
//
// Constructs an Anchor `Program` bound to the AgenC coordination protocol
// (agenc.tech, Tetsuo Corp) so the read-only helpers in @tetsuo-ai/sdk can be
// invoked without forcing every tool to know about Anchor's wallet plumbing.
//
// Cluster + RPC are resolved at call time so a single MCP server process can
// service both mainnet and devnet tools.

import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { AnchorProvider, Program } from '@coral-xyz/anchor';
import { AGENC_COORDINATION_IDL } from '@tetsuo-ai/protocol';
import { DEVNET_RPC, MAINNET_RPC, PROGRAM_ID } from '@tetsuo-ai/sdk';

// Devnet program ID validated by the AgenC team on 2026-03-22.
// Source: https://docs.agenc.tech/docs/runtime/api/.
export const AGENC_DEVNET_PROGRAM_ID = new PublicKey(
	'6UcJzbTEemBz3aY5wK5qKHGMD7bdRsmR4smND29gB2ab',
);
export const AGENC_MAINNET_PROGRAM_ID = PROGRAM_ID;

function pickRpc(cluster) {
	const override = (process.env.AGENC_RPC_URL || '').trim();
	if (override) return override;
	if (cluster === 'devnet') {
		return (process.env.SOLANA_DEVNET_RPC_URL || '').trim() || DEVNET_RPC;
	}
	return (process.env.SOLANA_RPC_URL || '').trim() || MAINNET_RPC;
}

function buildReadOnlyWallet() {
	// Anchor's Wallet interface needs a payer slot + publicKey to construct a
	// provider; we hold an ephemeral keypair purely for type satisfaction and
	// refuse to sign anything with it. The MCP tools only expose read paths.
	const ephemeral = Keypair.generate();
	const refuse = () => {
		throw new Error(
			'agenc-client read-only wallet refuses to sign — this tool exposes read paths only.',
		);
	};
	return {
		payer: ephemeral,
		publicKey: ephemeral.publicKey,
		async signTransaction(_tx) {
			refuse();
		},
		async signAllTransactions(_txs) {
			refuse();
		},
	};
}

/**
 * Build a read-only AgenC client for `cluster` ("mainnet" | "devnet").
 * Returns { connection, program, programId, cluster, rpcUrl }.
 */
export function getAgenCClient(cluster = 'mainnet') {
	const c = cluster === 'devnet' ? 'devnet' : 'mainnet';
	const rpcUrl = pickRpc(c);
	const connection = new Connection(rpcUrl, 'confirmed');
	const provider = new AnchorProvider(connection, buildReadOnlyWallet(), {
		commitment: 'confirmed',
		preflightCommitment: 'confirmed',
	});
	const programId = c === 'devnet' ? AGENC_DEVNET_PROGRAM_ID : AGENC_MAINNET_PROGRAM_ID;
	const program = new Program(AGENC_COORDINATION_IDL, provider);
	return { connection, program, programId, cluster: c, rpcUrl };
}

/** Normalize a base58 pubkey string. Returns a PublicKey or throws. */
export function parsePubkey(s, label = 'pubkey') {
	if (!s || typeof s !== 'string') {
		throw new Error(`${label} must be a base58 string`);
	}
	return new PublicKey(s.trim());
}

/** Convert bigint values inside an object to strings so JSON.stringify works. */
export function serializeBigInts(value) {
	if (value === null || value === undefined) return value;
	if (typeof value === 'bigint') return value.toString();
	if (value instanceof Uint8Array) return Buffer.from(value).toString('hex');
	if (value instanceof PublicKey) return value.toBase58();
	if (Array.isArray(value)) return value.map(serializeBigInts);
	if (typeof value === 'object') {
		const out = {};
		for (const [k, v] of Object.entries(value)) {
			out[k] = serializeBigInts(v);
		}
		return out;
	}
	return value;
}

/** Translate a TaskState enum value to a human label. Matches @tetsuo-ai/sdk. */
export function taskStateLabel(state) {
	const map = {
		0: 'Open',
		1: 'Claimed',
		2: 'Completed',
		3: 'Cancelled',
		4: 'Disputed',
		5: 'Expired',
	};
	if (typeof state === 'number') return map[state] ?? `Unknown(${state})`;
	if (state && typeof state === 'object') {
		const key = Object.keys(state)[0];
		return key ? key[0].toUpperCase() + key.slice(1) : 'Unknown';
	}
	return String(state);
}

/** Translate an AgentStatus enum value to a label. */
export function agentStatusLabel(status) {
	const map = { 0: 'Inactive', 1: 'Active', 2: 'Busy', 3: 'Suspended' };
	if (typeof status === 'number') return map[status] ?? `Unknown(${status})`;
	if (status && typeof status === 'object') {
		const key = Object.keys(status)[0];
		return key ? key[0].toUpperCase() + key.slice(1) : 'Unknown';
	}
	return String(status);
}
