import { id as keccakId, getAddress } from 'ethers';
import { z } from 'zod';
import { sql } from '../_lib/db.js';
import { getSessionUser, authenticateBearer, extractBearer, hasScope } from '../_lib/auth.js';
import { cors, json, method, wrap, error, readJson } from '../_lib/http.js';
import { parse } from '../_lib/validate.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { CHAIN_BY_ID } from '../_lib/erc8004-chains.js';

const REGISTERED_TOPIC = keccakId('Registered(uint256,string,address)');
const TIMEOUT_MS = 10_000;
const bodySchema = z.object({
	chainId: z.number().int().positive(),
	txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
	agentId: z.union([z.string(), z.number()]).transform(String),
	metadataUri: z.string().min(1),
	ownerAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
});

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;
	const session = await getSessionUser(req);
	const bearer = session ? null : await authenticateBearer(extractBearer(req));
	if (!session && !bearer) return error(res, 401, 'unauthorized', 'sign in required');
	if (bearer && !hasScope(bearer.scope, 'avatars:write'))
		return error(res, 403, 'insufficient_scope', 'avatars:write scope required');
	const rl = await limits.registerIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');
	const body = parse(bodySchema, await readJson(req));
	const chain = CHAIN_BY_ID[body.chainId];
	if (!chain) return error(res, 400, 'bad_request', `unsupported chain ${body.chainId}`);
	const receipt = await rpcCall(chain.rpcUrls ?? chain.rpcUrl, 'eth_getTransactionReceipt', [body.txHash]);
	if (!receipt) return error(res, 422, 'tx_not_mined', 'transaction not yet mined');
	if (receipt.status === '0x0') return error(res, 422, 'tx_failed', 'transaction reverted');
	const log = (receipt.logs ?? []).find(
		(l) => l.address?.toLowerCase() === chain.registry.toLowerCase() && l.topics?.[0] === REGISTERED_TOPIC,
	);
	if (!log) return error(res, 422, 'event_not_found', 'Registered event not found in receipt');
	const onChainId = BigInt(log.topics[1]).toString();
	const ownerHex = getAddress('0x' + log.topics[2].slice(-40)).toLowerCase();
	if (onChainId !== body.agentId) return error(res, 422, 'mismatch', 'agentId mismatch');
	if (ownerHex !== body.ownerAddress.toLowerCase()) return error(res, 422, 'mismatch', 'ownerAddress mismatch');
	await sql`
		INSERT INTO erc8004_agents_index
			(chain_id, agent_id, owner, registry, agent_uri,
			 registered_block, registered_tx, registered_at, last_seen_at)
		VALUES
			(${body.chainId}, ${onChainId}, ${ownerHex}, ${chain.registry.toLowerCase()},
			 ${body.metadataUri}, ${Number.parseInt(receipt.blockNumber, 16)}, ${body.txHash}, now(), now())
		ON CONFLICT (chain_id, agent_id) DO NOTHING
	`;
	await enrichMetadata(body.chainId, onChainId, body.metadataUri).catch(() => {});
	return json(res, 200, { success: true, agentId: onChainId, chainId: body.chainId });
});

async function rpcCall(urls, m, params) {
	const urlList = Array.isArray(urls) ? urls : [urls];
	let lastErr;
	for (const url of urlList) {
		const ac = new AbortController();
		const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
		try {
			const r = await fetch(url, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: m, params }),
				signal: ac.signal,
			});
			if (!r.ok) throw new Error(`HTTP ${r.status} from ${url}`);
			const d = await r.json();
			if (d.error) throw new Error(`RPC ${d.error.code}: ${d.error.message}`);
			return d.result;
		} catch (err) {
			lastErr = err;
		} finally {
			clearTimeout(t);
		}
	}
	throw lastErr;
}

function resolveGateway(uri) {
	if (!uri) return '';
	if (uri.startsWith('ipfs://')) return 'https://ipfs.io/ipfs/' + uri.slice(7);
	if (uri.startsWith('ar://')) return 'https://arweave.net/' + uri.slice(5);
	return uri.startsWith('http') ? uri : '';
}

async function enrichMetadata(chainId, agentId, uri) {
	const url = resolveGateway(uri);
	if (!url) return;
	const r = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
	if (!r.ok) return;
	const meta = await r.json();
	const services = Array.isArray(meta.services) ? meta.services : [];
	const avatarSvc = services.find((s) => String(s?.name || '').toLowerCase() === 'avatar' && s?.endpoint);
	const glbUrl = avatarSvc ? resolveGateway(avatarSvc.endpoint) : null;
	await sql`
		UPDATE erc8004_agents_index
		SET name = ${(meta.name || '').slice(0, 200) || null},
		    description = ${(meta.description || '').slice(0, 1000) || null},
		    image = ${resolveGateway(meta.image || '') || null},
		    glb_url = ${glbUrl}, services = ${JSON.stringify(services)}::jsonb,
		    has_3d = ${!!glbUrl}, active = ${meta.active !== false},
		    x402_support = ${!!(meta.x402Support || meta.x402)},
		    metadata_error = null, last_metadata_at = now()
		WHERE chain_id = ${chainId} AND agent_id = ${agentId}
	`;
}
