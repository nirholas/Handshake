/**
 * Marketplace-feature enrichment for the canonical /agents/:id detail page.
 *
 * The lean page (agent-detail.js) renders on-chain identity, wallet, memory,
 * actions, reputation and reviews. This module layers the discovery + commerce
 * features that previously only lived on the marketplace SPA's detail view, so
 * a single canonical agent page is the superset of both:
 *
 *   - 3D avatar viewer (model-viewer) in the hero
 *   - author / published / category / views / forks metadata
 *   - fork · bookmark · export-JSON hero actions
 *   - live "try it now" chat preview (reused from marketplace-detail.js)
 *   - creator profile modal (reused from marketplace-detail.js)
 *   - per-skill pricing (purchase · trial · time-pass) via the shared engine
 *   - whole-agent sale / buy panel (asset-price + payout wallet)
 *   - embed snippets (web component · iframe · direct link)
 *   - similar agents + version history
 *
 * Data comes from /api/marketplace/agents/:id (the same aggregate the SPA used).
 * If that endpoint 404s — agent not published to the marketplace — enrichment is
 * silently skipped and the base page is unaffected.
 */

import {
	startPreviewSession,
	bindDetailExtras,
} from './marketplace-detail.js';
import {
	configureSkillPurchase,
	openPurchaseFlow,
	openTrialFlow,
	openTimePassFlow,
	openSubscribeFlow,
	openAssetPurchaseFlow,
	formatAssetPrice,
	apiPostWithCsrf,
	USDC_MAINNET_MINT,
} from './shared/skill-purchase.js';
import { log } from './shared/log.js';
import { showToast } from './ui-helpers.js';
import { seeInWorldHref, hasCustomAvatar } from './shared/agent-3d.js';
import { mountSkillReviews } from './skill-reviews.js';

const API = '/api';
const $ = (id) => document.getElementById(id);

const CATEGORY_LABELS = {
	academic: 'Academic', career: 'Career', copywriting: 'Copywriting', design: 'Design',
	education: 'Education', emotions: 'Emotions', entertainment: 'Entertainment', games: 'Games',
	general: 'General', life: 'Life', marketing: 'Marketing', office: 'Office',
	programming: 'Programming', translation: 'Translation', blockchain: 'Blockchain',
};

function escapeHtml(s) {
	return String(s ?? '').replace(
		/[&<>"']/g,
		(ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch],
	);
}
// Safe DOM-id fragment from an arbitrary skill name (used for ARIA panel ids).
function cssId(s) {
	return String(s ?? '').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 64) || 'x';
}
function initial(name) {
	const s = String(name || '?').trim();
	return s ? s[0].toUpperCase() : '?';
}
function formatDate(iso) {
	if (!iso) return '';
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return '';
	return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
function fmtNumber(n) {
	const v = Number(n) || 0;
	if (v >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
	if (v >= 1e3) return (v / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
	return String(v);
}

// Module-scoped current agent — the shared purchase engine reads it via getAgent.
let marketAgent = null;
let isOwner = false;
const purchasedSkills = new Set();

// ── Entry ────────────────────────────────────────────────────────────────────

export async function enrichAgentDetail(baseAgent) {
	if (!baseAgent?.id) return;
	isOwner = !!baseAgent.isOwner;

	let market;
	try {
		const r = await fetch(`${API}/marketplace/agents/${encodeURIComponent(baseAgent.id)}`, {
			credentials: 'include',
		});
		if (!r.ok) return; // not published to marketplace — base page stands alone
		const j = await r.json();
		market = j?.data?.agent;
	} catch (e) {
		log.warn('[agent-detail-market] enrich fetch failed:', e.message);
		return;
	}
	if (!market) return;
	marketAgent = market;
	(market.purchased_skills || []).forEach((s) => purchasedSkills.add(s));

	configureSkillPurchase({
		getAgent: () => marketAgent,
		onPurchased: reloadPurchases,
	});

	render3DAvatar(market);
	upgradeSee3d(market);
	renderMeta(market);
	renderHeroActions(baseAgent, market);
	renderSalePanel(baseAgent, market);
	renderPricing(market);
	renderSubscriptionTiers(market).catch((e) => log.warn('[agent-detail-market] tiers', e?.message));
	renderEmbed(market);
	startPreviewSession(market);
	const preview = $('ad-preview-card');
	if (preview) preview.hidden = false;

	// Pay-per-minute of talking: a non-owner can open a money stream right under the
	// chat preview to support the agent by the second while they converse. Owners
	// don't stream to their own agent (their earnings live on the dedicated Money
	// Stream card), so the meter is visitor-only here.
	mountPreviewStream(market, baseAgent);

	// Reuse the marketplace module's preview-form + creator-modal wiring. navTo
	// routes the creator's mini-cards to the canonical /agents/:id page directly
	// (skipping the legacy /marketplace redirect hop).
	bindDetailExtras({
		navTo: (path) => {
			location.href = path.replace(/^\/marketplace\/agents\//, '/agents/');
		},
	});

	loadSimilar(baseAgent.id);
	loadVersions(baseAgent.id);
	bindPurchaseDelegation();
}

let _previewStreamHandle = null;

// Mount a compact pay-per-minute stream meter under the chat preview. Visitor-only:
// the owner's streaming income is shown on the dedicated Money Stream card instead.
function mountPreviewStream(market, baseAgent) {
	const host = $('d-preview-stream');
	if (!host) return;
	if (_previewStreamHandle) { try { _previewStreamHandle.destroy(); } catch { /* idempotent */ } _previewStreamHandle = null; }
	const address =
		market?.meta?.solana_address || market?.solana_address ||
		baseAgent?.meta?.solana_address || baseAgent?.solana_address || null;
	const owner = !!(baseAgent?.isOwner || market?.isOwner || isOwner);
	if (!address || owner) { host.hidden = true; return; }
	host.hidden = false;
	import('./shared/agent-money-stream.js').then(({ mountStreamMeter }) => {
		_previewStreamHandle = mountStreamMeter(host, {
			id: baseAgent.id,
			name: market?.name || baseAgent?.name,
			solana_address: address,
			avatar_thumbnail_url: market?.avatar_thumbnail_url || baseAgent?.avatar || '',
			meta: market?.meta || baseAgent?.meta || {},
		}, { network: 'mainnet', isOwner: false, compact: true });
	}).catch(() => { host.hidden = true; });
}

if (typeof window !== 'undefined') {
	window.addEventListener('pagehide', () => {
		try { _previewStreamHandle?.destroy?.(); } catch { /* idempotent */ } _previewStreamHandle = null;
	}, { once: true });
}

// Re-fetch owned-skills after a purchase / trial and re-render the pricing card.
async function reloadPurchases(agentId) {
	try {
		const r = await fetch(`${API}/marketplace/agents/${encodeURIComponent(agentId)}`, {
			credentials: 'include',
		});
		if (!r.ok) return;
		const j = await r.json();
		const fresh = j?.data?.agent;
		if (!fresh) return;
		marketAgent = fresh;
		purchasedSkills.clear();
		(fresh.purchased_skills || []).forEach((s) => purchasedSkills.add(s));
		// renderPricing rebuilds the body HTML, detaching any open review panels —
		// tear their handles down first so aborters/listeners don't leak.
		for (const handle of reviewHandles.values()) handle.destroy();
		reviewHandles.clear();
		renderPricing(fresh);
		renderSubscriptionTiers(fresh).catch(() => {});
	} catch (e) {
		log.warn('[agent-detail-market] reloadPurchases failed:', e.message);
	}
}

// ── 3D avatar ────────────────────────────────────────────────────────────────

export function render3DAvatar(a) {
	if (!a.avatar_glb_url) return;

	// The hero and the fullscreen modal already host <model-viewer> elements,
	// seeded with the base mannequin during the first render. Swap their source
	// to the agent's own GLB in place. An older revision built a fresh viewer
	// here and replaced the flat <img> fallback with it — but the markup now
	// ships a dedicated <model-viewer id="ad-avatar-3d">, so that path duplicated
	// the id and stacked a second, unsized 240×280 canvas below the avatar wrap,
	// bleeding the model over the agent's name. Updating in place keeps a single
	// viewer with its intended hero behaviour (auto-rotate, click-to-expand).
	const setSrc = (mv, alt) => {
		if (!mv || mv.getAttribute('src') === a.avatar_glb_url) return;
		mv.setAttribute('src', a.avatar_glb_url);
		mv.setAttribute('alt', alt);
		if (a.thumbnail_url) mv.setAttribute('poster', a.thumbnail_url);
	};
	setSrc($('ad-avatar-3d'), a.name || 'Agent avatar');
	setSrc($('ad-avatar-modal-3d'), `${a.name || 'Agent'} avatar — fullscreen`);

	// The flat <img> only surfaces if the GLB fails to load; keep it hidden while
	// the model is authoritative.
	const img = $('ad-avatar');
	if (img) img.style.display = 'none';
}

// Upgrade the always-present "See in 3D" link once the marketplace record (with
// its custom avatar_glb_url) is in hand — so agents that ship their own avatar
// walk into the world as themselves rather than the base mannequin.
function upgradeSee3d(a) {
	const see3d = $('ad-see-3d');
	if (!see3d) return;
	see3d.href = seeInWorldHref(a);
	if (hasCustomAvatar(a)) see3d.setAttribute('title', `See ${a.name || 'this agent'} in the three.ws world`);
}

// ── Hero metadata ─────────────────────────────────────────────────────────────

function renderMeta(a) {
	const row = $('ad-market-meta');
	if (!row) return;
	const author = a.author_name || 'Anonymous';
	const published = a.published_at || a.created_at;
	const views = a.views_count ?? 0;
	const forks = a.forks_count ?? 0;

	const authorBtn = $('d-author');
	if (authorBtn) {
		authorBtn.textContent = author;
		if (a.author_id) {
			authorBtn.dataset.creatorId = a.author_id;
			authorBtn.disabled = false;
		} else {
			delete authorBtn.dataset.creatorId;
			authorBtn.disabled = true;
		}
	}
	$('ad-published').textContent = published ? formatDate(published) : '';
	const cat = $('ad-category');
	cat.textContent = CATEGORY_LABELS[a.category] || a.category || 'General';
	$('ad-views').textContent = `⊙ ${fmtNumber(views)}`;
	const forksPill = $('ad-forks-pill');
	if (forks > 0) {
		forksPill.textContent = `⑂ ${fmtNumber(forks)} forks`;
		forksPill.hidden = false;
	} else {
		forksPill.hidden = true;
	}
	row.hidden = false;
}

// ── Hero actions: fork · bookmark · export ────────────────────────────────────

function renderHeroActions(baseAgent, market) {
	const wrap = $('ad-market-actions');
	if (!wrap) return;
	wrap.hidden = false;

	const bookmarkBtn = $('ad-bookmark');
	if (bookmarkBtn) {
		setBookmark(bookmarkBtn, !!market.bookmarked);
		bookmarkBtn.onclick = () => toggleBookmark(baseAgent.id, bookmarkBtn);
	}
	const forkBtn = $('ad-fork');
	if (forkBtn) forkBtn.onclick = () => forkAgent(baseAgent.id);
	const exportBtn = $('ad-export-json');
	if (exportBtn) exportBtn.onclick = () => exportAgentJson(market);
}

function setBookmark(btn, on) {
	btn.classList.toggle('on', on);
	btn.textContent = on ? '★ Saved' : '☆ Save';
	btn.dataset.on = on ? '1' : '0';
	btn.setAttribute('aria-pressed', on ? 'true' : 'false');
}

async function toggleBookmark(agentId, btn) {
	const cur = btn.dataset.on === '1';
	try {
		const r = await fetch(`${API}/marketplace/agents/${agentId}/bookmark`, {
			method: cur ? 'DELETE' : 'POST',
			credentials: 'include',
		});
		if (r.status === 401) {
			location.href = `/login?next=${encodeURIComponent(location.pathname)}`;
			return;
		}
		const j = await r.json().catch(() => null);
		if (!r.ok) throw new Error(j?.error_description || 'request failed');
		setBookmark(btn, !!j?.data?.bookmarked);
	} catch (err) {
		log.error('[agent-detail-market] bookmark', err);
		// The button still reflects its prior state (we never flipped it on the
		// failure path), so the user can simply retry — but surface the failure
		// so a dropped save isn't silent.
		showToast(`Couldn't ${cur ? 'remove' : 'save'} bookmark — try again`, { type: 'error' });
	}
}

async function forkAgent(agentId) {
	const btn = $('ad-fork');
	if (btn) { btn.disabled = true; btn.textContent = 'Forking…'; }
	try {
		const r = await fetch(`${API}/marketplace/agents/${agentId}/fork`, {
			method: 'POST',
			credentials: 'include',
		});
		if (r.status === 401) {
			location.href = `/login?next=${encodeURIComponent(location.pathname)}`;
			return;
		}
		const j = await r.json();
		if (!r.ok) throw new Error(j?.error_description || 'Fork failed');
		const newId = j?.data?.agent?.id;
		if (newId) location.href = `/agents/${newId}`;
	} catch (err) {
		alert(err.message || 'Fork failed');
		if (btn) { btn.disabled = false; btn.textContent = '⑂ Fork & Chat'; }
	}
}

function exportAgentJson(a) {
	const exportable = {
		id: a.id,
		name: a.name,
		description: a.description,
		category: a.category,
		tags: a.tags || [],
		greeting: a.greeting || '',
		system_prompt: a.system_prompt || '',
		capabilities: a.capabilities || {},
		skills: a.skills || a.capabilities?.skills || [],
		fork_of: a.fork_of || null,
		exported_at: new Date().toISOString(),
		source: `https://three.ws/agents/${encodeURIComponent(a.id)}`,
	};
	const blob = new Blob([JSON.stringify(exportable, null, 2)], { type: 'application/json' });
	const url = URL.createObjectURL(blob);
	const link = document.createElement('a');
	link.href = url;
	const slug = (a.name || a.id || 'agent').toString().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
	link.download = `${slug || 'agent'}.three-ws.json`;
	document.body.appendChild(link);
	link.click();
	document.body.removeChild(link);
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── Agent sale / buy panel ────────────────────────────────────────────────────

function setSaleStatus(el, text, kind) {
	if (!el) return;
	el.textContent = text;
	el.className = 'ad-sale-status' + (kind ? ' ' + kind : '');
}

function renderSalePanel(baseAgent, agent) {
	const card = $('ad-sale-card');
	const panel = $('ad-sale-panel');
	if (!card || !panel) return;
	const price = agent.price || null;

	if (isOwner) {
		card.hidden = false;
		const decimals = Number(price?.mint_decimals ?? 6);
		const currentUsd = price ? String(Number(price.amount) / Math.pow(10, decimals)) : '';
		panel.innerHTML = `
			<div class="ad-sale-eyebrow">Sell this agent</div>
			${price
				? `<div class="ad-sale-price">${escapeHtml(formatAssetPrice(price) || 'Free')}</div>`
				: `<div class="ad-sale-price free">Free</div>`}
			<label class="ad-sale-field">Price
				<span class="ad-sale-input-wrap">
					<input type="number" id="ad-sale-price" min="0" step="0.01" placeholder="0.00" value="${escapeHtml(currentUsd)}" />
					<span class="ad-sale-currency">USDC</span>
				</span>
			</label>
			<label class="ad-sale-field">Solana payout wallet
				<input type="text" id="ad-sale-payout" placeholder="Your Solana address" />
			</label>
			<div class="ad-sale-actions">
				<button class="ad-btn ad-btn-primary" type="button" id="ad-sale-save">${price ? 'Update price' : 'List for sale'}</button>
				${price ? '<button class="ad-btn" type="button" id="ad-sale-clear">Make free</button>' : ''}
			</div>
			<p class="ad-sale-status" id="ad-sale-status"></p>
			<p class="ad-sale-hint">Per-skill prices are set below — this is a single one-time price to fork the whole agent.</p>`;

		fetch(`${API}/billing/payout-wallets`, { credentials: 'include' })
			.then((r) => (r.ok ? r.json() : null))
			.then((j) => {
				const ws = j?.wallets || [];
				const solana = ws.find((w) => w.chain === 'solana' && w.is_default) || ws.find((w) => w.chain === 'solana');
				if (solana?.address) {
					const inp = $('ad-sale-payout');
					if (inp && !inp.value) inp.value = solana.address;
				}
			})
			.catch(() => {});

		$('ad-sale-save')?.addEventListener('click', () => saveAgentPrice(agent.id));
		$('ad-sale-clear')?.addEventListener('click', () => clearAgentPrice(agent.id));
		return;
	}

	if (price) {
		card.hidden = false;
		panel.innerHTML = `
			<div class="ad-sale-eyebrow">For sale</div>
			<div class="ad-sale-price">${escapeHtml(formatAssetPrice(price))}</div>
			<button class="ad-btn ad-btn-primary" type="button" id="ad-sale-buy">Buy agent with USDC</button>
			<p class="ad-sale-status" id="ad-sale-status"></p>
			<p class="ad-sale-hint">One-time purchase grants ownership to fork the whole agent. Per-skill prices below are separate.</p>`;
		$('ad-sale-buy')?.addEventListener('click', () => openAssetPurchaseFlow({
			item_type: 'agent',
			item_id: agent.id,
			label: agent.name || 'Agent',
			price,
		}));
		return;
	}

	card.hidden = true;
}

async function saveAgentPrice(agentId) {
	const priceInput = $('ad-sale-price');
	const payoutInput = $('ad-sale-payout');
	const status = $('ad-sale-status');
	if (!priceInput || !payoutInput) return;
	const usd = Number(priceInput.value || 0);
	const payout = (payoutInput.value || '').trim();
	if (!Number.isFinite(usd) || usd < 0) { setSaleStatus(status, 'Enter a valid price.', 'err'); return; }
	if (usd > 0 && !payout) { setSaleStatus(status, 'A payout wallet is required to charge.', 'err'); return; }

	setSaleStatus(status, 'Saving…');
	try {
		if (payout) {
			const r = await fetch(`${API}/billing/payout-wallets`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				credentials: 'include',
				body: JSON.stringify({ address: payout, chain: 'solana', is_default: true }),
			});
			if (!r.ok && r.status !== 409) {
				const j = await r.json().catch(() => ({}));
				throw new Error(j.error_description || j.error || 'Failed to save payout wallet');
			}
		}
		const amount = Math.round(usd * 1_000_000);
		const r = await apiPostWithCsrf('/api/marketplace/asset-price', {
			item_type: 'agent',
			item_id: agentId,
			amount,
			currency_mint: USDC_MAINNET_MINT,
			chain: 'solana',
			mint_decimals: 6,
		});
		const j = await r.json();
		if (!r.ok) throw new Error(j.error_description || j.error || 'Failed to save price');
		setSaleStatus(status, amount === 0 ? '✓ Agent is now free.' : `✓ Listed for ${usd} USDC.`, 'ok');
		if (marketAgent?.id === agentId) {
			marketAgent.price = j.data.price;
			renderSalePanel(null, marketAgent);
		}
	} catch (err) {
		setSaleStatus(status, err.message || 'Save failed', 'err');
	}
}

async function clearAgentPrice(agentId) {
	const status = $('ad-sale-status');
	setSaleStatus(status, 'Clearing…');
	try {
		const r = await apiPostWithCsrf('/api/marketplace/asset-price', {
			item_type: 'agent',
			item_id: agentId,
			amount: 0,
			currency_mint: USDC_MAINNET_MINT,
			chain: 'solana',
			mint_decimals: 6,
		});
		if (!r.ok) {
			const j = await r.json().catch(() => ({}));
			throw new Error(j.error_description || j.error || 'Failed to clear price');
		}
		setSaleStatus(status, '✓ Agent is now free.', 'ok');
		if (marketAgent?.id === agentId) {
			marketAgent.price = null;
			renderSalePanel(null, marketAgent);
		}
	} catch (err) {
		setSaleStatus(status, err.message || 'Failed', 'err');
	}
}

// ── Per-skill pricing ─────────────────────────────────────────────────────────

function renderPricing(a) {
	const card = $('ad-pricing-card');
	const body = $('ad-pricing-body');
	if (!card || !body) return;

	const caps = a.capabilities || {};
	const skillsArr = Array.isArray(caps.skills) ? caps.skills : a.skills || [];
	const libraryArr = Array.isArray(caps.library) ? caps.library : [];
	const skillPrices = a.skill_prices || {};

	if (!skillsArr.length) { card.hidden = true; return; }
	card.hidden = false;

	// "From $X/call" summary when any skill is priced.
	const priced = Object.values(skillPrices).filter((p) => p && Number(p.amount) > 0);
	const summary = $('ad-pricing-summary');
	if (priced.length) {
		const minAmount = Math.min(...priced.map((p) => Number(p.amount)));
		const decimals = Number(priced[0]?.mint_decimals ?? 6);
		const minUsd = minAmount / Math.pow(10, decimals);
		const formatted = minUsd >= 1 ? minUsd.toFixed(2) : minUsd >= 0.01 ? minUsd.toFixed(3) : minUsd.toFixed(6).replace(/0+$/, '');
		summary.innerHTML = `<span class="ad-pricing-icon">$</span> ${priced.length} paid skill${priced.length === 1 ? '' : 's'} · from <strong>$${escapeHtml(formatted)}/call</strong>`;
		summary.hidden = false;
	} else {
		summary.hidden = true;
	}

	body.innerHTML = skillsArr
		.map((s) => {
			const name = typeof s === 'string' ? s : s.name || '';
			const price = skillPrices[name];
			let badge;
			if (purchasedSkills.has(name)) {
				badge = `<span class="ad-price-badge owned">✓ Owned</span>`;
			} else if (price && price.gate_type === 'nft') {
				// NFT-gated: access is holding the collection, not a purchase. The
				// viewer-owned case is already handled above (the API folds held
				// gates into purchased_skills); here they don't (yet) hold it.
				const mint = String(price.nft_collection_mint || '');
				const shortMint = mint.length > 14 ? `${mint.slice(0, 6)}…${mint.slice(-6)}` : mint;
				const collectionUrl = mint ? `https://solscan.io/token/${encodeURIComponent(mint)}` : '';
				badge =
					`<span class="ad-price-badge gated" title="Hold an NFT from this collection to unlock">🔒 Token Gated</span>` +
					(collectionUrl
						? `<a class="ad-skill-btn gated-collection" href="${escapeHtml(collectionUrl)}" target="_blank" rel="noopener noreferrer">Collection ${escapeHtml(shortMint)}</a>`
						: '');
			} else if (price && Number(price.amount) > 0) {
				const isPwyw = price.pricing_type === 'pwyw';
				const trialUses = price.trial_uses || 0;
				const trialBtn = trialUses > 0
					? `<button class="ad-skill-btn trial-btn" data-skill-name="${escapeHtml(name)}" data-agent-id="${escapeHtml(a.id)}">Try free (${trialUses} left)</button>`
					: '';
				// Time-pass renting is a fixed-price mechanism; PWYW lets the buyer
				// name the amount instead, so it never pairs with a time-pass button.
				const hasTimePass = !isPwyw && price.time_pass_hours && price.time_pass_amount;
				const timePassBtn = hasTimePass
					? (() => {
							const tpHuman = (Number(price.time_pass_amount) / 1e6).toFixed(2);
							return `<button class="ad-skill-btn time-pass-btn" data-skill-name="${escapeHtml(name)}" data-agent-id="${escapeHtml(a.id)}" data-duration="${price.time_pass_hours}">Get ${price.time_pass_hours}h (${tpHuman} USDC)</button>`;
						})()
					: '';
				let priceBadge;
				let purchaseLabel;
				if (isPwyw) {
					const minAtomics = price.minimum_amount != null ? Number(price.minimum_amount) : 0;
					priceBadge = minAtomics > 0
						? `<span class="ad-price-badge pwyw">Pay what you want · min ${(minAtomics / 1e6).toFixed(2)} USDC</span>`
						: `<span class="ad-price-badge pwyw">Pay what you want</span>`;
					purchaseLabel = 'Name your price';
				} else {
					priceBadge = `<span class="ad-price-badge paid">${(Number(price.amount) / 1e6).toFixed(2)} USDC</span>`;
					purchaseLabel = 'Purchase';
				}
				badge =
					priceBadge +
					`<button class="ad-skill-btn purchase-btn" data-skill-name="${escapeHtml(name)}" data-agent-id="${escapeHtml(a.id)}">${purchaseLabel}</button>` +
					trialBtn + timePassBtn;
			} else {
				badge = `<span class="ad-price-badge free">Free</span>`;
			}
			// Per-skill ratings & reviews — premium skills only (a review must anchor
			// to real access: a purchase or a held NFT gate). Mounts lazily on expand.
			const isPaid = !!(price && (Number(price.amount) > 0 || price.gate_type === 'nft'));
			let reviewsBlock = '';
			if (isPaid) {
				const safeName = escapeHtml(name);
				const panelId = `ad-skill-reviews-${cssId(name)}`;
				reviewsBlock =
					`<div class="ad-skill-row ad-skill-reviews-row">` +
						`<button type="button" class="ad-skill-reviews-toggle" aria-expanded="false" aria-controls="${panelId}" data-reviews-skill="${safeName}" data-reviews-agent="${escapeHtml(a.id)}">` +
							`<span class="ad-skill-reviews-caret" aria-hidden="true">▸</span> Ratings &amp; reviews` +
						`</button>` +
						`<div class="ad-skill-reviews-panel" id="${panelId}" hidden></div>` +
					`</div>`;
			}
			return `<div class="ad-skill-row"><span class="ad-skill-name">${escapeHtml(name)}</span><span class="ad-skill-actions">${badge}</span></div>${reviewsBlock}`;
		})
		.join('');

	bindReviewsDelegation(a);
	hydrateSkillPromos(a, body);

	const lib = $('ad-pricing-library');
	if (libraryArr.length) {
		lib.innerHTML =
			`<div class="ad-sub">LIBRARY</div>` +
			libraryArr
				.map((l) => `<span class="ad-chip">${escapeHtml(typeof l === 'string' ? l : l.name || '')}</span>`)
				.join(' ');
		lib.hidden = false;
	} else {
		lib.hidden = true;
	}
}

/**
 * Overlay live proof-phase promo state onto the rendered price badges.
 * Only fixed-price purchasable skills can carry a first-N rule; each gets one
 * briefly-CDN-cached GET, and rows without an active promo are left untouched.
 * The quote endpoint applies the same rules, so what's shown here is what the
 * checkout charges.
 */
async function hydrateSkillPromos(a, body) {
	const names = Object.entries(a.skill_prices || {})
		.filter(([, p]) => p && Number(p.amount) > 0 && p.pricing_type !== 'pwyw' && p.gate_type !== 'nft')
		.map(([n]) => n)
		.slice(0, 8);
	const cssEsc = (s) =>
		typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&');
	await Promise.all(
		names.map(async (name) => {
			try {
				const r = await fetch(
					`/api/marketplace/skill-promo?agent_id=${encodeURIComponent(a.id)}&skill=${encodeURIComponent(name)}`,
				);
				if (!r.ok) return;
				const { data } = await r.json();
				const promo = data?.promo;
				if (!promo) return;
				const btn = body.querySelector(`.purchase-btn[data-skill-name="${cssEsc(name)}"]`);
				const priceBadge = btn?.previousElementSibling;
				if (!priceBadge?.classList?.contains('ad-price-badge')) return;
				const promoAtomic = Number(promo.promo_amount);
				const listUsd = (Number(promo.list_amount) / 1e6).toFixed(2);
				priceBadge.textContent = '';
				const struck = document.createElement('s');
				struck.className = 'ad-price-list';
				struck.textContent = `${listUsd}`;
				priceBadge.append(struck, ` ${promoAtomic === 0 ? 'Free' : `${(promoAtomic / 1e6).toFixed(2)} USDC`}`);
				const pill = document.createElement('span');
				pill.className = 'ad-price-badge promo';
				pill.title = 'Proof-phase price for the first buyers while this skill earns its track record';
				pill.textContent = `First ${promo.threshold} · ${promo.spots_left} left`;
				priceBadge.after(pill);
			} catch {
				/* promo overlay is best-effort; the base price is already rendered */
			}
		}),
	);
}

let purchaseDelegationBound = false;
function bindPurchaseDelegation() {
	if (purchaseDelegationBound) return;
	purchaseDelegationBound = true;
	const body = $('ad-pricing-body');
	if (!body) return;
	body.addEventListener('click', (e) => {
		const target = e.target;
		const skillName = target.dataset?.skillName;
		const agentId = target.dataset?.agentId;
		if (!skillName || !agentId) return;
		if (target.classList.contains('purchase-btn')) {
			openPurchaseFlow(agentId, skillName).catch((err) => log.error('[agent-detail-market] purchase', err));
		} else if (target.classList.contains('trial-btn')) {
			openTrialFlow(agentId, skillName, target).catch((err) => log.error('[agent-detail-market] trial', err));
		} else if (target.classList.contains('time-pass-btn')) {
			const duration = Number(target.dataset.duration);
			if (duration) openTimePassFlow(agentId, skillName, duration, target).catch((err) => log.error('[agent-detail-market] time-pass', err));
		}
	});
}

// ── Per-skill reviews (lazy-mounted surface) ──────────────────────────────────

// Live review-surface handles keyed by skill name, so a purchase that completes
// while a panel is open can flip its compose form on without a full re-render.
const reviewHandles = new Map();
let reviewsDelegationBound = false;
let reviewsChromeInjected = false;

// One-time chrome for the per-skill reviews expander. The reviews surface itself
// injects its own `.skr-*` styles; this only styles the toggle row on this page.
function injectReviewsChrome() {
	if (reviewsChromeInjected || typeof document === 'undefined') return;
	reviewsChromeInjected = true;
	const el = document.createElement('style');
	el.id = 'ad-skill-reviews-chrome';
	el.textContent = `
.ad-skill-reviews-row{display:block;padding:0 0 6px}
.ad-skill-reviews-toggle{display:inline-flex;align-items:center;gap:6px;background:none;border:none;padding:4px 0;margin:0;color:var(--ad-muted,rgba(231,233,238,.55));font:inherit;font-size:12px;cursor:pointer;transition:color .12s ease}
.ad-skill-reviews-toggle:hover{color:var(--ad-text,#e7e9ee)}
.ad-skill-reviews-toggle:focus-visible{outline:2px solid var(--ad-cyan,#57c7ff);outline-offset:2px;border-radius:4px}
.ad-skill-reviews-caret{display:inline-block;font-size:10px;transition:transform .12s ease}
.ad-skill-reviews-toggle[aria-expanded="true"]{color:var(--ad-text,#e7e9ee)}
.ad-skill-reviews-panel:not([hidden]){display:block}`;
	document.head.appendChild(el);
}

function bindReviewsDelegation(agent) {
	injectReviewsChrome();
	if (reviewsDelegationBound) return;
	reviewsDelegationBound = true;
	const body = $('ad-pricing-body');
	if (!body) return;
	body.addEventListener('click', (e) => {
		const toggle = e.target.closest?.('.ad-skill-reviews-toggle');
		if (!toggle || !body.contains(toggle)) return;
		const skillName = toggle.dataset.reviewsSkill;
		const agentId = toggle.dataset.reviewsAgent || agent?.id;
		if (!skillName || !agentId) return;

		const panel = toggle.parentElement?.querySelector('.ad-skill-reviews-panel');
		if (!panel) return;
		const expanded = toggle.getAttribute('aria-expanded') === 'true';
		const caret = toggle.querySelector('.ad-skill-reviews-caret');

		if (expanded) {
			toggle.setAttribute('aria-expanded', 'false');
			if (caret) caret.textContent = '▸';
			panel.hidden = true;
			reviewHandles.get(skillName)?.destroy();
			reviewHandles.delete(skillName);
			panel.replaceChildren();
			return;
		}

		toggle.setAttribute('aria-expanded', 'true');
		if (caret) caret.textContent = '▾';
		panel.hidden = false;
		if (!reviewHandles.has(skillName)) {
			const handle = mountSkillReviews(panel, {
				agentId,
				skill: skillName,
				canReview: purchasedSkills.has(skillName),
				isOwner: !!(agent && agent.is_owner),
			});
			reviewHandles.set(skillName, handle);
		}
	});
}

// ── Subscription tiers ─────────────────────────────────────────────────────────

let marketTiers = [];
let subscribedPlanIds = new Set();

async function renderSubscriptionTiers(a) {
	const card = $('ad-tiers-card');
	const body = $('ad-tiers-body');
	const sub = $('ad-tiers-sub');
	if (!card || !body) return;

	let tiers = [];
	try {
		const r = await fetch(`${API}/agents/${encodeURIComponent(a.id)}/tiers`, { credentials: 'include' });
		if (r.ok) {
			const j = await r.json();
			tiers = Array.isArray(j.tiers) ? j.tiers : [];
		}
	} catch (e) {
		log.warn('[agent-detail-market] tiers fetch failed:', e.message);
	}

	if (!tiers.length) { card.hidden = true; return; }
	marketTiers = tiers;
	card.hidden = false;

	// Highlight tiers the signed-in user already subscribes to.
	subscribedPlanIds = await fetchActiveSubscriptionIds();

	if (sub) {
		sub.textContent = isOwner
			? 'Subscribers get access to all of this agent’s paid skills.'
			: 'Subscribe for full access to this agent’s paid skills.';
		sub.hidden = false;
	}

	body.innerHTML = tiers
		.map((t) => {
			const cycle = t.interval === 'weekly' ? 'week' : 'month';
			const price = Number(t.price_usd).toFixed(2);
			const perks = Array.isArray(t.perks) ? t.perks.filter(Boolean) : [];
			const perksHtml = perks.length
				? `<ul class="ad-tier-perks">${perks.map((p) => `<li>${escapeHtml(p)}</li>`).join('')}</ul>`
				: '';
			let action;
			if (isOwner) {
				action = `<span class="ad-tier-note">Your tier</span>`;
			} else if (subscribedPlanIds.has(t.id)) {
				action = `<span class="ad-price-badge owned">✓ Subscribed</span>`;
			} else {
				action = `<button class="ad-tier-btn ad-subscribe-btn" data-tier-id="${escapeHtml(t.id)}" data-agent-id="${escapeHtml(a.id)}">Subscribe</button>`;
			}
			return `
				<div class="ad-tier">
					<div class="ad-tier-head">
						<span class="ad-tier-name">${escapeHtml(t.name)}</span>
						<span class="ad-tier-price">$${escapeHtml(price)}<span class="ad-tier-cycle">/${cycle}</span></span>
					</div>
					${perksHtml}
					<div class="ad-tier-foot">${action}</div>
				</div>`;
		})
		.join('');

	bindTierDelegation();
}

// Active subscription plan_ids for the signed-in user (empty when anonymous).
async function fetchActiveSubscriptionIds() {
	try {
		const r = await fetch(`${API}/subscriptions/mine`, { credentials: 'include' });
		if (!r.ok) return new Set();
		const j = await r.json();
		return new Set(
			(j.subscriptions || []).filter((s) => s.status === 'active').map((s) => s.plan_id),
		);
	} catch {
		return new Set();
	}
}

let tierDelegationBound = false;
function bindTierDelegation() {
	if (tierDelegationBound) return;
	tierDelegationBound = true;
	const body = $('ad-tiers-body');
	if (!body) return;
	body.addEventListener('click', (e) => {
		const btn = e.target.closest?.('.ad-subscribe-btn');
		if (!btn) return;
		const tierId = btn.dataset.tierId;
		const agentId = btn.dataset.agentId;
		if (!tierId || !agentId) return;
		const tier = marketTiers.find((t) => t.id === tierId);
		if (!tier) return;
		openSubscribeFlow(agentId, tier).catch((err) => log.error('[agent-detail-market] subscribe', err));
	});
}

// ── Embed snippets ────────────────────────────────────────────────────────────

export function renderEmbed(a) {
	const card = $('ad-embed-card');
	if (!card) return;
	if (card.dataset.embedDisabled === '1') return; // policy: embedding turned off
	card.hidden = false;
	const agentId = a.id;
	const glbUrl = a.avatar_glb_url || '';
	const embedPageUrl = `${location.origin}/agents/${agentId}`;
	const iframeSrc = `/agent/${agentId}/embed`;

	const wcSnippet = glbUrl
		? `<script type="module" src="https://three.ws/dist-lib/agent-3d.js"><\/script>\n<agent-3d\n  src="${glbUrl}"\n  agent-id="${agentId}"\n  style="width:480px;height:480px"\n></agent-3d>`
		: `<!-- No 3D avatar attached yet -->`;
	const iframeSnippet = `<iframe\n  src="${iframeSrc}"\n  width="480"\n  height="640"\n  style="border:0;border-radius:14px"\n  allow="autoplay; xr-spatial-tracking"\n></iframe>`;

	$('ad-embed-wc').textContent = wcSnippet;
	$('ad-embed-iframe').textContent = iframeSnippet;
	$('ad-embed-link').textContent = embedPageUrl;

	card.querySelectorAll('.ad-embed-copy').forEach((btn) => {
		btn.onclick = async () => {
			const map = { wc: 'ad-embed-wc', iframe: 'ad-embed-iframe', link: 'ad-embed-link' };
			const src = $(map[btn.dataset.embed]);
			if (!src) return;
			try {
				await navigator.clipboard.writeText(src.textContent);
				btn.textContent = 'Copied ✓';
				btn.classList.add('copied');
				setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 1800);
			} catch (_) { /* clipboard unavailable */ }
		};
	});
}

// ── Similar agents ────────────────────────────────────────────────────────────

async function loadSimilar(agentId) {
	const card = $('ad-similar-card');
	const grid = $('ad-similar-grid');
	if (!card || !grid) return;
	try {
		const r = await fetch(`${API}/marketplace/agents/${agentId}/similar`, { credentials: 'include' });
		if (!r.ok) return;
		const j = await r.json();
		const items = j?.data?.agents || j?.data || [];
		if (!Array.isArray(items) || !items.length) return;
		card.hidden = false;
		grid.innerHTML = items
			.slice(0, 8)
			.map((a) => {
				const thumb = a.thumbnail_url
					? `<div class="ad-similar-thumb" style="background-image:url('${escapeHtml(a.thumbnail_url)}')"></div>`
					: `<div class="ad-similar-thumb">${escapeHtml(initial(a.name))}</div>`;
				return `<a class="ad-similar-item" href="/agents/${escapeHtml(a.id)}">
					${thumb}
					<div class="ad-similar-name">${escapeHtml(a.name || 'Untitled')}</div>
					<div class="ad-similar-meta">⊙ ${fmtNumber(a.views_count)} · ⑂ ${fmtNumber(a.forks_count)}</div>
				</a>`;
			})
			.join('');
	} catch (e) {
		log.warn('[agent-detail-market] similar failed:', e.message);
	}
}

// ── Version history ───────────────────────────────────────────────────────────

async function loadVersions(agentId) {
	const card = $('ad-versions-card');
	const list = $('ad-versions-list');
	if (!card || !list) return;
	try {
		const r = await fetch(`${API}/marketplace/agents/${agentId}/versions`, { credentials: 'include' });
		if (!r.ok) return;
		const j = await r.json();
		const versions = j?.data?.versions || j?.data || [];
		if (!Array.isArray(versions) || !versions.length) return;
		card.hidden = false;
		list.innerHTML = versions
			.map(
				(v) => `<li class="ad-version-row">
					<span class="ad-version-tag">v${escapeHtml(String(v.version ?? '?'))}</span>
					<span class="ad-version-log">${escapeHtml(v.changelog || '(no changelog)')}</span>
					<span class="ad-version-when">${escapeHtml(formatDate(v.created_at))}</span>
				</li>`,
			)
			.join('');
	} catch (e) {
		log.warn('[agent-detail-market] versions failed:', e.message);
	}
}
