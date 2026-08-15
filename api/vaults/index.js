// /api/vaults
//   GET  /api/vaults              discovery feed (open vaults ranked by verified performance)
//   GET  /api/vaults?mine=1       the caller's backed-vault portfolio (auth)
//   POST /api/vaults              open a vault behind an agent you own (reputation-gated)
//
// Vaults are USDC-denominated. A vault gets its OWN dedicated custodial Solana
// wallet at open; backer capital lives there, never co-mingled with the agent's
// personal wallet. Only an agent with a real verified trading track record (the
// same on-chain badge the trader leaderboard uses) can open one.

import { cors, json, method, error, readJson, wrap, rateLimited } from '../_lib/http.js';
import { limits } from '../_lib/rate-limit.js';
import { authWrite, loadOwnedAgent, assertReputationVerified, traderBadge } from '../_lib/vault-auth.js';
import { resolveUserId } from '../_lib/vault-auth.js';
import { createVault, listVaults, listBackedVaults, recordVaultEvent } from '../_lib/vault-store.js';
import { generateVaultWallet } from '../_lib/vault-wallet.js';
import { usdcToAtomics, sharePriceE6, roiBps, toBig, TERM_BOUNDS, clampTermBps } from '../_lib/vault-accounting.js';
import { isUuid } from '../_lib/validate.js';

function clampInt(v, bound) {
	return clampTermBps(v, bound) ?? bound.def;
}

async function handleList(req, res) {
	if (!method(req, res, ['GET'])) return;
	const url = new URL(req.url, 'http://x');
	const mine = url.searchParams.get('mine') === '1';

	if (mine) {
		const who = await resolveUserId(req);
		if (!who) return error(res, 401, 'unauthorized', 'sign in to see your backed vaults');
		const rows = await listBackedVaults(who.userId, { limit: 60 });
		const items = rows.map((r) => ({
			id: r.id, agent_id: r.agent_id, agent_name: r.agent_name, agent_image: r.agent_image,
			network: r.network, status: r.status, performance_fee_bps: r.performance_fee_bps,
			max_drawdown_bps: r.max_drawdown_bps,
			shares: String(r.shares), cost_basis_atomics: String(r.cost_basis_atomics),
			deposited_atomics: String(r.deposited_atomics), redeemed_atomics: String(r.redeemed_atomics),
			realized_gain_atomics: String(r.realized_gain_atomics), fees_paid_atomics: String(r.fees_paid_atomics),
			backer_agent_id: r.backer_agent_id,
		}));
		return json(res, 200, { data: { items } }, { 'cache-control': 'no-store' });
	}

	const rows = await listVaults({ status: 'open', limit: 60 });
	// Rank by real verified trading performance: fetch each owning agent's badge in
	// parallel, then sort verified-first, then by score, then by capital backing.
	const badges = await Promise.all(rows.map((r) => traderBadge(r.agent_id, r.network).catch(() => null)));
	const items = rows.map((r, i) => {
		const badge = badges[i];
		const lastNav = r.last_nav_atomics != null ? toBig(r.last_nav_atomics) : null;
		return {
			id: r.id, agent_id: r.agent_id, agent_name: r.agent_name,
			agent_image: r.agent_image, agent_description: r.agent_description,
			network: r.network, status: r.status,
			performance_fee_bps: r.performance_fee_bps,
			max_drawdown_bps: r.max_drawdown_bps,
			per_backer_cap_atomics: r.per_backer_cap_atomics != null ? String(r.per_backer_cap_atomics) : null,
			backer_count: r.backer_count,
			lifetime_deposited_atomics: String(r.lifetime_deposited),
			total_shares: String(r.total_shares),
			last_nav_atomics: lastNav != null ? String(lastNav) : null,
			share_price_e6: lastNav != null ? String(sharePriceE6(lastNav, r.total_shares)) : '1000000',
			roi_bps: lastNav != null ? roiBps(lastNav, r.total_shares) : 0,
			reputation: badge,
		};
	});
	items.sort((a, b) => {
		const av = a.reputation?.verified ? 1 : 0; const bv = b.reputation?.verified ? 1 : 0;
		if (av !== bv) return bv - av;
		const as = a.reputation?.score ?? 0; const bs = b.reputation?.score ?? 0;
		if (as !== bs) return bs - as;
		return Number(toBig(b.lifetime_deposited_atomics) - toBig(a.lifetime_deposited_atomics));
	});
	return json(res, 200, { data: { items } }, { 'cache-control': 'public, max-age=15, s-maxage=30' });
}

async function handleOpen(req, res) {
	const who = await authWrite(req, res);
	if (!who) return;
	const { userId } = who;

	const rl = await limits.tradePerUser(userId);
	if (!rl.success) return rateLimited(res, rl);

	let body;
	try { body = (await readJson(req)) || {}; } catch (e) { return error(res, e?.status === 415 ? 415 : 400, 'bad_request', e?.message || 'invalid body'); }

	const agentId = String(body.agentId || body.agent_id || '').trim();
	if (!agentId) return error(res, 400, 'validation_error', 'agentId required');
	if (!isUuid(agentId)) return error(res, 400, 'validation_error', 'agentId must be an agent id');
	const network = body.network === 'devnet' ? 'devnet' : 'mainnet';

	let agent;
	try { agent = await loadOwnedAgent(agentId, userId); } catch (e) { return error(res, e.status || 400, e.code || 'bad_request', e.message); }

	// Reputation gate: only a verifiably-skilled agent can open a vault.
	try { await assertReputationVerified(agentId, network); } catch (e) { return error(res, e.status || 403, e.code || 'forbidden', e.message, e.detail || {}); }

	// Required risk terms.
	const maxPerTradeUsdc = Number(body.maxPerTradeUsdc ?? body.max_per_trade_usdc);
	const dailyBudgetUsdc = Number(body.dailyBudgetUsdc ?? body.daily_budget_usdc);
	if (!(maxPerTradeUsdc > 0)) return error(res, 400, 'validation_error', 'maxPerTradeUsdc must be a positive number');
	if (!(dailyBudgetUsdc > 0)) return error(res, 400, 'validation_error', 'dailyBudgetUsdc must be a positive number');
	const maxPerTradeAtomics = usdcToAtomics(maxPerTradeUsdc);
	const dailyBudgetAtomics = usdcToAtomics(dailyBudgetUsdc);
	if (maxPerTradeAtomics > dailyBudgetAtomics) return error(res, 400, 'validation_error', 'per-trade ceiling cannot exceed the daily budget');

	const perBackerCapUsdc = body.perBackerCapUsdc ?? body.per_backer_cap_usdc;
	const perBackerCapAtomics = perBackerCapUsdc == null || Number(perBackerCapUsdc) <= 0 ? null : usdcToAtomics(Number(perBackerCapUsdc));

	const performanceFeeBps = clampInt(body.performanceFeeBps ?? body.performance_fee_bps ?? TERM_BOUNDS.performanceFeeBps.def, TERM_BOUNDS.performanceFeeBps);
	const maxDrawdownBps = clampInt(body.maxDrawdownBps ?? body.max_drawdown_bps ?? TERM_BOUNDS.maxDrawdownBps.def, TERM_BOUNDS.maxDrawdownBps);

	const wallet = await generateVaultWallet();
	let vault;
	try {
		vault = await createVault({
			agentId, ownerUserId: userId, network,
			vaultAddress: wallet.address, encryptedSecret: wallet.encrypted_secret,
			performanceFeeBps, perBackerCapAtomics, maxDrawdownBps,
			maxPerTradeAtomics, dailyBudgetAtomics,
		});
	} catch (e) {
		if (String(e?.message || '').includes('agent_vaults_one_active')) {
			return error(res, 409, 'vault_exists', 'this agent already has an open vault');
		}
		throw e;
	}

	await recordVaultEvent({
		vaultId: vault.id, type: 'open', userId,
		reason: 'vault opened', meta: {
			agent_id: agentId, performance_fee_bps: performanceFeeBps, max_drawdown_bps: maxDrawdownBps,
			max_per_trade_atomics: String(maxPerTradeAtomics), daily_budget_atomics: String(dailyBudgetAtomics),
			per_backer_cap_atomics: perBackerCapAtomics != null ? String(perBackerCapAtomics) : null,
		},
	});

	return json(res, 201, { data: { vault: { ...vault, agent_name: agent.name } } }, { 'cache-control': 'no-store' });
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', credentials: true })) return;
	if (req.method === 'POST') return handleOpen(req, res);
	return handleList(req, res);
});
