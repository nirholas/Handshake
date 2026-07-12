// Site-wide notifications inbox: unread badge in the nav + a popover panel.
//
// Loaded by public/nav.js after the nav HTML is injected (so #nav-notifications-btn
// is guaranteed to exist). Auth-aware: silently skips polling when no session
// hint is found; shows a sign-in prompt when the panel is opened while logged out.
//
// All API calls are fire-and-forget with credentials: 'include'. A 401 just
// means the user is not signed in — the badge stays hidden.

import { isPushSupported, getPushState, getPushConfig, enablePush } from './push-notifications.js';

const POLL_INTERVAL = 30_000;
const AUTH_HINT_KEY = '3dagent:auth-hint';
// Remember a dismissed/declined push prompt so the value-moment banner isn't
// nagging — re-offer only via the explicit preference-center toggle after this.
const PUSH_PROMPT_KEY = '3dagent:push-prompt-dismissed';

// Cross-tab coordination. The inbox badge mounts in every open tab, and the
// /api/notifications budget is keyed per user — so N tabs each polling on their
// own 30s timer (plus a re-poll on every tab focus) used to multiply into a
// burst that tripped the per-user 429. We dedupe across tabs through a shared
// localStorage cache + a BroadcastChannel: whichever tab actually fetches
// writes the result and broadcasts it, and every other tab reuses that result
// for the poll interval instead of spending its own request.
const NOTIF_CACHE_KEY = '3dagent:notif-cache';
const NOTIF_LOCK_KEY = '3dagent:notif-lock';
const NOTIF_CHANNEL = '3dagent:notifications';
// Best-effort cross-tab fetch lock TTL — long enough to collapse a simultaneous
// poll burst, short enough that a tab whose fetch died never wedges the others.
const LOCK_TTL = 5_000;
// Cap exponential backoff after repeated 429s so the badge self-heals within a
// bounded window once the per-user budget refills.
const MAX_BACKOFF = 5 * 60_000;

function readNotifCache() {
	try {
		const raw = localStorage.getItem(NOTIF_CACHE_KEY);
		if (!raw) return null;
		const c = JSON.parse(raw);
		return c && typeof c.ts === 'number' ? c : null;
	} catch { return null; }
}

function writeNotifCache(notifications, unread_count) {
	try {
		localStorage.setItem(
			NOTIF_CACHE_KEY,
			JSON.stringify({ ts: Date.now(), notifications, unread_count }),
		);
	} catch { /* storage disabled/full — degrade to per-tab polling */ }
}

// Best-effort, last-writer-wins lock. localStorage isn't transactional across
// tabs, but the race window is sub-millisecond and an occasional double-fetch is
// harmless — this only needs to thin out the simultaneous burst.
function tryAcquireFetchLock() {
	try {
		const now = Date.now();
		const raw = localStorage.getItem(NOTIF_LOCK_KEY);
		const held = raw ? Number(raw) : 0;
		if (Number.isFinite(held) && now - held < LOCK_TTL) return false;
		localStorage.setItem(NOTIF_LOCK_KEY, String(now));
		return true;
	} catch { return true; }
}

const TYPE_ICON = {
	skill_purchased:          '💵',
	skill_purchase_confirmed: '✅',
	skill_gift_received:      '🎁',
	skill_gift_sent:          '🎁',
	asset_purchased:          '💵',
	asset_purchase_confirmed: '✅',
	asset_payment_mismatch:   '⚠️',
	skill_payment_mismatch:   '⚠️',
	referral_earned:          '💰',
	'payment-earned':         '💸',
	sale:                     '🛒',
	embed:                    '🔗',
	remix:                    '🔄',
	reply:                    '💬',
	irl_interaction:          '📍',
	irl_reply:                '💬',
	follow:                   '👤',
	dm_received:              '💬',
	pump_launch_filled:       '🚀',
	agent_review:             '⭐',
};

function notifLabel(n) {
	const p = n.payload || {};
	switch (n.type) {
		case 'skill_purchased':
			return `Payment received for skill "${p.skill || 'unknown'}"`;
		case 'skill_purchase_confirmed':
			return `Your purchase of "${p.skill || 'unknown'}" is confirmed`;
		case 'skill_gift_received':
			return p.from
				? `${p.from} gifted you the skill "${p.skill || 'unknown'}"`
				: `You received the skill "${p.skill || 'unknown'}" as a gift`;
		case 'skill_gift_sent':
			return p.to
				? `Your gift of "${p.skill || 'unknown'}" was delivered to ${p.to}`
				: `Your gift of "${p.skill || 'unknown'}" was delivered`;
		case 'asset_purchased':
			return `Someone purchased your ${p.item_type || 'asset'}`;
		case 'asset_purchase_confirmed':
			return `Your asset purchase is confirmed`;
		case 'asset_payment_mismatch':
		case 'skill_payment_mismatch':
			return `Payment mismatch — check your agent settings`;
		case 'referral_earned':
			return `Referral commission earned`;
		case 'payment-earned':
			return `Payment received${p.actor ? ` from ${p.actor}` : ''}`;
		case 'sale':
			return `Your agent made a sale`;
		case 'embed':
			return `Your creation was embedded`;
		case 'remix':
			return p.royaltyPaid && p.royaltyUsd
				? `Someone remixed your creation — you earned $${Number(p.royaltyUsd).toFixed(3)} in royalties`
				: `Someone remixed your creation`;
		case 'follow':
			return p.actor ? `${p.actor} started following you` : `Someone started following you`;
		case 'dm_received':
			return p.actor ? `New message from ${p.actor}` : `You have a new message`;
		case 'pump_launch_filled':
			return p.name ? `${p.name} hit its funding target and graduated` : `Your launch hit its funding target and graduated`;
		case 'agent_review':
			return p.actor ? `${p.actor} reviewed your agent${p.rating ? ` (${p.rating}★)` : ''}` : `Your agent received a new review`;
		case 'reply':
			return `New reply on your agent`;
		case 'irl_interaction':
			if (p.kind === 'pay') {
				const amt = irlPayLabel(p.amount, p.currency_mint);
				return amt ? `Your agent was paid ${amt} in person` : `Your agent was paid in person`;
			}
			return p.message
				? `Someone messaged your agent in person: “${p.message}”`
				: `Someone messaged your agent in person`;
		case 'irl_reply':
			return p.message ? `An agent replied: “${p.message}”` : `An agent replied to your message`;
		default:
			return n.type.replace(/_/g, ' ');
	}
}

// Human "0.05 USDC" from a pay notification's atomic amount + mint. $THREE and
// Solana/Base USDC are the only mints this platform references (each 6-decimal);
// an unrecognized mint degrades to a bare number rather than naming a coin.
function irlPayLabel(amount, mint) {
	if (amount == null) return '';
	const human = (Number(amount) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 6 });
	if (!Number.isFinite(Number(amount))) return '';
	const m = String(mint || '').toLowerCase();
	const label = mint === 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump' ? '$THREE'
		: (m === 'epjfwdd5aufqssqem2qn1xzybapc8g4weggkzwytdt1v' || m === '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913') ? 'USDC'
		: '';
	return label ? `${human} ${label}` : human;
}

function notifLink(n) {
	const p = n.payload || {};
	const raw = p.link
		|| (p.tx_signature ? `https://solscan.io/tx/${encodeURIComponent(p.tx_signature)}` : null)
		|| (p.agent_id ? `/agent/${encodeURIComponent(p.agent_id)}` : null);
	return safeNavUrl(raw);
}

// Permit only same-origin relative paths or absolute http(s) URLs. Anything
// else — javascript:, data:, vbscript:, or a protocol-relative //evil.com — is
// dropped, so a hostile notification payload can't drive navigation into a
// script execution or an off-site redirect.
function safeNavUrl(raw) {
	if (!raw || typeof raw !== 'string') return null;
	const s = raw.trim();
	if (s.startsWith('/') && !s.startsWith('//')) return s;
	if (/^https?:\/\//i.test(s)) return s;
	return null;
}

// HTML-escape untrusted notification text before it goes into innerHTML/attrs.
// Notification payloads carry other users' actor/skill/item names, so every
// interpolated value is treated as hostile.
function escNotif(s) {
	return String(s == null ? '' : s)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

function relTime(dateStr) {
	const diff = Date.now() - new Date(dateStr).getTime();
	const m = Math.floor(diff / 60_000);
	if (m < 1) return 'just now';
	if (m < 60) return `${m}m ago`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h ago`;
	return `${Math.floor(h / 24)}d ago`;
}

// Fire-and-forget funnel beacon for the in-app channel. The push channel is
// instrumented from the service worker; this closes the loop for inbox opens.
function trackInApp(notificationId, event) {
	fetch('/api/notifications/track', {
		method: 'POST',
		credentials: 'include',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ notification_id: notificationId, channel: 'in_app', event }),
	}).catch(() => {});
}

function isAuthed() {
	try {
		const raw = localStorage.getItem(AUTH_HINT_KEY);
		return raw ? JSON.parse(raw)?.authed === true : false;
	} catch { return false; }
}

class NotificationInbox {
	constructor(btn) {
		this._btn = btn;
		this._badge = btn.querySelector('.nav-notif-badge');
		this._panel = null;
		this._notifications = [];
		this._unread = 0;
		this._open = false;
		this._timer = null;
		this._backoffUntil = 0;
		this._backoffMs = 0;

		// Listen for fresh data fetched by sibling tabs so we update the badge
		// without spending our own request.
		this._channel = null;
		try {
			this._channel = new BroadcastChannel(NOTIF_CHANNEL);
			this._channel.onmessage = (e) => this._applyData(e.data, false);
		} catch { /* BroadcastChannel unsupported — localStorage cache still coordinates */ }

		btn.addEventListener('click', (e) => { e.stopPropagation(); this._toggle(); });
		document.addEventListener('keydown', (e) => {
			if (e.key === 'Escape' && this._open) this._close();
		});
	}

	// Apply a notifications payload (from our own fetch, the shared cache, or a
	// sibling tab) to local state + the badge. `share` re-publishes to the cache
	// and other tabs; broadcasts received from siblings pass `false` to avoid a
	// rebroadcast loop.
	_applyData(data, share) {
		if (!data) return;
		this._notifications = data.notifications || [];
		this._unread = data.unread_count || 0;
		this._updateBadge();
		if (this._open) this._renderBody();
		if (share) {
			writeNotifCache(this._notifications, this._unread);
			try {
				this._channel?.postMessage({
					notifications: this._notifications,
					unread_count: this._unread,
				});
			} catch { /* channel closed */ }
		}
	}

	start() {
		if (!isAuthed()) return;
		// Seed the badge instantly from whatever a sibling tab fetched last, so a
		// new tab is correct on load without adding its own request.
		const cached = readNotifCache();
		if (cached) this._applyData(cached, false);
		this._poll();
		this._schedulePoll();
		document.addEventListener('visibilitychange', () => {
			if (document.hidden) {
				clearTimeout(this._timer);
			} else {
				// Re-poll on focus, but `_poll` reuses a fresh shared cache, so
				// rapidly flipping between tabs no longer bursts the API.
				this._poll();
				this._schedulePoll();
			}
		});
	}

	_schedulePoll() {
		clearTimeout(this._timer);
		this._timer = setTimeout(() => {
			this._poll();
			this._schedulePoll();
		}, POLL_INTERVAL);
	}

	async _poll() {
		if (!isAuthed()) return;

		// Honour a 429 backoff window — don't keep hammering a drained budget.
		if (Date.now() < this._backoffUntil) return;

		// If any tab fetched within the poll interval, reuse it instead of
		// spending another request against the per-user budget.
		const cached = readNotifCache();
		if (cached && Date.now() - cached.ts < POLL_INTERVAL) {
			this._applyData(cached, false);
			return;
		}

		// Collapse a simultaneous multi-tab poll into a single fetch; the winner
		// broadcasts the result to everyone else.
		if (!tryAcquireFetchLock()) return;

		try {
			const resp = await fetch('/api/notifications?limit=20', { credentials: 'include' });
			if (resp.status === 429) {
				this._backoffMs = Math.min(this._backoffMs ? this._backoffMs * 2 : POLL_INTERVAL, MAX_BACKOFF);
				this._backoffUntil = Date.now() + this._backoffMs;
				return;
			}
			if (!resp.ok) return;
			this._backoffMs = 0;
			this._backoffUntil = 0;
			this._applyData(await resp.json(), true);
		} catch { /* network blip — silently ignore */ }
	}

	_updateBadge() {
		const badge = this._badge;
		if (!badge) return;
		if (this._unread > 0) {
			badge.textContent = this._unread > 99 ? '99+' : String(this._unread);
			badge.removeAttribute('hidden');
		} else {
			badge.setAttribute('hidden', '');
		}
		this._btn.setAttribute(
			'aria-label',
			this._unread > 0 ? `Notifications — ${this._unread} unread` : 'Notifications',
		);
		// aria-live on the badge for screen reader announcements
		badge.setAttribute('aria-live', 'polite');
	}

	_toggle() {
		this._open ? this._close() : this._openPanel();
	}

	_openPanel() {
		this._open = true;
		this._btn.setAttribute('aria-expanded', 'true');
		if (!this._panel) this._panel = this._buildPanel();
		document.body.appendChild(this._panel);
		this._positionPanel();

		if (isAuthed()) {
			this._renderBody();
			this._maybeRenderPushBanner();
			if (this._unread > 0) this._markAllRead();
		} else {
			this._renderLoggedOut();
		}

		// Close on outside click (deferred so the open click doesn't immediately close)
		setTimeout(() => {
			document.addEventListener('click', this._outsideHandler = (e) => {
				if (!this._panel?.contains(e.target) && e.target !== this._btn) this._close();
			}, { once: false });
		}, 0);
	}

	_close() {
		this._open = false;
		this._btn.setAttribute('aria-expanded', 'false');
		this._panel?.remove();
		if (this._outsideHandler) {
			document.removeEventListener('click', this._outsideHandler);
			this._outsideHandler = null;
		}
	}

	_buildPanel() {
		const el = document.createElement('div');
		el.className = 'notif-panel';
		el.setAttribute('role', 'dialog');
		el.setAttribute('aria-label', 'Notifications');
		el.setAttribute('aria-modal', 'false');
		el.innerHTML = `
			<div class="notif-panel-head">
				<span class="notif-panel-title">Notifications</span>
				<div style="display:flex;align-items:center;gap:4px">
					<a href="/dashboard/settings" class="notif-prefs-link btn-ghost" aria-label="Notification preferences" title="Notification preferences">⚙</a>
					<button type="button" class="notif-mark-all btn-ghost" aria-label="Mark all as read">Mark all read</button>
				</div>
			</div>
			<div class="notif-panel-body" aria-live="polite" aria-atomic="false"></div>
		`;
		el.querySelector('.notif-mark-all').addEventListener('click', (e) => {
			e.stopPropagation();
			this._markAllRead();
		});
		return el;
	}

	_positionPanel() {
		if (!this._panel || !this._btn) return;
		const rect = this._btn.getBoundingClientRect();
		const W = 360;
		let left = rect.right - W;
		left = Math.max(8, Math.min(window.innerWidth - W - 8, left));
		this._panel.style.top = `${rect.bottom + 6}px`;
		this._panel.style.left = `${left}px`;
	}

	_renderBody() {
		const body = this._panel?.querySelector('.notif-panel-body');
		if (!body) return;

		if (!this._notifications.length) {
			body.innerHTML = `
				<div class="notif-empty">
					<div class="notif-empty-icon" aria-hidden="true">🔔</div>
					<div class="notif-empty-title">No notifications yet</div>
					<div class="notif-empty-sub">When your agent earns, sells, or gets remixed, you'll see it here.</div>
				</div>
			`;
			return;
		}

		body.innerHTML = this._notifications.map((n) => {
			const icon = TYPE_ICON[n.type] || '📣';
			const msg = notifLabel(n);
			const link = notifLink(n);
			const time = relTime(n.created_at);
			const unread = !n.read_at;
			return `
				<div class="notif-row${unread ? ' is-unread' : ''}"
				     data-id="${escNotif(n.id)}"
				     data-link="${escNotif(link || '')}"
				     tabindex="0"
				     role="button"
				     aria-label="${escNotif(msg)}${unread ? ' (unread)' : ''}">
					<span class="notif-type-icon" aria-hidden="true">${icon}</span>
					<div class="notif-row-body">
						<div class="notif-row-msg">${escNotif(msg)}</div>
						<div class="notif-row-time">${escNotif(time)}</div>
					</div>
					${unread ? '<span class="notif-unread-dot" aria-hidden="true"></span>' : ''}
				</div>
			`;
		}).join('');

		body.querySelectorAll('.notif-row').forEach((row) => {
			const activate = () => {
				const id = row.dataset.id;
				const link = row.dataset.link;
				if (id) trackInApp(id, 'opened');
				if (id && row.classList.contains('is-unread')) this._markOneRead(id, row);
				if (link) {
					if (link.startsWith('http')) {
						window.open(link, '_blank', 'noopener');
					} else {
						window.location.href = link;
					}
				}
				this._close();
			};
			row.addEventListener('click', activate);
			row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); } });
		});
	}

	// Value-moment push prompt: only offered while the user is actively looking
	// at their notifications, never on page load. Hidden when push is
	// unsupported/unconfigured, already granted, previously denied, or dismissed.
	async _maybeRenderPushBanner() {
		if (!isPushSupported()) return;
		try {
			if (localStorage.getItem(PUSH_PROMPT_KEY) === '1') return;
		} catch { /* storage disabled — still offer */ }

		const [{ pushEnabled }, state] = await Promise.all([getPushConfig(), getPushState()]);
		if (!pushEnabled || !state.supported) return;
		if (state.subscribed || state.permission === 'denied') return;
		// Panel may have closed while we awaited.
		const body = this._panel?.querySelector('.notif-panel-body');
		if (!this._open || !body) return;

		const banner = document.createElement('div');
		banner.className = 'notif-push-banner';
		banner.innerHTML = `
			<div class="notif-push-copy">
				<span class="notif-push-icon" aria-hidden="true">🔔</span>
				<span>Get notified the moment your agent earns or sells.</span>
			</div>
			<div class="notif-push-actions">
				<button type="button" class="notif-push-enable">Turn on push</button>
				<button type="button" class="notif-push-dismiss" aria-label="Dismiss">Not now</button>
			</div>
		`;
		body.prepend(banner);

		banner.querySelector('.notif-push-enable').addEventListener('click', async (e) => {
			e.stopPropagation();
			const btn = e.currentTarget;
			btn.disabled = true;
			btn.textContent = 'Enabling…';
			const res = await enablePush();
			if (res.ok) {
				banner.remove();
			} else {
				btn.disabled = false;
				btn.textContent = res.reason === 'denied' ? 'Blocked in browser' : 'Try again';
				if (res.reason === 'denied') { try { localStorage.setItem(PUSH_PROMPT_KEY, '1'); } catch {} }
			}
		});
		banner.querySelector('.notif-push-dismiss').addEventListener('click', (e) => {
			e.stopPropagation();
			try { localStorage.setItem(PUSH_PROMPT_KEY, '1'); } catch {}
			banner.remove();
		});
	}

	_renderLoggedOut() {
		const body = this._panel?.querySelector('.notif-panel-body');
		if (!body) return;
		body.innerHTML = `
			<div class="notif-empty">
				<div class="notif-empty-icon" aria-hidden="true">🔔</div>
				<div class="notif-empty-title">Sign in to see your notifications</div>
				<div class="notif-empty-sub">Track payments, sales, and activity on your agents.</div>
				<a href="/login" class="notif-signin-btn">Sign in →</a>
			</div>
		`;
	}

	_markOneRead(id, rowEl) {
		const n = this._notifications.find((x) => x.id === id);
		if (!n || n.read_at) return;
		n.read_at = new Date().toISOString();
		this._unread = Math.max(0, this._unread - 1);
		this._updateBadge();
		rowEl?.classList.remove('is-unread');
		rowEl?.querySelector('.notif-unread-dot')?.remove();
		fetch(`/api/notifications/${encodeURIComponent(id)}/read`, { method: 'POST', credentials: 'include' }).catch(() => {});
	}

	async _markAllRead() {
		const markAllBtn = this._panel?.querySelector('.notif-mark-all');
		if (markAllBtn) { markAllBtn.disabled = true; markAllBtn.textContent = 'Done ✓'; }
		this._notifications.forEach((n) => { n.read_at = n.read_at || new Date().toISOString(); });
		this._unread = 0;
		this._updateBadge();
		this._renderBody();
		try {
			await fetch('/api/notifications/read-all', { method: 'POST', credentials: 'include' });
		} catch { /* fire-and-forget */ }
	}
}

function mount() {
	// Guard against a double mount (e.g. nav re-injected) spinning up a second
	// poller for the same tab.
	if (window.__notifInbox) return;
	const btn = document.getElementById('nav-notifications-btn');
	if (!btn) return;
	const inbox = new NotificationInbox(btn);
	inbox.start();
	window.__notifInbox = inbox;
}

if (document.readyState === 'loading') {
	document.addEventListener('DOMContentLoaded', mount);
} else {
	mount();
}
