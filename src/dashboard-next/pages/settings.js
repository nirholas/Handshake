// dashboard-next — Settings page.
//
// Consolidates everything that doesn't fit in Account or Monetize:
//   • Active sessions (list + revoke)
//   • Notifications (list + mark-read)
//   • Storage usage (avatar files, animation clips)
//   • LLM usage (calls this month, tokens consumed, by model)
//   • App preferences (dashboard prefs via /api/dashboard/prefs)
//   • Vanity wallet shortcuts (SOL vanity + ETH CREATE2)
//
// Real endpoints:
//   GET  /api/auth/sessions                 { sessions: [...] }
//   DELETE /api/auth/sessions/:id
//   GET  /api/notifications                 { notifications: [...], unread: N }
//   POST /api/notifications/read-all
//   GET  /api/billing/summary               { usage: { total_bytes, avatar_count, ... } }
//   GET  /api/usage/summary                 { llm: { calls_month, tokens_month, by_model } }
//   GET  /api/dashboard/prefs               { prefs }
//   PATCH /api/dashboard/prefs              body prefs patch

import { mountShell } from '../shell.js';
import { requireUser, get, post, del, patch, esc, relTime, ApiError } from '../api.js';

const MONO = `'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace`;

function toast(msg) {
	let el = document.getElementById('dn-toast');
	if (!el) {
		el = document.createElement('div');
		el.id = 'dn-toast';
		el.style.cssText = `
			position:fixed;left:50%;bottom:32px;transform:translateX(-50%) translateY(20px);
			background:rgba(20,21,28,0.95);border:1px solid var(--nxt-stroke-strong);
			color:var(--nxt-ink);padding:9px 16px;border-radius:999px;font-size:13px;
			z-index:9999;opacity:0;transition:opacity .18s,transform .18s;
			backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);
			box-shadow:0 8px 24px rgba(0,0,0,0.4);pointer-events:none;`;
		document.body.appendChild(el);
	}
	el.textContent = msg;
	requestAnimationFrame(() => {
		el.style.opacity = '1';
		el.style.transform = 'translateX(-50%) translateY(0)';
	});
	clearTimeout(el._t);
	el._t = setTimeout(() => {
		el.style.opacity = '0';
		el.style.transform = 'translateX(-50%) translateY(20px)';
	}, 1800);
}

(async function boot() {
	try {
		const main = await mountShell();
		await requireUser();

		main.innerHTML = `
			<h1 class="dn-h1">Settings</h1>
			<p class="dn-h1-sub">Sessions, storage, usage, notifications, and preferences.</p>
			<div data-slot="content" style="display:flex;flex-direction:column;gap:16px">
				${Array.from({ length: 4 }).map(() => `<div class="dn-skeleton" style="height:120px;border-radius:12px"></div>`).join('')}
			</div>
		`;

		const host = main.querySelector('[data-slot="content"]');

		const [sessionsResp, notifResp, summaryResp, usageResp, prefsResp] = await Promise.all([
			safeGet('/api/auth/sessions'),
			safeGet('/api/notifications?limit=20'),
			safeGet('/api/billing/summary'),
			safeGet('/api/usage/summary'),
			safeGet('/api/dashboard/prefs'),
		]);

		host.innerHTML = '';
		host.appendChild(renderTheme());
		host.appendChild(renderSessions(sessionsResp?.sessions || []));
		host.appendChild(renderNotifications(notifResp));
		host.appendChild(renderDefaultNetwork(prefsResp?.prefs || prefsResp || {}));
		host.appendChild(renderStorage(summaryResp));
		host.appendChild(renderLlmUsage(usageResp));
		host.appendChild(renderVanityTools());
		host.appendChild(renderPrefs(prefsResp?.prefs || prefsResp || {}));
		host.appendChild(renderDataExport());
		host.appendChild(renderAbout());
	} catch (err) {
		if (err instanceof ApiError && err.status === 401) {
			location.href = `/login?return=${encodeURIComponent(location.pathname)}`;
		} else {
			throw err;
		}
	}
})();

async function safeGet(url) {
	try { return await get(url); }
	catch { return null; }
}

// ── Sessions ───────────────────────────────────────────────────────────────

function renderSessions(sessions) {
	const panel = document.createElement('div');
	panel.className = 'dn-panel';

	const now = new Date();

	panel.innerHTML = `
		<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:14px">
			<div>
				<div class="dn-panel-title">Active sessions</div>
				<div class="dn-panel-sub" style="margin:2px 0 0">Devices signed in to your account.</div>
			</div>
			${sessions.length > 1 ? `<button class="dn-btn danger" data-action="revoke-all">Revoke all other</button>` : ''}
		</div>
		<div data-slot="sessions-list"></div>
	`;

	const listHost = panel.querySelector('[data-slot="sessions-list"]');

	function renderList(list) {
		if (!list.length) {
			listHost.innerHTML = `<div class="dn-empty" style="padding:24px"><h3>No session data</h3><p>Session tracking may not be enabled on this account.</p></div>`;
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
			await post('/api/auth/sessions/revoke-others', {});
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

function renderNotifications(resp) {
	const panel = document.createElement('div');
	panel.className = 'dn-panel';

	const notifications = resp?.notifications || [];
	const unread = resp?.unread ?? notifications.filter((n) => !n.read_at).length;

	panel.innerHTML = `
		<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:14px">
			<div>
				<div class="dn-panel-title">Notifications ${unread > 0 ? `<span class="dn-tag warn" style="margin-left:6px">${unread} unread</span>` : ''}</div>
				<div class="dn-panel-sub" style="margin:2px 0 0">Recent activity and platform messages.</div>
			</div>
			${unread > 0 ? `<button class="dn-btn" data-action="mark-all-read">Mark all read</button>` : ''}
		</div>
		<div data-slot="notif-list"></div>
	`;

	const listHost = panel.querySelector('[data-slot="notif-list"]');

	if (!notifications.length) {
		listHost.innerHTML = `<div class="dn-empty" style="padding:24px"><h3>No notifications</h3><p>You're all caught up.</p></div>`;
	} else {
		listHost.innerHTML = notifications.map((n) => `
			<div style="display:flex;gap:12px;padding:12px 0;border-bottom:1px solid var(--nxt-stroke);opacity:${n.read_at ? '0.6' : '1'}">
				<div style="flex:1">
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
			panel.querySelector('.dn-panel-title').innerHTML = 'Notifications';
			listHost.querySelectorAll('[style]').forEach((el) => { el.style.opacity = '0.6'; });
		} catch (err) {
			toast(err?.message || 'Failed');
			btn.disabled = false;
			btn.textContent = 'Mark all read';
		}
	});

	return panel;
}

// ── Storage ────────────────────────────────────────────────────────────────

function renderStorage(summary) {
	const panel = document.createElement('div');
	panel.className = 'dn-panel';

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

function renderLlmUsage(usageResp) {
	const panel = document.createElement('div');
	panel.className = 'dn-panel';

	const llm = usageResp?.llm || usageResp || {};
	const callsMonth = llm.calls_month ?? llm.llm_calls_month ?? null;
	const tokensMonth = llm.tokens_month ?? llm.tokens_consumed ?? null;
	const byModel = Array.isArray(llm.by_model) ? llm.by_model : [];

	panel.innerHTML = `
		<div style="margin-bottom:14px">
			<div class="dn-panel-title">LLM usage</div>
			<div class="dn-panel-sub" style="margin:2px 0 0">AI inference calls your agents have made this month.</div>
		</div>
		${callsMonth == null && !byModel.length
			? `<div class="dn-empty" style="padding:24px"><h3>No usage data</h3><p>LLM usage will appear here as your agents chat and reason.</p></div>`
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
				<div style="font-weight:600;margin-bottom:6px">Solana vanity ✦</div>
				<div style="font-size:13px;color:var(--nxt-ink-dim);margin-bottom:12px">Generate a Solana keypair where the address starts with text you choose.</div>
				<a class="dn-btn primary" href="/vanity-wallet" target="_blank" rel="noopener">Open tool ↗</a>
			</div>
			<div style="padding:16px;border:1px solid var(--nxt-stroke);border-radius:10px">
				<div style="font-weight:600;margin-bottom:6px">ETH vanity (CREATE2) ✦</div>
				<div style="font-size:13px;color:var(--nxt-ink-dim);margin-bottom:12px">Mine an Ethereum contract address with a custom prefix using CREATE2.</div>
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

	panel.querySelector('[data-action="save-prefs"]').addEventListener('click', async (e) => {
		const btn = e.currentTarget;
		const newPrefs = {};
		panel.querySelectorAll('[data-pref-key]').forEach((el) => {
			newPrefs[el.dataset.prefKey] = el.checked;
		});
		btn.disabled = true;
		btn.textContent = 'Saving…';
		try {
			await patch('/api/dashboard/prefs', newPrefs);
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
		<div style="display:flex;gap:10px;flex-wrap:wrap">
			${['dark', 'light', 'auto'].map((t) => `
				<button class="dn-btn ${t === stored ? 'primary' : ''}" data-theme="${t}" type="button"
					style="min-width:90px;justify-content:center;text-transform:capitalize">
					${t === 'dark' ? '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M13.5 8.5a5.5 5.5 0 11-6-6 4.5 4.5 0 006 6z"/></svg>' : ''}
					${t === 'light' ? '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="8" cy="8" r="3"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.2 3.2l1.4 1.4M11.4 11.4l1.4 1.4M3.2 12.8l1.4-1.4M11.4 4.6l1.4-1.4"/></svg>' : ''}
					${t === 'auto' ? '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M8 3v10"/></svg>' : ''}
					${t}
				</button>
			`).join('')}
		</div>
		<div style="margin-top:10px;font-size:12px;color:var(--nxt-ink-fade)">
			${stored === 'auto' ? 'Following your system preference.' : `Currently using ${stored} mode.`}
			The platform is designed for dark mode. Light mode support is coming.
		</div>
	`;

	panel.querySelectorAll('[data-theme]').forEach((btn) => {
		btn.addEventListener('click', () => {
			const theme = btn.dataset.theme;
			localStorage.setItem('twx_theme', theme);
			panel.querySelectorAll('[data-theme]').forEach((b) => {
				b.classList.toggle('primary', b.dataset.theme === theme);
			});
			const hint = panel.querySelector('div:last-child');
			hint.textContent = theme === 'auto'
				? 'Following your system preference.'
				: `Set to ${theme} mode. The platform is designed for dark mode. Light mode support is coming.`;
			toast('Theme preference saved');
		});
	});

	return panel;
}

// ── Default network ───────────────────────────────────────────────────────

function renderDefaultNetwork(prefs) {
	const panel = document.createElement('div');
	panel.className = 'dn-panel';

	const current = prefs.default_network || localStorage.getItem('twx_default_network') || 'base';

	panel.innerHTML = `
		<div style="margin-bottom:14px">
			<div class="dn-panel-title">Default payment network</div>
			<div class="dn-panel-sub" style="margin:2px 0 0">Select the default blockchain for payments and token operations.</div>
		</div>
		<div style="display:flex;gap:10px;flex-wrap:wrap">
			${[
				{ value: 'base', label: 'Base', note: 'Low-fee EVM L2' },
				{ value: 'solana', label: 'Solana', note: 'Fast, low-cost' },
				{ value: 'polygon', label: 'Polygon', note: 'EVM L2' },
			].map((n) => `
				<button class="dn-btn ${n.value === current ? 'primary' : ''}" data-network="${n.value}" type="button"
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
				b.classList.toggle('primary', b.dataset.network === network);
				const sub = b.querySelector('span:last-child');
				if (sub) sub.style.color = b.dataset.network === network ? 'rgba(0,0,0,0.6)' : 'var(--nxt-ink-fade)';
			});
			try {
				await patch('/api/dashboard/prefs', { default_network: network });
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

function renderAbout() {
	const panel = document.createElement('div');
	panel.className = 'dn-panel';

	const buildDate = new Date().toISOString().slice(0, 10);

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
			<span style="color:var(--nxt-ink);font-family:${MONO};font-size:12px">${esc(buildDate)}</span>
			<span style="color:var(--nxt-ink-fade)">Language</span>
			<span style="color:var(--nxt-ink)">English</span>
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

	return panel;
}

function prefToggle(key, label, description, checked) {
	return `
		<label style="display:flex;align-items:center;justify-content:space-between;gap:16px;cursor:pointer">
			<div>
				<div style="font-size:13.5px;color:var(--nxt-ink);font-weight:500">${esc(label)}</div>
				<div style="font-size:12.5px;color:var(--nxt-ink-dim);margin-top:2px">${esc(description)}</div>
			</div>
			<input type="checkbox" data-pref-key="${esc(key)}" ${checked ? 'checked' : ''}
				style="width:18px;height:18px;cursor:pointer;accent-color:var(--nxt-accent);flex-shrink:0" />
		</label>
	`;
}
