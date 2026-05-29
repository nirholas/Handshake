/**
 * Agent Home — Presence Component
 * ---------------------------------
 * The agent's home page. Not a dashboard. Not a settings panel.
 * A *place* — somewhere you can go to see the agent, its history, its skills.
 *
 * Every agent deserves an address. This renders it.
 * Embeddable anywhere: main page identity card, /agent/:id home page.
 */

import { ACTION_TYPES } from './agent-protocol.js';
import { MEMORY_TYPES } from './agent-memory.js';
import { mountPumpFunCard } from './agent-home-pumpfun.js';
import { mountAgentSolanaWalletCard } from './agent-solana-wallet.js';
import { mountAgentVanityGrinderCard } from './agent-vanity-grinder.js';
import { mountAgentEthVanityCard } from './agent-eth-vanity-card.js';
import { mountClaimsPanel } from './agent-home-claims.js';

const ACTION_ICONS = {
	[ACTION_TYPES.SPEAK]: '💬',
	[ACTION_TYPES.REMEMBER]: '🧠',
	[ACTION_TYPES.SIGN]: '✍️',
	[ACTION_TYPES.PERFORM_SKILL]: '⚡',
	[ACTION_TYPES.SKILL_DONE]: '✓',
	[ACTION_TYPES.SKILL_ERROR]: '⚠',
	[ACTION_TYPES.LOAD_END]: '📦',
	[ACTION_TYPES.VALIDATE]: '🔍',
	default: '·',
};

const EMOTION_LABELS = {
	neutral: 'calm',
	concern: 'focused',
	celebration: 'excited',
	patience: 'patient',
	curiosity: 'curious',
	empathy: 'empathetic',
};

export class AgentHome {
	/**
	 * @param {HTMLElement}                                    containerEl
	 * @param {import('./agent-identity.js').AgentIdentity}   identity
	 * @param {import('./agent-protocol.js').AgentProtocol}   protocol
	 * @param {import('./agent-avatar.js').AgentAvatar}        [avatar]
	 */
	constructor(containerEl, identity, protocol, avatar = null, opts = {}) {
		this.container = containerEl;
		this.identity = identity;
		this.protocol = protocol;
		this.avatar = avatar;
		this.skills = opts.skills || null;
		this.memory = opts.memory || null;
		this.isOwner = typeof opts.isOwner === 'boolean' ? opts.isOwner : null;

		this._panel = null;
		this._timeline = [];
		this._maxTimeline = 30;
		this._emotionInterval = null;
		this._destroyClaims = null;
	}

	// ── Lifecycle ─────────────────────────────────────────────────────────────

	async render() {
		await this._ensureIdentityLoaded();
		this._buildPanel();
		this._subscribeProtocol();
		this._startEmotionPoll();
	}

	destroy() {
		if (this._destroyClaims) this._destroyClaims();
		if (this._panel) this._panel.remove();
		clearInterval(this._emotionInterval);
		this.protocol.off('*', this._onAnyAction);
	}

	// ── Identity Card ─────────────────────────────────────────────────────────

	_buildPanel() {
		const id = this.identity;
		const skills = id.skills || [];
		const panel = document.createElement('div');
		panel.className = 'agent-home-panel';
		panel.innerHTML = `
			<div class="agent-home-identity">
				<div class="agent-home-avatar-ring" id="agent-avatar-ring">
					<div class="agent-home-avatar-inner" id="agent-avatar-inner">
						<span class="agent-home-avatar-emoji" id="agent-avatar-emoji">◎</span>
					</div>
				</div>
				<div class="agent-home-info">
					<div class="agent-home-name-row">
						<span
							class="agent-home-name agent-home-editable"
							id="agent-home-name"
							data-field="name"
							data-placeholder="Name your agent"
							contenteditable="plaintext-only"
							spellcheck="false"
							role="textbox"
							aria-label="Agent name (editable)"
							title="Click to rename"
						>${_esc(id.name)}</span>
						${
							id.isRegistered
								? `
						<span class="agent-home-badge erc8004" title="Registered on-chain (ERC-8004)">
							<svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
						</span>`
								: ''
						}
					</div>
					<div class="agent-home-status" id="agent-home-status">
						<span class="agent-home-dot online"></span>
						<span id="agent-home-emotion-label">present</span>
						<span class="agent-home-status-sep" aria-hidden="true">·</span>
						${id.walletAddress
							? `<span class="agent-home-address" id="agent-home-address">${_shortAddr(id.walletAddress)}</span>`
							: `<button class="agent-home-address agent-home-address--cta" id="agent-home-address" title="Connect wallet to register on-chain">no wallet</button>`
						}
					</div>
					<p
						class="agent-home-description agent-home-editable"
						id="agent-home-description"
						data-field="description"
						data-placeholder="Add a description…"
						contenteditable="plaintext-only"
						spellcheck="true"
						role="textbox"
						aria-label="Agent description (editable)"
					>${_esc(id.description || '')}</p>
				</div>
				<button class="agent-home-btn" id="agent-copy-link" title="Copy agent link">
					<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>
				</button>
				<button class="agent-home-btn" id="agent-home-hide" title="Hide panel" aria-label="Hide agent panel">
					<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M19 13H5v-2h14v2z"/></svg>
				</button>
			</div>

			${
				skills.length
					? `
			<details class="agent-home-skills" id="agent-skills-details">
				<summary class="agent-home-skills-summary">
					<span class="agent-home-skills-label">Skills</span>
					<span class="agent-home-skills-count">${skills.length}</span>
					<svg class="agent-home-chevron" width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z"/></svg>
				</summary>
				<div class="agent-home-skills-strip" id="agent-skills-strip">
					${skills.map((s) => `<span class="agent-skill-chip">${_esc(s)}</span>`).join('')}
				</div>
			</details>
			`
					: ''
			}

			<div id="agent-permissions-container"></div>

			<div id="agent-subscribe-area"></div>

			<div class="agent-home-memory-bar" id="agent-memory-bar">
				${this._renderMemoryBar()}
			</div>

			<div class="agent-home-timeline" id="agent-timeline">
				<div class="agent-timeline-empty">
					<svg class="agent-timeline-empty-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a6 6 0 0 0-4 10.5V15a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2v-2.5A6 6 0 0 0 12 2z"/><path d="M10 20h4"/><path d="M11 23h2"/></svg>
					<span class="agent-timeline-empty-title">Waiting for activity</span>
					<span class="agent-timeline-empty-sub">Your agent's actions will log here once it starts working</span>
				</div>
			</div>
		`;

		this.container.appendChild(panel);
		this._panel = panel;

		let _pumpMounted = false;
		const mountPumpIfReady = () => {
			if (_pumpMounted) return;
			if (!(this.identity?.meta?.chain_type === 'solana' || this.identity?.solana_address)) return;
			try {
				const skills =
					this.skills ||
					(typeof window !== 'undefined'
						? window.VIEWER?.agent_skills || window.VIEWER?.app?.agent_skills
						: null);
				const memory =
					this.memory ||
					(typeof window !== 'undefined'
						? window.VIEWER?.agent_memory || window.VIEWER?.app?.agent_memory
						: null);
				mountPumpFunCard({
					panel,
					identity: this.identity,
					skills,
					memory,
					protocol: this.protocol,
				});
				_pumpMounted = true;
			} catch {
				/* card is optional */
			}
		};

		// Solana wallet card — owner only. Lets the user provision a random
		// Solana wallet for the agent. On success, lazy-mount the pump.fun
		// card if it wasn't already mounted. The vanity grinder is a sibling
		// card so the wallet UI stays focused on identity + balance.
		// Default-deny when ownership is unknown — visitor flows must not fire
		// owner-only requests (/solana, /eth-vanity) and pollute the console
		// with 401s. Caller can pass opts.isOwner to override identity state.
		const isOwner = this.isOwner !== null ? this.isOwner : this.identity?.isOwner;
		if (this.identity?.id && isOwner === true) {
			let walletCard = null;
			try {
				walletCard = mountAgentSolanaWalletCard({
					panel,
					identity: this.identity,
					onProvisioned: () => mountPumpIfReady(),
				});
			} catch {
				/* card is optional */
			}
			try {
				mountAgentVanityGrinderCard({
					panel,
					identity: this.identity,
					onProvisioned: () => {
						walletCard?.refresh?.();
						mountPumpIfReady();
					},
				});
			} catch {
				/* card is optional */
			}
			try {
				mountAgentEthVanityCard({
					panel,
					identity: this.identity,
				});
			} catch {
				/* card is optional */
			}
		}

		mountPumpIfReady();

		// Claims panel — only when creatorWallet is set on the agent profile.
		const creatorWallet =
			this.identity.creatorWallet ||
			this.identity.meta?.creator_wallet ||
			this.identity.meta?.creatorWallet;
		if (creatorWallet) {
			const claimsNetwork = this.identity.meta?.pumpfun_network || 'mainnet';
			try {
				this._destroyClaims = mountClaimsPanel(panel, { creator: creatorWallet, network: claimsNetwork });
			} catch {
				/* panel is optional */
			}
		}

		// Permissions manage panel — lazy load; degrades gracefully if unauthenticated
		const agentId = this.identity.id;
		if (agentId) {
			const permContainer = panel.querySelector('#agent-permissions-container');
			import('./permissions/manage-panel.js')
				.then(({ mountManagePanel }) =>
					mountManagePanel({
						container: permContainer,
						agentId,
						agentWalletAddress: this.identity.walletAddress,
						agentChainId: this.identity.chainId,
					}),
				)
				.catch(() => {});
		}

		// Copy link button — use registered agent URL when available, else current page URL.
		panel.querySelector('#agent-copy-link')?.addEventListener('click', () => {
			const url = id.homeUrl
				? `${location.origin}${id.homeUrl}`
				: location.href;
			navigator.clipboard?.writeText(url).catch(() => {});
			this._flashBtn(panel.querySelector('#agent-copy-link'), '✓');
		});

		// Hide / show toggle — collapses the whole sidebar to a small pill.
		// Preference persisted in localStorage so it sticks across reloads.
		this._wireHideToggle(panel);

		// Wallet CTA button — fire a document event so app.js can handle it.
		panel.querySelector('.agent-home-address--cta')?.addEventListener('click', () => {
			document.dispatchEvent(new CustomEvent('agent-home:connect-wallet', { bubbles: true }));
		});

		// Inline name + description editing — auto-save with local-first fallback.
		panel.querySelectorAll('.agent-home-editable').forEach((el) => {
			this._wireInlineEdit(el);
		});
	}

	_wireHideToggle(panel) {
		const sidebar = this.container.closest('.agent-presence-sidebar') || this.container.parentElement;
		if (!sidebar) return;

		const STORAGE_KEY = 'agent3d:home-hidden';

		// Show-pill — appears only when sidebar is collapsed. Click to restore.
		let pill = sidebar.querySelector('.agent-home-show-pill');
		if (!pill) {
			pill = document.createElement('button');
			pill.type = 'button';
			pill.className = 'agent-home-show-pill';
			pill.title = 'Show agent panel';
			pill.setAttribute('aria-label', 'Show agent panel');
			pill.innerHTML = '<span aria-hidden="true">◎</span>';
			sidebar.appendChild(pill);
		}

		const apply = (hidden) => {
			sidebar.dataset.collapsed = hidden ? 'true' : 'false';
		};

		try {
			// Default to collapsed; only expand if user explicitly opened it ('0').
			apply(localStorage.getItem(STORAGE_KEY) !== '0');
		} catch {
			apply(true);
		}

		panel.querySelector('#agent-home-hide')?.addEventListener('click', () => {
			apply(true);
			try { localStorage.setItem(STORAGE_KEY, '1'); } catch {}
		});

		pill.addEventListener('click', () => {
			apply(false);
			try { localStorage.setItem(STORAGE_KEY, '0'); } catch {}
		});
	}

	_wireInlineEdit(el) {
		if (!el) return;
		const field = el.dataset.field;
		if (!field) return;

		const MAX_LEN = field === 'name' ? 40 : 160;

		// Track the last server-confirmed (or locally-saved) value for rollback.
		el._lastSaved = el.textContent.trim();

		// Counter element shown while editing
		const counter = document.createElement('span');
		counter.className = 'agent-edit-counter';
		counter.setAttribute('aria-live', 'polite');
		el.parentNode.insertBefore(counter, el.nextSibling);

		const _updateCounter = (len) => {
			counter.textContent = `${len}/${MAX_LEN}`;
			counter.classList.toggle('agent-edit-counter--warn', len > MAX_LEN * 0.85);
			counter.classList.toggle('agent-edit-counter--over', len >= MAX_LEN);
		};

		// Enforce char limit and update counter on input.
		el.addEventListener('input', () => {
			const text = el.textContent;
			if (text.length > MAX_LEN) {
				// Truncate and restore cursor to end
				el.textContent = text.slice(0, MAX_LEN);
				const range = document.createRange();
				const sel = window.getSelection();
				range.selectNodeContents(el);
				range.collapse(false);
				sel?.removeAllRanges();
				sel?.addRange(range);
			}
			_updateCounter(el.textContent.length);
		});

		// Enter blurs (saves) instead of inserting a newline. Escape reverts.
		el.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				el.blur();
			} else if (e.key === 'Escape') {
				e.preventDefault();
				el.textContent = el._lastSaved || '';
				el.blur();
			}
		});

		el.addEventListener('focus', () => {
			el.classList.add('is-editing');
			counter.classList.add('agent-edit-counter--visible');
			_updateCounter(el.textContent.length);
		});

		el.addEventListener('blur', async () => {
			el.classList.remove('is-editing');
			counter.classList.remove('agent-edit-counter--visible');
			const next = el.textContent.replace(/\s+/g, ' ').trim();
			if (next === (el._lastSaved || '')) return; // no change

			const previous = el._lastSaved || '';
			el._lastSaved = next;

			// Always persist locally first — works for anonymous and registered alike.
			if (this.identity._record) {
				this.identity._record[field] = next;
				this.identity._persist?.();
			}

			// If no backend id, show local-save feedback and maybe show wallet nudge.
			if (!this.identity.id) {
				el.classList.add('is-saved-local');
				setTimeout(() => el.classList.remove('is-saved-local'), 1400);
				this._maybeShowWalletNudge();
				return;
			}

			el.classList.add('is-saving');

			try {
				const resp = await fetch(`/api/agents/${this.identity.id}`, {
					method: 'PUT',
					credentials: 'include',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ [field]: next }),
				});

				// Not authenticated — save is local-only, don't treat as an error.
				if (resp.status === 401 || resp.status === 403) {
					el.classList.remove('is-saving');
					el.classList.add('is-saved-local');
					setTimeout(() => el.classList.remove('is-saved-local'), 1400);
					this._maybeShowWalletNudge();
					return;
				}

				if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

				const { agent } = await resp.json().catch(() => ({}));
				// Reflect any server-side normalisation (trimmed, capped, etc.)
				if (agent && typeof agent[field] === 'string' && agent[field] !== next) {
					el.textContent = agent[field];
					el._lastSaved = agent[field];
				}
				if (this.identity._record) this.identity._record[field] = el._lastSaved;
				el.classList.remove('is-saving');
				el.classList.add('is-saved');
				setTimeout(() => el.classList.remove('is-saved'), 1100);
			} catch {
				// Roll back to the last known good value.
				el.textContent = previous;
				el._lastSaved = previous;
				el.classList.remove('is-saving');
				el.classList.add('is-error');
				setTimeout(() => el.classList.remove('is-error'), 1500);
			}
		});
	}

	_maybeShowWalletNudge() {
		if (this.identity.walletAddress) return; // already connected
		const panel = this._panel;
		if (!panel || panel.querySelector('.agent-wallet-nudge')) return; // already shown

		const id = this.identity;
		const nameCustomised = id.name && id.name !== 'Agent';
		const descCustomised = id.description && id.description !== 'A 3D AI agent';
		if (!nameCustomised && !descCustomised) return;

		const nudge = document.createElement('div');
		nudge.className = 'agent-wallet-nudge';
		nudge.innerHTML =
			`<span class="agent-wallet-nudge-text">Connect wallet to register on-chain</span>` +
			`<button class="agent-wallet-nudge-btn" id="agent-wallet-nudge-btn">Connect →</button>`;
		nudge.querySelector('#agent-wallet-nudge-btn').addEventListener('click', () => {
			document.dispatchEvent(new CustomEvent('agent-home:connect-wallet', { bubbles: true }));
		});

		// Insert before the memory bar
		const memBar = panel.querySelector('#agent-memory-bar');
		if (memBar) panel.insertBefore(nudge, memBar);
		else panel.appendChild(nudge);

		requestAnimationFrame(() => nudge.classList.add('agent-wallet-nudge--visible'));
	}

	// ── Memory Bar ────────────────────────────────────────────────────────────

	_renderMemoryBar() {
		if (!this.identity.memory) return '';
		const stats = this.identity.memory.stats;
		if (!stats || !stats.total) return '<span class="agent-mem-empty">no memories yet</span>';

		return (
			Object.entries(stats)
				.filter(([k]) => k !== 'total')
				.filter(([, v]) => v > 0)
				.map(
					([type, count]) => `
				<span class="agent-mem-chip" data-type="${type}" title="${count} ${type} ${count === 1 ? 'memory' : 'memories'}">
					${_memIcon(type)} ${count}
				</span>
			`,
				)
				.join('') + `<span class="agent-mem-total">${stats.total}</span>`
		);
	}

	_refreshMemoryBar() {
		const bar = this._panel?.querySelector('#agent-memory-bar');
		if (bar) bar.innerHTML = this._renderMemoryBar();
	}

	// ── Action Timeline ───────────────────────────────────────────────────────

	_subscribeProtocol() {
		this._onAnyAction = (action) => {
			// Only show meaningful actions (skip internal think/presence churn)
			if ([ACTION_TYPES.THINK, ACTION_TYPES.PRESENCE].includes(action.type)) return;
			this._pushTimeline(action);
		};
		this.protocol.on('*', this._onAnyAction);
	}

	_pushTimeline(action) {
		this._timeline.unshift(action);
		if (this._timeline.length > this._maxTimeline) this._timeline.pop();

		const timelineEl = this._panel?.querySelector('#agent-timeline');
		if (!timelineEl) return;

		const emptyEl = timelineEl.querySelector('.agent-timeline-empty');
		if (emptyEl) emptyEl.remove();

		const item = document.createElement('div');
		item.className = 'agent-timeline-item';
		item.innerHTML = `
			<span class="agent-timeline-icon">${ACTION_ICONS[action.type] || ACTION_ICONS.default}</span>
			<span class="agent-timeline-text">${_timelineText(action)}</span>
			<span class="agent-timeline-time">${_relTime(action.timestamp)}</span>
		`;
		item.style.animation = 'agent-timeline-in 0.25s ease';

		timelineEl.insertBefore(item, timelineEl.firstChild);

		// Keep DOM clean
		while (timelineEl.children.length > this._maxTimeline) {
			timelineEl.removeChild(timelineEl.lastChild);
		}

		// Refresh memory bar if it was a remember action
		if (action.type === ACTION_TYPES.REMEMBER) {
			this._refreshMemoryBar();
		}
	}

	// ── Emotion Presence ──────────────────────────────────────────────────────

	_startEmotionPoll() {
		// Update the emotion label in the status bar every second
		this._emotionInterval = setInterval(() => {
			if (!this.avatar) return;
			const state = this.avatar.emotionState;
			if (!state) return;
			const dominant = Object.entries(state).reduce(
				(a, b) => (b[1] > a[1] ? b : a),
				['neutral', 0],
			);
			const label = EMOTION_LABELS[dominant[0]] || 'present';

			const el = this._panel?.querySelector('#agent-home-emotion-label');
			if (el && el.textContent !== label) {
				el.style.opacity = '0';
				setTimeout(() => {
					el.textContent = label;
					el.style.opacity = '1';
				}, 150);
			}

			// Pulse the avatar ring colour based on dominant emotion
			const ring = this._panel?.querySelector('#agent-avatar-ring');
			if (ring) {
				ring.dataset.emotion = dominant[0];
			}
		}, 1000);
	}

	// ── Helpers ───────────────────────────────────────────────────────────────

	async _ensureIdentityLoaded() {
		if (!this.identity.isLoaded) {
			await this.identity.load();
		}
	}

	_flashBtn(btn, text) {
		if (!btn) return;
		const orig = btn.innerHTML;
		btn.textContent = text;
		setTimeout(() => {
			btn.innerHTML = orig;
		}, 1500);
	}
}

// ── Rendering Helpers ─────────────────────────────────────────────────────────

function _esc(str) {
	return String(str || '').replace(
		/[<>&"]/g,
		(c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c],
	);
}

function _shortAddr(addr) {
	if (!addr) return '';
	return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function _memIcon(type) {
	return { user: '👤', feedback: '↩', project: '📋', reference: '🔗' }[type] || '·';
}

function _relTime(ts) {
	const diff = Date.now() - ts;
	if (diff < 60_000) return 'just now';
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
	if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
	return new Date(ts).toLocaleDateString();
}

function _timelineText(action) {
	const p = action.payload || {};
	switch (action.type) {
		case ACTION_TYPES.SPEAK:
			return _esc((p.text || '').slice(0, 80) + (p.text?.length > 80 ? '…' : ''));
		case ACTION_TYPES.REMEMBER:
			return _esc(`Remembered: ${(p.content || '').slice(0, 60)}`);
		case ACTION_TYPES.PERFORM_SKILL:
			return _esc(`Performing skill: ${p.skill || '?'}`);
		case ACTION_TYPES.SKILL_DONE:
			return _esc(`${p.skill || 'Skill'} complete`);
		case ACTION_TYPES.SKILL_ERROR:
			return _esc(`${p.skill || 'Skill'} failed: ${(p.error || '').slice(0, 50)}`);
		case ACTION_TYPES.SIGN:
			return _esc(`Signed: ${(p.message || '').slice(0, 50)}`);
		case ACTION_TYPES.LOAD_END:
			return p.error ? _esc(`Load failed: ${p.error}`) : 'Model loaded';
		case ACTION_TYPES.VALIDATE:
			return _esc(`Validation: ${p.errors || 0} errors, ${p.warnings || 0} warnings`);
		default:
			return _esc(action.type.replace(/-/g, ' '));
	}
}
