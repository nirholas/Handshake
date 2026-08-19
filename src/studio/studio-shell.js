/**
 * ════════════════════════════════════════════════════════════════════════════
 * Agent Studio — Shell  (P0 foundation)
 * ════════════════════════════════════════════════════════════════════════════
 *
 * The skeleton + nervous system of /agent-studio: a persistent live avatar stage
 * (<agent-presence mode="stage">, reusing the platform renderer) beside a tabbed
 * editing surface — Brain · Memory · Body · Money · Skills. This file builds the
 * shell, the auth/loading/empty/error states, the identity header (a REAL control
 * that proves the live edit→PUT→avatar path), and exposes mount points the five
 * sub-studios fill.
 *
 * ── MOUNT POINTS FOR P1–P5 ───────────────────────────────────────────────────
 * Each tab is an empty <section data-studio-mount="<domain>"> with a designed
 * empty state inside a <div class="studio-empty">. To fill a tab, mount into its
 * container and remove/hide the empty state:
 *
 *   import { studio } from '/src/studio/agent-studio-store.js';
 *   const mount = document.querySelector('[data-studio-mount="brain"]');
 *   mount.querySelector('.studio-empty')?.remove();
 *   // …render your sub-studio into `mount`, reading studio.agent and calling
 *   //   studio.patch({ meta: { studio: { brain: {...} } } }) to persist.
 *
 * The shell also fires `studio-shell:ready` (CustomEvent, detail:{ studio, agent })
 * on `document` once the agent has loaded, so a sub-studio bundle can boot itself
 * without racing the shell.
 * ----------------------------------------------------------------------------
 */

import { studio } from './agent-studio-store.js';
import { getMe } from '../account.js';
import { log } from '../shared/log.js';
import './agent-presence.js'; // registers <agent-presence>

const TABS = [
	{ key: 'brain', label: 'Brain', hint: "Model, provider, and the agent's reasoning graph." },
	{ key: 'memory', label: 'Memory', hint: 'What the agent remembers, and for how long.' },
	{ key: 'body', label: 'Body', hint: 'The 3D avatar, outfit, and animations.' },
	{ key: 'money', label: 'Money', hint: 'Wallet, payouts, and per-call pricing.' },
	{ key: 'skills', label: 'Skills', hint: 'Capabilities the agent can perform and sell.' },
];

// Fallback copy shown only if a sub-studio bundle fails to load (each mount
// removes this and renders its own designed loading/empty/error states). The
// copy is real and actionable — never a "mounts here" placeholder.
const EMPTY_COPY = {
	brain: {
		title: 'Loading the Brain studio…',
		body: "Pick a model and shape how your agent thinks. If this doesn't load, refresh the page.",
	},
	memory: {
		title: 'Loading the Memory studio…',
		body: "Decide what your agent recalls across conversations. If this doesn't load, refresh the page.",
	},
	body: {
		title: 'Loading the Body studio…',
		body: 'Choose a 3D avatar, customize its outfit, and set how it moves. If this stalls, refresh the page.',
		cta: { label: 'Create an avatar →', href: '/create' },
	},
	money: {
		title: 'Loading the Money studio…',
		body: "Fund the agent's wallet and price its skills. If this stalls, refresh the page.",
	},
	skills: {
		title: 'Loading the Skills studio…',
		body: "Turn on capabilities your agent can perform and monetize. If this stalls, refresh the page.",
	},
};

class StudioShell {
	constructor(root) {
		this.root = root;
		this.activeTab = this._initialTab();
		this._unsub = null;
	}

	_initialTab() {
		const hash = (location.hash || '').replace('#', '');
		return TABS.some((t) => t.key === hash) ? hash : 'brain';
	}

	async boot() {
		this._renderLoading();

		// Auth gate — /agent-studio is owner-only (every agent has a wallet).
		let user;
		try {
			user = await getMe();
		} catch (err) {
			log.warn('[studio-shell] auth check failed', err);
			return this._renderError('We couldn’t verify your session.', () => this.boot());
		}
		if (!user) return this._renderAuthGate();

		// Load the caller's agent through the shared store. An explicit `?id=`
		// targets a specific owned agent (deep links from the agent profile);
		// without it we auto-create/load the caller's default agent.
		const targetId = new URLSearchParams(location.search).get('id');
		try {
			const agent = await studio.load(targetId ? { agentId: targetId } : undefined);
			if (!agent || !agent.id) return this._renderEmptyAgent();
			// A targeted `?id=` can name an agent the caller doesn't own. The studio
			// is an owner console — every save is owner-gated server-side — so don't
			// render edit controls for someone else's agent; send them to its profile.
			if (targetId && agent.isOwner === false) return this._renderNotOwner(agent.id);
			this._renderShell(agent);
			this._bind();
			document.dispatchEvent(
				new CustomEvent('studio-shell:ready', { detail: { studio, agent } }),
			);
		} catch (err) {
			log.warn('[studio-shell] agent load failed', err);
			this._renderError('We couldn’t load your agent.', () => this.boot());
		}
	}

	// ── States ─────────────────────────────────────────────────────────────────

	_renderLoading() {
		this.root.innerHTML = `
			<div class="studio-skeleton" aria-busy="true" aria-label="Loading Agent Studio">
				<div class="sk-stage"></div>
				<div class="sk-panel">
					<div class="sk-tabs"></div>
					<div class="sk-rows">${'<div class="sk-row"></div>'.repeat(4)}</div>
				</div>
			</div>`;
	}

	_renderAuthGate() {
		const next = encodeURIComponent('/agent-studio');
		this.root.innerHTML = `
			<div class="studio-gate" role="region" aria-label="Sign in required">
				<div class="studio-gate-inner">
					<div class="studio-gate-glyph" aria-hidden="true">◐</div>
					<h1>Agent Studio</h1>
					<p>Author your agent's brain, memory, body, money, and skills in one place — and watch it come alive everywhere on the platform.</p>
					<a class="studio-btn studio-btn-primary" href="/login?next=${next}">Sign in to start</a>
					<a class="studio-btn studio-btn-ghost" href="/start">New here? Create your first agent</a>
				</div>
			</div>`;
	}

	_renderEmptyAgent() {
		this.root.innerHTML = `
			<div class="studio-gate" role="region" aria-label="No agent yet">
				<div class="studio-gate-inner">
					<div class="studio-gate-glyph" aria-hidden="true">✦</div>
					<h1>Create your first agent</h1>
					<p>You don't have an agent yet. Spin one up and it'll open right here in the Studio.</p>
					<a class="studio-btn studio-btn-primary" href="/create-agent">Create an agent →</a>
				</div>
			</div>`;
	}

	_renderError(message, onRetry) {
		this.root.innerHTML = `
			<div class="studio-gate" role="alert">
				<div class="studio-gate-inner">
					<div class="studio-gate-glyph" aria-hidden="true">⚠</div>
					<h1>Something went wrong</h1>
					<p>${esc(message)}</p>
					<button class="studio-btn studio-btn-primary" type="button" id="studio-retry">Try again</button>
				</div>
			</div>`;
		this.root.querySelector('#studio-retry')?.addEventListener('click', onRetry);
	}

	_renderNotOwner(agentId) {
		this.root.innerHTML = `
			<div class="studio-gate" role="alert">
				<div class="studio-gate-inner">
					<div class="studio-gate-glyph" aria-hidden="true">🔒</div>
					<h1>This isn’t your agent</h1>
					<p>The studio is where an owner configures their own agent. You can still view this one’s public profile.</p>
					<a class="studio-btn studio-btn-primary" href="/agents/${encodeURIComponent(agentId)}">View profile</a>
				</div>
			</div>`;
	}

	// ── Shell ────────────────────────────────────────────────────────────────

	_renderShell(agent) {
		this.root.innerHTML = `
			<div class="studio">
				<aside class="studio-stage" aria-label="Live agent">
					<agent-presence data-mode="stage"></agent-presence>
					<div class="studio-stage-hud">
						<span class="studio-live-dot" aria-hidden="true"></span>
						<span class="studio-live-label">Live · updates everywhere as you edit</span>
					</div>
				</aside>

				<section class="studio-panel" aria-label="Agent editor">
					<header class="studio-identity">
						<h1 class="studio-sr-only">Agent Studio</h1>
						<input id="studio-name" class="studio-name" value="${esc(agent.name || '')}"
							maxlength="100" aria-label="Agent name" placeholder="Name your agent" />
						<input id="studio-tagline" class="studio-tagline" value="${esc(agent.description || '')}"
							maxlength="280" aria-label="Agent tagline" placeholder="Add a short tagline…" />
						<div class="studio-actions">
							<span class="studio-save" id="studio-save" aria-live="polite"></span>
							<button type="button" class="studio-btn studio-btn-ghost studio-action" id="studio-save-draft"
								title="Save your progress now — your agent stays a private draft you can keep editing">Save draft</button>
							<a class="studio-btn studio-btn-ghost studio-action" id="studio-exit"
								href="${agent.id ? `/agents/${encodeURIComponent(agent.id)}` : '/'}"
								title="Save and view your live agent page">View agent ↗</a>
						</div>
					</header>

					<nav class="studio-tabs" role="tablist" aria-label="Editor sections">
						${TABS.map(
							(t, i) => `
							<button role="tab" class="studio-tab" id="tab-${t.key}"
								data-tab="${t.key}" aria-controls="panel-${t.key}"
								aria-selected="false" tabindex="-1" title="${esc(t.hint)} (${i + 1})">
								<span class="studio-tab-num" aria-hidden="true">${i + 1}</span>${t.label}
							</button>`,
						).join('')}
					</nav>

					<div class="studio-tabpanels">
						${TABS.map(
							(t) => `
							<section role="tabpanel" id="panel-${t.key}" class="studio-tabpanel"
								data-studio-mount="${t.key}" aria-labelledby="tab-${t.key}" hidden tabindex="0">
								<div class="studio-empty">
									<div class="studio-empty-glyph" aria-hidden="true"></div>
									<h2>${esc(EMPTY_COPY[t.key].title)}</h2>
									<p>${esc(EMPTY_COPY[t.key].body)}</p>
									${
										EMPTY_COPY[t.key].cta
											? `<a class="studio-btn studio-btn-ghost" href="${EMPTY_COPY[t.key].cta.href}">${esc(EMPTY_COPY[t.key].cta.label)}</a>`
											: ''
									}
								</div>
							</section>`,
						).join('')}
					</div>
				</section>
			</div>`;

		this._selectTab(this.activeTab, { focus: false });
	}

	_bind() {
		// Tabs: click + number keys + Esc + arrow nav.
		const tabs = [...this.root.querySelectorAll('.studio-tab')];
		tabs.forEach((tab) => {
			tab.addEventListener('click', () => this._selectTab(tab.dataset.tab));
			tab.addEventListener('keydown', (e) => this._onTabKeydown(e, tabs));
		});
		this._keyHandler = (e) => this._onGlobalKeydown(e);
		document.addEventListener('keydown', this._keyHandler);

		// Identity header → real live edits through the store. Typing the name
		// updates the avatar's nameplate (via subscribe) and debounce-PUTs.
		const nameEl = this.root.querySelector('#studio-name');
		const tagEl = this.root.querySelector('#studio-tagline');
		const saveEl = this.root.querySelector('#studio-save');

		// Save indicator. Every domain (identity here, Brain/Memory sub-studios, …)
		// edits through the same store, which emits 'save:pending' on each patch and
		// 'save:ok' once the debounced PUT reconciles. Driving the indicator off those
		// events — rather than per-field timers — means any edit anywhere in the studio
		// honestly reflects the real write, and the Brain graph's saves finally show.
		nameEl?.addEventListener('input', () => studio.patch({ name: nameEl.value }));
		tagEl?.addEventListener('input', () => studio.patch({ description: tagEl.value }));
		this._unsubSaving = studio.on('save:pending', () => {
			if (!saveEl) return;
			saveEl.textContent = 'Saving…';
			saveEl.dataset.state = 'pending';
		});
		this._unsubSaved = studio.on('save:ok', () => {
			if (!saveEl) return;
			saveEl.textContent = 'Saved';
			saveEl.dataset.state = 'saved';
		});

		// Studio-wide escape hatches. Every tab auto-saves through the store, but a
		// focused sub-studio (e.g. the Brain graph) can feel like a forward-only
		// dead-end — these give an always-present, honest way to save a draft and to
		// leave. "Edit other parts" is the tab row directly below this header.
		this.root.querySelector('#studio-save-draft')?.addEventListener('click', (e) => this._saveDraft(e.currentTarget));
		this.root.querySelector('#studio-exit')?.addEventListener('click', (e) => this._exit(e));

		// Sub-studios (e.g. the Brain graph's "Done →") request an onward jump
		// through a DOM event so they stay decoupled from the shell instance.
		this._navHandler = (e) => {
			const key = e.detail?.tab;
			if (key && TABS.some((t) => t.key === key)) this._selectTab(key, { focus: true });
		};
		document.addEventListener('studio:navigate', this._navHandler);

		// A focused sub-studio can also ask to leave the studio entirely (save + exit
		// to the live agent). The Brain editor's "Save & exit" fires this so the graph
		// is never a forward-only dead-end — its own controls otherwise only advance to
		// the next tab. The shell owns the destination so it lives in exactly one place.
		this._exitHandler = () => this._leaveStudio();
		document.addEventListener('studio:exit', this._exitHandler);

		// Keep the header in sync if another surface edits the same agent.
		this._unsub = studio.subscribe((agent) => {
			if (!agent) return;
			if (nameEl && document.activeElement !== nameEl && nameEl.value !== (agent.name || '')) {
				nameEl.value = agent.name || '';
			}
			if (tagEl && document.activeElement !== tagEl && tagEl.value !== (agent.description || '')) {
				tagEl.value = agent.description || '';
			}
		});
		this._unsubErr = studio.on('error', () => {
			if (saveEl) {
				saveEl.textContent = 'Save failed — retrying';
				saveEl.dataset.state = 'error';
			}
		});
	}

	// Flush any sub-studio's not-yet-debounced edits into the store, then push the
	// real PUT through. The flush event lets a focused editor (Brain graph) commit
	// its in-progress state synchronously *before* we commit, so an explicit
	// Save/Exit honestly captures what's on screen rather than the last auto-save.
	async _flushAndCommit() {
		document.dispatchEvent(new CustomEvent('studio:flush'));
		return studio.commit();
	}

	async _saveDraft(btn) {
		if (!btn || btn.dataset.busy) return;
		btn.dataset.busy = '1';
		btn.disabled = true;
		btn.textContent = 'Saving…';
		clearTimeout(this._draftFlash);
		try {
			await this._flushAndCommit();
			btn.textContent = 'Draft saved ✓';
		} catch {
			btn.textContent = 'Retry save';
		} finally {
			btn.disabled = false;
			delete btn.dataset.busy;
			this._draftFlash = setTimeout(() => {
				btn.textContent = 'Save draft';
			}, 1800);
		}
	}

	// Save, then leave to the live agent. We navigate even if the save errors —
	// the store's beforeunload/visibilitychange flush is a backstop, and the href
	// is a real link so a blocked handler still goes somewhere useful.
	async _exit(e) {
		const link = e.currentTarget;
		e.preventDefault();
		if (link.dataset.busy) return;
		link.dataset.busy = '1';
		link.textContent = 'Saving…';
		await this._leaveStudio(link.getAttribute('href'));
	}

	// Flush every sub-studio's edits, commit, then navigate out to the live agent.
	// Shared by the header "View agent" link and any sub-studio's studio:exit request
	// so a save-and-leave always lands somewhere real. We navigate even if the save
	// throws — leaving must never trap the user.
	async _leaveStudio(href) {
		const dest = href || this.root.querySelector('#studio-exit')?.getAttribute('href') || '/';
		try {
			await this._flushAndCommit();
		} catch {
			/* navigate anyway — leaving must never trap the user */
		}
		location.href = dest;
	}

	_onTabKeydown(e, tabs) {
		const i = tabs.indexOf(e.currentTarget);
		if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
			e.preventDefault();
			const next = tabs[(i + 1) % tabs.length];
			this._selectTab(next.dataset.tab);
		} else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
			e.preventDefault();
			const prev = tabs[(i - 1 + tabs.length) % tabs.length];
			this._selectTab(prev.dataset.tab);
		}
	}

	_onGlobalKeydown(e) {
		// Don't hijack typing in the identity fields or any future panel input.
		const t = e.target;
		const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
		if (e.key === 'Escape') {
			// Esc closes/blurs the active panel control and returns focus to its tab.
			if (typing) {
				t.blur();
				this.root.querySelector(`#tab-${this.activeTab}`)?.focus();
				e.preventDefault();
			}
			return;
		}
		if (typing) return;
		const n = Number(e.key);
		if (n >= 1 && n <= TABS.length) {
			e.preventDefault();
			this._selectTab(TABS[n - 1].key, { focus: true });
		}
	}

	_selectTab(key, { focus = true } = {}) {
		this.activeTab = key;
		for (const tab of this.root.querySelectorAll('.studio-tab')) {
			const on = tab.dataset.tab === key;
			tab.setAttribute('aria-selected', String(on));
			tab.tabIndex = on ? 0 : -1;
			if (on && focus) tab.focus();
		}
		for (const panel of this.root.querySelectorAll('.studio-tabpanel')) {
			panel.hidden = panel.dataset.studioMount !== key;
		}
		if (history.replaceState) history.replaceState(null, '', `#${key}`);
	}
}

function esc(s) {
	return String(s == null ? '' : s).replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
	);
}

function init() {
	const root = document.getElementById('studio-root');
	if (!root) return;
	new StudioShell(root).boot();
}

if (document.readyState === 'loading') {
	document.addEventListener('DOMContentLoaded', init);
} else {
	init();
}
