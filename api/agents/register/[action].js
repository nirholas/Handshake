// Consolidated ERC-8004 agent registration endpoints.
// prep: build metadata + pin + store record
// confirm: verify on-chain tx, upsert agent_identities + erc8004_agents_index

import { sql } from '../../_lib/db.js';
import { getSessionUser } from '../../_lib/auth.js';
import { cors, json, method, wrap, error, readJson, rateLimited } from '../../_lib/http.js';
import { parse } from '../../_lib/validate.js';
import { limits, clientIp } from '../../_lib/rate-limit.js';
import { env } from '../../_lib/env.js';
import { erc8004RegistryFields } from '../../_lib/three-brand.js';
import { r2, publicUrl, isStorageInfrastructureError } from '../../_lib/r2.js';
import { SERVER_CHAIN_META } from '../../_lib/onchain.js';
import { evmRpcEndpoints } from '../../_lib/evm/rpc.js';
import { publishFeedEvent } from '../../_lib/feed.js';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { AbiCoder, getAddress, keccak256, toUtf8Bytes } from 'ethers';
import { z } from 'zod';

import { fetchUpstream } from '../../_lib/upstream-fetch.js';
// ── prep ──────────────────────────────────────────────────────────────────────

const prepSchema = z.object({
	name: z.string().trim().min(1).max(60),
	// agent_identities bios run up to 500 chars (api/agents.js): accept the
	// same cap here so a long bio doesn't 400 the deploy.
	description: z.string().trim().max(500),
	avatarId: z.string().uuid(),
	// When deploying an EXISTING three.ws agent (the profile-page DeployButton),
	// its row id: confirm binds the on-chain identity onto that row instead of
	// inserting a duplicate.
	agentDbId: z.string().uuid().optional(),
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
			const res = await fetchUpstream('https://api.web3.storage/upload', {
				method: 'POST',
				headers: { Authorization: `Bearer ${web3Token}` },
				body: jsonBytes,
			}, { timeoutMs: 60_000, attempts: 2, okWhen: () => true });
			if (res.ok) {
				const r = await res.json();
				if (r.cid) {
					await storeToR2(jsonBytes);
					return { cid: r.cid, metadataURI: `ipfs://${r.cid}` };
				}
			} else {
				console.warn('[register/prep] web3.storage upload failed:', res.status);
			}
		} catch (e) {
			console.warn('[register/prep] web3.storage upload error:', e?.message);
		}
	}

	// 2. Try Pinata if configured.
	const pinataJwt = env.PINATA_JWT;
	if (pinataJwt) {
		try {
			const form = new FormData();
			form.append('file', new Blob([jsonBytes], { type: 'application/json' }), 'agent-manifest.json');
			const res = await fetchUpstream('https://api.pinata.cloud/pinning/pinFileToIPFS', {
				method: 'POST',
				headers: { Authorization: `Bearer ${pinataJwt}` },
				body: form,
			}, { timeoutMs: 60_000, attempts: 2, okWhen: () => true });
			if (res.ok) {
				const r = await res.json();
				if (r.IpfsHash) {
					await storeToR2(jsonBytes);
					return { cid: r.IpfsHash, metadataURI: `ipfs://${r.IpfsHash}` };
				}
			} else {
				console.warn('[register/prep] pinata upload failed:', res.status);
			}
		} catch (e) {
			console.warn('[register/prep] pinata upload error:', e?.message);
		}
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
	if (!rl.success) return rateLimited(res, rl);
	const body = parse(prepSchema, await readJson(req));
	const [avatar] = await sql`select id from avatars where id = ${body.avatarId} and owner_id = ${session.id} and deleted_at is null limit 1`;
	if (!avatar) return error(res, 404, 'not_found', 'avatar not found');
	if (body.agentDbId) {
		const [agent] = await sql`select id from agent_identities where id = ${body.agentDbId} and user_id = ${session.id} and deleted_at is null limit 1`;
		if (!agent) return error(res, 404, 'not_found', 'agent not found');
	}
	const registrationJson = {
		$schema: 'https://3d-agent.io/schemas/manifest/0.1.json', spec: 'agent-manifest/0.1',
		name: body.name, description: body.description, image: '', tags: [],
		body: { uri: '', format: 'gltf-binary' }, _baseURI: `ipfs://`,
		// ERC-8004 registration-file fields the registry subgraph indexes — without
		// them the agent shows as inactive / "x402 Not Supported".
		...erc8004RegistryFields(env.APP_ORIGIN),
		...(body.brain && { brain: body.brain }),
		...(body.skills?.length > 0 && { skills: body.skills }),
		...(body.embedPolicy && { embedPolicy: body.embedPolicy }),
		...(body.demoSlug && { demoSlug: body.demoSlug }),
	};
	// The manifest has to be stored somewhere resolvable before an on-chain
	// registration can point at it, and the last-resort store is our own bucket:
	// when the bucket rejects our credential there is nowhere to put it and the
	// registration genuinely cannot proceed. Say that, instead of throwing the
	// store's signing complaint at someone who was creating an agent (on
	// 2026-09-07 a rejected R2 secret failed this path and the forge together, so
	// an agent could be neither given an avatar nor registered).
	let pinned;
	try {
		pinned = await pinRegistrationJson(registrationJson);
	} catch (err) {
		if (!isStorageInfrastructureError(err)) throw err;
		console.error(`[register/prep] object storage rejected the manifest: ${err?.message || err}`);
		res.setHeader('retry-after', '60');
		return error(
			res,
			503,
			'storage_unavailable',
			'Agent registration is temporarily unavailable while our asset storage recovers. Your avatar is safe: try again shortly.',
		);
	}
	const { cid, metadataURI } = pinned;
	const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
	// payload stores the pinned manifest plus a _local block confirm needs to
	// bind the identity row (never pinned: added after the pin above).
	const payload = { ...registrationJson, _local: { avatarId: body.avatarId, ...(body.agentDbId ? { agentDbId: body.agentDbId } : {}) } };
	const [prep] = await sql`insert into agent_registrations_pending (user_id, cid, metadata_uri, payload, expires_at) values (${session.id}, ${cid}, ${metadataURI}, ${JSON.stringify(payload)}::jsonb, ${expiresAt}) returning id`;
	return json(res, 200, { ok: true, cid, metadataURI, prepId: prep.id });
}

// ── confirm ───────────────────────────────────────────────────────────────────

const confirmSchema = z.object({
	prepId: z.string().uuid(),
	chainId: z.number().int().positive(),
	// The client's best-effort parse of the Registered event. '0'/absent means
	// "couldn't parse": the server-decoded event id is authoritative either way.
	agentId: z.union([z.string(), z.number()]).optional(),
	txHash: z.string().regex(/^0x[a-f0-9]{64}$/i),
});

const RPC_TIMEOUT_MS = 10_000;
const REGISTERED_TOPIC = keccak256(toUtf8Bytes('Registered(uint256,string,address)'));

// eth_getTransactionReceipt with sequential failover across the chain's full
// endpoint list (RPC_URL_<id> override → Alchemy → keyless public tail).
async function fetchTransactionReceipt(chainId, primaryUrl, txHash) {
	const urls = evmRpcEndpoints(chainId, primaryUrl);
	let lastErr;
	for (const url of urls.length ? urls : [primaryUrl]) {
		const ac = new AbortController();
		const t = setTimeout(() => ac.abort(), RPC_TIMEOUT_MS);
		try {
			const res = await fetch(url, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [txHash] }),
				signal: ac.signal,
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = await res.json();
			if (data.error) throw new Error(`RPC error: ${data.error.message}`);
			return data.result;
		} catch (err) {
			lastErr = err;
		} finally {
			clearTimeout(t);
		}
	}
	throw lastErr ?? new Error('no RPC endpoint available');
}

/**
 * Decode the Registered(uint256 indexed agentId, string agentURI, address
 * indexed owner) event emitted by the Identity Registry. Returns the full
 * on-chain truth: id and owner from the indexed topics, URI from the data
 * so nothing security-relevant comes from the client.
 */
function parseRegisteredEvent(logs, registryAddress) {
	const registryAddr = getAddress(registryAddress);
	for (const log of logs ?? []) {
		if (getAddress(log.address) === registryAddr && log.topics?.[0] === REGISTERED_TOPIC) {
			return {
				onChainId: BigInt(log.topics[1]).toString(),
				owner: getAddress('0x' + log.topics[2].slice(-40)).toLowerCase(),
				agentURI: AbiCoder.defaultAbiCoder().decode(['string'], log.data)[0],
			};
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
	if (!rl.success) return rateLimited(res, rl);
	const body = parse(confirmSchema, await readJson(req));
	const chainMeta = SERVER_CHAIN_META[body.chainId];
	if (!chainMeta) return error(res, 400, 'bad_request', `unsupported chain ${body.chainId}`);
	const [prep] = await sql`select id, cid, metadata_uri, payload from agent_registrations_pending where id = ${body.prepId} and user_id = ${session.id} and expires_at > now() limit 1`;
	if (!prep) return error(res, 404, 'not_found', 'prep record not found or expired');
	let receipt;
	try { receipt = await fetchTransactionReceipt(body.chainId, chainMeta.rpc, body.txHash); }
	catch (err) { return error(res, 400, 'bad_request', `tx verification failed: ${err.message}`); }
	if (!receipt) return error(res, 400, 'bad_request', 'tx not found or still pending');
	const status = typeof receipt.status === 'string' ? Number.parseInt(receipt.status, 16) : receipt.status;
	if (status !== 1) return error(res, 400, 'bad_request', 'tx failed on-chain');
	let ev;
	try { ev = parseRegisteredEvent(receipt.logs, chainMeta.registry); }
	catch (err) { return error(res, 400, 'bad_request', `failed to parse event: ${err.message}`); }
	if (ev.agentURI !== prep.metadata_uri) return error(res, 409, 'conflict', `metadata URI mismatch: expected ${prep.metadata_uri} got ${ev.agentURI}`);
	// The client's parsed agentId is advisory; when it claims one, it must match
	// the id the chain actually emitted.
	const claimed = body.agentId == null ? null : String(body.agentId);
	if (claimed && claimed !== '0' && claimed !== ev.onChainId) {
		return error(res, 409, 'conflict', `agentId mismatch: receipt says ${ev.onChainId}`);
	}

	const local = prep.payload?._local || {};
	const onchain = {
		chain: `eip155:${body.chainId}`,
		family: 'evm',
		tx_hash: body.txHash,
		onchain_id: ev.onChainId,
		contract_or_mint: chainMeta.registry,
		wallet: ev.owner,
		metadata_uri: prep.metadata_uri,
		confirmed_at: new Date().toISOString(),
	};

	let identityId;
	if (local.agentDbId) {
		// Bind onto the existing agent row the DeployButton was pressed on
		// merge meta.onchain, never clobber the agent's own name/description.
		const [existing] = await sql`select id, meta from agent_identities where id = ${local.agentDbId} and user_id = ${session.id} and deleted_at is null limit 1`;
		if (existing) {
			const mergedMeta = { ...(existing.meta || {}), onchain };
			await sql`
				update agent_identities
				set meta = ${JSON.stringify(mergedMeta)}::jsonb,
				    wallet_address = ${ev.owner},
				    chain_id = ${body.chainId},
				    erc8004_agent_id = ${BigInt(ev.onChainId)},
				    erc8004_registry = ${chainMeta.registry},
				    registration_cid = ${prep.cid ?? prep.metadata_uri},
				    updated_at = now()
				where id = ${existing.id} and user_id = ${session.id}
			`;
			identityId = existing.id;
		}
	}
	if (!identityId) {
		const [inserted] = await sql`
			insert into agent_identities
				(user_id, name, description, avatar_id, wallet_address, chain_id, erc8004_agent_id, erc8004_registry, registration_cid, meta)
			values
				(${session.id}, ${(prep.payload.name || 'Unnamed Agent').slice(0, 255)}, ${(prep.payload.description || '').slice(0, 1000)},
				 ${local.avatarId ?? null}, ${ev.owner}, ${body.chainId}, ${BigInt(ev.onChainId)}, ${chainMeta.registry},
				 ${prep.cid ?? prep.metadata_uri}, ${JSON.stringify({ onchain })}::jsonb)
			returning id
		`;
		identityId = inserted.id;
	}

	// Mirror into the public registry index so /deployments shows the agent the
	// moment the tx confirms, instead of waiting for the next crawler pass.
	await sql`
		insert into erc8004_agents_index
			(chain_id, agent_id, owner, registry, agent_uri, name, description, active,
			 registered_block, registered_tx, registered_at, last_seen_at)
		values
			(${body.chainId}, ${ev.onChainId}, ${ev.owner}, ${chainMeta.registry.toLowerCase()},
			 ${prep.metadata_uri}, ${(prep.payload.name || '').slice(0, 200) || null},
			 ${(prep.payload.description || '').slice(0, 1000) || null}, true,
			 ${Number.parseInt(receipt.blockNumber, 16) || null}, ${body.txHash}, now(), now())
		on conflict (chain_id, agent_id) do update
			set agent_uri = excluded.agent_uri, name = excluded.name,
			    description = excluded.description, last_seen_at = now()
	`.catch((e) => console.warn('[register/confirm] index mirror failed:', e?.message));

	await sql`delete from agent_registrations_pending where id = ${body.prepId}`;
	// Truthful "deployed on-chain" ticker event — only after the ERC-8004 tx is
	// verified and the agent row carries its on-chain id. Fire-and-forget.
	publishFeedEvent({
		type: 'agent-onchain',
		ts: Date.now(),
		actor: prep.payload.name || 'An agent',
		agentId: identityId,
		name: prep.payload.name || 'An agent',
		chain: chainMeta.name || 'EVM',
	}).catch(() => {});
	return json(res, 200, { ok: true, agentId: identityId, onchainAgentId: ev.onChainId, owner: ev.owner });
}

// ── dispatcher ────────────────────────────────────────────────────────────────

const DISPATCH = { prep: handlePrep, confirm: handleConfirm };

export default wrap(async (req, res) => {
	const action = req.query?.action ?? new URL(req.url, 'http://x').pathname.split('/').pop();
	const fn = DISPATCH[action];
	if (!fn) return error(res, 404, 'not_found', `unknown register action: ${action}`);
	return fn(req, res);
});
