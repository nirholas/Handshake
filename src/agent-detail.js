/**
 * Rich agent detail page.
 *
 * Loads via /api/agents/:id (UUID) and /api/avatars/:id for the image.
 * Falls back to a 404 view when the id is unknown or fetch fails.
 *
 * Owner-private fields (chain_id, wallet_address, erc8004_*) only appear when
 * the requester is the agent's owner — render() tolerates them being absent.
 */

import { onchainBadgeEl } from './shared/onchain-badge.js';
import { walletChipEl } from './shared/agent-wallet-chip.js';
import { mountMoneyPulse } from './shared/money-pulse.js';
import { mountMirrorPanel } from './shared/agent-mirror-panel.js';
import { mountStrategyPanel } from './shared/agent-strategy-panel.js';
import { mountPatronagePanel } from './shared/agent-patronage.js';
import { mountValidationBadge } from './shared/validation-badge.js';
import { seeInWorldHref, agentAvatarGlb } from './shared/agent-3d.js';
import { mountIdleAvatar } from './shared/idle-avatar.js';
import { hydrateAvatarWallet } from './shared/wallet-aura.js';
import { mountNameplate } from './shared/living-avatar.js';
import { mountPresence } from './shared/networth-presence.js';
import { mountStagePanel } from './shared/stage-link.js';
import { mountLaborPanel } from './shared/labor-link.js';
import { mountAlphaPanel } from './shared/alpha-copilot-link.js';
import { mountWatchPanel } from './shared/agent-watch-panel.js';
import { mountAchievements } from './shared/agent-achievements-panel.js';
import { renderError as renderAsyncError } from './shared/async-state.js';
import { skeletonHTML } from './shared/state-kit.js';
import { openCoinLaunch } from './shared/agent-coin.js';
import { showSharePanel } from './shared/share.js';
import { mountWalletCard } from './shared/wallet-card.js';
import { enrichAgentDetail, renderEmbed as renderAgentEmbed } from './agent-detail-market.js';
import { log } from './shared/log.js';
import { track, trackError, ANALYTICS_EVENTS } from './analytics.js';
import { mountViewSwitcher } from './view-switcher.js';
import { mountCoinStatus } from './pump/coin-status-card.js';
import { consumeCsrfToken } from './api.js';
import { countUp, updateValue, flashValue, ring, playRings, sparkline, enterStagger } from './ui-juice.js';

// Live coin-status widgets mounted on this page (token chip + launch-history
// rows). Tracked so a re-render (e.g. avatar refresh) tears down their refresh
// timers before remounting, rather than leaking intervals.
const coinStatusHandles = [];
// The per-agent Money Pulse handle (live feed). Torn down on re-render so its
// polling interval + observers don't leak.
let _pulseHandle = null;
let _mirrorHandle = null;
let _streamHandle = null;
let _strategyHandle = null;
let _cardHandle = null;
let _patronageHandle = null;
let _watchHandle = null;
let _achievementsHandle = null;
// Live WebGL avatar mounts (hero + fullscreen modal). Disposed on re-render so a
// fresh render() doesn't stack a second renderer onto the same container.
let _heroAvatarHandle = null;
let _modalAvatarHandle = null;
// Refreshed every render() so the once-wired modal-open handler always mounts the
// current avatar (enrichment can re-render with an updated GLB url).
let _mountModalAvatar = null;

// The hero's wallet aura controller — torn down on re-render/unload so its live
// poll + rAF never leak.
let adNetWorthAura = null;
let adNetWorthPanel = null;
let adNetWorthPlate = null;
function mountAgentDetailAura(agent) {
	const wrap = document.getElementById('ad-avatar-wrap');
	if (!wrap || !agent?.id) return;
	adNetWorthAura?.destroy?.();
	adNetWorthAura = null;
	adNetWorthPanel?.destroy?.();
	adNetWorthPanel = null;
	adNetWorthPlate?.destroy?.();
	adNetWorthPlate = null;
	// The nameplate — name + vanity-highlighted address + tier glyph, anchored to the
	// hero avatar. Renders identity immediately; the tier hydrates from the same
	// cached wallet read the aura uses, so the two never disagree.
	adNetWorthPlate = mountNameplate(wrap, agent, {
		network: 'mainnet', isOwner: !!agent.isOwner, live: true, position: 'bottom',
	});
	hydrateAvatarWallet(wrap, agent, { lod: 'full', live: true, network: 'mainnet', fetchPrefs: false })
		.then((c) => {
			adNetWorthAura = c;
			// The v2 shell provides dedicated slots so these cross-link panels
			// compose into the layout (banner strip below the hero, watch panel in
			// the Activity section) instead of stacking full-width banners above
			// the fold. Classic layout — and any other page without slots — keeps
			// the original prepend/append-to-main behavior.
			const main = document.querySelector('.ad-main');
			const bannerHost = document.getElementById('adv2-banners') || main;
			const bannerPos = bannerHost === main ? 'prepend' : 'append';
			const watchHost = document.getElementById('adv2-watch-slot') || main;
			// Mount the presence panel (tier + reputation regalia + owner reactivity
			// dial) at the top of the main column, kept in lockstep with the aura.
			if (c && bannerHost) {
				mountPresence({ agentId: agent.id, container: bannerHost, aura: c, position: bannerPos })
					.then((panel) => { adNetWorthPanel = panel || null; })
					.catch(() => { /* read failed — aura still shows the look */ });
			}
			// Living Stages cross-link: a "live now / next show" badge for visitors,
			// and one-tap stage controls (create / go live / end show) for the owner.
			if (main) {
				mountStagePanel({ agentId: agent.id, agentName: agent.name || 'this agent', isOwner: !!agent.isOwner, container: bannerHost, position: bannerPos })
					.catch(() => { /* stage is an enhancement; never block the profile */ });
					// Labor Market cross-link: this agent's "Work" record (earnings, jobs,
					// reputation) + a link to post or work for hire. Enhancement only.
					mountLaborPanel({ agentId: agent.id, agentName: agent.name || 'this agent', isOwner: !!agent.isOwner, container: bannerHost, position: bannerPos })
						.catch(() => { /* never block the profile */ });
					// Alpha Co-pilot cross-link: hear this agent read a real live launch in
					// character and (for the owner) act within its spend limits. Enhancement.
					mountAlphaPanel({ agentId: agent.id, agentName: agent.name || 'this agent', isOwner: !!agent.isOwner, container: bannerHost, position: bannerPos })
						.catch(() => { /* never block the profile */ });
					// Live watch panel — agent's screen + avatar webcam. Always shown;
					// renders real activity canvas when no Playwright frames are flowing.
					try { _watchHandle?.destroy?.(); } catch { /* */ } _watchHandle = null;
					mountWatchPanel({
						agentId: agent.id,
						agentName: agent.name || 'this agent',
						avatarUrl: agentAvatarGlb(agent),
						isOwner: !!agent.isOwner,
						container: watchHost,
						position: 'append',
					}).then((h) => { _watchHandle = h || null; }).catch(() => { /* never block */ });
			}
		})
		.catch(() => { /* dormant baseline already shown */ });
}
if (typeof window !== 'undefined') {
	window.addEventListener('pagehide', () => {
		adNetWorthAura?.destroy?.(); adNetWorthAura = null;
		adNetWorthPanel?.destroy?.(); adNetWorthPanel = null;
		adNetWorthPlate?.destroy?.(); adNetWorthPlate = null;
		// Stop any active money stream so a final settle fires and no charges accrue
		// past navigation (the engine also guards this internally).
		try { _streamHandle?.destroy?.(); } catch { /* idempotent */ } _streamHandle = null;
		try { _cardHandle?.destroy?.(); } catch { /* idempotent */ } _cardHandle = null;
		try { _watchHandle?.destroy?.(); } catch { /* idempotent */ } _watchHandle = null;
		try { _achievementsHandle?.destroy?.(); } catch { /* idempotent */ } _achievementsHandle = null;
		// Release the WebGL contexts so they don't count against the browser's
		// hard context budget once the user navigates away.
		try { _heroAvatarHandle?.dispose(); } catch { /* idempotent */ } _heroAvatarHandle = null;
		try { _modalAvatarHandle?.dispose(); } catch { /* idempotent */ } _modalAvatarHandle = null;
	}, { once: true });
}

function destroyCoinStatus() {
	while (coinStatusHandles.length) {
		const h = coinStatusHandles.pop();
		try {
			h.destroy();
		} catch {
			/* ignore */
		}
	}
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SERVICE_TYPES = {
	web: { tag: 'WEB' },
	a2a: { tag: 'A2A' },
	mcp: { tag: 'MCP' },
	token: { tag: 'TOKEN' },
	dbc: { tag: 'DBC' },
	chart: { tag: 'CHART' },
};

const TRUST_ACCENT = {
	reputation: 'amber',
	'crypto-economic': 'violet',
	tee: 'green',
};

const GRADIENTS = [
	['#555577', '#4f46e5'],
	['#0ea5e9', '#ffffff'],
	['#10b981', '#0ea5e9'],
	['#f59e0b', '#ef4444'],
	['#ec4899', '#ffffff'],
	['#14b8a6', '#3b82f6'],
];

function avatarDataUri(name) {
	const [c1, c2] = GRADIENTS[(name?.charCodeAt(0) || 0) % GRADIENTS.length];
	const letter = (name || '?')[0].toUpperCase();
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="168" height="168" viewBox="0 0 168 168"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs><rect width="168" height="168" rx="24" fill="url(#g)"/><text x="50%" y="55%" text-anchor="middle" font-family="Inter,system-ui,sans-serif" font-size="80" font-weight="600" fill="white">${letter}</text></svg>`;
	return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function shortAddr(s, head = 4, tail = 4) {
	if (!s) return '—';
	const str = String(s);
	if (str.length <= head + tail + 1) return str;
	return `${str.slice(0, head)}…${str.slice(-tail)}`;
}

// Deep-link this agent into /irl. Prefer the avatar id (resolveAvatarUrl reads it
// directly); fall back to the always-real GLB (custom or mannequin) so the body
// is never missing. `agent=` lets /irl pre-focus this agent's pin + inspect card.
function irlHref(agent) {
	const av = agent?.avatar_id || agentAvatarGlb(agent); // agentAvatarGlb never returns empty
	const sp = new URLSearchParams();
	if (av) sp.set('avatar', av);
	if (agent?.id) sp.set('agent', agent.id);
	const q = sp.toString();
	return q ? `/irl?${q}` : '/irl';
}

// Deep-link into /xr. Its resolver takes an avatar id (a raw GLB URL would 404 and
// fall back to the default body), so pass the id when present, else let /xr load
// its default — the link is always live either way.
function xrHref(agent) {
	const id = agent?.avatar_id;
	return id ? `/xr?avatar=${encodeURIComponent(id)}` : '/xr';
}

// Deep-link into the full walk experience (/walk/app, which serves the same
// runtime as /walk-embed). Pass the avatar id when present — the embed routes it
// through the same-origin GLB proxy that works from any host — and always pass
// `agent=` so the runtime can resolve the body (and any future persona) even when
// no avatar id is attached, falling back to the mannequin. Joystick controls so a
// visitor can immediately drive the avatar.
function walkAppHref(agent) {
	const sp = new URLSearchParams();
	if (agent?.avatar_id) sp.set('avatar', agent.avatar_id);
	if (agent?.id) sp.set('agent', agent.id);
	sp.set('controls', 'joystick');
	return `/walk/app?${sp.toString()}`;
}

// Source URL for the inline preview iframe. Autoplaying (avatar walks an idle
// circle) and joystick-driven, on the studio environment. We force a transparent
// background and hide the ground disc so the avatar floats free on the page —
// just the body, its soft contact shadow, and the joystick, with no framed box.
function walkEmbedSrc(agent) {
	const sp = new URLSearchParams();
	if (agent?.avatar_id) sp.set('avatar', agent.avatar_id);
	if (agent?.id) sp.set('agent', agent.id);
	sp.set('controls', 'joystick');
	sp.set('autoplay', 'true');
	sp.set('env', 'studio');
	sp.set('bg', 'transparent');
	sp.set('ground', 'false');
	return `/walk-embed?${sp.toString()}`;
}

// Wire the hero "Walk with this agent" CTA plus the inline walking-avatar preview
// card. The card self-manages loading / error / populated states off the embed's
// postMessage handshake (walk:ready) and the iframe's own load/error events.
function wireWalkMode(agent) {
	const cta = document.getElementById('ad-walk-link');
	if (cta) cta.href = walkAppHref(agent);

	// Watch-live CTA → the agent's dedicated live screen viewer (self-handles the
	// idle/offline state when the agent isn't currently broadcasting).
	const watch = document.getElementById('ad-watch-live');
	if (watch && agent?.id) watch.href = `/agent-screen?agentId=${encodeURIComponent(agent.id)}`;

	const card = document.getElementById('ad-walk-card');
	const frame = document.getElementById('ad-walk-frame');
	const skeleton = document.getElementById('ad-walk-skeleton');
	const errorBox = document.getElementById('ad-walk-error');
	const retry = document.getElementById('ad-walk-retry');
	const expand = document.getElementById('ad-walk-expand');
	if (!card || !frame) return;

	if (expand) expand.href = walkAppHref(agent);

	// Idempotent: re-render (avatar refresh) shouldn't stack listeners/timers.
	if (frame._walkWired) clearTimeout(frame._walkTimer);
	frame._walkWired = true;

	const src = walkEmbedSrc(agent);
	card.hidden = false;

	const showReady = () => {
		clearTimeout(frame._walkTimer);
		if (errorBox) errorBox.hidden = true;
		skeleton?.classList.add('is-hidden');
		frame.style.opacity = '1';
	};
	const showError = () => {
		clearTimeout(frame._walkTimer);
		skeleton?.classList.add('is-hidden');
		frame.style.opacity = '0';
		if (errorBox) errorBox.hidden = false;
	};

	// The embed posts { channel:'three-walk', type:'walk:ready' } once the GLB +
	// animations are live (see src/walk-embed-events.js CHANNEL/OUTBOUND.READY).
	// Listen for it (origin- and source-checked) to fade the avatar in; the iframe
	// `load` event only means the document loaded, not that the 3D scene is ready.
	if (!frame._walkMsgWired) {
		frame._walkMsgWired = true;
		window.addEventListener('message', (e) => {
			if (e.source !== frame.contentWindow) return;
			if (e.origin !== location.origin) return;
			const data = e.data;
			if (data && data.channel === 'three-walk' && data.type === 'walk:ready') {
				showReady();
			}
		});
	}

	const start = () => {
		frame.style.opacity = '0';
		skeleton?.classList.remove('is-hidden');
		if (errorBox) errorBox.hidden = true;
		// Belt-and-suspenders: if walk:ready never arrives (e.g. WebGL blocked),
		// reveal whatever the iframe rendered after a grace period instead of an
		// indefinite skeleton. A hard iframe `error` flips to the error state.
		clearTimeout(frame._walkTimer);
		frame._walkTimer = setTimeout(showReady, 9000);
		frame.src = src;
	};

	if (!frame._walkErrWired) {
		frame._walkErrWired = true;
		frame.addEventListener('error', showError);
	}
	if (retry && !retry._wired) {
		retry._wired = true;
		retry.addEventListener('click', start);
	}

	start();
}

function el(tag, props = {}, children = []) {
	const node = document.createElement(tag);
	for (const [k, v] of Object.entries(props)) {
		if (v == null || v === false) continue;
		if (k === 'class') node.className = v;
		else if (k === 'text') node.textContent = v;
		else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
		else node.setAttribute(k, v);
	}
	for (const c of [].concat(children || [])) {
		if (c == null) continue;
		node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
	}
	return node;
}

function pill(text, accent = '') {
	return el('span', { class: `ad-pill ${accent ? `ad-pill-${accent}` : ''}`, text });
}

// ── Launch history ───────────────────────────────────────────────────────────
// Every coin this agent has launched through the platform, newest first, from
// GET /api/pump/by-agent (pump_agent_mints registry). Live market caps stream
// in per row from the shared coin-status widget (`row` variant). Links into the
// public /launches feed.

function launchTimeAgo(iso) {
	const t = new Date(iso).getTime();
	if (!Number.isFinite(t)) return '';
	const s = Math.max(0, (Date.now() - t) / 1000);
	if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m ago`;
	if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
	if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
	return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

async function renderLaunchHistory(container, agent) {
	if (!agent.id) return;
	let coins = [];
	try {
		const r = await fetch(`/api/pump/by-agent?agent_id=${encodeURIComponent(agent.id)}`);
		if (!r.ok) return;
		const body = await r.json();
		coins = Array.isArray(body.coins) ? body.coins : [];
	} catch {
		return; // history is supplementary — the primary token chip still renders
	}
	if (!coins.length) return;

	// Real launch history is worth showing even when no token is linked — undo
	// the visitor-facing hide of the token card (v2 layout only).
	const tokenCard = document.getElementById('ad-token-card');
	if (tokenCard) tokenCard.hidden = false;

	// A single launch that is already shown as the agent token chip above would
	// be pure duplication — just add the public-feed link in that case.
	const onlyDuplicatesChip =
		coins.length === 1 && agent.token && coins[0].mint === agent.token.mint;

	container.classList.remove('ad-muted');
	if (container.textContent === 'No agent token linked for this agent yet.') {
		container.textContent = '';
	}

	const box = el('div', { class: 'ad-launch-history' });

	if (!onlyDuplicatesChip) {
		box.appendChild(
			el('div', { class: 'ad-launch-history-head', text: `Launched coins (${coins.length})` }),
		);
		for (const coin of coins) {
			const isDevnet = coin.network === 'devnet';
			// Keep traders on-platform: each launched coin links to its three.ws
			// coin profile (/launches/<mint>), matching the launches-feed cards.
			// Devnet mints have no market page, so they still deep-link to the
			// explorer in a new tab.
			const row = isDevnet
				? el('a', {
					class: 'ad-launch-row',
					href: `https://explorer.solana.com/address/${coin.mint}?cluster=devnet`,
					target: '_blank',
					rel: 'noopener noreferrer',
					'aria-label': `${coin.symbol || coin.name || 'coin'} on Solana Explorer`,
				})
				: el('a', {
					class: 'ad-launch-row',
					href: `/launches/${coin.mint}`,
					'aria-label': `${coin.symbol || coin.name || 'coin'} on three.ws`,
				});
			box.appendChild(row);
			if (isDevnet) {
				// Devnet mints have no pump.fun market data — render the static row.
				row.append(
					el('span', { class: 'ad-launch-symbol', text: coin.symbol ? `$${coin.symbol}` : coin.name || '—' }),
					el('span', { class: 'ad-mono ad-launch-mint', text: shortAddr(coin.mint) }),
					el('span', { class: 'ad-launch-time', text: launchTimeAgo(coin.created_at) }),
				);
			} else {
				// Live market cap + time stream in through the shared widget — one
				// /api/pump/coin fetch per row, mapped and formatted in one place.
				coinStatusHandles.push(mountCoinStatus(row, coin.mint, { variant: 'row' }));
			}
		}
	}

	box.appendChild(
		el('a', {
			class: 'ad-launch-feed-link',
			href: `/launches?agent_id=${encodeURIComponent(agent.id)}`,
			text: 'View in the public launch feed →',
		}),
	);
	container.appendChild(box);
}

// ── 3D Creations (tokenized mints) ───────────────────────────────────────────
// Every GLB this agent has minted as a Metaplex Core NFT (roadmap prompt 08 —
// GET /api/v1/tokenized/launches, the NFT analogue of pump_agent_mints above),
// surfaced on the profile the same way launched coins are — this is the "link
// from existing agent profiles where the creator is an agent" half of the
// creator-marketplace leaderboard (roadmap prompt 09, /creations). A mint that
// names a parent shows a remix badge; the section stays hidden (see the
// `hidden` attribute in pages/agent-detail.html) until a real mint is found —
// no empty card ever ships to a visitor.
async function renderMintedCreations(container, card, agent) {
	if (!agent.id || !container || !card) return;
	let launches = [];
	try {
		const r = await fetch(`/api/v1/tokenized/launches?agent_id=${encodeURIComponent(agent.id)}&limit=6`);
		if (!r.ok) return;
		const body = await r.json();
		launches = Array.isArray(body?.data?.launches) ? body.data.launches : [];
		// A brand-new profile may only have devnet test mints — fall back so the
		// card isn't hidden just because nothing has hit mainnet yet.
		if (!launches.length) {
			const rd = await fetch(`/api/v1/tokenized/launches?agent_id=${encodeURIComponent(agent.id)}&network=devnet&limit=6`);
			if (rd.ok) {
				const bodyD = await rd.json();
				launches = Array.isArray(bodyD?.data?.launches) ? bodyD.data.launches : [];
			}
		}
	} catch {
		return; // supplementary card — never blocks the rest of the profile
	}
	if (!launches.length) return;

	card.hidden = false;
	const box = el('div', { class: 'ad-launch-history' });
	box.appendChild(el('div', { class: 'ad-launch-history-head', text: `Minted 3D assets (${launches.length})` }));
	for (const a of launches) {
		const row = el('a', {
			class: 'ad-launch-row',
			href: a.viewer_url || `/minted`,
			target: a.viewer_url ? '_blank' : undefined,
			rel: a.viewer_url ? 'noopener noreferrer' : undefined,
			'aria-label': `${a.name || 'Minted 3D asset'} viewer`,
		});
		row.append(
			el('span', { class: 'ad-launch-symbol', text: truncateLabel(a.name || '3D asset', 22) }),
			el('span', { class: 'ad-mono ad-launch-mint', text: shortAddr(a.mint) }),
		);
		if (a.parent_mint) {
			row.append(
				el('span', {
					class: 'ad-pill ad-pill-violet',
					text: a.remix_royalty?.paid ? 'remix · royalty paid' : 'remix',
				}),
			);
		}
		row.append(el('span', { class: 'ad-launch-time', text: launchTimeAgo(a.created_at) }));
		box.appendChild(row);
	}
	box.appendChild(el('a', { class: 'ad-launch-feed-link', href: '/creations', text: 'Browse the creator gallery →' }));
	box.appendChild(el('a', { class: 'ad-launch-feed-link', href: '/minted', text: 'View every mint on /minted →' }));
	container.replaceChildren(box);
}

function truncateLabel(s, n) {
	const t = String(s || '');
	return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

// ── Agent Genome lineage panel ───────────────────────────────────────────────
// Reveals the verifiable family tree: parents this agent was bred from, children
// it has parented, and a one-click verify that re-derives the genome from the
// recorded seed + parents. Hidden entirely when the agent has no lineage, so it
// never adds an empty card to a founder profile.
async function renderLineage(agent) {
	if (!agent?.id) return;
	const card = document.getElementById('ad-lineage-card');
	const body = document.getElementById('ad-lineage-body');
	if (!card || !body) return;
	let data;
	try {
		const r = await fetch(`/api/genome/lineage?agentId=${encodeURIComponent(agent.id)}`);
		if (!r.ok) return;
		data = await r.json();
	} catch {
		return;
	}
	const parents = (data.parents || []).filter((p) => p && p.id);
	const children = (data.children || []).filter((c) => c && c.id);
	if (!data.bred && !parents.length && !children.length) return; // founder, no offspring

	const tierPill = (p) => {
		const tier = p?.pedigree?.tier || 'common';
		return el('span', { class: `ad-lineage-tier`, 'data-tier': tier, text: tier });
	};
	const nodeRow = (label, p) =>
		el('a', { class: 'ad-lineage-node', href: `/agents/${p.id}` }, [
			el('span', { class: 'ad-lineage-role', text: label }),
			el('span', { class: 'ad-lineage-name', text: p.name || 'Agent' }),
			el('span', { class: 'ad-lineage-gen', text: `gen ${p.generation ?? 0}` }),
			tierPill(p),
		]);

	body.replaceChildren();
	const wrap = el('div', { class: 'ad-lineage' });

	if (parents.length === 2) {
		wrap.appendChild(el('div', { class: 'ad-lineage-section-label', text: 'Parents' }));
		wrap.appendChild(nodeRow('Parent A', parents[0]));
		wrap.appendChild(nodeRow('Parent B', parents[1]));
		// Verify control — re-derives and confirms the genome.
		const verifyBtn = el('button', {
			class: 'ad-btn ad-btn-ghost ad-lineage-verify',
			type: 'button',
			text: '✓ Verify lineage',
		});
		const verdict = el('span', { class: 'ad-lineage-verdict' });
		verifyBtn.addEventListener('click', async () => {
			verifyBtn.disabled = true;
			verdict.textContent = 'Verifying…';
			try {
				const r = await fetch(`/api/genome/lineage?agentId=${encodeURIComponent(agent.id)}&verify=1`);
				const j = await r.json();
				if (j.valid) {
					verdict.textContent = `✓ verified · genome ${String(j.genome_hash || '').slice(0, 12)}…`;
					verdict.dataset.ok = '1';
				} else {
					verdict.textContent = `⚠ ${j.reason || 'verification failed'}`;
					verdict.dataset.ok = '0';
				}
			} catch {
				verdict.textContent = '⚠ could not verify — retry';
				verdict.dataset.ok = '0';
			} finally {
				verifyBtn.disabled = false;
			}
		});
		wrap.appendChild(el('div', { class: 'ad-lineage-verify-row' }, [verifyBtn, verdict]));
	}

	if (children.length) {
		wrap.appendChild(el('div', { class: 'ad-lineage-section-label', text: `Offspring (${children.length})` }));
		for (const c of children.slice(0, 12)) wrap.appendChild(nodeRow('Child', c));
	}

	// CTA into the breeding studio, pre-seeded with this agent.
	wrap.appendChild(
		el('a', { class: 'ad-btn ad-btn-primary ad-lineage-breed', href: `/genome?a=${encodeURIComponent(agent.id)}`, text: '🧬 Breed this agent' }),
	);

	body.classList.remove('ad-muted');
	body.appendChild(wrap);
	card.hidden = false;
}

// ── Holder cohorts panel ─────────────────────────────────────────────────────
// Renders the live holder segmentation for an agent token from
// GET /api/coin/:mint/cohorts. Self-manages loading / empty / error / populated
// states so the caller just hands it a container and a mint.

const COHORT_ICONS = {
	holders: '👥',
	whales: '🐋',
	'diamond-hands': '💎',
	'new-buyers': '🌱',
	exited: '🚪',
};

const CONC_LABELS = {
	healthy: 'Healthy spread',
	moderate: 'Moderate',
	high: 'Concentrated',
	'very-high': 'Highly concentrated',
	none: '—',
};

function fmtInt(n) {
	return Number(n || 0).toLocaleString('en-US');
}

function fmtPct(frac) {
	const v = Number(frac || 0) * 100;
	return `${v >= 10 || v === 0 ? v.toFixed(0) : v.toFixed(1)}%`;
}

function cohortsSkeleton() {
	return el('div', {}, [
		el('div', { class: 'ad-cohorts-head' }, [
			el('span', { class: 'ad-cohorts-title', text: 'HOLDERS' }),
			el('span', { class: 'ad-skel ad-skel-count' }),
		]),
		el('div', { class: 'ad-cohorts-body' }, [
			el('div', { class: 'ad-skel ad-skel-row' }),
			el('div', { class: 'ad-skel ad-skel-row' }),
		]),
	]);
}

function cohortsErrorState(retry) {
	const btn = el('button', { class: 'ad-cohorts-retry', type: 'button', text: 'Retry' });
	btn.addEventListener('click', retry);
	return el('div', { class: 'ad-cohorts-err' }, [
		el('span', { class: 'ad-muted', text: 'Couldn’t load holder cohorts.' }),
		btn,
	]);
}

function cohortRow(c, frac) {
	const pct = Math.max(0, Math.min(1, frac));
	return el('div', { class: 'ad-cohort-row', title: c.description || c.name }, [
		el('span', { class: 'ad-cohort-name' }, [
			el('span', { class: 'ad-cohort-icon', text: COHORT_ICONS[c.id] || '•' }),
			el('span', { text: c.name }),
		]),
		el('span', { class: 'ad-cohort-bar' }, [
			el('span', { class: 'ad-cohort-fill', style: `width:${(pct * 100).toFixed(1)}%` }),
		]),
		el('span', { class: 'ad-cohort-val', text: `${fmtInt(c.count)} · ${fmtPct(frac)}` }),
	]);
}

function cohortsView(data) {
	const holderCount =
		data.holderCount ?? (data.cohorts || []).find((c) => c.id === 'holders')?.count ?? 0;
	const nodes = [
		el('div', { class: 'ad-cohorts-head' }, [
			el('span', { class: 'ad-cohorts-title', text: 'HOLDERS' }),
			el('span', { class: 'ad-cohorts-count', text: fmtInt(holderCount) }),
		]),
	];

	if (!holderCount) {
		nodes.push(
			el('div', { class: 'ad-cohorts-empty', text: 'No holders yet — be the first.' }),
		);
		return nodes;
	}

	const locked = [];
	const body = el('div', { class: 'ad-cohorts-body' });
	for (const c of data.cohorts || []) {
		if (c.id === 'holders') continue; // the header already shows the total
		if (c.count == null) {
			locked.push(c.name);
			continue;
		}
		body.appendChild(cohortRow(c, holderCount ? c.count / holderCount : 0));
	}
	if (body.childNodes.length) nodes.push(body);

	const con = data.concentration;
	if (con) {
		nodes.push(
			el('div', { class: 'ad-cohorts-conc' }, [
				el('span', {
					class: `ad-conc-chip ad-conc-${con.label || 'none'}`,
					text: CONC_LABELS[con.label] || con.label || '—',
				}),
				el('span', {
					class: 'ad-cohorts-conc-detail',
					text: `Top holder ${fmtPct(con.top1Share)} · Top 10 ${fmtPct(con.top10Share)}`,
				}),
			]),
		);
	}

	if (locked.length) {
		nodes.push(
			el('div', {
				class: 'ad-cohorts-note',
				text: `${locked.join(' · ')} unlock once holder history is recorded.`,
			}),
		);
	}
	return nodes;
}

async function renderHolderCohorts(box, mint) {
	box.classList.add('ad-cohorts');
	box.replaceChildren(cohortsSkeleton());
	let data;
	try {
		const r = await fetch(`/api/coin/${encodeURIComponent(mint)}/cohorts`, {
			credentials: 'include',
		});
		if (!r.ok) throw new Error(String(r.status));
		data = await r.json();
	} catch {
		box.replaceChildren(cohortsErrorState(() => renderHolderCohorts(box, mint)));
		return;
	}
	box.replaceChildren(...cohortsView(data));
}

function renderService(svc) {
	const meta = SERVICE_TYPES[svc.type] || { tag: (svc.type || '').toUpperCase() };
	const head = el('div', { class: 'ad-svc-head' }, [
		el('span', { class: 'ad-svc-tag', text: meta.tag }),
		svc.version ? el('span', { class: 'ad-svc-version', text: svc.version }) : null,
		svc.label ? el('span', { class: 'ad-svc-version', text: svc.label }) : null,
	]);

	const card = el('div', { class: 'ad-svc' }, [head]);

	if (svc.url) {
		card.appendChild(
			el('div', { class: 'ad-svc-link' }, [
				el('span', { text: '🔗' }),
				el('span', { text: svc.url }),
				el(
					'button',
					{
						class: 'ad-copy',
						'aria-label': 'Copy',
						onclick: () => navigator.clipboard?.writeText(svc.url),
					},
					'⧉',
				),
			]),
		);
	}

	const metaItems = [];
	if (svc.skills?.length) {
		metaItems.push(el('span', { class: 'ad-svc-meta-label', text: 'SKILLS' }));
		svc.skills.forEach((s) => metaItems.push(el('span', { class: 'ad-chip', text: s })));
	}
	if (svc.domains?.length) {
		metaItems.push(el('span', { class: 'ad-svc-meta-label', text: 'DOMAINS' }));
		svc.domains.forEach((s) => metaItems.push(el('span', { class: 'ad-chip', text: s })));
	}
	if (metaItems.length) card.appendChild(el('div', { class: 'ad-svc-meta' }, metaItems));

	return card;
}

function render(agent) {
	document.title = `${agent.name} — three.ws`;

	const $ = (id) => document.getElementById(id);

	// Flat image fallback (hidden while the live WebGL avatar renders)
	const avatarImg = $('ad-avatar');
	if (avatarImg) {
		avatarImg.src = agent.avatar || avatarDataUri(agent.name);
		avatarImg.alt = agent.name;
		avatarImg.onerror = () => { avatarImg.src = avatarDataUri(agent.name); };
	}
	$('ad-name').textContent = agent.name;

	// Update page title, canonical URL, and OG tags for social sharing
	if (agent.id && agent.name) {
		const pageUrl = `https://three.ws/agents/${agent.id}`;
		const ogImg   = `https://three.ws/api/og/agent?id=${encodeURIComponent(agent.id)}`;
		document.title = `${agent.name} · three.ws`;
		const canonical = document.getElementById('canonical-link');
		if (canonical) canonical.href = pageUrl;
		document.querySelector('meta[property="og:url"]')?.setAttribute('content', pageUrl);
		document.querySelector('meta[property="og:title"]')?.setAttribute('content', `${agent.name} · three.ws`);
		document.querySelector('meta[property="og:image"]')?.setAttribute('content', ogImg);
		document.querySelector('meta[name="twitter:title"]')?.setAttribute('content', `${agent.name} · three.ws`);
		document.querySelector('meta[name="twitter:image"]')?.setAttribute('content', ogImg);
	}

	// Let visitors save this agent's avatar as their own fork (its wallet is
	// already managed in the holdings panel below, so fork-only here).
	const fork = $('ad-avatar-actions');
	if (fork && agent.avatar_id) {
		if (!customElements.get('avatar-actions') && !document.querySelector('script[data-avatar-actions]')) {
			const s = document.createElement('script');
			s.type = 'module';
			s.src = '/avatar-actions.js';
			s.dataset.avatarActions = '1';
			document.head.appendChild(s);
		}
		fork.setAttribute('avatar-id', agent.avatar_id);
		fork.style.display = 'block';
	}

	// Register the shared royalty panel so the avatar-actions royalty chips open
	// the rich in-page ledger (rather than navigating away), and honor a
	// /agent/:id#royalties deep link by opening it directly.
	import('./shared/agent-fork-royalty.js')
		.then((rty) => {
			if (location.hash === '#royalties' && agent.id) {
				rty.openRoyaltyPanel(agent.id, { name: agent.name || 'this agent' });
			}
		})
		.catch(() => {});

	// "See in 3D" drops this agent's avatar into the live $three world. Every
	// agent has one — its own GLB if attached, the base mannequin otherwise — so
	// the button is always live. Marketplace enrichment upgrades the href to a
	// richer custom GLB if the agent ships one.
	const see3d = $('ad-see-3d');
	if (see3d) see3d.href = seeInWorldHref(agent);

	// "View in IRL" / "View in XR" drop this agent's body into the immersive layer
	// with the pin pre-focused. Every agent has a resolvable body — its own avatar
	// id, or the always-real mannequin GLB — so both links are never dead (same
	// invariant the world link relies on above).
	const irlLink = $('ad-irl-link');
	if (irlLink) irlLink.href = irlHref(agent);
	const xrLink = $('ad-xr-link');
	if (xrLink) xrLink.href = xrHref(agent);

	// "Walk with this agent" — the hero CTA and the inline walking preview card,
	// both pointed at /walk/app + /walk-embed with this agent's avatar. Every agent
	// has a resolvable body (custom GLB or mannequin), so the mode is always live.
	wireWalkMode(agent);

	// View switcher: flip this agent between its detail, 3D world, and embed
	// presentations. Every agent has a 3D body (custom GLB or mannequin).
	mountViewSwitcher($('view-switch-slot'), {
		kind: 'agent',
		id: agent.id,
		active: new URLSearchParams(location.search).get('view') === 'embed' ? 'embed' : 'detail',
		worldHref: seeInWorldHref(agent),
	});

	// Embed snippets work for every agent, not just marketplace-published ones,
	// so the "Embed" view always lands on real, copyable code. Marketplace
	// enrichment later refreshes this with the canonical GLB if it differs.
	renderAgentEmbed({ ...agent, avatar_glb_url: agent.avatar_glb_url || agentAvatarGlb(agent) });

	// ── Hero 3D avatar ────────────────────────────────────────────────────
	// A live, idle-animated body — the canonical idle clip is retargeted onto the
	// avatar's rig (arms drop, weight settles) and the procedural idle-life loop
	// (breathing, blink, weight shift) plays on top. Never a frozen bind-pose
	// T-pose, which is what a static <model-viewer> could only ever show.
	const glbUrl = agentAvatarGlb(agent);
	// WebGL unavailable or the GLB failed → reveal the still image (already given a
	// real src — thumbnail or generated initials — earlier in render()).
	const showFlatFallback = () => {
		const host = document.getElementById('ad-avatar-3d');
		if (host) host.style.display = 'none';
		const img = document.getElementById('ad-avatar');
		if (img) img.style.display = '';
	};
	_heroAvatarHandle?.dispose();
	_heroAvatarHandle = null;
	const heroHost = document.getElementById('ad-avatar-3d');
	if (heroHost && glbUrl) {
		_heroAvatarHandle = mountIdleAvatar(heroHost, glbUrl, {
			autoRotate: true,
			seed: agent.id || agent.name || glbUrl,
			onError: showFlatFallback,
		});
		// null → no WebGL context available; fall back to the still image.
		if (!_heroAvatarHandle) showFlatFallback();
	}
	// Radial glow behind avatar derived from agent name color
	const glowEl = document.getElementById('ad-hero-glow');
	if (glowEl) {
		const [c1] = GRADIENTS[(agent.name?.charCodeAt(0) || 0) % GRADIENTS.length];
		glowEl.style.background = `radial-gradient(ellipse 60% 55% at 50% 40%, ${c1}22 0%, transparent 70%)`;
	}
	// Net-Worth-Reactive Avatar: weld the agent's real wallet to its hero body so
	// its funded-ness is legible here exactly as on the viewer and in the galaxy.
	mountAgentDetailAura(agent);
	// Fullscreen modal — the orbitable, camera-controlled body. Mounted lazily on
	// first open so the page doesn't pay for a second WebGL context up front.
	_modalAvatarHandle?.dispose();
	_modalAvatarHandle = null;
	_mountModalAvatar = () => {
		if (_modalAvatarHandle) return;
		const host = document.getElementById('ad-avatar-modal-3d');
		if (host && glbUrl) {
			_modalAvatarHandle = mountIdleAvatar(host, glbUrl, {
				autoRotate: true,
				cameraControls: true,
				seed: agent.id || agent.name || glbUrl,
			});
		}
	};
	// "View in AR" link drops this agent into the live three.ws world (every
	// agent has a body — custom GLB or mannequin — so the href is always real).
	const modalWorld = document.getElementById('ad-3d-modal-world');
	if (modalWorld) {
		const worldHref = seeInWorldHref(agent);
		if (worldHref && worldHref !== '#') {
			modalWorld.href = worldHref;
			modalWorld.hidden = false;
		} else {
			modalWorld.hidden = true;
		}
	}
	const modal = document.getElementById('ad-3d-modal');
	const avatarWrap = document.getElementById('ad-avatar-wrap');
	const closeModal = () => modal.classList.add('hidden');
	if (modal && avatarWrap && !avatarWrap._modalWired) {
		avatarWrap._modalWired = true;
		const openModal = () => { _mountModalAvatar?.(); modal.classList.remove('hidden'); };
		avatarWrap.addEventListener('click', openModal);
		avatarWrap.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openModal(); }
		});
		document.getElementById('ad-3d-modal-close')?.addEventListener('click', closeModal);
		modal.addEventListener('click', (e) => {
			if (e.target === modal) closeModal();
		});
		// Esc closes the fullscreen viewer — standard modal affordance.
		document.addEventListener('keydown', (e) => {
			if (e.key === 'Escape' && !modal.classList.contains('hidden')) closeModal();
		});
	}

	const status = $('ad-status');
	status.textContent = agent.active ? 'Active' : 'Inactive';
	status.classList.toggle('ad-status-inactive', !agent.active);

	// On-chain badge sits directly below the name as a pulsing pill.
	// Re-rendered safely if render() runs twice — drop any prior badge first.
	document.getElementById('ad-onchain-badge')?.remove();
	const onchainBadge = onchainBadgeEl(agent.rawMetadata || agent, { size: 'md' });
	if (onchainBadge) {
		onchainBadge.id = 'ad-onchain-badge';
		if (agent.onchain || agent.txHash || agent.contractAddress) {
			onchainBadge.classList.add('ad-onchain-live');
		}
		// Insert right after the title row for prominence
		const titleRow = document.querySelector('.ad-hero-title');
		if (titleRow) {
			titleRow.insertAdjacentElement('afterend', onchainBadge);
		} else {
			status.insertAdjacentElement('afterend', onchainBadge);
		}
	}

	// Validation attestation badge — only for EVM ERC-8004 agents, read
	// walletlessly from the on-chain ValidationRegistry. Re-mountable on refresh.
	let validationSlot = document.getElementById('ad-validation-badge');
	if (agent.chainId && agent.erc8004AgentId) {
		if (!validationSlot) {
			validationSlot = document.createElement('span');
			validationSlot.id = 'ad-validation-badge';
			validationSlot.style.marginLeft = '8px';
			(onchainBadge || status).insertAdjacentElement('afterend', validationSlot);
		}
		mountValidationBadge({
			container: validationSlot,
			chainId: agent.chainId,
			agentId: agent.erc8004AgentId,
			isOwner: agent.isOwner,
			glbUrl: agent.glbUrl || undefined,
		});
	} else {
		validationSlot?.remove();
	}

	$('ad-id-short').textContent = shortAddr(agent.id);
	$('ad-id-short').dataset.full = agent.id;
	$('ad-asset-kind').textContent = agent.assetKind || 'Core Asset';
	$('ad-desc').textContent = agent.description || '';

	const trustPills = $('ad-trust-pills');
	trustPills.innerHTML = '';
	(agent.trust || []).forEach((t) =>
		trustPills.appendChild(pill(t, TRUST_ACCENT[t.toLowerCase()] || '')),
	);

	const services = $('ad-services');
	services.innerHTML = '';
	(agent.services || []).forEach((s) => services.appendChild(renderService(s)));
	$('ad-svc-count').textContent = `${agent.services?.length || 0} configured`;
	$('ad-svc-count2').textContent = String(agent.services?.length || 0);

	// Universal wallet chip — the same vanity-aware component every other surface
	// renders, so the agent's custodial Solana address (and its vanity styling)
	// looks and behaves identically here: copy + explorer for everyone, plus the
	// owner-only "✦ Vanity" entry point into the wallet hub via isOwner. The
	// Solana address lives on meta.solana_address (agent.wallet is the EVM address,
	// which the Solana chip rejects), so feed the chip the real Solana key.
	{
		const host = $('ad-holdings-chip');
		const wMeta = agent.rawMetadata?.meta || {};
		if (host) {
			host.replaceChildren();
			const chip = walletChipEl(
				{
					id: agent.id,
					name: agent.name,
					solana_address: wMeta.solana_address || null,
					avatar_thumbnail_url: agent.avatar || '',
					solana_vanity_prefix: wMeta.solana_vanity_prefix || null,
					solana_vanity_suffix: wMeta.solana_vanity_suffix || null,
					meta: wMeta,
				},
				{ isOwner: !!agent.isOwner, showPending: true, link: true },
			);
			if (chip) host.appendChild(chip);
		}
	}
	countUpField($('ad-holdings-sol'), agent.solBalance);

	// Wallet trading card — the agent's living, screenshot-worthy identity object:
	// avatar, vanity address, live net worth, holdings, P&L, reputation tier, and a
	// tip/fork/share CTA. Rendered only when the agent has a custodial wallet, from
	// the same public, server-authoritative reads every wallet surface uses. The
	// card's image twin (api/og/agent.js) is what a shared link unfurls as.
	{
		const cardSection = $('ad-trading-card-section');
		const cardMount = $('ad-trading-card-mount');
		const wMeta = agent.rawMetadata?.meta || {};
		if (_cardHandle) { try { _cardHandle.destroy(); } catch { /* idempotent */ } _cardHandle = null; }
		if (cardSection && cardMount && wMeta.solana_address) {
			cardSection.hidden = false;
			_cardHandle = mountWalletCard(cardMount, {
				id: agent.id,
				name: agent.name,
				solana_address: wMeta.solana_address,
				avatar_thumbnail_url: agent.avatar || '',
				solana_vanity_prefix: wMeta.solana_vanity_prefix || null,
				solana_vanity_suffix: wMeta.solana_vanity_suffix || null,
				meta: wMeta,
			}, { isOwner: !!agent.isOwner, network: 'mainnet' });

			const shareTrigger = $('ad-trading-card-share');
			if (shareTrigger && !shareTrigger._wired) {
				shareTrigger._wired = true;
				const openShare = () => showSharePanel({
					kind: 'agent',
					id: agent.id,
					title: agent.name || 'Agent',
					description: agent.description || '',
					shareUrl: `${location.origin}/agent/${agent.id}/share`,
					remixUrl: `${location.origin}/agents/${agent.id}`,
					previewImage: `${location.origin}/api/og/agent?id=${encodeURIComponent(agent.id)}`,
				}, shareTrigger);
				shareTrigger.addEventListener('click', openShare);
				shareTrigger.addEventListener('keydown', (e) => {
					if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openShare(); }
				});
			}
		} else if (cardSection) {
			cardSection.hidden = true;
		}
	}

	// Money Stream — pay-per-second income. A visitor gets the live meter (set a
	// rate, sign a cap, watch the agent earn while they're here); the owner gets the
	// live "earning now" + lifetime streaming earnings view. Mounted only when the
	// agent has a custodial wallet to stream to / earn into.
	{
		const streamCard = $('ad-stream-card');
		const streamMount = $('ad-stream-mount');
		const streamSub = $('ad-stream-sub');
		const streamTitle = $('ad-stream-title');
		const wMeta = agent.rawMetadata?.meta || {};
		if (_streamHandle) { try { _streamHandle.destroy(); } catch { /* idempotent */ } _streamHandle = null; }
		if (streamCard && streamMount && wMeta.solana_address) {
			streamCard.hidden = false;
			if (streamTitle) streamTitle.textContent = agent.isOwner ? 'STREAM EARNINGS' : 'MONEY STREAM';
			if (streamSub) streamSub.textContent = agent.isOwner ? 'earning by the second' : 'pay by the second';
			import('./shared/agent-money-stream.js').then(({ mountStreamMeter }) => {
				_streamHandle = mountStreamMeter(streamMount, {
					id: agent.id,
					name: agent.name,
					solana_address: wMeta.solana_address,
					avatar_thumbnail_url: agent.avatar || '',
					isOwner: !!agent.isOwner,
					meta: wMeta,
				}, { network: 'mainnet', isOwner: !!agent.isOwner, compact: false });
			}).catch(() => { if (streamCard) streamCard.hidden = true; });
		} else if (streamCard) {
			streamCard.hidden = true;
		}
	}

	// Wallet story — this agent's public Money Pulse (tips, launches, trades,
	// payments) scoped to it: the same real-data component as /pulse. Shown only
	// when the agent has a custodial wallet; the component renders its own honest
	// empty/loading/error states.
	{
		const pulseCard = $('ad-pulse-card');
		const pulseFeed = $('ad-pulse-feed');
		const wMeta = agent.rawMetadata?.meta || {};
		if (_pulseHandle) { try { _pulseHandle.destroy(); } catch { /* idempotent */ } _pulseHandle = null; }
		if (pulseCard && pulseFeed && wMeta.solana_address) {
			pulseCard.hidden = false;
			pulseFeed.replaceChildren();
			_pulseHandle = mountMoneyPulse({
				mount: pulseFeed,
				variant: 'agent',
				agentId: agent.id,
				network: 'mainnet',
				controls: false,
				live: true,
				pageSize: 12,
				emptyHint: agent.isOwner
					? 'No public activity yet — launch a coin or get tipped and it appears here.'
					: 'No public wallet activity yet. Be the first to tip this agent.',
			});
		} else if (pulseCard) {
			pulseCard.hidden = true;
		}
	}

	// Copy Trading (mirror) — manage who this agent mirrors (owner), or its honest
	// track record + a "Mirror this agent" CTA (visitor). The panel reveals its own
	// card (#ad-mirror-card) only when there's something to show, and renders every
	// state itself. The leash (kill switch + caps) is surfaced prominently.
	{
		const mirrorPanel = $('ad-mirror-panel');
		if (_mirrorHandle) { try { _mirrorHandle.destroy(); } catch { /* idempotent */ } _mirrorHandle = null; }
		const wMeta = agent.rawMetadata?.meta || {};
		if (mirrorPanel && wMeta.solana_address) {
			_mirrorHandle = mountMirrorPanel({ mount: mirrorPanel, agent, isOwner: !!agent.isOwner });
		}
	}

	// Strategy Objects — equip a real, rule-based plan and the agent trades it for
	// real within the spend policy (owner), or equip a strategy this creator
	// publishes with your own agent (visitor). Sibling primitive to mirroring; the
	// panel reveals its own card (#ad-strategy-objects-card) only when there's
	// something to show.
	{
		const strategyPanel = $('ad-strategy-panel');
		if (_strategyHandle) { try { _strategyHandle.destroy(); } catch { /* idempotent */ } _strategyHandle = null; }
		const wMeta = agent.rawMetadata?.meta || {};
		if (strategyPanel && wMeta.solana_address) {
			_strategyHandle = mountStrategyPanel({ mount: strategyPanel, agent, isOwner: !!agent.isOwner });
		}
	}

	// Patronage — tips/streams build a memory-backed relationship: the perk ladder,
	// the visitor's level + progress, the public patron wall, season standings, and
	// the owner's perk editor + patron CRM. The panel reveals its own card
	// (#ad-patronage-card) only when there's a ladder, a wall, or the owner is here.
	{
		const patronagePanel = $('ad-patronage-panel');
		if (_patronageHandle) { try { _patronageHandle.destroy(); } catch { /* idempotent */ } _patronageHandle = null; }
		const wMeta = agent.rawMetadata?.meta || {};
		if (patronagePanel && wMeta.solana_address) {
			_patronageHandle = mountPatronagePanel({
				mount: patronagePanel,
				agent: { id: agent.id, name: agent.name, solana_address: wMeta.solana_address, rawMetadata: agent.rawMetadata },
				isOwner: !!agent.isOwner,
			});
		}
	}

	// A re-render (avatar refresh) clears the token body below; tear down any
	// coin-status widgets first so their refresh timers don't leak.
	destroyCoinStatus();

	// "No agent token linked yet" is dead weight for a visitor — hide the card
	// unless there's a token, the viewer owns the agent (launch CTA), or launch
	// history reveals it below. Classic layout has no #ad-token-card, so this
	// is a v2-only refinement.
	const tokenCard = document.getElementById('ad-token-card');
	if (tokenCard) tokenCard.hidden = !agent.token && !agent.isOwner;

	if (agent.token) {
		$('ad-token-body').classList.remove('ad-muted');
		$('ad-token-body').textContent = '';
		// Live token chip — symbol · price · market cap · graduation %, streamed
		// and formatted by the shared coin-status widget. Devnet tokens (no
		// pump.fun market data) fall back to a static symbol + mint row.
		if (agent.token.cluster === 'devnet') {
			$('ad-token-body').appendChild(
				el('div', { class: 'ad-row ad-row-split' }, [
					el('span', { text: agent.token.symbol || 'TOKEN' }),
					el('span', { class: 'ad-mono', text: shortAddr(agent.token.mint) }),
				]),
			);
		} else {
			const chipBox = el('div', { class: 'ad-token-chip' });
			$('ad-token-body').appendChild(chipBox);
			coinStatusHandles.push(mountCoinStatus(chipBox, agent.token.mint, { variant: 'chip' }));
		}
		const dashLink =
			agent.token.pumpfun_url ||
			(agent.token.cluster === 'devnet'
				? `https://explorer.solana.com/address/${agent.token.mint}?cluster=devnet`
				: `https://pump.fun/${agent.token.mint}`);
		const viewBtn = el('a', {
			class: 'ad-token-cta',
			href: dashLink,
			target: '_blank',
			rel: 'noopener noreferrer',
			text: `View on ${agent.token.cluster === 'devnet' ? 'Solana Explorer' : 'pump.fun'} →`,
		});
		$('ad-token-body').appendChild(viewBtn);

		// Live holder segmentation for this token — fire-and-forget; the panel
		// renders its own loading / empty / error / populated states.
		const cohortsBox = el('div', { class: 'ad-cohorts' });
		$('ad-token-body').appendChild(cohortsBox);
		renderHolderCohorts(cohortsBox, agent.token.mint);
	} else if (agent.isOwner) {
		$('ad-token-body').classList.remove('ad-muted');
		$('ad-token-body').textContent = '';
		const launchBtn = el('button', {
			class: 'ad-token-cta',
			type: 'button',
			text: '🚀 Launch agent token',
		});
		launchBtn.addEventListener('click', async () => {
			launchBtn.disabled = true;
			try {
				await openCoinLaunch(agent);
			} finally {
				launchBtn.disabled = false;
			}
		});
		$('ad-token-body').appendChild(launchBtn);
	}

	// Full launch history from the pump_agent_mints registry — fire-and-forget;
	// renders nothing extra when the agent has no launches beyond the chip above.
	renderLaunchHistory($('ad-token-body'), agent);

	// 3D creations minted as NFTs — fire-and-forget; the card stays hidden when
	// this agent hasn't minted anything yet.
	renderMintedCreations($('ad-creations-body'), $('ad-creations-card'), agent);

	// Achievements — earned badges + in-progress ladder from real platform data
	// (launches, graduations/migrations, market caps, supporters, burns,
	// reputation, tenure). The panel hides its own card for visitors on a blank
	// profile and shows the owner an encouraging empty state.
	{
		const achBody = $('ad-achievements-body');
		const achCard = $('ad-achievements-card');
		if (_achievementsHandle) { try { _achievementsHandle.destroy(); } catch { /* idempotent */ } _achievementsHandle = null; }
		if (achBody && agent.id) {
			_achievementsHandle = mountAchievements({
				mount: achBody,
				agentId: agent.id,
				isOwner: !!agent.isOwner,
				card: achCard,
			});
		}
	}

	// Agent Genome lineage — parents (if bred), children (if a parent), and a
	// one-click re-derivation verify. Fire-and-forget; reveals the card only when
	// there is real descent to show.
	renderLineage(agent);

	// Creator rewards: only surface the card once this agent has actually earned.
	// A "Lifetime rewards 0 SOL" row is pure hollow for a non-earning agent — hide
	// it (like the other reveal-when-data sections) so the page reads tight, and
	// reveal it the moment there's a real number to show.
	const _rewards = Number(agent.creatorRewards) || 0;
	const _rewardsCard = document.getElementById('ad-rewards-card');
	if (_rewards > 0) {
		if (_rewardsCard) _rewardsCard.hidden = false;
		countUpField($('ad-rewards'), _rewards);
	} else if (_rewardsCard) {
		_rewardsCard.hidden = true;
	}

	const mechs = $('ad-trust-mechs');
	mechs.innerHTML = '';
	(agent.trust || []).forEach((t) =>
		mechs.appendChild(pill(t, TRUST_ACCENT[t.toLowerCase()] || '')),
	);

	const pay = $('ad-payment');
	pay.innerHTML = '';
	pay.appendChild(
		pill(agent.x402 ? 'x402 Supported' : 'x402 Not Supported', agent.x402 ? 'green' : ''),
	);

	$('ad-agent-id').textContent = shortAddr(agent.id);
	const regs = $('ad-registries');
	regs.innerHTML = '';
	(agent.registries || []).forEach((r) => regs.appendChild(pill(r)));

	$('ad-raw').textContent = JSON.stringify(agent.rawMetadata || agent, null, 2);

	const onchain = $('ad-onchain');
	onchain.innerHTML = '';
	[
		['Agent UUID', shortAddr(agent.id)],
		['Agent Wallet', shortAddr(agent.wallet)],
		['Owner', shortAddr(agent.owner)],
		['Authority', shortAddr(agent.authority)],
	].forEach(([k, v]) => {
		onchain.appendChild(
			el('div', { class: 'ad-row ad-row-split' }, [
				el('span', { class: 'ad-muted', text: k }),
				el('span', { class: 'ad-mono', text: v }),
			]),
		);
	});

	$('ad-active').textContent = agent.active ? 'true' : 'false';
	$('ad-x402').textContent = agent.x402 ? 'Yes' : 'No';

	const supportedTrust = $('ad-supported-trust');
	supportedTrust.innerHTML = '';
	(agent.trust || []).forEach((t) =>
		supportedTrust.appendChild(pill(t, TRUST_ACCENT[t.toLowerCase()] || '')),
	);

	const protos = $('ad-protocols');
	protos.innerHTML = '';
	(agent.protocols || []).forEach((p) => protos.appendChild(pill(p)));

	if (agent.explorerUrl && agent.explorerUrl !== '#') $('ad-explorer').href = agent.explorerUrl;
	else $('ad-explorer').style.display = 'none';
	if (agent.tradeUrl && agent.tradeUrl !== '#') $('ad-trade').href = agent.tradeUrl;
	else $('ad-trade').style.display = 'none';

	const attachedSns = agent.rawMetadata?.meta?.sns_domain;
	const solAddress = agent.rawMetadata?.meta?.solana_address;
	if (attachedSns) {
		document.getElementById('ad-sns-row').style.display = '';
		document.getElementById('ad-sns').textContent = `${attachedSns}.sol`;
	} else if (solAddress) {
		// Lazy reverse-lookup of the wallet's on-chain favorite. Fire-and-forget;
		// 404s and timeouts just leave the row hidden — non-essential UX.
		fetch(`/api/sns?address=${encodeURIComponent(solAddress)}`)
			.then((r) => (r.ok ? r.json() : null))
			.then((body) => {
				const name = body?.data?.name;
				if (!name) return;
				const row = document.getElementById('ad-sns-row');
				const span = document.getElementById('ad-sns');
				if (!row || !span) return;
				row.style.display = '';
				span.textContent = name;
				span.title = 'On-chain favorite domain';
			})
			.catch(() => {});
	}

	const voiceProvider = agent.rawMetadata?.voice_provider;
	const voiceId = agent.rawMetadata?.voice_id;
	if (voiceProvider && voiceProvider !== 'browser') {
		document.getElementById('ad-voice-row').style.display = '';
		document.getElementById('ad-voice').innerHTML =
			`<span class="ad-pill ad-pill-green">cloned · ${escapeText(voiceProvider)}</span>`;
	} else if (voiceProvider === 'browser') {
		document.getElementById('ad-voice-row').style.display = '';
		document.getElementById('ad-voice').textContent = 'browser TTS';
	}

	document.querySelector('.ad-main').classList.remove('loading');
	bindWalletActions(agent);
	mountOwnerBar(agent);
	wireShareButton(agent);

	loadExtraSections(agent.id, agent.rawMetadata, agent.isOwner);

	// Layer the marketplace discovery + commerce features (3D avatar, live chat
	// preview, creator profile, skill pricing, sale panel, embed, similar,
	// versions) onto the canonical page. No-ops if the agent isn't published to
	// the marketplace, so the base page is never blocked.
	enrichAgentDetail(agent)
		.then(() => {
			// Embed view (from the view switcher): reveal and highlight the embed
			// snippets once enrichment has populated them.
			if (new URLSearchParams(location.search).get('view') === 'embed') focusEmbedSection();
		})
		.catch((e) => log.warn('[agent-detail] enrich failed:', e?.message));
}

// Scroll to the embed snippets and flash them — used by the ?view=embed
// deep-link so the switcher's "Embed" view lands on something concrete.
function focusEmbedSection() {
	const card = document.getElementById('ad-embed-card');
	if (!card || card.hidden) return;
	card.scrollIntoView({ behavior: 'smooth', block: 'center' });
	card.classList.add('ad-embed-flash');
	setTimeout(() => card.classList.remove('ad-embed-flash'), 1600);
}

async function loadExtraSections(agentId, rec, isOwner) {
	const url = (p) => `/api/agents/${encodeURIComponent(agentId)}${p}`;

	const safe = async (fn) => {
		try {
			return await fn();
		} catch (e) {
			return null;
		}
	};

	// Actions, memory and strategy are owner-only on the server (401/403 for
	// anyone else). Only request them when the viewer owns the agent, so public
	// visitors don't generate failed requests that pollute the console.
	const ownerOnly = (fn) => (isOwner ? safe(fn) : Promise.resolve(null));

	const [actions, memory, strategy, reputation, embedPolicy] = await Promise.all([
		ownerOnly(() => fetchJson(url('/actions?limit=8'))),
		ownerOnly(() =>
			fetch(`/api/agent-memory?agentId=${encodeURIComponent(agentId)}&limit=6`, {
				credentials: 'include',
			}).then((r) => (r.ok ? r.json() : null)),
		),
		ownerOnly(() =>
			fetch(`/api/agent-strategy?id=${encodeURIComponent(agentId)}`, {
				credentials: 'include',
			}).then((r) => (r.ok ? r.json() : null)),
		),
		safe(() => fetchJson(url('/reputation'))),
		safe(() =>
			fetch(url('/embed-policy'), { credentials: 'include' }).then((r) =>
				r.ok ? r.json() : null,
			),
		),
	]);

	if (actions?.actions?.length) renderActions(actions.actions, agentId);
	else if (isOwner)
		renderOwnerEmptyCard('ad-actions-card', 'ad-actions-list', {
			icon: '⚡',
			title: 'No signed actions yet',
			body: 'Every trade, launch, and skill invocation this agent makes is logged here with a verifiable signature. Turn on capabilities in the studio to get it working.',
			ctaHref: `/agent-studio?id=${encodeURIComponent(agentId)}#skills`,
			ctaText: 'Open agent studio →',
		});
	if (memory?.entries?.length) renderMemory(memory.entries);
	else if (isOwner)
		renderOwnerEmptyCard('ad-memory-card', 'ad-memory-list', {
			icon: '🧠',
			title: 'No memories yet',
			body: 'This agent builds long-term memory as it works and converses. Seed what it remembers from the memory studio.',
			ctaHref: `/agent-studio?id=${encodeURIComponent(agentId)}#memory`,
			ctaText: 'Open memory studio →',
		});
	if (strategy?.data?.strategy != null) renderStrategy(strategy.data.strategy);
	else if (isOwner)
		renderOwnerEmptyCard('ad-strategy-card', 'ad-strategy', {
			icon: '🎯',
			title: 'No strategy set',
			body: 'Define how this agent trades, allocates, and acts on its own. A strategy turns the wallet above into an autonomous operator.',
			ctaHref: `/agent-studio?id=${encodeURIComponent(agentId)}#brain`,
			ctaText: 'Set a strategy →',
		});
	if (reputation && (reputation.count > 0 || reputation.average > 0))
		renderReputation(reputation);
	if (embedPolicy) renderEmbedPolicy(embedPolicy);

	loadReviews(agentId, rec);
	loadPlatformBar();
}

// ── Reviews ──────────────────────────────────────────────────────────────────

function starsHtml(rating, size = 'sm') {
	const full = Math.floor(rating);
	const half = rating - full >= 0.5;
	let html = '';
	for (let i = 1; i <= 5; i++) {
		if (i <= full) html += `<span class="ad-star filled" aria-hidden="true">★</span>`;
		else if (i === full + 1 && half)
			html += `<span class="ad-star half" aria-hidden="true">★</span>`;
		else html += `<span class="ad-star" aria-hidden="true">★</span>`;
	}
	return html;
}

function reviewAvatarEl(author) {
	const initial = (author?.author_name || '?')[0].toUpperCase();
	if (author?.author_avatar) {
		const img = el('img', {
			class: 'ad-review-avatar',
			src: author.author_avatar,
			alt: author.author_name || 'Reviewer',
		});
		img.onerror = () => {
			const span = el('div', { class: 'ad-review-avatar', text: initial });
			img.replaceWith(span);
		};
		return img;
	}
	return el('div', { class: 'ad-review-avatar', text: initial });
}

// Single-use CSRF token for review writes. Delegates to the shared client so we
// inherit the correct response shape ({ data: { token } }) — a local copy here
// previously read d.token and always got undefined, sending writes without the
// header and tripping a server 403 for signed-in users.
async function getCsrfToken() {
	try {
		return await consumeCsrfToken();
	} catch {
		return null;
	}
}

async function loadReviews(agentId, agentRec) {
	const card = document.getElementById('ad-reviews-card');
	const body = document.getElementById('ad-reviews-body');
	const countPill = document.getElementById('ad-reviews-count');
	if (!card || !body) return;

	const isOwner = !!agentRec?.user_id;

	body.innerHTML = skeletonHTML(2, 'text');

	let data;
	try {
		const r = await fetch(`/api/marketplace/agents/${encodeURIComponent(agentId)}/reviews`, {
			credentials: 'include',
		});
		if (!r.ok) throw new Error(`${r.status}`);
		const json = await r.json();
		data = json.data;
	} catch (e) {
		renderAsyncError(
			body,
			e,
			{ error: { title: 'Couldn’t load reviews', body: 'Check your connection and try again.' }, context: 'agent-detail:reviews' },
			() => loadReviews(agentId, agentRec),
		);
		return;
	}

	const { summary, reviews, my_review } = data;

	if (countPill) {
		countPill.textContent = summary.rating_count > 0 ? String(summary.rating_count) : '';
	}

	body.innerHTML = '';

	// Summary bar
	if (summary.rating_count > 0) {
		const total = summary.rating_count || 1;
		const avgDisplay = Number(summary.rating_avg).toFixed(1);
		const summaryEl = el('div', { class: 'ad-reviews-summary' }, [
			el('div', { class: 'ad-reviews-score' }, [
				el('div', { class: 'ad-reviews-avg', text: avgDisplay }),
				el('div', {
					class: 'ad-reviews-stars',
					'aria-label': `${avgDisplay} out of 5 stars`,
				}),
				el('div', {
					class: 'ad-reviews-total',
					text: `${summary.rating_count} review${summary.rating_count !== 1 ? 's' : ''}`,
				}),
			]),
			el(
				'div',
				{ class: 'ad-reviews-bars' },
				[5, 4, 3, 2, 1].map((star) => {
					const count = summary.breakdown?.[star] || 0;
					const pct = Math.round((count / total) * 100);
					return el('div', { class: 'ad-reviews-bar-row' }, [
						el('span', { class: 'ad-reviews-bar-label', text: String(star) }),
						el('span', { class: 'ad-star filled', 'aria-hidden': 'true', text: '★' }),
						el('div', { class: 'ad-reviews-bar-track' }, [
							el('div', { class: 'ad-reviews-bar-fill', style: `width:${pct}%` }),
						]),
						el('span', { class: 'ad-reviews-bar-count', text: String(count) }),
					]);
				}),
			),
		]);
		summaryEl.querySelector('.ad-reviews-stars').innerHTML = starsHtml(summary.rating_avg);
		body.appendChild(summaryEl);
	}

	// Write / edit form (skip if owner)
	if (!isOwner) {
		body.appendChild(
			buildReviewForm(agentId, my_review, (updated) => loadReviews(agentId, agentRec)),
		);
	}

	// Reviews list
	if (reviews.length === 0 && !my_review) {
		body.appendChild(
			el('div', { class: 'ad-reviews-empty' }, [
				el('strong', { text: 'No reviews yet' }),
				el('span', {
					text: isOwner
						? 'Reviews from users will appear here.'
						: 'Be the first to review this agent.',
				}),
			]),
		);
		return;
	}

	const list = el('div', { class: 'ad-reviews-list' });
	for (const r of reviews) {
		list.appendChild(buildReviewItem(r, agentId, () => loadReviews(agentId, agentRec)));
	}
	body.appendChild(list);
}

/**
 * Show an inline "Anchor on Base?" prompt in the review form actions area.
 * The user can sign the review with MetaMask for an ERC-8004 on-chain record, or skip.
 * Resolves when the user makes a choice (either way).
 */
async function offerErc8004Anchor({ erc8004, rating, reviewId, statusEl, actions }) {
	return new Promise((resolve) => {
		// Replace the save button row with anchor / skip options.
		const prev = Array.from(actions.children);
		prev.forEach((c) => c.remove());

		statusEl.textContent = '';

		const anchorBtn = el('button', {
			class: 'ad-review-submit',
			type: 'button',
			text: 'Anchor on Base',
			style: 'font-size:0.85em',
		});
		const skipLink = el('button', {
			class: 'ad-review-delete',
			type: 'button',
			text: 'Skip',
			style: 'font-size:0.85em',
		});

		const hint = el('span', {
			class: 'ad-review-char-count',
			style: 'color:var(--ad-muted);font-size:0.8em',
			text: 'Immutable on-chain record via MetaMask',
		});

		actions.appendChild(hint);
		actions.appendChild(skipLink);
		actions.appendChild(anchorBtn);

		skipLink.addEventListener('click', () => resolve());

		anchorBtn.addEventListener('click', async () => {
			anchorBtn.disabled = true;
			skipLink.disabled = true;
			anchorBtn.textContent = 'Connecting…';
			statusEl.textContent = '';

			try {
				const [{ BrowserProvider }, { submitFeedback }, { REGISTRY_DEPLOYMENTS }] = await Promise.all([
					import('ethers'),
					import('./erc8004/reputation.js'),
					import('./erc8004/abi.js'),
				]);

				const chainId = erc8004.chain_id ? Number(erc8004.chain_id) : 8453; // default to Base
				const deployment = REGISTRY_DEPLOYMENTS[chainId];
				if (!deployment?.reputationRegistry) {
					statusEl.textContent = 'Registry not deployed on this chain';
					statusEl.style.color = '#ff8a80';
					resolve();
					return;
				}

				// Switch MetaMask to the correct network before requesting signature.
				try {
					await window.ethereum.request({
						method: 'wallet_switchEthereumChain',
						params: [{ chainId: `0x${chainId.toString(16)}` }],
					});
				} catch {
					// Non-fatal — the provider may already be on the right chain.
				}

				anchorBtn.textContent = 'Sign in wallet…';
				const provider = new BrowserProvider(window.ethereum);
				const signer = await provider.getSigner();

				const txHash = await submitFeedback({
					agentId: BigInt(erc8004.agent_id),
					score: rating,
					comment: reviewId ? `threews:review:${reviewId}` : '',
					signer,
					chainId,
				});

				statusEl.innerHTML = `Anchored on-chain — <a href="https://basescan.org/tx/${txHash}" target="_blank" rel="noopener" style="color:var(--ad-violet)">view tx</a>`;
				statusEl.style.color = 'var(--ad-muted)';
			} catch (err) {
				if (err?.code === 4001 || err?.code === 'ACTION_REJECTED') {
					statusEl.textContent = 'Signature declined';
				} else {
					statusEl.textContent = err?.shortMessage || err?.message || 'Anchor failed';
				}
				statusEl.style.color = '#ff8a80';
			}

			resolve();
		});
	});
}

function buildReviewForm(agentId, existing, onSuccess) {
	let selectedRating = existing?.rating || 0;
	let submitting = false;

	const formTitle = el('div', {
		class: 'ad-review-form-title',
		text: existing ? 'Your Review' : 'Write a Review',
	});

	const starPicker = el('div', {
		class: 'ad-review-star-picker',
		role: 'radiogroup',
		'aria-label': 'Rating',
	});
	const starEls = [1, 2, 3, 4, 5].map((n) => {
		const s = el('span', {
			class: `ad-star${n <= selectedRating ? ' filled' : ''}`,
			role: 'radio',
			'aria-label': `${n} star${n !== 1 ? 's' : ''}`,
			'aria-checked': String(n === selectedRating),
			tabindex: '0',
			text: '★',
		});
		s.addEventListener('click', () => setRating(n));
		s.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				setRating(n);
			}
		});
		starPicker.appendChild(s);
		return s;
	});

	function setRating(n) {
		selectedRating = n;
		starEls.forEach((s, i) => {
			s.classList.toggle('filled', i < n);
			s.setAttribute('aria-checked', String(i + 1 === n));
		});
		submitBtn.disabled = false;
	}

	const textarea = el('textarea', {
		class: 'ad-review-textarea',
		placeholder: 'Share your experience with this agent… (optional)',
		maxlength: '2000',
		'aria-label': 'Review text',
	});
	textarea.value = existing?.body || '';

	const charCount = el('span', {
		class: 'ad-review-char-count',
		text: `${textarea.value.length}/2000`,
	});
	textarea.addEventListener('input', () => {
		charCount.textContent = `${textarea.value.length}/2000`;
	});

	const statusEl = el('span', { class: 'ad-review-char-count', style: 'color:var(--ad-muted)' });

	const submitBtn = el('button', {
		class: 'ad-review-submit',
		type: 'button',
		text: existing ? 'Update' : 'Submit',
		disabled: !existing && selectedRating === 0,
	});

	submitBtn.addEventListener('click', async () => {
		if (submitting || selectedRating === 0) return;

		// Guests can't review — prompt sign-in without firing a csrf/POST pair the
		// server would only 401. window.__authed is resolved by the page's inline
		// /api/auth/me probe; unknown (null/undefined) means the probe is still in
		// flight, so let the request go and the POST's own 401 handle it.
		if (window.__authed === false) {
			statusEl.innerHTML =
				'<a href="/login" style="color:var(--ad-violet)">Sign in</a> to leave a review';
			statusEl.style.color = 'var(--ad-muted)';
			return;
		}

		submitting = true;
		submitBtn.disabled = true;
		submitBtn.textContent = 'Saving…';
		statusEl.textContent = '';

		try {
			const csrf = await getCsrfToken();
			const headers = { 'content-type': 'application/json' };
			if (csrf) headers['x-csrf-token'] = csrf;

			const r = await fetch(
				`/api/marketplace/agents/${encodeURIComponent(agentId)}/reviews`,
				{
					method: 'POST',
					credentials: 'include',
					headers,
					body: JSON.stringify({
						rating: selectedRating,
						body: textarea.value.trim() || null,
					}),
				},
			);
			const json = await r.json();
			if (!r.ok) {
				if (r.status === 401) {
					statusEl.innerHTML =
						'<a href="/login" style="color:var(--ad-violet)">Sign in</a> to leave a review';
				} else {
					statusEl.textContent = json.error?.message || 'Save failed';
				}
				statusEl.style.color = r.status === 401 ? 'var(--ad-muted)' : '#ff8a80';
				submitBtn.disabled = false;
				submitBtn.textContent = existing ? 'Update' : 'Submit';
				submitting = false;
				return;
			}

			submitBtn.textContent = 'Saved!';

			// If the agent has an ERC-8004 on-chain identity and the browser has an
			// injected wallet, offer a user-signed anchor on Base for stronger
			// provenance. The platform already anchored on Solana server-side.
			const erc8004 = json.data?.erc8004;
			if (erc8004?.agent_id && typeof window !== 'undefined' && window.ethereum) {
				await offerErc8004Anchor({
					erc8004,
					rating: selectedRating,
					reviewId: json.data.review?.id,
					statusEl,
					actions,
				});
			}

			onSuccess(json.data);
		} catch (e) {
			statusEl.textContent = 'Network error';
			statusEl.style.color = '#ff8a80';
			submitBtn.disabled = false;
			submitBtn.textContent = existing ? 'Update' : 'Submit';
			submitting = false;
		}
	});

	const actions = el('div', { class: 'ad-review-form-actions' });
	if (existing) {
		const deleteBtn = el('button', {
			class: 'ad-review-delete',
			type: 'button',
			text: 'Delete',
		});
		deleteBtn.addEventListener('click', async () => {
			if (submitting) return;
			submitting = true;
			deleteBtn.disabled = true;
			deleteBtn.textContent = 'Deleting…';
			try {
				const csrf = await getCsrfToken();
				const headers = {};
				if (csrf) headers['x-csrf-token'] = csrf;
				await fetch(`/api/marketplace/agents/${encodeURIComponent(agentId)}/reviews`, {
					method: 'DELETE',
					credentials: 'include',
					headers,
				});
				onSuccess(null);
			} catch {
				deleteBtn.disabled = false;
				deleteBtn.textContent = 'Delete';
				submitting = false;
			}
		});
		actions.appendChild(deleteBtn);
	}
	actions.appendChild(submitBtn);

	return el('div', { class: 'ad-review-form' }, [
		formTitle,
		starPicker,
		textarea,
		el('div', { class: 'ad-review-form-footer' }, [
			el('div', { style: 'display:flex;gap:12px;align-items:center' }, [charCount, statusEl]),
			actions,
		]),
	]);
}

function buildReviewItem(r, agentId, onRefresh) {
	const avatar = reviewAvatarEl(r);
	const dateStr = fmtRelTime(r.created_at);

	const starsEl = el('div', {
		class: 'ad-review-item-stars',
		'aria-label': `${r.rating} out of 5 stars`,
	});
	starsEl.innerHTML = starsHtml(r.rating);

	const head = el('div', { class: 'ad-review-item-head' }, [
		avatar,
		el('div', { class: 'ad-review-meta' }, [
			el('div', { class: 'ad-review-author', text: r.author_name || 'Anonymous' }),
			el('div', { class: 'ad-review-date', text: dateStr }),
		]),
		starsEl,
	]);

	const children = [head];

	if (r.body) {
		children.push(el('div', { class: 'ad-review-body', text: r.body }));
	}

	if (r.is_mine) {
		const editBtn = el('button', { class: 'ad-review-mine-btn', type: 'button', text: 'Edit' });
		editBtn.addEventListener('click', () => {
			const form = buildReviewForm(agentId, r, onRefresh);
			item.replaceWith(form);
		});
		const delBtn = el('button', {
			class: 'ad-review-mine-btn danger',
			type: 'button',
			text: 'Delete',
		});
		delBtn.addEventListener('click', async () => {
			delBtn.disabled = true;
			delBtn.textContent = 'Deleting…';
			try {
				const csrf = await getCsrfToken();
				const headers = {};
				if (csrf) headers['x-csrf-token'] = csrf;
				await fetch(`/api/marketplace/agents/${encodeURIComponent(agentId)}/reviews`, {
					method: 'DELETE',
					credentials: 'include',
					headers,
				});
				onRefresh(null);
			} catch {
				delBtn.disabled = false;
				delBtn.textContent = 'Delete';
			}
		});
		children.push(el('div', { class: 'ad-review-mine-actions' }, [editBtn, delBtn]));
	}

	const item = el('div', { class: 'ad-review-item', role: 'article' }, children);
	return item;
}

// HTML-escape untrusted text before interpolating it into an innerHTML string.
// Covers the five significant characters so attacker-controlled values (URL
// params, on-chain metadata, API fields) can't break out into markup.
function escapeText(s) {
	return String(s == null ? '' : s)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function fmtRelTime(iso) {
	const t = new Date(iso).getTime();
	const sec = Math.floor((Date.now() - t) / 1000);
	if (sec < 60) return `${sec}s ago`;
	if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
	if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
	if (sec < 604800) return `${Math.floor(sec / 86400)}d ago`;
	return new Date(iso).toLocaleDateString();
}

function actionIcon(type) {
	return (
		{
			speak: '💬',
			remember: '📝',
			sign: '✍️',
			'skill-done': '✓',
			validate: '✔',
			'load-end': '📦',
		}[type] || '•'
	);
}

function summarizeActionPayload(p) {
	if (typeof p !== 'object' || !p) return '';
	if (p.text) return String(p.text).slice(0, 90);
	if (p.content) return String(p.content).slice(0, 90);
	const k = Object.keys(p)[0];
	if (k == null) return '';
	const v = p[k];
	return typeof v === 'string' ? `${k}=${v.slice(0, 60)}` : `${k}=${typeof v}`;
}

// Designed empty state for owner-only cards (actions / memory / strategy) when a
// fresh agent has no data yet. Public visitors never see these cards; the owner
// gets a clear next step instead of a blank or hidden panel.
function renderOwnerEmptyCard(cardId, bodyId, { icon, title, body, ctaHref, ctaText }) {
	const card = document.getElementById(cardId);
	const target = document.getElementById(bodyId);
	if (!card || !target) return;
	target.style.display = 'none';
	const empty = el(
		'div',
		{
			class: 'ad-owner-empty',
			style:
				'display:flex;flex-direction:column;align-items:center;text-align:center;gap:8px;padding:22px 16px;color:var(--ad-muted,#8a8f98)',
		},
		[
			el('div', { style: 'font-size:26px;line-height:1', text: icon }),
			el('div', { style: 'color:#eaeaea;font-size:14px;font-weight:600', text: title }),
			el('div', { style: 'font-size:12.5px;line-height:1.5;max-width:42ch', text: body }),
			el('a', {
				class: 'ad-cta',
				style: 'margin-top:4px',
				href: ctaHref,
				text: ctaText,
			}),
		],
	);
	card.appendChild(empty);
	card.style.display = '';
}

function renderActions(actions, agentId) {
	const card = document.getElementById('ad-actions-card');
	const list = document.getElementById('ad-actions-list');
	document.getElementById('ad-actions-count').textContent = `${actions.length} recent`;
	list.innerHTML = '';
	for (const a of actions) {
		const verifyMark =
			a.verified === true
				? '<span class="ad-pill ad-pill-green" title="signature verified">✓</span>'
				: a.verified === false
					? '<span class="ad-pill" title="invalid signature">✗</span>'
					: '';
		const meta = el('span', {
			class: 'ad-muted',
			style: 'font-size:11px;display:flex;align-items:center;gap:6px',
		});
		if (verifyMark) {
			const m = document.createElement('span');
			m.innerHTML = verifyMark;
			meta.appendChild(m);
		}
		meta.appendChild(el('span', { text: fmtRelTime(a.timestamp) }));
		const row = el(
			'div',
			{
				class: 'ad-row ad-row-split',
				style: 'padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.04)',
			},
			[
				el('span', { style: 'display:flex;align-items:center;gap:8px;min-width:0' }, [
					el('span', { text: actionIcon(a.type) }),
					el('span', {
						class: 'ad-mono',
						style: 'min-width:90px;flex-shrink:0',
						text: a.type,
					}),
					el('span', {
						class: 'ad-muted',
						style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap',
						text: summarizeActionPayload(a.payload),
					}),
				]),
				meta,
			],
		);
		list.appendChild(row);
	}
	list.appendChild(
		el('div', { style: 'text-align:center;padding-top:10px' }, [
			el('a', {
				class: 'ad-cta',
				href: `/dashboard/account?agent=${encodeURIComponent(agentId)}`,
				text: 'See full action log →',
			}),
		]),
	);
	card.style.display = '';
}

function renderMemory(entries) {
	const card = document.getElementById('ad-memory-card');
	document.getElementById('ad-memory-count').textContent = `${entries.length}`;
	const list = document.getElementById('ad-memory-list');
	list.innerHTML = '';
	for (const m of entries) {
		const row = el(
			'div',
			{ style: 'padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.04)' },
			[
				el('div', {
					class: 'ad-muted',
					style: 'font-size:11px;text-transform:uppercase;letter-spacing:.05em;margin-bottom:2px',
					text: m.type || 'memory',
				}),
				el('div', {
					style: 'color:#ddd;font-size:13px;white-space:pre-wrap',
					text: String(m.content || '').slice(0, 240),
				}),
			],
		);
		list.appendChild(row);
	}
	card.style.display = '';
}

function renderStrategy(strategy) {
	const card = document.getElementById('ad-strategy-card');
	const pre = document.getElementById('ad-strategy');
	pre.textContent = typeof strategy === 'string' ? strategy : JSON.stringify(strategy, null, 2);
	card.style.display = '';
}

// Count a numeric headline field up from 0, preserving the source's decimal places.
// Non-numeric values (commas, suffixes) fall back to a plain, un-animated label.
function countUpField(el, value) {
	if (!el) return;
	const raw = String(value ?? 0);
	const n = Number(raw);
	if (!Number.isFinite(n)) { el.textContent = raw; return; }
	const dp = raw.includes('.') ? (raw.split('.')[1] || '').length : 0;
	countUp(el, 0, n, { format: (x) => x.toFixed(dp) });
}

function renderReputation(r) {
	const card = document.getElementById('ad-reputation-card');
	const avg = r.average ? Number(r.average) : 0;
	const avgEl = document.getElementById('ad-rep-avg');
	if (avgEl) updateValue(avgEl, avg, (n) => n.toFixed(2));
	// Score ring — the 0–5 average as a real fill (avg/5 → %).
	const repRing = document.getElementById('ad-rep-ring');
	if (repRing) {
		repRing.innerHTML = ring((avg / 5) * 100, { size: 30, stroke: 3, label: '' });
		playRings(repRing);
	}
	const countEl = document.getElementById('ad-rep-count');
	if (countEl) updateValue(countEl, Number(r.count || 0), (n) => String(Math.round(n)));
	if (r.total_stake_wei && r.total_stake_wei !== '0' && /^\d+$/.test(r.total_stake_wei)) {
		document.getElementById('ad-rep-stake-row').style.display = '';
		const wei = BigInt(r.total_stake_wei);
		const eth = Number(wei) / 1e18;
		document.getElementById('ad-rep-stake').textContent = `${eth.toFixed(4)} ETH`;
	}
	card.style.display = '';
}

const TIER_EMOJI_MAP = { prime: '🟣', strong: '🔵', lean: '🟡', watch: '⚪', avoid: '🔴' };

// Reasoning Ledger summary — the auditable track-record card. Best-effort:
// hidden unless the agent has logged at least one decision. Verification runs in
// the background and upgrades the badge in place.
async function renderReasoningLedger(agentId) {
	const card = document.getElementById('ad-ledger-card');
	if (!card || !agentId) return;
	let data;
	try {
		const r = await fetch(`/api/ledger/${encodeURIComponent(agentId)}?limit=1`);
		if (!r.ok) return;
		data = await r.json();
	} catch { return; }

	const rep = data.reputation;
	if (!rep || !rep.decisions_total) return; // nothing logged yet — keep hidden

	card.style.display = '';
	const link = document.getElementById('ad-ledger-link');
	if (link) link.href = `/ledger/${encodeURIComponent(agentId)}`;
	const scoreEl = document.getElementById('ad-ledger-score');
	if (scoreEl) scoreEl.textContent = String(rep.score);
	const hitEl = document.getElementById('ad-ledger-hitrate');
	if (hitEl) hitEl.textContent = rep.sample_size ? `${(rep.hit_rate * 100).toFixed(0)}% (${rep.wins}W/${rep.losses}L)` : 'pending';
	const sampleEl = document.getElementById('ad-ledger-sample');
	if (sampleEl) sampleEl.textContent = `${rep.sample_size} of ${rep.decisions_total}`;

	const badge = document.getElementById('ad-ledger-verify');
	if (!badge) return;
	try {
		const vr = await fetch(`/api/ledger/verify/${encodeURIComponent(agentId)}`);
		const v = await vr.json();
		if (v.status === 'verified') { badge.textContent = '✓ verified on-chain'; badge.className = 'ad-pill ad-pill-green'; }
		else if (v.status === 'verified_unanchored') { badge.textContent = 'chain intact'; badge.className = 'ad-pill ad-pill-amber'; }
		else if (v.status === 'verification_failed') { badge.textContent = '⚠ tamper detected'; badge.className = 'ad-pill ad-pill-red'; }
		else { badge.textContent = 'no anchor'; badge.className = 'ad-pill ad-pill-muted'; }
	} catch {
		badge.textContent = 'unverified';
		badge.className = 'ad-pill ad-pill-muted';
	}
}

async function renderOracleTrackRecord(agentId) {
	const card = document.getElementById('ad-trading-card');
	if (!card || !agentId) return;
	let data;
	try {
		const r = await fetch(`/api/oracle/agent-stats?agent_id=${encodeURIComponent(agentId)}&limit=8`);
		if (!r.ok) return;
		data = await r.json();
	} catch { return; }

	const s = data.summary;
	if (!s || s.total === 0) return; // agent has no oracle actions — keep card hidden

	card.style.display = '';

	const allSim = (data.recent_actions || []).every((a) => a.mode === 'simulate');
	const modePill = document.getElementById('ad-trade-mode-pill');
	if (modePill && allSim) modePill.hidden = false;

	const winRateEl = document.getElementById('ad-trade-winrate');
	if (winRateEl) {
		if (s.win_rate != null) updateValue(winRateEl, Number(s.win_rate), (n) => `${Math.round(n)}%`);
		else winRateEl.textContent = '—';
	}
	// Win-rate ring — a real gauge driven by the same win_rate the row shows.
	const winRing = document.getElementById('ad-trade-winring');
	if (winRing) {
		if (s.win_rate != null) {
			winRing.innerHTML = ring(Number(s.win_rate), { size: 26, stroke: 3, label: '' });
			playRings(winRing);
		} else winRing.innerHTML = '';
	}

	const wlEl = document.getElementById('ad-trade-wl');
	if (wlEl) wlEl.textContent = `${s.wins}W / ${s.losses}L / ${s.open} open`;

	const pnlEl = document.getElementById('ad-trade-pnl');
	if (pnlEl) {
		const pnl = s.realized_pnl_sol;
		if (pnl != null) updateValue(pnlEl, Number(pnl), (n) => `${n >= 0 ? '+' : ''}${Number(n).toFixed(4)} SOL`);
		else pnlEl.textContent = '—';
		pnlEl.className = pnl > 0 ? 'ad-trade-pnl positive' : pnl < 0 ? 'ad-trade-pnl negative' : '';
	}

	const roiEl = document.getElementById('ad-trade-roi');
	if (roiEl) {
		if (s.roi_pct != null) updateValue(roiEl, Number(s.roi_pct), (n) => `${n >= 0 ? '+' : ''}${Math.round(n)}%`);
		else roiEl.textContent = '—';
	}

	// Cumulative realized-P&L sparkline from the real recent-trade series (oldest→newest).
	const sparkEl = document.getElementById('ad-trade-spark');
	if (sparkEl) {
		const closed = (data.recent_actions || [])
			.filter((a) => a.realized_pnl_sol != null)
			.slice()
			.reverse();
		if (closed.length >= 2) {
			let cum = 0;
			const series = closed.map((a) => (cum += Number(a.realized_pnl_sol)));
			const net = series[series.length - 1];
			sparkEl.hidden = false;
			sparkEl.innerHTML = `<div class="ad-trade-spark-head"><span>CUMULATIVE PnL</span>`
				+ `<span class="ad-trade-spark-net ${net >= 0 ? 'positive' : 'negative'}">${net >= 0 ? '+' : ''}${net.toFixed(3)} SOL</span></div>`
				+ sparkline(series, { width: 240, height: 38, fill: true, animate: true });
		} else {
			sparkEl.hidden = true;
			sparkEl.innerHTML = '';
		}
	}

	const histEl = document.getElementById('ad-trade-history');
	if (histEl) {
		histEl.innerHTML = '';
		for (const a of (data.recent_actions || [])) {
			const outcome = a.outcome || 'open';
			const tierE = TIER_EMOJI_MAP[a.tier] || '';
			const peak = a.peak_multiple != null ? `${Number(a.peak_multiple).toFixed(1)}×` : '';
			const pnlVal = a.realized_pnl_sol;
			const pnlText = pnlVal != null
				? `${pnlVal >= 0 ? '+' : ''}${Number(pnlVal).toFixed(3)} SOL`
				: '';
			const row = document.createElement('a');
			row.className = 'ad-trade-row';
			row.href = a.oracle_url || `https://three.ws/oracle/coin/${a.mint}`;
			row.target = '_blank';
			row.rel = 'noopener noreferrer';
			row.innerHTML = `<span class="ad-trade-outcome ${outcome}"></span><span class="ad-trade-symbol">$${escapeText((a.symbol || '?').toUpperCase())}</span><span class="ad-trade-tier">${tierE} ${escapeText(a.tier || '')}</span><span class="ad-trade-peak">${peak}</span><span class="ad-trade-pnl ${pnlVal != null && pnlVal >= 0 ? 'positive' : pnlVal != null ? 'negative' : ''}">${pnlText}</span>`;
			histEl.appendChild(row);
		}
		enterStagger(histEl.children);
	}

	const copyLink = document.getElementById('ad-trade-copy-link');
	if (copyLink && s.wins > 0) {
		copyLink.href = `/trader/${encodeURIComponent(agentId)}`;
		copyLink.hidden = false;
	}
}

function renderEmbedPolicy(p) {
	if (!p || typeof p !== 'object') return;
	const card = document.getElementById('ad-embed-policy-card');
	const host = document.getElementById('ad-embed-policy');
	host.innerHTML = '';

	const allowEmbed = p.allow_embed === false ? 'No' : 'Yes';
	const allowedOrigins = Array.isArray(p.allowed_origins) ? p.allowed_origins : [];
	const monthlyQuota = p?.brain?.monthly_quota;

	// Respect the owner's embed policy: if embedding is turned off, hide the
	// snippet card (and keep enrichment from re-revealing it).
	const embedCard = document.getElementById('ad-embed-card');
	if (embedCard && p.allow_embed === false) {
		embedCard.dataset.embedDisabled = '1';
		embedCard.hidden = true;
	}

	host.appendChild(
		el('div', { class: 'ad-row ad-row-split' }, [
			el('span', { class: 'ad-muted', text: 'Embeddable' }),
			el('span', { text: allowEmbed }),
		]),
	);
	if (allowedOrigins.length) {
		host.appendChild(
			el('div', { class: 'ad-row ad-row-split' }, [
				el('span', { class: 'ad-muted', text: 'Allowed origins' }),
				el('span', {
					class: 'ad-mono',
					style: 'font-size:11px;text-align:right',
					text:
						allowedOrigins.slice(0, 3).join(', ') +
						(allowedOrigins.length > 3 ? ` +${allowedOrigins.length - 3}` : ''),
				}),
			]),
		);
	} else if (allowEmbed === 'Yes') {
		host.appendChild(
			el('div', { class: 'ad-row ad-row-split' }, [
				el('span', { class: 'ad-muted', text: 'Allowed origins' }),
				el('span', { text: 'any' }),
			]),
		);
	}
	if (monthlyQuota != null) {
		host.appendChild(
			el('div', { class: 'ad-row ad-row-split' }, [
				el('span', { class: 'ad-muted', text: 'Monthly LLM quota' }),
				el('span', { text: String(monthlyQuota) }),
			]),
		);
	}
	card.style.display = '';
}

function wireShareButton(agent) {
	const origin   = location.origin;
	const shareUrl = `${origin}/agent/${agent.id}/share`;
	const remixUrl = `${origin}/create`;
	const shareData = {
		kind: 'agent',
		id: agent.id,
		title: agent.name || 'Agent',
		description: agent.description || '',
		shareUrl,
		remixUrl,
		previewImage: `${origin}/api/og/agent?id=${encodeURIComponent(agent.id)}`,
	};

	// Hero float button (above the fold)
	const floatBtn = document.getElementById('ad-hero-share-float');
	if (floatBtn && !floatBtn._wired) {
		floatBtn._wired = true;
		floatBtn.addEventListener('click', () => showSharePanel(shareData, floatBtn));
	}

	const btn = document.getElementById('ad-share-btn');
	if (!btn) return;

	btn.style.display = '';
	btn.addEventListener('click', () => showSharePanel(shareData, btn));
}

// ── Owner action bar (hero) + inline deploy slot (BLOCKCHAIN DETAILS) ────────

function mountOwnerBar(agent) {
	const bar = document.getElementById('ad-owner-bar');
	if (!bar) return;

	// Always reset so re-renders are idempotent.
	bar.innerHTML = '';
	bar.hidden = !agent.isOwner;
	if (!agent.isOwner) return;

	// Edit Agent
	const editLink = el('a', {
		class: 'ad-btn',
		href: `/agent-edit?id=${encodeURIComponent(agent.id)}`,
	});
	editLink.textContent = '✏ Edit Agent';
	bar.appendChild(editLink);

	// Dashboard link
	const dashLink = el('a', {
		class: 'ad-btn',
		href: '/dashboard-next/agents',
	});
	dashLink.textContent = 'Manage Agents';
	bar.appendChild(dashLink);

	// Deploy on-chain (only if not yet deployed)
	const alreadyDeployed = !!(
		(agent.rawMetadata?.onchain || agent.onchain)?.txHash
	);
	if (!alreadyDeployed) {
		const deployBtn = el('button', {
			class: 'ad-btn ad-btn-deploy',
			type: 'button',
		});
		deployBtn.textContent = '⬡ Deploy on-chain';
		deployBtn.addEventListener('click', () => openDeployModalFromDetail(agent));
		bar.appendChild(deployBtn);
	}

	// Mount inline OnchainDeployButton in BLOCKCHAIN DETAILS section.
	// This shows the success chip when deployed, or the full chain-select +
	// deploy button for owners who haven't deployed yet.
	mountDeploySlot(agent);
}

async function mountDeploySlot(agent) {
	const slot = document.getElementById('ad-deploy-slot');
	if (!slot) return;
	slot.innerHTML = '';
	if (!agent.isOwner) return;

	try {
		const [{ OnchainDeployButton }, ] = await Promise.all([
			import('./onchain/deploy-button.js'),
			import('./erc8004/deploy-button.css'),
		]);
		const deployAgentObj = {
			id: agent.id,
			name: agent.name || '',
			description: agent.description || '',
			avatar_id: agent.avatar_id || null,
			skills: Array.isArray(agent.skills) && agent.skills.length ? agent.skills : undefined,
			onchain: agent.onchain || agent.rawMetadata?.onchain || null,
		};
		const btn = new OnchainDeployButton({ agent: deployAgentObj, container: slot });
		btn.mount();

		// When deploy succeeds, hide the "Deploy on-chain" button in the owner bar
		// (the success chip in the slot replaces the call-to-action).
		const observer = new MutationObserver(() => {
			if (deployAgentObj.onchain?.txHash && slot.querySelector('.deploy-chip--success')) {
				observer.disconnect();
				const heroDeployBtn = document.querySelector('#ad-owner-bar .ad-btn-deploy');
				if (heroDeployBtn) heroDeployBtn.remove();
				// Refresh the status badge to show the on-chain badge.
				import('./shared/onchain-badge.js').then(({ onchainBadgeEl }) => {
					document.getElementById('ad-onchain-badge')?.remove();
					const badge = onchainBadgeEl({ onchain: deployAgentObj.onchain }, { size: 'md' });
					if (badge) {
						badge.id = 'ad-onchain-badge';
						document.getElementById('ad-status')?.insertAdjacentElement('afterend', badge);
					}
				}).catch(() => {});
			}
		});
		observer.observe(slot, { childList: true, subtree: true });
	} catch (err) {
		log.warn('[agent-detail] deploy slot failed:', err?.message);
	}
}

async function openDeployModalFromDetail(agent) {
	try {
		const [{ OnchainDeployButton }] = await Promise.all([
			import('./onchain/deploy-button.js'),
			import('./erc8004/deploy-button.css'),
		]);

		const overlay = document.createElement('div');
		overlay.style.cssText = `
			position:fixed;inset:0;z-index:1000;
			background:rgba(8,9,14,0.72);backdrop-filter:blur(6px);
			display:grid;place-items:center;padding:20px;
		`;
		overlay.innerHTML = `
			<div role="dialog" aria-modal="true" aria-label="Deploy agent on-chain" style="
				width:min(460px,100%);
				background:linear-gradient(180deg,rgba(22,24,32,0.97),rgba(16,17,24,0.97));
				border:1px solid rgba(255,255,255,0.1);border-radius:14px;padding:24px;
				box-shadow:0 20px 60px rgba(0,0,0,0.6);
			">
				<div style="font-size:17px;font-weight:600;margin-bottom:6px;color:#e7e9ee">Deploy on-chain</div>
				<div style="font-size:12.5px;color:rgba(231,233,238,0.5);margin-bottom:18px">
					Register <strong style="color:#e7e9ee">${escapeText(agent.name || 'this agent')}</strong> on-chain.
					Pick a chain, sign one transaction — the asset becomes the agent's permanent on-chain identity.
				</div>
				<div data-slot="deploy-host" style="display:flex;justify-content:center;margin-bottom:18px"></div>
				<div style="display:flex;gap:8px;justify-content:flex-end">
					<button data-action="cancel" style="
						background:rgba(255,255,255,0.06);color:#e7e9ee;border:1px solid rgba(255,255,255,0.1);
						border-radius:8px;padding:7px 16px;font-size:13px;cursor:pointer;font-family:inherit;
					">Close</button>
				</div>
			</div>
		`;
		document.body.appendChild(overlay);

		const deployHost = overlay.querySelector('[data-slot="deploy-host"]');
		const deployAgentObj = {
			id: agent.id,
			name: agent.name || '',
			description: agent.description || '',
			avatar_id: agent.avatar_id || null,
			skills: Array.isArray(agent.skills) && agent.skills.length ? agent.skills : undefined,
			onchain: agent.onchain || agent.rawMetadata?.onchain || null,
		};
		const deployBtn = new OnchainDeployButton({ agent: deployAgentObj, container: deployHost });
		deployBtn.mount();

		let deployed = false;
		const observer = new MutationObserver(() => {
			if (deployAgentObj.onchain?.txHash && deployHost.querySelector('.deploy-chip--success')) {
				deployed = true;
			}
		});
		observer.observe(deployHost, { childList: true, subtree: true });

		const close = () => {
			observer.disconnect();
			deployBtn.unmount();
			overlay.remove();
			document.removeEventListener('keydown', onKey);
			if (deployed) {
				// Refresh the owner bar so the deploy button disappears and the slot
				// shows the persistent success chip.
				agent.onchain = deployAgentObj.onchain;
				mountOwnerBar(agent);
			}
		};
		function onKey(e) { if (e.key === 'Escape') close(); }
		document.addEventListener('keydown', onKey);
		overlay.querySelector('[data-action="cancel"]').addEventListener('click', close);
		overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
	} catch (err) {
		log.warn('[agent-detail] deploy modal failed:', err?.message);
	}
}

function bindWalletActions(agent) {
	// AGENT HOLDINGS shows the agent's custodial Solana address + balance as
	// read-only info for everyone. Funding, trading, paying, and withdrawing the
	// agent's OWN custodial wallet all live in one place — the Agent Wallet hub
	// (/agent/:id/wallet) — so this card just links there for the owner. The hub
	// owns every wallet action; the detail page no longer re-implements them.
	const actions = document.getElementById('ad-holdings-actions');
	if (!actions) return;

	const isOwner = !!(agent?.isOwner ?? agent?.is_owner);
	// The legacy Receive QR popover lives in the same card; the hub's Deposit tab
	// supersedes it, so keep it hidden whether or not the user owns the agent.
	const qrCodeContainer = document.getElementById('qr-code-container');
	if (qrCodeContainer) qrCodeContainer.classList.add('hidden');

	const agentId = agent?.id;
	if (!isOwner || !agentId) {
		actions.style.display = 'none';
		return;
	}

	// Replace the legacy Receive/Withdraw/Swap buttons with a single entry point
	// into the wallet hub. One wallet surface, reachable from the profile.
	actions.innerHTML = '';
	const manage = document.createElement('a');
	manage.className = 'ad-btn ad-btn-primary';
	manage.href = `/agent/${encodeURIComponent(agentId)}/wallet`;
	manage.textContent = 'Manage wallet';
	manage.setAttribute('aria-label', 'Open this agent’s wallet hub');
	const deposit = document.createElement('a');
	deposit.className = 'ad-btn';
	deposit.href = `/agent/${encodeURIComponent(agentId)}/wallet#deposit`;
	deposit.textContent = 'Deposit';
	// Opt-in vanity: grind a custom address for this agent's custodial wallet.
	const meta = agent?.rawMetadata?.meta || {};
	const isVanity = !!(meta.solana_vanity_prefix || meta.solana_vanity_suffix);
	const vanity = document.createElement('a');
	vanity.className = 'ad-btn';
	vanity.href = `/agent/${encodeURIComponent(agentId)}/wallet#vanity`;
	vanity.textContent = isVanity ? '✦ Vanity address' : '✦ Make it vanity';
	vanity.setAttribute('aria-label', 'Grind a custom vanity address for this agent wallet');
	actions.append(manage, deposit, vanity);
}

function renderNotFound(id, reason) {
	document.title = 'Agent not found — three.ws';
	const main = document.querySelector('.ad-main');
	main.innerHTML = `
		<div style="padding:60px 24px;text-align:center;">
			<h1 style="margin:0 0 8px;font-size:22px;font-weight:600;">Agent not found</h1>
			<p style="color:rgba(231,233,238,0.55);font-size:14px;margin:0 0 22px;">
				${escapeText(reason || 'No agent registered with id')} <code style="font-family:ui-monospace,monospace;color:#e7e9ee;">${escapeText(id || '(none)')}</code>.
			</p>
			<a class="ad-cta" style="display:inline-block;padding:10px 22px;" href="/agents">← Back to Registry</a>
		</div>
	`;
}

/**
 * Transient load failure (offline, 5xx) — distinct from a genuine 404. Shows the
 * shared retryable error shell so a network blip never leaves a blank page.
 */
function renderLoadError(err) {
	document.title = 'Couldn’t load agent — three.ws';
	const main = document.querySelector('.ad-main');
	if (!main) return;
	main.innerHTML = '<div class="ad-load-error"></div>';
	renderAsyncError(
		main.querySelector('.ad-load-error'),
		err,
		{
			error: {
				title: 'Couldn’t load this agent',
				body: 'We hit a problem reaching the registry. Check your connection and try again.',
			},
			context: 'agent-detail:load',
		},
		runLoad,
	);
}

document.addEventListener('click', (e) => {
	const btn = e.target.closest('.ad-copy[data-copy-target]');
	if (!btn) return;
	const id = btn.getAttribute('data-copy-target');
	const node = document.getElementById(id);
	const value = node?.dataset?.full || node?.textContent || '';
	if (value && value !== '—') navigator.clipboard?.writeText(value)?.catch(() => {});
});

async function fetchJson(url) {
	const res = await fetch(url, { credentials: 'include' });
	if (!res.ok) {
		const err = new Error(`${url} → HTTP ${res.status}`);
		err.status = res.status;
		throw err;
	}
	return res.json();
}

/**
 * Fetch the primary agent record with one automatic retry on a *transient*
 * failure (offline, 5xx, 429) — a single network blip or cold serverless boot
 * shouldn't dump the visitor onto the full "Couldn't load this agent" screen.
 * A 404 is a definitive answer, never retried; it falls straight through to the
 * not-found / avatar-redirect path.
 */
async function fetchAgentRecord(url) {
	try {
		return await fetchJson(url);
	} catch (e) {
		const transient = e?.status == null || e.status >= 500 || e.status === 429;
		if (!transient) throw e;
		await new Promise((r) => setTimeout(r, 600));
		return fetchJson(url);
	}
}

/**
 * Inflate the /api/agents/:id record into the detail-page shape.
 * `meta.onchain`, `rec.token`, and `rec.payments` are surfaced when present.
 */
export function normalize(rec, avatar) {
	const meta = rec.meta || {};
	const onchain = rec.onchain || meta.onchain || {};

	const trust = [];
	if (rec.payments || rec.is_registered) trust.push('Reputation');
	if (rec.token) trust.push('Crypto-Economic');

	const services = [];
	if (rec.home_url) {
		services.push({
			type: 'web',
			url: new URL(rec.home_url, location.origin).href,
		});
	}
	if (rec.skills?.length) {
		services.push({
			type: 'a2a',
			version: meta.a2a_version || '0.3.0',
			url: `${location.origin}/agent/${rec.id}`,
			skills: rec.skills
				.map((s) => (typeof s === 'string' ? s : s.name || s.id))
				.filter(Boolean),
			domains: meta.domains || undefined,
		});
	}
	if (rec.token?.mint) {
		services.push({
			type: 'token',
			label: rec.token.symbol || rec.token.name,
			url: `https://birdeye.so/token/${rec.token.mint}?chain=solana`,
		});
		services.push({
			type: 'chart',
			url: `https://dexscreener.com/solana/${rec.token.mint}`,
		});
	}

	const protocols = [];
	if (rec.home_url) protocols.push('WEB');
	if (rec.skills?.length) protocols.push(`A2A ${meta.a2a_version || '0.3.0'}`);
	if (rec.token?.symbol) protocols.push(`TOKEN ${rec.token.symbol}`);
	if (onchain?.chain_id || rec.chain_id)
		protocols.push(`CHAIN ${onchain?.chain_id ?? rec.chain_id}`);

	const wallet = rec.wallet_address || onchain.wallet || meta.solana_wallet || '';

	const explorerUrl =
		(rec.token?.mint && `https://solscan.io/token/${rec.token.mint}`) ||
		(wallet && `https://solscan.io/account/${wallet}`) ||
		'#';

	const registries = [];
	if (rec.erc8004_registry) {
		registries.push(`ERC-8004 #${rec.erc8004_agent_id ?? '?'}`);
	}
	if (rec.is_registered) registries.push('three.ws');

	return {
		id: rec.id,
		avatar_id: rec.avatar_id || avatar?.id || null,
		name: rec.name || 'Unnamed agent',
		assetKind: rec.is_registered ? 'Core Asset' : 'Off-chain',
		// "Active" is a liveness signal, NOT an on-chain one. An agent is live as
		// long as it isn't an unpublished draft — off-chain agents are fully usable
		// and must not read as dead. On-chain status is carried separately by the
		// asset-kind label + the on-chain badge. `is_published` is only present in
		// the owner view; public viewers (undefined) always see a live agent.
		active: rec.is_published !== false,
		avatar: avatar?.image_url || avatar?.thumbnail_url || avatar?.preview_url || null,
		description: rec.description || '',
		trust,
		wallet,
		owner: rec.user_id || onchain.owner || '',
		authority: onchain.authority || rec.erc8004_registry || '',
		solBalance: meta.sol_balance ?? 0,
		creatorRewards: meta.creator_rewards ?? 0,
		x402: !!rec.payments?.accepted_tokens?.length,
		registries,
		protocols,
		explorerUrl,
		tradeUrl: rec.token?.mint ? `https://magiceden.io/marketplace/${rec.token.mint}` : '#',
		token: rec.token || null,
		services,
		// The /api/agents/:id endpoint only includes `user_id` in the response when
		// the requester is the owner — see api/agents.js decorate(row, isOwner).
		isOwner: !!rec.user_id,
		// On-chain ERC-8004 identifiers for the validation attestation badge.
		// Owner responses carry chain_id / erc8004_agent_id directly; public
		// responses carry them through the canonical `onchain` block (caip2 chain +
		// onchain_id). Resolved for EVM agents only — Solana token agents have no
		// ValidationRegistry record, so the badge is correctly skipped for them.
		...erc8004Ids(rec, onchain),
		// Preserve the avatar's loadable model URL under the field names
		// agentAvatarGlb() reads. GET /api/agents/:id serves it as
		// `avatar_model_url`; older/on-chain shapes use `avatar_glb_url`. Dropping
		// these here silently fell every such agent back to the mannequin in the
		// hero (e.g. a quadruped whose body lives only in avatar_model_url).
		avatar_glb_url: rec.avatar_glb_url || null,
		avatar_model_url: rec.avatar_model_url || null,
		glbUrl:
			rec.avatar_glb_url ||
			rec.avatar_model_url ||
			onchain?.body_uri ||
			meta.glb_url ||
			null,
		rawMetadata: rec,
	};
}

/** Resolve { chainId, erc8004AgentId } from owner or public on-chain fields (EVM only). */
function erc8004Ids(rec, onchain) {
	const caip2Match = /^eip155:(\d+)$/.exec(String(onchain?.chain || ''));
	const isEvm = onchain
		? onchain.family === 'evm' || !!caip2Match
		: rec.chain_id != null && rec.erc8004_agent_id != null;
	if (!isEvm) return { chainId: null, erc8004AgentId: null };

	const chainId = Number(rec.chain_id ?? onchain?.chain_id ?? caip2Match?.[1]) || null;
	const agentId =
		rec.erc8004_agent_id != null
			? String(rec.erc8004_agent_id)
			: onchain?.onchain_id != null
				? String(onchain.onchain_id)
				: null;
	return { chainId, erc8004AgentId: agentId };
}

// Agents and avatars live in separate tables with separate UUIDs — an agent
// merely references an avatar via avatar_id. So an id that 404s as an agent may
// actually be an avatar shared (or old-linked) as /agents/:id. Probe the avatar
// store; if it resolves, the caller redirects to the avatar page instead of
// showing a dead "not found".
async function resolveAsAvatar(id) {
	try {
		const json = await fetchJson(`/api/avatars/${encodeURIComponent(id)}`);
		return !!(json && json.avatar);
	} catch {
		return false;
	}
}

async function loadAgent(id) {
	if (!id) return { error: 'missing id', agent: null, notFound: true };
	if (!UUID_RE.test(id))
		return { error: 'invalid id (expected UUID)', agent: null, notFound: true };

	let rec;
	try {
		const json = await fetchAgentRecord(`/api/agents/${encodeURIComponent(id)}`);
		rec = json.agent;
	} catch (e) {
		// A 404 is genuinely "no such agent"; anything else (offline, 5xx) is a
		// transient load failure the user should be able to retry.
		const notFound = e.status === 404;
		if (notFound && (await resolveAsAvatar(id))) {
			location.replace(`/avatars/${encodeURIComponent(id)}`);
			return { agent: null, error: null, redirecting: true };
		}
		return {
			error: notFound ? 'No agent with id' : e,
			agent: null,
			notFound,
		};
	}
	if (!rec) {
		if (await resolveAsAvatar(id)) {
			location.replace(`/avatars/${encodeURIComponent(id)}`);
			return { agent: null, error: null, redirecting: true };
		}
		return { error: 'No agent with id', agent: null, notFound: true };
	}

	let avatar = null;
	if (rec.avatar_id) {
		try {
			const json = await fetchJson(`/api/avatars/${encodeURIComponent(rec.avatar_id)}`);
			avatar = json.avatar || null;
		} catch (e) {
			log.warn('[agent-detail] avatar fetch failed:', e.message);
		}
	}

	return { agent: normalize(rec, avatar), error: null };
}


const id =
	new URLSearchParams(location.search).get('id') ||
	location.pathname.match(/\/agents\/([^/]+)/)?.[1];

function runLoad() {
	loadAgent(id)
		.then(({ agent, error, notFound, redirecting }) => {
			if (redirecting) return;
			if (agent) {
				track(ANALYTICS_EVENTS.AGENT_PROFILE_VIEWED, { agent_id: agent.id });
				render(agent);
				renderOracleTrackRecord(agent.id);
				renderReasoningLedger(agent.id);
				return;
			}
			if (notFound) return renderNotFound(id, typeof error === 'string' ? error : '');
			if (error) trackError('agent_detail.load', error, { agent_id: id });
			renderLoadError(error);
		})
		.catch((e) => {
			trackError('agent_detail.load', e, { agent_id: id });
			renderLoadError(e);
		});
}
async function loadPlatformBar() {
	try {
		const r = await fetch('/api/oracle/stats');
		if (!r.ok) return;
		const d = await r.json();
		const fmt = n => n >= 1e3 ? (n/1e3).toFixed(1)+'K' : String(n||0);
		// A zero or dash in a stats strip reads as "the platform is dead" — only
		// show stats with a real value, and only reveal the bar if any survive.
		let shown = 0;
		const set = (id, ok, v) => {
			const e = document.getElementById(id);
			if (!e) return;
			const stat = e.closest('.ad-platform-stat');
			if (ok) { e.textContent = v; shown++; }
			else if (stat) stat.hidden = true;
		};
		set('adp-agents', Number(d.agents_armed) > 0, fmt(d.agents_armed));
		set('adp-winrate', Number(d.win_rate) > 0, d.win_rate + '%');
		set('adp-wins', Number(d.total_wins) > 0, fmt(d.total_wins));
		set('adp-scored', Number(d.scored_24h) > 0, fmt(d.scored_24h));
		const bar = document.getElementById('ad-platform-bar');
		if (bar && shown > 0) bar.hidden = false;
	} catch { /* non-fatal */ }
}

// Only auto-run when the route actually carries an agent id. In the browser the
// /agents/:id (and /agent/:id) route always does; importing this module without
// one (e.g. a unit test of normalize()) is a no-op rather than a stray fetch.
if (id) runLoad();
