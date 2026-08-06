/**
 * Agent Wallet hub — the single product home for an agent's self-custodied
 * Solana wallet. Tabbed: Balance · Deposit · Trade · Snipe · Pay · Withdraw · Give.
 *
 * This file owns the shell: layout, the agent header (name + wallet-readiness),
 * the network selector, the accessible tab strip, and the shared context handed
 * to every tab. The tabs themselves live in ./tabs/*.js and self-register via
 * ./registry.js — adding a tab is a new file + one import below, never an edit
 * to a shared list.
 *
 * Balance, Deposit, Trade, Snipe, Pay, Withdraw, and Give are all fully built —
 * each is its own tab file under ./tabs/, registered via ./registry.js, so the
 * shell never hardcodes a tab list and a surface is a single-file change.
 *
 * Reachable from the agent profile and the create-agent success screen as
 * `/agent/:id/wallet` (or `?id=`). Owner sees management tabs; a visitor gets a
 * read-only view (Balance + Deposit only).
 */

import { getVisibleTabs } from './registry.js';

// Tab modules — importing each one runs its registerWalletTab() side effect.
// To add a tab later: drop a file in ./tabs/ and add one import line here.
import './tabs/balance.js';
import './tabs/activate.js';
import './tabs/portfolio.js';
import './tabs/pulse.js';
import './tabs/reputation.js';
import './tabs/deposit.js';
import './tabs/trade.js';
import './tabs/copilot.js';
import './tabs/snipe.js';
import './tabs/orders.js';
import './tabs/earn.js';
import './tabs/autopilot.js';
import './tabs/intents.js';
import './tabs/signals.js';
import './tabs/pay.js';
import './tabs/vanity.js';
import './tabs/policy.js';
import './tabs/withdraw.js';
import './tabs/give.js';
import './tabs/access.js';
import './tabs/recovery.js';
import './tabs/guard.js';
import './tabs/proof.js';

import { escapeHtml, shortAddress, copyToClipboard, toast } from './util.js';

const STYLE_ID = 'agent-wallet-hub-style';
const STYLE = `
.awh { --awh-gap: var(--space-4, 16px); display: flex; flex-direction: column; gap: var(--awh-gap); max-width: 760px; margin: 0 auto; }
.awh-header { display: flex; align-items: center; gap: var(--space-3, 12px); flex-wrap: wrap; }
.awh-avatar { width: 44px; height: 44px; border-radius: var(--radius-md, 10px); object-fit: cover; background: var(--surface-2, rgba(255,255,255,.05)); border: 1px solid var(--stroke, rgba(255,255,255,.08)); flex: none; }
.awh-id { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.awh-name { font-family: var(--font-display, system-ui); font-size: var(--text-lg, 1.236rem); font-weight: 600; color: var(--ink-bright, #fff); margin: 0; line-height: 1.2; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 46vw; }
.awh-sub { font-size: var(--text-sm, .764rem); color: var(--ink-dim, #888); display: flex; align-items: center; gap: var(--space-2, 8px); flex-wrap: wrap; }
.awh-sub a { color: inherit; text-decoration: none; border-bottom: 1px dotted currentColor; }
.awh-sub a:hover { color: var(--ink, #e8e8e8); }
.awh-ready { display: inline-flex; align-items: center; gap: 5px; font-size: var(--text-2xs, .6875rem); font-weight: 600; padding: 2px 8px; border-radius: var(--radius-pill, 999px); border: 1px solid transparent; }
.awh-ready::before { content: ''; width: 7px; height: 7px; border-radius: 50%; flex: none; }
.awh-ready[data-state="ready"] { color: var(--success, #4ade80); background: color-mix(in srgb, var(--success, #4ade80) 14%, transparent); border-color: color-mix(in srgb, var(--success, #4ade80) 35%, transparent); }
.awh-ready[data-state="ready"]::before { background: var(--success, #4ade80); box-shadow: 0 0 6px color-mix(in srgb, var(--success,#4ade80) 60%, transparent); }
.awh-ready[data-state="preparing"] { color: var(--warn, #fbbf24); background: color-mix(in srgb, var(--warn, #fbbf24) 12%, transparent); border-color: color-mix(in srgb, var(--warn, #fbbf24) 32%, transparent); }
.awh-ready[data-state="preparing"]::before { background: var(--warn, #fbbf24); animation: awh-pulse 1.3s ease-in-out infinite; }
.awh-net { margin-left: auto; display: inline-flex; align-items: center; gap: 6px; font-size: var(--text-sm, .764rem); color: var(--ink-dim, #888); }
.awh-net select { font: inherit; color: var(--ink, #e8e8e8); background: var(--surface-1, rgba(255,255,255,.03)); border: 1px solid var(--stroke, rgba(255,255,255,.08)); border-radius: var(--radius-sm, 6px); padding: 4px 8px; cursor: pointer; }
.awh-net select:focus-visible { outline: var(--focus-ring-width, 2px) solid var(--focus-ring-color, #fff); outline-offset: var(--focus-ring-offset, 2px); }

.awh-tabs { display: flex; gap: 2px; overflow-x: auto; scrollbar-width: thin; border-bottom: 1px solid var(--stroke, rgba(255,255,255,.08)); padding-bottom: 0; -webkit-overflow-scrolling: touch; }
.awh-tab { appearance: none; font: inherit; font-size: var(--text-md, .8125rem); font-weight: 500; color: var(--ink-dim, #888); background: transparent; border: none; border-bottom: 2px solid transparent; padding: 10px 14px; cursor: pointer; white-space: nowrap; transition: color var(--duration-fast, 140ms) var(--ease-standard, ease), border-color var(--duration-fast, 140ms) var(--ease-standard, ease), background var(--duration-fast, 140ms) var(--ease-standard, ease); border-radius: var(--radius-sm, 6px) var(--radius-sm, 6px) 0 0; }
.awh-tab:hover { color: var(--ink, #e8e8e8); background: var(--surface-1, rgba(255,255,255,.03)); }
.awh-tab:active { color: var(--ink-bright, #fff); background: var(--surface-2, rgba(255,255,255,.05)); }
.awh-tab[aria-selected="true"] { color: var(--ink-bright, #fff); border-bottom-color: var(--accent, #fff); }
.awh-tab:focus-visible { outline: var(--focus-ring-width, 2px) solid var(--focus-ring-color, #fff); outline-offset: -2px; }

.awh-panel { animation: awh-fade var(--duration-base, 220ms) var(--ease-out, ease); }
.awh-panel[hidden] { display: none; }

/* Shared card + control vocabulary for tabs to reuse. */
.awh-card { border: 1px solid var(--stroke, rgba(255,255,255,.08)); border-radius: var(--radius-lg, 14px); background: var(--surface-1, rgba(255,255,255,.03)); padding: var(--space-4, 16px) var(--space-5, 20px); }
.awh-card + .awh-card { margin-top: var(--awh-gap); }
.awh-card-h { font-size: var(--text-2xs, .6875rem); text-transform: uppercase; letter-spacing: .06em; color: var(--ink-dim, #888); margin: 0 0 var(--space-3, 12px); display: flex; align-items: center; gap: 8px; }
.awh-btn { appearance: none; font: inherit; font-size: var(--text-md, .8125rem); color: var(--ink, #e8e8e8); background: var(--surface-2, rgba(255,255,255,.05)); border: 1px solid var(--stroke, rgba(255,255,255,.08)); border-radius: var(--radius-md, 10px); padding: 8px 14px; cursor: pointer; transition: background var(--duration-fast,140ms), border-color var(--duration-fast,140ms), transform var(--duration-instant,80ms); }
.awh-btn:hover:not(:disabled) { background: var(--surface-3, rgba(255,255,255,.08)); border-color: var(--stroke-strong, rgba(255,255,255,.14)); }
.awh-btn:active:not(:disabled) { transform: translateY(1px); }
.awh-btn:focus-visible { outline: var(--focus-ring-width,2px) solid var(--focus-ring-color,#fff); outline-offset: var(--focus-ring-offset,2px); }
.awh-btn:disabled { opacity: var(--disabled-opacity, .4); cursor: var(--disabled-cursor, not-allowed); }
.awh-btn--primary { background: var(--accent, #fff); color: #0a0a0a; border-color: var(--accent, #fff); font-weight: 600; }
.awh-btn--primary:hover:not(:disabled) { background: color-mix(in srgb, var(--accent,#fff) 88%, #000); }
.awh-btn--danger { background: color-mix(in srgb, var(--danger,#ef4444) 14%, transparent); color: var(--danger,#ef4444); border-color: color-mix(in srgb, var(--danger,#ef4444) 40%, transparent); font-weight: 600; }
.awh-btn--danger:hover:not(:disabled) { background: color-mix(in srgb, var(--danger,#ef4444) 22%, transparent); border-color: color-mix(in srgb, var(--danger,#ef4444) 60%, transparent); }
.awh-freeze-card { margin-bottom: var(--space-3,12px); }
.awh-freeze-card.is-frozen { border-color: color-mix(in srgb, var(--danger,#ef4444) 45%, transparent); background: color-mix(in srgb, var(--danger,#ef4444) 8%, transparent); }
.awh-freeze-row { display: flex; align-items: center; gap: var(--space-3,12px); justify-content: space-between; flex-wrap: wrap; }
.awh-freeze-copy { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.awh-freeze-copy strong { font-size: var(--text-md,.8125rem); color: var(--ink-bright,#fff); }
.awh-freeze-copy span { font-size: var(--text-sm,.764rem); color: var(--ink-dim,#888); line-height: 1.45; }
.awh-freeze-row .awh-btn { flex: 0 0 auto; }
.awh-warn-irrev { margin-top: var(--space-3,12px); padding: 9px 12px; border-radius: var(--radius-md,10px); font-size: var(--text-sm,.764rem); line-height: 1.45; color: var(--warn,#fbbf24); background: color-mix(in srgb, var(--warn,#fbbf24) 9%, transparent); border: 1px solid color-mix(in srgb, var(--warn,#fbbf24) 28%, transparent); }
.awh-dest-tag { display: inline-block; margin-left: 8px; font-size: var(--text-2xs,.6875rem); font-weight: 600; padding: 2px 8px; border-radius: var(--radius-pill,999px); white-space: nowrap; }
.awh-dest-tag.ok { color: var(--ok,#34d399); background: color-mix(in srgb, var(--ok,#34d399) 14%, transparent); border: 1px solid color-mix(in srgb, var(--ok,#34d399) 34%, transparent); }
.awh-dest-tag.warn { color: var(--danger,#ef4444); background: color-mix(in srgb, var(--danger,#ef4444) 12%, transparent); border: 1px solid color-mix(in srgb, var(--danger,#ef4444) 34%, transparent); }
.awh-mono { font-family: var(--font-mono, ui-monospace, monospace); }
.awh-empty { color: var(--ink-dim, #888); font-size: var(--text-sm, .764rem); padding: var(--space-3,12px) 0; }
/* Tab mount-failure fallback — a designed, recoverable error state (never a dead end). */
.awh-tab-error { border-color: color-mix(in srgb, var(--danger,#ef4444) 34%, transparent); background: color-mix(in srgb, var(--danger,#ef4444) 7%, transparent); }
.awh-tab-error-h { display: flex; align-items: center; gap: 8px; margin: 0 0 6px; font-size: var(--text-md,.8125rem); font-weight: 600; color: var(--ink-bright,#fff); }
.awh-tab-error-h::before { content: ''; width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--danger,#ef4444); box-shadow: 0 0 6px color-mix(in srgb, var(--danger,#ef4444) 55%, transparent); }
.awh-tab-error p.awh-empty { margin: 0 0 var(--space-3,12px); padding: 0; line-height: 1.5; }
/* Shared address-row + explorer-link primitives. Defined at the hub level (not in
 * a single tab's lazily-injected sheet) so every tab that reuses them — balance,
 * pay, trade — is styled regardless of which tab mounts first. */
.awh-bal-addr { display: flex; align-items: center; gap: var(--space-2,8px); margin-top: var(--space-4,16px); flex-wrap: wrap; }
.awh-bal-addr .awh-mono { font-size: var(--text-sm,.764rem); color: var(--ink,#e8e8e8); background: var(--surface-2, rgba(255,255,255,.05)); padding: 6px 9px; border-radius: var(--radius-sm,6px); border: 1px solid var(--stroke, rgba(255,255,255,.08)); }
.awh-bal-mini { padding: 6px 10px; font-size: var(--text-sm,.764rem); text-decoration: none; }
.awh-act-sig { color: var(--ink,#e8e8e8); text-decoration: none; }
.awh-act-sig:hover { text-decoration: underline; }

.awh-toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%) translateY(8px); background: var(--bg-1, #1a1a1a); color: var(--ink-bright,#fff); border: 1px solid var(--stroke-strong, rgba(255,255,255,.14)); border-radius: var(--radius-md,10px); padding: 10px 16px; font-size: var(--text-md,.8125rem); box-shadow: var(--shadow-3, 0 8px 32px rgba(0,0,0,.5)); opacity: 0; pointer-events: none; transition: opacity var(--duration-base,220ms), transform var(--duration-base,220ms); z-index: 9999; }
.awh-toast[data-show="true"] { opacity: 1; transform: translateX(-50%) translateY(0); }

@keyframes awh-fade { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
@keyframes awh-pulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }
@media (prefers-reduced-motion: reduce) { .awh-panel, .awh-ready[data-state="preparing"]::before, .awh-toast { animation: none; transition: none; } }

@media (max-width: 520px) {
	.awh-name { max-width: 60vw; }
	.awh-net { margin-left: 0; flex-basis: 100%; }
	.awh-tab { padding: 10px 11px; font-size: var(--text-sm,.764rem); }
}
`;

function injectStyle() {
	if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
	const tag = document.createElement('style');
	tag.id = STYLE_ID;
	tag.textContent = STYLE;
	document.head.appendChild(tag);
}

/**
 * Mount the Agent Wallet hub into a container.
 *
 * @param {object} opts
 * @param {HTMLElement} opts.mount        — container element
 * @param {object} opts.agent             — agent record (id, name, avatar_*, walletReady, solana_address, is_owner)
 * @param {string} [opts.initialTab]      — tab id to open first (defaults to URL hash or 'balance')
 * @param {(net: string) => void} [opts.onNetworkChange]
 * @returns {{ destroy: () => void, refresh: () => void, openTab: (id: string) => void }}
 */
export function mountAgentWalletHub({ mount, agent, initialTab, onNetworkChange } = {}) {
	if (!mount || !agent?.id) {
		throw new Error('mountAgentWalletHub requires { mount, agent.id }');
	}
	injectStyle();

	const isOwner = !!(agent.is_owner ?? agent.isOwner);
	let network = 'mainnet';
	const networkListeners = new Set();
	if (typeof onNetworkChange === 'function') networkListeners.add(onNetworkChange);

	// Shared context handed to every tab — the only surface tabs depend on.
	const ctx = {
		agentId: agent.id,
		agent,
		isOwner,
		get network() {
			return network;
		},
		getNetwork: () => network,
		onNetworkChange: (fn) => {
			if (typeof fn === 'function') networkListeners.add(fn);
			return () => networkListeners.delete(fn);
		},
		// Lets a tab hand off to another (e.g. Trade → Deposit on insufficient funds).
		openTab: (id) => openTab(id),
		escapeHtml,
		shortAddress,
		copyToClipboard,
		toast,
	};

	const tabs = getVisibleTabs(isOwner);
	const validIds = new Set(tabs.map((t) => t.id));
	const hashTab = (location.hash || '').replace(/^#/, '');
	let activeId =
		(initialTab && validIds.has(initialTab) && initialTab) ||
		(validIds.has(hashTab) && hashTab) ||
		(tabs[0]?.id ?? null);

	const ready = !!(agent.walletReady ?? agent.wallet_ready);
	const profileUrl = agent.home_url || `/agent/${agent.id}`;

	mount.innerHTML = `
		<section class="awh" aria-label="Agent wallet">
			<div class="awh-header">
				${
					agent.avatar_thumbnail_url || agent.avatar_model_url
						? `<img class="awh-avatar" src="${escapeHtml(agent.avatar_thumbnail_url || '')}" alt="" loading="lazy" data-fallback="remove" />`
						: '<div class="awh-avatar" aria-hidden="true"></div>'
				}
				<div class="awh-id">
					<h1 class="awh-name" title="${escapeHtml(agent.name || 'Agent')}">${escapeHtml(agent.name || 'Agent')} wallet</h1>
					<div class="awh-sub">
						<span class="awh-ready" data-state="${ready ? 'ready' : 'preparing'}" role="status">
							${ready ? 'Wallet ready' : 'Preparing wallet…'}
						</span>
						<a href="${escapeHtml(profileUrl)}">View agent profile</a>
					</div>
				</div>
				<label class="awh-net">
					Network
					<select data-awh="network" aria-label="Solana network">
						<option value="mainnet">Mainnet</option>
						<option value="devnet">Devnet</option>
					</select>
				</label>
			</div>

			<div class="awh-tabs" role="tablist" aria-label="Wallet sections">
				${tabs
					.map(
						(t) => `
					<button class="awh-tab" role="tab" type="button"
						id="awh-tab-${escapeHtml(t.id)}"
						data-awh-tab="${escapeHtml(t.id)}"
						aria-controls="awh-panel-${escapeHtml(t.id)}"
						aria-selected="${t.id === activeId ? 'true' : 'false'}"
						tabindex="${t.id === activeId ? '0' : '-1'}">${escapeHtml(t.label)}</button>`,
					)
					.join('')}
			</div>

			${tabs
				.map(
					(t) => `
				<div class="awh-panel" role="tabpanel"
					id="awh-panel-${escapeHtml(t.id)}"
					aria-labelledby="awh-tab-${escapeHtml(t.id)}"
					data-awh-panel="${escapeHtml(t.id)}"
					${t.id === activeId ? '' : 'hidden'}></div>`,
				)
				.join('')}
		</section>
	`;

	const netSelect = mount.querySelector('[data-awh="network"]');
	const tabButtons = [...mount.querySelectorAll('[data-awh-tab]')];
	const panelFor = (id) => mount.querySelector(`[data-awh-panel="${CSS.escape(id)}"]`);

	// Panels are created once and shown/hidden via [hidden], so the awh-fade
	// animation only fires on first paint. Replay it on each tab switch so a
	// section enters with intent — honouring prefers-reduced-motion live.
	const reduceMotionMq =
		typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
	function playPanelIn(panel) {
		if (!panel || reduceMotionMq?.matches) return;
		panel.style.animation = 'none';
		void panel.offsetWidth; // force reflow so the re-added animation restarts
		panel.style.animation = '';
	}

	// Lazy-mount each tab on first activation; keep the instance so onShow/onHide
	// and destroy can fire. A tab mount that throws degrades to an inline error
	// rather than breaking the whole hub.
	const instances = new Map();
	function ensureMounted(id) {
		if (instances.has(id)) return instances.get(id);
		const panel = panelFor(id);
		const def = tabs.find((t) => t.id === id);
		if (!panel || !def) return null;
		let inst = null;
		try {
			inst = def.mount({ panel, ctx }) || {};
		} catch (err) {
			console.error(`[agent-wallet-hub] tab "${id}" failed to mount`, err);
			const label = def.label || 'this section';
			panel.innerHTML = `
				<div class="awh-card awh-tab-error" role="alert">
					<p class="awh-tab-error-h">Couldn't load ${escapeHtml(label)}</p>
					<p class="awh-empty">Something went wrong opening this section. It's usually temporary — try again, and if it keeps failing, reload the page.</p>
					<button class="awh-btn awh-btn--primary" type="button" data-awh-retry="${escapeHtml(id)}">Retry</button>
				</div>`;
			panel.querySelector('[data-awh-retry]')?.addEventListener('click', () => {
				instances.delete(id);
				ensureMounted(id);
				const fresh = instances.get(id);
				fresh?.onShow?.();
				// Move focus into the freshly-mounted content so keyboard/AT users
				// aren't stranded on a button that just replaced itself.
				const target =
					panel.querySelector(
						'button:not([data-awh-retry]), a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
					) || panel.querySelector('[data-awh-retry]');
				target?.focus?.();
			});
			inst = {};
		}
		instances.set(id, inst);
		return inst;
	}

	function openTab(id) {
		if (!validIds.has(id) || id === activeId) {
			// still ensure the requested (or current) tab is mounted + shown
			if (validIds.has(id)) {
				ensureMounted(id)?.onShow?.();
			}
			return;
		}
		const prev = activeId;
		activeId = id;
		for (const btn of tabButtons) {
			const on = btn.dataset.awhTab === id;
			btn.setAttribute('aria-selected', on ? 'true' : 'false');
			btn.tabIndex = on ? 0 : -1;
		}
		for (const t of tabs) {
			const panel = panelFor(t.id);
			if (panel) panel.hidden = t.id !== id;
		}
		if (prev && instances.has(prev)) instances.get(prev)?.onHide?.();
		ensureMounted(id)?.onShow?.();
		playPanelIn(panelFor(id));
		try {
			history.replaceState(null, '', `#${id}`);
		} catch {
			/* hash update best-effort */
		}
	}

	// Tab strip interactions: click + full roving-tabindex keyboard nav.
	for (const btn of tabButtons) {
		btn.addEventListener('click', () => openTab(btn.dataset.awhTab));
	}
	mount.querySelector('.awh-tabs')?.addEventListener('keydown', (e) => {
		const idx = tabButtons.findIndex((b) => b.dataset.awhTab === activeId);
		if (idx < 0) return;
		let next = -1;
		if (e.key === 'ArrowRight') next = (idx + 1) % tabButtons.length;
		else if (e.key === 'ArrowLeft') next = (idx - 1 + tabButtons.length) % tabButtons.length;
		else if (e.key === 'Home') next = 0;
		else if (e.key === 'End') next = tabButtons.length - 1;
		if (next < 0) return;
		e.preventDefault();
		const btn = tabButtons[next];
		openTab(btn.dataset.awhTab);
		btn.focus();
	});

	netSelect?.addEventListener('change', () => {
		network = netSelect.value === 'devnet' ? 'devnet' : 'mainnet';
		for (const fn of networkListeners) {
			try {
				fn(network);
			} catch (err) {
				console.error('[agent-wallet-hub] network listener failed', err);
			}
		}
	});

	// Mount + show the initial tab.
	if (activeId) ensureMounted(activeId)?.onShow?.();

	function destroy() {
		for (const inst of instances.values()) {
			try {
				inst?.destroy?.();
			} catch {
				/* tab teardown best-effort */
			}
		}
		instances.clear();
		networkListeners.clear();
		mount.innerHTML = '';
	}

	return {
		destroy,
		openTab,
		refresh: () => instances.get(activeId)?.onShow?.(),
	};
}
