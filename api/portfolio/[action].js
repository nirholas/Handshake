// Portfolio dispatcher for the user's agent custodial wallets.
//
//   GET  /api/portfolio/summary?snapshot=1   → live aggregated balances; opt. snapshot
//   GET  /api/portfolio/history?days=30      → past snapshots for the chart
//   POST /api/portfolio/send                 → server-signed transfer from an agent wallet
//
// All endpoints require a session cookie and operate only on agents owned by
// the caller (agent_identities.user_id = session.user_id). Balances are
// memoized for 60s in-process to shield Helius/Alchemy/CoinGecko from
// per-page-load fan-out.

import { cors, json, method, readJson, wrap, error, validationError } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { getSessionUser, isSameSiteOrigin } from '../_lib/auth.js';
import { requireCsrf } from '../_lib/csrf.js';
import { logAudit } from '../_lib/audit.js';
import { sql } from '../_lib/db.js';
import { getBalances, walletUsdTotal, invalidateBalances } from '../_lib/balances.js';
import { recoverAgentKey, recoverSolanaAgentKeypair } from '../_lib/agent-wallet.js';
import { reverseLookupAddress, resolveSolanaRecipient } from '../../src/solana/sns.js';
import { env } from '../_lib/env.js';
import { z } from 'zod';

// `send` does a Solana submit + EVM RPC roundtrips; default 10s is not enough.
export const maxDuration = 60;

const SNS_CACHE_TTL_MS = 10 * 60_000;
const _snsCache = new Map();

async function lookupSnsCached(address) {
	const hit = _snsCache.get(address);
	if (hit && Date.now() - hit.at < SNS_CACHE_TTL_MS) return hit.value;
	let value = null;
	try {
		value = await reverseLookupAddress(address);
	} catch {
		value = null;
	}
	_snsCache.set(address, { at: Date.now(), value });
	return value;
}

const ETH_ADDR_RE = /^0x[a-fA-F0-9]{40}$/;
const SOL_ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function parse(schema, raw) {
	const r = schema.safeParse(raw);
	if (!r.success) {
		const err = new Error(r.error.issues[0]?.message || 'invalid input');
		err.status = 400;
		err.code = 'validation_error';
		err.issues = r.error.issues;
		throw err;
	}
	return r.data;
}

async function listUserAgentWallets(userId) {
	const rows = await sql`
		select id, name, wallet_address, chain_id, meta
		  from agent_identities
		 where user_id = ${userId} and deleted_at is null
		 order by created_at asc
	`;
	const wallets = [];
	for (const row of rows) {
		const meta = row.meta || {};
		if (row.wallet_address) {
			wallets.push({
				agent_id: row.id,
				agent_name: row.name || 'Agent',
				kind: 'evm',
				chain: 'evm',
				chain_id: row.chain_id || 8453,
				address: row.wallet_address,
			});
		}
		const solAddr = meta.solana_address;
		if (solAddr) {
			wallets.push({
				agent_id: row.id,
				agent_name: row.name || 'Agent',
				kind: 'solana',
				chain: 'solana',
				address: solAddr,
			});
		}
	}
	return wallets;
}

// ── GET /api/portfolio/summary ─────────────────────────────────────────────

async function handleSummary(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const user = await getSessionUser(req, res);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');

	const rl = await limits.walletRead(user.id);
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const url = new URL(req.url, 'http://localhost');
	const wantSnapshot = url.searchParams.get('snapshot') === '1';

	const wallets = await listUserAgentWallets(user.id);

	const [balanceResults, snsResults] = await Promise.all([
		Promise.allSettled(wallets.map((w) => getBalances({ chain: w.chain, address: w.address }))),
		Promise.all(
			wallets.map((w) => (w.chain === 'solana' ? lookupSnsCached(w.address) : Promise.resolve(null))),
		),
	]);

	const byWallet = wallets.map((w, i) => {
		const r = balanceResults[i];
		const sns = snsResults[i];
		if (r.status === 'fulfilled') {
			const bal = r.value;
			return {
				agent_id: w.agent_id,
				agent_name: w.agent_name,
				chain: w.chain,
				chain_id: w.chain_id,
				address: w.address,
				sns,
				native: bal.native,
				tokens: bal.tokens,
				usd: walletUsdTotal(bal),
				ok: true,
			};
		}
		const err = r.reason;
		return {
			agent_id: w.agent_id,
			agent_name: w.agent_name,
			chain: w.chain,
			chain_id: w.chain_id,
			address: w.address,
			sns,
			native: { symbol: w.chain === 'solana' ? 'SOL' : 'ETH', amount: 0, usd: 0 },
			tokens: [],
			usd: 0,
			ok: false,
			error: err?.code === 'not_configured' ? `missing env: ${err.missing}` : err?.message || 'fetch failed',
		};
	});

	const totalUsd = byWallet.reduce((s, w) => s + (w.usd || 0), 0);

	if (wantSnapshot) {
		const breakdown = byWallet.map((w) => ({
			agent_id: w.agent_id,
			chain: w.chain,
			address: w.address,
			usd: w.usd,
		}));
		try {
			await sql`
				insert into portfolio_snapshots (user_id, total_usd, breakdown)
				values (${user.id}, ${totalUsd}, ${JSON.stringify(breakdown)}::jsonb)
			`;
		} catch (e) {
			console.error('[portfolio] snapshot insert failed', e?.message);
		}
	}

	return json(res, 200, {
		captured_at: new Date().toISOString(),
		total_usd: totalUsd,
		wallets: byWallet,
	});
}

// ── GET /api/portfolio/history ─────────────────────────────────────────────

async function handleHistory(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const user = await getSessionUser(req, res);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');

	const rl = await limits.walletRead(user.id);
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const url = new URL(req.url, 'http://localhost');
	const days = Math.min(365, Math.max(1, parseInt(url.searchParams.get('days') || '90', 10)));

	const rows = await sql`
		select captured_at, total_usd
		  from portfolio_snapshots
		 where user_id = ${user.id}
		   and captured_at > now() - (${days} || ' days')::interval
		 order by captured_at asc
	`;

	return json(res, 200, {
		days,
		points: rows.map((r) => ({
			t: new Date(r.captured_at).toISOString(),
			usd: Number(r.total_usd),
		})),
	});
}

// ── POST /api/portfolio/send ───────────────────────────────────────────────

const sendSchema = z.object({
	agent_id: z.string().uuid(),
	chain: z.enum(['solana', 'evm']),
	// 'native' for SOL/ETH, otherwise a mint (Solana) or 0x contract (EVM).
	asset: z.string().min(1),
	recipient: z.string().min(1),
	// Decimal string, in human units (e.g. "1.5" SOL, ".5" SOL, "100" USDC).
	amount: z.string().regex(/^(\d+(\.\d*)?|\.\d+)$/, 'invalid amount'),
	memo: z.string().max(120).optional(),
});

function parseAmountToBaseUnits(amountStr, decimals) {
	const [whole, frac = ''] = amountStr.split('.');
	const fracPadded = (frac + '0'.repeat(decimals)).slice(0, decimals);
	const combined = (whole + fracPadded).replace(/^0+/, '') || '0';
	return BigInt(combined);
}

async function loadOwnedAgent(userId, agentId) {
	const [row] = await sql`
		select id, name, wallet_address, chain_id, meta
		  from agent_identities
		 where id = ${agentId} and user_id = ${userId} and deleted_at is null
		 limit 1
	`;
	return row || null;
}

async function sendEvm({ agent, asset, recipient, amount, memo }) {
	if (!ETH_ADDR_RE.test(recipient)) {
		const e = new Error('invalid EVM recipient');
		e.code = 'validation_error';
		e.status = 400;
		throw e;
	}
	const encryptedKey = agent.meta?.encrypted_wallet_key;
	if (!encryptedKey) {
		const e = new Error('agent has no EVM key');
		e.code = 'no_key';
		e.status = 409;
		throw e;
	}
	const chainId = agent.chain_id || 8453;
	const rpcUrl = env.getRpcUrl(chainId);
	if (!rpcUrl) {
		const e = new Error(`no RPC URL for chain ${chainId}`);
		e.code = 'no_rpc';
		e.status = 503;
		throw e;
	}

	const pkHex = await recoverAgentKey(encryptedKey);
	const { JsonRpcProvider, Wallet, parseEther, Contract } = await import('ethers');
	const provider = new JsonRpcProvider(rpcUrl);
	const signer = new Wallet(pkHex, provider);

	if (asset === 'native') {
		const value = parseEther(amount);
		const tx = await signer.sendTransaction({ to: recipient, value, data: memo ? '0x' + Buffer.from(memo, 'utf8').toString('hex') : undefined });
		return { tx_hash: tx.hash, chain_id: chainId };
	}

	if (!ETH_ADDR_RE.test(asset)) {
		const e = new Error('asset must be 0x contract or "native"');
		e.code = 'validation_error';
		e.status = 400;
		throw e;
	}
	const ERC20 = ['function decimals() view returns (uint8)', 'function transfer(address,uint256) returns (bool)'];
	const token = new Contract(asset, ERC20, signer);
	const decimals = Number(await token.decimals());
	const amountUnits = parseAmountToBaseUnits(amount, decimals);
	const tx = await token.transfer(recipient, amountUnits);
	return { tx_hash: tx.hash, chain_id: chainId };
}

async function sendSolana({ agent, asset, recipient, amount, userId }) {
	const { address: resolvedRecipient, resolved_from } = await resolveSolanaRecipient(recipient);
	if (!resolvedRecipient) {
		const e = new Error('invalid Solana recipient — must be a base58 address or a registered .sol name');
		e.code = 'validation_error';
		e.status = 400;
		throw e;
	}
	recipient = resolvedRecipient;
	const encryptedSecret = agent.meta?.encrypted_solana_secret;
	if (!encryptedSecret) {
		const e = new Error('agent has no Solana key');
		e.code = 'no_key';
		e.status = 409;
		throw e;
	}

	const { Connection, PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL } = await import('@solana/web3.js');
	const rpcUrl = process.env.HELIUS_API_KEY
		? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
		: 'https://api.mainnet-beta.solana.com';
	const conn = new Connection(rpcUrl, 'confirmed');

	const kp = await recoverSolanaAgentKeypair(encryptedSecret, {
		userId,
		agentId: agent.id,
		reason: 'portfolio_send',
	});

	const recipientPk = new PublicKey(recipient);
	const tx = new Transaction();

	if (asset === 'native') {
		const lamports = BigInt(Math.round(Number(amount) * LAMPORTS_PER_SOL));
		tx.add(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: recipientPk, lamports }));
	} else {
		if (!SOL_ADDR_RE.test(asset)) {
			const e = new Error('asset must be SPL mint or "native"');
			e.code = 'validation_error';
			e.status = 400;
			throw e;
		}
		const { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction, createTransferInstruction } = await import('@solana/spl-token');
		const mintPk = new PublicKey(asset);

		const mintInfo = await conn.getParsedAccountInfo(mintPk);
		const decimals = mintInfo.value?.data?.parsed?.info?.decimals ?? 6;

		const senderAta = await getAssociatedTokenAddress(mintPk, kp.publicKey);
		const recipientAta = await getAssociatedTokenAddress(mintPk, recipientPk);
		const recipientAccount = await conn.getAccountInfo(recipientAta);
		if (!recipientAccount) {
			tx.add(createAssociatedTokenAccountInstruction(kp.publicKey, recipientAta, recipientPk, mintPk));
		}
		const amountUnits = parseAmountToBaseUnits(amount, decimals);
		tx.add(createTransferInstruction(senderAta, recipientAta, kp.publicKey, amountUnits));
	}

	const { blockhash } = await conn.getLatestBlockhash();
	tx.feePayer = kp.publicKey;
	tx.recentBlockhash = blockhash;
	tx.sign(kp);

	// Preflight runs on the RPC and throws synchronously if the tx would fail
	// (insufficient lamports, missing ATA rent, etc.) — that gives us instant
	// validation feedback. We deliberately don't await confirmTransaction here:
	// 'confirmed' commitment takes 10-30s under load and the function would
	// time out (Vercel default 10s). The signature is the receipt.
	const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
	return { tx_hash: sig, recipient, resolved_from };
}

async function handleSend(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const user = await getSessionUser(req, res);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');

	if (!isSameSiteOrigin(req)) {
		return error(res, 403, 'forbidden', 'cross-site request denied');
	}
	if (!(await requireCsrf(req, res, user.id))) return;

	const rl = await limits.strict(`portfolio:send:${user.id}`);
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many sends');

	let body;
	try {
		body = parse(sendSchema, await readJson(req));
	} catch (e) {
		return validationError(res, e);
	}

	const agent = await loadOwnedAgent(user.id, body.agent_id);
	if (!agent) return error(res, 404, 'not_found', 'agent not found');

	try {
		const out =
			body.chain === 'solana'
				? await sendSolana({ agent, asset: body.asset, recipient: body.recipient, amount: body.amount, userId: user.id })
				: await sendEvm({ agent, asset: body.asset, recipient: body.recipient, amount: body.amount, memo: body.memo });

		logAudit({
			userId: user.id,
			action: 'portfolio_send',
			resourceId: agent.id,
			meta: {
				chain: body.chain,
				asset: body.asset,
				recipient: out.recipient || body.recipient,
				recipient_typed: body.recipient,
				resolved_from: out.resolved_from || null,
				amount: body.amount,
				tx_hash: out.tx_hash,
			},
		});

		// Invalidate cache so the next /summary reflects the new balance.
		const addr = body.chain === 'solana' ? agent.meta?.solana_address : agent.wallet_address;
		if (addr) invalidateBalances({ chain: body.chain, address: addr });

		return json(res, 200, { ok: true, ...out });
	} catch (e) {
		if (e.code === 'validation_error') return error(res, 400, 'validation_error', e.message);
		if (e.code === 'no_key') return error(res, 409, 'no_key', e.message);
		if (e.code === 'no_rpc') return error(res, 503, 'no_rpc', e.message);
		console.error('[portfolio/send] failed', e?.message);
		return error(res, 502, 'send_failed', e?.message || 'transaction failed');
	}
}

// ── GET /api/portfolio/asset ───────────────────────────────────────────────
//
// Returns combined data for a single token across all of the user's agent
// wallets: which wallets hold it, total amount, USD value, plus current market
// data (price, 24h change, market cap) and a price history chart pulled from
// CoinGecko. Params:
//   chain   = "solana" | "evm"
//   id      = "native" | <mint or 0x contract>
//   days    = optional, defaults to 30
//
// Native maps to SOL on Solana and ETH on EVM (mainnet coin IDs are used for
// the price chart; the holding is read directly from the live balances).

async function cgFetch(url) {
	const r = await fetch(url, { headers: { accept: 'application/json' } });
	if (!r.ok) {
		const text = await r.text().catch(() => '');
		throw Object.assign(new Error(`coingecko ${r.status}: ${text.slice(0, 200)}`), { status: 502 });
	}
	return r.json();
}

async function handleAsset(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const user = await getSessionUser(req, res);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');

	const rl = await limits.walletRead(user.id);
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const url = new URL(req.url, 'http://localhost');
	const chain = String(url.searchParams.get('chain') || '').toLowerCase();
	const idRaw = String(url.searchParams.get('id') || '').trim();
	const days = Math.min(365, Math.max(1, parseInt(url.searchParams.get('days') || '30', 10)));

	if (chain !== 'solana' && chain !== 'evm') {
		return error(res, 400, 'validation_error', 'chain must be solana or evm');
	}
	if (!idRaw) return error(res, 400, 'validation_error', 'id required');

	const isNative = idRaw === 'native';
	const id = isNative ? 'native' : idRaw;

	// 1) Walk this user's wallets, fetch live balances, and pick out matching holdings.
	const wallets = await listUserAgentWallets(user.id);
	const chainWallets = wallets.filter((w) => w.chain === chain);
	const balResults = await Promise.allSettled(
		chainWallets.map((w) => getBalances({ chain: w.chain, address: w.address })),
	);

	const holdings = [];
	let totalAmount = 0;
	let totalUsd = 0;
	let symbol = isNative ? (chain === 'solana' ? 'SOL' : 'ETH') : null;
	let logo = null;
	let decimals = isNative ? (chain === 'solana' ? 9 : 18) : null;
	let unitPrice = 0;

	for (let i = 0; i < chainWallets.length; i++) {
		const w = chainWallets[i];
		const r = balResults[i];
		if (r.status !== 'fulfilled') continue;
		const bal = r.value;
		if (isNative) {
			const a = Number(bal.native?.amount || 0);
			const u = Number(bal.native?.usd || 0);
			if (a > 0 || u > 0) {
				holdings.push({
					agent_id: w.agent_id,
					agent_name: w.agent_name,
					chain: w.chain,
					chain_id: w.chain_id,
					address: w.address,
					amount: a,
					usd: u,
				});
				totalAmount += a;
				totalUsd += u;
				if (!unitPrice && a > 0) unitPrice = u / a;
			}
		} else {
			const tokens = bal.tokens || [];
			const idLower = id.toLowerCase();
			const match = tokens.find((t) => {
				const tid = (t.mint || t.contract || '').toLowerCase();
				return tid === idLower;
			});
			if (!match) continue;
			symbol = symbol || match.symbol;
			logo = logo || match.logo;
			decimals = decimals ?? match.decimals;
			const a = Number(match.amount || 0);
			const u = Number(match.usd || 0);
			holdings.push({
				agent_id: w.agent_id,
				agent_name: w.agent_name,
				chain: w.chain,
				chain_id: w.chain_id,
				address: w.address,
				amount: a,
				usd: u,
			});
			totalAmount += a;
			totalUsd += u;
			if (!unitPrice && a > 0) unitPrice = u / a;
		}
	}

	// 2) Pull market data + price history from CoinGecko.
	//    For native: use coin id ("solana" or "ethereum").
	//    For tokens: use /coins/{platform}/contract/{address}.
	let market = null;
	let chartPoints = [];
	try {
		if (isNative) {
			const coinId = chain === 'solana' ? 'solana' : 'ethereum';
			const [meta, chart] = await Promise.all([
				cgFetch(
					`https://api.coingecko.com/api/v3/coins/${coinId}?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false`,
				).catch(() => null),
				cgFetch(
					`https://api.coingecko.com/api/v3/coins/${coinId}/market_chart?vs_currency=usd&days=${days}`,
				).catch(() => null),
			]);
			if (meta) {
				symbol = (meta.symbol || symbol || '').toUpperCase();
				logo = logo || meta.image?.small || meta.image?.thumb || null;
				market = {
					name: meta.name,
					price_usd: meta.market_data?.current_price?.usd ?? null,
					change_24h_pct: meta.market_data?.price_change_percentage_24h ?? null,
					change_7d_pct: meta.market_data?.price_change_percentage_7d ?? null,
					change_30d_pct: meta.market_data?.price_change_percentage_30d ?? null,
					market_cap_usd: meta.market_data?.market_cap?.usd ?? null,
					total_volume_usd: meta.market_data?.total_volume?.usd ?? null,
					high_24h_usd: meta.market_data?.high_24h?.usd ?? null,
					low_24h_usd: meta.market_data?.low_24h?.usd ?? null,
					ath_usd: meta.market_data?.ath?.usd ?? null,
					ath_change_pct: meta.market_data?.ath_change_percentage?.usd ?? null,
					description: (meta.description?.en || '').split('. ').slice(0, 2).join('. '),
					homepage: meta.links?.homepage?.[0] || null,
					coingecko_id: coinId,
				};
			}
			if (chart?.prices?.length) {
				chartPoints = chart.prices.map(([t, p]) => ({ t: new Date(t).toISOString(), price: p }));
			}
		} else {
			const platform = chain === 'solana' ? 'solana' : 'ethereum';
			const [meta, chart] = await Promise.all([
				cgFetch(
					`https://api.coingecko.com/api/v3/coins/${platform}/contract/${encodeURIComponent(id)}`,
				).catch(() => null),
				cgFetch(
					`https://api.coingecko.com/api/v3/coins/${platform}/contract/${encodeURIComponent(id)}/market_chart?vs_currency=usd&days=${days}`,
				).catch(() => null),
			]);
			if (meta) {
				symbol = (meta.symbol || symbol || '').toUpperCase();
				logo = logo || meta.image?.small || meta.image?.thumb || null;
				market = {
					name: meta.name,
					price_usd: meta.market_data?.current_price?.usd ?? null,
					change_24h_pct: meta.market_data?.price_change_percentage_24h ?? null,
					change_7d_pct: meta.market_data?.price_change_percentage_7d ?? null,
					change_30d_pct: meta.market_data?.price_change_percentage_30d ?? null,
					market_cap_usd: meta.market_data?.market_cap?.usd ?? null,
					total_volume_usd: meta.market_data?.total_volume?.usd ?? null,
					high_24h_usd: meta.market_data?.high_24h?.usd ?? null,
					low_24h_usd: meta.market_data?.low_24h?.usd ?? null,
					ath_usd: meta.market_data?.ath?.usd ?? null,
					ath_change_pct: meta.market_data?.ath_change_percentage?.usd ?? null,
					description: (meta.description?.en || '').split('. ').slice(0, 2).join('. '),
					homepage: meta.links?.homepage?.[0] || null,
					coingecko_id: meta.id,
				};
			}
			if (chart?.prices?.length) {
				chartPoints = chart.prices.map(([t, p]) => ({ t: new Date(t).toISOString(), price: p }));
			}
		}
	} catch (e) {
		console.error('[portfolio/asset] coingecko fetch failed', e?.message);
	}

	// If CoinGecko gave us a more reliable spot price, use it for the holding
	// USD calculation as well so the page is internally consistent.
	if (market?.price_usd && totalAmount > 0) {
		totalUsd = totalAmount * market.price_usd;
		for (const h of holdings) h.usd = h.amount * market.price_usd;
		unitPrice = market.price_usd;
	}

	return json(res, 200, {
		chain,
		id,
		is_native: isNative,
		symbol: symbol || (chain === 'solana' ? 'SOL' : 'ETH'),
		logo,
		decimals,
		unit_price_usd: unitPrice,
		total_amount: totalAmount,
		total_usd: totalUsd,
		holdings,
		market,
		chart: { days, points: chartPoints },
	});
}

// ── Dispatcher ─────────────────────────────────────────────────────────────

export default wrap(async (req, res) => {
	const action = String(req.query?.action || '').toLowerCase();
	switch (action) {
		case 'summary':
			return handleSummary(req, res);
		case 'history':
			return handleHistory(req, res);
		case 'asset':
			return handleAsset(req, res);
		case 'send':
			return handleSend(req, res);
		default:
			return error(res, 404, 'not_found', `unknown action: ${action}`);
	}
});
