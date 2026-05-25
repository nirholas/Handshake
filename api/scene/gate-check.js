import { z } from 'zod';
import { verifyMessage } from 'ethers';
import { sql } from '../_lib/db.js';
import { cors, json, method, readJson, wrap, error } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { randomToken } from '../_lib/crypto.js';
import { verifySiwsSignature } from '../_lib/siws.js';
import { parse } from '../_lib/validate.js';

const NONCE_TTL_SEC = 10 * 60;

const phase1Schema = z.object({
	gateId: z.string().trim().min(1).max(32),
	walletAddress: z.string().trim().min(1).max(128),
});

const phase2Schema = z.object({
	gateId: z.string().trim().min(1).max(32),
	walletAddress: z.string().trim().min(1).max(128),
	signature: z.string().min(1).max(512),
	message: z.string().min(1).max(1024),
});

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const raw = await readJson(req);

	if (raw.signature != null) return handlePhase2(res, raw);
	return handlePhase1(res, raw);
});

async function handlePhase1(res, raw) {
	const body = parse(phase1Schema, raw);

	const [gate] = await sql`
		select id, chain from scene_gates where id = ${body.gateId} limit 1
	`;
	if (!gate) return error(res, 404, 'not_found', 'gate not found');

	let nonce = '';
	while (nonce.length < 16) {
		nonce += randomToken(20).replace(/[^A-Za-z0-9]/g, '');
	}
	nonce = nonce.slice(0, 16);

	await sql`
		insert into gate_nonces (nonce, gate_id, address, expires_at)
		values (${nonce}, ${body.gateId}, ${body.walletAddress}, now() + ${`${NONCE_TTL_SEC} seconds`}::interval)
	`;

	const message = [
		'three.ws scene gate verification.',
		'',
		`Gate ID: ${body.gateId}`,
		`Wallet: ${body.walletAddress}`,
		`Nonce: ${nonce}`,
		`Issued At: ${new Date().toISOString()}`,
	].join('\n');

	return json(res, 200, { message, chain: gate.chain });
}

async function handlePhase2(res, raw) {
	const body = parse(phase2Schema, raw);

	const [gate] = await sql`
		select id, chain, kind, address, min_balance
		from scene_gates where id = ${body.gateId} limit 1
	`;
	if (!gate) return error(res, 404, 'not_found', 'gate not found');

	// Verify signature
	if (gate.chain === 'solana') {
		let valid;
		try {
			valid = verifySiwsSignature(body.message, body.signature, body.walletAddress);
		} catch {
			return error(res, 401, 'invalid_signature', 'Solana signature verification failed');
		}
		if (!valid) return error(res, 401, 'invalid_signature', 'Solana signature does not match wallet');
	} else {
		let recovered;
		try {
			recovered = verifyMessage(body.message, body.signature);
		} catch {
			return error(res, 401, 'invalid_signature', 'EVM signature verification failed');
		}
		if (recovered.toLowerCase() !== body.walletAddress.toLowerCase()) {
			return error(res, 401, 'invalid_signature', 'EVM signature does not match wallet');
		}
	}

	// Extract and burn nonce
	const nonceMatch = body.message.match(/^Nonce: (.+)$/m);
	if (!nonceMatch) return error(res, 400, 'invalid_message', 'nonce not found in message');
	const nonce = nonceMatch[1].trim();

	const [nonceRow] = await sql`
		select nonce, gate_id, address, expires_at, consumed_at
		from gate_nonces where nonce = ${nonce} limit 1
	`;
	if (!nonceRow) return error(res, 400, 'invalid_nonce', 'unknown nonce');
	if (nonceRow.consumed_at) return error(res, 400, 'nonce_reused', 'nonce already used');
	if (new Date(nonceRow.expires_at) < new Date()) return error(res, 400, 'nonce_expired', 'nonce expired');
	if (nonceRow.gate_id !== body.gateId) return error(res, 400, 'invalid_nonce', 'nonce gate mismatch');
	if (nonceRow.address !== body.walletAddress) return error(res, 400, 'invalid_nonce', 'nonce wallet mismatch');

	const burned = await sql`
		update gate_nonces set consumed_at = now()
		where nonce = ${nonce} and consumed_at is null
		returning nonce
	`;
	if (!burned[0]) return error(res, 400, 'nonce_reused', 'nonce already used');

	// Query chain holdings
	let balance;
	try {
		balance = await queryBalance(gate, body.walletAddress);
	} catch (e) {
		return json(res, 200, { allowed: false, reason: e.message || 'Balance check failed' });
	}

	const minBalance = Number(gate.min_balance);
	if (balance >= minBalance) {
		return json(res, 200, { allowed: true });
	}
	return json(res, 200, {
		allowed: false,
		reason: `Insufficient balance: need ${minBalance}, have ${balance}`,
	});
}

async function queryBalance(gate, walletAddress) {
	if (gate.chain === 'solana') return querySolanaBalance(gate, walletAddress);
	return queryEvmBalance(gate, walletAddress);
}

async function querySolanaBalance(gate, walletAddress) {
	const rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

	if (gate.kind === 'spl') {
		const resp = await fetch(rpcUrl, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0', id: 1,
				method: 'getTokenAccountsByOwner',
				params: [walletAddress, { mint: gate.address }, { encoding: 'jsonParsed' }],
			}),
		});
		if (!resp.ok) throw new Error(`Helius RPC error ${resp.status}`);
		const data = await resp.json();
		if (data.error) throw new Error(`Helius: ${data.error.message || JSON.stringify(data.error)}`);
		const accounts = data.result?.value || [];
		return accounts.reduce((sum, a) => sum + (a.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0), 0);
	}

	// NFT collection via DAS getAssetsByOwner
	const resp = await fetch(rpcUrl, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			jsonrpc: '2.0', id: 1,
			method: 'getAssetsByOwner',
			params: {
				ownerAddress: walletAddress,
				page: 1,
				limit: 1000,
				displayOptions: { showCollectionMetadata: false },
			},
		}),
	});
	if (!resp.ok) throw new Error(`Helius DAS error ${resp.status}`);
	const data = await resp.json();
	if (data.error) throw new Error(`Helius: ${data.error.message || JSON.stringify(data.error)}`);
	const assets = data.result?.items || [];
	return assets.filter((a) =>
		(a.grouping || []).some((g) => g.group_key === 'collection' && g.group_value === gate.address),
	).length;
}

async function queryEvmBalance(gate, walletAddress) {
	const alchemyKey = process.env.ALCHEMY_API_KEY;
	if (!alchemyKey) {
		const e = new Error('ALCHEMY_API_KEY not configured');
		e.status = 503;
		throw e;
	}
	const rpcUrl = `https://eth-mainnet.g.alchemy.com/v2/${alchemyKey}`;

	// balanceOf(address) — 0x70a08231
	const callData = '0x70a08231' + walletAddress.replace(/^0x/i, '').padStart(64, '0');
	const resp = await fetch(rpcUrl, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			jsonrpc: '2.0', id: 1,
			method: 'eth_call',
			params: [{ to: gate.address, data: callData }, 'latest'],
		}),
	});
	if (!resp.ok) throw new Error(`Alchemy error ${resp.status}`);
	const data = await resp.json();
	if (data.error) throw new Error(`EVM RPC: ${data.error.message || JSON.stringify(data.error)}`);

	const rawBalance = BigInt(data.result || '0x0');

	if (gate.kind === 'erc721') {
		return Number(rawBalance);
	}

	// ERC-20: fetch decimals() — 0x313ce567
	const decResp = await fetch(rpcUrl, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			jsonrpc: '2.0', id: 2,
			method: 'eth_call',
			params: [{ to: gate.address, data: '0x313ce567' }, 'latest'],
		}),
	});
	if (!decResp.ok) throw new Error(`Alchemy decimals error ${decResp.status}`);
	const decData = await decResp.json();
	const decimals = decData.result && decData.result !== '0x' ? Number(BigInt(decData.result)) : 18;
	return Number(rawBalance) / Math.pow(10, decimals);
}
