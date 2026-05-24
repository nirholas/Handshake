/**
 * Agent Onchain Dispatcher
 * ------------------------
 * POST /api/agents/onchain/prep
 * POST /api/agents/onchain/confirm
 *
 * Single Vercel function that dispatches on req.query.action (auto-populated
 * from the [action] filename). Consolidated to reduce function count and
 * avoid bundling heavy Solana/Metaplex/EVM SDKs twice.
 */

import { z } from 'zod';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { mplCore, createV1 } from '@metaplex-foundation/mpl-core';
import {
	generateSigner,
	publicKey as umiPublicKey,
	signerIdentity,
	createNoopSigner,
} from '@metaplex-foundation/umi';
import { Connection } from '@solana/web3.js';
import { JsonRpcProvider } from 'ethers';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { CID } from 'multiformats/cid';
import * as raw from 'multiformats/codecs/raw';
import { sha256 } from 'multiformats/hashes/sha2';
import { sql } from '../../_lib/db.js';
import { getSessionUser } from '../../_lib/auth.js';
import { cors, json, method, readJson, wrap, error } from '../../_lib/http.js';
import { limits, clientIp } from '../../_lib/rate-limit.js';
import { parse } from '../../_lib/validate.js';
import { randomToken } from '../../_lib/crypto.js';
import { r2, publicUrl } from '../../_lib/r2.js';
import { env } from '../../_lib/env.js';

export default wrap(async (req, res) => {
	const action = req.query?.action;
	switch (action) {
		case 'prep':
			return handlePrep(req, res);
		case 'confirm':
			return handleConfirm(req, res);
		default:
			return error(res, 404, 'not_found', 'unknown onchain action');
	}
});

// ── Chain parsing ────────────────────────────────────────────────────────────

const SOLANA_REFS = {
	mainnet: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
	devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
};
const SOLANA_REF_TO_CLUSTER = Object.fromEntries(
	Object.entries(SOLANA_REFS).map(([k, v]) => [v, k]),
);

/** @returns {{ family: 'evm', chainId: number } | { family: 'solana', cluster: 'mainnet'|'devnet' }} */
function parseChain(caip2) {
	const [ns, ref] = String(caip2).split(':');
	if (ns === 'eip155') {
		const id = Number(ref);
		if (!Number.isInteger(id) || id <= 0) throw new Error(`bad eip155 ref: ${ref}`);
		return { family: 'evm', chainId: id };
	}
	if (ns === 'solana') {
		const cluster = SOLANA_REF_TO_CLUSTER[ref];
		if (!cluster) throw new Error(`unknown solana ref: ${ref}`);
		return { family: 'solana', cluster };
	}
	throw new Error(`unsupported namespace: ${ns}`);
}

// ── prep ─────────────────────────────────────────────────────────────────────

const prepBodySchema = z.object({
	agent_id: z.string().min(1).max(80),
	chain: z.string().min(8).max(120),
	wallet_address: z.string().min(20).max(80),
	name: z.string().trim().min(1).max(60),
	description: z.string().trim().max(280).default(''),
	avatar_id: z.string().uuid().nullable().optional(),
	skills: z
		.array(z.string().regex(/^[a-z0-9-]{1,40}$/i))
		.max(16)
		.optional(),
});

// Pin a manifest. Try web3.storage first for true IPFS pinning. If unavailable,
// fall back to R2: compute the real CIDv1 (raw codec, sha2-256 multihash) from
// the bytes so the cid is verifiable IPFS content-addressing, and return the
// R2 HTTPS URL as the resolvable location. The on-chain registry accepts both
// ipfs:// and https:// URIs (see src/erc8004/resolver.js), so a real https URL
// is a first-class result — never a stub.
async function pinManifest(manifest) {
	const bytes = Buffer.from(JSON.stringify(manifest), 'utf-8');
	const token = process.env.WEB3_STORAGE_TOKEN;
	if (token) {
		try {
			const r = await fetch('https://api.web3.storage/upload', {
				method: 'POST',
				headers: { Authorization: `Bearer ${token}` },
				body: bytes,
			});
			if (r.ok) {
				const data = await r.json();
				if (data.cid) return { cid: data.cid, uri: `ipfs://${data.cid}` };
			}
			console.warn('[onchain/prep] web3.storage returned', r.status);
		} catch (e) {
			console.warn('[onchain/prep] web3.storage pin failed:', e.message);
		}
	}
	// R2-backed fallback: compute the real raw-codec CIDv1 so the bytes are
	// verifiable via IPFS gateways (any gateway that supports raw codec can
	// resolve the same bytes if someone later pins them), but the returned
	// `uri` is the HTTPS R2 URL — real, resolvable, no stub.
	const digest = await sha256.digest(bytes);
	const cid = CID.create(1, raw.code, digest).toString();
	const key = `agent-manifests/${Date.now()}-${randomToken(8)}.json`;
	await r2.send(
		new PutObjectCommand({
			Bucket: env.S3_BUCKET,
			Key: key,
			Body: bytes,
			ContentType: 'application/json',
		}),
	);
	return { cid, uri: publicUrl(key) };
}

function buildManifest({ name, description, avatar_id, skills }) {
	return {
		$schema: 'https://3d-agent.io/schemas/manifest/0.1.json',
		spec: 'agent-manifest/0.1',
		name,
		description,
		image: '',
		tags: [],
		body: { uri: '', format: 'gltf-binary' },
		_baseURI: 'ipfs://',
		...(avatar_id ? { avatarId: avatar_id } : {}),
		...(skills?.length ? { skills } : {}),
	};
}

async function prepEvm({ chainId, metadataUri }) {
	// EVM: client builds its own tx via ethers; we just hand back the metadata
	// URI and the registry address (looked up from the existing chain config).
	const { CHAIN_BY_ID } = await import('../../_lib/erc8004-chains.js');
	return {
		contractAddress: CHAIN_BY_ID?.[chainId]?.registry || null,
		metadataUri,
	};
}

const SOLANA_PUBLIC_RPC = {
	mainnet: 'https://api.mainnet-beta.solana.com',
	devnet: 'https://api.devnet.solana.com',
};

async function buildSolanaTx({ rpc, walletAddress, name, metadataUri }) {
	const umi = createUmi(rpc).use(mplCore());
	const ownerPk = umiPublicKey(walletAddress);
	const assetSigner = generateSigner(umi);
	umi.use(signerIdentity(createNoopSigner(ownerPk)));
	const builder = createV1(umi, { asset: assetSigner, owner: ownerPk, name, uri: metadataUri });
	const tx = await builder.buildAndSign(umi);
	return { assetSigner, txBytes: umi.transactions.serialize(tx) };
}

function isRpcAuthError(err) {
	const msg = err?.message || '';
	return msg.includes('401') || msg.includes('Unauthorized') || msg.includes('invalid api key');
}

async function prepSolana({ cluster, metadataUri, walletAddress, name }) {
	const configuredRpc =
		cluster === 'devnet'
			? process.env.SOLANA_RPC_URL_DEVNET || SOLANA_PUBLIC_RPC.devnet
			: process.env.SOLANA_RPC_URL || SOLANA_PUBLIC_RPC.mainnet;

	let assetSigner, txBytes;
	try {
		({ assetSigner, txBytes } = await buildSolanaTx({
			rpc: configuredRpc,
			walletAddress,
			name,
			metadataUri,
		}));
	} catch (err) {
		// If the configured RPC rejects with an auth error AND it's not already the
		// public endpoint, fall back to the public endpoint once.
		const isUsingPublic = configuredRpc === SOLANA_PUBLIC_RPC[cluster];
		if (!isRpcAuthError(err) || isUsingPublic) {
			if (isRpcAuthError(err)) {
				// Public RPC also returned auth error — Solana's public endpoints now
				// require an API key. Surface a clear operator-facing message.
				const e = new Error(
					'Solana RPC rejected the request with an auth error. ' +
						'Set SOLANA_RPC_URL (mainnet) or SOLANA_RPC_URL_DEVNET (devnet) ' +
						'to a valid RPC endpoint with an API key.',
				);
				e.code = 'rpc_auth_failed';
				throw e;
			}
			throw err;
		}

		console.warn('[onchain/prep] configured Solana RPC auth failed, retrying with public RPC');
		try {
			({ assetSigner, txBytes } = await buildSolanaTx({
				rpc: SOLANA_PUBLIC_RPC[cluster],
				walletAddress,
				name,
				metadataUri,
			}));
		} catch (fallbackErr) {
			if (isRpcAuthError(fallbackErr)) {
				const e = new Error(
					'Solana RPC rejected the request with an auth error. ' +
						'Set SOLANA_RPC_URL (mainnet) or SOLANA_RPC_URL_DEVNET (devnet) ' +
						'to a valid RPC endpoint with an API key.',
				);
				e.code = 'rpc_auth_failed';
				throw e;
			}
			throw fallbackErr;
		}
	}

	return {
		assetPubkey: assetSigner.publicKey,
		txBase64: Buffer.from(txBytes).toString('base64'),
		metadataUri,
	};
}

async function handlePrep(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const user = await getSessionUser(req);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const body = parse(prepBodySchema, await readJson(req));

	let chain;
	try {
		chain = parseChain(body.chain);
	} catch (e) {
		return error(res, 400, 'validation_error', `invalid chain: ${e.message}`);
	}

	if (body.avatar_id) {
		const [av] = await sql`
			select id from avatars
			where id=${body.avatar_id} and owner_id=${user.id} and deleted_at is null
			limit 1
		`;
		if (!av) return error(res, 404, 'not_found', 'avatar not found');
	}

	// Refuse if the wallet is linked to a *different* user. If unlinked, allow
	// — confirm-time tx receipt verification is the binding step.
	const [conflict] = await sql`
		select user_id from user_wallets
		where address = ${body.wallet_address}
		  and chain_type = ${chain.family === 'solana' ? 'solana' : 'evm'}
		  and user_id <> ${user.id}
		limit 1
	`;
	if (conflict) {
		return error(res, 403, 'forbidden', 'wallet is linked to another account');
	}

	const manifest = buildManifest(body);
	const { cid, uri: metadataUri } = await pinManifest(manifest);

	let familyPrep;
	try {
		if (chain.family === 'evm') {
			familyPrep = await prepEvm({ chainId: chain.chainId, metadataUri });
		} else {
			familyPrep = await prepSolana({
				cluster: chain.cluster,
				metadataUri,
				walletAddress: body.wallet_address,
				name: body.name,
			});
		}
	} catch (e) {
		if (e.code === 'rpc_auth_failed') {
			return error(res, 503, 'rpc_unavailable', e.message);
		}
		throw e;
	}

	const prepId = await randomToken(24);
	const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

	await sql`
		insert into agent_registrations_pending
			(user_id, cid, metadata_uri, payload, expires_at)
		values (
			${user.id},
			${cid},
			${metadataUri},
			${JSON.stringify({
				prep_id: prepId,
				agent_id: body.agent_id,
				chain: body.chain,
				chain_family: chain.family,
				wallet_address: body.wallet_address,
				name: body.name,
				description: body.description,
				avatar_id: body.avatar_id || null,
				skills: body.skills || [],
				...(chain.family === 'evm'
					? { contract_address: familyPrep.contractAddress }
					: { asset_pubkey: familyPrep.assetPubkey, cluster: chain.cluster }),
			})}::jsonb,
			${expiresAt}
		)
	`;

	return json(res, 201, {
		prepId,
		chain: body.chain,
		metadataUri,
		cid,
		...(chain.family === 'evm'
			? { contractAddress: familyPrep.contractAddress }
			: {
					assetPubkey: familyPrep.assetPubkey,
					txBase64: familyPrep.txBase64,
					cluster: chain.cluster,
				}),
		expiresAt: expiresAt.toISOString(),
	});
}

// ── confirm ──────────────────────────────────────────────────────────────────

const confirmBodySchema = z.object({
	prep_id: z.string().min(8).max(80),
	tx_hash: z.string().min(8).max(120),
	onchain_id: z.string().nullable().optional(),
	wallet_address: z.string().min(20).max(80),
});

async function verifyEvm({ chainId, txHash, expectedContract, expectedOwner }) {
	const { CHAIN_BY_ID } = await import('../../_lib/erc8004-chains.js');
	const cfg = CHAIN_BY_ID[chainId];
	if (!cfg?.rpcUrl) throw new Error(`no RPC for chainId ${chainId}`);

	const provider = new JsonRpcProvider(cfg.rpcUrl);
	const receipt = await provider.getTransactionReceipt(txHash);
	if (!receipt) {
		const e = new Error('Transaction not found yet — try again in a few seconds.');
		e.code = 'tx_not_found';
		e.status = 422;
		throw e;
	}
	if (receipt.status !== 1) {
		const e = new Error('Transaction failed on-chain.');
		e.code = 'tx_failed';
		e.status = 422;
		throw e;
	}
	if (
		expectedContract &&
		receipt.to &&
		receipt.to.toLowerCase() !== expectedContract.toLowerCase()
	) {
		const e = new Error('tx target does not match expected registry.');
		e.code = 'tx_wrong_target';
		e.status = 422;
		throw e;
	}
	if (receipt.from.toLowerCase() !== expectedOwner.toLowerCase()) {
		const e = new Error('tx sender does not match wallet_address.');
		e.code = 'tx_wrong_sender';
		e.status = 422;
		throw e;
	}
	return { blockNumber: receipt.blockNumber };
}

async function verifySolana({ cluster, txSig, expectedAsset, expectedOwner }) {
	const rpc =
		cluster === 'devnet'
			? process.env.SOLANA_RPC_URL_DEVNET || 'https://api.devnet.solana.com'
			: process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
	const conn = new Connection(rpc, 'confirmed');

	// Bounded poll — RPC may not have indexed the tx yet, especially on devnet.
	const deadline = Date.now() + 20_000;
	let tx;
	while (Date.now() < deadline) {
		tx = await conn.getParsedTransaction(txSig, {
			maxSupportedTransactionVersion: 0,
			commitment: 'confirmed',
		});
		if (tx) break;
		await new Promise((r) => setTimeout(r, 1500));
	}
	if (!tx) {
		const e = new Error('Transaction not found on Solana RPC.');
		e.code = 'tx_not_found';
		e.status = 422;
		throw e;
	}
	if (tx.meta?.err) {
		const e = new Error('Transaction failed on-chain.');
		e.code = 'tx_failed';
		e.status = 422;
		throw e;
	}

	const accountKeys = tx.transaction.message.accountKeys.map((k) => k.pubkey?.toString());
	if (expectedAsset && !accountKeys.includes(expectedAsset)) {
		const e = new Error('Asset pubkey not found in transaction.');
		e.code = 'asset_not_in_tx';
		e.status = 422;
		throw e;
	}
	if (!accountKeys.includes(expectedOwner)) {
		const e = new Error('Wallet address not in transaction signers.');
		e.code = 'wrong_signer';
		e.status = 422;
		throw e;
	}
	return { slot: tx.slot };
}

async function handleConfirm(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const user = await getSessionUser(req);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const body = parse(confirmBodySchema, await readJson(req));

	const [prep] = await sql`
		select id, payload, metadata_uri, cid
		from agent_registrations_pending
		where user_id = ${user.id}
		  and payload->>'prep_id' = ${body.prep_id}
		  and expires_at > now()
		limit 1
	`;
	if (!prep) return error(res, 404, 'not_found', 'prep record expired or not found');

	const p = prep.payload;
	if (p.wallet_address !== body.wallet_address) {
		return error(res, 400, 'validation_error', 'wallet_address mismatch with prep record');
	}

	// Verify on-chain
	try {
		if (p.chain_family === 'evm') {
			const chainId = Number(p.chain.split(':')[1]);
			await verifyEvm({
				chainId,
				txHash: body.tx_hash,
				expectedContract: p.contract_address,
				expectedOwner: body.wallet_address,
			});
		} else if (p.chain_family === 'solana') {
			await verifySolana({
				cluster: p.cluster,
				txSig: body.tx_hash,
				expectedAsset: p.asset_pubkey,
				expectedOwner: body.wallet_address,
			});
		} else {
			return error(res, 400, 'validation_error', `unknown chain family: ${p.chain_family}`);
		}
	} catch (e) {
		return error(res, e.status || 500, e.code || 'verify_failed', e.message);
	}

	// Link wallet to user (idempotent — confirm time, since tx is ownership proof).
	await sql`
		insert into user_wallets (user_id, address, chain_type, is_primary)
		values (${user.id}, ${body.wallet_address}, ${p.chain_family === 'solana' ? 'solana' : 'evm'}, false)
		on conflict do nothing
	`;

	// Build the unified onchain block.
	const onchain = {
		chain: p.chain,
		family: p.chain_family,
		tx_hash: body.tx_hash,
		onchain_id: body.onchain_id || null,
		contract_or_mint: p.contract_address || p.asset_pubkey || null,
		wallet: body.wallet_address,
		metadata_uri: prep.metadata_uri,
		confirmed_at: new Date().toISOString(),
		...(p.chain_family === 'solana' ? { cluster: p.cluster } : {}),
	};

	// Upsert agent_identities. If a row already exists for (user, agent), we
	// merge the new onchain block in — supports redeploying across chains.
	const [existing] = await sql`
		select id, meta from agent_identities
		where user_id = ${user.id}
		  and (id::text = ${p.agent_id} or name = ${p.name})
		  and deleted_at is null
		limit 1
	`;

	let agent;
	if (existing) {
		const mergedMeta = { ...(existing.meta || {}), onchain };
		[agent] = await sql`
			update agent_identities
			set meta = ${JSON.stringify(mergedMeta)}::jsonb,
			    wallet_address = ${body.wallet_address},
			    updated_at = now()
			where id = ${existing.id}
			returning id, name, description, wallet_address, meta, created_at
		`;
	} else {
		[agent] = await sql`
			insert into agent_identities
				(user_id, name, description, avatar_id, wallet_address, meta)
			values (
				${user.id},
				${p.name},
				${p.description},
				${p.avatar_id},
				${body.wallet_address},
				${JSON.stringify({ onchain })}::jsonb
			)
			returning id, name, description, wallet_address, meta, created_at
		`;
	}

	// Cleanup prep
	await sql`delete from agent_registrations_pending where id = ${prep.id}`;

	return json(res, 201, {
		ok: true,
		agent: {
			...agent,
			onchain,
			home_url: `${env.APP_ORIGIN}/agent/${agent.id}`,
		},
	});
}
