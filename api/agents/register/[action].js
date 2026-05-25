// Consolidated ERC-8004 agent registration endpoints.
// prep: build metadata + pin + store record
// confirm: verify on-chain tx, upsert agent_identities

import { sql } from '../../_lib/db.js';
import { getSessionUser } from '../../_lib/auth.js';
import { cors, json, method, wrap, error, readJson } from '../../_lib/http.js';
import { parse } from '../../_lib/validate.js';
import { limits, clientIp } from '../../_lib/rate-limit.js';
import { env } from '../../_lib/env.js';
import { r2, publicUrl } from '../../_lib/r2.js';
import { SERVER_CHAIN_META } from '../../_lib/onchain.js';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { AbiCoder, getAddress, keccak256, toUtf8Bytes } from 'ethers';
import { z } from 'zod';

// ── prep ──────────────────────────────────────────────────────────────────────

const prepSchema = z.object({
	name: z.string().trim().min(1).max(60),
	description: z.string().trim().max(280),
	avatarId: z.string().uuid(),
	brain: z.object({ provider: z.string().optional(), model: z.string().optional(), instructions: z.string().optional() }).optional(),
	skills: z.array(z.string().regex(/^[a-z0-9-]{1,40}$/i)).max(16).optional(),
	embedPolicy: z.record(z.any()).optional(),
	demoSlug: z.string().optional(),
});

// Store registration JSON to R2 and return a public HTTPS URL.
// Always succeeds — R2 is the source of truth even when IPFS is available.
async function storeToR2(jsonBytes) {
	const key = `agent-registrations/${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
	await r2.send(new PutObjectCommand({ Bucket: env.S3_BUCKET, Key: key, Body: jsonBytes, ContentType: 'application/json' }));
	return { key, httpsUrl: publicUrl(key) };
}

async function pinRegistrationJson(jsonObj) {
	const jsonStr = JSON.stringify(jsonObj);
	const jsonBytes = Buffer.from(jsonStr, 'utf-8');

	// 1. Try web3.storage (legacy, still supported).
	const web3Token = process.env.WEB3_STORAGE_TOKEN;
	if (web3Token) {
		try {
			const res = await fetch('https://api.web3.storage/upload', {
				method: 'POST',
				headers: { Authorization: `Bearer ${web3Token}` },
				body: jsonBytes,
			});
			if (res.ok) {
				const r = await res.json();
				if (r.cid) {
					await storeToR2(jsonBytes);
					return { cid: r.cid, metadataURI: `ipfs://${r.cid}` };
				}
			}
		} catch {}
	}

	// 2. Try Pinata if configured.
	const pinataJwt = env.PINATA_JWT;
	if (pinataJwt) {
		try {
			const form = new FormData();
			form.append('file', new Blob([jsonBytes], { type: 'application/json' }), 'agent-manifest.json');
			const res = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', {
				method: 'POST',
				headers: { Authorization: `Bearer ${pinataJwt}` },
				body: form,
			});
			if (res.ok) {
				const r = await res.json();
				if (r.IpfsHash) {
					await storeToR2(jsonBytes);
					return { cid: r.IpfsHash, metadataURI: `ipfs://${r.IpfsHash}` };
				}
			}
		} catch {}
	}

	// 3. No IPFS provider — store in R2 and return a real HTTPS URL.
	// On-chain consumers can resolve it; the metadata is fully public.
	const { httpsUrl } = await storeToR2(jsonBytes);
	return { cid: null, metadataURI: httpsUrl };
}

async function handlePrep(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;
	const session = await getSessionUser(req);
	if (!session) return error(res, 401, 'unauthorized', 'sign in required');
	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');
	const body = parse(prepSchema, await readJson(req));
	const [avatar] = await sql`select id from avatars where id = ${body.avatarId} and owner_id = ${session.id} and deleted_at is null limit 1`;
	if (!avatar) return error(res, 404, 'not_found', 'avatar not found');
	const registrationJson = {
		$schema: 'https://3d-agent.io/schemas/manifest/0.1.json', spec: 'agent-manifest/0.1',
		name: body.name, description: body.description, image: '', tags: [],
		body: { uri: '', format: 'gltf-binary' }, _baseURI: `ipfs://`,
		...(body.brain && { brain: body.brain }),
		...(body.skills?.length > 0 && { skills: body.skills }),
		...(body.embedPolicy && { embedPolicy: body.embedPolicy }),
		...(body.demoSlug && { demoSlug: body.demoSlug }),
	};
	const { cid, metadataURI } = await pinRegistrationJson(registrationJson);
	const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
	const [prep] = await sql`insert into agent_registrations_pending (user_id, cid, metadata_uri, payload, expires_at) values (${session.id}, ${cid}, ${metadataURI}, ${JSON.stringify(registrationJson)}::jsonb, ${expiresAt}) returning id`;
	return json(res, 200, { ok: true, cid, metadataURI, prepId: prep.id });
}

// ── confirm ───────────────────────────────────────────────────────────────────

const confirmSchema = z.object({
	prepId: z.string().uuid(),
	chainId: z.number().int().positive(),
	agentId: z.union([z.string(), z.number()]),
	txHash: z.string().regex(/^0x[a-f0-9]{64}$/i),
});

function eventSignatureHash(sig) { return keccak256(toUtf8Bytes(sig)); }

async function fetchTransactionReceipt(rpcUrl, txHash) {
	const res = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [txHash] }) });
	const data = await res.json();
	if (data.error) throw new Error(`RPC error: ${data.error.message}`);
	return data.result;
}

function parseRegisteredEvent(logs, registryAddress) {
	const registryAddr = getAddress(registryAddress);
	const topic0 = eventSignatureHash('Registered(uint256,string,address)');
	for (const log of logs) {
		if (getAddress(log.address) === registryAddr && log.topics[0] === topic0) {
			return AbiCoder.defaultAbiCoder().decode(['string'], log.data)[0];
		}
	}
	throw new Error('Registered event not found in receipt');
}

async function handleConfirm(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;
	const session = await getSessionUser(req);
	if (!session) return error(res, 401, 'unauthorized', 'sign in required');
	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');
	const body = parse(confirmSchema, await readJson(req));
	const chainMeta = SERVER_CHAIN_META[body.chainId];
	if (!chainMeta) return error(res, 400, 'bad_request', `unsupported chain ${body.chainId}`);
	const [prep] = await sql`select id, cid, metadata_uri, payload from agent_registrations_pending where id = ${body.prepId} and user_id = ${session.id} and expires_at > now() limit 1`;
	if (!prep) return error(res, 404, 'not_found', 'prep record not found or expired');
	let receipt;
	try { receipt = await fetchTransactionReceipt(chainMeta.rpc, body.txHash); }
	catch (err) { return error(res, 400, 'bad_request', `tx verification failed: ${err.message}`); }
	if (!receipt) return error(res, 400, 'bad_request', 'tx not found or still pending');
	if (receipt.status !== 1) return error(res, 400, 'bad_request', 'tx failed on-chain');
	let agentURI;
	try { agentURI = parseRegisteredEvent(receipt.logs, chainMeta.registry); }
	catch (err) { return error(res, 400, 'bad_request', `failed to parse event: ${err.message}`); }
	if (agentURI !== prep.metadata_uri) return error(res, 409, 'conflict', `metadata URI mismatch: expected ${prep.metadata_uri} got ${agentURI}`);
	const [updated] = await sql`insert into agent_identities (user_id, name, description, avatar_id, chain_id, erc8004_agent_id, erc8004_registry, registration_cid) values (${session.id}, ${(prep.payload.name || 'Unnamed Agent').slice(0, 255)}, ${(prep.payload.description || '').slice(0, 1000)}, null, ${body.chainId}, ${String(body.agentId)}, ${chainMeta.registry}, ${prep.cid}) on conflict (user_id) do update set name=excluded.name, description=excluded.description, chain_id=excluded.chain_id, erc8004_agent_id=excluded.erc8004_agent_id, erc8004_registry=excluded.erc8004_registry, registration_cid=excluded.registration_cid, updated_at=now() returning id`;
	await sql`delete from agent_registrations_pending where id = ${body.prepId}`;
	return json(res, 200, { ok: true, agentId: updated.id });
}

// ── dispatcher ────────────────────────────────────────────────────────────────

const DISPATCH = { prep: handlePrep, confirm: handleConfirm };

export default wrap(async (req, res) => {
	const action = req.query?.action ?? new URL(req.url, 'http://x').pathname.split('/').pop();
	const fn = DISPATCH[action];
	if (!fn) return error(res, 404, 'not_found', `unknown register action: ${action}`);
	return fn(req, res);
});
