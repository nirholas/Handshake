// Dedicated notification-center page (pages/notifications.html) — the full
// history view the nav bell dropdown (src/notifications.js) can't hold. Reuses
// the dropdown's icon/label/link/escaping helpers so the two surfaces always
// read identically; adds category tabs, delete, and cursor pagination for the
// "hundreds of items" overflow case the dropdown never has to handle.

import { TYPE_ICON, notifLabel, notifLink, escNotif, relTime, trackInApp } from './notifications.js';
import { apiFetch } from './api.js';

const AUTH_HINT_KEY = '3dagent:auth-hint';
const PAGE_SIZE = 30;

// Mirrors api/_lib/notify-prefs.js TYPE_CATEGORY — kept small and in sync by
// hand since it only drives client-side tab filtering, not delivery gating.
const TYPE_CATEGORY = {
	skill_purchased: 'sales', asset_purchased: 'sales', sale: 'sales', 'payment-earned': 'sales',
	payment_received: 'sales', referral_earned: 'sales', referral_signup: 'sales', referral_reward: 'sales',
	pump_launch_filled: 'sales', royalty_paid: 'sales',
	skill_purchase_confirmed: 'purchases', asset_purchase_confirmed: 'purchases',
	skill_gift_received: 'purchases', skill_gift_sent: 'purchases',
	print_update: 'purchases',
	remix: 'social', reply: 'social', comment: 'social', embed: 'social', mention: 'social',
	fork: 'social', follow: 'social', dm_received: 'social', agent_review: 'social',
	quest_complete: 'social',
	irl_interaction: 'irl', irl_reply: 'irl',
	pump_alert: 'alerts',
	companion_delivery: 'companion',
	forge_complete: 'creations', forge_failed: 'creations',
	withdrawal_completed: 'account', withdrawal_failed: 'account', payment_mismatch: 'account',
	asset_payment_mismatch: 'account', skill_payment_mismatch: 'account', security_alert: 'account',
	wallet_anomaly_frozen: 'account',
};
function categoryOf(type) { return TYPE_CATEGORY[type] || 'account'; }

function isAuthed() {
	try {
		const raw = localStorage.getItem(AUTH_HINT_KEY);
		return raw ? JSON.parse(raw)?.authed === true : false;
	} catch { return false; }
}

const els = {};
let all = [];       // every notification fetched so far, newest-first
let activeTab = '';  // '' = all
let unread = 0;
let hasMore = true;
let loading = false;

function q(id) { return document.getElementById(id); }

function renderSkeleton() {
	els.list.innerHTML = Array.from({ length: 6 }).map(() => `
		<div class="n-skel-row">
			<div class="skeleton"></div>
			<div class="n-skel-body">
				<div class="skeleton skeleton-row" style="height:14px;width:70%"></div>
				<div class="skeleton skeleton-row" style="height:11px;width:30%"></div>
			</div>
		</div>
	`).join('');
}

function renderEmpty() {
	els.list.innerHTML = `
		<div class="n-empty">
			<div class="n-empty-icon" aria-hidden="true">🔔</div>
			<h3>No notifications ${activeTab ? 'in this category ' : ''}yet</h3>
			<p>When your agent earns, sells, gets remixed, followed, or finishes a quest, you'll see it here.</p>
		</div>
	`;
}

function filtered() {
	return activeTab ? all.filter((n) => categoryOf(n.type) === activeTab) : all;
}

function render() {
	const list = filtered();
	if (!list.length) return renderEmpty();

	els.list.innerHTML = list.map((n) => {
		const icon = TYPE_ICON[n.type] || '📣';
		const msg = notifLabel(n);
		const link = notifLink(n);
		const time = relTime(n.created_at);
		const rowUnread = !n.read_at;
		return `
			<div class="n-row${rowUnread ? ' is-unread' : ''}"
			     data-id="${escNotif(n.id)}"
			     data-link="${escNotif(link || '')}"
			     tabindex="0" role="button"
			     aria-label="${escNotif(msg)}${rowUnread ? ' (unread)' : ''}">
				<span class="n-icon" aria-hidden="true">${icon}</span>
				<div class="n-body">
					<div class="n-msg">${escNotif(msg)}</div>
					<div class="n-time">${escNotif(time)}</div>
				</div>
				${rowUnread ? '<span class="n-dot" aria-hidden="true"></span>' : ''}
				<button type="button" class="n-del" data-id="${escNotif(n.id)}" aria-label="Delete notification" title="Delete">✕</button>
			</div>
		`;
	}).join('');

	els.list.querySelectorAll('.n-row').forEach((row) => {
		const activate = (e) => {
			if (e.target.closest('.n-del')) return;
			const id = row.dataset.id;
			const link = row.dataset.link;
			if (id) trackInApp(id, 'opened');
			if (id && row.classList.contains('is-unread')) markOneRead(id, row);
			if (link) {
				if (link.startsWith('http')) window.open(link, '_blank', 'noopener');
				else window.location.href = link;
			}
		};
		row.addEventListener('click', activate);
		row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(e); } });
	});
	els.list.querySelectorAll('.n-del').forEach((btn) => {
		btn.addEventListener('click', (e) => {
			e.stopPropagation();
			deleteOne(btn.dataset.id);
		});
	});

	els.loadMoreWrap.hidden = !hasMore;
}

function markOneRead(id, rowEl) {
	const n = all.find((x) => x.id === id);
	if (!n || n.read_at) return;
	n.read_at = new Date().toISOString();
	unread = Math.max(0, unread - 1);
	rowEl?.classList.remove('is-unread');
	rowEl?.querySelector('.n-dot')?.remove();
	apiFetch(`/api/notifications/${encodeURIComponent(id)}/read`, { method: 'POST', credentials: 'include', allowAnonymous: true }).catch(() => {});
}

async function markAllRead() {
	els.markAll.disabled = true;
	els.markAll.textContent = 'Done ✓';
	all.forEach((n) => { n.read_at = n.read_at || new Date().toISOString(); });
	unread = 0;
	render();
	try {
		await apiFetch('/api/notifications/read-all', { method: 'POST', credentials: 'include', allowAnonymous: true });
	} catch { /* fire-and-forget */ }
}

function deleteOne(id) {
	const row = els.list.querySelector(`.n-row[data-id="${CSS.escape(id)}"]`);
	row?.remove();
	const wasUnread = all.find((n) => n.id === id && !n.read_at);
	all = all.filter((n) => n.id !== id);
	if (wasUnread) unread = Math.max(0, unread - 1);
	if (!filtered().length) renderEmpty();
	apiFetch(`/api/notifications/${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'include', allowAnonymous: true }).catch(() => {});
}

async function loadPage(before) {
	if (loading) return;
	loading = true;
	els.loadMoreBtn.disabled = true;
	els.loadMoreBtn.textContent = 'Loading…';
	try {
		const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
		if (before) params.set('before', before);
		const resp = await fetch(`/api/notifications?${params}`, { credentials: 'include' });
		if (resp.status === 401) {
			els.authWall.hidden = false;
			els.main.hidden = true;
			return;
		}
		if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
		const data = await resp.json();
		const fresh = data.notifications || [];
		all = before ? [...all, ...fresh] : fresh;
		unread = data.unread_count ?? unread;
		hasMore = !!data.has_more;
		render();
	} catch (err) {
		els.error.textContent = 'Could not load notifications. Try refreshing the page.';
		els.error.hidden = false;
	} finally {
		loading = false;
		els.loadMoreBtn.disabled = false;
		els.loadMoreBtn.textContent = 'Load more';
	}
}

function wireTabs() {
	els.tabs.querySelectorAll('.n-tab').forEach((tab) => {
		tab.addEventListener('click', () => {
			els.tabs.querySelectorAll('.n-tab').forEach((t) => { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); });
			tab.classList.add('active');
			tab.setAttribute('aria-selected', 'true');
			activeTab = tab.dataset.type || '';
			render();
		});
	});
}

async function init() {
	els.authWall = q('n-auth-wall');
	els.error = q('n-error');
	els.main = q('n-main');
	els.tabs = q('n-tabs');
	els.list = q('n-list');
	els.markAll = q('n-mark-all');
	els.loadMoreWrap = q('n-load-more');
	els.loadMoreBtn = q('n-load-more-btn');

	if (!isAuthed()) {
		els.authWall.hidden = false;
		return;
	}

	els.main.hidden = false;
	renderSkeleton();
	wireTabs();
	els.markAll.addEventListener('click', markAllRead);
	els.loadMoreBtn.addEventListener('click', () => {
		const last = all[all.length - 1];
		if (last) loadPage(last.created_at);
	});

	await loadPage(null);
}

if (document.readyState === 'loading') {
	document.addEventListener('DOMContentLoaded', init);
} else {
	init();
}
