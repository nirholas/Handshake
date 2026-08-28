/**
 * Wallet Trading Card — the agent wallet as a living, screenshot-worthy artifact.
 *
 * One self-contained collectible card per agent: its avatar, its glowing vanity
 * "license plate", its real net worth and holdings, its realized P&L, its
 * reputation tier, the $THREE-holder mark, and a tip / fork / share CTA. Rarity
 * "finish" scales with the agent's REAL wealth + reputation tier — matte for a
 * dormant new wallet, holographic shimmer for a luminous, elite one — tasteful,
 * never casino.
 *
 * Everything is real data. The card reads the same public, server-authoritative
 * endpoints every other wallet surface uses:
 *   - GET /api/agents/:id/solana/networth  → portfolio (USD, SOL, $THREE, holdings),
 *     public-safe reputation aggregates (forks, tips, realized P&L), wealth tier.
 *   - GET /api/agents/:id/reputation       → 0–100 score + tier (new…elite).
 * Both are public-safe: the card NEVER shows an owner-only datum (custody specifics,
 * limits, keys). A real balance of $0 shows $0 — never a decorative number.
 *
 * The same card renders to a 1200×630 image server-side in api/og/agent.js, so a
 * shared agent link unfurls with a card that matches what's on the page.
 *
 * Usage:
 *   import { mountWalletCard } from './shared/wallet-card.js';
 *   const handle = mountWalletCard(hostEl, agentRecord, { isOwner, network });
 *   // handle.destroy() to tear down (idempotent).
 */

import { getWalletIdentity } from './agent-wallet-chip.js';
import { formatWalletUsd, shortAddress } from './wallet-format.js';
import { tierForUsd, NETWORTH_TIERS } from './wallet-networth.js';
import { showSharePanel } from './share.js';
import { openTipModal } from './agent-tip-modal.js';

const STYLE_ID = 'tws-wallet-card-styles';
const THREE_MARK = '$THREE';

// Reputation tier → rank (0..4). Mirrors TIERS in agent-financial-reputation.js
// without importing the whole scoring engine into the client card.
const REP_RANK = { new: 0, emerging: 1, established: 2, trusted: 3, elite: 4 };

// Finish ladder (0..5): the visual "rarity" of the card, derived from the higher
// of the wealth tier (0..5) and the reputation rank (0..4, shifted). Each step
// adds a touch more presence: matte → satin → foil → holo → prism.
const FINISHES = [
	{ key: 'matte',  label: 'Common' },
	{ key: 'satin',  label: 'Uncommon' },
	{ key: 'foil',   label: 'Rare' },
	{ key: 'holo',   label: 'Epic' },
	{ key: 'prism',  label: 'Legendary' },
	{ key: 'aurora', label: 'Mythic' },
];

const reducedMotion = () =>
	typeof window !== 'undefined' &&
	window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;

function esc(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) =>
		({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
	);
}

// Bounded: the card renders a loading row for net worth and reputation before
// these resolve, and an edge that never answers used to leave both rows
// shimmering. On timeout the caller's catch paints the designed fallback.
async function fetchJson(url, { timeout = 8000 } = {}) {
	const r = await fetch(url, { credentials: 'include', signal: AbortSignal.timeout(timeout) });
	if (!r.ok) {
		const e = new Error(`http_${r.status}`);
		e.status = r.status;
		throw e;
	}
	return r.json();
}

/**
 * Render the vanity-highlighted address: the matched prefix/suffix get the
 * emphasized accent, the elided middle stays muted. Falls back to a plain short
 * address when the agent has no vanity pattern.
 */
function addressHTML(identity) {
	const addr = identity.address;
	const pre = identity.prefix && addr.startsWith(identity.prefix) ? identity.prefix : '';
	const suf = identity.suffix && addr.endsWith(identity.suffix) ? identity.suffix : '';
	if (!pre && !suf) {
		return `<span class="twc2-addr-mid">${esc(shortAddress(addr, 5, 5))}</span>`;
	}
	const head = pre ? addr.slice(0, Math.max(pre.length, 4)) : addr.slice(0, 4);
	const tail = suf ? addr.slice(-Math.max(suf.length, 4)) : addr.slice(-4);
	const headEmph = pre ? `<b class="twc2-addr-vanity">${esc(head)}</b>` : `<span class="twc2-addr-mid">${esc(head)}</span>`;
	const tailEmph = suf ? `<b class="twc2-addr-vanity">${esc(tail)}</b>` : `<span class="twc2-addr-mid">${esc(tail)}</span>`;
	return `${headEmph}<span class="twc2-addr-dots">…</span>${tailEmph}`;
}

/** Compute the card's finish from real wealth + reputation tiers. */
function finishFor(wealthLevel, repTier) {
	const repRank = REP_RANK[repTier] ?? 0;
	// Reputation rank 0..4 maps onto the 0..5 finish ladder one step higher so an
	// elite agent reads as mythic even on a modest balance; wealth tops out at 5.
	const level = Math.max(Number(wealthLevel) || 0, repRank + 1 > 5 ? 5 : (repTier && repRank > 0 ? repRank + 1 : 0));
	const clamped = Math.max(0, Math.min(5, level));
	return { level: clamped, ...FINISHES[clamped] };
}

function statCell(label, value, opts = {}) {
	const accentCls = opts.accent ? ' twc2-stat--accent' : '';
	const title = opts.title ? ` title="${esc(opts.title)}"` : '';
	return `
		<div class="twc2-stat${accentCls}"${title}>
			<span class="twc2-stat-val">${esc(value)}</span>
			<span class="twc2-stat-label">${esc(label)}</span>
		</div>`;
}

function skeletonHTML() {
	return `
		<div class="twc2-skel" aria-hidden="true">
			<div class="twc2-skel-top">
				<div class="twc2-skel-avatar"></div>
				<div class="twc2-skel-lines">
					<span class="twc2-skel-line w60"></span>
					<span class="twc2-skel-line w40"></span>
				</div>
			</div>
			<div class="twc2-skel-hero"></div>
			<div class="twc2-skel-stats">
				<span></span><span></span><span></span>
			</div>
		</div>`;
}

/**
 * @param {HTMLElement} host    where to mount
 * @param {object} agent        an agent/avatar record (id, name, meta.solana_address, vanity, avatar url)
 * @param {object} [opts]
 * @param {boolean} [opts.isOwner]
 * @param {'mainnet'|'devnet'} [opts.network]
 * @param {() => void} [opts.onFork]  custom fork handler (default: go to the agent profile)
 * @returns {{ destroy: () => void, refresh: () => void } | null}
 */
export function mountWalletCard(host, agent, opts = {}) {
	if (typeof document === 'undefined' || !host) return null;
	const identity = getWalletIdentity(agent);
	const agentId = identity?.agentId || agent?.id || agent?.agent_id || null;
	// No custodial wallet → no card. The caller renders its own empty/pending state.
	if (!identity || !agentId) return null;

	ensureStyles();

	const network = opts.network === 'devnet' ? 'devnet' : 'mainnet';
	const isOwner = !!opts.isOwner;
	const origin = typeof location !== 'undefined' ? location.origin : 'https://three.ws';

	let destroyed = false;
	let tiltRaf = 0;

	const root = document.createElement('div');
	root.className = 'twc2-wrap';
	root.innerHTML = skeletonHTML();
	host.replaceChildren(root);

	function setHTML(html) {
		if (destroyed) return;
		root.innerHTML = html;
	}

	// ── Hover tilt + shine (pointer only, honors reduced-motion) ───────────────
	function wireTilt(cardEl) {
		if (reducedMotion()) return;
		if (!window.matchMedia?.('(hover: hover) and (pointer: fine)')?.matches) return;
		let rect = null;
		const onEnter = () => { rect = cardEl.getBoundingClientRect(); cardEl.classList.add('twc2-card--live'); };
		const onMove = (e) => {
			if (!rect) rect = cardEl.getBoundingClientRect();
			const px = (e.clientX - rect.left) / rect.width;
			const py = (e.clientY - rect.top) / rect.height;
			if (tiltRaf) cancelAnimationFrame(tiltRaf);
			tiltRaf = requestAnimationFrame(() => {
				const rx = (0.5 - py) * 7;
				const ry = (px - 0.5) * 9;
				cardEl.style.setProperty('--twc2-rx', `${rx.toFixed(2)}deg`);
				cardEl.style.setProperty('--twc2-ry', `${ry.toFixed(2)}deg`);
				cardEl.style.setProperty('--twc2-mx', `${(px * 100).toFixed(1)}%`);
				cardEl.style.setProperty('--twc2-my', `${(py * 100).toFixed(1)}%`);
			});
		};
		const onLeave = () => {
			rect = null;
			cardEl.classList.remove('twc2-card--live');
			cardEl.style.removeProperty('--twc2-rx');
			cardEl.style.removeProperty('--twc2-ry');
		};
		cardEl.addEventListener('pointerenter', onEnter);
		cardEl.addEventListener('pointermove', onMove);
		cardEl.addEventListener('pointerleave', onLeave);
	}

	function shareData() {
		return {
			kind: 'agent',
			id: agentId,
			title: identity.name || agent?.name || 'Agent',
			description: `${identity.name || 'This agent'} on three.ws — its avatar, its wallet, its reputation.`,
			shareUrl: `${origin}/agents/${agentId}/share`,
			remixUrl: `${origin}/agents/${agentId}`,
			previewImage: `${origin}/api/og/agent?id=${encodeURIComponent(agentId)}`,
		};
	}

	function doFork() {
		if (typeof opts.onFork === 'function') { opts.onFork(); return; }
		// Prefer the live fork affordance if this card sits on the profile page.
		const actions = document.getElementById('ad-avatar-actions');
		if (actions) {
			actions.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'center' });
			actions.querySelector('button,[role=button]')?.click?.();
			return;
		}
		location.href = `${origin}/agents/${agentId}`;
	}

	function wireActions(cardEl) {
		cardEl.querySelector('[data-twc2-copy]')?.addEventListener('click', async (e) => {
			const btn = e.currentTarget;
			try {
				await navigator.clipboard.writeText(identity.address);
				btn.classList.add('twc2-copied');
				const lbl = btn.querySelector('.twc2-copy-lbl');
				const prev = lbl?.textContent;
				if (lbl) lbl.textContent = 'Copied';
				setTimeout(() => { btn.classList.remove('twc2-copied'); if (lbl) lbl.textContent = prev; }, 1800);
			} catch { /* clipboard blocked — address is still selectable on screen */ }
		});
		cardEl.querySelector('[data-twc2-share]')?.addEventListener('click', (e) => {
			showSharePanel(shareData(), e.currentTarget);
		});
		cardEl.querySelector('[data-twc2-tip]')?.addEventListener('click', () => {
			openTipModal(agent, { network });
		});
		cardEl.querySelector('[data-twc2-fork]')?.addEventListener('click', (e) => {
			e.preventDefault();
			doFork();
		});
	}

	function renderError() {
		// Minimal valid card — identity only, never a broken artifact. Balance reads
		// "—" honestly when the chain/price feed is unavailable.
		const av = identity.avatarUrl
			? `<img class="twc2-avatar" src="${esc(identity.avatarUrl)}" alt="" loading="lazy" />`
			: `<div class="twc2-avatar twc2-avatar--ph">${esc((identity.name || 'A')[0].toUpperCase())}</div>`;
		setHTML(`
			<article class="twc2-card" data-finish="matte" aria-label="${esc(identity.name || 'Agent')} wallet card">
				<div class="twc2-shine" aria-hidden="true"></div>
				<header class="twc2-head">
					${av}
					<div class="twc2-id">
						<h3 class="twc2-name">${esc(identity.name || 'Agent')}</h3>
						<button type="button" class="twc2-addr" data-twc2-copy aria-label="Copy wallet address">
							${addressHTML(identity)}
							<span class="twc2-copy-lbl">Copy</span>
						</button>
					</div>
				</header>
				<div class="twc2-hero">
					<span class="twc2-hero-usd">—</span>
					<span class="twc2-hero-sub">balance unavailable right now</span>
				</div>
				<footer class="twc2-cta">
					<button type="button" class="twc2-btn twc2-btn-ghost" data-twc2-share>Share card</button>
				</footer>
			</article>`);
		const cardEl = root.querySelector('.twc2-card');
		wireActions(cardEl);
		wireTilt(cardEl);
	}

	async function load() {
		let nw = null, rep = null;
		try {
			nw = (await fetchJson(`/api/agents/${agentId}/solana/networth?network=${network}`))?.data || null;
		} catch (err) {
			if (err.status === 404) nw = null; // not provisioned → empty-wallet card below
			else { renderError(); return; }
		}
		// Reputation is enhancement-only: a failed read just omits the tier badge.
		try {
			rep = (await fetchJson(`/api/agents/${agentId}/reputation`))?.data || null;
		} catch { rep = null; }

		render(nw, rep);
	}

	function render(nw, rep) {
		if (destroyed) return;

		const portfolio = nw?.portfolio || { usd: 0, sol: 0, three: null, token_count: 0 };
		const repAgg = nw?.reputation || {};
		const usd = Number(portfolio.usd) || 0;
		const wealthTier = nw?.tier?.key
			? (NETWORTH_TIERS.find((t) => t.key === nw.tier.key) || tierForUsd(usd))
			: tierForUsd(usd);
		const finish = finishFor(wealthTier.level, rep?.tier);

		const hasThree = !!(portfolio.three && Number(portfolio.three.amount) > 0);
		const tokenCount = Number(portfolio.token_count) || 0;
		const pnlSol = Number(repAgg.realized_pnl_sol) || 0;
		const tips = repAgg.tips || { count: 0, usd: 0 };
		const forks = Number(repAgg.fork_count) || 0;
		const score = rep && Number.isFinite(Number(rep.score)) ? Number(rep.score) : null;
		const repLabel = rep?.tierLabel || null;
		const repAccent = rep?.accent || null;
		const isEmpty = usd <= 0 && tokenCount === 0 && tips.count === 0 && forks === 0 && pnlSol === 0;

		const usdLabel = nw?.address || usd > 0 ? (formatWalletUsd(usd) ?? '$0') : '$0';
		const av = identity.avatarUrl
			? `<img class="twc2-avatar" src="${esc(identity.avatarUrl)}" alt="" loading="lazy" />`
			: `<div class="twc2-avatar twc2-avatar--ph">${esc((identity.name || 'A')[0].toUpperCase())}</div>`;

		// Stat grid — only real, public-safe aggregates. P&L shown only when positive
		// (a public card never broadcasts a loss); reputation only when scored.
		const stats = [];
		stats.push(statCell('Holdings', tokenCount === 0 ? '—' : `${tokenCount}`, { title: `${tokenCount} token${tokenCount === 1 ? '' : 's'} held` }));
		if (pnlSol > 0) stats.push(statCell('Realized P&L', `+${pnlSol.toFixed(pnlSol < 1 ? 3 : 2)} ◎`, { accent: true, title: `${repAgg.realized_wins || 0} winning closed trade(s)` }));
		else if (tips.count > 0) stats.push(statCell('Tips', `${tips.count}`, { title: `${formatWalletUsd(tips.usd) || '$0'} tipped` }));
		else stats.push(statCell('Forks', `${forks}`, { title: `forked ${forks} time(s)` }));
		if (score != null) stats.push(statCell('Reputation', `${Math.round(score)}`, { title: `${repLabel || ''} · ${Math.round(score)}/100` }));
		else stats.push(statCell('Tier', wealthTier.label));

		const repBadge = repLabel
			? `<span class="twc2-rep" style="--rep:${esc(repAccent || '#c4b5fd')}">${esc(repLabel)}</span>`
			: '';
		const threeMark = hasThree
			? `<span class="twc2-three" title="Holds ${THREE_MARK}">◆ ${THREE_MARK}</span>`
			: '';

		const emptyHint = isEmpty
			? `<p class="twc2-empty-hint">A fresh wallet, ready for its first move. ${isOwner ? 'Fund it to bring its body to life.' : 'Tip it or fork it to start one of your own.'}</p>`
			: '';

		// CTA row by viewer role. Owner → manage/customize; visitor/logged-out →
		// tip + fork. Share is universal. No owner-only datum is ever rendered above.
		const primaryCta = isOwner
			? `<a class="twc2-btn twc2-btn-primary" href="${esc(identity.hubUrl || `/agents/${agentId}/wallet`)}">Manage wallet</a>`
			: `<button type="button" class="twc2-btn twc2-btn-primary" data-twc2-tip>Tip</button>`;
		const secondaryCta = isOwner
			? `<a class="twc2-btn twc2-btn-ghost" href="${esc(identity.hubUrl || `/agents/${agentId}/wallet`)}#customize">Customize</a>`
			: `<button type="button" class="twc2-btn twc2-btn-ghost" data-twc2-fork>Fork to own</button>`;

		setHTML(`
			<article class="twc2-card" data-finish="${esc(finish.key)}" data-empty="${isEmpty ? '1' : '0'}"
				style="--twc2-rim:${esc(repAccent || '#c4b5fd')}"
				aria-label="${esc(identity.name || 'Agent')} wallet trading card — ${esc(finish.label)}">
				<div class="twc2-shine" aria-hidden="true"></div>
				<div class="twc2-foil" aria-hidden="true"></div>
				<span class="twc2-finish" aria-label="Card finish: ${esc(finish.label)}">${esc(finish.label)}</span>

				<header class="twc2-head">
					${av}
					<div class="twc2-id">
						<h3 class="twc2-name" title="${esc(identity.name || 'Agent')}">${esc(identity.name || 'Agent')}</h3>
						<button type="button" class="twc2-addr ${identity.isVanity ? 'twc2-addr--vanity' : ''}" data-twc2-copy
							aria-label="Copy wallet address ${esc(identity.address)}">
							${identity.isVanity ? '<span class="twc2-spark" aria-hidden="true">✦</span>' : ''}
							${addressHTML(identity)}
							<span class="twc2-copy-lbl">Copy</span>
						</button>
					</div>
					<div class="twc2-marks">${repBadge}${threeMark}</div>
				</header>

				<div class="twc2-hero">
					<span class="twc2-hero-usd">${esc(usdLabel)}</span>
					<span class="twc2-hero-sub">${esc(wealthTier.label)} · net worth</span>
				</div>

				<div class="twc2-stats">${stats.join('')}</div>
				${emptyHint}

				<footer class="twc2-cta">
					${primaryCta}
					${secondaryCta}
					<button type="button" class="twc2-btn twc2-btn-icon" data-twc2-share aria-label="Share this card" title="Share card">
						<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
					</button>
				</footer>

				<div class="twc2-wm">three.ws</div>
			</article>`);

		const cardEl = root.querySelector('.twc2-card');
		wireActions(cardEl);
		wireTilt(cardEl);
	}

	load();

	return {
		refresh: () => { if (!destroyed) load(); },
		destroy: () => {
			destroyed = true;
			if (tiltRaf) cancelAnimationFrame(tiltRaf);
			try { root.remove(); } catch { /* idempotent */ }
		},
	};
}

function ensureStyles() {
	if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
	const style = document.createElement('style');
	style.id = STYLE_ID;
	style.textContent = CARD_CSS;
	(document.head || document.documentElement).appendChild(style);
}

const CARD_CSS = `
.twc2-wrap{ --twc2-accent:#c4b5fd; --twc2-rim:#c4b5fd; perspective:1100px; width:100%; }

.twc2-card{
	position:relative; overflow:hidden;
	border-radius:18px; padding:18px 18px 16px;
	background:
		radial-gradient(120% 80% at 18% 0%, color-mix(in srgb, var(--twc2-rim) 16%, transparent), transparent 55%),
		linear-gradient(165deg, #14121d 0%, #0b0a11 60%, #08070c 100%);
	border:1px solid color-mix(in srgb, var(--twc2-rim) 28%, rgba(255,255,255,.06));
	box-shadow:0 10px 34px rgba(0,0,0,.45), inset 0 1px 0 rgba(255,255,255,.05);
	transform:rotateX(var(--twc2-rx,0)) rotateY(var(--twc2-ry,0));
	transform-style:preserve-3d; transition:transform .25s ease, box-shadow .25s ease;
	will-change:transform;
}
.twc2-card--live{ transition:none; box-shadow:0 18px 50px rgba(0,0,0,.55), 0 0 0 1px color-mix(in srgb, var(--twc2-rim) 40%, transparent); }

/* Light sweep that tracks the cursor on hover (foil+ finishes only). */
.twc2-shine{ position:absolute; inset:0; pointer-events:none; opacity:0; transition:opacity .25s ease;
	background:radial-gradient(420px 280px at var(--twc2-mx,50%) var(--twc2-my,0%), rgba(255,255,255,.14), transparent 60%); }
.twc2-card--live .twc2-shine{ opacity:1; }

/* Holographic foil layer — its richness steps up with the finish. */
.twc2-foil{ position:absolute; inset:0; pointer-events:none; opacity:0; mix-blend-mode:screen;
	background:linear-gradient(115deg, transparent 30%,
		rgba(124,108,176,.20) 42%, rgba(96,165,250,.18) 50%, rgba(236,114,182,.18) 58%, transparent 70%);
	background-size:260% 260%; }
.twc2-card[data-finish="foil"] .twc2-foil{ opacity:.35; }
.twc2-card[data-finish="holo"] .twc2-foil{ opacity:.5; }
.twc2-card[data-finish="prism"] .twc2-foil{ opacity:.7; }
.twc2-card[data-finish="aurora"] .twc2-foil{ opacity:.9; }
.twc2-card--live .twc2-foil{ background-position:var(--twc2-mx,50%) var(--twc2-my,50%); }

.twc2-finish{ position:absolute; top:12px; right:14px; z-index:2;
	font-size:9px; font-weight:800; letter-spacing:.12em; text-transform:uppercase;
	color:color-mix(in srgb, var(--twc2-rim) 70%, #fff);
	opacity:.85; }
.twc2-card[data-finish="matte"] .twc2-finish,
.twc2-card[data-finish="satin"] .twc2-finish{ color:#6b7280; }

.twc2-head{ position:relative; z-index:1; display:flex; align-items:center; gap:12px; }
.twc2-avatar{ width:54px; height:54px; border-radius:14px; object-fit:cover; flex:none;
	border:1px solid color-mix(in srgb, var(--twc2-rim) 40%, rgba(255,255,255,.1));
	background:#0c0b12; box-shadow:0 4px 14px rgba(0,0,0,.4); }
.twc2-avatar--ph{ display:grid; place-items:center; font:800 22px/1 Inter,system-ui,sans-serif;
	color:rgba(255,255,255,.85);
	background:linear-gradient(135deg, color-mix(in srgb, var(--twc2-rim) 60%, #4338ca), #8b5cf6); }
.twc2-id{ min-width:0; flex:1; }
.twc2-name{ margin:0 0 3px; font:700 17px/1.15 Inter,system-ui,sans-serif; color:#f5f3ff;
	white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:100%; }

.twc2-addr{ display:inline-flex; align-items:center; gap:5px; max-width:100%;
	padding:3px 7px; border-radius:7px; cursor:pointer;
	font:600 12.5px/1 ui-monospace,'JetBrains Mono',Menlo,monospace;
	background:rgba(124,108,176,.1); border:1px solid rgba(124,108,176,.22);
	color:#c4b5fd; transition:background .14s ease, border-color .14s ease; }
.twc2-addr:hover{ background:rgba(124,108,176,.18); border-color:rgba(124,108,176,.4); }
.twc2-addr:focus-visible{ outline:2px solid rgba(196,181,253,.7); outline-offset:2px; }
.twc2-addr--vanity{ background:rgba(167,139,250,.16); border-color:rgba(167,139,250,.45); }
.twc2-addr-vanity{ color:#e9d5ff; font-weight:800; }
.twc2-addr-mid{ color:#a8a0c4; }
.twc2-addr-dots{ color:#6b6485; margin:0 1px; }
.twc2-spark{ color:#e9d5ff; }
.twc2-copy-lbl{ font-family:Inter,system-ui,sans-serif; font-size:9.5px; font-weight:700;
	letter-spacing:.06em; text-transform:uppercase; color:#8b82ac; margin-left:2px; }
.twc2-addr.twc2-copied{ background:rgba(74,222,128,.14); border-color:rgba(74,222,128,.45); color:#86efac; }
.twc2-addr.twc2-copied .twc2-copy-lbl,.twc2-addr.twc2-copied .twc2-addr-mid{ color:#86efac; }

.twc2-marks{ display:flex; flex-direction:column; align-items:flex-end; gap:5px; flex:none; }
.twc2-rep{ font:800 9.5px/1 Inter,system-ui,sans-serif; letter-spacing:.08em; text-transform:uppercase;
	padding:4px 8px; border-radius:999px; color:var(--rep,#c4b5fd);
	background:color-mix(in srgb, var(--rep,#c4b5fd) 14%, transparent);
	border:1px solid color-mix(in srgb, var(--rep,#c4b5fd) 40%, transparent); }
.twc2-three{ font:800 9.5px/1 Inter,system-ui,sans-serif; letter-spacing:.06em;
	padding:4px 8px; border-radius:999px; color:#fbbf24;
	background:rgba(251,191,36,.12); border:1px solid rgba(251,191,36,.4); white-space:nowrap; }

.twc2-hero{ position:relative; z-index:1; margin:16px 0 6px; display:flex; flex-direction:column; gap:1px; }
.twc2-hero-usd{ font:800 34px/1 Inter,system-ui,sans-serif; letter-spacing:-.02em;
	color:#fff; text-shadow:0 2px 18px color-mix(in srgb, var(--twc2-rim) 35%, transparent); }
.twc2-hero-sub{ font:600 10.5px/1 Inter,system-ui,sans-serif; letter-spacing:.1em; text-transform:uppercase; color:#7c7596; }

.twc2-stats{ position:relative; z-index:1; display:grid; grid-template-columns:repeat(3,1fr); gap:8px; margin-top:14px; }
.twc2-stat{ display:flex; flex-direction:column; gap:3px; padding:9px 10px; border-radius:11px;
	background:rgba(255,255,255,.03); border:1px solid rgba(255,255,255,.06); }
.twc2-stat--accent{ background:rgba(74,222,128,.08); border-color:rgba(74,222,128,.22); }
.twc2-stat-val{ font:800 16px/1 Inter,system-ui,sans-serif; color:#ece9f8; }
.twc2-stat--accent .twc2-stat-val{ color:#86efac; }
.twc2-stat-label{ font:600 8.5px/1 Inter,system-ui,sans-serif; letter-spacing:.1em; text-transform:uppercase; color:#6f6889; }

.twc2-empty-hint{ position:relative; z-index:1; margin:12px 0 0; font:500 12px/1.45 Inter,system-ui,sans-serif; color:#8b82ac; }

.twc2-cta{ position:relative; z-index:1; display:flex; gap:8px; margin-top:16px; }
.twc2-btn{ display:inline-flex; align-items:center; justify-content:center; gap:6px;
	padding:10px 14px; border-radius:10px; cursor:pointer; text-decoration:none;
	font:700 13px/1 Inter,system-ui,sans-serif; border:1px solid transparent;
	transition:background .14s ease, border-color .14s ease, transform .1s ease; }
.twc2-btn:active{ transform:translateY(1px); }
.twc2-btn:focus-visible{ outline:2px solid rgba(196,181,253,.7); outline-offset:2px; }
.twc2-btn-primary{ flex:1; background:linear-gradient(135deg,#8b5cf6,#7c3aed); color:#fff;
	box-shadow:0 4px 16px rgba(124,58,237,.35); }
.twc2-btn-primary:hover{ background:linear-gradient(135deg,#956cf8,#8b48f0); }
.twc2-btn-ghost{ flex:1; background:rgba(255,255,255,.05); border-color:rgba(255,255,255,.1); color:#d6d2e8; }
.twc2-btn-ghost:hover{ background:rgba(255,255,255,.09); border-color:rgba(255,255,255,.18); }
.twc2-btn-icon{ flex:none; width:40px; padding:10px; background:rgba(255,255,255,.05);
	border-color:rgba(255,255,255,.1); color:#c4b5fd; }
.twc2-btn-icon:hover{ background:rgba(124,108,176,.18); border-color:rgba(124,108,176,.4); }

.twc2-wm{ position:absolute; bottom:11px; right:14px; z-index:1;
	font:800 9px/1 Inter,system-ui,sans-serif; letter-spacing:.14em; text-transform:uppercase; color:#3a3550; }

/* ── Skeleton ─────────────────────────────────────────────────────────────── */
.twc2-skel{ border-radius:18px; padding:18px; background:linear-gradient(165deg,#14121d,#0a0910);
	border:1px solid rgba(255,255,255,.06); }
.twc2-skel-top{ display:flex; gap:12px; align-items:center; }
.twc2-skel-avatar{ width:54px; height:54px; border-radius:14px; flex:none; }
.twc2-skel-lines{ flex:1; display:flex; flex-direction:column; gap:8px; }
.twc2-skel-line{ height:12px; border-radius:6px; display:block; }
.twc2-skel-line.w60{ width:60%; } .twc2-skel-line.w40{ width:40%; }
.twc2-skel-hero{ height:38px; border-radius:9px; margin:18px 0 6px; width:55%; }
.twc2-skel-stats{ display:grid; grid-template-columns:repeat(3,1fr); gap:8px; margin-top:14px; }
.twc2-skel-stats span{ height:44px; border-radius:11px; }
.twc2-skel-avatar,.twc2-skel-line,.twc2-skel-hero,.twc2-skel-stats span{
	background:linear-gradient(90deg, rgba(255,255,255,.04) 25%, rgba(255,255,255,.08) 37%, rgba(255,255,255,.04) 63%);
	background-size:400% 100%; animation:twc2-shimmer 1.4s ease infinite; }

@keyframes twc2-shimmer{ 0%{ background-position:100% 0; } 100%{ background-position:-100% 0; } }

@media (max-width:380px){
	.twc2-hero-usd{ font-size:28px; }
	.twc2-cta{ flex-wrap:wrap; }
	.twc2-btn-primary,.twc2-btn-ghost{ flex:1 1 40%; }
}

@media (prefers-reduced-motion:reduce){
	.twc2-card{ transition:none; }
	.twc2-skel-avatar,.twc2-skel-line,.twc2-skel-hero,.twc2-skel-stats span{ animation:none; }
}
`;

if (typeof window !== 'undefined') {
	window.twsWalletCard = { mountWalletCard };
}
