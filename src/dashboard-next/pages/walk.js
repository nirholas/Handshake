// dashboard-next — Walk Companion settings.
//
// A dedicated editor for the @three-ws/walk SDK (walk-sdk/README.md): the
// walking 3D avatar companion + full-page playground that ships across
// three.ws. Everything configurable through `createWalkCompanion(options)` is
// surfaced here, persisted, and applied live.
//
// Persistence is two-layered, mirroring how the SDK actually reads state:
//   • localStorage — the companion reads `walk:companion:enabled` and
//     `walk:companion:avatar` directly, so writing them takes effect on the
//     next page load (and immediately, via window.__walkCompanion).
//   • /api/dashboard/prefs (PATCH) — durable per-user backup under prefs.walk
//     so the configuration follows the user across browsers/devices.
//
// The page also renders a live install snippet so a developer can lift the
// exact `createWalkCompanion({...})` call for their own site, and drives the
// live companion on this very page for an instant preview.

import { mountShell } from '../shell.js';
import { requireUser, get, patch, esc, ApiError } from '../api.js';
import {
	WALK_AVATARS,
	DEFAULT_AVATAR_ID,
	resolveAvatarUrl,
} from '../../../walk-sdk/src/roster.js';
import { DEFAULT_EXCLUDED_PREFIXES } from '../../../walk-sdk/src/config.js';
import { toast } from '../../shared/toast.js';

const MONO = `'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace`;

// localStorage keys the live companion reads (storagePrefix defaults to 'walk').
const LS = {
	enabled: 'walk:companion:enabled',
	avatar: 'walk:companion:avatar',
};

// The shape we persist (a subset of createWalkCompanion options + the live
// toggle). Defaults match walk-sdk/src/config.js → resolveConfig exactly.
const DEFAULTS = {
	enabled: true,
	defaultAvatarId: DEFAULT_AVATAR_ID,
	enablePicker: true,
	greeting: '',
	assetBase: '',
	apiBase: '',
	manifestUrl: '/animations/manifest.json',
	docsUrl: '/avatar-studio',
	excludedRoutes: DEFAULT_EXCLUDED_PREFIXES.join('\n'),
};

let state = { ...DEFAULTS };

// ── boot ────────────────────────────────────────────────────────────────────

(async function boot() {
	try {
		const main = await mountShell();
		await requireUser();

		main.innerHTML = `
			<h1 class="dn-h1">Walk Companion</h1>
			<p class="dn-h1-sub">Configure the <code style="font-family:${MONO};font-size:12.5px;color:var(--nxt-ink)">@three-ws/walk</code> avatar that walks and talks across your pages.</p>
			<div data-slot="content" style="display:flex;flex-direction:column;gap:16px">
				${Array.from({ length: 4 }).map(() => `<div class="dn-skeleton" style="height:140px;border-radius:12px"></div>`).join('')}
			</div>
		`;

		const host = main.querySelector('[data-slot="content"]');
		injectWalkStyles();

		const prefsResp = await safeGet('/api/dashboard/prefs');
		hydrateState(prefsResp?.prefs || prefsResp || {});

		host.innerHTML = '';
		host.appendChild(renderStatus());
		host.appendChild(renderCompanion());
		host.appendChild(renderRoster());
		host.appendChild(renderGreeting());
		host.appendChild(renderDelivery());
		host.appendChild(renderExcluded());
		host.appendChild(renderSnippet());
		host.appendChild(renderActions());
		host.appendChild(renderAbout());

		refreshDerived();
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

// Merge server prefs and local overrides into `state`. localStorage wins for
// the two keys the live companion actually owns, so the page reflects reality.
function hydrateState(prefs) {
	const saved = prefs && typeof prefs.walk === 'object' && prefs.walk ? prefs.walk : {};
	state = { ...DEFAULTS, ...saved };

	const lsEnabled = localStorage.getItem(LS.enabled);
	if (lsEnabled === '1') state.enabled = true;
	else if (lsEnabled === '0') state.enabled = false;

	const lsAvatar = localStorage.getItem(LS.avatar);
	if (lsAvatar) state.defaultAvatarId = lsAvatar;
}

// ── status ───────────────────────────────────────────────────────────────────

function renderStatus() {
	const panel = document.createElement('div');
	panel.className = 'dn-panel';
	panel.dataset.slot = 'status';
	panel.innerHTML = statusInner();
	return panel;
}

function statusInner() {
	const av = WALK_AVATARS.find((a) => a.id === state.defaultAvatarId);
	const avatarLabel = av ? `${av.emoji || ''} ${av.name}`.trim() : state.defaultAvatarId;
	return `
		<div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap">
			<div style="width:46px;height:46px;border-radius:12px;display:grid;place-items:center;font-size:24px;flex-shrink:0;background:${av?.accent ? hexSoft(av.accent) : 'var(--nxt-accent-soft)'};border:1px solid var(--nxt-stroke)">
				${av?.emoji ? esc(av.emoji) : '🚶'}
			</div>
			<div style="flex:1;min-width:200px">
				<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
					<span class="dn-panel-title">Companion is ${state.enabled ? '<span style="color:var(--nxt-success)">on</span>' : '<span style="color:var(--nxt-ink-fade)">off</span>'}</span>
					<span class="dn-tag ${state.enabled ? 'success' : ''}">${state.enabled ? 'Live' : 'Hidden'}</span>
				</div>
				<div class="dn-panel-sub" style="margin:3px 0 0">
					Walking as <strong style="color:var(--nxt-ink)">${esc(avatarLabel)}</strong>${state.enablePicker ? ' · visitors can swap avatars' : ' · avatar locked'}.
				</div>
			</div>
			<div style="display:flex;gap:8px;flex-wrap:wrap">
				<button class="dn-btn" data-action="preview" type="button">${state.enabled ? 'Show here' : 'Preview here'}</button>
				<a class="dn-btn" href="/walk" target="_blank" rel="noopener" style="text-decoration:none">Open playground ↗</a>
			</div>
		</div>
	`;
}

function bindStatus(panel) {
	panel.querySelector('[data-action="preview"]')?.addEventListener('click', () => {
		applyLive();
		toast(state.enabled ? 'Companion mounted on this page' : 'Companion enabled for preview');
		if (!state.enabled) { state.enabled = true; refreshDerived(); }
	});
}

// ── companion (core toggles) ──────────────────────────────────────────────────

function renderCompanion() {
	const panel = document.createElement('div');
	panel.className = 'dn-panel';
	panel.innerHTML = `
		<div style="margin-bottom:14px">
			<div class="dn-panel-title">Companion</div>
			<div class="dn-panel-sub" style="margin:2px 0 0">Whether the corner mascot mounts, and whether visitors may choose their own.</div>
		</div>
		<div style="display:flex;flex-direction:column;gap:14px">
			${toggleRow('enabled', 'Enable companion', 'Mount the walking avatar in the corner of your pages. Off hides it everywhere.', state.enabled)}
			${toggleRow('enablePicker', 'Show avatar picker', 'Let visitors open the roster and pick who walks with them.', state.enablePicker)}
		</div>
	`;
	panel.querySelectorAll('[data-toggle]').forEach((input) => {
		input.addEventListener('change', () => {
			state[input.dataset.toggle] = input.checked;
			refreshDerived();
			if (input.dataset.toggle === 'enabled') applyLive();
		});
	});
	return panel;
}

// ── roster (default avatar picker) ────────────────────────────────────────────

function renderRoster() {
	const panel = document.createElement('div');
	panel.className = 'dn-panel';
	panel.innerHTML = `
		<div style="margin-bottom:14px">
			<div class="dn-panel-title">Default avatar</div>
			<div class="dn-panel-sub" style="margin:2px 0 0">Loaded for first-time visitors and whenever none is stored. ${WALK_AVATARS.length} in the roster.</div>
		</div>
		<div data-slot="roster-grid" role="group" aria-label="Default companion avatar" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(min(130px,100%),1fr));gap:10px"></div>
	`;
	const grid = panel.querySelector('[data-slot="roster-grid"]');
	grid.innerHTML = WALK_AVATARS.map((a) => avatarCard(a)).join('');

	grid.querySelectorAll('[data-avatar]').forEach((card) => {
		card.addEventListener('click', () => {
			state.defaultAvatarId = card.dataset.avatar;
			grid.querySelectorAll('[data-avatar]').forEach((c) => {
				c.setAttribute('aria-pressed', String(c.dataset.avatar === state.defaultAvatarId));
			});
			refreshDerived();
			applyLive();
		});
	});

	// Roving arrow-key navigation across the roster (focus only — selection
	// stays on click / Enter / Space, which buttons handle natively).
	grid.addEventListener('keydown', (ev) => {
		if (!['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(ev.key)) return;
		const cards = [...grid.querySelectorAll('[data-avatar]')];
		const i = cards.indexOf(document.activeElement);
		if (i === -1) return;
		ev.preventDefault();
		let n = i;
		if (ev.key === 'ArrowRight' || ev.key === 'ArrowDown') n = (i + 1) % cards.length;
		else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowUp') n = (i - 1 + cards.length) % cards.length;
		else if (ev.key === 'Home') n = 0;
		else if (ev.key === 'End') n = cards.length - 1;
		cards[n]?.focus();
	});
	return panel;
}

function avatarCard(a) {
	const selected = a.id === state.defaultAvatarId;
	const thumb = a.thumb ? resolveAvatarUrl({ ...a, asset: a.thumb }, {}) : '';
	return `
		<button class="dn-walk-card" data-avatar="${esc(a.id)}" type="button" aria-pressed="${selected}"
			style="position:relative;display:flex;flex-direction:column;align-items:center;gap:8px;padding:14px 10px 12px;border-radius:12px;cursor:pointer;text-align:center;
			background:rgba(255,255,255,0.02);border:1px solid ${selected ? 'var(--nxt-accent)' : 'var(--nxt-stroke)'};transition:border-color .15s,transform .15s,background .15s">
			<div style="width:54px;height:54px;border-radius:12px;display:grid;place-items:center;overflow:hidden;font-size:30px;background:${a.accent ? hexSoft(a.accent) : 'rgba(255,255,255,0.04)'}">
				${thumb ? `<img src="${esc(thumb)}" alt="" loading="lazy" style="width:100%;height:100%;object-fit:cover" onerror="this.replaceWith(document.createTextNode('${esc(a.emoji || '🚶')}'))" />` : esc(a.emoji || '🚶')}
			</div>
			<div style="font-size:13px;font-weight:600;color:var(--nxt-ink);line-height:1.1">${esc(a.name)}</div>
			<div style="font-size:11px;color:var(--nxt-ink-fade)">${esc(a.category || '')}</div>
			${selected ? `<span style="position:absolute;top:8px;right:8px;width:16px;height:16px;border-radius:50%;background:var(--nxt-accent);display:grid;place-items:center"><svg viewBox="0 0 12 12" width="9" height="9" fill="none" stroke="#000" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 6.5l2.5 2.5 4.5-5"/></svg></span>` : ''}
		</button>
	`;
}

// ── greeting ──────────────────────────────────────────────────────────────────

function renderGreeting() {
	const panel = document.createElement('div');
	panel.className = 'dn-panel';
	panel.innerHTML = `
		<div style="margin-bottom:14px">
			<div class="dn-panel-title">Page greeting</div>
			<div class="dn-panel-sub" style="margin:2px 0 0">A line the companion speaks when a visitor lands. Leave blank for the built-in per-page greeting. Use <code style="font-family:${MONO};font-size:12px">{path}</code> to insert the current path.</div>
		</div>
		${textField('greeting', state.greeting, 'Welcome to {path} 👋')}
	`;
	bindTextFields(panel);
	return panel;
}

// ── asset delivery (advanced) ─────────────────────────────────────────────────

function renderDelivery() {
	const panel = document.createElement('div');
	panel.className = 'dn-panel';
	panel.innerHTML = `
		<div style="margin-bottom:14px">
			<div class="dn-panel-title">Asset delivery</div>
			<div class="dn-panel-sub" style="margin:2px 0 0">Where the avatar GLBs, animation manifest, and "make your own" link resolve. Defaults serve from this origin — override to point at a CDN.</div>
		</div>
		<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(240px,100%),1fr));gap:14px">
			${labeledField('assetBase', 'Asset base', state.assetBase, 'https://cdn.example.com', 'Prepended to static GLB paths.')}
			${labeledField('apiBase', 'API base', state.apiBase, 'https://api.example.com', 'Prepended to the /api/avatars/<id>/glb proxy.')}
			${labeledField('manifestUrl', 'Manifest URL', state.manifestUrl, '/animations/manifest.json', 'Shared animation manifest for retargeted rigs.')}
			${labeledField('docsUrl', 'Docs / build link', state.docsUrl, '/avatar-studio', '"Make your own" link in the picker footer.')}
		</div>
	`;
	bindTextFields(panel);
	return panel;
}

// ── excluded routes ───────────────────────────────────────────────────────────

function renderExcluded() {
	const panel = document.createElement('div');
	panel.className = 'dn-panel';
	panel.innerHTML = `
		<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:14px">
			<div>
				<div class="dn-panel-title">Excluded routes</div>
				<div class="dn-panel-sub" style="margin:2px 0 0">Path prefixes where the companion never mounts — typically full-screen 3D pages. One per line.</div>
			</div>
			<button class="dn-btn ghost" data-action="reset-routes" type="button" style="font-size:12px">Reset to defaults</button>
		</div>
		<textarea data-text="excludedRoutes" rows="6" spellcheck="false"
			style="width:100%;box-sizing:border-box;resize:vertical;font-family:${MONO};font-size:12.5px;line-height:1.6;padding:12px 14px;border-radius:10px;color:var(--nxt-ink);background:rgba(0,0,0,0.25);border:1px solid var(--nxt-stroke)"
			placeholder="/embed&#10;/play&#10;/club">${esc(state.excludedRoutes)}</textarea>
	`;
	bindTextFields(panel);
	panel.querySelector('[data-action="reset-routes"]').addEventListener('click', () => {
		state.excludedRoutes = DEFAULT_EXCLUDED_PREFIXES.join('\n');
		panel.querySelector('[data-text="excludedRoutes"]').value = state.excludedRoutes;
		refreshDerived();
		toast('Excluded routes reset');
	});
	return panel;
}

// ── install snippet ───────────────────────────────────────────────────────────

function renderSnippet() {
	const panel = document.createElement('div');
	panel.className = 'dn-panel';
	panel.dataset.slot = 'snippet';
	panel.innerHTML = `
		<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:14px">
			<div>
				<div class="dn-panel-title">Install snippet</div>
				<div class="dn-panel-sub" style="margin:2px 0 0">Drop this into any site to ship the companion with your settings. Updates live as you edit above.</div>
			</div>
			<button class="dn-btn" data-action="copy-snippet" type="button">
				<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="5" y="5" width="9" height="9" rx="1.5"/><path d="M3 11V3a1 1 0 011-1h7"/></svg>
				Copy
			</button>
		</div>
		<pre data-slot="snippet-code" style="margin:0;overflow-x:auto;padding:16px;border-radius:10px;background:rgba(0,0,0,0.32);border:1px solid var(--nxt-stroke);font-family:${MONO};font-size:12.5px;line-height:1.6;color:var(--nxt-ink)"></pre>
	`;
	panel.querySelector('[data-slot="snippet-code"]').textContent = buildSnippet();
	panel.querySelector('[data-action="copy-snippet"]').addEventListener('click', async (e) => {
		const btn = e.currentTarget;
		try {
			await navigator.clipboard.writeText(buildSnippet());
			toast('Snippet copied');
			const original = btn.innerHTML;
			btn.innerHTML = 'Copied ✓';
			setTimeout(() => { btn.innerHTML = original; }, 1400);
		} catch {
			toast('Copy failed — select and copy manually');
		}
	});
	return panel;
}

// Build the exact createWalkCompanion(...) call for the current settings,
// emitting only non-default options so the snippet stays tight.
function buildSnippet() {
	const opts = [];
	if (state.defaultAvatarId !== DEFAULTS.defaultAvatarId) opts.push(`  defaultAvatarId: ${q(state.defaultAvatarId)},`);
	if (!state.enablePicker) opts.push('  enablePicker: false,');
	if (state.assetBase) opts.push(`  assetBase: ${q(state.assetBase)},`);
	if (state.apiBase) opts.push(`  apiBase: ${q(state.apiBase)},`);
	if (state.manifestUrl && state.manifestUrl !== DEFAULTS.manifestUrl) opts.push(`  manifestUrl: ${q(state.manifestUrl)},`);
	if (state.docsUrl) opts.push(`  docsUrl: ${q(state.docsUrl)},`);
	if (state.greeting.trim()) {
		const tmpl = state.greeting.replace(/`/g, '\\`').replace(/\$\{/g, '\\${').replace(/\{path\}/g, '${path}');
		opts.push(`  greeting: (path) => \`${tmpl}\`,`);
	}
	const routes = state.excludedRoutes.split('\n').map((r) => r.trim()).filter(Boolean);
	const routesDefault = arraysEqual(routes, DEFAULT_EXCLUDED_PREFIXES);
	if (routes.length && !routesDefault) {
		opts.push(`  excludedRoutes: [${routes.map(q).join(', ')}],`);
	}

	const optsBlock = opts.length ? `{\n${opts.join('\n')}\n}` : '';
	const call = `const walk = createWalkCompanion(${optsBlock});\nwalk.bootstrap();`;
	const disabledNote = state.enabled ? '' : `\n\n// Companion is currently disabled in your dashboard —\n// call walk.bootstrap() to mount it, or walk.disable() to keep it hidden.`;

	return `npm install @three-ws/walk three\n\nimport { createWalkCompanion } from '@three-ws/walk';\n\n${call}${disabledNote}`;
}

// ── actions (save / reset) ────────────────────────────────────────────────────

function renderActions() {
	const panel = document.createElement('div');
	panel.className = 'dn-panel';
	panel.style.cssText = 'position:sticky;bottom:16px;z-index:5;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;backdrop-filter:blur(12px)';
	panel.innerHTML = `
		<div style="font-size:12.5px;color:var(--nxt-ink-fade)">
			Saved to your account and applied to the live companion across three.ws.
		</div>
		<div style="display:flex;gap:10px;flex-wrap:wrap">
			<button class="dn-btn" data-action="reset-all" type="button">Reset all</button>
			<button class="dn-btn primary" data-action="save" type="button">Save settings</button>
		</div>
	`;

	panel.querySelector('[data-action="save"]').addEventListener('click', async (e) => {
		syncFromInputs();
		const btn = e.currentTarget;
		btn.disabled = true;
		btn.textContent = 'Saving…';
		try {
			await patch('/api/dashboard/prefs', { prefs: { walk: serialize() } });
			applyLive();
			toast('Walk Companion settings saved');
		} catch (err) {
			// localStorage still applies even if the durable backup fails — never
			// leave the user with a silent no-op.
			applyLive();
			toast(err?.message ? `Saved locally — ${err.message}` : 'Saved locally (sync unavailable)');
		} finally {
			btn.disabled = false;
			btn.textContent = 'Save settings';
		}
	});

	panel.querySelector('[data-action="reset-all"]').addEventListener('click', () => {
		if (!confirm('Reset all Walk Companion settings to their defaults?')) return;
		state = { ...DEFAULTS };
		rerenderInputs();
		refreshDerived();
		toast('Reset to defaults — Save to persist');
	});

	return panel;
}

// ── about ─────────────────────────────────────────────────────────────────────

function renderAbout() {
	const panel = document.createElement('div');
	panel.className = 'dn-panel';
	panel.innerHTML = `
		<div style="margin-bottom:12px">
			<div class="dn-panel-title">About the Walk SDK</div>
			<div class="dn-panel-sub" style="margin:2px 0 0">The companion + playground engine ships as a standalone, Apache-2.0 package.</div>
		</div>
		<div style="display:grid;grid-template-columns:auto 1fr;gap:8px 16px;font-size:13px;margin-bottom:16px">
			<span style="color:var(--nxt-ink-fade)">Package</span>
			<span style="font-family:${MONO};font-size:12px;color:var(--nxt-ink)">@three-ws/walk</span>
			<span style="color:var(--nxt-ink-fade)">Peer dep</span>
			<span style="font-family:${MONO};font-size:12px;color:var(--nxt-ink)">three &gt;= 0.150</span>
			<span style="color:var(--nxt-ink-fade)">Roster</span>
			<span style="color:var(--nxt-ink)">${WALK_AVATARS.length} avatars · embedded &amp; retargeted rigs</span>
		</div>
		<div style="display:flex;gap:10px;flex-wrap:wrap">
			<a class="dn-btn" href="/walk" target="_blank" rel="noopener" style="text-decoration:none">Try the playground ↗</a>
			<a class="dn-btn" href="/features/walk" style="text-decoration:none">Feature page</a>
			<a class="dn-btn" href="/dashboard/avatars" style="text-decoration:none">Build a custom avatar</a>
		</div>
	`;
	return panel;
}

// ── live application ──────────────────────────────────────────────────────────

// Push the relevant settings into localStorage (which the companion reads) and,
// when the live companion is present on this page, drive it directly so the
// preview is instant.
function applyLive() {
	localStorage.setItem(LS.enabled, state.enabled ? '1' : '0');
	localStorage.setItem(LS.avatar, state.defaultAvatarId);

	const walk = window.__walkCompanion;
	if (!walk) return;
	try {
		if (state.enabled) {
			if (!walk.isEnabled?.()) walk.enable();
			walk.setAvatar?.(state.defaultAvatarId);
		} else if (walk.isEnabled?.()) {
			walk.disable();
		}
	} catch { /* companion not interactive on this surface — localStorage still applies */ }
}

// ── persistence helpers ───────────────────────────────────────────────────────

function serialize() {
	return {
		enabled: state.enabled,
		defaultAvatarId: state.defaultAvatarId,
		enablePicker: state.enablePicker,
		greeting: state.greeting.trim(),
		assetBase: state.assetBase.trim(),
		apiBase: state.apiBase.trim(),
		manifestUrl: state.manifestUrl.trim(),
		docsUrl: state.docsUrl.trim(),
		excludedRoutes: state.excludedRoutes.split('\n').map((r) => r.trim()).filter(Boolean).join('\n'),
	};
}

// Pull current input values into state (text fields update on input, but this
// guarantees a clean read before save).
function syncFromInputs() {
	document.querySelectorAll('[data-text]').forEach((el) => {
		state[el.dataset.text] = el.value;
	});
	document.querySelectorAll('[data-toggle]').forEach((el) => {
		state[el.dataset.toggle] = el.checked;
	});
}

// After a programmatic state change (reset), re-render the input-bearing panels
// in place without a full reload.
function rerenderInputs() {
	const content = document.querySelector('[data-slot="content"]');
	if (!content) return;
	document.querySelectorAll('[data-text]').forEach((el) => {
		el.value = state[el.dataset.text] ?? '';
	});
	document.querySelectorAll('[data-toggle]').forEach((el) => {
		el.checked = !!state[el.dataset.toggle];
	});
	const grid = content.querySelector('[data-slot="roster-grid"]');
	if (grid) {
		grid.querySelectorAll('[data-avatar]').forEach((c) => {
			const sel = c.dataset.avatar === state.defaultAvatarId;
			c.setAttribute('aria-pressed', String(sel));
			c.style.borderColor = sel ? 'var(--nxt-accent)' : 'var(--nxt-stroke)';
		});
	}
}

// Refresh everything derived from state: status header, roster selection
// borders, and the live snippet.
function refreshDerived() {
	const statusPanel = document.querySelector('[data-slot="status"]');
	if (statusPanel) {
		statusPanel.innerHTML = statusInner();
		bindStatus(statusPanel);
	}
	const grid = document.querySelector('[data-slot="roster-grid"]');
	if (grid) {
		grid.querySelectorAll('[data-avatar]').forEach((c) => {
			const sel = c.dataset.avatar === state.defaultAvatarId;
			c.style.borderColor = sel ? 'var(--nxt-accent)' : 'var(--nxt-stroke)';
			const existing = c.querySelector('span[style*="position:absolute"]');
			if (sel && !existing) {
				const badge = document.createElement('span');
				badge.style.cssText = 'position:absolute;top:8px;right:8px;width:16px;height:16px;border-radius:50%;background:var(--nxt-accent);display:grid;place-items:center';
				badge.innerHTML = '<svg viewBox="0 0 12 12" width="9" height="9" fill="none" stroke="#000" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 6.5l2.5 2.5 4.5-5"/></svg>';
				c.appendChild(badge);
			} else if (!sel && existing) {
				existing.remove();
			}
		});
	}
	const code = document.querySelector('[data-slot="snippet-code"]');
	if (code) code.textContent = buildSnippet();
}

// ── small UI builders ─────────────────────────────────────────────────────────

function toggleRow(key, label, description, checked) {
	return `
		<label style="display:flex;align-items:center;justify-content:space-between;gap:16px;cursor:pointer">
			<div>
				<div style="font-size:13.5px;color:var(--nxt-ink);font-weight:500">${esc(label)}</div>
				<div style="font-size:12.5px;color:var(--nxt-ink-dim);margin-top:2px">${esc(description)}</div>
			</div>
			<input type="checkbox" data-toggle="${esc(key)}" ${checked ? 'checked' : ''}
				style="width:18px;height:18px;cursor:pointer;accent-color:var(--nxt-accent);flex-shrink:0" />
		</label>
	`;
}

function textField(key, value, placeholder) {
	return `
		<input type="text" data-text="${esc(key)}" value="${esc(value)}" placeholder="${esc(placeholder)}" spellcheck="false"
			style="width:100%;box-sizing:border-box;font-size:13.5px;padding:10px 14px;border-radius:10px;color:var(--nxt-ink);background:rgba(0,0,0,0.25);border:1px solid var(--nxt-stroke)" />
	`;
}

function labeledField(key, label, value, placeholder, hint) {
	return `
		<div>
			<label style="display:block;font-size:12.5px;font-weight:600;color:var(--nxt-ink);margin-bottom:6px">${esc(label)}</label>
			${textField(key, value, placeholder)}
			<div style="font-size:11.5px;color:var(--nxt-ink-fade);margin-top:5px">${esc(hint)}</div>
		</div>
	`;
}

function bindTextFields(panel) {
	panel.querySelectorAll('[data-text]').forEach((input) => {
		input.addEventListener('input', () => {
			state[input.dataset.text] = input.value;
			refreshDerived();
		});
		// Mirror the dashboard input focus affordance used elsewhere.
		input.addEventListener('focus', () => { input.style.borderColor = 'var(--nxt-accent)'; });
		input.addEventListener('blur', () => { input.style.borderColor = 'var(--nxt-stroke)'; });
	});
}

// ── utilities ─────────────────────────────────────────────────────────────────

function q(s) { return `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`; }

function arraysEqual(a, b) {
	return a.length === b.length && a.every((v, i) => v === b[i]);
}

// Translate a hex accent into a faint translucent fill for chips/thumbs.
function hexSoft(hex) {
	const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
	if (!m) return 'rgba(255,255,255,0.04)';
	const n = parseInt(m[1], 16);
	return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, 0.16)`;
}

// Scoped hover / focus / reduced-motion polish for the roster cards. Inline
// styles can't express pseudo-classes, so the interactive states live here.
function injectWalkStyles() {
	if (document.getElementById('dn-walk-styles')) return;
	const style = document.createElement('style');
	style.id = 'dn-walk-styles';
	style.textContent = `
		.dn-walk-card:not([aria-pressed="true"]):hover {
			border-color: var(--nxt-stroke-strong) !important;
			background: rgba(255,255,255,0.05) !important;
		}
		.dn-walk-card:hover { transform: translateY(-2px); }
		.dn-walk-card:active { transform: translateY(0); }
		.dn-walk-card:focus-visible {
			outline: 2px solid var(--nxt-accent);
			outline-offset: 2px;
		}
		@media (prefers-reduced-motion: reduce) {
			.dn-walk-card { transition: none !important; }
			.dn-walk-card:hover, .dn-walk-card:active { transform: none; }
		}
	`;
	document.head.appendChild(style);
}


