// dashboard-next — Settings page.
//
// Consolidates everything that doesn't fit in Account or Monetize:
//   • Active sessions (list + revoke)
//   • Notifications (list + mark-read)
//   • Avatar storage mode (R2 vs IPFS, pin to IPFS)
//   • Storage usage (avatar files, animation clips)
//   • LLM usage (calls this month, tokens consumed, by model)
//   • App preferences (dashboard prefs via /api/dashboard/prefs)
//   • Vanity wallet shortcuts (SOL vanity + ETH CREATE2)
//
// Real endpoints:
//   GET  /api/auth/sessions                 { sessions: [...] }
//   DELETE /api/auth/sessions/:id           revoke one session
//   DELETE /api/auth/sessions               revoke all others + rotate current
//   GET  /api/notifications                 { notifications: [...], unread: N }
//   POST /api/notifications/read-all
//   GET  /api/billing/summary               { usage: { total_bytes, avatar_count, ... } }
//   GET  /api/usage/summary                 { llm: { calls_month, tokens_month, by_model } }
//   GET  /api/dashboard/prefs               { prefs }
//   PATCH /api/dashboard/prefs              body prefs patch
//   GET  /api/avatars/mine                  { avatars: [{ storage, ... }] }
//   POST /api/avatars/:id/pin-ipfs          pin the stored object, returns CID
//   PUT  /api/avatars/:id/storage-mode      switch which source is primary
//   GET  /api/version                       running build (About panel)

import { mountShell } from '../shell.js';
import { requireUser, get, post, put, del, patch, esc, relTime, ApiError } from '../api.js';
import { emptyStateHTML, errorStateHTML, ensureStateKitStyles, attachRetry } from '../../shared/state-kit.js';
import { toast } from '../../shared/toast.js';

const MONO = `'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace`;


// Scoped styles for this page — the switch control and shared panel-header
// layout. Uses only design tokens; injected once.
function injectStyles() {
	if (document.getElementById('set-css')) return;
	const s = document.createElement('style');
	s.id = 'set-css';
	s.textContent = `
		.set-panel-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:14px}
		.set-toggle-row{display:flex;align-items:center;justify-content:space-between;gap:16px}
		.set-toggle-text{min-width:0}
		.set-toggle-label{font-size:13.5px;color:var(--nxt-ink);font-weight:500}
		.set-toggle-desc{font-size:12.5px;color:var(--nxt-ink-dim);margin-top:2px;line-height:1.45}
		.set-switch{position:relative;flex:0 0 auto;width:40px;height:24px;padding:0;border-radius:999px;
			border:1px solid var(--nxt-stroke-strong);background:rgba(255,255,255,.06);cursor:pointer;
			transition:background .18s ease,border-color .18s ease}
		.set-switch:hover{border-color:var(--nxt-accent)}
		.set-switch[aria-checked="true"]{background:var(--nxt-accent);border-color:var(--nxt-accent)}
		.set-switch::after{content:"";position:absolute;top:50%;left:2px;transform:translateY(-50%);
			width:18px;height:18px;border-radius:50%;background:var(--nxt-ink);
			transition:transform .2s cubic-bezier(.4,0,.2,1),background .18s ease}
		.set-switch[aria-checked="true"]::after{transform:translateY(-50%) translateX(16px);background:#000}
		.set-switch:focus-visible{outline:none;box-shadow:0 0 0 3px var(--nxt-accent-soft)}
		.set-theme-btn:focus-visible,.set-net-btn:focus-visible{outline:none;box-shadow:0 0 0 3px var(--nxt-accent-soft)}
		.set-store-row{display:flex;align-items:center;gap:12px;padding:12px 0;flex-wrap:wrap;
			border-bottom:1px solid var(--nxt-stroke)}
		.set-store-row:last-child{border-bottom:0}
		.set-store-thumb{flex:0 0 auto;width:44px;height:44px;border-radius:9px;object-fit:cover;
			background:rgba(255,255,255,.04);border:1px solid var(--nxt-stroke)}
		.set-store-meta{flex:1 1 200px;min-width:0}
		.set-store-name{font-size:13.5px;color:var(--nxt-ink);font-weight:500;overflow:hidden;
			text-overflow:ellipsis;white-space:nowrap}
		.set-store-facts{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:5px;
			font-size:12px;color:var(--nxt-ink-fade)}
		.set-store-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
		.set-seg{display:inline-flex;border:1px solid var(--nxt-stroke-strong);border-radius:8px;overflow:hidden}
		.set-seg-btn{padding:5px 12px;font-size:12px;font-weight:500;color:var(--nxt-ink-dim);
			background:transparent;border:0;cursor:pointer;transition:background .16s ease,color .16s ease}
		.set-seg-btn+.set-seg-btn{border-left:1px solid var(--nxt-stroke-strong)}
		.set-seg-btn:hover:not([disabled]){background:rgba(255,255,255,.06);color:var(--nxt-ink)}
		.set-seg-btn[aria-pressed="true"]{background:var(--nxt-accent);color:#000}
		.set-seg-btn[disabled]{opacity:.4;cursor:not-allowed}
		.set-seg-btn:focus-visible{outline:none;box-shadow:inset 0 0 0 2px var(--nxt-accent-soft)}
		@media (prefers-reduced-motion:reduce){.set-switch,.set-switch::after{transition:none}}
	`;
	document.head.appendChild(s);
}

(async function boot() {
	try {
		const main = await mountShell();
		await requireUser();
		ensureStateKitStyles();
		injectStyles();

		main.innerHTML = `
			<h1 class="dn-h1">Settings</h1>
			<p class="dn-h1-sub">Sessions, storage, usage, notifications, and preferences.</p>
			<div data-slot="content" style="display:flex;flex-direction:column;gap:16px"></div>
		`;

		loadContent(main.querySelector('[data-slot="content"]'));
	} catch (err) {
		if (err instanceof ApiError && err.status === 401) {
			location.href = `/login?return=${encodeURIComponent(location.pathname)}`;
		} else {
			throw err;
		}
	}
})();

// Load (or reload) every data-backed panel. Extracted so the per-panel error
// states can offer a working Retry that re-fetches without a full page reload.
async function loadContent(host) {
	host.innerHTML = Array.from({ length: 4 })
		.map(() => `<div class="dn-skeleton" style="height:120px;border-radius:12px"></div>`)
		.join('');

	const retry = () => loadContent(host);

	const [sessionsResp, notifResp, notifPrefsResp, avatarsResp, summaryResp, usageResp, prefsResp, versionResp] =
		await Promise.all([
			safeGet('/api/auth/sessions'),
			safeGet('/api/notifications?limit=20'),
			safeGet('/api/notifications/preferences'),
			safeGet('/api/avatars/mine?limit=24'),
			safeGet('/api/billing/summary'),
			safeGet('/api/usage/summary'),
			safeGet('/api/dashboard/prefs'),
			safeGet('/api/version'),
		]);

	const prefs = prefsResp.data?.prefs || prefsResp.data || {};

	host.innerHTML = '';
	host.appendChild(renderTheme());
	host.appendChild(renderSessions(sessionsResp, retry));
	host.appendChild(renderNotifications(notifResp, retry));
	host.appendChild(renderNotificationPrefs(notifPrefsResp, retry));
	host.appendChild(renderDefaultNetwork(prefs));
	host.appendChild(renderAvatarStorage(avatarsResp, retry));
	host.appendChild(renderStorage(summaryResp, retry));
	host.appendChild(renderLlmUsage(usageResp, retry));
	host.appendChild(renderVanityTools());
	host.appendChild(renderPrefs(prefs));
	host.appendChild(renderDataExport());
	host.appendChild(renderAbout(versionResp));
}

// Returns { ok, data } so callers can tell a genuine fetch failure (show an
// error state with Retry) apart from a successful-but-empty response (show an
// empty state). The old swallow-to-null lost that distinction.
async function safeGet(url) {
	try { return { ok: true, data: await get(url) }; }
	catch { return { ok: false, data: null }; }
}

// ── Sessions ───────────────────────────────────────────────────────────────

function renderSessions(resp, onRetry) {
	const panel = document.createElement('div');
	panel.className = 'dn-panel';
	panel.setAttribute('aria-label', 'Active sessions');

	const failed = !resp.ok;
	const sessions = resp.data?.sessions || [];

	panel.innerHTML = `
		<div class="set-panel-head">
			<div>
				<div class="dn-panel-title">Active sessions</div>
				<div class="dn-panel-sub" style="margin:2px 0 0">Devices signed in to your account.</div>
			</div>
			${!failed && sessions.length > 1 ? `<button class="dn-btn danger" data-action="revoke-all">Revoke all other</button>` : ''}
		</div>
		<div data-slot="sessions-list"></div>
	`;

	const listHost = panel.querySelector('[data-slot="sessions-list"]');

	if (failed) {
		listHost.innerHTML = errorStateHTML({
			title: "Couldn't load sessions",
			body: 'We couldn’t reach the session service. Check your connection and try again.',
		});
		attachRetry(listHost, onRetry);
		return panel;
	}

	function renderList(list) {
		if (!list.length) {
			listHost.innerHTML = emptyStateHTML({
				icon: '',
				title: 'No active sessions',
				body: 'Session tracking may not be enabled on this account.',
				compact: true,
			});
			return;
		}
		listHost.innerHTML = list.map((s) => {
			const ua = s.user_agent || s.agent || '';
			const ip = s.ip || s.client_ip || '';
			const when = s.created_at || s.last_seen || s.updated_at;
			const isCurrent = s.is_current || s.current;
			return `
				<div style="display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid var(--nxt-stroke);flex-wrap:wrap" data-session-id="${esc(s.id || '')}">
					<div style="flex:1;min-width:180px">
						<div style="font-size:13.5px;color:var(--nxt-ink)">
							${isCurrent ? `<span class="dn-tag success" style="margin-right:6px">Current</span>` : ''}
							${esc(ua ? ua.slice(0, 80) : 'Unknown device')}
						</div>
						<div style="font-size:12px;color:var(--nxt-ink-fade);margin-top:3px">
							${ip ? `${esc(ip)} · ` : ''}${when ? esc(relTime(when)) : ''}
						</div>
					</div>
					${!isCurrent ? `<button class="dn-btn danger" data-action="revoke-session" data-id="${esc(s.id || '')}" style="padding:5px 10px;font-size:12px">Revoke</button>` : ''}
				</div>
			`;
		}).join('');

		listHost.querySelectorAll('[data-action="revoke-session"]').forEach((btn) => {
			btn.addEventListener('click', async () => {
				const id = btn.dataset.id;
				if (!confirm('Revoke this session?')) return;
				btn.disabled = true;
				btn.textContent = 'Revoking…';
				try {
					await del(`/api/auth/sessions/${encodeURIComponent(id)}`);
					toast('Session revoked');
					const row = btn.closest('[data-session-id]');
					if (row) row.remove();
				} catch (err) {
					toast(err?.message || 'Failed to revoke');
					btn.disabled = false;
					btn.textContent = 'Revoke';
				}
			});
		});
	}

	renderList(sessions);

	const revokeAllBtn = panel.querySelector('[data-action="revoke-all"]');
	revokeAllBtn?.addEventListener('click', async () => {
		if (!confirm('Revoke all sessions except the current one?')) return;
		revokeAllBtn.disabled = true;
		revokeAllBtn.textContent = 'Revoking…';
		try {
			// DELETE on the index revokes every other session and rotates the
			// current one (api/auth/sessions/[action].js handleIndex).
			await del('/api/auth/sessions');
			toast('All other sessions revoked');
			const updated = sessions.filter((s) => s.is_current || s.current);
			renderList(updated);
			revokeAllBtn.remove();
		} catch (err) {
			toast(err?.message || 'Failed');
			revokeAllBtn.disabled = false;
			revokeAllBtn.textContent = 'Revoke all other';
		}
	});

	return panel;
}

// ── Notifications ──────────────────────────────────────────────────────────

function renderNotifications(resp, onRetry) {
	const panel = document.createElement('div');
	panel.className = 'dn-panel';
	panel.setAttribute('aria-label', 'Notifications');

	const failed = !resp.ok;
	const notifications = resp.data?.notifications || [];
	const unread = resp.data?.unread ?? notifications.filter((n) => !n.read_at).length;

	panel.innerHTML = `
		<div class="set-panel-head">
			<div>
				<div class="dn-panel-title">Notifications ${!failed && unread > 0 ? `<span class="dn-tag warn" style="margin-left:6px" data-slot="unread-badge">${unread} unread</span>` : ''}</div>
				<div class="dn-panel-sub" style="margin:2px 0 0">Recent activity and platform messages.</div>
			</div>
			${!failed && unread > 0 ? `<button class="dn-btn" data-action="mark-all-read">Mark all read</button>` : ''}
		</div>
		<div data-slot="notif-list"></div>
	`;

	const listHost = panel.querySelector('[data-slot="notif-list"]');

	if (failed) {
		listHost.innerHTML = errorStateHTML({
			title: "Couldn't load notifications",
			body: 'We couldn’t reach the notifications service. Try again in a moment.',
		});
		attachRetry(listHost, onRetry);
		return panel;
	}

	if (!notifications.length) {
		listHost.innerHTML = emptyStateHTML({
			icon: '',
			title: "You're all caught up",
			body: 'New activity and platform messages will show up here.',
			compact: true,
		});
	} else {
		listHost.innerHTML = notifications.map((n) => `
			<div class="set-notif-row" data-notif ${n.read_at ? '' : 'data-unread'} style="display:flex;gap:12px;padding:12px 0;border-bottom:1px solid var(--nxt-stroke);opacity:${n.read_at ? '0.6' : '1'};transition:opacity .2s ease">
				<div style="flex:1;min-width:0">
					<div style="font-size:13.5px;font-weight:${n.read_at ? '400' : '500'};color:var(--nxt-ink)">${esc(n.title || n.message || 'Notification')}</div>
					${n.body || n.description ? `<div style="font-size:12.5px;color:var(--nxt-ink-dim);margin-top:3px">${esc((n.body || n.description).slice(0, 160))}</div>` : ''}
					<div style="font-size:12px;color:var(--nxt-ink-fade);margin-top:4px">${n.created_at ? esc(relTime(n.created_at)) : ''}</div>
				</div>
				${n.url ? `<a href="${esc(n.url)}" style="font-size:12px;color:var(--nxt-accent);white-space:nowrap;align-self:center">View →</a>` : ''}
			</div>
		`).join('');
	}

	panel.querySelector('[data-action="mark-all-read"]')?.addEventListener('click', async (e) => {
		const btn = e.currentTarget;
		btn.disabled = true;
		btn.textContent = 'Marking…';
		try {
			await post('/api/notifications/read-all', {});
			toast('All notifications marked read');
			btn.remove();
			panel.querySelector('[data-slot="unread-badge"]')?.remove();
			// Fade only the rows that were unread — the read ones are already dim.
			listHost.querySelectorAll('[data-unread]').forEach((el) => {
				el.style.opacity = '0.6';
				el.removeAttribute('data-unread');
			});
		} catch (err) {
			toast(err?.message || 'Failed');
			btn.disabled = false;
			btn.textContent = 'Mark all read';
		}
	});

	return panel;
}

// ── Notification preferences ────────────────────────────────────────────────
// Per-type mute control: which channel(s) deliver each category of notification
// (sales, purchases, social, irl, alerts, account). Backed by the real
// notification_preferences table (api/_lib/notify-prefs.js is the single
// source of truth for categories/channels/defaults) — every write path in
// api/_lib/notify.js checks this before sending push/email, so a toggle here
// takes effect on the very next event, not just in the UI.

const CHANNEL_LABEL = { in_app: 'In-app', push: 'Push', email: 'Email', telegram: 'Telegram', avatar: 'Avatar' };
// One line of help per channel, shown under the table, because "Avatar" is not
// self-explanatory the way Push and Email are.
const CHANNEL_HINT = {
	avatar: 'Avatar: your companion walks on screen and says it out loud while you are on the site. Turn it off for this browser only from the "Turn off" control in its bubble.',
};

function renderNotificationPrefs(resp, onRetry) {
	const panel = document.createElement('div');
	panel.className = 'dn-panel';
	panel.setAttribute('aria-label', 'Notification preferences');

	if (!resp.ok) {
		panel.innerHTML = `
			<div style="margin-bottom:14px">
				<div class="dn-panel-title">Notification preferences</div>
				<div class="dn-panel-sub" style="margin:2px 0 0">Choose which channels deliver each kind of notification.</div>
			</div>
			<div data-slot="notif-prefs-err"></div>`;
		const errHost = panel.querySelector('[data-slot="notif-prefs-err"]');
		errHost.innerHTML = errorStateHTML({
			title: "Couldn't load notification preferences",
			body: 'We couldn’t reach the preference center. Try again in a moment.',
		});
		attachRetry(errHost, onRetry);
		return panel;
	}

	const body = resp.data || {};
	const categories = Array.isArray(body.categories) ? body.categories : [];
	const channels = Array.isArray(body.channels) ? body.channels : ['in_app', 'push', 'email', 'telegram', 'avatar'];
	const matrix = body.prefs?.categories || {};
	const subscribedDevices = body.push?.subscribed_devices ?? 0;

	panel.innerHTML = `
		<div style="margin-bottom:14px">
			<div class="dn-panel-title">Notification preferences</div>
			<div class="dn-panel-sub" style="margin:2px 0 0">Mute noisy categories per channel. Account and security events always stay in your bell so nothing important is silently lost, but you can still quiet their push, email, Telegram and avatar announcements.</div>
		</div>
		${!categories.length ? emptyStateHTML({
			icon: '',
			title: 'No preference categories yet',
			body: 'The preference center will appear here once it has categories to show.',
			compact: true,
		}) : `
			<div style="overflow-x:auto">
				<table style="width:100%;border-collapse:collapse;font-size:13px">
					<thead>
						<tr style="text-align:left;color:var(--nxt-ink-fade);border-bottom:1px solid var(--nxt-stroke)">
							<th style="padding:8px 10px;font-weight:500;min-width:180px">Category</th>
							${channels.map((ch) => `<th style="padding:8px 10px;font-weight:500;text-align:center">${esc(CHANNEL_LABEL[ch] || ch)}</th>`).join('')}
						</tr>
					</thead>
					<tbody>
						${categories.map((cat) => `
							<tr style="border-bottom:1px solid var(--nxt-stroke)" data-cat-row="${esc(cat.key)}">
								<td style="padding:10px">
									<div style="font-weight:500">${esc(cat.label || cat.key)}</div>
									${cat.description ? `<div style="font-size:12px;color:var(--nxt-ink-dim);margin-top:2px">${esc(cat.description)}</div>` : ''}
								</td>
								${channels.map((ch) => {
									// A locked channel always delivers for this category (see
									// notify-prefs lockedChannelsFor), so it renders on and
									// non-interactive rather than as a toggle that does nothing.
									const locked = (cat.lockedChannels || []).includes(ch);
									const on = locked || (matrix?.[cat.key]?.[ch] ?? false);
									const noTelegram = ch === 'telegram' && !body.prefs?.telegram_chat_id;
									const disabled = locked || noTelegram;
									const title = locked
										? 'Always on: account and security events are kept in your bell'
										: noTelegram
											? 'Link a Telegram chat id to enable'
											: '';
									return `
										<td style="padding:10px;text-align:center">
											<button type="button" role="switch" class="set-switch" data-notif-cat="${esc(cat.key)}" data-notif-ch="${esc(ch)}"
												aria-checked="${on ? 'true' : 'false'}"
												${disabled ? 'disabled' : ''}${title ? ` title="${esc(title)}"` : ''}
												aria-label="${esc(cat.label || cat.key)} via ${esc(CHANNEL_LABEL[ch] || ch)}${locked ? ', always on' : ''}"
												style="${noTelegram ? 'opacity:.35;cursor:not-allowed' : locked ? 'cursor:not-allowed' : ''}"></button>
										</td>
									`;
								}).join('')}
							</tr>
						`).join('')}
					</tbody>
				</table>
			</div>
			${channels.some((ch) => CHANNEL_HINT[ch]) ? `
				<div style="margin-top:12px;font-size:12px;color:var(--nxt-ink-fade);display:grid;gap:4px">
					${channels.filter((ch) => CHANNEL_HINT[ch]).map((ch) => `<div>${esc(CHANNEL_HINT[ch])}</div>`).join('')}
				</div>
			` : ''}
			<div style="margin-top:12px;font-size:12px;color:var(--nxt-ink-fade)">
				${subscribedDevices > 0
					? `Push is enabled on ${subscribedDevices} device${subscribedDevices === 1 ? '' : 's'}.`
					: 'No devices are subscribed to push yet — enable it from the notification bell.'}
			</div>
			<div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--nxt-stroke);display:flex;justify-content:flex-end">
				<button class="dn-btn primary" data-action="save-notif-prefs">Save notification preferences</button>
			</div>
		`}
	`;

	panel.querySelectorAll('[data-notif-cat]').forEach((sw) => {
		sw.addEventListener('click', () => {
			if (sw.disabled) return;
			sw.setAttribute('aria-checked', sw.getAttribute('aria-checked') === 'true' ? 'false' : 'true');
		});
	});

	panel.querySelector('[data-action="save-notif-prefs"]')?.addEventListener('click', async (e) => {
		const btn = e.currentTarget;
		const next = {};
		panel.querySelectorAll('[data-notif-cat]').forEach((sw) => {
			const cat = sw.dataset.notifCat;
			const ch = sw.dataset.notifCh;
			(next[cat] ??= {})[ch] = sw.getAttribute('aria-checked') === 'true';
		});
		btn.disabled = true;
		btn.textContent = 'Saving…';
		try {
			await put('/api/notifications/preferences', { categories: next });
			toast('Notification preferences saved');
		} catch (err) {
			toast(err?.message || 'Save failed');
		} finally {
			btn.disabled = false;
			btn.textContent = 'Save notification preferences';
		}
	});

	return panel;
}

// ── Avatar storage (R2 vs IPFS) ────────────────────────────────────────────
// Every avatar is written to R2 on upload. Pinning one to IPFS gives it a CID
// that outlives this platform, and the `primary` flag decides which of the two
// copies a viewer resolves first. All three calls are real per-avatar records:
//   GET  /api/avatars/mine             each row carries its flattened storage
//   POST /api/avatars/:id/pin-ipfs     pins the stored object, returns the CID
//   PUT  /api/avatars/:id/storage-mode switches which source is primary
//
// A deployment with no pinning provider answers the pin with `stub: true` and a
// `stub:` pseudo-CID, which is a recorded content hash and not a pin. The row
// says exactly that rather than showing a CID that resolves nowhere.

const IPFS_GATEWAY = 'https://ipfs.io/ipfs/';

function isRealCid(cid) {
	return typeof cid === 'string' && cid.length > 0 && !cid.startsWith('stub:');
}

function shortCid(cid) {
	return cid.length > 18 ? `${cid.slice(0, 10)}…${cid.slice(-6)}` : cid;
}

function renderAvatarStorage(resp, onRetry) {
	const panel = document.createElement('div');
	panel.className = 'dn-panel';
	panel.setAttribute('aria-label', 'Avatar storage');

	const headHTML = `
		<div style="margin-bottom:14px">
			<div class="dn-panel-title">Avatar storage</div>
			<div class="dn-panel-sub" style="margin:2px 0 0">Every avatar lives in three.ws storage (R2). Pin one to IPFS to give it a permanent content address, then choose which copy viewers load first.</div>
		</div>`;

	if (!resp.ok) {
		panel.innerHTML = `${headHTML}<div data-slot="avstore-err"></div>`;
		const errHost = panel.querySelector('[data-slot="avstore-err"]');
		errHost.innerHTML = errorStateHTML({
			title: "Couldn't load avatar storage",
			body: 'We could not reach the avatar service. Try again in a moment.',
		});
		attachRetry(errHost, onRetry);
		return panel;
	}

	const avatars = Array.isArray(resp.data?.avatars) ? resp.data.avatars : [];

	if (!avatars.length) {
		panel.innerHTML = `${headHTML}<div data-slot="avstore-empty"></div>`;
		panel.querySelector('[data-slot="avstore-empty"]').innerHTML = emptyStateHTML({
			icon: '',
			title: 'No avatars yet',
			body: 'Create your first avatar and its storage mode will show up here.',
			actions: [{ label: 'Create an avatar', href: '/create', primary: true }],
			compact: true,
		});
		return panel;
	}

	panel.innerHTML = `
		${headHTML}
		<div data-slot="avstore-list" style="display:flex;flex-direction:column"></div>
		<div style="margin-top:12px;font-size:12px;color:var(--nxt-ink-fade)">
			Showing your ${avatars.length} most recent avatar${avatars.length === 1 ? '' : 's'}.
			<a href="/dashboard/library" style="color:var(--nxt-accent);margin-left:6px">Open your library →</a>
		</div>
	`;

	const listHost = panel.querySelector('[data-slot="avstore-list"]');
	for (const av of avatars) listHost.appendChild(avatarStorageRow(av));
	return panel;
}

function avatarStorageRow(av) {
	const row = document.createElement('div');
	row.className = 'set-store-row';
	const state = { ...(av.storage || { primary: 'r2', r2_present: true, ipfs_pinned: false, ipfs_cid: null }) };

	function paint() {
		const pinned = !!state.ipfs_pinned;
		const real = isRealCid(state.ipfs_cid);
		row.innerHTML = `
			<img class="set-store-thumb" src="/api/avatars/${esc(av.id)}/thumb" width="44" height="44" loading="lazy"
				alt="Preview of ${esc(av.name || 'avatar')}" />
			<div class="set-store-meta">
				<div class="set-store-name">${esc(av.name || 'Untitled avatar')}</div>
				<div class="set-store-facts">
					${av.size_bytes ? `${esc(fmtBytes(av.size_bytes))} · ` : ''}
					<span class="dn-tag success">R2</span>
					${pinned
						? real
							? `<a class="dn-tag" href="${esc(IPFS_GATEWAY + state.ipfs_cid)}" target="_blank" rel="noopener" title="${esc(state.ipfs_cid)}" style="text-decoration:none">IPFS ${esc(shortCid(state.ipfs_cid))} ↗</a>`
							: `<span class="dn-tag warn" title="This deployment has no pinning provider, so a content hash was recorded instead of a real CID">Content hash only</span>`
						: `<span class="dn-tag">Not on IPFS</span>`}
				</div>
			</div>
			<div class="set-store-actions">
				<div class="set-seg" role="group" aria-label="Primary source for ${esc(av.name || 'avatar')}">
					<button type="button" class="set-seg-btn" data-primary="r2" aria-pressed="${state.primary !== 'ipfs'}">R2</button>
					<button type="button" class="set-seg-btn" data-primary="ipfs" aria-pressed="${state.primary === 'ipfs'}"
						${real ? '' : 'disabled title="Pin this avatar to IPFS first"'}>IPFS</button>
				</div>
				${real ? '' : `<button type="button" class="dn-btn" data-action="pin">Pin to IPFS</button>`}
			</div>
		`;
		wire();
	}

	function wire() {
		row.querySelector('[data-action="pin"]')?.addEventListener('click', async (e) => {
			const btn = e.currentTarget;
			btn.disabled = true;
			btn.textContent = 'Pinning…';
			try {
				const out = await post(`/api/avatars/${encodeURIComponent(av.id)}/pin-ipfs`, {});
				const mode = out?.storage_mode || {};
				state.ipfs_pinned = !!mode.ipfs?.pinned;
				state.ipfs_cid = mode.ipfs?.cid ?? null;
				toast(out?.stub
					? 'No pinning provider is configured, so a content hash was recorded instead of a CID'
					: 'Pinned to IPFS');
				paint();
			} catch (err) {
				toast(err?.message || 'Pin failed');
				btn.disabled = false;
				btn.textContent = 'Pin to IPFS';
			}
		});

		row.querySelectorAll('[data-primary]').forEach((btn) => {
			btn.addEventListener('click', async () => {
				const next = btn.dataset.primary;
				if (btn.disabled || next === state.primary) return;
				const seg = row.querySelectorAll('[data-primary]');
				seg.forEach((b) => { b.disabled = true; });
				try {
					// Re-read the full record before writing it back: the schema is
					// whole-object and the server owns the attestation block, so a
					// blind PUT of the flattened list row would be a lossy write.
					const current = await get(`/api/avatars/${encodeURIComponent(av.id)}/storage-mode`);
					const mode = current?.storage_mode;
					if (!mode) throw new Error('storage mode unavailable');
					await put(`/api/avatars/${encodeURIComponent(av.id)}/storage-mode`, { ...mode, primary: next });
					state.primary = next;
					toast(`Primary source set to ${next === 'ipfs' ? 'IPFS' : 'R2'}`);
				} catch (err) {
					toast(err?.message || 'Could not change the primary source');
				} finally {
					seg.forEach((b) => { b.disabled = false; });
					paint();
				}
			});
		});
	}

	paint();
	return row;
}

// ── Storage ────────────────────────────────────────────────────────────────

function renderStorage(resp, onRetry) {
	const panel = document.createElement('div');
	panel.className = 'dn-panel';
	panel.setAttribute('aria-label', 'Storage');

	if (!resp.ok) {
		panel.innerHTML = `
			<div style="margin-bottom:14px">
				<div class="dn-panel-title">Storage</div>
				<div class="dn-panel-sub" style="margin:2px 0 0">Disk usage across avatars and animation clips.</div>
			</div>
			<div data-slot="storage-err"></div>`;
		const errHost = panel.querySelector('[data-slot="storage-err"]');
		errHost.innerHTML = errorStateHTML({
			title: "Couldn't load storage usage",
			body: 'We couldn’t reach the billing service. Try again in a moment.',
		});
		attachRetry(errHost, onRetry);
		return panel;
	}

	const summary = resp.data || {};
	const usage = summary?.usage || {};
	const quotas = summary?.quotas || {};
	const totalBytes = usage.total_bytes ?? 0;
	const maxBytes = quotas.max_total_bytes ?? 0;
	const avatarCount = usage.avatar_count ?? 0;
	const maxAvatars = quotas.max_avatars ?? 0;

	panel.innerHTML = `
		<div style="margin-bottom:14px">
			<div class="dn-panel-title">Storage</div>
			<div class="dn-panel-sub" style="margin:2px 0 0">Disk usage across avatars and animation clips.</div>
		</div>
		<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:20px">
			${meter('Total storage', totalBytes, maxBytes, fmtBytes)}
			${meter('Avatars', avatarCount, maxAvatars, (n) => String(n))}
		</div>
		<div style="margin-top:14px;font-size:12.5px;color:var(--nxt-ink-dim)">
			${totalBytes > 0 ? `Using ${fmtBytes(totalBytes)}${maxBytes ? ` of ${fmtBytes(maxBytes)} on your plan.` : '.'}` : 'No usage data available.'}
			<a href="/dashboard/monetize" style="color:var(--nxt-accent);margin-left:8px">Upgrade plan →</a>
		</div>
	`;
	return panel;
}

function meter(label, used, max, fmt) {
	const pct = max ? Math.min(100, (used / max) * 100) : 0;
	const color = pct > 90 ? 'var(--nxt-danger)' : pct > 70 ? 'var(--nxt-warn)' : 'var(--nxt-accent)';
	return `
		<div>
			<div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:6px">
				<span>${esc(label)}</span>
				<span style="color:var(--nxt-ink-fade)">${esc(fmt(used))} ${max ? `/ ${esc(fmt(max))}` : ''}</span>
			</div>
			<div style="height:6px;border-radius:3px;background:var(--nxt-stroke);overflow:hidden">
				<div style="height:100%;width:${pct.toFixed(1)}%;background:${color};transition:width 400ms ease"></div>
			</div>
		</div>
	`;
}

function fmtBytes(n) {
	if (n >= 1e9) return (n / 1e9).toFixed(1) + ' GB';
	if (n >= 1e6) return (n / 1e6).toFixed(1) + ' MB';
	if (n >= 1e3) return Math.round(n / 1e3) + ' KB';
	return `${n} B`;
}

// ── LLM usage ─────────────────────────────────────────────────────────────

function renderLlmUsage(resp, onRetry) {
	const panel = document.createElement('div');
	panel.className = 'dn-panel';
	panel.setAttribute('aria-label', 'LLM usage');

	if (!resp.ok) {
		panel.innerHTML = `
			<div style="margin-bottom:14px">
				<div class="dn-panel-title">LLM usage</div>
				<div class="dn-panel-sub" style="margin:2px 0 0">AI inference calls your agents have made this month.</div>
			</div>
			<div data-slot="llm-err"></div>`;
		const errHost = panel.querySelector('[data-slot="llm-err"]');
		errHost.innerHTML = errorStateHTML({
			title: "Couldn't load usage",
			body: 'We couldn’t reach the usage service. Try again in a moment.',
		});
		attachRetry(errHost, onRetry);
		return panel;
	}

	const usageResp = resp.data || {};
	const llm = usageResp?.llm || usageResp || {};
	const callsMonth = llm.calls_month ?? llm.llm_calls_month ?? null;
	const tokensMonth = llm.tokens_month ?? llm.tokens_consumed ?? null;
	const byModel = Array.isArray(llm.by_model) ? llm.by_model : [];

	panel.innerHTML = `
		<div style="margin-bottom:14px">
			<div class="dn-panel-title">LLM usage</div>
			<div class="dn-panel-sub" style="margin:2px 0 0">AI inference calls your agents have made this month.</div>
		</div>
		${!callsMonth && !byModel.length
			? emptyStateHTML({ icon: '', title: 'No usage yet', body: 'LLM usage will appear here as your agents chat and reason.', compact: true })
			: `
				<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:${byModel.length ? '16px' : '0'}">
					${callsMonth != null ? statBox('Calls this month', callsMonth.toLocaleString()) : ''}
					${tokensMonth != null ? statBox('Tokens consumed', (tokensMonth >= 1e6 ? (tokensMonth / 1e6).toFixed(1) + 'M' : tokensMonth >= 1e3 ? (tokensMonth / 1e3).toFixed(1) + 'K' : String(tokensMonth))) : ''}
				</div>
				${byModel.length ? `
					<div style="font-size:12.5px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:var(--nxt-ink-fade);margin-bottom:8px">By model</div>
					<div style="overflow-x:auto">
						<table style="width:100%;border-collapse:collapse;font-size:13px">
							<thead>
								<tr style="text-align:left;color:var(--nxt-ink-fade);border-bottom:1px solid var(--nxt-stroke)">
									<th style="padding:8px 10px;font-weight:500">Model</th>
									<th style="padding:8px 10px;font-weight:500;text-align:right">Calls</th>
									<th style="padding:8px 10px;font-weight:500;text-align:right">Tokens</th>
								</tr>
							</thead>
							<tbody>
								${byModel.map((m) => `
									<tr style="border-bottom:1px solid var(--nxt-stroke)">
										<td style="padding:10px;font-family:${MONO};font-size:12px">${esc(m.model || m.name || '—')}</td>
										<td style="padding:10px;text-align:right;font-variant-numeric:tabular-nums">${(m.calls || 0).toLocaleString()}</td>
										<td style="padding:10px;text-align:right;font-variant-numeric:tabular-nums;color:var(--nxt-ink-dim)">${(m.tokens || 0).toLocaleString()}</td>
									</tr>
								`).join('')}
							</tbody>
						</table>
					</div>
				` : ''}
			`
		}
	`;
	return panel;
}

function statBox(label, value) {
	return `
		<div style="padding:12px;background:rgba(255,255,255,0.02);border-radius:8px;border:1px solid var(--nxt-stroke)">
			<div style="font-size:11.5px;color:var(--nxt-ink-fade);margin-bottom:6px">${esc(label)}</div>
			<div style="font-size:22px;font-weight:700;letter-spacing:-0.01em">${esc(value)}</div>
		</div>
	`;
}

// ── Vanity wallet tools ────────────────────────────────────────────────────

function renderVanityTools() {
	const panel = document.createElement('div');
	panel.className = 'dn-panel';
	panel.innerHTML = `
		<div style="margin-bottom:14px">
			<div class="dn-panel-title">Vanity wallets</div>
			<div class="dn-panel-sub" style="margin:2px 0 0">Generate wallet addresses that start with a custom prefix.</div>
		</div>
		<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px">
			<div style="padding:16px;border:1px solid var(--nxt-stroke);border-radius:10px">
				<div style="font-weight:600;margin-bottom:6px">Solana &amp; EVM wallets ✦</div>
				<div style="font-size:13px;color:var(--nxt-ink-dim);margin-bottom:12px">Grind a Solana or EVM keypair whose address starts or ends with text you choose, right in the dashboard.</div>
				<a class="dn-btn primary" href="/dashboard/wallet-grinder">Open grinder →</a>
			</div>
			<div style="padding:16px;border:1px solid var(--nxt-stroke);border-radius:10px">
				<div style="font-weight:600;margin-bottom:6px">ETH contract (CREATE2) ✦</div>
				<div style="font-size:13px;color:var(--nxt-ink-dim);margin-bottom:12px">Mine an Ethereum contract address with a custom prefix using a CREATE2 salt.</div>
				<a class="dn-btn primary" href="/eth-vanity" target="_blank" rel="noopener">Open tool ↗</a>
			</div>
		</div>
	`;
	return panel;
}

// ── Preferences ────────────────────────────────────────────────────────────

function renderPrefs(prefs) {
	const panel = document.createElement('div');
	panel.className = 'dn-panel';

	panel.innerHTML = `
		<div style="margin-bottom:14px">
			<div class="dn-panel-title">Preferences</div>
			<div class="dn-panel-sub" style="margin:2px 0 0">Dashboard display and notification settings.</div>
		</div>
		<div style="display:flex;flex-direction:column;gap:14px">
			${prefToggle('email_notifications', 'Email notifications', 'Receive account activity summaries by email', prefs.email_notifications ?? true)}
			${prefToggle('show_tips', 'Show onboarding tips', 'Display contextual help throughout the dashboard', prefs.show_tips ?? true)}
			${prefToggle('compact_mode', 'Compact sidebar', 'Collapse sidebar labels to icon-only mode', prefs.compact_mode ?? false)}
		</div>
		<div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--nxt-stroke);display:flex;justify-content:flex-end">
			<button class="dn-btn primary" data-action="save-prefs">Save preferences</button>
		</div>
	`;

	// role=switch buttons: click (and native Space/Enter on a <button>) flips state.
	panel.querySelectorAll('.set-switch').forEach((sw) => {
		sw.addEventListener('click', () => {
			sw.setAttribute('aria-checked', sw.getAttribute('aria-checked') === 'true' ? 'false' : 'true');
		});
	});

	panel.querySelector('[data-action="save-prefs"]').addEventListener('click', async (e) => {
		const btn = e.currentTarget;
		const newPrefs = {};
		panel.querySelectorAll('[data-pref-key]').forEach((el) => {
			newPrefs[el.dataset.prefKey] = el.getAttribute('aria-checked') === 'true';
		});
		btn.disabled = true;
		btn.textContent = 'Saving…';
		try {
			await patch('/api/dashboard/prefs', { prefs: newPrefs });
			toast('Preferences saved');
		} catch (err) {
			toast(err?.message || 'Save failed');
		} finally {
			btn.disabled = false;
			btn.textContent = 'Save preferences';
		}
	});

	return panel;
}

// ── Theme ─────────────────────────────────────────────────────────────────

function renderTheme() {
	const panel = document.createElement('div');
	panel.className = 'dn-panel';

	const stored = localStorage.getItem('twx_theme') || 'dark';

	panel.innerHTML = `
		<div style="margin-bottom:14px">
			<div class="dn-panel-title">Appearance</div>
			<div class="dn-panel-sub" style="margin:2px 0 0">Choose your dashboard color scheme.</div>
		</div>
		<div style="display:flex;gap:10px;flex-wrap:wrap" role="group" aria-label="Color scheme">
			${['dark', 'light', 'auto'].map((t) => `
				<button class="dn-btn set-theme-btn ${t === stored ? 'primary' : ''}" data-theme="${t}" type="button"
					aria-pressed="${t === stored}"
					style="min-width:90px;justify-content:center;text-transform:capitalize">
					${t === 'dark' ? '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M13.5 8.5a5.5 5.5 0 11-6-6 4.5 4.5 0 006 6z"/></svg>' : ''}
					${t === 'light' ? '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="8" cy="8" r="3"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.2 3.2l1.4 1.4M11.4 11.4l1.4 1.4M3.2 12.8l1.4-1.4M11.4 4.6l1.4-1.4"/></svg>' : ''}
					${t === 'auto' ? '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M8 3v10"/></svg>' : ''}
					${t}
				</button>
			`).join('')}
		</div>
		<div data-slot="theme-hint" style="margin-top:10px;font-size:12px;color:var(--nxt-ink-fade)">
			${stored === 'auto' ? 'Following your system preference.' : `Currently using ${stored} mode.`}
			Dark is the brand default; the theme toggle also lives in the top nav.
		</div>
	`;

	// Apply a theme choice through the shared switcher so it takes effect site-
	// wide and persists under the same key the nav toggle uses. Falls back to a
	// direct apply if the switcher script isn't loaded on this surface.
	function applyTheme(theme) {
		if (window.threeTheme) {
			window.threeTheme.set(theme);
			return;
		}
		localStorage.setItem('twx_theme', theme);
		const effective = theme === 'auto'
			? (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
			: theme;
		document.documentElement.setAttribute('data-theme', effective === 'light' ? 'light' : 'dark');
	}

	panel.querySelectorAll('[data-theme]').forEach((btn) => {
		btn.addEventListener('click', () => {
			const theme = btn.dataset.theme;
			applyTheme(theme);
			panel.querySelectorAll('[data-theme]').forEach((b) => {
				const on = b.dataset.theme === theme;
				b.classList.toggle('primary', on);
				b.setAttribute('aria-pressed', String(on));
			});
			// Address the hint by slot: `div:last-child` matched the panel subtitle
			// first (it is the last child of the header block), so every theme
			// click used to overwrite "Choose your dashboard color scheme." while
			// the real hint below kept reporting the previous theme.
			const hint = panel.querySelector('[data-slot="theme-hint"]');
			hint.textContent = theme === 'auto'
				? 'Following your system preference. The theme toggle also lives in the top nav.'
				: `Currently using ${theme} mode. The theme toggle also lives in the top nav.`;
			toast('Theme applied');
		});
	});

	return panel;
}

// ── Default network ───────────────────────────────────────────────────────

function renderDefaultNetwork(prefs) {
	const panel = document.createElement('div');
	panel.className = 'dn-panel';

	const current = prefs.default_network || localStorage.getItem('twx_default_network') || 'solana';

	panel.innerHTML = `
		<div style="margin-bottom:14px">
			<div class="dn-panel-title">Default payment network</div>
			<div class="dn-panel-sub" style="margin:2px 0 0">Select the default blockchain for payments and token operations.</div>
		</div>
		<div style="display:flex;gap:10px;flex-wrap:wrap" role="group" aria-label="Default payment network">
			${[
				{ value: 'solana', label: 'Solana', note: 'Fast, low-cost' },
				{ value: 'base', label: 'Base', note: 'Low-fee EVM L2' },
				{ value: 'polygon', label: 'Polygon', note: 'EVM L2' },
			].map((n) => `
				<button class="dn-btn set-net-btn ${n.value === current ? 'primary' : ''}" data-network="${n.value}" type="button"
					aria-pressed="${n.value === current}"
					style="min-width:120px;flex-direction:column;align-items:center;gap:4px;padding:14px 16px">
					<span style="font-weight:600;font-size:14px">${esc(n.label)}</span>
					<span style="font-size:11px;color:${n.value === current ? 'rgba(0,0,0,0.6)' : 'var(--nxt-ink-fade)'}">${esc(n.note)}</span>
				</button>
			`).join('')}
		</div>
	`;

	panel.querySelectorAll('[data-network]').forEach((btn) => {
		btn.addEventListener('click', async () => {
			const network = btn.dataset.network;
			localStorage.setItem('twx_default_network', network);
			panel.querySelectorAll('[data-network]').forEach((b) => {
				const on = b.dataset.network === network;
				b.classList.toggle('primary', on);
				b.setAttribute('aria-pressed', String(on));
				const sub = b.querySelector('span:last-child');
				if (sub) sub.style.color = on ? 'rgba(0,0,0,0.6)' : 'var(--nxt-ink-fade)';
			});
			try {
				await patch('/api/dashboard/prefs', { prefs: { default_network: network } });
			} catch { /* best-effort server save */ }
			toast(`Default network set to ${network}`);
		});
	});

	return panel;
}

// ── Data export ───────────────────────────────────────────────────────────

function renderDataExport() {
	const panel = document.createElement('div');
	panel.className = 'dn-panel';

	panel.innerHTML = `
		<div style="margin-bottom:14px">
			<div class="dn-panel-title">Data export</div>
			<div class="dn-panel-sub" style="margin:2px 0 0">Download a copy of your account data including agents, avatars, and settings.</div>
		</div>
		<div style="display:flex;gap:10px;flex-wrap:wrap">
			<button class="dn-btn" data-action="export-agents" type="button">
				<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M8 2v10M5 9l3 3 3-3"/><path d="M2 12v2h12v-2"/></svg>
				Export agents
			</button>
			<button class="dn-btn" data-action="export-avatars" type="button">
				<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M8 2v10M5 9l3 3 3-3"/><path d="M2 12v2h12v-2"/></svg>
				Export avatars
			</button>
			<button class="dn-btn" data-action="export-all" type="button">
				<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M8 2v10M5 9l3 3 3-3"/><path d="M2 12v2h12v-2"/></svg>
				Export all data (JSON)
			</button>
		</div>
	`;

	async function exportData(type) {
		const btn = panel.querySelector(`[data-action="export-${type}"]`);
		const originalHtml = btn.innerHTML;
		btn.disabled = true;
		btn.textContent = 'Exporting...';
		try {
			const calls = [];
			if (type === 'agents' || type === 'all') calls.push(get('/api/agents').catch(() => ({ agents: [] })));
			if (type === 'avatars' || type === 'all') calls.push(get('/api/avatars?limit=100').catch(() => ({ avatars: [] })));
			if (type === 'all') calls.push(get('/api/widgets').catch(() => ({ widgets: [] })));

			const results = await Promise.all(calls);
			const data = {};
			let i = 0;
			if (type === 'agents' || type === 'all') { data.agents = results[i]?.agents || []; i++; }
			if (type === 'avatars' || type === 'all') { data.avatars = results[i]?.avatars || []; i++; }
			if (type === 'all') { data.widgets = results[i]?.widgets || []; i++; }
			data.exported_at = new Date().toISOString();

			const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = `threews-${type}-${new Date().toISOString().slice(0, 10)}.json`;
			document.body.appendChild(a);
			a.click();
			a.remove();
			URL.revokeObjectURL(url);
			toast('Data exported');
		} catch (err) {
			toast(err?.message || 'Export failed');
		} finally {
			btn.disabled = false;
			btn.innerHTML = originalHtml;
		}
	}

	panel.querySelector('[data-action="export-agents"]').addEventListener('click', () => exportData('agents'));
	panel.querySelector('[data-action="export-avatars"]').addEventListener('click', () => exportData('avatars'));
	panel.querySelector('[data-action="export-all"]').addEventListener('click', () => exportData('all'));

	return panel;
}

// ── About ─────────────────────────────────────────────────────────────────

function renderAbout(versionResp) {
	const panel = document.createElement('div');
	panel.className = 'dn-panel';

	// The running build, read from /api/version (server/build-info). This used
	// to print `new Date()`, which made every visit claim the site was built
	// today no matter which revision was serving it.
	const build = versionResp?.ok ? versionResp.data || {} : null;
	const buildLabel = build
		? [build.version, build.commitShort].filter(Boolean).join(' · ') || 'unknown'
		: 'Unavailable';
	const buildTitle = build?.commit ? ` title="${esc(build.commit)}"` : '';
	const builtAt = build?.builtAt || build?.commitTime || null;

	panel.innerHTML = `
		<div style="margin-bottom:14px">
			<div class="dn-panel-title">About three.ws</div>
			<div class="dn-panel-sub" style="margin:2px 0 0">Platform information and helpful links.</div>
		</div>
		<div style="display:grid;grid-template-columns:auto 1fr;gap:8px 16px;font-size:13px;margin-bottom:16px">
			<span style="color:var(--nxt-ink-fade)">Platform</span>
			<span style="color:var(--nxt-ink)">three.ws</span>
			<span style="color:var(--nxt-ink-fade)">Dashboard</span>
			<span style="color:var(--nxt-ink)">dashboard-next</span>
			<span style="color:var(--nxt-ink-fade)">Build</span>
			<span style="color:var(--nxt-ink);font-family:${MONO};font-size:12px"${buildTitle}>${esc(buildLabel)}${builtAt ? ` <span style="color:var(--nxt-ink-fade)">(${esc(relTime(builtAt))})</span>` : ''}</span>
			<span style="color:var(--nxt-ink-fade)">Language</span>
			<span style="color:var(--nxt-ink)" data-slot="about-language">${esc(currentLanguageName())}</span>
		</div>
		<div style="display:flex;gap:10px;flex-wrap:wrap">
			<a class="dn-btn" href="/features" style="text-decoration:none">
				<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 4h12v12H4z"/><path d="M4 10h12M10 4v12"/></svg>
				Features
			</a>
			<a class="dn-btn" href="/tutorials" style="text-decoration:none">
				<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M1 3h5a2 2 0 012 2v9a1.5 1.5 0 00-1.5-1.5H1V3z"/><path d="M15 3h-5a2 2 0 00-2 2v9a1.5 1.5 0 011.5-1.5H15V3z"/></svg>
				Documentation
			</a>
			<a class="dn-btn" href="/community" style="text-decoration:none">
				<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="6" cy="6" r="2"/><circle cx="11" cy="6" r="1.5"/><path d="M1.5 13c.6-2.2 2.2-3.3 4.5-3.3s3.9 1.1 4.5 3.3"/></svg>
				Community
			</a>
			<a class="dn-btn" href="mailto:support@three.ws" style="text-decoration:none">
				<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1" y="3" width="14" height="10" rx="1.5"/><path d="M1 3l7 5 7-5"/></svg>
				Support
			</a>
		</div>
	`;

	// The runtime i18n layer swaps copy in place and fires i18n:change, so the
	// row follows the live locale instead of freezing at first paint.
	window.addEventListener('i18n:change', () => {
		const slot = panel.querySelector('[data-slot="about-language"]');
		if (slot) slot.textContent = currentLanguageName();
	});

	return panel;
}

/** The language the page is actually rendering in, named in that language.
 *  src/i18n.js writes the active locale onto <html lang>, so that tag is the
 *  single source of truth for both the runtime and this row. */
function currentLanguageName() {
	const code = document.documentElement.lang || 'en';
	try {
		return new Intl.DisplayNames([code], { type: 'language' }).of(code) || code;
	} catch {
		return code;
	}
}

function prefToggle(key, label, description, checked) {
	const labelId = `pref-${key}-label`;
	const descId = `pref-${key}-desc`;
	return `
		<div class="set-toggle-row">
			<div class="set-toggle-text">
				<div class="set-toggle-label" id="${labelId}">${esc(label)}</div>
				<div class="set-toggle-desc" id="${descId}">${esc(description)}</div>
			</div>
			<button type="button" role="switch" class="set-switch" data-pref-key="${esc(key)}"
				aria-checked="${checked ? 'true' : 'false'}"
				aria-labelledby="${esc(labelId)}" aria-describedby="${esc(descId)}"></button>
		</div>
	`;
}
