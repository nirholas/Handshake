/**
 * The Agent Economy — live across the network (Pillar 3).
 *
 * The /agent-economy page is a curated two-agent on-chain demo. This is the
 * wide-angle counterpart: the real population of agents earning on three.ws and
 * the paid services they expose over x402. Reads real, keyless endpoints
 * (no mocks):
 *   - GET /api/agents/economy?view=offers — the agent-to-agent service market:
 *     real offers joined to live hire stats (completion counts, ratings, earnings).
 *   - GET /api/marketplace/agents  — published agents with ratings, buyer counts
 *     and on-chain pricing.
 *   - GET /api/agenc/x402-services — the live x402 bazaar: agent/tool endpoints
 *     charging USDC per call, with price, network and capabilities.
 *
 * Every section owns its loading / empty / error state independently so a slow
 * or failing feed never blanks the page.
 */

import { openHirePanel } from './shared/agent-hire.js';
import { sanitizeUrl } from './shared/sanitize-url.js';

const $ = (sel) => /** @type {HTMLElement} */ (document.querySelector(sel));

// ── Formatting helpers ────────────────────────────────────────────────────────

function fmtUsd(amountAtomics, decimals) {
	const d = Number.isFinite(decimals) ? decimals : 6;
	const n = Number(amountAtomics) / 10 ** d;
	if (!Number.isFinite(n)) return null;
	if (n === 0) return 'Free';
	if (n < 0.01) return `$${n.toFixed(4)}`;
	return `$${n.toFixed(2)}`;
}

function esc(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function chainLabel(chain) {
	const c = String(chain || '').toLowerCase();
	if (c.includes('sol')) return 'Solana';
	if (c.includes('base')) return 'Base';
	if (c.includes('eth')) return 'Ethereum';
	return chain || '';
}

function stars(avg, count) {
	if (!count) return '<span class="ae-muted">No ratings yet</span>';
	const a = Math.round((Number(avg) || 0) * 10) / 10;
	return `<span class="ae-stars" aria-label="${a} out of 5">★ ${a.toFixed(1)}</span> <span class="ae-muted">(${count})</span>`;
}

// ── State rendering ───────────────────────────────────────────────────────────

function skeleton(host, n, kind) {
	host.innerHTML = '';
	for (let i = 0; i < n; i++) {
		const s = document.createElement('div');
		s.className = `ae-skel ae-skel-${kind}`;
		host.appendChild(s);
	}
}

function emptyState(host, title, hint) {
	host.innerHTML = `<div class="ae-empty"><p class="ae-empty-title">${esc(title)}</p><p class="ae-muted">${esc(hint)}</p></div>`;
}

function errorState(host, retryFn) {
	host.innerHTML = '';
	const box = document.createElement('div');
	box.className = 'ae-error';
	box.innerHTML = `<p>Couldn't load this feed.</p>`;
	const btn = document.createElement('button');
	btn.className = 'ae-retry';
	btn.type = 'button';
	btn.textContent = 'Retry';
	btn.addEventListener('click', retryFn);
	box.appendChild(btn);
	host.appendChild(box);
}

// ── Section: earning agents ───────────────────────────────────────────────────

function agentCard(a) {
	const thumb = a.thumbnail_url || '';
	const price = a.price ? fmtUsd(a.price.amount, a.price.mint_decimals) : null;
	const priceChip = price
		? `<span class="ae-chip ae-chip-price">${esc(price)}${a.price?.chain ? ` · ${esc(chainLabel(a.price.chain))}` : ''}</span>`
		: a.has_paid_skills ? '<span class="ae-chip">Paid skills</span>' : '<span class="ae-chip ae-chip-free">Free</span>';
	const buyers = Number(a.buyers_total) || 0;
	const buyers24 = Number(a.buyers_24h) || 0;
	return `
		<a class="ae-card" href="/agents/${encodeURIComponent(a.id)}">
			<div class="ae-card-top">
				<div class="ae-avatar">${thumb ? `<img src="${esc(thumb)}" alt="" loading="lazy" />` : `<span class="ae-avatar-fallback">${esc((a.name || '?').slice(0, 1).toUpperCase())}</span>`}</div>
				<div class="ae-card-head">
					<span class="ae-card-name">${esc(a.name || 'Untitled agent')}</span>
					<span class="ae-muted ae-card-cat">${esc(a.category || 'general')}</span>
				</div>
			</div>
			<p class="ae-card-desc">${esc((a.description || '').slice(0, 110))}</p>
			<div class="ae-card-foot">
				<span class="ae-rating">${stars(a.rating_avg, a.rating_count)}</span>
				${priceChip}
			</div>
			<div class="ae-card-metrics">
				<span title="Total buyers"><strong>${buyers.toLocaleString()}</strong> buyers</span>
				${buyers24 > 0 ? `<span class="ae-up" title="Buyers in the last 24h">▲ ${buyers24.toLocaleString()} / 24h</span>` : ''}
			</div>
		</a>`;
}

async function loadAgents({ quiet = false } = {}) {
	const host = $('#ae-agents');
	if (!host) return;
	if (!quiet) skeleton(host, 6, 'card');
	try {
		const sort = $('#ae-sort')?.value || 'top_rated';
		const params = new URLSearchParams({ sort, limit: '24' });
		const r = await fetch(`/api/marketplace/agents?${params}`, { credentials: 'include' });
		if (!r.ok) throw new Error(`status ${r.status}`);
		const j = await r.json();
		const items = j?.data?.items || j?.items || [];
		if (!items.length) {
			emptyState(host, 'No published agents yet', 'Be the first — build an agent and price a skill.');
			setStat('#ae-stat-agents', '0');
			return;
		}
		host.innerHTML = items.map(agentCard).join('');
		setStat('#ae-stat-agents', items.length >= 24 ? '24+' : String(items.length));
		const earners = items.filter((a) => (Number(a.buyers_total) || 0) > 0).length;
		setStat('#ae-stat-earning', String(earners));
	} catch (err) {
		errorState(host, loadAgents);
		// eslint-disable-next-line no-console
		console.error('[economy-live] agents', err);
	}
}

// ── Section: live x402 services ───────────────────────────────────────────────

function serviceRow(t) {
	const price = t.price?.amountLabel
		? `${esc(t.price.amountLabel)}${t.price.currency ? ` ${esc(t.price.currency)}` : ''}`
		: 'Free';
	const net = t.price?.network ? chainLabel(t.price.network) : '';
	const method = t.method ? `<span class="ae-svc-method">${esc(t.method)}</span>` : '';
	const tags = (t.tags || []).slice(0, 3).map((x) => `<span class="ae-tag">${esc(x)}</span>`).join('');
	// t.resource is an x402 endpoint URL sourced from third-party facilitator
	// discovery listings (PayAI / Coinbase CDP / etc.) — any operator can
	// register one, so it's untrusted external input. esc() only guards
	// attribute-breakout; sanitizeUrl() gates the scheme so a malicious
	// `javascript:`/`data:` listing can't execute when clicked.
	return `
		<a class="ae-svc" href="${esc(sanitizeUrl(t.resource || '#'))}" rel="noopener" target="_blank">
			<div class="ae-svc-main">
				<span class="ae-svc-name">${method}${esc(t.serviceName || t.toolName || 'Service')}</span>
				<span class="ae-svc-desc ae-muted">${esc((t.description || '').slice(0, 120))}</span>
				<span class="ae-svc-tags">${tags}</span>
			</div>
			<div class="ae-svc-price">
				<span class="ae-chip ae-chip-price">${price}</span>
				${net ? `<span class="ae-muted ae-svc-net">${esc(net)}</span>` : ''}
			</div>
		</a>`;
}

async function loadServices({ quiet = false } = {}) {
	const host = $('#ae-services');
	if (!host) return;
	if (!quiet) skeleton(host, 5, 'row');
	try {
		const params = new URLSearchParams({ type: 'http', maxItems: '40' });
		const r = await fetch(`/api/agenc/x402-services?${params}`);
		if (!r.ok) throw new Error(`status ${r.status}`);
		const j = await r.json();
		const tasks = j?.tasks || [];
		if (!tasks.length) {
			emptyState(host, 'No live x402 services right now', 'Agents publish pay-per-call endpoints here as they come online.');
			setStat('#ae-stat-services', '0');
			return;
		}
		host.innerHTML = tasks.map(serviceRow).join('');
		setStat('#ae-stat-services', tasks.length >= 40 ? '40+' : String(tasks.length));
	} catch (err) {
		errorState(host, loadServices);
		// eslint-disable-next-line no-console
		console.error('[economy-live] services', err);
	}
}

// ── Section: agents hiring agents (the A2A service market) ────────────────────

let _offers = [];

function offerAvatar(offer) {
	const url = offer?.provider?.avatar_thumbnail_url || '';
	if (url) return `<span class="ae-offer-av"><img src="${esc(url)}" alt="" loading="lazy" /></span>`;
	const letter = (offer?.provider?.name || offer?.name || '?').slice(0, 1).toUpperCase();
	return `<span class="ae-offer-av"><span class="ae-offer-av-fallback">${esc(letter)}</span></span>`;
}

function offerStatsLine(st) {
	if (!st) return '';
	const bits = [];
	const completed = Number(st.completion_count) || 0;
	bits.push(`<span><strong>${completed.toLocaleString()}</strong> hire${completed === 1 ? '' : 's'}</span>`);
	if (st.rating_count > 0 && st.avg_rating != null) {
		bits.push(`<span class="ae-stars" aria-label="${Number(st.avg_rating).toFixed(1)} out of 5">★ ${Number(st.avg_rating).toFixed(1)} <span class="ae-muted">(${st.rating_count})</span></span>`);
	}
	if (st.success_rate != null && st.total_hires > 0) {
		bits.push(`<span title="Completed vs disputed/failed/refunded"><strong>${Math.round(st.success_rate * 100)}%</strong> success</span>`);
	}
	if (Number(st.throughput_24h) > 0) {
		bits.push(`<span class="ae-fresh" title="Hires in the last 24h">▲ ${Number(st.throughput_24h)} / 24h</span>`);
	}
	if (Number(st.earned_usdc) > 0) {
		bits.push(`<span title="Lifetime earned to the provider's wallet">$${Number(st.earned_usdc).toLocaleString(undefined, { maximumFractionDigits: 2 })} earned</span>`);
	}
	return bits.join('');
}

function priceUsd(offer) {
	if (offer?.price_usdc != null) return Number(offer.price_usdc);
	return Number(offer?.price_atomics || 0) / 1e6;
}

function fmtPrice(n) {
	const v = Number(n);
	if (!Number.isFinite(v) || v === 0) return 'Free';
	if (v < 0.01) return `$${v.toFixed(4)}`;
	return `$${v.toFixed(2)}`;
}

function offerCard(offer) {
	const prov = offer.provider || {};
	const provHref = prov.id ? `/agent/${encodeURIComponent(prov.id)}` : null;
	const provLabel = provHref
		? `<a href="${esc(provHref)}">${esc(prov.name || 'Agent')}</a>`
		: esc(prov.name || 'Agent');
	return `
		<article class="ae-offer" data-slug="${esc(offer.slug)}">
			<div class="ae-offer-top">
				${offerAvatar(offer)}
				<div class="ae-offer-id">
					<div class="ae-offer-name" title="${esc(offer.name)}">${esc(offer.name || 'Service')}</div>
					<div class="ae-offer-prov">by ${provLabel} · ${esc(chainLabel(offer.network) || 'Solana')}</div>
				</div>
				<div class="ae-offer-price">${esc(fmtPrice(priceUsd(offer)))}</div>
			</div>
			<p class="ae-offer-desc">${esc(offer.description || 'A paid skill another agent can hire.')}</p>
			<div class="ae-offer-stats">${offerStatsLine(offer.stats)}</div>
			<div class="ae-offer-foot">
				<button class="ae-hire-btn" type="button" data-hire="${esc(offer.slug)}">Hire this agent</button>
				${provHref ? `<a class="ae-offer-link" href="${esc(provHref)}">Provider →</a>` : ''}
			</div>
		</article>`;
}

function sortOffers(offers, mode) {
	const arr = offers.slice();
	if (mode === 'new') {
		arr.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
	} else {
		arr.sort((a, b) => (Number(b.stats?.completion_count) || 0) - (Number(a.stats?.completion_count) || 0));
	}
	return arr;
}

function renderOffers() {
	const host = $('#ae-offers');
	if (!host) return;
	if (!_offers.length) {
		emptyState(host, 'No agent services listed yet', 'When an owner prices one of their agent\'s skills, it appears here for other agents to hire.');
		setStat('#ae-stat-hires', '0');
		return;
	}
	const mode = $('#ae-offer-sort')?.value || 'proven';
	host.innerHTML = sortOffers(_offers, mode).map(offerCard).join('');
	for (const btn of host.querySelectorAll('[data-hire]')) {
		btn.addEventListener('click', () => {
			const offer = _offers.find((o) => o.slug === btn.getAttribute('data-hire'));
			if (offer) openHirePanel(offer, { onComplete: () => loadOffers({ quiet: true }) });
		});
	}
	const totalHires = _offers.reduce((sum, o) => sum + (Number(o.stats?.completion_count) || 0), 0);
	setStat('#ae-stat-hires', totalHires >= 1000 ? `${(totalHires / 1000).toFixed(1)}k` : String(totalHires));
}

async function loadOffers({ quiet = false } = {}) {
	const host = $('#ae-offers');
	if (!host) return;
	if (!quiet && !_offers.length) {
		host.innerHTML = '';
		for (let i = 0; i < 6; i++) {
			const s = document.createElement('div');
			s.className = 'ae-skel ae-skel-offer';
			host.appendChild(s);
		}
	}
	try {
		const r = await fetch('/api/agents/economy?view=offers&limit=60', { credentials: 'include' });
		if (!r.ok) throw new Error(`status ${r.status}`);
		const j = await r.json();
		_offers = j?.data?.offers || [];
		renderOffers();
	} catch (err) {
		if (!_offers.length) errorState(host, () => loadOffers());
		// eslint-disable-next-line no-console
		console.error('[economy-live] offers', err);
	}
}

function setStat(sel, value) {
	const el = $(sel);
	if (el) el.textContent = value;
}

const REFRESH_MS = 45000;
let _refreshTimer = 0;

function scheduleRefresh() {
	clearInterval(_refreshTimer);
	_refreshTimer = window.setInterval(() => {
		if (document.hidden) return; // don't poll a backgrounded tab
		loadOffers({ quiet: true });
		loadAgents({ quiet: true });
		loadServices({ quiet: true });
		pulseLive();
	}, REFRESH_MS);
}

function pulseLive() {
	const live = $('#ae-live');
	if (!live) return;
	live.hidden = false;
	const label = $('#ae-live-label');
	if (label) {
		label.textContent = 'Updated just now';
		setTimeout(() => { label.textContent = 'Live'; }, 2500);
	}
}

export function initEconomyLive() {
	loadOffers().then(() => pulseLive());
	loadAgents();
	loadServices();
	const sortEl = $('#ae-sort');
	if (sortEl) sortEl.addEventListener('change', () => loadAgents());
	const offerSortEl = $('#ae-offer-sort');
	if (offerSortEl) offerSortEl.addEventListener('change', () => renderOffers());
	scheduleRefresh();
}

if (typeof document !== 'undefined') {
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', initEconomyLive, { once: true });
	} else {
		initEconomyLive();
	}
}
