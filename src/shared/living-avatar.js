/**
 * The Living Avatar — the agent's wallet-reactive IDENTITY layer (the nameplate).
 *
 * Where wallet-aura.js (the glow) answers "how funded does this agent LOOK," this
 * module answers "WHO is this agent, on chain." It renders the avatar's license
 * plate: the agent name, its vanity-highlighted public address, and a tier glyph
 * that reads the SAME wealth bucket the aura paints — anchored to the avatar so you
 * can look at a character and read its financial life at a glance.
 *
 * One source of truth, composed not reinvented:
 *   • identity (address, vanity prefix/suffix, rarity, owner, deep links) comes from
 *     getWalletStatus() in agent-wallet-chip.js — the platform's one normalizer;
 *   • the vanity-highlighted address uses that module's one highlightAddress();
 *   • the tier + accent come from wallet-networth.js (tierForUsd/computeWalletVisual),
 *     the same tier math the 2D and 3D auras use;
 *   • live tier + the pulse-on-earn ride agent-wealth-state.js's cached custody read,
 *     so the nameplate and the aura share ONE request per agent and never disagree.
 *
 * Three fidelities, same data:
 *   • mountNameplate()      — a DOM overlay plate anchored to a hero / card avatar;
 *   • applyWorldNameplate() — a cheap, pooled enrichment of a world's floating name
 *                             label (tier dot + vanity mark via CSS, survives the
 *                             renderer's per-frame textContent updates);
 *   • resolveLivingAvatar() — the pure descriptor both renderers (and Tasks 04/05)
 *                             consume: { tier, holdsThree, vanity, address, … }.
 *
 * Honest by construction: a real $0 wallet shows a clean plate with no tier glyph
 * (an owner sees a "fund to light it up" nudge); an RPC failure silently falls back
 * to the identity-only plate, never a broken effect. No precise dollar value is ever
 * floated over an avatar — only the bucketed tier. $THREE is the only coin named.
 */

import { getWalletStatus, highlightAddress, ensureWalletChipStyles } from './agent-wallet-chip.js';
import { tierForUsd, computeWalletVisual } from './wallet-networth.js';
import { fetchWealthState, computeWealthDynamics } from './agent-wealth-state.js';
import { normalizePrefs } from './agent-networth.js';

const STYLE_ID = 'tws-living-avatar-styles';
const REDUCED_MOTION =
	typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

function esc(s) {
	return String(s == null ? '' : s).replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
	);
}

function agentIdOf(agent) {
	if (!agent) return null;
	if (typeof agent === 'string') return agent;
	return agent.agent_id || agent.agentId || agent.id || null;
}

// ── pure descriptor ───────────────────────────────────────────────────────────

/**
 * Resolve an agent record (+ optional real wallet figures) into the normalized
 * Living-Avatar descriptor every renderer consumes. Pure and synchronous — pass a
 * known `usd`/`holdsThree` to get the tier filled in, omit them for the loading
 * (identity-only) descriptor. Tier math and identity are NOT reimplemented here:
 * they compose getWalletStatus + tierForUsd/computeWalletVisual.
 *
 * @param {object|string} agent  any supported agent/avatar record (or just an id)
 * @param {object} [opts]
 * @param {number} [opts.usd]         real total portfolio USD (undefined → tier unknown)
 * @param {boolean} [opts.holdsThree] real $THREE holding (drives the brand accent)
 * @param {boolean} [opts.isOwner]    server-resolved ownership for the viewer
 * @returns {{
 *   agentId, address, name, avatarUrl, prefix, suffix, isVanity, rarity,
 *   explorerUrl, hubUrl, ownerName, isOwner, hasWallet,
 *   tier, tierLabel, level, accent, glow, dormant, holdsThree, hasTier
 * }}
 */
export function resolveLivingAvatar(agent, opts = {}) {
	const status = typeof agent === 'string' ? null : getWalletStatus(agent);
	const usd = opts.usd;
	const hasTier = Number.isFinite(usd);
	const holdsThree = !!opts.holdsThree;
	const visual = hasTier
		? computeWalletVisual({ usdTotal: usd, mix: holdsThree ? { three: 1 } : { sol: 1 }, hasThree: holdsThree })
		: null;
	const tier = hasTier ? tierForUsd(usd) : null;

	if (!status) {
		const id = agentIdOf(agent);
		const name = typeof agent === 'object'
			? agent?.name || agent?.display_name || agent?.agent_name || null
			: null;
		return {
			agentId: id, address: null, name, avatarUrl: null,
			prefix: null, suffix: null, isVanity: false, rarity: null,
			explorerUrl: null, hubUrl: id ? `/agents/${id}/wallet` : null,
			ownerName: null, isOwner: !!opts.isOwner, hasWallet: false,
			tier: tier?.key || null, tierLabel: tier?.label || null, level: tier?.level ?? null,
			accent: visual?.accent || 'var(--wallet-accent,#c4b5fd)',
			glow: visual?.glow || 'var(--wallet-glow,rgba(139,92,246,.45))',
			dormant: hasTier ? !!visual?.dormant : true,
			holdsThree, hasTier,
		};
	}

	return {
		agentId: status.agentId, address: status.address, name: status.name, avatarUrl: status.avatarUrl,
		prefix: status.prefix, suffix: status.suffix, isVanity: status.isVanity, rarity: status.rarity,
		explorerUrl: status.explorerUrl, hubUrl: status.hubUrl, ownerName: status.ownerName,
		isOwner: !!opts.isOwner, hasWallet: true,
		tier: tier?.key || null, tierLabel: tier?.label || null, level: tier?.level ?? null,
		accent: visual?.accent || 'var(--wallet-accent,#c4b5fd)',
		glow: visual?.glow || 'var(--wallet-glow,rgba(139,92,246,.45))',
		dormant: hasTier ? !!visual?.dormant : false,
		holdsThree, hasTier,
	};
}

// ── styles ──────────────────────────────────────────────────────────────────

function ensureStyles() {
	if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
	const s = document.createElement('style');
	s.id = STYLE_ID;
	s.textContent = `
.la-plate{position:absolute;z-index:6;left:50%;bottom:10px;transform:translateX(-50%);
	display:inline-flex;align-items:center;gap:7px;max-width:calc(100% - 16px);
	padding:5px 9px;border-radius:999px;pointer-events:auto;
	font:600 12px/1 var(--font-body,Inter,system-ui,-apple-system,"Segoe UI",sans-serif);
	color:var(--ink,#e8e8e8);background:var(--surface-2,rgba(18,18,22,.82));
	border:1px solid var(--wallet-stroke,rgba(139,92,246,.3));
	box-shadow:0 6px 22px rgba(0,0,0,.4);backdrop-filter:blur(var(--blur-md,12px));
	--la-accent:var(--wallet-accent,#c4b5fd);--la-glow:var(--wallet-glow,rgba(139,92,246,.45));
	opacity:0;transition:opacity .35s var(--ease-standard,ease),transform .25s var(--ease-standard,ease),border-color .25s ease,box-shadow .3s ease;}
.la-plate[data-pos="top"]{bottom:auto;top:10px;}
.la-plate[data-ready="1"]{opacity:1;}
.la-plate[data-vanity="1"]{border-color:var(--wallet-stroke-strong,rgba(139,92,246,.5));}
.la-plate[data-three="1"]{border-color:color-mix(in srgb,var(--la-accent) 60%,#f0c46e 40%);}
.la-plate:hover,.la-plate:focus-within{border-color:var(--wallet-stroke-strong,rgba(139,92,246,.55));box-shadow:0 8px 28px rgba(0,0,0,.5),0 0 0 1px var(--la-glow);}
.la-plate:focus-visible{outline:2px solid var(--la-glow);outline-offset:2px;}
.la-glyph{width:9px;height:9px;border-radius:50%;flex:none;position:relative;
	background:var(--la-accent);box-shadow:0 0 7px var(--la-glow);transition:background .4s ease,box-shadow .4s ease;}
.la-plate[data-tier="dormant"] .la-glyph,.la-plate[data-tierless="1"] .la-glyph{background:var(--ink-faint,rgba(255,255,255,.32));box-shadow:none;}
.la-glyph-sk{background:linear-gradient(90deg,rgba(255,255,255,.1),rgba(255,255,255,.28),rgba(255,255,255,.1));
	background-size:200% 100%;animation:la-sk 1.1s ease-in-out infinite;box-shadow:none;}
@keyframes la-sk{0%{background-position:200% 0}100%{background-position:-200% 0}}
.la-name{font-weight:700;color:var(--ink-bright,#fff);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:140px;}
.la-addr{font-family:var(--font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11px;letter-spacing:.01em;
	color:var(--wallet-accent,#c4b5fd);display:inline-flex;gap:1px;align-items:center;border-left:1px solid var(--wallet-stroke,rgba(139,92,246,.28));padding-left:7px;}
.la-addr .twc-hi{color:var(--ink-bright,#fff);font-weight:700;}
.la-addr .twc-dots{opacity:.5;}
.la-three{font-size:9px;font-weight:800;letter-spacing:.03em;text-transform:uppercase;flex:none;
	color:#1a1206;background:linear-gradient(135deg,#f0c46e,#e0a94a);padding:2px 6px;border-radius:999px;line-height:1.3;}
.la-expand{display:inline-flex;align-items:center;gap:5px;max-width:0;overflow:hidden;opacity:0;
	transition:max-width .28s var(--ease-standard,ease),opacity .2s ease;}
.la-plate:hover .la-expand,.la-plate:focus-within .la-expand{max-width:120px;opacity:1;}
.la-act{appearance:none;background:none;border:none;padding:0 2px;margin:0;cursor:pointer;color:inherit;opacity:.7;
	display:inline-flex;align-items:center;transition:opacity .15s ease,transform .12s ease;}
.la-act:hover{opacity:1;}
.la-act:active{transform:scale(.9);}
.la-act:focus-visible{outline:2px solid var(--la-glow);outline-offset:2px;border-radius:4px;}
.la-act svg{width:13px;height:13px;}
.la-copied{color:var(--success,#4ade80)!important;}
.la-tip{font:700 10px/1 var(--font-body,Inter,system-ui);color:var(--wallet-accent-strong,#a78bfa);
	border-left:1px solid var(--wallet-stroke,rgba(139,92,246,.28));padding-left:7px;white-space:nowrap;
	appearance:none;background:none;border-top:none;border-right:none;border-bottom:none;cursor:pointer;transition:color .15s ease;}
.la-tip:hover{color:var(--ink-bright,#fff);}
.la-tip:focus-visible{outline:2px solid var(--la-glow);outline-offset:2px;border-radius:4px;}
.la-fund{font:700 10px/1 var(--font-body,Inter,system-ui);color:var(--wallet-accent-strong,#a78bfa);
	border-left:1px solid var(--wallet-stroke,rgba(139,92,246,.28));padding-left:7px;white-space:nowrap;text-decoration:none;transition:color .15s ease;}
.la-fund:hover{color:var(--ink-bright,#fff);}
.la-plate.la-pulse{animation:la-pulse 1.2s var(--ease-standard,ease-out);}
@keyframes la-pulse{0%{box-shadow:0 6px 22px rgba(0,0,0,.4),0 0 0 0 var(--la-glow);}
	30%{box-shadow:0 6px 22px rgba(0,0,0,.4),0 0 0 8px color-mix(in srgb,var(--la-glow) 0%,transparent);}
	100%{box-shadow:0 6px 22px rgba(0,0,0,.4),0 0 0 0 transparent;}}
.la-plate[data-lod="card"]{padding:3px 7px;gap:5px;font-size:11px;bottom:6px;}
.la-plate[data-lod="card"] .la-name{max-width:90px;}
.la-plate[data-lod="card"] .la-addr,.la-plate[data-lod="card"] .la-expand{display:none;}

/* ── world label enrichment (CSS-only, survives renderer textContent updates) ── */
.walk-remote-label.la-world-label{--la-tier:var(--ink-faint,rgba(255,255,255,.4));}
.walk-remote-label.la-world-label::before{content:"";display:inline-block;width:7px;height:7px;border-radius:50%;
	margin-right:6px;vertical-align:middle;background:var(--la-tier);box-shadow:0 0 6px var(--la-tier);}
.walk-remote-label[data-la-tier="dormant"]::before,.walk-remote-label.la-world-label:not([data-la-tier])::before{box-shadow:none;opacity:.6;}
.walk-remote-label[data-la-vanity]::after{content:"✦";margin-left:5px;color:var(--wallet-accent,#c4b5fd);font-weight:700;vertical-align:middle;}
.walk-remote-label.la-world-three{border-color:color-mix(in srgb,var(--wallet-accent,#c4b5fd) 55%,#f0c46e 45%)!important;}
@media (prefers-reduced-motion: reduce){
	.la-plate,.la-glyph,.la-expand{transition:none;}
	.la-glyph-sk{animation:none;}
	.la-plate.la-pulse{animation:none;}
}`;
	(document.head || document.documentElement).appendChild(s);
}

const COPY_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const LINK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>';
const GEAR_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/></svg>';

async function copyToClipboard(addr, btn) {
	if (!addr || typeof navigator === 'undefined' || !navigator.clipboard) return;
	try {
		await navigator.clipboard.writeText(addr);
		if (!btn) return;
		const prev = btn.innerHTML;
		btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';
		btn.classList.add('la-copied');
		setTimeout(() => { btn.innerHTML = prev; btn.classList.remove('la-copied'); }, 1400);
	} catch { /* clipboard denied — address still legible on the plate */ }
}

// ── overlay nameplate (hero / card) ───────────────────────────────────────────

/**
 * Mount the Living-Avatar nameplate as a DOM overlay anchored to a container that
 * holds an avatar (a <model-viewer> stage, a portrait wrap, a card thumb). Renders
 * identity (name + vanity address) immediately from the record, then hydrates the
 * tier glyph + role-appropriate actions from the real wallet — never blocking the
 * avatar's first paint on wallet data.
 *
 * @param {HTMLElement} container
 * @param {object} agent  any supported agent/avatar record
 * @param {object} [opts]
 * @param {'mainnet'|'devnet'} [opts.network='mainnet']
 * @param {'top'|'bottom'} [opts.position='bottom']
 * @param {'full'|'card'} [opts.lod='full']  card LOD hides the address/expand for dense thumbs
 * @param {boolean} [opts.isOwner=false]  initial owner hint (reconciled with the server read)
 * @param {boolean} [opts.live=true]  keep the tier glyph current + pulse on real earnings
 * @returns {{ el, update(state), setTier(usd,holdsThree), setPrefs(prefs), pulse(), destroy() }|null}
 */
export function mountNameplate(container, agent, opts = {}) {
	if (!container || typeof document === 'undefined') return null;
	ensureWalletChipStyles();
	ensureStyles();

	const network = opts.network === 'devnet' ? 'devnet' : 'mainnet';
	const lod = opts.lod === 'card' ? 'card' : 'full';
	const position = opts.position === 'top' ? 'top' : 'bottom';
	const agentId = agentIdOf(agent);

	const cs = getComputedStyle(container);
	if (cs.position === 'static') container.style.position = 'relative';

	let descriptor = resolveLivingAvatar(agent, { isOwner: !!opts.isOwner });
	// No wallet at all and no name → nothing meaningful to anchor; bail cleanly.
	if (!descriptor.hasWallet && !descriptor.name) return null;

	const plate = document.createElement('div');
	plate.className = 'la-plate';
	plate.dataset.pos = position;
	plate.dataset.lod = lod;
	plate.dataset.tierless = '1';
	plate.setAttribute('tabindex', '0');
	plate.setAttribute('role', 'group');

	let prefs = null;
	let isOwner = !!opts.isOwner;
	let lastTipAt = null;
	let lastUsd = null;
	let primed = false;

	function render() {
		const showAddr = descriptor.hasWallet && lod === 'full' && !(prefs && prefs.nameplate?.address === false);
		const showTier = !(prefs && (prefs.reactivity === 'off' || prefs.signals?.aura === false || prefs.nameplate?.tier === false));
		const vanity = descriptor.isVanity;
		const three = descriptor.holdsThree && showTier;

		plate.style.setProperty('--la-accent', descriptor.accent);
		plate.style.setProperty('--la-glow', descriptor.glow);
		plate.dataset.tier = descriptor.tier || 'dormant';
		plate.dataset.vanity = vanity ? '1' : '0';
		plate.dataset.three = three ? '1' : '0';
		// Tier glyph: a skeleton dot until the first read, then the real bucket (or
		// removed when the wallet is honestly empty). Never a precise dollar value.
		const tierState = !descriptor.hasTier ? 'sk' : descriptor.dormant || !showTier ? 'off' : 'on';
		plate.dataset.tierless = tierState === 'on' ? '0' : '1';
		const glyphCls = tierState === 'sk' ? 'la-glyph la-glyph-sk' : 'la-glyph';
		const glyphTitle = tierState === 'sk'
			? 'Reading wallet…'
			: tierState === 'off'
				? (descriptor.hasWallet ? 'Dormant wallet' : 'Wallet provisioning')
				: `${descriptor.tierLabel} tier · funded`;

		const addrHTML = showAddr
			? `<span class="la-addr" aria-label="Wallet address ${esc(descriptor.address)}">${highlightAddress(descriptor.address, descriptor.prefix, descriptor.suffix, { head: 4, tail: 4 })}</span>`
			: '';
		const threeTag = three
			? '<span class="la-three" title="Holds $THREE — the platform coin">$THREE</span>'
			: '';

		// Expand-on-hover: full-address copy + explorer (visitor-safe, read-only).
		const expand = descriptor.hasWallet && lod === 'full'
			? `<span class="la-expand">` +
				`<button type="button" class="la-act" data-la-copy title="Copy address" aria-label="Copy wallet address">${COPY_SVG}</button>` +
				`<a class="la-act" href="${esc(descriptor.explorerUrl)}" target="_blank" rel="noopener noreferrer" title="View on Solscan" aria-label="View wallet on Solscan">${LINK_SVG}</a>` +
				`</span>`
			: '';

		// Role action: owner → tune how the agent presents (opens the presence panel);
		// non-owner → tip the agent; a fresh empty wallet nudges its owner to fund it.
		let action = '';
		if (isOwner) {
			if (descriptor.hasWallet && descriptor.dormant && descriptor.hasTier) {
				action = descriptor.hubUrl
					? `<a class="la-fund" href="${esc(descriptor.hubUrl)}#deposit" title="Fund this agent to light it up">⚡ Fund</a>`
					: '';
			} else if (lod === 'full') {
				action = `<button type="button" class="la-act" data-la-settings title="Tune how your agent presents" aria-label="Nameplate display settings">${GEAR_SVG}</button>`;
			}
		} else if (descriptor.hasWallet) {
			action = `<button type="button" class="la-tip" data-la-tip title="Tip ${esc(descriptor.name || 'this agent')}">◎ Tip</button>`;
		}

		plate.innerHTML =
			`<span class="${glyphCls}" aria-hidden="true" title="${esc(glyphTitle)}"></span>` +
			`<span class="la-name">${esc(descriptor.name || 'Agent')}</span>` +
			threeTag + addrHTML + expand + action;
		plate.setAttribute('aria-label',
			`${descriptor.name || 'Agent'}${descriptor.hasWallet ? `, wallet ${descriptor.address}` : ''}` +
			`${tierState === 'on' ? `, ${descriptor.tierLabel} tier` : ''}${three ? ', holds $THREE' : ''}`);
		wire();
	}

	function wire() {
		const copyBtn = plate.querySelector('[data-la-copy]');
		if (copyBtn) copyBtn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); copyToClipboard(descriptor.address, copyBtn); });
		const tip = plate.querySelector('[data-la-tip]');
		if (tip) tip.addEventListener('click', async (e) => {
			e.preventDefault(); e.stopPropagation();
			try {
				const { openTipModal } = await import('./agent-tip-modal.js');
				openTipModal({
					id: descriptor.agentId, solana_address: descriptor.address,
					name: descriptor.name || 'this agent', avatar_thumbnail_url: descriptor.avatarUrl || '',
					meta: { payments: { accepted_tokens: (agent?.meta?.payments?.accepted_tokens || agent?.payments?.accepted_tokens || []) } },
				});
			} catch { /* address still copyable from the expanded plate */ }
		});
		const gear = plate.querySelector('[data-la-settings]');
		if (gear) gear.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); openOwnerSettings(); });
	}

	// Owner settings affordance: reveal the presence panel (the owner's control
	// centre for how the agent presents itself). Scroll the nearest one into view
	// and flash it; broadcast an event so a page can open a collapsed panel; fall
	// back to the wallet hub so the affordance is never a dead end.
	function openOwnerSettings() {
		if (agentId) window.dispatchEvent(new CustomEvent('tws:open-presence', { detail: { agentId } }));
		const panel = document.querySelector('.nwp');
		if (panel) {
			panel.scrollIntoView({ behavior: REDUCED_MOTION ? 'auto' : 'smooth', block: 'center' });
			panel.animate?.(
				[{ boxShadow: '0 0 0 0 rgba(139,92,246,.6)' }, { boxShadow: '0 0 0 6px rgba(139,92,246,0)' }],
				{ duration: 1000, easing: 'ease-out' },
			);
			return;
		}
		if (descriptor.hubUrl) window.location.href = `${descriptor.hubUrl}#presence`;
	}

	function setTier(usd, holdsThree) {
		descriptor = resolveLivingAvatar(agent, { usd, holdsThree, isOwner });
		render();
	}

	function setPrefs(p) {
		prefs = p ? normalizePrefs(p) : null;
		render();
	}

	function pulse() {
		if (REDUCED_MOTION || !plate.isConnected) return;
		if (prefs && (prefs.reactivity === 'off' || prefs.signals?.events === false)) return;
		plate.classList.remove('la-pulse');
		void plate.offsetWidth; // restart the animation
		plate.classList.add('la-pulse');
		setTimeout(() => plate.classList.remove('la-pulse'), 1300);
	}

	function update(state) {
		if (!state || !state.ok) return;
		if (typeof state.isOwner === 'boolean') isOwner = state.isOwner;
		if (state.prefs) prefs = normalizePrefs(state.prefs);
		descriptor = resolveLivingAvatar(agent, { usd: state.balanceUsd, holdsThree: state.holdsThree, isOwner });
		render();
		// A real new tip or a real balance increase fires one tasteful glint — only
		// after the first (priming) read so landing on the page never replays an old
		// event. The dynamics gate keeps a flat wallet from ever pulsing.
		const dyn = computeWealthDynamics(state);
		const tipAdvanced = state.lastTipAt && state.lastTipAt !== lastTipAt;
		const grew = lastUsd != null && state.balanceUsd > lastUsd + 1e-6;
		if (primed && (tipAdvanced || (grew && dyn.trend !== 'down'))) pulse();
		lastTipAt = state.lastTipAt;
		lastUsd = state.balanceUsd;
		primed = true;
	}

	container.appendChild(plate);
	render();
	requestAnimationFrame(() => { plate.dataset.ready = '1'; });

	// Apply the owner's nameplate/reactivity prefs the instant they're saved in the
	// presence panel (it broadcasts), so a toggle is reflected without waiting for
	// the next poll. Scoped to this agent.
	const onPrefs = (e) => { if (e?.detail?.agentId === agentId && e.detail.prefs) setPrefs(e.detail.prefs); };
	window.addEventListener('tws:networth-prefs', onPrefs);

	// Live tier + pulse: a visibility-gated poll of the cached custody read. Uses the
	// shared 60s client cache (fresh:false) so on a hero page it rides the aura's
	// poll for zero extra requests, and self-hydrates anywhere the aura isn't mounted.
	let stop = () => {};
	if (opts.live !== false && agentId) {
		let timer = 0;
		let stopped = false;
		let visible = true;
		const io = typeof IntersectionObserver === 'function'
			? new IntersectionObserver((es) => { visible = es.some((e) => e.isIntersecting); }, { threshold: 0.01 })
			: null;
		if (io) io.observe(container);
		const tick = async () => {
			if (stopped) return;
			if (visible && (typeof document === 'undefined' || document.visibilityState === 'visible')) {
				try { update(await fetchWealthState(agentId, { network })); } catch { /* hold last real look */ }
			}
			if (!stopped) timer = setTimeout(tick, 30_000);
		};
		tick();
		stop = () => { stopped = true; if (timer) clearTimeout(timer); try { io?.disconnect(); } catch { /* noop */ } };
	}

	return {
		el: plate,
		update, setTier, setPrefs, pulse,
		destroy() { stop(); window.removeEventListener('tws:networth-prefs', onPrefs); plate.remove(); },
	};
}

// ── world label enrichment (pooled, CSS-only) ─────────────────────────────────

const _embedCache = new Map(); // agentId -> Promise<embed|null>  (dedupes across all labels)

function fetchEmbed(agentId, network) {
	const key = `${agentId}:${network}`;
	if (_embedCache.has(key)) return _embedCache.get(key);
	const p = fetch(`/api/agents/wallet-embed?id=${encodeURIComponent(agentId)}&network=${encodeURIComponent(network)}`, {
		headers: { accept: 'application/json' },
	})
		.then((r) => (r.ok ? r.json() : null))
		.then((j) => j?.data || null)
		.catch(() => null);
	_embedCache.set(key, p);
	return p;
}

/**
 * Enrich a world's floating name label (e.g. walk.js's `.walk-remote-label`) with
 * the agent's wealth tier + vanity, so a crowded plaza is instantly legible — you
 * can see who's funded and who's vanity without walking up to each one. Drives the
 * label's tier dot + vanity mark through CSS pseudo-elements and data attributes,
 * which SURVIVE the renderer's per-frame `textContent = name` updates (no child
 * nodes to clobber). One cached, deduped wallet-embed read per agent across all
 * labels — no per-frame work, no per-label request storm. Visitor view only: it
 * reads the public embed and shows the bucketed tier, never a dollar value.
 *
 * @param {HTMLElement} label   the floating label element
 * @param {string} agentId      the piloted agent's UUID
 * @param {object} [opts] { network }
 * @returns {{ destroy: () => void }}
 */
export function applyWorldNameplate(label, agentId, opts = {}) {
	if (!label || !agentId || typeof document === 'undefined') return { destroy() {} };
	ensureStyles();
	const network = opts.network === 'devnet' ? 'devnet' : 'mainnet';
	let destroyed = false;

	fetchEmbed(agentId, network).then((embed) => {
		if (destroyed || !embed || !embed.address) return;
		label.classList.add('la-world-label');
		const usd = Number(embed.balanceUsd);
		if (Number.isFinite(usd)) {
			const tier = tierForUsd(usd);
			const vis = computeWalletVisual({ usdTotal: usd, mix: Number(embed.three) > 0 ? { three: 1 } : { sol: 1 }, hasThree: Number(embed.three) > 0 });
			label.dataset.laTier = tier.key;
			label.style.setProperty('--la-tier', tier.level > 0 ? vis.accent : 'var(--ink-faint,rgba(255,255,255,.4))');
		}
		if (Number(embed.three) > 0) label.classList.add('la-world-three');
		const v = embed.vanity;
		if (v && (v.prefix || v.suffix)) label.dataset.laVanity = String(v.prefix || v.suffix);
		// Accessible, non-doxxing hover summary (tier bucket + vanity, never a $ value).
		const bucket = Number.isFinite(usd) ? tierForUsd(usd) : null;
		const bits = [embed.name || ''];
		if (bucket && bucket.level > 0) bits.push(`${bucket.label} tier`);
		if (Number(embed.three) > 0) bits.push('holds $THREE');
		if (v && (v.prefix || v.suffix)) bits.push('vanity address');
		label.title = bits.filter(Boolean).join(' · ');
	});

	return {
		destroy() {
			destroyed = true;
			label.classList.remove('la-world-label', 'la-world-three');
			delete label.dataset.laTier;
			delete label.dataset.laVanity;
			label.style.removeProperty('--la-tier');
		},
	};
}

if (typeof window !== 'undefined') {
	window.twsLivingAvatar = { resolveLivingAvatar, mountNameplate, applyWorldNameplate };
}
