// dashboard-next — API & Embed page.
//
// Four sections:
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

// Scopes accepted by /api/keys — match api/keys/index.js ALLOWED_SCOPES exactly.
const SCOPES = [
	{ value: 'avatars:read',   label: 'avatars:read',   note: 'List, fetch, and stream avatars' },
	{ value: 'avatars:write',  label: 'avatars:write',  note: 'Create or modify avatars' },
	{ value: 'avatars:delete', label: 'avatars:delete', note: 'Permanently remove avatars' },
	{ value: 'profile',        label: 'profile',        note: 'Read the signed-in user record' },
];

const EXPIRY_OPTIONS = [
	{ label: 'Never',   days: null },
	{ label: '30 days', days: 30 },
	{ label: '90 days', days: 90 },
	{ label: '1 year',  days: 365 },
];

const KEY_PLACEHOLDER = 'YOUR_API_KEY';

(async function boot() {
	const main = await mountShell();
	const me = await requireUser();

	main.innerHTML = `
		<h1 class="dn-h1">API & embed</h1>
		<p class="dn-h1-sub">Issue keys, configure MCP clients, embed agents anywhere.</p>
		<div class="dn-stack" data-slot="content">
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
		keys:   content.querySelector('[data-section="keys"]'),
		mcp:    content.querySelector('[data-section="mcp"]'),
		embed:  content.querySelector('[data-section="embed"]'),
		policy: content.querySelector('[data-section="policy"]'),
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

	state.selectedKeyForMcp = pickDisplayKey(state.keys);
	state.embed.selection = pickDefaultEmbedTarget(state.avatars, state.widgets, state.agents);

	renderKeys(sections.keys, state);
	renderMcp(sections.mcp, state);
	renderEmbed(sections.embed, state);
	renderPolicy(sections.policy, state);
})();

// ── Helpers ────────────────────────────────────────────────────────────────

function pickDisplayKey(keys) {
	const live = keys.find((k) => !k.revoked_at);
	return live || null;
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
		<div data-slot="keys-body">${hasKeys ? renderKeysTable(list) : renderKeysEmpty()}</div>
	`;

	host.querySelector('[data-act="new-key"]').addEventListener('click', () => openNewKeyModal(state));
	host.querySelectorAll('[data-act="revoke"]').forEach((btn) => {
		btn.addEventListener('click', () => confirmRevokeKey(state, btn.dataset.keyId, btn.dataset.keyName));
	});
}

function renderKeysEmpty() {
	return `
		<div class="dn-empty">
			<h3>No keys yet</h3>
			<p>Issue one to start hitting the API or connect an MCP client.</p>
		</div>
	`;
}

function renderKeysTable(keys) {
	return `
		<div class="dn-table-wrap">
			<table class="dn-table">
				<thead>
					<tr>
						<th>Name</th>
						<th>Prefix</th>
						<th>Scopes</th>
						<th>Created</th>
						<th>Last used</th>
						<th></th>
					</tr>
				</thead>
				<tbody>
					${keys.map((k) => `
						<tr>
							<td>${esc(k.name)}</td>
							<td><code class="dn-mono-sm">${esc(k.prefix)}…</code></td>
							<td>
								<div class="dn-chip-row">
									${(k.scope || '').split(/\s+/).filter(Boolean).map((s) => `<span class="dn-tag">${esc(s)}</span>`).join('')}
								</div>
							</td>
							<td><span class="dn-dim">${esc(relTime(k.created_at))}</span></td>
							<td><span class="dn-dim">${k.last_used_at ? esc(relTime(k.last_used_at)) : 'never'}</span></td>
							<td style="text-align:right">
								<button class="dn-btn danger" data-act="revoke" data-key-id="${esc(k.id)}" data-key-name="${esc(k.name)}">Revoke</button>
							</td>
						</tr>
					`).join('')}
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
			<button type="button" class="dn-code-copy" data-copy>Copy</button>
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

		<div class="dn-tabs" role="tablist">
			${MCP_TABS.map((t, i) => `
				<button class="dn-tab ${i === 0 ? 'active' : ''}" role="tab" data-mcp-tab="${esc(t.id)}">${esc(t.label)}</button>
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
			host.querySelectorAll('[data-mcp-tab]').forEach((b) => b.classList.toggle('active', b === btn));
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
			<button type="button" class="dn-code-copy" data-copy="${id}">Copy</button>
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
		// We can't ship the user's plaintext key (it's hashed server-side after
		// creation), so we exercise the MCP endpoint with the session cookie
		// — same auth path the dashboard's own MCP integration uses.
		const res = await fetch('/api/mcp', {
			method: 'POST',
			credentials: 'include',
			headers: {
				accept: 'application/json',
				'content-type': 'application/json',
			},
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
		});
		const data = await res.json().catch(() => null);
		if (res.ok && data && (data.result || Array.isArray(data))) {
			const tools = data.result?.tools || [];
			result.innerHTML = `<span class="dn-tag success">OK · ${tools.length} tool${tools.length === 1 ? '' : 's'}</span>`;
		} else {
			const msg = data?.error?.message || `HTTP ${res.status}`;
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
		host.innerHTML = `
			<div class="dn-section-head">
				<div>
					<div class="dn-panel-title">Embed snippets</div>
					<div class="dn-panel-sub">Drop your avatar or widget into any web page.</div>
				</div>
			</div>
			<div class="dn-empty">
				<h3>Nothing to embed yet</h3>
				<p>Create an avatar or widget first, then come back here for the snippet.</p>
				<a class="dn-btn" href="/dashboard/avatars">Go to avatars</a>
			</div>
		`;
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
				<select data-embed-target>
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

				<div class="dn-tabs" role="tablist" style="margin-top:14px">
					${EMBED_TABS.map((t) => `
						<button class="dn-tab ${state.embed.tab === t.id ? 'active' : ''}" role="tab" data-embed-tab="${esc(t.id)}">${esc(t.label)}</button>
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
			host.querySelectorAll('[data-embed-tab]').forEach((x) => x.classList.toggle('active', x === b));
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
			<button type="button" class="dn-code-copy" data-copy="embed">Copy</button>
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
			? `${o}/agent/${encodeURIComponent(sel.agentId)}/embed`
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
			${agents.length
				? `<div class="dn-policy-table">
					<div class="dn-policy-head">
						<div>Agent</div>
						<div>Mode</div>
						<div>Allowed hosts (one per line)</div>
						<div></div>
					</div>
					${agents.map((a, i) => renderPolicyRow(a, i)).join('')}
				</div>`
				: `<div class="dn-empty"><h3>No agents yet</h3><p>Create an agent before locking down where it can be embedded.</p></div>`}
		</div>
	`;

	host.querySelector('[data-act="why-policy"]').addEventListener('click', () => openPolicyExplainer());

	// Lazy-load each agent's current policy and wire the row controls.
	agents.forEach((agent, i) => initPolicyRow(host, state, agent, i));
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
				<select data-policy-mode disabled>
					<option value="allowlist">Allowlist</option>
					<option value="denylist">Denylist</option>
				</select>
			</div>
			<div>
				<textarea data-policy-hosts placeholder="example.com&#10;*.partner.io" rows="3" disabled></textarea>
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
			model: 'meta-llama/llama-3.3-70b-instruct:free',
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
	`;
	document.head.appendChild(style);
}
