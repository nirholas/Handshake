// /api/vaults/:id
//   GET   /api/vaults/:id   live vault detail (NAV, terms, positions, backers, reputation)
//   PATCH /api/vaults/:id   owner-only: pause / resume / update terms / close
//
// The GET is role-aware: anyone can see the public picture (the agent, its verified
// reputation, live NAV + P&L, terms, backer roster); the signed-in caller also sees
// their own position; the owner additionally sees accrued fees and the funding
// roster detail. NAV is re-derived from chain on every read — never a stale cache.

import { cors, json, method, error, readJson, wrap } from '../_lib/http.js';
import { authWrite, resolveUserId, loadAgent, traderBadge } from '../_lib/vault-auth.js';
import {
	getVault, getOpenPositions, getBacker, listBackers,
	setVaultStatus, updateVaultTerms, recordVaultEvent,
} from '../_lib/vault-store.js';
import { computeVaultNav } from '../_lib/vault-wallet.js';
import {
	sharePriceE6, roiBps, toBig, usdcToAtomics, settleRedemption,
	TERM_BOUNDS, clampTermBps,
} from '../_lib/vault-accounting.js';
import { isUuid } from '../_lib/validate.js';

function idFromReq(req) {
	const fromQuery = req.query?.id;
	if (typeof fromQuery === 'string' && fromQuery) return fromQuery;
	const path = new URL(req.url, 'http://x').pathname;
	const m = path.match(/\/api\/vaults\/([^/]+)/);
	return m ? decodeURIComponent(m[1]) : null;
}

async function handleGet(req, res, id) {
	const who = await resolveUserId(req).catch(() => null);
	const vault = await getVault(id);
	if (!vault) return error(res, 404, 'not_found', 'vault not found');
	const isOwner = who && who.userId === vault.owner_user_id;

	const [agent, positions, backers, badge] = await Promise.all([
		loadAgent(vault.agent_id).catch(() => null),
		getOpenPositions(vault.id),
		listBackers(vault.id, { limit: 50 }),
		traderBadge(vault.agent_id, vault.network).catch(() => null),
	]);

	const nav = await computeVaultNav(vault, positions);
	const totalShares = toBig(vault.total_shares);
	const priceE6 = sharePriceE6(nav.navAtomics, totalShares);

	// The caller's own position (so the UI can show "your stake / your P&L").
	let myPosition = null;
	if (who) {
		const b = await getBacker(vault.id, who.userId);
		if (b && toBig(b.shares) > 0n) {
			const settle = settleRedemption({
				shares: b.shares, backerShares: b.shares, costBasisAtomics: b.cost_basis_atomics,
				navAtomics: nav.navAtomics, totalShares, feeBps: vault.performance_fee_bps,
			});
			myPosition = {
				shares: String(b.shares), cost_basis_atomics: String(b.cost_basis_atomics),
				deposited_atomics: String(b.deposited_atomics), redeemed_atomics: String(b.redeemed_atomics),
				realized_gain_atomics: String(b.realized_gain_atomics), fees_paid_atomics: String(b.fees_paid_atomics),
				backer_agent_id: b.backer_agent_id,
				current_value_atomics: String(settle.grossPayout),
				unrealized_gain_atomics: String(settle.gain),
				estimated_net_atomics: String(settle.netPayout),
			};
		}
	}

	const data = {
		id: vault.id, agent_id: vault.agent_id, network: vault.network, status: vault.status,
		halt_reason: vault.halt_reason, paused_at: vault.paused_at, created_at: vault.created_at,
		vault_address: vault.vault_address,
		agent: agent ? { id: agent.id, name: agent.name, description: agent.description, image: agent.image } : null,
		reputation: badge,
		terms: {
			performance_fee_bps: vault.performance_fee_bps,
			max_drawdown_bps: vault.max_drawdown_bps,
			per_backer_cap_atomics: vault.per_backer_cap_atomics != null ? String(vault.per_backer_cap_atomics) : null,
			max_per_trade_atomics: String(vault.max_per_trade_atomics),
			daily_budget_atomics: String(vault.daily_budget_atomics),
		},
		nav: {
			nav_atomics: String(nav.navAtomics),
			free_atomics: String(nav.freeAtomics),
			usdc_atomics: String(nav.usdcAtomics),
			share_price_e6: String(priceE6),
			roi_bps: roiBps(nav.navAtomics, totalShares),
			total_shares: String(totalShares),
			priced: nav.priced,
			peak_share_price_e6: String(vault.peak_share_price_e6),
		},
		positions: nav.positions.map((p) => ({ mint: p.mint, amount_raw: p.amount_raw, mark_atomics: p.mark_atomics })),
		backer_count: backers.length,
		backers: backers.map((b) => ({
			shares: String(b.shares),
			deposited_atomics: String(b.deposited_atomics),
			// Pseudonymous: the roster shows stake size, never the user id.
			is_me: who ? b.user_id === who.userId : false,
		})),
		my_position: myPosition,
		is_owner: !!isOwner,
		...(isOwner ? { accrued_fee_atomics: String(vault.accrued_fee_atomics) } : {}),
	};
	return json(res, 200, { data }, { 'cache-control': isOwner || who ? 'no-store' : 'public, max-age=10, s-maxage=20' });
}

async function handlePatch(req, res, id) {
	const who = await authWrite(req, res);
	if (!who) return;
	const vault = await getVault(id);
	if (!vault) return error(res, 404, 'not_found', 'vault not found');
	if (vault.owner_user_id !== who.userId) return error(res, 403, 'forbidden', 'only the vault owner can change it');

	let body;
	try { body = (await readJson(req)) || {}; } catch (e) { return error(res, e?.status === 415 ? 415 : 400, 'bad_request', e?.message || 'invalid body'); }
	const action = String(body.action || 'terms');

	if (action === 'pause') {
		if (vault.status === 'closed') return error(res, 409, 'closed', 'vault is closed');
		const next = await setVaultStatus(vault.id, 'paused', { haltReason: 'owner_pause' });
		await recordVaultEvent({ vaultId: vault.id, type: 'pause', userId: who.userId, reason: 'owner paused trading' });
		return json(res, 200, { data: { vault: next } }, { 'cache-control': 'no-store' });
	}
	if (action === 'resume') {
		if (vault.status === 'closed') return error(res, 409, 'closed', 'vault is closed');
		const next = await setVaultStatus(vault.id, 'open', { haltReason: null });
		await recordVaultEvent({ vaultId: vault.id, type: 'resume', userId: who.userId, reason: 'owner resumed trading' });
		return json(res, 200, { data: { vault: next } }, { 'cache-control': 'no-store' });
	}
	if (action === 'close') {
		const next = await setVaultStatus(vault.id, 'closing', { haltReason: 'owner_close' });
		await recordVaultEvent({ vaultId: vault.id, type: 'close', userId: who.userId, reason: 'owner closing vault — backers may redeem' });
		return json(res, 200, { data: { vault: next } }, { 'cache-control': 'no-store' });
	}
	if (action === 'terms') {
		const patch = {};
		if (body.performanceFeeBps != null) {
			const bps = clampTermBps(body.performanceFeeBps, TERM_BOUNDS.performanceFeeBps);
			if (bps == null) return error(res, 400, 'validation_error', 'performanceFeeBps must be a number');
			patch.performanceFeeBps = bps;
		}
		if (body.maxDrawdownBps != null) {
			const bps = clampTermBps(body.maxDrawdownBps, TERM_BOUNDS.maxDrawdownBps);
			if (bps == null) return error(res, 400, 'validation_error', 'maxDrawdownBps must be a number');
			patch.maxDrawdownBps = bps;
		}
		if (body.maxPerTradeUsdc != null) {
			const v = Number(body.maxPerTradeUsdc);
			if (!(v > 0)) return error(res, 400, 'validation_error', 'maxPerTradeUsdc must be a positive number');
			patch.maxPerTradeAtomics = usdcToAtomics(v);
		}
		if (body.dailyBudgetUsdc != null) {
			const v = Number(body.dailyBudgetUsdc);
			if (!(v > 0)) return error(res, 400, 'validation_error', 'dailyBudgetUsdc must be a positive number');
			patch.dailyBudgetAtomics = usdcToAtomics(v);
		}
		if ('perBackerCapUsdc' in body) {
			const v = body.perBackerCapUsdc;
			if (v != null && !Number.isFinite(Number(v))) return error(res, 400, 'validation_error', 'perBackerCapUsdc must be a number or null');
			patch.perBackerCapAtomics = v == null || Number(v) <= 0 ? null : usdcToAtomics(Number(v));
		}
		const effectivePerTrade = patch.maxPerTradeAtomics ?? toBig(vault.max_per_trade_atomics);
		const effectiveDaily = patch.dailyBudgetAtomics ?? toBig(vault.daily_budget_atomics);
		if (effectivePerTrade > effectiveDaily) return error(res, 400, 'validation_error', 'per-trade ceiling cannot exceed the daily budget');
		const next = await updateVaultTerms(vault.id, patch);
		await recordVaultEvent({ vaultId: vault.id, type: 'terms', userId: who.userId, reason: 'terms updated', meta: { patch: Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, v == null ? null : String(v)])) } });
		return json(res, 200, { data: { vault: next } }, { 'cache-control': 'no-store' });
	}
	return error(res, 400, 'bad_action', 'action must be pause, resume, close, or terms');
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,PATCH,OPTIONS', credentials: true })) return;
	const id = idFromReq(req);
	if (!id || !isUuid(id)) return error(res, 404, 'not_found', 'vault not found');
	if (req.method === 'PATCH') return handlePatch(req, res, id);
	if (!method(req, res, ['GET', 'PATCH'])) return;
	return handleGet(req, res, id);
});
