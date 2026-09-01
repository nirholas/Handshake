// dashboard-next — API & Embed page.
//
// Five sections:
//   0. Agent Toolkit      — Connect to Claude (one-click MCP), Skill/CLI/MCP resources
//   1. API keys           — list, create (with one-shot secret reveal), revoke
//   2. MCP setup          — Claude Desktop / Cursor / Generic JSON configs
//   3. Embed snippets     — Script tag / iframe / web-component with live preview
//   4. Embed policy       — per-agent origin allowlist editor
//
// Endpoints (all real):
//   GET    /api/keys                       { keys: [...] }
//   POST   /api/keys                       body { name, scope, expires_in_days? } → { key: { ..., secret } }
//   DELETE /api/keys/:id
//   GET    /api/avatars                    { avatars: [...] }
//   GET    /api/widgets                    { widgets: [...] }
//   GET    /api/agents                     { agents: [...] }
//   GET    /api/agents/:id/embed-policy    { policy }
//   PUT    /api/agents/:id/embed-policy    body = policy json
//   POST   /api/mcp  (with bearer)         JSON-RPC test (tools/list)

import { mountShell } from '../shell.js';
import { requireUser, get, post, del, put, esc, relTime, ApiError } from '../api.js';
import { apiFetch } from '../../api.js';
import { errorStateHTML, emptyStateHTML, skeletonHTML, ensureStateKitStyles } from '../../shared/state-kit.js';

// Scopes accepted by /api/keys — match api/keys/index.js ALLOWED_SCOPES exactly.
const SCOPES = [
	{ value: 'avatars:read',   label: 'avatars:read',   note: 'List, fetch, and stream avatars' },
	{ value: 'avatars:write',  label: 'avatars:write',  note: 'Create or modify avatars' },
	{ value: 'avatars:delete', label: 'avatars:delete', note: 'Permanently remove avatars' },
	{ value: 'profile',        label: 'profile',        note: 'Read the signed-in user record' },
	{ value: 'memory:read',    label: 'memory:read',    note: 'Recall your agents’ stored memories' },
	{ value: 'memory:write',   label: 'memory:write',   note: 'Store and forget agent memories' },
	{ value: 'agents:read',    label: 'agents:read',    note: 'Read your agents and their identities' },
	{ value: 'agents:write',   label: 'agents:write',   note: 'Create, update, and register agents' },
	{ value: 'herald:announce', label: 'herald:announce', note: 'Post announcements through the Herald' },
];

const EXPIRY_OPTIONS = [
	{ label: 'Never',   days: null },
	{ label: '30 days', days: 30 },
	{ label: '90 days', days: 90 },
	{ label: '1 year',  days: 365 },
];

const KEY_PLACEHOLDER = 'YOUR_API_KEY';

(async function boot() {
	let main;
	try {
		main = await mountShell();
	} catch {
		// Shell failed to mount — nothing renderable yet, surface a full-page retry.
		ensureStateKitStyles();
		const fallback = document.querySelector('.dn-main-inner') || document.body;
		fallback.innerHTML = errorStateHTML({
			title: "Couldn't load this page",
			body: 'We had trouble loading the dashboard. Check your connection and try again.',
		});
		fallback.querySelector('[data-sk-retry]')?.addEventListener('click', () => location.reload());
		return;
	}

	let me;
	try {
		me = await requireUser();
	} catch (err) {
		if (err instanceof ApiError && err.status === 401) {
			location.href = `/login?return=${encodeURIComponent(location.pathname)}`;
			return;
		}
		ensureStateKitStyles();
		main.innerHTML = errorStateHTML({
			title: "Couldn't verify your session",
			body: 'We had trouble confirming you are signed in. Check your connection and try again.',
		});
		main.querySelector('[data-sk-retry]')?.addEventListener('click', () => location.reload());
		return;
	}

	main.innerHTML = `
		<h1 class="dn-h1">API & embed</h1>
		<p class="dn-h1-sub">Connect your agent, issue keys, configure MCP clients, embed agents anywhere.</p>
		<div class="dn-stack" data-slot="content">
			<div class="dn-panel dn-toolkit-panel" data-section="toolkit"><div class="dn-skeleton" style="height:220px"></div></div>
			<div class="dn-panel" data-section="keys"><div class="dn-skeleton" style="height:180px"></div></div>
			<div class="dn-panel" data-section="mcp"><div class="dn-skeleton" style="height:180px"></div></div>
			<div class="dn-panel" data-section="embed"><div class="dn-skeleton" style="height:240px"></div></div>
			<div class="dn-panel" data-section="policy"><div class="dn-skeleton" style="height:160px"></div></div>
		</div>
		<div data-slot="modals"></div>
		<div data-slot="toasts" class="dn-toasts"></div>
	`;
	injectStyles();

	const state = {
		me,
		keys: [],
		avatars: [],
		widgets: [],
		agents: [],
		selectedKeyForMcp: null,
		embed: {
			selection: null, // { kind: 'avatar' | 'widget', id, label, agentId? }
			tab: 'script',
			width: 360,
			height: 480,
			background: 'transparent',
			reveal: 'auto',
			hideChrome: false,
		},
	};

	const content = main.querySelector('[data-slot="content"]');
	const sections = {
		toolkit: content.querySelector('[data-section="toolkit"]'),
		keys:    content.querySelector('[data-section="keys"]'),
		mcp:     content.querySelector('[data-section="mcp"]'),
		embed:   content.querySelector('[data-section="embed"]'),
		policy:  content.querySelector('[data-section="policy"]'),
	};

	// Fetch the four data sources concurrently. Each one is optional —
	// the section it feeds shows an empty/error state rather than blocking
	// the whole page if its endpoint is unavailable.
	const [keysRes, avatarsRes, widgetsRes, agentsRes] = await Promise.allSettled([
		get('/api/keys'),
		get('/api/avatars?limit=200'),
		get('/api/widgets'),
		get('/api/agents'),
	]);

	state.keys    = keysRes.status    === 'fulfilled' ? (keysRes.value?.keys || [])       : [];
	state.avatars = avatarsRes.status === 'fulfilled' ? (avatarsRes.value?.avatars || []) : [];
	state.widgets = widgetsRes.status === 'fulfilled' ? (widgetsRes.value?.widgets || []) : [];
	state.agents  = agentsRes.status  === 'fulfilled' ? (agentsRes.value?.agents || [])   : [];

	// Track which sources genuinely failed (vs. legitimately empty) so each
	// section can show a recoverable error state with Retry rather than an
	// "empty" state that hides a network problem.
	state.errors = {
		keys:    keysRes.status    === 'rejected',
		avatars: avatarsRes.status === 'rejected',
		widgets: widgetsRes.status === 'rejected',
		agents:  agentsRes.status  === 'rejected',
	};

	state.selectedKeyForMcp = pickDisplayKey(state.keys);
	state.embed.selection = pickDefaultEmbedTarget(state.avatars, state.widgets, state.agents);

	renderToolkit(sections.toolkit, state);
	renderKeys(sections.keys, state);
	renderMcp(sections.mcp, state);
	renderEmbed(sections.embed, state);
	renderPolicy(sections.policy, state);
})();

// ── Helpers ────────────────────────────────────────────────────────────────

// The MCP section pre-fills its snippets and its live handshake test with this
// key, so it has to be one that can still authenticate: an expired key is as
// unusable as a revoked one and would fail the test with no visible reason.
function pickDisplayKey(keys) {
	return keys.find((k) => !keyStatus(k).dead) || null;
}

function pickDefaultEmbedTarget(avatars, widgets, agents) {
	if (avatars.length) {
		const a = avatars[0];
		return {
			kind: 'avatar',
			id: a.id,
			label: a.name || a.id.slice(0, 8),
			agentId: matchAgentByAvatar(agents, a.id),
		};
	}
	if (widgets.length) {
		const w = widgets[0];
		return {
			kind: 'widget',
			id: w.id,
			label: w.name || w.id.slice(0, 8),
			agentId: matchAgentByAvatar(agents, w.avatar_id),
		};
	}
	return null;
}

function matchAgentByAvatar(agents, avatarId) {
	if (!avatarId) return null;
	const found = agents.find((a) => a.avatar_id === avatarId);
	return found?.id || null;
}

function toast(msg, kind = 'info') {
	const host = document.querySelector('[data-slot="toasts"]');
	if (!host) return;
	const el = document.createElement('div');
	el.className = `dn-toast dn-toast-${kind}`;
	el.textContent = msg;
	host.appendChild(el);
	setTimeout(() => {
		el.style.opacity = '0';
		setTimeout(() => el.remove(), 250);
	}, 3500);
}

function copyToClipboard(text, btnEl) {
	if (!navigator.clipboard) {
		toast('Clipboard unavailable in this browser', 'danger');
		return;
	}
	navigator.clipboard.writeText(text).then(
		() => {
			if (btnEl) {
				const orig = btnEl.textContent;
				btnEl.textContent = 'Copied';
				btnEl.classList.add('copied');
				setTimeout(() => {
					btnEl.textContent = orig;
					btnEl.classList.remove('copied');
				}, 1400);
			} else {
				toast('Copied to clipboard');
			}
		},
		() => toast('Could not copy', 'danger'),
	);
}

function openModal(html) {
	const host = document.querySelector('[data-slot="modals"]');
	const wrap = document.createElement('div');
	wrap.className = 'dn-modal-backdrop';
	wrap.innerHTML = `<div class="dn-modal" role="dialog" aria-modal="true">${html}</div>`;
	host.appendChild(wrap);
	const close = () => wrap.remove();
	wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
	wrap.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
	wrap.querySelectorAll('[data-modal-close]').forEach((b) => b.addEventListener('click', close));
	const focusTarget = wrap.querySelector('[data-autofocus]') || wrap.querySelector('input,select,textarea,button');
	if (focusTarget) focusTarget.focus();
	return { el: wrap, close };
}

function origin() {
	return location.origin.replace(/\/$/, '');
}

// ── Per-section retry loaders ─────────────────────────────────────────────
// Re-fetch a single data source and re-render just the sections it feeds, so a
// transient failure in one endpoint never forces a full-page reload.

async function reloadKeys(state) {
	const slot = document.querySelector('[data-section="keys"] [data-slot="keys-body"]');
	if (slot) slot.innerHTML = skeletonHTML(3, 'row');
	try {
		const res = await get('/api/keys');
		state.keys = res?.keys || [];
		state.errors.keys = false;
	} catch {
		state.errors.keys = true;
	}
	state.selectedKeyForMcp = pickDisplayKey(state.keys);
	renderKeys(document.querySelector('[data-section="keys"]'), state);
	renderMcp(document.querySelector('[data-section="mcp"]'), state);
}

async function reloadEmbedData(state) {
	const host = document.querySelector('[data-section="embed"]');
	if (host) host.innerHTML = skeletonHTML(3, 'row');
	const [av, wg] = await Promise.allSettled([get('/api/avatars?limit=200'), get('/api/widgets')]);
	state.errors.avatars = av.status === 'rejected';
	state.errors.widgets = wg.status === 'rejected';
	state.avatars = av.status === 'fulfilled' ? (av.value?.avatars || []) : [];
	state.widgets = wg.status === 'fulfilled' ? (wg.value?.widgets || []) : [];
	renderEmbed(document.querySelector('[data-section="embed"]'), state);
}

async function reloadAgents(state) {
	const host = document.querySelector('[data-section="policy"]');
	if (host) host.innerHTML = skeletonHTML(3, 'row');
	try {
		const res = await get('/api/agents');
		state.agents = res?.agents || [];
		state.errors.agents = false;
	} catch {
		state.errors.agents = true;
	}
	renderPolicy(document.querySelector('[data-section="policy"]'), state);
}

// ── Section 0: Agent Toolkit ──────────────────────────────────────────────
//
// The "connect your agent" front door — mirrors the way other agent platforms
// surface a one-click client hookup plus the three install surfaces (Skill,
// CLI, MCP). Every command here is real and copy-paste runnable:
//   Skill → `/plugin marketplace add nirholas/three.ws`  (Claude Code plugins)
//   CLI   → `npm i -g @three-ws/avatar-cli`              (the three-ws-avatar bin)
//   MCP   → https://<host>/api/mcp                       (hosted streamable HTTP)
// "Connect to Claude" opens a modal with the exact `claude mcp add` one-liner
// and the Claude Desktop config, pre-filled with the active key prefix.

function toolkitResources() {
	return [
		{
			id: 'skill',
			tag: 'Skill',
			title: 'Claude plugins',
			desc: 'Install the three.ws skill pack — wallet, payments, pump.fun, and agent scaffolding.',
			cmd: '/plugin marketplace add nirholas/three.ws',
			doc: { href: '/docs/quick-start', label: 'Skill docs' },
		},
		{
			id: 'cli',
			tag: 'CLI',
			title: 'Command line',
			desc: 'Drive avatars and agents from your terminal or CI with the three-ws-avatar binary.',
			cmd: 'npm i -g @three-ws/avatar-cli',
			doc: { href: '/docs/quick-start', label: 'CLI docs' },
		},
		{
			id: 'mcp',
			tag: 'MCP',
			title: 'MCP server',
			desc: 'Point Claude, Cursor, or any MCP host at your agents over streamable HTTP.',
			cmd: `${origin()}/api/mcp`,
			doc: { href: '/docs/mcp', label: 'MCP setup' },
		},
	];
}

function renderToolkit(host, state) {
	const resources = toolkitResources();
	host.innerHTML = `
		<div class="dn-toolkit-hero">
			<div class="dn-toolkit-copy">
				<div class="dn-toolkit-eyebrow">Agent Toolkit</div>
				<h2 class="dn-toolkit-h">Connect your agent to three.ws.</h2>
				<p class="dn-toolkit-sub">Drive 3D avatars, query live market intel, and pay per call — straight from Claude, Cursor, your CLI, or any MCP client.</p>
				<div class="dn-toolkit-cta">
					<button class="dn-btn primary dn-connect-claude" data-act="connect-claude">
						<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false"><path fill="currentColor" d="M4.7 16.6 9 5.4h2.1l4.3 11.2h-2.05l-1-2.74H7.7l-1 2.74H4.7Zm3.55-4.4h3.4L10 7.2l-1.75 5Zm9.05 4.4V5.4h1.95v11.2H17.3Z"/></svg>
						Connect to Claude
					</button>
					<a class="dn-btn" href="/docs/mcp">Builder docs <span aria-hidden="true">→</span></a>
				</div>
			</div>
		</div>

		<div class="dn-toolkit-grid">
			${resources.map((r) => `
				<div class="dn-toolkit-card">
					<div class="dn-toolkit-card-head">
						<span class="dn-toolkit-card-tag">${esc(r.tag)}</span>
						<span class="dn-toolkit-card-title">${esc(r.title)}</span>
					</div>
					<p class="dn-toolkit-card-desc">${esc(r.desc)}</p>
					<div class="dn-toolkit-cmd">
						<code data-snippet="toolkit-${esc(r.id)}">${esc(r.cmd)}</code>
						<button type="button" class="dn-code-copy dn-toolkit-cmd-copy" data-copy="toolkit-${esc(r.id)}" aria-label="Copy ${esc(r.title)} command">Copy</button>
					</div>
					<a class="dn-toolkit-card-doc" href="${esc(r.doc.href)}">${esc(r.doc.label)} <span aria-hidden="true">↗</span></a>
				</div>
			`).join('')}
		</div>

		<div class="dn-toolkit-foot">
			<a class="dn-link" href="/docs">Builder docs</a>
			<a class="dn-link" href="/docs/api-reference">API docs</a>
			<a class="dn-link" href="/docs/mcp">MCP setup</a>
			<button type="button" class="dn-link" data-act="jump-keys">API keys</button>
		</div>
	`;

	host.querySelector('[data-act="connect-claude"]').addEventListener('click', () => openConnectClaudeModal(state));
	host.querySelector('[data-act="jump-keys"]').addEventListener('click', () => {
		document.querySelector('[data-section="keys"]')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
	});
	host.querySelectorAll('[data-copy]').forEach((b) => {
		b.addEventListener('click', () => {
			const code = host.querySelector(`[data-snippet="${b.dataset.copy}"]`)?.textContent || '';
			copyToClipboard(code, b);
		});
	});
}

function openConnectClaudeModal(state) {
	const live = state.keys.filter((k) => !k.revoked_at);
	const selected = (state.selectedKeyForMcp && live.find((k) => k.id === state.selectedKeyForMcp.id)) || live[0] || null;
	const token = selected ? `${selected.prefix}…` : KEY_PLACEHOLDER;
	const mcpUrl = `${origin()}/api/mcp`;

	const cliCmd = `claude mcp add --transport http three-ws ${mcpUrl} --header "Authorization: Bearer ${token}"`;
	const desktopCfg = JSON.stringify({
		mcpServers: {
			'three-ws': {
				url: mcpUrl,
				headers: { authorization: `Bearer ${token}` },
			},
		},
	}, null, 2);

	const { el } = openModal(`
		<div class="dn-modal-head">
			<h2>Connect to Claude</h2>
			<button type="button" class="dn-btn ghost" data-modal-close aria-label="Close">×</button>
		</div>
		${selected
			? `<p class="dn-modal-body" style="margin-bottom:14px">Using key <strong>${esc(selected.name)}</strong> (<code>${esc(selected.prefix)}…</code>). Swap the prefix for your full secret — the one shown once at creation.</p>`
			: `<div class="dn-warn-banner"><strong>No API key yet.</strong>These snippets use the <code>${esc(KEY_PLACEHOLDER)}</code> placeholder. Create a key first, then paste it in.</div>`}

		<div class="dn-modal-block">
			<div class="dn-modal-block-label">Claude Code — one command</div>
			<div class="dn-code-block">
				<pre><code data-snippet="cc-cli">${esc(cliCmd)}</code></pre>
				<button type="button" class="dn-code-copy" data-copy="cc-cli" aria-label="Copy Claude Code command">Copy</button>
			</div>
		</div>

		<div class="dn-modal-block">
			<div class="dn-modal-block-label">Claude Desktop — config</div>
			<p class="dn-modal-hint">Add to <code>claude_desktop_config.json</code>, then restart Claude Desktop.</p>
			<div class="dn-code-block">
				<pre><code data-snippet="cc-desktop">${esc(desktopCfg)}</code></pre>
				<button type="button" class="dn-code-copy" data-copy="cc-desktop" aria-label="Copy Claude Desktop config">Copy</button>
			</div>
		</div>

		<div class="dn-modal-foot">
			${!selected ? `<button type="button" class="dn-btn primary" data-act="make-key">Create an API key</button>` : ''}
			<a class="dn-btn ghost" href="/docs/mcp">Full MCP setup ↗</a>
			<button type="button" class="dn-btn ${selected ? 'primary' : ''}" data-modal-close data-autofocus>Done</button>
		</div>
	`);

	el.querySelectorAll('[data-copy]').forEach((b) => {
		b.addEventListener('click', () => {
			const code = el.querySelector(`[data-snippet="${b.dataset.copy}"]`)?.textContent || '';
			copyToClipboard(code, b);
		});
	});
	const makeKeyBtn = el.querySelector('[data-act="make-key"]');
	if (makeKeyBtn) {
		makeKeyBtn.addEventListener('click', () => {
			el.closest('.dn-modal-backdrop')?.remove();
			document.querySelector('[data-section="keys"]')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
			document.querySelector('[data-act="new-key"]')?.click();
		});
	}
}

// ── Section 1: API keys ───────────────────────────────────────────────────

function renderKeys(host, state) {
	const list = state.keys;
	const hasKeys = list.length > 0;
	host.innerHTML = `
		<div class="dn-section-head">
			<div>
				<div class="dn-panel-title">API keys</div>
				<div class="dn-panel-sub">Long-lived bearer tokens for the public API and MCP server.</div>
			</div>
			<button class="dn-btn primary" data-act="new-key">+ New key</button>
		</div>
		<div data-slot="keys-body">${
			state.errors?.keys
				? errorStateHTML({
					title: "Couldn't load your API keys",
					body: 'We had trouble reaching the key service. Check your connection and try again.',
					scope: 'keys',
				})
				: hasKeys ? renderKeysTable(list) : renderKeysEmpty()
		}</div>
	`;

	host.querySelector('[data-act="new-key"]').addEventListener('click', () => openNewKeyModal(state));
	host.querySelector('[data-sk-action="create-key"]')?.addEventListener('click', () => openNewKeyModal(state));
	host.querySelector('[data-sk-retry]')?.addEventListener('click', () => reloadKeys(state));
	host.querySelectorAll('[data-act="revoke"]').forEach((btn) => {
		btn.addEventListener('click', () => confirmRevokeKey(state, btn.dataset.keyId, btn.dataset.keyName));
	});
}

function renderKeysEmpty() {
	return emptyStateHTML({
		icon: '🔑',
		title: 'No API keys yet',
		body: 'Issue a bearer token to start hitting the public API or connect an MCP client like Claude or Cursor.',
		actions: [
			{ label: '+ New key', id: 'create-key', primary: true },
			{ label: 'Read the API docs', href: '/docs/api-reference', id: 'api-docs' },
		],
		compact: true,
	});
}

// GET /api/keys returns the caller's full history, revoked and expired keys
// included, so the table has to say which rows are still usable. Without this a
// revoked key rendered identically to a live one and kept an armed Revoke
// button that could only ever answer 404, and an expired key looked healthy
// right up until a request failed with no explanation.
export function keyStatus(k) {
	if (k.revoked_at) return { label: 'Revoked', tag: 'danger', dead: true, at: k.revoked_at };
	if (k.expires_at && new Date(k.expires_at) <= new Date())
		return { label: 'Expired', tag: 'warn', dead: true, at: k.expires_at };
	return { label: 'Active', tag: 'success', dead: false, at: null };
}

export function renderKeysTable(keys) {
	return `
		<div class="dn-table-wrap">
			<table class="dn-table">
				<thead>
					<tr>
						<th>Name</th>
						<th>Prefix</th>
						<th>Status</th>
						<th>Scopes</th>
						<th>Created</th>
						<th>Last used</th>
						<th></th>
					</tr>
				</thead>
				<tbody>
					${keys.map((k) => {
						const st = keyStatus(k);
						return `
						<tr${st.dead ? ' class="dn-row-muted"' : ''}>
							<td>${esc(k.name)}</td>
							<td><code class="dn-mono-sm">${esc(k.prefix)}…</code></td>
							<td>
								<span class="dn-tag ${st.tag}"${st.at ? ` title="${esc(st.label)} ${esc(relTime(st.at))}"` : ''}>${st.label}</span>
							</td>
							<td>
								<div class="dn-chip-row">
									${(k.scope || '').split(/\s+/).filter(Boolean).map((s) => `<span class="dn-tag">${esc(s)}</span>`).join('')}
								</div>
							</td>
							<td><span class="dn-dim">${esc(relTime(k.created_at))}</span></td>
							<td><span class="dn-dim">${k.last_used_at ? esc(relTime(k.last_used_at)) : 'never'}</span></td>
							<td style="text-align:right">
								${k.revoked_at
									? '<span class="dn-dim">Revoked</span>'
									: `<button class="dn-btn danger" data-act="revoke" data-key-id="${esc(k.id)}" data-key-name="${esc(k.name)}" aria-label="Revoke API key ${esc(k.name)}">Revoke</button>`}
							</td>
						</tr>
					`;
					}).join('')}
				</tbody>
			</table>
		</div>
	`;
}

function openNewKeyModal(state) {
	const { close, el } = openModal(`
		<form data-form="new-key">
			<div class="dn-modal-head">
				<h2>New API key</h2>
				<button type="button" class="dn-btn ghost" data-modal-close aria-label="Close">×</button>
			</div>
			<label class="dn-field">
				<span>Name</span>
				<input data-autofocus name="name" type="text" placeholder="e.g. Production server" required maxlength="80" />
			</label>
			<fieldset class="dn-field">
				<legend>Scopes</legend>
				<div class="dn-scopes">
					${SCOPES.map((s) => `
						<label class="dn-scope-row">
							<input type="checkbox" name="scope" value="${esc(s.value)}" ${(s.value === 'avatars:read' || s.value === 'avatars:write') ? 'checked' : ''} />
							<div>
								<div class="dn-scope-label"><code>${esc(s.label)}</code></div>
								<div class="dn-scope-note">${esc(s.note)}</div>
							</div>
						</label>
					`).join('')}
				</div>
			</fieldset>
			<label class="dn-field">
				<span>Expires</span>
				<select name="expiry">
					${EXPIRY_OPTIONS.map((o, i) => `<option value="${i}">${esc(o.label)}</option>`).join('')}
				</select>
			</label>
			<div data-slot="error" class="dn-error" hidden></div>
			<div class="dn-modal-foot">
				<button type="button" class="dn-btn ghost" data-modal-close>Cancel</button>
				<button type="submit" class="dn-btn primary" data-submit>Create key</button>
			</div>
		</form>
	`);

	const form = el.querySelector('form');
	const errSlot = form.querySelector('[data-slot="error"]');
	const submitBtn = form.querySelector('[data-submit]');

	form.addEventListener('submit', async (e) => {
		e.preventDefault();
		errSlot.hidden = true;
		errSlot.textContent = '';
		const fd = new FormData(form);
		const name = String(fd.get('name') || '').trim();
		const scopes = fd.getAll('scope');
		const expiryIdx = parseInt(String(fd.get('expiry') ?? '0'), 10);
		if (!name) { errSlot.textContent = 'Name is required.'; errSlot.hidden = false; return; }
		if (!scopes.length) { errSlot.textContent = 'Pick at least one scope.'; errSlot.hidden = false; return; }

		submitBtn.disabled = true;
		submitBtn.textContent = 'Creating…';
		try {
			const payload = { name, scope: scopes.join(' '), environment: 'live' };
			const days = EXPIRY_OPTIONS[expiryIdx]?.days;
			if (days) payload.expires_in_days = days;
			const resp = await post('/api/keys', payload);
			close();
			state.keys.unshift({
				id: resp.key.id,
				name: resp.key.name,
				prefix: resp.key.prefix,
				scope: resp.key.scope,
				created_at: resp.key.created_at,
				expires_at: resp.key.expires_at,
				last_used_at: null,
			});
			state.selectedKeyForMcp = state.selectedKeyForMcp || pickDisplayKey(state.keys);
			renderKeys(document.querySelector('[data-section="keys"]'), state);
			renderMcp(document.querySelector('[data-section="mcp"]'), state);
			openKeyRevealModal(resp.key);
		} catch (err) {
			submitBtn.disabled = false;
			submitBtn.textContent = 'Create key';
			errSlot.textContent = err instanceof ApiError ? err.message : 'Could not create key.';
			errSlot.hidden = false;
		}
	});
}

function openKeyRevealModal(key) {
	const { el } = openModal(`
		<div class="dn-modal-head">
			<h2>Key created</h2>
			<button type="button" class="dn-btn ghost" data-modal-close aria-label="Close">×</button>
		</div>
		<div class="dn-warn-banner">
			<strong>This is the only time you'll see this key.</strong>
			Store it somewhere safe — we hash and discard the plaintext after this page closes.
		</div>
		<div class="dn-code-block">
			<pre><code data-secret>${esc(key.secret)}</code></pre>
			<button type="button" class="dn-code-copy" data-copy aria-label="Copy secret API key">Copy</button>
		</div>
		<div class="dn-modal-foot">
			<button type="button" class="dn-btn primary" data-modal-close data-autofocus>I've saved it</button>
		</div>
	`);
	el.querySelector('[data-copy]').addEventListener('click', (e) => {
		copyToClipboard(key.secret, e.currentTarget);
	});
}

function confirmRevokeKey(state, id, name) {
	const { close, el } = openModal(`
		<div class="dn-modal-head">
			<h2>Revoke key</h2>
			<button type="button" class="dn-btn ghost" data-modal-close aria-label="Close">×</button>
		</div>
		<p class="dn-modal-body">Revoke <strong>${esc(name)}</strong>? Any service using this key will immediately fail with a 401. This cannot be undone.</p>
		<div data-slot="error" class="dn-error" hidden></div>
		<div class="dn-modal-foot">
			<button type="button" class="dn-btn ghost" data-modal-close>Cancel</button>
			<button type="button" class="dn-btn danger" data-confirm data-autofocus>Revoke key</button>
		</div>
	`);

	const errSlot = el.querySelector('[data-slot="error"]');
	const btn = el.querySelector('[data-confirm]');
	btn.addEventListener('click', async () => {
		btn.disabled = true;
		btn.textContent = 'Revoking…';
		try {
			await del(`/api/keys/${encodeURIComponent(id)}`);
			state.keys = state.keys.filter((k) => k.id !== id);
			if (state.selectedKeyForMcp?.id === id) {
				state.selectedKeyForMcp = pickDisplayKey(state.keys);
			}
			close();
			toast(`Revoked ${name}`);
			renderKeys(document.querySelector('[data-section="keys"]'), state);
			renderMcp(document.querySelector('[data-section="mcp"]'), state);
		} catch (err) {
			btn.disabled = false;
			btn.textContent = 'Revoke key';
			errSlot.textContent = err instanceof ApiError ? err.message : 'Could not revoke.';
			errSlot.hidden = false;
		}
	});
}

// ── Section 2: MCP setup ──────────────────────────────────────────────────

const MCP_TABS = [
	{ id: 'claude',  label: 'Claude Desktop' },
	{ id: 'cursor',  label: 'Cursor' },
	{ id: 'generic', label: 'Generic JSON' },
];

function renderMcp(host, state) {
	const live = state.keys.filter((k) => !k.revoked_at);
	const selected = state.selectedKeyForMcp && live.find((k) => k.id === state.selectedKeyForMcp.id)
		? state.selectedKeyForMcp
		: (live[0] || null);
	state.selectedKeyForMcp = selected;
	const secretToken = selected ? `${selected.prefix}…` : KEY_PLACEHOLDER;
	const mcpUrl = `${origin()}/api/mcp`;

	host.innerHTML = `
		<div class="dn-section-head">
			<div>
				<div class="dn-panel-title">MCP setup</div>
				<div class="dn-panel-sub">Point Claude Desktop, Cursor, or any MCP client at your agents.</div>
			</div>
			<div class="dn-mcp-key-picker">
				${live.length
					? `<label>
						<span class="dn-dim">Key:</span>
						<select data-mcp-key>
							${live.map((k) => `<option value="${esc(k.id)}" ${k.id === selected?.id ? 'selected' : ''}>${esc(k.name)} (${esc(k.prefix)}…)</option>`).join('')}
						</select>
					</label>`
					: `<button type="button" class="dn-btn primary" data-create-key-from-mcp>+ Create an API key</button>`}
			</div>
		</div>

		${!live.length ? `
			<div class="dn-mcp-hint">
				Snippets below use the placeholder <code class="dn-mono-sm">${esc(KEY_PLACEHOLDER)}</code>. Create a key above and the snippets refresh with your real key prefix.
			</div>
		` : ''}

		<div class="dn-tabs" role="tablist" aria-label="MCP client configs">
			${MCP_TABS.map((t, i) => `
				<button class="dn-tab ${i === 0 ? 'active' : ''}" role="tab" aria-selected="${i === 0 ? 'true' : 'false'}" data-mcp-tab="${esc(t.id)}">${esc(t.label)}</button>
			`).join('')}
		</div>

		<div class="dn-mcp-panels">
			${MCP_TABS.map((t, i) => `
				<div class="dn-mcp-panel" data-mcp-panel="${esc(t.id)}" ${i === 0 ? '' : 'hidden'}>
					${renderMcpSnippet(t.id, mcpUrl, secretToken)}
				</div>
			`).join('')}
		</div>

		<div class="dn-mcp-test">
			<button class="dn-btn" data-mcp-test ${!selected ? 'disabled title="Create a key to test the live connection"' : ''}>Test connection</button>
			<span data-mcp-result class="dn-mcp-result"></span>
			<span class="dn-dim" style="margin-left:auto">POST <code class="dn-mono-sm">${esc(mcpUrl)}</code> · <code class="dn-mono-sm">tools/list</code></span>
		</div>
	`;

	const createBtn = host.querySelector('[data-create-key-from-mcp]');
	if (createBtn) {
		createBtn.addEventListener('click', () => {
			const keysSection = document.querySelector('[data-section="keys"]');
			keysSection?.scrollIntoView({ behavior: 'smooth', block: 'start' });
			document.querySelector('[data-act="new-key"]')?.click();
		});
	}

	host.querySelectorAll('[data-mcp-tab]').forEach((btn) => {
		btn.addEventListener('click', () => {
			host.querySelectorAll('[data-mcp-tab]').forEach((b) => {
				const on = b === btn;
				b.classList.toggle('active', on);
				b.setAttribute('aria-selected', on ? 'true' : 'false');
			});
			host.querySelectorAll('[data-mcp-panel]').forEach((p) => {
				p.hidden = p.dataset.mcpPanel !== btn.dataset.mcpTab;
			});
		});
	});
	host.querySelectorAll('[data-copy]').forEach((b) => {
		b.addEventListener('click', () => {
			const blockId = b.dataset.copy;
			const code = host.querySelector(`[data-snippet="${blockId}"]`)?.textContent || '';
			copyToClipboard(code, b);
		});
	});
	const sel = host.querySelector('[data-mcp-key]');
	if (sel) {
		sel.addEventListener('change', () => {
			const k = live.find((x) => x.id === sel.value);
			state.selectedKeyForMcp = k || null;
			renderMcp(host, state);
		});
	}
	const testBtn = host.querySelector('[data-mcp-test]');
	if (testBtn && selected) {
		testBtn.addEventListener('click', () => runMcpTest(host, selected));
	}
}

function renderMcpSnippet(tabId, mcpUrl, token) {
	let snippet = '';
	let lang = 'json';
	if (tabId === 'claude') {
		snippet = JSON.stringify({
			mcpServers: {
				'3d-agent': {
					url: mcpUrl,
					headers: { authorization: `Bearer ${token}` },
				},
			},
		}, null, 2);
	} else if (tabId === 'cursor') {
		snippet = JSON.stringify({
			mcpServers: {
				'three-ws': {
					transport: 'http',
					url: mcpUrl,
					headers: { Authorization: `Bearer ${token}` },
				},
			},
		}, null, 2);
	} else {
		snippet = JSON.stringify({
			name: 'three-ws',
			transport: 'streamable-http',
			endpoint: mcpUrl,
			auth: { type: 'bearer', token },
		}, null, 2);
	}
	const id = `mcp-${tabId}`;
	return `
		<div class="dn-code-block">
			<pre><code data-snippet="${id}" class="dn-lang-${lang}">${esc(snippet)}</code></pre>
			<button type="button" class="dn-code-copy" data-copy="${id}" aria-label="Copy ${esc(tabId)} MCP config">Copy</button>
		</div>
	`;
}

async function runMcpTest(host, key) {
	const result = host.querySelector('[data-mcp-result]');
	const btn = host.querySelector('[data-mcp-test]');
	if (!result || !btn) return;
	result.innerHTML = '<span class="dn-tag">Testing…</span>';
	btn.disabled = true;
	try {
		// The plaintext key is hashed server-side and can't be replayed, so the
		// test endpoint validates this key by id (ownership, revoked, expired) and
		// runs the initialize → tools/list handshake with its real scope.
		const res = await apiFetch('/api/developer/mcp-test', {
			method: 'POST',
			credentials: 'include',
			headers: { accept: 'application/json', 'content-type': 'application/json' },
			body: JSON.stringify({ keyId: key.id }),
		});
		const data = await res.json().catch(() => null);
		if (res.ok && data?.ok) {
			const toolCount = data.tools?.length || 0;
			const scopes = data.scopes?.length ? ` · ${data.scopes.join(', ')}` : '';
			result.innerHTML = `<span class="dn-tag success">OK · ${toolCount} tool${toolCount === 1 ? '' : 's'}${esc(scopes)}</span>`;
		} else {
			const msg = data?.error?.message || data?.error_description || `HTTP ${res.status}`;
			result.innerHTML = `<span class="dn-tag danger">Failed: ${esc(msg)}</span>`;
		}
	} catch (err) {
		result.innerHTML = `<span class="dn-tag danger">Failed: ${esc(err.message || 'network error')}</span>`;
	} finally {
		btn.disabled = false;
	}
}

// ── Section 3: Embed snippets ─────────────────────────────────────────────

const EMBED_TABS = [
	{ id: 'script',    label: 'Script tag' },
	{ id: 'iframe',    label: 'iframe' },
	{ id: 'component', label: 'Web component' },
];

function renderEmbed(host, state) {
	const targets = buildEmbedTargets(state.avatars, state.widgets, state.agents);
	if (!targets.length) {
		const dataFailed = state.errors?.avatars || state.errors?.widgets;
		host.innerHTML = `
			<div class="dn-section-head">
				<div>
					<div class="dn-panel-title">Embed snippets</div>
					<div class="dn-panel-sub">Drop your avatar or widget into any web page.</div>
				</div>
			</div>
			<div data-slot="embed-body">${
				dataFailed
					? errorStateHTML({
						title: "Couldn't load embed targets",
						body: 'We had trouble loading your avatars and widgets. Check your connection and try again.',
						scope: 'embed',
					})
					: emptyStateHTML({
						icon: '🎬',
						title: 'Nothing to embed yet',
						body: 'Create an avatar first, then come back for a copy-paste embed snippet with a live preview.',
						actions: [
							{ label: 'Create an avatar', href: '/dashboard/avatars', id: 'go-avatars', primary: true },
							{ label: 'Embed docs', href: '/docs/mcp', id: 'embed-docs' },
						],
						compact: true,
					})
			}</div>
		`;
		host.querySelector('[data-sk-retry]')?.addEventListener('click', () => reloadEmbedData(state));
		return;
	}

	if (!state.embed.selection || !targets.find((t) => t.kind === state.embed.selection.kind && t.id === state.embed.selection.id)) {
		state.embed.selection = targets[0];
	}

	host.innerHTML = `
		<div class="dn-section-head">
			<div>
				<div class="dn-panel-title">Embed snippets</div>
				<div class="dn-panel-sub">Live preview updates as you tune the knobs.</div>
			</div>
			<label class="dn-mcp-key-picker">
				<span class="dn-dim">Target:</span>
				<select data-embed-target aria-label="Embed target avatar or widget">
					${targets.map((t) => `
						<option value="${esc(t.kind)}:${esc(t.id)}" ${state.embed.selection?.kind === t.kind && state.embed.selection?.id === t.id ? 'selected' : ''}>
							${esc(t.kind === 'avatar' ? 'Avatar' : 'Widget')} · ${esc(t.label)}
						</option>
					`).join('')}
				</select>
			</label>
		</div>

		<div class="dn-embed-grid">
			<div class="dn-embed-controls">
				<div class="dn-knob-row">
					<label class="dn-knob">
						<span>Width</span>
						<input type="number" min="120" max="1200" step="10" value="${state.embed.width}" data-embed-knob="width" />
					</label>
					<label class="dn-knob">
						<span>Height</span>
						<input type="number" min="120" max="1200" step="10" value="${state.embed.height}" data-embed-knob="height" />
					</label>
				</div>
				<div class="dn-knob-row">
					<label class="dn-knob">
						<span>Background</span>
						<select data-embed-knob="background">
							<option value="transparent" ${state.embed.background === 'transparent' ? 'selected' : ''}>Transparent</option>
							<option value="dark" ${state.embed.background === 'dark' ? 'selected' : ''}>Dark</option>
							<option value="light" ${state.embed.background === 'light' ? 'selected' : ''}>Light</option>
						</select>
					</label>
					<label class="dn-knob">
						<span>Reveal</span>
						<select data-embed-knob="reveal">
							<option value="auto" ${state.embed.reveal === 'auto' ? 'selected' : ''}>Auto</option>
							<option value="interaction" ${state.embed.reveal === 'interaction' ? 'selected' : ''}>Interaction</option>
						</select>
					</label>
				</div>
				<label class="dn-knob dn-knob-check">
					<input type="checkbox" data-embed-knob="hideChrome" ${state.embed.hideChrome ? 'checked' : ''} />
					<span>Hide chrome (controls + watermark)</span>
				</label>

				<div class="dn-tabs" role="tablist" aria-label="Embed snippet format" style="margin-top:14px">
					${EMBED_TABS.map((t) => `
						<button class="dn-tab ${state.embed.tab === t.id ? 'active' : ''}" role="tab" aria-selected="${state.embed.tab === t.id ? 'true' : 'false'}" data-embed-tab="${esc(t.id)}">${esc(t.label)}</button>
					`).join('')}
				</div>
				<div data-slot="embed-snippet" style="margin-top:12px"></div>
			</div>

			<div class="dn-embed-preview">
				<div class="dn-embed-preview-label dn-dim">Live preview</div>
				<div class="dn-embed-preview-frame" data-slot="embed-preview"></div>
			</div>
		</div>
	`;

	host.querySelector('[data-embed-target]').addEventListener('change', (e) => {
		const [kind, id] = e.target.value.split(':');
		state.embed.selection = targets.find((t) => t.kind === kind && t.id === id) || targets[0];
		renderEmbedSnippet(host, state);
		renderEmbedPreview(host, state);
	});
	host.querySelectorAll('[data-embed-knob]').forEach((el) => {
		el.addEventListener('input', () => {
			const key = el.dataset.embedKnob;
			let val = el.type === 'checkbox' ? el.checked : el.value;
			if (el.type === 'number') val = clampInt(val, 120, 1200);
			state.embed[key] = val;
			renderEmbedSnippet(host, state);
			renderEmbedPreview(host, state);
		});
	});
	host.querySelectorAll('[data-embed-tab]').forEach((b) => {
		b.addEventListener('click', () => {
			state.embed.tab = b.dataset.embedTab;
			host.querySelectorAll('[data-embed-tab]').forEach((x) => {
				const on = x === b;
				x.classList.toggle('active', on);
				x.setAttribute('aria-selected', on ? 'true' : 'false');
			});
			renderEmbedSnippet(host, state);
		});
	});

	renderEmbedSnippet(host, state);
	renderEmbedPreview(host, state);
}

function buildEmbedTargets(avatars, widgets, agents) {
	const out = [];
	for (const a of avatars) {
		out.push({
			kind: 'avatar',
			id: a.id,
			label: a.name || a.id.slice(0, 8),
			agentId: matchAgentByAvatar(agents, a.id),
		});
	}
	for (const w of widgets) {
		out.push({
			kind: 'widget',
			id: w.id,
			label: w.name || w.id.slice(0, 8),
			agentId: matchAgentByAvatar(agents, w.avatar_id),
		});
	}
	return out;
}

function clampInt(v, min, max) {
	const n = parseInt(String(v), 10);
	if (!Number.isFinite(n)) return min;
	return Math.max(min, Math.min(max, n));
}

function renderEmbedSnippet(host, state) {
	const slot = host.querySelector('[data-slot="embed-snippet"]');
	if (!slot) return;
	const snippet = buildSnippet(state);
	slot.innerHTML = `
		<div class="dn-code-block">
			<pre><code data-snippet="embed">${esc(snippet)}</code></pre>
			<button type="button" class="dn-code-copy" data-copy="embed" aria-label="Copy embed snippet">Copy</button>
		</div>
	`;
	slot.querySelector('[data-copy]').addEventListener('click', (e) => {
		copyToClipboard(snippet, e.currentTarget);
	});
}

function buildSnippet(state) {
	const sel = state.embed.selection;
	const { width, height, background, reveal, hideChrome, tab } = state.embed;
	const o = origin();

	if (tab === 'iframe') {
		const src = embedIframeSrc(sel, { background, reveal, hideChrome });
		const styleParts = [
			`width:${width}px`,
			`height:${height}px`,
			'border:0',
			'border-radius:14px',
			'overflow:hidden',
		];
		if (background === 'transparent') styleParts.push('background:transparent');
		return `<iframe src="${src}" allow="camera; microphone; autoplay" style="${styleParts.join(';')}" title="${sel.label}"></iframe>`;
	}

	if (tab === 'component') {
		const attrs = [
			sel.kind === 'avatar' ? `avatar-id="${sel.id}"` : `widget-id="${sel.id}"`,
			`bg="${background}"`,
			`reveal="${reveal}"`,
		];
		if (hideChrome) attrs.push('hide-chrome');
		const style = `display:block;width:${width}px;height:${height}px`;
		return [
			`<script src="${o}/embed.js"></script>`,
			`<threews-avatar ${attrs.join(' ')} style="${style}"></threews-avatar>`,
		].join('\n');
	}

	// default: script tag (auto-discovery via data attrs)
	const dataAttrs = [];
	if (sel.kind === 'widget') dataAttrs.push(`data-widget="${sel.id}"`);
	else dataAttrs.push(`data-avatar="${sel.id}"`);
	dataAttrs.push(`data-bg="${background}"`);
	dataAttrs.push(`data-reveal="${reveal}"`);
	if (hideChrome) dataAttrs.push('data-hide-chrome');
	dataAttrs.push(`data-width="${width}"`);
	dataAttrs.push(`data-height="${height}"`);
	return `<script async src="${o}/embed.js" ${dataAttrs.join(' ')}></script>`;
}

function embedIframeSrc(sel, opts) {
	const o = origin();
	const base = sel.kind === 'widget'
		? `${o}/widget/${encodeURIComponent(sel.id)}`
		: sel.agentId
			? `${o}/agents/${encodeURIComponent(sel.agentId)}/embed`
			: `${o}/a/${encodeURIComponent(sel.id)}`;
	const params = new URLSearchParams();
	if (opts.background) params.set('bg', opts.background);
	if (opts.reveal) params.set('reveal', opts.reveal);
	if (opts.hideChrome) params.set('chrome', '0');
	const qs = params.toString();
	return qs ? `${base}?${qs}` : base;
}

function renderEmbedPreview(host, state) {
	const slot = host.querySelector('[data-slot="embed-preview"]');
	if (!slot) return;
	const sel = state.embed.selection;
	if (!sel) {
		slot.innerHTML = `<div class="dn-dim" style="padding:24px">Pick a target above to preview.</div>`;
		return;
	}
	const bgFill = state.embed.background === 'dark' ? '#0a0a10'
		: state.embed.background === 'light' ? '#f4f4f9'
		: 'transparent';
	const attrs = [
		sel.kind === 'avatar' ? `avatar-id="${esc(sel.id)}"` : `widget-id="${esc(sel.id)}"`,
		`bg="${esc(state.embed.background)}"`,
		`reveal="${esc(state.embed.reveal)}"`,
	];
	if (state.embed.hideChrome) attrs.push('hide-chrome');
	slot.style.background = bgFill;
	slot.innerHTML = `
		<threews-avatar ${attrs.join(' ')} style="display:block;width:100%;height:100%"></threews-avatar>
	`;
}

// ── Section 4: Embed policy ───────────────────────────────────────────────

function renderPolicy(host, state) {
	const agents = state.agents;
	host.innerHTML = `
		<div class="dn-section-head">
			<div>
				<div class="dn-panel-title">Embed policy</div>
				<div class="dn-panel-sub">
					Per-agent allowlist. By default an agent embeds anywhere; add hosts here to lock it down.
					<button type="button" class="dn-link" data-act="why-policy">Why does this matter?</button>
				</div>
			</div>
		</div>
		<div data-slot="policy-body">
			${state.errors?.agents
				? errorStateHTML({
					title: "Couldn't load your agents",
					body: 'We had trouble loading your agents to configure embed policies. Check your connection and try again.',
					scope: 'policy',
				})
				: agents.length
				? `<div class="dn-policy-table">
					<div class="dn-policy-head">
						<div>Agent</div>
						<div>Mode</div>
						<div>Allowed hosts (one per line)</div>
						<div></div>
					</div>
					${agents.map((a, i) => renderPolicyRow(a, i)).join('')}
				</div>`
				: emptyStateHTML({
					icon: '🤖',
					title: 'No agents yet',
					body: 'Embed policies let you restrict which sites each agent can run on. Create an agent first, then come back to lock down where it can be embedded.',
					actions: [
						{ label: '+ Create your first agent', href: '/dashboard/agents', id: 'create-agent', primary: true },
						{ label: "What's an agent?", href: '/docs/agents-vs-avatars', id: 'learn-agents' },
					],
					compact: true,
				})}
		</div>
	`;

	host.querySelector('[data-act="why-policy"]').addEventListener('click', () => openPolicyExplainer());
	host.querySelector('[data-sk-retry]')?.addEventListener('click', () => reloadAgents(state));

	// Lazy-load each agent's current policy and wire the row controls.
	if (!state.errors?.agents) agents.forEach((agent, i) => initPolicyRow(host, state, agent, i));
}

function renderPolicyRow(agent, i) {
	const name = agent.name || agent.id.slice(0, 8);
	return `
		<div class="dn-policy-row" data-policy-row="${i}" data-agent-id="${esc(agent.id)}">
			<div class="dn-policy-name">
				<div>${esc(name)}</div>
				<div class="dn-dim dn-mono-sm">${esc(agent.id.slice(0, 8))}…</div>
			</div>
			<div>
				<select data-policy-mode disabled aria-label="Embed policy mode for ${esc(name)}">
					<option value="allowlist">Allowlist</option>
					<option value="denylist">Denylist</option>
				</select>
			</div>
			<div>
				<textarea data-policy-hosts placeholder="example.com&#10;*.partner.io" rows="3" disabled aria-label="Allowed embed hosts for ${esc(name)}, one per line"></textarea>
			</div>
			<div class="dn-policy-actions">
				<span class="dn-tag" data-policy-status>Loading…</span>
				<button type="button" class="dn-btn" data-policy-save disabled>Save</button>
			</div>
		</div>
	`;
}

async function initPolicyRow(host, state, agent, i) {
	const row = host.querySelector(`[data-policy-row="${i}"]`);
	if (!row) return;
	const status = row.querySelector('[data-policy-status]');
	const modeSel = row.querySelector('[data-policy-mode]');
	const hostsTa = row.querySelector('[data-policy-hosts]');
	const saveBtn = row.querySelector('[data-policy-save]');

	let original = null;
	let saveTimer = null;

	const setStatus = (text, kind) => {
		status.className = 'dn-tag' + (kind ? ` ${kind}` : '');
		status.textContent = text;
	};

	try {
		const { policy } = await get(`/api/agents/${encodeURIComponent(agent.id)}/embed-policy`);
		original = policy || defaultClientPolicy();
		modeSel.value = original.origins?.mode || 'allowlist';
		hostsTa.value = (original.origins?.hosts || []).join('\n');
		modeSel.disabled = false;
		hostsTa.disabled = false;
		saveBtn.disabled = false;
		const count = (original.origins?.hosts || []).length;
		setStatus(count ? `${count} host${count === 1 ? '' : 's'}` : 'Anywhere', count ? 'success' : '');
	} catch (err) {
		setStatus(err instanceof ApiError ? err.message : 'Load failed', 'danger');
		return;
	}

	const markDirty = () => {
		const current = collectFromRow(modeSel, hostsTa);
		const same = JSON.stringify(current) === JSON.stringify({
			mode: original.origins?.mode || 'allowlist',
			hosts: original.origins?.hosts || [],
		});
		saveBtn.disabled = same;
		if (!same) setStatus('Unsaved', 'warn');
	};

	const debouncedSave = () => {
		if (saveTimer) clearTimeout(saveTimer);
		saveTimer = setTimeout(() => savePolicyRow(agent, original, modeSel, hostsTa, saveBtn, setStatus, (newPolicy) => { original = newPolicy; }), 800);
	};

	modeSel.addEventListener('change', () => { markDirty(); debouncedSave(); });
	hostsTa.addEventListener('input', () => { markDirty(); debouncedSave(); });
	hostsTa.addEventListener('blur', () => {
		if (!saveBtn.disabled) {
			if (saveTimer) clearTimeout(saveTimer);
			savePolicyRow(agent, original, modeSel, hostsTa, saveBtn, setStatus, (newPolicy) => { original = newPolicy; });
		}
	});
	saveBtn.addEventListener('click', () => {
		if (saveTimer) clearTimeout(saveTimer);
		savePolicyRow(agent, original, modeSel, hostsTa, saveBtn, setStatus, (newPolicy) => { original = newPolicy; });
	});
}

function collectFromRow(modeSel, hostsTa) {
	const hosts = hostsTa.value
		.split('\n')
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);
	return { mode: modeSel.value, hosts };
}

async function savePolicyRow(agent, original, modeSel, hostsTa, saveBtn, setStatus, onSaved) {
	const next = collectFromRow(modeSel, hostsTa);
	const body = {
		...defaultClientPolicy(),
		...original,
		origins: { mode: next.mode, hosts: next.hosts },
	};
	body.version = 1;
	// Strip any host that has spaces / obviously invalid chars before sending;
	// the server validates with a strict regex and will 400 otherwise.
	body.origins.hosts = body.origins.hosts.filter((h) => /^(\*\.)?[a-z0-9.-]+$/.test(h));
	saveBtn.disabled = true;
	setStatus('Saving…');
	try {
		const resp = await put(`/api/agents/${encodeURIComponent(agent.id)}/embed-policy`, body);
		const saved = resp?.policy || body;
		onSaved(saved);
		const count = (saved.origins?.hosts || []).length;
		setStatus(count ? `${count} host${count === 1 ? '' : 's'}` : 'Anywhere', count ? 'success' : '');
		saveBtn.disabled = true;
	} catch (err) {
		// Revert UI to last-known-good
		modeSel.value = original.origins?.mode || 'allowlist';
		hostsTa.value = (original.origins?.hosts || []).join('\n');
		saveBtn.disabled = false;
		setStatus('Save failed', 'danger');
		toast(err instanceof ApiError ? err.message : 'Could not save policy', 'danger');
	}
}

function defaultClientPolicy() {
	return {
		version: 1,
		origins: { mode: 'allowlist', hosts: [] },
		surfaces: { script: true, iframe: true, widget: true, mcp: false },
		brain: {
			mode: 'we-pay',
			proxy_url: null,
			monthly_quota: 1000,
			rate_limit_per_min: 10,
			model: 'openai/gpt-oss-20b:free',
		},
		storage: { primary: 'r2', pinned_ipfs: false, onchain_attested: false },
	};
}

function openPolicyExplainer() {
	openModal(`
		<div class="dn-modal-head">
			<h2>Why embed policies matter</h2>
			<button type="button" class="dn-btn ghost" data-modal-close aria-label="Close">×</button>
		</div>
		<div class="dn-modal-body">
			<p>By default an agent can be embedded on any website — convenient for testing but it means anyone could iframe your agent on a site you don't control and rack up brain-model usage on your account.</p>
			<p>An <strong>allowlist</strong> restricts which referrer hosts the agent will respond to. Add the domains you intend to embed on (e.g. <code>example.com</code>, <code>*.partner.io</code>). Requests from anywhere else are rejected before your model budget is touched.</p>
			<p>A <strong>denylist</strong> is the inverse — convenient when you want to block a specific abuser without locking down everything.</p>
			<p>Leave the allowlist empty to keep the embed open to all origins.</p>
		</div>
		<div class="dn-modal-foot">
			<button type="button" class="dn-btn primary" data-modal-close data-autofocus>Got it</button>
		</div>
	`);
}

// ── Page-scoped CSS ───────────────────────────────────────────────────────

function injectStyles() {
	if (document.querySelector('#dn-api-styles')) return;
	const style = document.createElement('style');
	style.id = 'dn-api-styles';
	style.textContent = `
		.dn-stack { display: flex; flex-direction: column; gap: 18px; }
		.dn-section-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 14px; }
		.dn-section-head .dn-panel-title, .dn-section-head .dn-panel-sub { margin: 0; }
		.dn-section-head .dn-panel-sub { margin-top: 4px; }

		.dn-table-wrap { overflow-x: auto; border: 1px solid var(--nxt-stroke); border-radius: var(--nxt-radius-sm); }
		.dn-table { width: 100%; border-collapse: collapse; font-size: 13px; }
		.dn-table th, .dn-table td { padding: 10px 12px; text-align: left; vertical-align: middle; }
		.dn-table thead th { font-weight: 500; font-size: 11.5px; color: var(--nxt-ink-fade); text-transform: uppercase; letter-spacing: 0.06em; border-bottom: 1px solid var(--nxt-stroke); background: rgba(255,255,255,0.02); }
		.dn-table tbody tr + tr td { border-top: 1px solid var(--nxt-stroke); }
		.dn-chip-row { display: flex; flex-wrap: wrap; gap: 4px; }
		.dn-mono-sm { font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 11.5px; color: var(--nxt-ink-dim); }
		.dn-dim { color: var(--nxt-ink-dim); }
		/* A key that can no longer authenticate (revoked or past its expiry) stays
		   in the table for the record but recedes behind the usable ones. */
		.dn-table tbody tr.dn-row-muted td { opacity: 0.55; }
		.dn-table tbody tr.dn-row-muted:hover td { opacity: 1; }

		/* Tabs (pill style — matches Library page) */
		.dn-tabs { display: inline-flex; gap: 4px; padding: 4px; border: 1px solid var(--nxt-stroke); border-radius: var(--nxt-radius-pill); background: rgba(255,255,255,0.03); margin-bottom: 12px; }
		.dn-tab { background: transparent; border: 0; color: var(--nxt-ink-dim); font-size: 12.5px; padding: 6px 14px; border-radius: var(--nxt-radius-pill); cursor: pointer; transition: all 0.12s ease; }
		.dn-tab:hover { color: var(--nxt-ink); }
		.dn-tab.active { background: var(--nxt-accent-soft); color: var(--nxt-ink); }

		/* Code blocks */
		.dn-code-block { position: relative; }
		.dn-code-block pre { margin: 0; padding: 14px 16px; background: #0a0a10; border: 1px solid var(--nxt-stroke); border-left: 2px solid var(--nxt-accent); border-radius: var(--nxt-radius-sm); overflow: auto; max-height: 320px; }
		.dn-code-block code { font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 12.5px; color: #d8dbe5; white-space: pre; }
		.dn-code-copy { position: absolute; top: 8px; right: 8px; background: rgba(20,21,28,0.85); border: 1px solid var(--nxt-stroke); color: var(--nxt-ink-dim); font-size: 11px; padding: 4px 10px; border-radius: var(--nxt-radius-sm); cursor: pointer; opacity: 0.4; transition: opacity 0.12s ease, color 0.12s ease; backdrop-filter: blur(8px); }
		.dn-code-block:hover .dn-code-copy { opacity: 1; }
		.dn-code-copy:hover { color: var(--nxt-ink); }
		.dn-code-copy.copied { color: var(--nxt-success); }

		/* Agent Toolkit */
		.dn-toolkit-panel { background: radial-gradient(120% 140% at 0% 0%, var(--nxt-accent-soft, rgba(255,255,255,0.06)) 0%, transparent 55%), var(--nxt-panel, rgba(255,255,255,0.02)); }
		.dn-toolkit-hero { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; flex-wrap: wrap; }
		.dn-toolkit-copy { max-width: 560px; }
		.dn-toolkit-eyebrow { font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.1em; color: var(--nxt-ink-fade); margin-bottom: 8px; }
		.dn-toolkit-h { margin: 0 0 8px; font-size: 22px; font-weight: 600; letter-spacing: -0.02em; color: var(--nxt-ink); }
		.dn-toolkit-sub { margin: 0; font-size: 13.5px; line-height: 1.6; color: var(--nxt-ink-dim); }
		.dn-toolkit-cta { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 16px; }
		.dn-connect-claude { display: inline-flex; align-items: center; gap: 7px; }
		.dn-connect-claude svg { flex-shrink: 0; }

		.dn-toolkit-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-top: 20px; }
		@media (max-width: 820px) { .dn-toolkit-grid { grid-template-columns: 1fr; } }
		.dn-toolkit-card { display: flex; flex-direction: column; gap: 8px; padding: 14px; border: 1px solid var(--nxt-stroke); border-radius: var(--nxt-radius-sm); background: rgba(255,255,255,0.015); transition: border-color 0.14s ease, transform 0.14s ease; }
		.dn-toolkit-card:hover { border-color: var(--nxt-accent, rgba(255,255,255,0.25)); transform: translateY(-1px); }
		.dn-toolkit-card-head { display: flex; align-items: center; gap: 8px; }
		.dn-toolkit-card-tag { font-size: 10.5px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.07em; color: var(--nxt-ink); background: var(--nxt-accent-soft, rgba(255,255,255,0.08)); padding: 2px 7px; border-radius: var(--nxt-radius-pill); }
		.dn-toolkit-card-title { font-size: 13.5px; font-weight: 500; color: var(--nxt-ink); }
		.dn-toolkit-card-desc { margin: 0; font-size: 12px; line-height: 1.5; color: var(--nxt-ink-fade); flex: 1; }
		.dn-toolkit-cmd { position: relative; display: flex; align-items: center; }
		.dn-toolkit-cmd code { display: block; width: 100%; font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 11.5px; color: #d8dbe5; background: #0a0a10; border: 1px solid var(--nxt-stroke); border-left: 2px solid var(--nxt-accent); border-radius: var(--nxt-radius-sm); padding: 9px 52px 9px 11px; overflow-x: auto; white-space: nowrap; }
		.dn-toolkit-cmd-copy { position: absolute; top: 50%; right: 6px; transform: translateY(-50%); opacity: 0.5; }
		.dn-toolkit-cmd:hover .dn-toolkit-cmd-copy { opacity: 1; }
		.dn-toolkit-card-doc { font-size: 11.5px; color: var(--nxt-ink-dim); text-decoration: none; transition: color 0.12s ease; }
		.dn-toolkit-card-doc:hover { color: var(--nxt-ink); }
		.dn-toolkit-foot { display: flex; flex-wrap: wrap; gap: 18px; margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--nxt-stroke); }

		.dn-modal-block { margin-bottom: 16px; }
		.dn-modal-block-label { font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--nxt-ink-fade); margin-bottom: 7px; }
		.dn-modal-hint { margin: 0 0 7px; font-size: 12px; color: var(--nxt-ink-dim); }
		.dn-modal-hint code { font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 11.5px; padding: 1px 5px; background: rgba(255,255,255,0.06); border-radius: 4px; }

		/* MCP */
		.dn-mcp-key-picker { display: inline-flex; align-items: center; gap: 8px; font-size: 12.5px; }
		.dn-mcp-key-picker select { background: rgba(255,255,255,0.04); border: 1px solid var(--nxt-stroke); color: var(--nxt-ink); padding: 6px 9px; border-radius: var(--nxt-radius-sm); font-size: 12.5px; }
		.dn-mcp-panels { margin-bottom: 14px; }
		.dn-mcp-hint { font-size: 12.5px; color: var(--nxt-ink-dim); background: rgba(200, 202, 208, 0.06); border: 1px solid var(--nxt-accent-soft); border-radius: var(--nxt-radius-sm); padding: 9px 12px; margin-bottom: 12px; }
		.dn-mcp-hint code { color: var(--nxt-ink); background: rgba(255,255,255,0.06); padding: 1px 6px; border-radius: 4px; }
		.dn-mcp-test { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
		.dn-mcp-result { display: inline-flex; align-items: center; }

		/* Embed */
		.dn-embed-grid { display: grid; grid-template-columns: 1fr 320px; gap: 18px; align-items: start; }
		@media (max-width: 960px) { .dn-embed-grid { grid-template-columns: 1fr; } }
		.dn-embed-controls { min-width: 0; }
		.dn-knob-row { display: flex; gap: 12px; margin-bottom: 10px; flex-wrap: wrap; }
		.dn-knob { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--nxt-ink-dim); flex: 1 1 140px; }
		.dn-knob input, .dn-knob select { background: rgba(255,255,255,0.04); border: 1px solid var(--nxt-stroke); color: var(--nxt-ink); padding: 7px 9px; border-radius: var(--nxt-radius-sm); font-size: 13px; font-family: inherit; width: 100%; }
		.dn-knob input:focus, .dn-knob select:focus { outline: none; border-color: var(--nxt-accent); }
		.dn-knob-check { flex-direction: row; align-items: center; gap: 8px; }
		.dn-knob-check input { width: auto; }
		.dn-embed-preview { border: 1px solid var(--nxt-stroke); border-radius: var(--nxt-radius); overflow: hidden; }
		.dn-embed-preview-label { padding: 8px 12px; border-bottom: 1px solid var(--nxt-stroke); font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.06em; background: rgba(255,255,255,0.02); }
		.dn-embed-preview-frame { width: 320px; height: 320px; max-width: 100%; display: block; position: relative; }

		/* Policy */
		.dn-policy-table { border: 1px solid var(--nxt-stroke); border-radius: var(--nxt-radius-sm); overflow: hidden; }
		.dn-policy-head, .dn-policy-row { display: grid; grid-template-columns: 1.2fr 0.8fr 2fr 1fr; gap: 12px; padding: 12px; align-items: start; }
		.dn-policy-head { background: rgba(255,255,255,0.02); border-bottom: 1px solid var(--nxt-stroke); font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--nxt-ink-fade); }
		.dn-policy-row + .dn-policy-row { border-top: 1px solid var(--nxt-stroke); }
		.dn-policy-name { display: flex; flex-direction: column; gap: 2px; font-size: 13px; }
		.dn-policy-row select, .dn-policy-row textarea { width: 100%; background: rgba(255,255,255,0.04); border: 1px solid var(--nxt-stroke); color: var(--nxt-ink); padding: 7px 9px; border-radius: var(--nxt-radius-sm); font-size: 12.5px; font-family: inherit; }
		.dn-policy-row textarea { font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 12px; resize: vertical; min-height: 60px; }
		.dn-policy-row select:focus, .dn-policy-row textarea:focus { outline: none; border-color: var(--nxt-accent); }
		.dn-policy-actions { display: flex; flex-direction: column; gap: 6px; align-items: stretch; }

		/* Modal */
		.dn-modal-backdrop { position: fixed; inset: 0; background: rgba(5,6,12,0.7); backdrop-filter: blur(6px); display: grid; place-items: center; z-index: 200; padding: 24px; }
		.dn-modal { background: linear-gradient(180deg, rgba(20,21,28,0.95), rgba(14,15,22,0.95)); border: 1px solid var(--nxt-stroke); border-radius: var(--nxt-radius); padding: 22px; width: 520px; max-width: 100%; max-height: 90vh; overflow-y: auto; box-shadow: 0 24px 60px rgba(0,0,0,0.5); }
		.dn-modal-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 14px; }
		.dn-modal-head h2 { margin: 0; font-size: 17px; font-weight: 600; letter-spacing: -0.01em; }
		.dn-modal-body { font-size: 13.5px; color: var(--nxt-ink-dim); line-height: 1.6; }
		.dn-modal-body p { margin: 0 0 10px; }
		.dn-modal-body code { font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 12px; padding: 1px 5px; background: rgba(255,255,255,0.06); border-radius: 4px; }
		.dn-modal-foot { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }
		.dn-field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 14px; font-size: 12.5px; color: var(--nxt-ink-dim); }
		.dn-field > span, .dn-field > legend { font-weight: 500; }
		.dn-field input, .dn-field select { background: rgba(255,255,255,0.04); border: 1px solid var(--nxt-stroke); color: var(--nxt-ink); padding: 9px 11px; border-radius: var(--nxt-radius-sm); font-size: 13.5px; font-family: inherit; }
		.dn-field input:focus, .dn-field select:focus { outline: none; border-color: var(--nxt-accent); }
		.dn-scopes { display: flex; flex-direction: column; gap: 10px; padding: 10px; border: 1px solid var(--nxt-stroke); border-radius: var(--nxt-radius-sm); background: rgba(255,255,255,0.02); }
		.dn-scope-row { display: flex; gap: 10px; align-items: flex-start; cursor: pointer; }
		.dn-scope-row input { margin-top: 3px; }
		.dn-scope-label { font-size: 13px; color: var(--nxt-ink); }
		.dn-scope-label code { font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 12px; }
		.dn-scope-note { font-size: 12px; color: var(--nxt-ink-fade); }
		.dn-warn-banner { padding: 12px 14px; border-radius: var(--nxt-radius-sm); background: rgba(168,173,181,0.08); border: 1px solid rgba(168,173,181,0.25); color: var(--nxt-warn); font-size: 13px; margin-bottom: 14px; line-height: 1.5; }
		.dn-warn-banner strong { color: var(--nxt-ink); display: block; margin-bottom: 4px; }
		.dn-error { padding: 10px 12px; border-radius: var(--nxt-radius-sm); background: rgba(150,155,163,0.1); border: 1px solid rgba(150,155,163,0.25); color: var(--nxt-danger); font-size: 13px; margin-bottom: 12px; }

		/* Link button */
		.dn-link { background: none; border: 0; color: var(--nxt-accent-strong, #c8cad0); cursor: pointer; padding: 0; font: inherit; text-decoration: underline; }
		.dn-link:hover { color: var(--nxt-ink); }

		/* Toasts */
		.dn-toasts { position: fixed; bottom: 24px; right: 24px; display: flex; flex-direction: column; gap: 8px; z-index: 300; pointer-events: none; }
		.dn-toast { background: rgba(20,21,28,0.95); border: 1px solid var(--nxt-stroke); border-radius: var(--nxt-radius-sm); padding: 10px 14px; font-size: 13px; color: var(--nxt-ink); box-shadow: 0 8px 24px rgba(0,0,0,0.4); transition: opacity 0.25s ease; pointer-events: auto; }
		.dn-toast-danger { border-color: rgba(150,155,163,0.4); color: var(--nxt-danger); }
		.dn-toast-info { color: var(--nxt-ink); }

		/* Keyboard focus rings — visible only for keyboard users, never on mouse click */
		.dn-tab:focus-visible, .dn-link:focus-visible, .dn-code-copy:focus-visible,
		.dn-toolkit-cmd-copy:focus-visible, .dn-toolkit-card-doc:focus-visible,
		.dn-mcp-key-picker select:focus-visible, .dn-knob input:focus-visible,
		.dn-knob select:focus-visible, .dn-policy-row select:focus-visible,
		.dn-policy-row textarea:focus-visible, .dn-field input:focus-visible,
		.dn-field select:focus-visible, .dn-scope-row input:focus-visible {
			outline: 2px solid var(--nxt-accent); outline-offset: 2px;
		}
		.dn-toolkit-card:focus-within { border-color: var(--nxt-accent); }

		/* Honor reduced-motion: drop transforms and transitions, keep state changes instant */
		@media (prefers-reduced-motion: reduce) {
			.dn-toolkit-card, .dn-tab, .dn-code-copy, .dn-toolkit-cmd-copy,
			.dn-toolkit-card-doc, .dn-toast { transition: none; }
			.dn-toolkit-card:hover { transform: none; }
		}
	`;
	document.head.appendChild(style);
}
