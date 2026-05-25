// /api/agents/:id/sns
//
// GET     — list .sol domains the agent's Solana wallet owns (via Bonfida
//           sns-api.bonfida.com), the wallet's favorite/primary domain,
//           the currently-attached SNS id (meta.sns_domain), and which
//           registration modes are enabled.
// POST    — body { domain } — verify the agent's wallet (or one of the
//           caller's linked Solana wallets) owns `domain`, then save it as
//           the agent's SNS id (meta.sns_domain).
// DELETE  — clear meta.sns_domain.
//
// /api/agents/:id/sns/register
// POST    — Option A: agent wallet pays. Body { domain, space?, referrer? }.
//           Server signs with the agent's keypair; agent's USDC ATA pays.
//           On success sets meta.sns_domain.
//
// /api/agents/:id/sns/register-prep
// POST    — Option B step 1: build an unsigned tx for the user's wallet to
//           sign. Body { domain, wallet_address, space? }. Returns a base64
//           VersionedTransaction the browser submits via wallet adapter.
//
// /api/agents/:id/sns/register-confirm
// POST    — Option B step 2: body { signature, domain, wallet_address }.
//           Confirms on-chain owner = wallet_address, then sets meta.sns_domain
//           (the user owns the domain; we only store the alias against the agent).

import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { sql } from '../_lib/db.js';
import { cors, json, method, error, readJson } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { env } from '../_lib/env.js';
import { loadAgentForSigning, solanaConnection } from '../_lib/agent-pumpfun.js';

const SNS_API = 'https://sns-api.bonfida.com';
// Accept a label or dotted subdomain, optionally suffixed `.sol`.
const DOMAIN_RE = /^[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63})*(?:\.sol)?$/i;
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function normalizeDomain(input) {
	if (typeof input !== 'string') return null;
	const trimmed = input.trim().toLowerCase().replace(/\.sol$/, '');
	if (!trimmed) return null;
	// Each dotted segment is a valid SNS label.
	const segments = trimmed.split('.');
	for (const seg of segments) {
		if (!/^[a-z0-9-]{1,63}$/.test(seg)) return null;
	}
	return trimmed;
}

async function snsFetch(path) {
	const r = await fetch(`${SNS_API}${path}`, { headers: { accept: 'application/json' } });
	if (!r.ok) throw new Error(`sns api ${r.status}`);
	return r.json();
}

async function fetchOwnedDomains(address) {
	const body = await snsFetch(`/v2/user/domains/${address}`);
	const list = body?.[address] || body?.data?.[address] || [];
	return Array.isArray(list) ? list : [];
}

async function fetchFavoriteDomain(address) {
	try {
		const body = await snsFetch(`/v2/user/fav-domains/${address}`);
		return body?.[address] || null;
	} catch {
		return null;
	}
}

async function getRegistryOwner(connection, domain) {
	const sns = await import('@bonfida/spl-name-service/dist/cjs/index.js');
	const { pubkey } = sns.getDomainKeySync(domain);
	const { registry } = await sns.NameRegistryState.retrieve(connection, pubkey);
	return registry.owner.toBase58();
}

async function buildRegisterIxs({ connection, domain, buyer, space }) {
	const { PublicKey } = await import('@solana/web3.js');
	const { getAssociatedTokenAddressSync } = await import('@solana/spl-token');
	const sns = await import('@bonfida/spl-name-service/dist/cjs/index.js');
	const usdcMint = new PublicKey(USDC_MINT);
	const buyerAta = getAssociatedTokenAddressSync(usdcMint, buyer, true);
	return sns.registerDomainNameV2(connection, domain, space || 1000, buyer, buyerAta, usdcMint);
}

async function resolveAuth(req) {
	const session = await getSessionUser(req);
	if (session) return { userId: session.id };
	const bearer = await authenticateBearer(extractBearer(req));
	if (bearer) return { userId: bearer.userId };
	return null;
}

function priceUsdcFor(domain) {
	const len = domain.length;
	if (len === 1) return 750;
	if (len === 2) return 700;
	if (len === 3) return 640;
	if (len === 4) return 160;
	return 20;
}

// ── Availability check ────────────────────────────────────────────────────
async function handleCheck(req, res) {
	if (!method(req, res, ['GET'])) return;
	const url = new URL(req.url, 'http://x');
	const domain = normalizeDomain(url.searchParams.get('domain'));
	if (!domain) return error(res, 400, 'validation_error', 'domain required (a–z, 0–9, hyphen, max 63)');
	const conn = solanaConnection('mainnet');
	let owner = null;
	try {
		owner = await getRegistryOwner(conn, domain);
	} catch {}
	return json(res, 200, {
		data: {
			domain,
			available: !owner,
			owner: owner || null,
			price_usdc: priceUsdcFor(domain),
			length: domain.length,
		},
	});
}

// ── Option A: agent wallet pays + auto-attach ─────────────────────────────
async function handleRegisterAgent(req, res, id, auth) {
	if (!method(req, res, ['POST'])) return;
	const body = await readJson(req).catch(() => ({}));
	const domain = normalizeDomain(body?.domain);
	if (!domain) return error(res, 400, 'validation_error', 'domain required (a–z, 0–9, hyphen)');
	const space = Number.isInteger(body?.space) && body.space >= 1000 && body.space <= 10000 ? body.space : 1000;

	const loaded = await loadAgentForSigning(id, auth.userId, { reason: 'sns_register' });
	if (loaded.error) return error(res, loaded.error.status, loaded.error.code, loaded.error.msg);
	const { keypair } = loaded;
	let meta = { ...(loaded.meta || {}) };

	const { Transaction } = await import('@solana/web3.js');
	const conn = solanaConnection('mainnet');

	try {
		if (await getRegistryOwner(conn, domain).catch(() => null)) {
			return error(res, 409, 'conflict', `${domain}.sol is already registered`);
		}
		const ixs = await buildRegisterIxs({ connection: conn, domain, buyer: keypair.publicKey, space });
		const tx = new Transaction().add(...ixs);
		tx.feePayer = keypair.publicKey;
		const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
		tx.recentBlockhash = blockhash;
		tx.sign(keypair);
		const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
		await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');

		meta = { ...meta, sns_domain: domain };
		await sql`UPDATE agent_identities SET meta = ${JSON.stringify(meta)}::jsonb WHERE id = ${id}`;
		return json(res, 201, {
			data: { ok: true, address: meta.solana_address, sns_domain: domain, signature: sig, mode: 'agent' },
		});
	} catch (err) {
		console.error('[agents/sns/register-agent] failed', err);
		const msg = err?.message || 'registration failed';
		return error(res, 502, 'upstream_error', msg);
	}
}

// ── Option B step 1: build unsigned tx for user wallet ────────────────────
async function handleRegisterPrep(req, res, id, auth) {
	if (!method(req, res, ['POST'])) return;
	const body = await readJson(req).catch(() => ({}));
	const domain = normalizeDomain(body?.domain);
	if (!domain) return error(res, 400, 'validation_error', 'domain required');
	const walletAddress = String(body?.wallet_address || '').trim();
	if (walletAddress.length < 32 || walletAddress.length > 44) {
		return error(res, 400, 'validation_error', 'wallet_address required');
	}
	const space = Number.isInteger(body?.space) && body.space >= 1000 && body.space <= 10000 ? body.space : 1000;

	const [agent] = await sql`
		SELECT id FROM agent_identities WHERE id = ${id} AND user_id = ${auth.userId} AND deleted_at IS NULL
	`;
	if (!agent) return error(res, 404, 'not_found', 'agent not found');

	const [walletRow] = await sql`
		SELECT id FROM user_wallets
		WHERE user_id = ${auth.userId} AND address = ${walletAddress} AND chain_type = 'solana'
		LIMIT 1
	`;
	if (!walletRow) return error(res, 403, 'forbidden', 'wallet not linked to your account');

	const { PublicKey, TransactionMessage, VersionedTransaction } = await import('@solana/web3.js');
	const conn = solanaConnection('mainnet');
	if (await getRegistryOwner(conn, domain).catch(() => null)) {
		return error(res, 409, 'conflict', `${domain}.sol is already registered`);
	}

	const buyer = new PublicKey(walletAddress);
	const ixs = await buildRegisterIxs({ connection: conn, domain, buyer, space });
	const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
	const msg = new TransactionMessage({ payerKey: buyer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
	const tx = new VersionedTransaction(msg);
	return json(res, 200, {
		data: {
			tx_base64: Buffer.from(tx.serialize()).toString('base64'),
			blockhash,
			last_valid_block_height: lastValidBlockHeight,
			domain,
		},
	});
}

// ── Option B step 2: confirm and attach ───────────────────────────────────
async function handleRegisterConfirm(req, res, id, auth) {
	if (!method(req, res, ['POST'])) return;
	const body = await readJson(req).catch(() => ({}));
	const domain = normalizeDomain(body?.domain);
	const signature = String(body?.signature || '').trim();
	const walletAddress = String(body?.wallet_address || '').trim();
	if (!domain || !signature || !walletAddress) {
		return error(res, 400, 'validation_error', 'domain, signature, wallet_address required');
	}

	const [row] = await sql`
		SELECT meta FROM agent_identities WHERE id = ${id} AND user_id = ${auth.userId} AND deleted_at IS NULL
	`;
	if (!row) return error(res, 404, 'not_found', 'agent not found');

	const [walletRow] = await sql`
		SELECT id FROM user_wallets
		WHERE user_id = ${auth.userId} AND address = ${walletAddress} AND chain_type = 'solana'
		LIMIT 1
	`;
	if (!walletRow) return error(res, 403, 'forbidden', 'wallet not linked to your account');

	const conn = solanaConnection('mainnet');
	let confirmed;
	try {
		confirmed = await conn.getSignatureStatus(signature, { searchTransactionHistory: true });
	} catch {}
	if (!confirmed?.value || confirmed.value.err) {
		return error(res, 400, 'not_confirmed', 'tx not confirmed yet — try again in a moment');
	}

	let onChainOwner;
	try {
		onChainOwner = await getRegistryOwner(conn, domain);
	} catch {
		return error(res, 502, 'upstream_error', 'failed to read registry');
	}
	if (onChainOwner !== walletAddress) {
		return error(res, 409, 'conflict', `on-chain owner ${onChainOwner} does not match ${walletAddress}`);
	}

	const meta = { ...(row.meta || {}), sns_domain: domain, sns_owner_wallet: walletAddress };
	await sql`UPDATE agent_identities SET meta = ${JSON.stringify(meta)}::jsonb WHERE id = ${id}`;
	return json(res, 200, {
		data: { ok: true, sns_domain: domain, owner: walletAddress, signature, mode: 'user' },
	});
}

export default async function handler(req, res, id, action) {
	if (cors(req, res, { methods: 'GET,POST,DELETE,OPTIONS', credentials: true })) return;

	const auth = await resolveAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in required');

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	if (action === 'check') return handleCheck(req, res);
	if (action === 'register') return handleRegisterAgent(req, res, id, auth);
	if (action === 'register-prep') return handleRegisterPrep(req, res, id, auth);
	if (action === 'register-confirm') return handleRegisterConfirm(req, res, id, auth);

	if (!method(req, res, ['GET', 'POST', 'DELETE'])) return;

	const [row] = await sql`
		SELECT id, user_id, meta FROM agent_identities
		WHERE id = ${id} AND deleted_at IS NULL
	`;
	if (!row) return error(res, 404, 'not_found', 'agent not found');
	if (row.user_id !== auth.userId) return error(res, 403, 'forbidden', 'not your agent');

	let meta = { ...(row.meta || {}) };
	const address = meta.solana_address;
	if (!address) {
		return error(res, 409, 'conflict', 'agent has no solana wallet — provision one first via POST /api/agents/:id/solana');
	}

	if (req.method === 'DELETE') {
		delete meta.sns_domain;
		delete meta.sns_owner_wallet;
		await sql`UPDATE agent_identities SET meta = ${JSON.stringify(meta)}::jsonb WHERE id = ${id}`;
		return json(res, 200, { data: { ok: true, address, sns_domain: null } });
	}

	if (req.method === 'POST') {
		const body = await readJson(req).catch(() => ({}));
		if (!DOMAIN_RE.test(String(body?.domain || ''))) {
			return error(res, 400, 'validation_error', 'domain must be a .sol name');
		}
		const domain = normalizeDomain(body.domain);
		if (!domain) return error(res, 400, 'validation_error', 'invalid .sol domain');

		// Accept the domain if it's owned by the agent OR by any Solana wallet
		// linked to the caller's account.
		const linked = await sql`
			SELECT address FROM user_wallets
			WHERE user_id = ${auth.userId} AND chain_type = 'solana'
		`;
		const candidates = [address, ...linked.map((r) => r.address)];

		let ownerAddress = null;
		for (const cand of candidates) {
			let owned;
			try {
				owned = await fetchOwnedDomains(cand);
			} catch {
				continue;
			}
			if (owned.includes(domain)) {
				ownerAddress = cand;
				break;
			}
		}
		if (!ownerAddress) {
			return error(res, 403, 'forbidden', `${domain}.sol is not owned by this agent's wallet or any wallet linked to your account`);
		}

		meta = { ...meta, sns_domain: domain };
		if (ownerAddress !== address) meta.sns_owner_wallet = ownerAddress;
		else delete meta.sns_owner_wallet;
		await sql`UPDATE agent_identities SET meta = ${JSON.stringify(meta)}::jsonb WHERE id = ${id}`;
		return json(res, 200, { data: { ok: true, address, sns_domain: domain, owner: ownerAddress } });
	}

	// GET
	let domains = [];
	let favorite = null;
	let upstreamOk = true;
	try {
		[domains, favorite] = await Promise.all([fetchOwnedDomains(address), fetchFavoriteDomain(address)]);
	} catch {
		upstreamOk = false;
	}
	return json(res, 200, {
		data: {
			address,
			sns_domain: meta.sns_domain || null,
			sns_owner_wallet: meta.sns_owner_wallet || null,
			domains,
			favorite,
			upstream_ok: upstreamOk,
			register_url: `https://www.sns.id/?search=`,
			modes: { agent_pays: true, user_pays: true },
			usdc_mint: USDC_MINT,
		},
	});
}
