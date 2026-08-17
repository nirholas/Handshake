/**
 * My Collection: the pure card/state renderers.
 *
 * Split out of collection.js so the markup can be unit-tested without booting
 * the page controller (which fetches and mutates the DOM on import).
 */

import { walletChipHTML } from './shared/agent-wallet-chip.js';

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const THREE_MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';

function fmtDate(iso) {
	if (!iso) return '';
	return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtAmount(amount, mint) {
	if (!amount) return '';
	const symbol = mint === THREE_MINT ? '$THREE' : mint === USDC_MINT ? 'USDC' : '';
	const val = (Number(amount) / 1_000_000).toFixed(2);
	return symbol ? `${val} ${symbol}` : val;
}

function fmtUsd(n) {
	if (n == null || Number.isNaN(Number(n))) return '';
	return `$${Number(n).toFixed(2)}`;
}

function esc(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) => (
		{ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
	));
}

function explorerUrl(mint, network) {
	const base = network === 'devnet'
		? 'https://explorer.solana.com/address/'
		: 'https://solscan.io/token/';
	const suffix = network === 'devnet' ? '?cluster=devnet' : '';
	return `${base}${mint}${suffix}`;
}

function skillCard(p) {
	const agentName = p.agent_name || 'Unknown agent';
	const thumb = p.agent_thumbnail
		? `<img class="col-card-avatar" src="${esc(p.agent_thumbnail)}" alt="${esc(agentName)}" loading="lazy">`
		: `<div class="col-card-avatar placeholder" aria-hidden="true">⚡</div>`;

	const kindBadge = p.kind === 'trial'
		? '<span class="badge badge-amber">Trial</span>'
		: '<span class="badge badge-green">Owned</span>';

	const nftLine = p.skill_nft_mint
		? `<div class="col-card-nft">NFT: <a href="${esc(explorerUrl(p.skill_nft_mint, p.skill_nft_network))}" target="_blank" rel="noopener">${esc(`${p.skill_nft_mint.slice(0, 6)}…${p.skill_nft_mint.slice(-4)}`)}</a></div>`
		: '';

	const priceLine = p.amount ? `<span class="badge badge-muted">${esc(fmtAmount(p.amount, p.currency_mint))}</span>` : '';

	// Wallet chip for the publishing agent, only when the purchase record carries
	// its custodial Solana address. The buyer doesn't own the publisher agent, so
	// the chip renders isOwner:false (◎ Tip), letting the holder tip the creator
	// straight from their collection. getWalletStatus returns null without an
	// address, so showPending:false means the chip simply doesn't render.
	// Field names match what /api/users/me/purchased-skills actually selects
	// (agent_solana_*, aliased off agent_identities.meta). Reading the un-prefixed
	// names alone silently dropped every vanity address into a plain one.
	const agentRecord = {
		id: p.agent_id,
		name: p.agent_name,
		solana_address: p.solana_address || p.agent_solana_address || null,
		solana_vanity_prefix: p.solana_vanity_prefix || p.agent_solana_vanity_prefix || null,
		solana_vanity_suffix: p.solana_vanity_suffix || p.agent_solana_vanity_suffix || null,
		avatar_thumbnail_url: p.agent_thumbnail || null,
	};
	const walletLine = agentRecord.solana_address
		? `<div class="col-card-wallet" style="margin-top:8px">${walletChipHTML(agentRecord, { isOwner: false, showPending: false, dense: true })}</div>`
		: '';

	const agentHref = p.agent_id
		? `/marketplace/agents/${encodeURIComponent(p.agent_id)}`
		: '/marketplace';

	return `
		<article class="col-card">
			<div class="col-card-header">
				${thumb}
				<div class="col-card-meta">
					<div class="col-card-skill">${esc(p.skill)}</div>
					<div class="col-card-agent">${esc(agentName)}</div>
				</div>
			</div>
			${walletLine}
			<div class="col-card-badges">${kindBadge}${priceLine}</div>
			${nftLine}
			<div class="col-card-footer">
				<span class="col-card-date">Purchased ${esc(fmtDate(p.confirmed_at || p.created_at))}</span>
				<a href="${esc(agentHref)}" class="col-cta">View agent<span class="sr-only"> ${esc(agentName)}</span></a>
			</div>
		</article>`;
}

function subCard(s) {
	const now = Date.now();
	const periodEnd = s.current_period_end ? new Date(s.current_period_end) : null;
	const isActive = s.status === 'active' && (!periodEnd || periodEnd > now);
	const isCancelled = s.status === 'cancelled' || s.status === 'canceled';

	const expiryClass = isActive ? 'active' : 'expired';
	const expiryText = periodEnd
		? (isActive
			? `Renews ${fmtDate(s.current_period_end)}`
			: `${isCancelled ? 'Ends' : 'Ended'} ${fmtDate(s.current_period_end)}`)
		: '';

	const statusBadge = isActive
		? '<span class="badge badge-green">Active</span>'
		: isCancelled
			? '<span class="badge badge-muted">Cancelled</span>'
			: '<span class="badge badge-amber">Expired</span>';

	const priceLine = s.price_usd != null
		? `<span class="badge badge-muted">${esc(fmtUsd(s.price_usd))}${s.interval ? ` / ${esc(s.interval)}` : ''}</span>`
		: '';

	const planName = s.plan_name || 'Subscription';
	const creator = s.creator_name || 'Creator';
	const creatorHref = s.creator_username ? `/u/${encodeURIComponent(s.creator_username)}` : '/marketplace';
	const initial = esc((planName[0] || '🔄').toUpperCase());

	return `
		<article class="col-card">
			<div class="col-card-header">
				<div class="col-card-avatar placeholder" aria-hidden="true">${initial}</div>
				<div class="col-card-meta">
					<div class="col-card-skill">${esc(planName)}</div>
					<div class="col-card-agent">by ${esc(creator)}</div>
				</div>
			</div>
			<div class="col-card-badges">${statusBadge}${priceLine}</div>
			<div class="col-card-footer">
				<span class="col-sub-expiry ${expiryClass}">${esc(expiryText)}</span>
				<a href="${esc(creatorHref)}" class="col-cta">View creator<span class="sr-only"> ${esc(creator)}</span></a>
			</div>
		</article>`;
}

function skeletonGrid(n = 6) {
	return Array.from({ length: n }, () => `
		<div class="skeleton-card">
			<div class="col-card-header">
				<div class="col-card-avatar skeleton"></div>
				<div class="col-card-meta">
					<div class="skeleton-row skeleton" style="width:70%;margin-bottom:6px;"></div>
					<div class="skeleton-row skeleton" style="width:45%;"></div>
				</div>
			</div>
			<div class="skeleton-row skeleton" style="width:40%;"></div>
			<div style="display:flex;justify-content:space-between;margin-top:4px;">
				<div class="skeleton-row skeleton" style="width:40%;"></div>
				<div class="skeleton-row skeleton" style="width:25%;"></div>
			</div>
		</div>`).join('');
}

function emptyState(panel) {
	if (panel === 'skills') {
		return `
			<div class="col-empty">
				<svg width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24" aria-hidden="true"><path d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>
				<h3>No skills yet</h3>
				<p>Browse the <a href="/marketplace">marketplace</a> and unlock premium agent skills.</p>
			</div>`;
	}
	return `
		<div class="col-empty">
			<svg width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24" aria-hidden="true"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
			<h3>No subscriptions</h3>
			<p>Browse the <a href="/marketplace">marketplace</a> and subscribe to a creator to see it here.</p>
		</div>`;
}

export { esc, fmtDate, fmtAmount, fmtUsd, explorerUrl, skillCard, subCard, skeletonGrid, emptyState };
