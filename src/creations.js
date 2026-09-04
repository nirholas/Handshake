/**
 * /creations — the creator marketplace gallery (roadmap prompt 09): search,
 * filter, sort, and live-preview the remix bazaar; view trending assets and a
 * top-creators leaderboard; remix any card for real, on-chain USDC; inspect a
 * remix's parent → child lineage; publish a finished creation into the gallery.
 *
 * Data flow (all real, no mocks):
 *   GET  /api/remix-feed                         → paginated bazaar (recent)
 *   GET  /api/remix-feed?sort=remixed|royalty     → fixed top-N leaderboard slice
 *   GET  /api/remix-feed?category=&q=             → server-side filter
 *   GET  /api/remix-feed?action=trending          → most-remixed assets
 *   GET  /api/remix-feed?action=lineage&root=<id> → parent → child chain
 *   POST /api/remix-feed  { action:'publish', ... } → opt a creation in
 *   POST /api/x402/remix-asset (via window.X402.pay) → paid remix + royalty
 *   GET  /api/creations-leaderboard               → top creators (real agent identity)
 */

import { createLogger } from './shared/log.js';
import { proxiedModelURL } from './ipfs.js';
import { enterStagger, liveDot, setLiveDot } from './ui-juice.js';
import { ensureX402 } from './shared/x402-loader.js';

const log = createLogger('creations');

const PAGE_SIZE = 24;
const CLIENT_HEADERS = (() => {
	try {
		const id = localStorage.getItem('forge:cid');
		return id ? { 'x-forge-client': id } : {};
	} catch {
		return {};
	}
})();

const state = {
	sort: 'recent',
	category: '',
	q: '',
	cursor: null,
	hasMore: false,
	loading: false,
	items: [],
};

const $ = (id) => document.getElementById(id);
const esc = (s) =>
	String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function timeAgo(iso) {
	const t = new Date(iso).getTime();
	if (!Number.isFinite(t)) return '';
	const s = Math.max(0, Math.round((Date.now() - t) / 1000));
	if (s < 60) return 'just now';
	const m = Math.round(s / 60);
	if (m < 60) return `${m}m ago`;
	const h = Math.round(m / 60);
	if (h < 24) return `${h}h ago`;
	const d = Math.round(h / 24);
	if (d < 30) return `${d}d ago`;
	const mo = Math.round(d / 30);
	if (mo < 12) return `${mo}mo ago`;
	return `${Math.round(mo / 12)}y ago`;
}

function truncate(s, n) {
	const t = String(s || '');
	return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

// ── card rendering ───────────────────────────────────────────────────────────

// A gallery thumbnail is deliberately control-free. model-viewer reads
// `camera-controls` as a boolean attribute, so the old `camera-controls="false"`
// switched controls ON: every card drag-orbited (and stayed wherever it was
// flung), and on touch the mesh swallowed the vertical drag that scrolls the
// grid, so the feed could not be scrolled past the first row. Dropping the
// attribute leaves auto-rotate, which needs no controls, and lets a drag over a
// leaderboard row reach the link that wraps it. The `disable-*` attributes went
// with it; they only ever qualified camera-controls.
function thumbHTML(glbUrl, alt, posterUrl) {
	// The asset bucket allowlists the production origin by name, so a GLB read
	// straight from it dies inside model-viewer on every other origin (partner
	// embeds, notebooks, previews, local audits) with an unrecoverable "Failed
	// to fetch". /api/glb serves the same public object with open CORS.
	const src = proxiedModelURL(glbUrl);
	if (!src) return `<div class="cr-card-noglb" aria-hidden="true">3D</div>`;
	// The feed ships a rendered still alongside every GLB, so paint that first
	// and let the interactive mesh swap in once it has streamed.
	const poster = posterUrl ? ` poster="${esc(posterUrl)}"` : '';
	return `<model-viewer
			src="${esc(src)}"
			alt="${esc(alt)}"${poster}
			class="cr-card-mv"
			reveal="auto"
			loading="lazy"
			interaction-prompt="none"
			auto-rotate
			rotation-per-second="16deg"
			environment-image="neutral"
			shadow-intensity="0"
			exposure="1"
		></model-viewer>`;
}

function cardHTML(item) {
	const promptText = item.prompt ? truncate(item.prompt, 110) : 'A remixable 3D creation';
	const royaltyChip = item.royaltyPercent > 0
		? `<span class="cr-chip ${item.royaltyPayable ? 'cr-chip--payable' : 'cr-chip--unpayable'}" title="${item.royaltyPayable ? 'This creator has a payout wallet set' : 'No payout wallet set yet — royalty won’t route'}">${item.royaltyPercent}% royalty${item.royaltyPayable ? '' : ' · no wallet'}</span>`
		: `<span class="cr-chip">no royalty</span>`;
	const remixChip = item.remixCount > 0 ? `<span class="cr-chip" title="Creations derived from this one">${item.remixCount} remix${item.remixCount === 1 ? '' : 'es'}</span>` : '';
	const categoryChip = `<span class="cr-chip cr-chip--cat">${esc(item.category || 'other')}</span>`;
	return `
		<article class="cr-card" data-id="${esc(item.id)}">
			<div class="cr-card-thumb">
				${item.isDerived ? '<span class="cr-card-derived" title="This is itself a remix">remix</span>' : ''}
				${thumbHTML(item.glbUrl, promptText, item.previewImageUrl)}
			</div>
			<div class="cr-card-body">
				<p class="cr-card-prompt" title="${esc(item.prompt || '')}">${esc(promptText)}</p>
				<div class="cr-card-meta">${categoryChip}${royaltyChip}${remixChip}</div>
				<div class="cr-card-actions">
					<a class="cr-card-btn" href="/m/${esc(item.id)}" title="Open the model page: stats, comments, likes">Details</a>
					${item.viewerUrl ? `<a class="cr-card-btn" href="${esc(item.viewerUrl)}" target="_blank" rel="noopener noreferrer">View</a>` : ''}
					<button class="cr-card-btn" type="button" data-lineage="${esc(item.id)}" aria-controls="cr-lineage-panel">Lineage</button>
					${item.prompt ? `<button class="cr-card-btn" type="button" data-copy-prompt="${esc(item.id)}" title="Copy the prompt that generated this model">Copy prompt</button>` : ''}
					<a class="cr-card-btn" href="/materialize?creation=${esc(item.id)}" title="Order this creation as a real physical print, shipped to you">Materialize</a>
					<button class="cr-card-btn cr-card-btn--remix" type="button" data-remix-open="${esc(item.id)}">Remix — $0.25</button>
					<span class="cr-time">${esc(timeAgo(item.createdAt))}</span>
				</div>
				<div class="cr-remix-inline" data-remix-inline="${esc(item.id)}">
					<input type="text" class="cr-remix-input" aria-label="Describe the change this remix should make" placeholder='Describe the change, e.g. "make it metallic"' maxlength="500" />
					<button class="cr-card-btn cr-card-btn--remix" type="button" data-remix-pay="${esc(item.id)}">Pay &amp; remix</button>
					<div class="cr-remix-status" role="status" aria-live="polite"></div>
				</div>
			</div>
		</article>
	`;
}

function skeleton() {
	return Array.from({ length: 8 })
		.map(() => `<div class="cr-skeleton"></div>`)
		.join('');
}

function emptyStateHTML() {
	const hasFilters = Boolean(state.q || state.category || state.sort !== 'recent');
	if (hasFilters) {
		return (
			`<div class="cr-empty"><div class="cr-empty-title">Nothing matches those filters</div>` +
			`<p class="cr-empty-sub">Try a broader search, a different category, or <button type="button" class="cr-retry" id="cr-clear-filters">clear filters</button>.</p></div>`
		);
	}
	return (
		`<div class="cr-empty"><div class="cr-empty-title">No creations published to the bazaar yet</div>` +
		`<p class="cr-empty-sub">Generate a model at <a href="/forge">/forge</a>, then publish it below to be the first entry ` +
		`in the gallery. <a href="#cr-publish">Publish a creation →</a></p></div>`
	);
}

function renderFeed(append) {
	const host = $('cr-feed');
	if (!host) return;
	if (!state.items.length) {
		host.setAttribute('aria-busy', 'false');
		host.innerHTML = emptyStateHTML();
		$('cr-clear-filters')?.addEventListener('click', clearFilters);
		return;
	}
	host.setAttribute('aria-busy', 'false');
	if (!append) {
		host.innerHTML = state.items.map(cardHTML).join('');
		enterStagger([...host.children], { step: 24 });
	} else {
		const startIdx = host.children.length;
		const added = state.items.slice(startIdx).map(cardHTML).join('');
		host.insertAdjacentHTML('beforeend', added);
		enterStagger([...host.children].slice(startIdx), { step: 24 });
	}
}

function updateCount() {
	const el = $('cr-count');
	if (!el) return;
	const suffix = state.sort !== 'recent' ? ' · top slice' : state.hasMore ? ' · more available' : '';
	el.textContent = state.items.length ? `${state.items.length} shown${suffix}` : '';
}

function setFeedLive(kind) {
	const head = document.querySelector('.cr-feed-head .cr-count');
	if (!head) return;
	if (!head.previousElementSibling?.classList?.contains('juice-live')) {
		head.insertAdjacentHTML('beforebegin', liveDot(kind));
	} else {
		setLiveDot(head.previousElementSibling, kind, kind);
	}
}

// ── feed loading ─────────────────────────────────────────────────────────────

let inflight = null;

async function loadFeed({ reset = false } = {}) {
	// A sort or filter change supersedes whatever is in flight: the controls
	// already show the new selection, so dropping the reload (or queueing it
	// behind a slow response) would leave the feed showing the wrong slice
	// under the wrong tab. Pagination, by contrast, never stacks pages.
	if (reset) inflight?.abort();
	else if (state.loading) return;
	const ctrl = new AbortController();
	inflight = ctrl;
	state.loading = true;
	if (reset) {
		state.cursor = null;
		state.items = [];
	}
	const host = $('cr-feed');
	if (reset && host) {
		host.setAttribute('aria-busy', 'true');
		host.innerHTML = skeleton();
		// The old tally belongs to the slice being replaced; leaving it up next
		// to a grid of skeletons reads as a count of the skeletons.
		updateCount();
		// The open lineage belongs to a card that this reload may drop.
		$('cr-lineage-panel')?.classList.add('is-hidden');
	}
	setFeedLive('connecting');
	try {
		const params = new URLSearchParams({ limit: String(PAGE_SIZE), sort: state.sort });
		if (state.category) params.set('category', state.category);
		if (state.q) params.set('q', state.q);
		if (state.cursor && !reset) params.set('before', state.cursor);
		const res = await fetch(`/api/remix-feed?${params}`, { headers: { accept: 'application/json' }, signal: ctrl.signal });
		const data = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(data?.message || `feed returned ${res.status}`);
		if (!data.enabled) {
			setFeedLive('error');
			updateCount();
			if (host) {
				host.setAttribute('aria-busy', 'false');
				host.innerHTML =
					`<div class="cr-error"><div class="cr-empty-title">The remix bazaar is temporarily unavailable</div>` +
					`<p>Nothing is lost. Published creations reappear as soon as it is back. ` +
					`<button type="button" class="cr-retry" id="cr-retry">Retry</button></p></div>`;
				$('cr-retry')?.addEventListener('click', () => loadFeed({ reset: true }));
			}
			return;
		}
		const incoming = Array.isArray(data.items) ? data.items : [];
		state.items = reset ? incoming : [...state.items, ...incoming];
		state.cursor = data.next || null;
		state.hasMore = Boolean(data.next);
		renderFeed(!reset);
		updateCount();
		setFeedLive(state.items.length ? 'live' : 'idle');
	} catch (err) {
		// Superseded by a newer request: the replacement owns the UI now.
		if (ctrl.signal.aborted) return;
		log.warn('feed failed', err?.message);
		setFeedLive('error');
		updateCount();
		if (reset && host) {
			host.setAttribute('aria-busy', 'false');
			host.innerHTML =
				`<div class="cr-error"><div class="cr-empty-title">Couldn’t reach the creator gallery</div>` +
				`<p>${esc(err?.message || 'Reconnecting…')} <button type="button" class="cr-retry" id="cr-retry">Retry</button></p></div>`;
			$('cr-retry')?.addEventListener('click', () => loadFeed({ reset: true }));
		}
	} finally {
		if (inflight === ctrl) {
			inflight = null;
			state.loading = false;
			renderLoadMoreSentinel();
		}
	}
}

let observer = null;
function renderLoadMoreSentinel() {
	const footer = $('cr-footer-state');
	if (!footer) return;
	const canPaginate = state.sort === 'recent' && state.hasMore;
	footer.textContent = canPaginate ? '' : state.items.length ? (state.sort === 'recent' ? 'End of the gallery.' : 'Top of the leaderboard — switch to “New” to browse everything.') : '';
	if (!canPaginate) {
		observer?.disconnect();
		return;
	}
	if (!observer && 'IntersectionObserver' in window) {
		observer = new IntersectionObserver(
			(entries) => {
				if (entries[0].isIntersecting && !state.loading && state.hasMore) loadFeed({});
			},
			{ rootMargin: '0px 0px 320px 0px' },
		);
	}
	observer?.observe(footer);
}

function clearFilters() {
	state.q = '';
	state.category = '';
	$('cr-q').value = '';
	$('cr-category').value = '';
	// Reload unconditionally: the empty state that offers this button is
	// reachable while the sort is already "recent", and an early-returning
	// setSort would leave the button doing nothing at all.
	syncSortButtons('recent');
	state.sort = 'recent';
	loadFeed({ reset: true });
	$('cr-q').focus();
}

// ── controls ────────────────────────────────────────────────────────────────

function syncSortButtons(sort) {
	for (const btn of document.querySelectorAll('[data-sort]')) {
		const on = btn.dataset.sort === sort;
		btn.classList.toggle('active', on);
		btn.setAttribute('aria-selected', String(on));
		btn.tabIndex = on ? 0 : -1;
	}
}

function setSort(sort) {
	if (sort === state.sort) return;
	state.sort = sort;
	syncSortButtons(sort);
	loadFeed({ reset: true });
}

function debounce(fn, ms) {
	let t;
	return (...args) => {
		clearTimeout(t);
		t = setTimeout(() => fn(...args), ms);
	};
}

function wireControls() {
	const sortBtns = [...document.querySelectorAll('[data-sort]')];
	for (const [i, btn] of sortBtns.entries()) {
		btn.addEventListener('click', () => setSort(btn.dataset.sort));
		// A role="tablist" is expected to move between its tabs with the arrow
		// keys, with only the selected tab in the page's tab order.
		btn.addEventListener('keydown', (e) => {
			const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : e.key === 'Home' ? -i : e.key === 'End' ? sortBtns.length - 1 - i : 0;
			if (!step) return;
			e.preventDefault();
			const next = sortBtns[(i + step + sortBtns.length) % sortBtns.length];
			next.focus();
			setSort(next.dataset.sort);
		});
	}
	const qInput = $('cr-q');
	const onSearch = debounce(() => {
		state.q = qInput.value.trim();
		loadFeed({ reset: true });
	}, 350);
	qInput?.addEventListener('input', onSearch);
	$('cr-category')?.addEventListener('change', (e) => {
		state.category = e.target.value;
		loadFeed({ reset: true });
	});
}

// ── remix (real x402 payment) ───────────────────────────────────────────────

function cssEscape(s) {
	return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&');
}

function wireRemixActions() {
	$('cr-feed')?.addEventListener('click', async (e) => {
		const lineageId = e.target.closest('[data-lineage]')?.dataset.lineage;
		if (lineageId) return openLineage(lineageId);

		const copyBtn = e.target.closest('[data-copy-prompt]');
		if (copyBtn) {
			const item = state.items.find((it) => it.id === copyBtn.dataset.copyPrompt);
			if (!item?.prompt) return;
			try {
				await navigator.clipboard.writeText(item.prompt);
				const prev = copyBtn.textContent;
				copyBtn.textContent = 'Copied!';
				copyBtn.disabled = true;
				setTimeout(() => {
					copyBtn.textContent = prev;
					copyBtn.disabled = false;
				}, 1200);
			} catch {
				// Clipboard blocked (permissions/insecure context): hand the visitor
				// the composer instead so the action still lands somewhere real.
				window.open(`/create/prompt?prompt=${encodeURIComponent(item.prompt)}`, '_blank', 'noopener');
			}
			return;
		}

		const openId = e.target.closest('[data-remix-open]')?.dataset.remixOpen;
		if (openId) {
			const inline = document.querySelector(`[data-remix-inline="${cssEscape(openId)}"]`);
			inline?.classList.toggle('is-open');
			if (inline?.classList.contains('is-open')) inline.querySelector('input')?.focus();
			return;
		}
		const payId = e.target.closest('[data-remix-pay]')?.dataset.remixPay;
		if (payId) return remixOne(payId, e.target.closest('.cr-card'));
	});
}

async function remixOne(sourceId, cardEl) {
	const inline = cardEl?.querySelector('[data-remix-inline]');
	const input = inline?.querySelector('.cr-remix-input');
	const statusEl = inline?.querySelector('.cr-remix-status');
	const payBtn = cardEl?.querySelector(`[data-remix-pay="${cssEscape(sourceId)}"]`);
	const instruction = input?.value.trim();
	if (!instruction) {
		if (statusEl) statusEl.textContent = 'Describe the change first.';
		return;
	}
	if (payBtn) payBtn.disabled = true;
	if (statusEl) {
		statusEl.textContent = 'Opening payment…';
		statusEl.dataset.kind = 'busy';
	}
	try {
		const X402 = await ensureX402();
		const out = await X402.pay({
			endpoint: '/api/x402/remix-asset',
			method: 'POST',
			body: { source_creation_id: sourceId, instruction },
			merchant: 'three.ws Remix Bazaar',
			action: `Remix this model — $0.25 USDC (a royalty routes to its creator)`,
		});
		const remix = out?.result?.remix;
		const royalty = out?.result?.royalty;
		if (statusEl) {
			statusEl.dataset.kind = 'done';
			statusEl.innerHTML = remix?.viewerUrl
				? `Remixed! <a href="${esc(remix.viewerUrl)}" target="_blank" rel="noopener noreferrer">View your new model →</a>` +
					(royalty?.paid ? ` · $${royalty.creatorUsd} routed to the original creator.` : '')
				: 'Remix submitted.';
		}
		if (input) input.value = '';
	} catch (err) {
		if (statusEl) {
			statusEl.dataset.kind = 'error';
			statusEl.textContent = err?.message || 'Remix failed. Try again.';
		}
	} finally {
		if (payBtn) payBtn.disabled = false;
	}
}

// ── lineage ──────────────────────────────────────────────────────────────────

async function openLineage(rootId) {
	const panel = $('cr-lineage-panel');
	const chain = $('cr-lineage-chain');
	if (!panel || !chain) return;
	panel.classList.remove('is-hidden');
	panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
	chain.innerHTML = `<li class="cr-lineage-item"><span class="cr-lineage-body">Loading lineage…</span></li>`;
	try {
		const res = await fetch(`/api/remix-feed?action=lineage&root=${encodeURIComponent(rootId)}`, {
			headers: { accept: 'application/json' },
		});
		const data = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(data?.message || `lineage returned ${res.status}`);
		// The API always includes the root creation itself as the first row (the
		// base case of its recursive walk) — only rows AFTER it are actual
		// remixes/refinements, so a root-only result means no remixes yet.
		const full = Array.isArray(data.lineage) ? data.lineage : [];
		const lineage = full.filter((node) => node.id !== rootId);
		if (!lineage.length) {
			chain.innerHTML = `<li class="cr-lineage-item"><span class="cr-lineage-body">No remixes yet — be the first to build on this one.</span></li>`;
			return;
		}
		chain.innerHTML = lineage
			.map(
				(node, i) => `
				<li class="cr-lineage-item">
					<span class="cr-lineage-idx">${i + 1}</span>
					<span class="cr-lineage-body">
						<span class="cr-lineage-instruction">${esc(node.instruction || node.prompt || 'Remix')}</span>
						<span class="cr-lineage-prompt">${esc(truncate(node.prompt || '', 80))}</span>
					</span>
					${node.viewerUrl ? `<a class="cr-lineage-view" href="${esc(node.viewerUrl)}" target="_blank" rel="noopener noreferrer">View →</a>` : ''}
				</li>
			`,
			)
			.join('');
	} catch (err) {
		chain.innerHTML = `<li class="cr-lineage-item"><span class="cr-lineage-body">${esc(err?.message || 'Could not load lineage.')}</span></li>`;
	}
}

// ── leaderboards ─────────────────────────────────────────────────────────────

function trendingRowHTML(item, i) {
	return `
		<li>
			<a class="cr-lb-row" href="${esc(item.viewerUrl)}" target="_blank" rel="noopener noreferrer">
				<span class="cr-lb-rank">${i + 1}</span>
				<span class="cr-lb-thumb">${thumbHTML(item.glbUrl, item.prompt || 'creation', item.previewImageUrl)}</span>
				<span class="cr-lb-body">
					<span class="cr-lb-title">${esc(truncate(item.prompt || 'A 3D creation', 48))}</span>
					<span class="cr-lb-meta">${esc(item.category || 'other')}${item.remixable ? '' : ' · no longer remixable'}</span>
				</span>
				<span class="cr-lb-stat">${item.remixCount} remix${item.remixCount === 1 ? '' : 'es'}</span>
			</a>
		</li>
	`;
}

function creatorRowHTML(row, i) {
	const initials = (row.agent?.name || 'A').trim().slice(0, 2).toUpperCase();
	return `
		<li>
			<a class="cr-lb-row" href="${esc(row.agent?.url || '/agents')}">
				<span class="cr-lb-rank">${i + 1}</span>
				<span class="cr-lb-avatar" aria-hidden="true">${esc(initials)}</span>
				<span class="cr-lb-body">
					<span class="cr-lb-title">${esc(row.agent?.name || 'Agent')}</span>
					<span class="cr-lb-meta">${row.mintedCount} minted · ${row.remixCount} remix${row.remixCount === 1 ? '' : 'es'}</span>
				</span>
				<span class="cr-lb-stat">$${row.royaltyEarnedUsd.toFixed(2)}</span>
			</a>
		</li>
	`;
}

function lbSkeleton(rows) {
	return Array.from({ length: rows })
		.map(() => `<li class="cr-lb-skeleton" aria-hidden="true"></li>`)
		.join('');
}

async function loadLeaderboards() {
	const trendingHost = $('cr-trending-list');
	const creatorsHost = $('cr-creators-list');
	// Both columns start as empty <ol aria-busy>, which paints a 54px void for
	// the length of the fetch. Fill them with the same skeleton language the
	// feed uses so the page reads as loading rather than as already empty.
	if (trendingHost) trendingHost.innerHTML = lbSkeleton(4);
	if (creatorsHost) creatorsHost.innerHTML = lbSkeleton(4);
	try {
		const res = await fetch('/api/creations-leaderboard?limit=6', { headers: { accept: 'application/json' } });
		const data = await res.json().catch(() => ({}));
		if (!res.ok || !data.enabled) throw new Error('leaderboard unavailable');

		if (trendingHost) {
			trendingHost.setAttribute('aria-busy', 'false');
			const assets = Array.isArray(data.topRemixedAssets) ? data.topRemixedAssets : [];
			trendingHost.innerHTML = assets.length
				? assets.map(trendingRowHTML).join('')
				: `<li class="cr-lb-empty">No remixes yet — <a href="#cr-feed">be the first to remix something</a>.</li>`;
		}
		if (creatorsHost) {
			creatorsHost.setAttribute('aria-busy', 'false');
			const creators = Array.isArray(data.topCreators) ? data.topCreators : [];
			creatorsHost.innerHTML = creators.length
				? creators.map(creatorRowHTML).join('')
				: `<li class="cr-lb-empty">No creator has been remixed yet — <a href="/agent-identities">mint a 3D asset</a> to appear here.</li>`;
		}
	} catch (err) {
		log.warn('leaderboards failed', err?.message);
		if (trendingHost) {
			trendingHost.setAttribute('aria-busy', 'false');
			trendingHost.innerHTML = `<li class="cr-lb-empty">Leaderboard temporarily unavailable.</li>`;
		}
		if (creatorsHost) {
			creatorsHost.setAttribute('aria-busy', 'false');
			creatorsHost.innerHTML = `<li class="cr-lb-empty">Leaderboard temporarily unavailable.</li>`;
		}
	}
}

// ── publish ──────────────────────────────────────────────────────────────────

function wirePublishForm() {
	const form = $('cr-publish-form');
	if (!form) return;
	const licenseSel = $('cr-pub-license');
	const royaltyRow = $('cr-pub-royalty-row');
	const royaltyInput = $('cr-pub-royalty');
	const royaltyOut = $('cr-pub-royalty-out');
	const statusEl = $('cr-pub-status');
	const submitBtn = $('cr-pub-submit');

	royaltyInput.addEventListener('input', () => {
		royaltyOut.textContent = `${royaltyInput.value}%`;
	});
	licenseSel.addEventListener('change', () => {
		royaltyRow.hidden = licenseSel.value === 'all-rights';
	});

	form.addEventListener('submit', async (e) => {
		e.preventDefault();
		const idInput = $('cr-pub-id');
		const creationId = idInput.value.trim();
		if (!creationId) {
			statusEl.dataset.kind = 'error';
			statusEl.textContent = 'Paste the creation id from your Forge result first.';
			idInput.focus();
			return;
		}
		const wallet = $('cr-pub-wallet').value.trim();
		const license = licenseSel.value;
		const royaltyBps = Math.round(Number(royaltyInput.value || 0) * 100);
		submitBtn.disabled = true;
		statusEl.textContent = 'Publishing…';
		statusEl.dataset.kind = 'busy';
		try {
			const res = await fetch('/api/remix-feed', {
				method: 'POST',
				headers: { 'content-type': 'application/json', ...CLIENT_HEADERS },
				body: JSON.stringify({
					action: 'publish',
					creation_id: creationId,
					license,
					royalty_bps: license === 'all-rights' ? 0 : royaltyBps,
					...(wallet ? { creator_wallet: wallet } : {}),
				}),
			});
			const data = await res.json().catch(() => ({}));
			if (!res.ok || !data?.published) {
				statusEl.dataset.kind = 'error';
				statusEl.textContent = data?.error || 'Could not publish that creation — check the id and try again.';
				submitBtn.disabled = false;
				return;
			}
			const p = data.published;
			statusEl.dataset.kind = 'done';
			// The gallery reloads below, so the entry is already on screen.
			statusEl.textContent = p.remixable
				? p.royaltyPayable
					? `Published to the gallery, remixable at ${p.royaltyPercent}% royalty.`
					: `Published to the gallery, remixable at ${p.royaltyPercent}% royalty, but add a payout wallet above to actually collect it.`
				: 'Published to the gallery, display only, not remixable.';
			form.reset();
			royaltyOut.textContent = `${royaltyInput.value}%`;
			royaltyRow.hidden = licenseSel.value === 'all-rights';
			loadFeed({ reset: true });
			loadLeaderboards();
		} catch (err) {
			statusEl.dataset.kind = 'error';
			statusEl.textContent = err?.message || 'Publishing failed. Check your connection and try again.';
		} finally {
			submitBtn.disabled = false;
		}
	});
}

// ── init ─────────────────────────────────────────────────────────────────────

function init() {
	wireControls();
	wireRemixActions();
	wirePublishForm();
	$('cr-lineage-close')?.addEventListener('click', () => $('cr-lineage-panel')?.classList.add('is-hidden'));
	loadFeed({ reset: true });
	loadLeaderboards();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
