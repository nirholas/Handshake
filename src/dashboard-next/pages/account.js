// dashboard-next — Account page.
//
// Consolidates profile, linked wallets, SNS domains, delegation entry,
// and the audit trail behind a single sidebar destination.

import { mountShell } from '../shell.js';
import { requireUser, get, post, patch, del, esc, relTime, initialsOf } from '../api.js';

const CHAIN_STYLES = {
	solana:   { label: 'Solana',   bg: 'rgba(154, 124, 255, 0.16)', border: 'rgba(154, 124, 255, 0.32)', ink: '#c7b6ff' },
	base:     { label: 'Base',     bg: 'rgba(0, 82, 255, 0.16)',    border: 'rgba(0, 82, 255, 0.32)',    ink: '#7aa9ff' },
	ethereum: { label: 'Ethereum', bg: 'rgba(150, 160, 175, 0.14)', border: 'rgba(150, 160, 175, 0.28)', ink: '#c5cbd5' },
	polygon:  { label: 'Polygon',  bg: 'rgba(231, 41, 169, 0.14)',  border: 'rgba(231, 41, 169, 0.28)',  ink: '#ef8acf' },
	optimism: { label: 'Optimism', bg: 'rgba(255, 4, 32, 0.14)',    border: 'rgba(255, 4, 32, 0.28)',    ink: '#ff8088' },
	evm:      { label: 'EVM',      bg: 'rgba(150, 160, 175, 0.14)', border: 'rgba(150, 160, 175, 0.28)', ink: '#c5cbd5' },
};

const MONO = `'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace`;

const CATEGORY_BY_ACTION = [
	[/^(link_wallet|unlink_wallet|set_primary_wallet|password_|email_|login|logout|session|revoke_oauth_token)/, 'Auth'],
	[/^(avatar_|create_avatar|delete_avatar|upload_avatar)/,             'Avatar'],
	[/^(widget_|embed_)/,                                                'Widget'],
	[/^(payment_|invoice_|payout_|withdraw_|stripe_|x402_)/,             'Payment'],
	[/^(api_key|key_|revoke_api_key|delegate_|delegation_)/,             'Auth'],
];

function categoryOf(action) {
	const a = String(action || '');
	for (const [re, cat] of CATEGORY_BY_ACTION) if (re.test(a)) return cat;
	return 'Settings';
}

function chainKey(w) {
	const t = String(w.chain_type || '').toLowerCase();
	if (t === 'solana') return 'solana';
	const id = Number(w.chain_id);
	if (id === 8453 || id === 84532) return 'base';
	if (id === 1 || id === 11155111) return 'ethereum';
	if (id === 137 || id === 80001 || id === 80002) return 'polygon';
	if (id === 10 || id === 11155420) return 'optimism';
	return 'evm';
}

function chainChip(w) {
	const style = CHAIN_STYLES[chainKey(w)] || CHAIN_STYLES.evm;
	return `<span class="dn-tag" style="background:${style.bg};border-color:${style.border};color:${style.ink}">${style.label}</span>`;
}

function truncMid(s, head = 6, tail = 4) {
	const str = String(s || '');
	if (str.length <= head + tail + 1) return str;
	return `${str.slice(0, head)}…${str.slice(-tail)}`;
}

function toast(msg) {
	let el = document.getElementById('dn-toast');
	if (!el) {
		el = document.createElement('div');
		el.id = 'dn-toast';
		el.style.cssText = `
			position:fixed;left:50%;bottom:32px;transform:translateX(-50%) translateY(20px);
			background:rgba(20,21,28,0.95);border:1px solid var(--nxt-stroke-strong);
			color:var(--nxt-ink);padding:9px 16px;border-radius:999px;font-size:13px;
			z-index:9999;opacity:0;transition:opacity .18s, transform .18s;
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
	}, 1600);
}

async function copyToClipboard(text) {
	try {
		await navigator.clipboard.writeText(text);
		toast('Copied');
	} catch {
		const t = document.createElement('textarea');
		t.value = text;
		t.style.position = 'fixed';
		t.style.opacity = '0';
		document.body.appendChild(t);
		t.select();
		try { document.execCommand('copy'); toast('Copied'); } catch { toast('Copy failed'); }
		document.body.removeChild(t);
	}
}

(async function boot() {
	const main = await mountShell();
	const me = await requireUser();

	main.innerHTML = `
		<h1 class="dn-h1">Account</h1>
		<p class="dn-h1-sub">Profile, wallets, and the audit trail.</p>

		<div style="display:grid;gap:16px">
			<section class="dn-panel" data-section="profile">
				<div data-slot="profile"></div>
			</section>

			<section class="dn-panel" data-section="wallets">
				<div style="display:flex;justify-content:space-between;align-items:start;gap:16px;margin-bottom:14px;flex-wrap:wrap">
					<div>
						<div class="dn-panel-title">Linked wallets</div>
						<div class="dn-panel-sub" style="margin:0">Addresses that can claim royalties, pay for subscriptions, or sign as you.</div>
					</div>
					<a class="dn-btn primary" href="/dashboard/wallets" data-link="wallets">+ Link wallet</a>
				</div>
				<div data-slot="wallets"><div class="dn-skeleton" style="height:120px"></div></div>
			</section>

			<section class="dn-panel" data-section="sns">
				<div style="display:flex;justify-content:space-between;align-items:start;gap:16px;margin-bottom:14px;flex-wrap:wrap">
					<div>
						<div class="dn-panel-title">SNS &amp; handle domains</div>
						<div class="dn-panel-sub" style="margin:0">.sol domains you own that point at one of your linked wallets.</div>
					</div>
					<a class="dn-btn" href="/vanity-wallet">+ Register a domain</a>
				</div>
				<div data-slot="sns"><div class="dn-skeleton" style="height:80px"></div></div>
			</section>

			<section class="dn-panel" data-section="delegation">
				<div style="display:flex;justify-content:space-between;align-items:start;gap:16px;margin-bottom:14px;flex-wrap:wrap">
					<div>
						<div class="dn-panel-title">Delegation</div>
						<div class="dn-panel-sub" style="margin:0">Let one of your agents answer on behalf of another, or hand off to a partner agent.</div>
					</div>
					<a class="dn-btn" href="/dashboard/delegation">Open delegation console →</a>
				</div>
				<div data-slot="delegation"><div class="dn-skeleton" style="height:80px"></div></div>
			</section>

			<section class="dn-panel" data-section="actions">
				<div style="display:flex;justify-content:space-between;align-items:start;gap:16px;margin-bottom:14px;flex-wrap:wrap">
					<div>
						<div class="dn-panel-title">Action log</div>
						<div class="dn-panel-sub" style="margin:0">Sensitive operations on your account — wallet links, key issuance, sign-ins.</div>
					</div>
					<button class="dn-btn" data-action="export-csv">Export CSV</button>
				</div>
				<div data-slot="actions"><div class="dn-skeleton" style="height:200px"></div></div>
			</section>
		</div>
	`;

	renderProfile(main.querySelector('[data-slot="profile"]'), me);

	const walletsHost = main.querySelector('[data-slot="wallets"]');
	const snsHost = main.querySelector('[data-slot="sns"]');
	const delegationHost = main.querySelector('[data-slot="delegation"]');
	const actionsHost = main.querySelector('[data-slot="actions"]');

	const wallets = await loadWallets(walletsHost);
	renderSns(snsHost, wallets);
	loadDelegations(delegationHost);
	loadActions(actionsHost);

	main.querySelector('[data-action="export-csv"]').addEventListener('click', async (e) => {
		const btn = e.currentTarget;
		const originalText = btn.textContent;
		btn.disabled = true;
		btn.textContent = 'Exporting…';
		try {
			const res = await fetch('/api/audit-log?format=csv', { credentials: 'include' });
			if (!res.ok) {
				if (res.status === 404) toast('Audit log endpoint not deployed yet');
				else if (res.status === 401) toast('Sign in required');
				else toast(`Export failed: HTTP ${res.status}`);
				return;
			}
			const blob = await res.blob();
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
			document.body.appendChild(a);
			a.click();
			a.remove();
			URL.revokeObjectURL(url);
			toast('CSV downloaded');
		} catch (err) {
			toast(err?.message ? `Export failed: ${err.message}` : 'Export failed');
		} finally {
			btn.disabled = false;
			btn.textContent = originalText;
		}
	});
})();

// ── Profile ───────────────────────────────────────────────────────────────

function renderProfile(host, me) {
	const initials = initialsOf(me);
	const handle = me.username || me.handle || (me.email ? me.email.split('@')[0] : '');
	const verified = me.email_verified
		? `<span class="dn-tag success" style="margin-left:8px">verified</span>`
		: `<span class="dn-tag warn" style="margin-left:8px">unverified</span>`;
	const memberSince = me.created_at ? relTime(me.created_at) : '—';
	const planName = me.plan || 'free';

	host.innerHTML = `
		<div style="display:flex;gap:18px;align-items:center;flex-wrap:wrap">
			<div style="
				width:72px;height:72px;border-radius:50%;
				display:grid;place-items:center;
				background:linear-gradient(135deg, rgba(154,124,255,0.4), rgba(109,193,255,0.3));
				color:#fff;font-size:24px;font-weight:600;letter-spacing:-0.01em;
				border:1px solid rgba(255,255,255,0.12);
				flex-shrink:0;
			">${esc(initials)}</div>

			<div style="flex:1;min-width:240px">
				<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px" data-slot="name-row">
					<span data-slot="name-text" style="font-size:20px;font-weight:600;letter-spacing:-0.01em">${esc(me.display_name || handle || 'Unnamed')}</span>
					<button class="dn-btn ghost" data-action="edit-name" title="Edit display name" style="padding:4px 6px;color:var(--nxt-ink-fade)" aria-label="Edit display name">
						<svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3l3 3-9 9H5v-3l9-9z"/></svg>
					</button>
				</div>
				<div style="color:var(--nxt-ink-dim);font-size:13px">
					${handle ? `@${esc(handle)}` : ''}${handle && me.email ? ' · ' : ''}${me.email ? esc(me.email) : ''}${me.email ? verified : ''}
				</div>
				<div style="color:var(--nxt-ink-fade);font-size:12.5px;margin-top:6px">
					Member since ${esc(memberSince)} · Plan: <a href="/dashboard-next/monetize" style="color:var(--nxt-accent)">${esc(planName)}</a>
				</div>
			</div>

			<button class="dn-btn ghost" data-action="signout" style="align-self:flex-start">Sign out</button>
		</div>
	`;

	host.querySelector('[data-action="edit-name"]').addEventListener('click', () => {
		startEditName(host, me);
	});
	host.querySelector('[data-action="signout"]').addEventListener('click', async (e) => {
		const btn = e.currentTarget;
		btn.disabled = true;
		btn.textContent = 'Signing out…';
		try {
			await post('/api/auth/logout', {});
		} catch { /* destroy session is best-effort */ }
		window.location.href = '/';
	});
}

function startEditName(host, me) {
	const row = host.querySelector('[data-slot="name-row"]');
	const current = me.display_name || '';
	row.innerHTML = `
		<input type="text" value="${esc(current)}" maxlength="60" style="
			background:rgba(255,255,255,0.04);
			border:1px solid var(--nxt-stroke-strong);
			border-radius:6px;padding:6px 10px;color:var(--nxt-ink);
			font-size:19px;font-weight:600;letter-spacing:-0.01em;
			min-width:200px;max-width:420px;
		" />
		<button class="dn-btn primary" data-action="save-name" style="padding:6px 12px">Save</button>
		<button class="dn-btn ghost" data-action="cancel-name" style="padding:6px 10px">Cancel</button>
	`;
	const input = row.querySelector('input');
	input.focus();
	input.select();

	const cancel = () => renderProfile(host, me);
	const save = async () => {
		const next = input.value.trim();
		if (!next || next === current) return cancel();
		const saveBtn = row.querySelector('[data-action="save-name"]');
		saveBtn.disabled = true;
		saveBtn.textContent = 'Saving…';
		try {
			const r = await patch('/api/auth/profile', { display_name: next });
			const updated = r?.user || { ...me, display_name: next };
			renderProfile(host, { ...me, ...updated, display_name: updated.display_name ?? next });
			toast('Saved');
		} catch (err) {
			toast(err?.message ? `Save failed: ${err.message}` : 'Save failed');
			saveBtn.disabled = false;
			saveBtn.textContent = 'Save';
		}
	};

	row.querySelector('[data-action="save-name"]').addEventListener('click', save);
	row.querySelector('[data-action="cancel-name"]').addEventListener('click', cancel);
	input.addEventListener('keydown', (e) => {
		if (e.key === 'Enter') save();
		else if (e.key === 'Escape') cancel();
	});
}

// ── Wallets ───────────────────────────────────────────────────────────────

async function loadWallets(host) {
	try {
		const r = await get('/api/auth/wallets');
		const wallets = Array.isArray(r?.wallets) ? r.wallets : [];
		renderWallets(host, wallets);
		return wallets;
	} catch (err) {
		host.innerHTML = `<div class="dn-empty"><h3>Couldn't load wallets</h3><p>${esc(err?.message || 'Try again in a moment.')}</p></div>`;
		return [];
	}
}

function renderWallets(host, wallets) {
	if (wallets.length === 0) {
		host.innerHTML = `
			<div class="dn-empty">
				<h3>No wallets linked</h3>
				<p>Link a wallet so you can claim royalties, pay for subscriptions, or sign as you.</p>
				<a class="dn-btn primary" href="/dashboard/wallets">+ Link wallet</a>
			</div>`;
		return;
	}

	const rows = wallets.map((w) => {
		const isPrimary = !!w.is_primary;
		const star = isPrimary
			? `<svg width="13" height="13" viewBox="0 0 20 20" fill="#ffd479" stroke="#e8a934" stroke-width="1" style="margin-right:4px;flex-shrink:0"><path d="M10 2l2.4 5.4 5.9.6-4.4 4 1.3 5.9L10 14.7 4.8 17.9l1.3-5.9-4.4-4 5.9-.6L10 2z"/></svg>`
			: '';
		return `
			<tr data-address="${esc(w.address)}">
				<td style="padding:11px 12px;white-space:nowrap">
					<span style="display:inline-flex;align-items:center">${star}${chainChip(w)}</span>
				</td>
				<td style="padding:11px 12px">
					<button class="dn-copy" data-copy="${esc(w.address)}" title="${esc(w.address)} · click to copy" style="
						font-family:${MONO};font-size:12.5px;
						background:transparent;border:none;color:var(--nxt-ink);
						padding:0;cursor:pointer;letter-spacing:0.01em;
					">${esc(truncMid(w.address, 8, 6))}</button>
				</td>
				<td style="padding:11px 12px;color:var(--nxt-ink-dim);font-size:12.5px;white-space:nowrap">${esc(w.created_at ? relTime(w.created_at) : '—')}</td>
				<td style="padding:11px 12px;color:var(--nxt-ink-dim);font-size:12.5px;white-space:nowrap">
					${isPrimary ? '<span class="dn-tag" style="background:rgba(255,212,121,0.12);border-color:rgba(255,212,121,0.28);color:#ffd479">primary</span>' : ''}
				</td>
				<td style="padding:11px 12px;text-align:right;white-space:nowrap">
					<div style="display:inline-flex;gap:6px">
						${isPrimary ? '' : `<button class="dn-btn" data-action="make-primary" data-address="${esc(w.address)}" style="padding:5px 10px;font-size:12px">Make primary</button>`}
						<button class="dn-btn danger" data-action="unlink" data-address="${esc(w.address)}" style="padding:5px 10px;font-size:12px">Disconnect</button>
					</div>
				</td>
			</tr>
		`;
	}).join('');

	host.innerHTML = `
		<div style="overflow-x:auto;border:1px solid var(--nxt-stroke);border-radius:var(--nxt-radius-sm)">
			<table style="width:100%;border-collapse:collapse">
				<thead>
					<tr style="background:rgba(255,255,255,0.02);text-align:left">
						<th style="padding:9px 12px;font-size:11.5px;color:var(--nxt-ink-fade);font-weight:500;text-transform:uppercase;letter-spacing:0.04em">Chain</th>
						<th style="padding:9px 12px;font-size:11.5px;color:var(--nxt-ink-fade);font-weight:500;text-transform:uppercase;letter-spacing:0.04em">Address</th>
						<th style="padding:9px 12px;font-size:11.5px;color:var(--nxt-ink-fade);font-weight:500;text-transform:uppercase;letter-spacing:0.04em">Linked</th>
						<th style="padding:9px 12px;font-size:11.5px;color:var(--nxt-ink-fade);font-weight:500;text-transform:uppercase;letter-spacing:0.04em"></th>
						<th style="padding:9px 12px"></th>
					</tr>
				</thead>
				<tbody>${rows}</tbody>
			</table>
		</div>
	`;

	host.querySelectorAll('.dn-copy').forEach((btn) => {
		btn.addEventListener('click', () => copyToClipboard(btn.dataset.copy));
	});
	host.querySelectorAll('[data-action="unlink"]').forEach((btn) => {
		btn.addEventListener('click', async () => {
			const addr = btn.dataset.address;
			if (!confirm(`Disconnect ${truncMid(addr, 6, 4)} from this account?`)) return;
			btn.disabled = true;
			btn.textContent = 'Disconnecting…';
			try {
				await del(`/api/auth/wallets/${encodeURIComponent(addr)}`);
				toast('Wallet disconnected');
				const tr = btn.closest('tr');
				if (tr) tr.remove();
				const remaining = host.querySelectorAll('tbody tr').length;
				if (remaining === 0) renderWallets(host, []);
			} catch (err) {
				toast(err?.message ? `Failed: ${err.message}` : 'Disconnect failed');
				btn.disabled = false;
				btn.textContent = 'Disconnect';
			}
		});
	});
	host.querySelectorAll('[data-action="make-primary"]').forEach((btn) => {
		btn.addEventListener('click', async () => {
			const addr = btn.dataset.address;
			btn.disabled = true;
			btn.textContent = 'Setting…';
			try {
				await post('/api/auth/wallets/primary', { address: addr });
				toast('Primary wallet updated');
				const r = await get('/api/auth/wallets');
				renderWallets(host, Array.isArray(r?.wallets) ? r.wallets : []);
			} catch (err) {
				toast(err?.message ? `Failed: ${err.message}` : 'Couldn’t set primary');
				btn.disabled = false;
				btn.textContent = 'Make primary';
			}
		});
	});
}

// ── SNS ───────────────────────────────────────────────────────────────────

async function renderSns(host, wallets) {
	const solanaWallets = wallets.filter((w) => chainKey(w) === 'solana');
	if (solanaWallets.length === 0) {
		host.innerHTML = `
			<div class="dn-empty" style="padding:32px 24px">
				<h3>No Solana wallets linked</h3>
				<p>SNS .sol domains live on Solana — link a Solana wallet to surface the domains it owns.</p>
			</div>`;
		return;
	}

	host.innerHTML = `<div data-slot="sns-rows"><div class="dn-skeleton" style="height:60px"></div></div>`;
	const rowsHost = host.querySelector('[data-slot="sns-rows"]');

	const lookups = await Promise.all(
		solanaWallets.map(async (w) => {
			try {
				const r = await get(`/api/sns?address=${encodeURIComponent(w.address)}`);
				return { wallet: w, domain: r?.data?.name || null, status: 'Active' };
			} catch (err) {
				return { wallet: w, domain: null, status: err?.status === 404 ? null : 'error' };
			}
		}),
	);

	const hits = lookups.filter((l) => l.domain);
	if (hits.length === 0) {
		rowsHost.innerHTML = `
			<div class="dn-empty" style="padding:32px 24px">
				<h3>No primary .sol domains found</h3>
				<p>Set one of your wallets' primary .sol domain on-chain — it'll show up here automatically.</p>
				<a class="dn-btn" href="/vanity-wallet">+ Register a domain</a>
			</div>`;
		return;
	}

	const rows = hits.map((h) => `
		<tr>
			<td style="padding:11px 12px">
				<span style="font-family:${MONO};font-size:13px;color:var(--nxt-ink)">${esc(h.domain)}</span>
			</td>
			<td style="padding:11px 12px">
				<button class="dn-copy" data-copy="${esc(h.wallet.address)}" title="${esc(h.wallet.address)}" style="
					font-family:${MONO};font-size:12.5px;
					background:transparent;border:none;color:var(--nxt-ink-dim);
					padding:0;cursor:pointer;
				">${esc(truncMid(h.wallet.address, 6, 6))}</button>
			</td>
			<td style="padding:11px 12px">
				<span class="dn-tag success">Active</span>
			</td>
			<td style="padding:11px 12px;text-align:right">
				<a class="dn-btn ghost" href="https://www.sns.id/domain/${encodeURIComponent(h.domain.replace(/\\.sol$/, ''))}" target="_blank" rel="noopener" style="padding:5px 10px;font-size:12px">Manage ↗</a>
			</td>
		</tr>
	`).join('');

	rowsHost.innerHTML = `
		<div style="overflow-x:auto;border:1px solid var(--nxt-stroke);border-radius:var(--nxt-radius-sm)">
			<table style="width:100%;border-collapse:collapse">
				<thead>
					<tr style="background:rgba(255,255,255,0.02);text-align:left">
						<th style="padding:9px 12px;font-size:11.5px;color:var(--nxt-ink-fade);font-weight:500;text-transform:uppercase;letter-spacing:0.04em">Domain</th>
						<th style="padding:9px 12px;font-size:11.5px;color:var(--nxt-ink-fade);font-weight:500;text-transform:uppercase;letter-spacing:0.04em">Wallet</th>
						<th style="padding:9px 12px;font-size:11.5px;color:var(--nxt-ink-fade);font-weight:500;text-transform:uppercase;letter-spacing:0.04em">Status</th>
						<th style="padding:9px 12px"></th>
					</tr>
				</thead>
				<tbody>${rows}</tbody>
			</table>
		</div>
	`;

	rowsHost.querySelectorAll('.dn-copy').forEach((btn) => {
		btn.addEventListener('click', () => copyToClipboard(btn.dataset.copy));
	});
}

// ── Delegation ────────────────────────────────────────────────────────────

async function loadDelegations(host) {
	try {
		const r = await get('/api/agents');
		const agents = Array.isArray(r?.agents) ? r.agents : [];
		if (agents.length === 0) {
			host.innerHTML = `
				<div class="dn-empty" style="padding:32px 24px">
					<h3>No agents to delegate</h3>
					<p>Create an agent first, then return here to let another agent answer on its behalf.</p>
					<a class="dn-btn" href="/dashboard-next/avatars">Create an agent →</a>
				</div>`;
			return;
		}

		const rows = agents.slice(0, 8).map((a) => `
			<tr>
				<td style="padding:11px 12px">
					<div style="font-size:13.5px;color:var(--nxt-ink);font-weight:500">${esc(a.name || a.display_name || 'Unnamed agent')}</div>
					<div style="font-family:${MONO};font-size:11.5px;color:var(--nxt-ink-fade);margin-top:2px">${esc(truncMid(a.id, 8, 4))}</div>
				</td>
				<td style="padding:11px 12px;color:var(--nxt-ink-dim);font-size:12.5px">
					${a.wallet_address ? `<span style="font-family:${MONO}">${esc(truncMid(a.wallet_address, 6, 6))}</span>` : '<span style="color:var(--nxt-ink-fade)">no delegate</span>'}
				</td>
				<td style="padding:11px 12px;text-align:right">
					<a class="dn-btn ghost" href="/dashboard/delegation?agent=${encodeURIComponent(a.id)}" style="padding:5px 10px;font-size:12px">Configure →</a>
				</td>
			</tr>
		`).join('');

		host.innerHTML = `
			<div style="overflow-x:auto;border:1px solid var(--nxt-stroke);border-radius:var(--nxt-radius-sm)">
				<table style="width:100%;border-collapse:collapse">
					<thead>
						<tr style="background:rgba(255,255,255,0.02);text-align:left">
							<th style="padding:9px 12px;font-size:11.5px;color:var(--nxt-ink-fade);font-weight:500;text-transform:uppercase;letter-spacing:0.04em">Agent</th>
							<th style="padding:9px 12px;font-size:11.5px;color:var(--nxt-ink-fade);font-weight:500;text-transform:uppercase;letter-spacing:0.04em">Delegate wallet</th>
							<th style="padding:9px 12px"></th>
						</tr>
					</thead>
					<tbody>${rows}</tbody>
				</table>
			</div>
		`;
	} catch (err) {
		host.innerHTML = `<div class="dn-empty" style="padding:24px 16px"><h3>Couldn't load agents</h3><p>${esc(err?.message || 'Try again in a moment.')}</p></div>`;
	}
}

// ── Action log ────────────────────────────────────────────────────────────

let actionsCursor = null;

async function loadActions(host, append = false) {
	try {
		const qs = new URLSearchParams({ limit: '50' });
		if (append && actionsCursor) qs.set('cursor', actionsCursor);
		const r = await get(`/api/audit-log?${qs.toString()}`);
		const items = Array.isArray(r?.items) ? r.items
			: Array.isArray(r?.events) ? r.events
			: Array.isArray(r) ? r
			: [];
		actionsCursor = r?.next_cursor || r?.cursor || null;
		if (items.length === 0 && !append) {
			host.innerHTML = `
				<div class="dn-empty">
					<h3>Audit log is empty</h3>
					<p>Audit log will appear here as you make changes — wallet links, key issuance, sign-ins.</p>
				</div>`;
			return;
		}
		renderActions(host, items, append);
	} catch (err) {
		host.innerHTML = `<div class="dn-empty"><h3>Couldn't load audit log</h3><p>${esc(err?.message || 'Try again in a moment.')}</p></div>`;
	}
}

function renderActions(host, items, append) {
	const rowsHtml = items.map((it) => {
		const when = it.created_at || it.ts || it.timestamp;
		const action = it.action || it.event || '';
		const desc = it.description || it.message || it.resource_id || it.resourceId || '';
		const ip = it.ip || it.client_ip || '';
		const ua = it.user_agent || it.agent || it.ua || '';
		const cat = it.category || categoryOf(action);
		return `
			<tr>
				<td style="padding:9px 12px;color:var(--nxt-ink-dim);font-size:12px;white-space:nowrap">${when ? esc(relTime(when)) : '—'}</td>
				<td style="padding:9px 12px"><span class="dn-tag">${esc(cat)}</span></td>
				<td style="padding:9px 12px;color:var(--nxt-ink);font-size:12.5px">
					<span style="font-family:${MONO};color:var(--nxt-ink-dim);font-size:11.5px">${esc(action)}</span>
					${desc ? `<div style="color:var(--nxt-ink-dim);font-size:12px;margin-top:2px">${esc(String(desc).slice(0, 120))}</div>` : ''}
				</td>
				<td style="padding:9px 12px;color:var(--nxt-ink-fade);font-size:11.5px;font-family:${MONO};white-space:nowrap">${esc(truncMid(ip, 8, 4))}</td>
				<td style="padding:9px 12px;color:var(--nxt-ink-fade);font-size:11.5px;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(ua)}">${esc(String(ua).slice(0, 28))}</td>
			</tr>
		`;
	}).join('');

	if (append) {
		const tbody = host.querySelector('tbody');
		if (tbody) tbody.insertAdjacentHTML('beforeend', rowsHtml);
	} else {
		host.innerHTML = `
			<div style="overflow-x:auto;border:1px solid var(--nxt-stroke);border-radius:var(--nxt-radius-sm)">
				<table style="width:100%;border-collapse:collapse">
					<thead>
						<tr style="background:rgba(255,255,255,0.02);text-align:left">
							<th style="padding:9px 12px;font-size:11.5px;color:var(--nxt-ink-fade);font-weight:500;text-transform:uppercase;letter-spacing:0.04em">When</th>
							<th style="padding:9px 12px;font-size:11.5px;color:var(--nxt-ink-fade);font-weight:500;text-transform:uppercase;letter-spacing:0.04em">Category</th>
							<th style="padding:9px 12px;font-size:11.5px;color:var(--nxt-ink-fade);font-weight:500;text-transform:uppercase;letter-spacing:0.04em">Event</th>
							<th style="padding:9px 12px;font-size:11.5px;color:var(--nxt-ink-fade);font-weight:500;text-transform:uppercase;letter-spacing:0.04em">IP</th>
							<th style="padding:9px 12px;font-size:11.5px;color:var(--nxt-ink-fade);font-weight:500;text-transform:uppercase;letter-spacing:0.04em">Agent</th>
						</tr>
					</thead>
					<tbody>${rowsHtml}</tbody>
				</table>
			</div>
			<div data-slot="actions-more" style="display:flex;justify-content:center;padding:14px 0 4px"></div>
		`;
	}

	const more = host.querySelector('[data-slot="actions-more"]');
	if (more) {
		if (actionsCursor) {
			more.innerHTML = `<button class="dn-btn" data-action="load-more">Load older</button>`;
			more.querySelector('[data-action="load-more"]').addEventListener('click', (e) => {
				e.currentTarget.disabled = true;
				e.currentTarget.textContent = 'Loading…';
				loadActions(host, true);
			});
		} else {
			more.innerHTML = '';
		}
	}
}
