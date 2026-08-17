/**
 * My Collection page controller: fetches the caller's purchases and
 * subscriptions, drives the loading / empty / error / populated states, and
 * owns the tablist. The card markup lives in collection-render.js.
 */

import { wireWalletChips } from './shared/agent-wallet-chip.js';
import { skillCard, subCard, skeletonGrid, emptyState } from './collection-render.js';

function els() {
	return {
		authWall: document.getElementById('col-auth-wall'),
		errorEl: document.getElementById('col-error'),
		colMain: document.getElementById('col-main'),
		colStats: document.getElementById('col-stats'),
		skillsGrid: document.getElementById('skills-grid'),
		subsGrid: document.getElementById('subs-grid'),
	};
}

// Render a retryable load error into the shared error element and clear the
// loading skeletons so they never linger. Wires a Retry button to re-run load().
function renderLoadError(detail) {
	const { errorEl, colMain, colStats, skillsGrid, subsGrid } = els();
	errorEl.innerHTML = '';
	const msg = document.createElement('span');
	msg.textContent = detail
		? `Couldn't load your collection: ${detail}.`
		: 'Failed to load your collection. Please try again.';
	const retry = document.createElement('button');
	retry.type = 'button';
	retry.className = 'col-retry-btn';
	retry.textContent = 'Retry';
	retry.addEventListener('click', () => { load(); });
	errorEl.append(msg, retry);
	errorEl.hidden = false;
	skillsGrid.innerHTML = '';
	subsGrid.innerHTML = '';
	// Nothing loaded, so the tabs and the stats bar would be empty chrome around
	// the error. Collapse them and let the alert own the page.
	colMain.hidden = true;
	colStats.hidden = true;
}

async function load() {
	const { authWall, errorEl, colMain, colStats, skillsGrid, subsGrid } = els();

	// Loading state: the tabs and the skeleton grid are visible from the first
	// frame. Keeping col-main hidden until the fetch resolved meant the skeletons
	// rendered into a hidden container and the loading state was unreachable.
	errorEl.hidden = true;
	authWall.hidden = true;
	colMain.hidden = false;
	skillsGrid.innerHTML = skeletonGrid(6);
	subsGrid.innerHTML = skeletonGrid(3);

	let skillsRes, subsRes;
	try {
		[skillsRes, subsRes] = await Promise.all([
			fetch('/api/users/me/purchased-skills', { credentials: 'include' }),
			fetch('/api/subscriptions/mine', { credentials: 'include' }),
		]);
	} catch (err) {
		// Network-level failure (offline, DNS, aborted): without this the awaited
		// Promise.all rejects and the skeletons render forever. Surface a retryable
		// error instead.
		renderLoadError(err?.message);
		return;
	}

	if (skillsRes.status === 401 || subsRes.status === 401) {
		authWall.hidden = false;
		colMain.hidden = true;
		colStats.hidden = true;
		skillsGrid.innerHTML = '';
		subsGrid.innerHTML = '';
		return;
	}

	if (!skillsRes.ok || !subsRes.ok) {
		const bad = !skillsRes.ok ? skillsRes : subsRes;
		renderLoadError(`the server returned ${bad.status}`);
		return;
	}

	let skillsData, subsData;
	try {
		({ data: skillsData } = await skillsRes.json());
		({ subscriptions: subsData } = await subsRes.json());
	} catch (err) {
		renderLoadError(err?.message);
		return;
	}

	const purchases = Array.isArray(skillsData?.purchases) ? skillsData.purchases : [];
	const subs = Array.isArray(subsData) ? subsData : [];
	const nftCount = purchases.filter(p => p.skill_nft_mint).length;
	const now = Date.now();
	const activeSubs = subs.filter(s =>
		s.status === 'active' && (!s.current_period_end || new Date(s.current_period_end) > now)
	).length;

	// Update stats
	document.getElementById('stat-skills').textContent = purchases.length;
	document.getElementById('stat-subs').textContent = activeSubs;
	document.getElementById('stat-nfts').textContent = nftCount;

	colStats.hidden = false;
	colMain.hidden = false;

	skillsGrid.innerHTML = purchases.length
		? purchases.map(skillCard).join('')
		: emptyState('skills');

	// Wire the publishing agents' wallet chips (copy + ◎ Tip) on the freshly
	// rendered skill cards. No-op for purchases without a wallet address.
	wireWalletChips(skillsGrid);

	subsGrid.innerHTML = subs.length
		? subs.map(subCard).join('')
		: emptyState('subscriptions');

	// Counts live in their own span so the runtime i18n pass, which rewrites the
	// sibling [data-i18n] label's textContent whenever the catalog lands, cannot
	// race the count away.
	setTabCount('skills', purchases.length);
	setTabCount('subscriptions', subs.length);
}

function setTabCount(panel, n) {
	const el = document.querySelector(`.col-tab[data-panel="${panel}"] .col-tab-count`);
	if (el) el.textContent = `(${n})`;
}

// Tab switching: a WAI-ARIA tablist with roving tabindex, so Arrow/Home/End move
// between tabs and Tab itself lands on the selected panel.
const tabs = [...document.querySelectorAll('.col-tab')];

function selectTab(tab, { focus = false } = {}) {
	for (const t of tabs) {
		const on = t === tab;
		t.classList.toggle('active', on);
		t.setAttribute('aria-selected', String(on));
		t.tabIndex = on ? 0 : -1;
		const panel = document.getElementById(`panel-${t.dataset.panel}`);
		if (!panel) continue;
		panel.classList.toggle('active', on);
		panel.hidden = !on;
	}
	if (focus) tab.focus();
}

tabs.forEach((tab, i) => {
	tab.addEventListener('click', () => selectTab(tab));
	tab.addEventListener('keydown', (e) => {
		const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
		if (step) {
			e.preventDefault();
			selectTab(tabs[(i + step + tabs.length) % tabs.length], { focus: true });
			return;
		}
		if (e.key === 'Home') {
			e.preventDefault();
			selectTab(tabs[0], { focus: true });
		} else if (e.key === 'End') {
			e.preventDefault();
			selectTab(tabs[tabs.length - 1], { focus: true });
		}
	});
});

load();
