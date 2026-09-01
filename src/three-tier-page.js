// The canonical $THREE holder-value surface (/three).
//
// One page that renders the whole hold-to-access ladder: every tier, its perks,
// the live fee discount + free-quota multiplier, and, for the connected wallet or
// signed-in holder, the current tier highlighted with the exact $-to-next-tier
// delta and a real "Hold more $THREE" action. Every locked state across the
// platform routes here (the nav tier chip, the in-place lock panels), so this is
// the single upgrade path the token's promise rests on.
//
// Truth comes from the server, never the client:
//   GET /api/three/tier    -> { signed_in, wallet_linked, tier, held_usd, next:{usd_to_go}, ladder:[...] }
//   GET /api/three/access  -> per-feature { enforced, eligible, required, ... }
// Both accept ?wallet= so an account-less visitor who has connected Phantom sees
// their real on-chain tier. With no wallet and no session, /tier still answers the
// public ladder at the Member floor, so a first-time visitor sees every tier and
// its threshold; the hero then asks them to connect or sign in for their own spot.
// Both degrade to the Member floor on any price/RPC hiccup, so an outage shows the
// ladder and the upgrade path rather than a dead screen.
//
// All five states are designed: a skeleton ladder while loading, a connect/sign-in
// prompt when there's no wallet in hand, an actionable error with retry that keeps
// the page heading, the populated ladder, and graceful overflow at $10M+ holdings.

import { getConnectedWalletAddress, getConnectedWallet, connectWallet } from './wallet.js';
import { openSwapModal } from './swap-jupiter.js';
import { THREE_MINT } from './pump/three-token-data.js';
import { errorStateHTML } from './shared/state-kit.js';
import { trackFunnelStep, ANALYTICS_EVENTS } from './analytics.js';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const PRICE_URL = '/three-token';
const SIGN_IN_URL = '/login';

// ── formatters ──────────────────────────────────────────────────────────────
function fmtUsd(n, max = 0) {
	const v = Number(n);
	if (!Number.isFinite(v)) return '$0';
	return v.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: max });
}
// Compact currency so a $10M+ bag never blows out the header layout.
function fmtCompactUsd(n) {
	const v = Number(n) || 0;
	if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
	if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
	if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
	return fmtUsd(v, v > 0 && v < 1 ? 2 : 0);
}
function esc(s) {
	return String(s ?? '').replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
	);
}
// Tone class by tier id — mirrors src/three-access.js / src/three-lock.js so the
// badge, the lock panels, and this ladder read as one system.
function tone(id) {
	if (id === 'gold' || id === 'genesis') return 'tt-gold';
	if (id === 'silver') return 'tt-silver';
	if (id === 'bronze') return 'tt-bronze';
	return 'tt-green';
}

// ── data ──────────────────────────────────────────────────────────────────────

// Resolve the caller's tier + the per-feature access matrix in one round-trip
// pair. Reads the connected wallet via ?wallet= when one is in hand, else the
// session cookie. Never throws — returns { tier:null } so the UI can still draw
// the public ladder and the connect/sign-in prompt.
async function loadState() {
	const wallet = (() => {
		try {
			return getConnectedWalletAddress() || null;
		} catch {
			return null;
		}
	})();
	const q = wallet ? `?wallet=${encodeURIComponent(wallet)}` : '';
	const [tierRes, accessRes] = await Promise.allSettled([
		fetch(`/api/three/tier${q}`, { credentials: 'include', headers: { accept: 'application/json' } }),
		fetch(`/api/three/access${q}`, { credentials: 'include', headers: { accept: 'application/json' } }),
	]);

	let tier = null;
	if (tierRes.status === 'fulfilled' && tierRes.value.ok) {
		tier = await tierRes.value.json().catch(() => null);
	}
	let access = null;
	if (accessRes.status === 'fulfilled' && accessRes.value.ok) {
		access = await accessRes.value.json().catch(() => null);
	}
	return { wallet, tier, access };
}

// ── render ──────────────────────────────────────────────────────────────────

// Who we are showing a tier for. 'wallet' means a Solana wallet is in hand (connected
// on this page or linked to the session) and its real on-chain tier is highlighted;
// 'signed_in' is an account with no wallet yet; 'anonymous' is a plain visitor.
function resolveIdentity({ tier, access, wallet }) {
	const linked = Boolean(wallet) || Boolean(tier?.wallet_linked ?? access?.wallet_linked);
	if (linked) return 'wallet';
	const signedIn = Boolean(tier?.signed_in ?? access?.signed_in);
	return signedIn ? 'signed_in' : 'anonymous';
}

function render(root, state) {
	const { tier, access } = state;
	if (!tier || !Array.isArray(tier.ladder) || tier.ladder.length === 0) {
		// No ladder at all: a real (rare) outage, since the server answers the public
		// ladder even to anonymous callers. Keep the heading, offer a retry.
		renderFailure(root, 'The tier ladder is resolved live on-chain. Check your connection and try again.');
		return;
	}

	const ladder = tier.ladder;
	const heldUsd = Number(tier.held_usd) || 0;
	const identity = resolveIdentity(state);
	// With no wallet in hand we don't claim a tier: show the neutral ladder and a
	// connect prompt rather than presumptuously marking Member as "You're here".
	const currentLevel = identity === 'wallet' ? Number(tier.tier?.level) || 0 : -1;

	// Group the gated features by the tier level that unlocks them, so each ladder
	// card lists the concrete things it turns on (with Live vs Planned honesty).
	const featuresByLevel = new Map();
	for (const f of access?.features || []) {
		const lvl = Number(f.required?.level) || 0;
		if (!featuresByLevel.has(lvl)) featuresByLevel.set(lvl, []);
		featuresByLevel.get(lvl).push(f);
	}

	root.innerHTML =
		renderHero({ tier, heldUsd, currentLevel, identity }) +
		`<ol class="tt-ladder" role="list" aria-label="$THREE holder tiers">` +
		ladder.map((t) => renderTier(t, { currentLevel, heldUsd, featuresByLevel })).join('') +
		`</ol>` +
		renderFooter();

	wire(root);
	enableRovingFocus(root);
}

function renderHero({ tier, heldUsd, currentLevel, identity }) {
	const cur = tier.tier || { id: 'member', label: 'Member' };
	const next = tier.next; // { id, label, min_usd, usd_to_go } | null
	const isHolder = currentLevel >= 1;

	let statusLine;
	let cta;
	if (identity === 'anonymous') {
		statusLine = `Connect your wallet or sign in to see your tier and what you've unlocked.`;
		cta =
			`<button type="button" class="tt-btn tt-btn--primary" data-tt-connect>Connect wallet</button>` +
			`<a class="tt-btn tt-btn--ghost" href="${SIGN_IN_URL}">Sign in</a>`;
	} else if (identity === 'signed_in') {
		statusLine = `You're signed in, but no Solana wallet is linked yet. Connect one and your tier resolves live from the $THREE it holds.`;
		cta =
			`<button type="button" class="tt-btn tt-btn--primary" data-tt-connect>Connect wallet</button>` +
			`<a class="tt-btn tt-btn--ghost" href="${PRICE_URL}">Price &amp; chart</a>`;
	} else if (next) {
		const toGo = Number(next.usd_to_go) || Math.max(0, (Number(next.min_usd) || 0) - heldUsd);
		statusLine = isHolder
			? `You're <strong>${esc(cur.label)}</strong>, holding ${fmtCompactUsd(heldUsd)} of $THREE. Hold <strong>${fmtUsd(toGo, toGo < 1 ? 2 : 0)}</strong> more to reach <strong>${esc(next.label)}</strong>.`
			: `You hold ${fmtCompactUsd(heldUsd)} of $THREE. Hold <strong>${fmtUsd(toGo, toGo < 1 ? 2 : 0)}</strong> to reach <strong>${esc(next.label)}</strong> and start unlocking perks.`;
		cta =
			`<button type="button" class="tt-btn tt-btn--primary" data-tt-buy>Hold more $THREE</button>` +
			`<a class="tt-btn tt-btn--ghost" href="${PRICE_URL}">Price &amp; chart</a>`;
	} else {
		// Top of the ladder : nothing left to upgrade to.
		statusLine = `You're <strong>${esc(cur.label)}</strong>, holding ${fmtCompactUsd(heldUsd)} of $THREE: the top tier. Every holder perk is unlocked.`;
		cta =
			`<button type="button" class="tt-btn tt-btn--primary" data-tt-buy>Add to your bag</button>` +
			`<a class="tt-btn tt-btn--ghost" href="${PRICE_URL}">Price &amp; chart</a>`;
	}

	const chip = identity === 'wallet' && currentLevel >= 1
		? `<span class="tt-hero-chip ${tone(cur.id)}"><span aria-hidden="true">◆</span> ${esc(cur.label)}</span>`
		: '';

	return heroShell(
		`<p class="tt-lede">${statusLine}</p>` +
			`<div class="tt-hero-actions">${cta}</div>` +
			`<p class="tt-hero-foot">Holding (not spending) $THREE is the status lever: fee discounts on compute, higher free quotas, and private worlds. $THREE is the only coin on three.ws. Draft &amp; Standard generation stay free, forever.</p>`,
		chip,
	);
}

// The eyebrow + h1 every state shares (loading, failure, populated), so the page
// always has exactly one heading and a reader always knows where they are.
function heroShell(body = '', chip = '') {
	return (
		`<header class="tt-hero">` +
		`<p class="tt-eyebrow">$THREE · Hold-to-access</p>` +
		`<h1 class="tt-h1">Hold $THREE. Unlock more.${chip}</h1>` +
		body +
		`</header>`
	);
}

function renderTier(t, { currentLevel, heldUsd, featuresByLevel }) {
	const isCurrent = t.level === currentLevel;
	const isCleared = t.level < currentLevel; // already included in the user's tier
	const isMember = t.level === 0;
	const toGo = Math.max(0, (Number(t.min_usd) || 0) - heldUsd);

	const threshold = isMember
		? 'Free for everyone'
		: `${fmtUsd(t.min_usd)}+ in $THREE`;

	const discount = Number(t.discount_bps) || 0;
	const mult = Number(t.rate_multiplier) || 1;
	const valueChips =
		!isMember || discount > 0
			? `<div class="tt-chips">` +
				(discount > 0 ? `<span class="tt-vchip">${(discount / 100).toFixed(0)}% off compute</span>` : '') +
				(mult > 1 ? `<span class="tt-vchip">${mult}× free quota</span>` : '') +
				`</div>`
			: '';

	const statusBadge = isCurrent
		? `<span class="tt-status tt-status--here">You're here</span>`
		: isCleared
			? `<span class="tt-status tt-status--done">✓ Included</span>`
			: isMember
				? ''
				: `<span class="tt-status tt-status--togo">${fmtUsd(toGo, toGo < 1 ? 2 : 0)} to go</span>`;

	const perks = (t.perks || [])
		.map((p) => `<li class="tt-perk"><span class="tt-perk-tick" aria-hidden="true">✦</span><span class="tt-perk-text">${esc(p)}</span></li>`)
		.join('');

	// Concrete gated features that unlock at this tier, with Live/Planned honesty
	// and a check when the current holder already clears them.
	const feats = (featuresByLevel.get(t.level) || [])
		.map((f) => {
			const live = f.enforced
				? `<span class="tt-flag tt-flag--live">Live</span>`
				: `<span class="tt-flag tt-flag--soon">Planned</span>`;
			const got = f.eligible ? `<span class="tt-feat-tick" aria-hidden="true">✓</span>` : '';
			return `<li class="tt-feat">${got}<span class="tt-feat-label">${esc(f.label)}</span>${live}</li>`;
		})
		.join('');
	const featsBlock = feats ? `<ul class="tt-feats" aria-label="Features unlocked at ${esc(t.label)}">${feats}</ul>` : '';

	return (
		`<li class="tt-tier ${tone(t.id)}${isCurrent ? ' tt-tier--current' : ''}${isCleared ? ' tt-tier--cleared' : ''}" ` +
		`tabindex="-1" aria-current="${isCurrent ? 'true' : 'false'}" ` +
		`aria-label="${esc(t.label)} tier, ${esc(threshold)}${isCurrent ? ', your current tier' : ''}">` +
		`<div class="tt-tier-head">` +
		`<span class="tt-tier-mark" aria-hidden="true">◆</span>` +
		`<div class="tt-tier-id"><span class="tt-tier-name">${esc(t.label)}</span>` +
		`<span class="tt-tier-thresh">${esc(threshold)}</span></div>` +
		statusBadge +
		`</div>` +
		valueChips +
		(perks ? `<ul class="tt-perks">${perks}</ul>` : '') +
		featsBlock +
		`</li>`
	);
}

function renderFooter() {
	return (
		`<footer class="tt-page-foot">` +
		`<p>Your tier is resolved live from the USD value of $THREE your wallet holds: nothing is stored, nothing is spent. Sell and your tier adjusts; the lever rewards holding.</p>` +
		`<p class="tt-mint">Contract: <a href="https://solscan.io/token/${THREE_MINT}" target="_blank" rel="noopener">${THREE_MINT}</a></p>` +
		`</footer>`
	);
}

// ── interaction ───────────────────────────────────────────────────────────────

function wire(root) {
	const connect = root.querySelector('[data-tt-connect]');
	if (connect) {
		connect.addEventListener('click', async () => {
			try {
				await connectWallet();
			} catch {
				/* the wallet module surfaces its own connect errors */
			}
		});
	}
	root.querySelectorAll('[data-tt-buy]').forEach((btn) => {
		btn.addEventListener('click', () => openBuy());
	});
}

// Open the in-app Jupiter swap (SOL → $THREE) when a wallet is connected, else
// route to the coin page's one-click buy. Either way the user can act without
// leaving the upgrade flow.
function openBuy() {
	try {
		trackFunnelStep('three', ANALYTICS_EVENTS.TOKEN_BUY_CLICKED, { source: 'tier_page' });
		trackFunnelStep('upgrade', ANALYTICS_EVENTS.UPGRADE_GET_THREE_CLICKED, { feature: 'tier_page' });
	} catch {
		/* analytics is best-effort */
	}
	let provider = null;
	let wallet = null;
	try {
		provider = getConnectedWallet();
		wallet = getConnectedWalletAddress();
	} catch {
		provider = null;
	}
	if (provider && wallet) {
		openSwapModal({
			wallet,
			getProvider: () => provider,
			defaultInputMint: SOL_MINT,
			defaultOutputMint: THREE_MINT,
		});
		return;
	}
	window.location.assign(PRICE_URL);
}

// Roving-tabindex keyboard navigation across the ladder: one stop in the tab
// order, then ↑/↓/Home/End move between tiers. The current tier is the default
// stop so a keyboard user lands on "where am I" first.
function enableRovingFocus(root) {
	const tiers = Array.from(root.querySelectorAll('.tt-tier'));
	if (tiers.length === 0) return;
	const startIdx = Math.max(0, tiers.findIndex((el) => el.classList.contains('tt-tier--current')));
	tiers.forEach((el, i) => {
		el.tabIndex = i === startIdx ? 0 : -1;
	});
	const move = (from, to) => {
		const next = Math.max(0, Math.min(tiers.length - 1, to));
		if (next === from) return;
		tiers[from].tabIndex = -1;
		tiers[next].tabIndex = 0;
		tiers[next].focus();
	};
	root.addEventListener('keydown', (e) => {
		const idx = tiers.indexOf(document.activeElement);
		if (idx === -1) return;
		switch (e.key) {
			case 'ArrowDown':
			case 'ArrowRight':
				e.preventDefault();
				move(idx, idx + 1);
				break;
			case 'ArrowUp':
			case 'ArrowLeft':
				e.preventDefault();
				move(idx, idx - 1);
				break;
			case 'Home':
				e.preventDefault();
				move(idx, 0);
				break;
			case 'End':
				e.preventDefault();
				move(idx, tiers.length - 1);
				break;
			default:
				break;
		}
	});
}

// ── states ──────────────────────────────────────────────────────────────────

function renderLoading(root) {
	const card = () =>
		`<li class="tt-tier tt-skel" aria-hidden="true">` +
		`<div class="tt-tier-head"><span class="tt-sk tt-sk--mark"></span>` +
		`<div class="tt-tier-id"><span class="tt-sk tt-sk--name"></span><span class="tt-sk tt-sk--thresh"></span></div></div>` +
		`<span class="tt-sk tt-sk--line"></span><span class="tt-sk tt-sk--line tt-sk--short"></span>` +
		`</li>`;
	root.innerHTML =
		heroShell(`<span class="tt-sk tt-sk--lede"></span>`) +
		`<ol class="tt-ladder" role="list" aria-busy="true">${card().repeat(5)}</ol>` +
		`<span class="tt-sr" role="status">Loading your $THREE tier…</span>`;
}

// The failure state keeps the page heading above the error card, so the h1 and
// the page's identity survive an outage, and Retry re-runs the whole boot.
function renderFailure(root, body) {
	root.innerHTML =
		heroShell() +
		errorStateHTML({ title: "Couldn't load the $THREE tiers", body });
	const retry = root.querySelector('[data-sk-retry]');
	if (retry) retry.addEventListener('click', () => boot(root));
}

async function boot(root) {
	injectStyles();
	renderLoading(root);
	try {
		const state = await loadState();
		render(root, state);
	} catch {
		renderFailure(root, 'Something went wrong resolving your tier. Try again.');
	}
}

// ── mount ─────────────────────────────────────────────────────────────────────

function mount() {
	let root = document.getElementById('tier-root');
	if (!root) {
		root = document.createElement('main');
		root.id = 'tier-root';
		root.className = 'tt-root';
		document.body.appendChild(root);
	} else {
		root.classList.add('tt-root');
	}
	try {
		trackFunnelStep('three', ANALYTICS_EVENTS.TOKEN_PAGE_VIEWED, { source: 'tier_page' });
	} catch {
		/* analytics is best-effort */
	}
	boot(root);

	// A wallet connect/disconnect/switch changes whose tier we're showing, so re-resolve.
	if (typeof window !== 'undefined') {
		let last = null;
		try {
			last = getConnectedWalletAddress() || null;
		} catch {
			last = null;
		}
		window.addEventListener('wallet:changed', (e) => {
			const next =
				e?.detail && Object.prototype.hasOwnProperty.call(e.detail, 'address')
					? e.detail.address || null
					: (() => {
							try {
								return getConnectedWalletAddress() || null;
							} catch {
								return null;
							}
						})();
			if (next === last) return;
			last = next;
			boot(root);
		});
	}
}

// ── styles ──────────────────────────────────────────────────────────────────

let _styled = false;
function injectStyles() {
	if (_styled || typeof document === 'undefined') return;
	_styled = true;
	const css = `
	.tt-root{max-width:920px;margin:0 auto;padding:32px 18px 80px;font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#f5f5f7;}
	.tt-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0;}

	.tt-hero{margin:0 0 26px;}
	.tt-eyebrow{margin:0 0 8px;font-size:11.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#6ee7a8;}
	.tt-h1{margin:0 0 12px;font-size:32px;font-weight:840;letter-spacing:-.025em;line-height:1.08;display:flex;align-items:center;gap:12px;flex-wrap:wrap;}
	.tt-hero-chip{display:inline-flex;align-items:center;gap:6px;font-size:13px;font-weight:700;border-radius:999px;padding:5px 12px;color:#6ee7a8;border:1px solid rgba(110,231,168,.32);background:rgba(110,231,168,.08);}
	.tt-hero-chip.tt-gold{color:#f5c451;border-color:rgba(245,196,81,.34);background:rgba(245,196,81,.08);}
	.tt-hero-chip.tt-silver{color:#cfd6e4;border-color:rgba(207,214,228,.3);background:rgba(207,214,228,.06);}
	.tt-hero-chip.tt-bronze{color:#e0a878;border-color:rgba(224,168,120,.32);background:rgba(224,168,120,.08);}
	.tt-lede{margin:0 0 18px;font-size:15.5px;line-height:1.55;color:#b9b9c2;max-width:62ch;}
	.tt-lede strong{color:#f5f5f7;font-weight:700;}
	.tt-hero-actions{display:flex;gap:10px;flex-wrap:wrap;}
	.tt-hero-foot{margin:16px 0 0;font-size:12px;line-height:1.6;color:#75757f;max-width:64ch;}

	.tt-btn{display:inline-flex;align-items:center;justify-content:center;font:700 14px/1 Inter,system-ui,sans-serif;
		padding:12px 20px;border-radius:12px;text-decoration:none;cursor:pointer;border:1px solid #2a2a33;
		background:#13131a;color:#f1f1f4;transition:transform .15s cubic-bezier(.22,1,.36,1),background .15s,border-color .15s;}
	.tt-btn--primary{background:#6ee7a8;color:#06120c;border-color:#6ee7a8;}
	.tt-btn--primary:hover{background:#8af0c0;transform:translateY(-1px);}
	.tt-btn--ghost:hover{border-color:#3a3a44;background:#181820;transform:translateY(-1px);}

	.tt-ladder{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:12px;}
	.tt-tier{position:relative;border-radius:16px;padding:18px 18px 16px;border:1px solid #1f1f27;
		background:linear-gradient(180deg,#111116,#0c0c11);transition:border-color .16s,transform .12s,box-shadow .16s;outline:none;}
	.tt-tier:hover{transform:translateY(-2px);border-color:#2c2c36;}
	.tt-tier:focus-visible{outline:2px solid #6ee7a8;outline-offset:3px;}
	.tt-tier--cleared{opacity:.78;}
	.tt-tier--current{border-color:rgba(110,231,168,.5);box-shadow:0 0 0 1px rgba(110,231,168,.25),0 18px 50px -28px rgba(110,231,168,.5);opacity:1;}
	.tt-tier.tt-gold.tt-tier--current{border-color:rgba(245,196,81,.5);box-shadow:0 0 0 1px rgba(245,196,81,.25),0 18px 50px -28px rgba(245,196,81,.45);}
	.tt-tier.tt-silver.tt-tier--current{border-color:rgba(207,214,228,.5);box-shadow:0 0 0 1px rgba(207,214,228,.22),0 18px 50px -28px rgba(207,214,228,.4);}
	.tt-tier.tt-bronze.tt-tier--current{border-color:rgba(224,168,120,.5);box-shadow:0 0 0 1px rgba(224,168,120,.24),0 18px 50px -28px rgba(224,168,120,.45);}

	.tt-tier-head{display:flex;align-items:center;gap:12px;}
	.tt-tier-mark{flex-shrink:0;width:34px;height:34px;border-radius:10px;display:inline-flex;align-items:center;justify-content:center;font-size:15px;
		color:#6ee7a8;background:rgba(110,231,168,.1);border:1px solid rgba(110,231,168,.22);}
	.tt-gold .tt-tier-mark{color:#f5c451;background:rgba(245,196,81,.1);border-color:rgba(245,196,81,.24);}
	.tt-silver .tt-tier-mark{color:#cfd6e4;background:rgba(207,214,228,.1);border-color:rgba(207,214,228,.22);}
	.tt-bronze .tt-tier-mark{color:#e0a878;background:rgba(224,168,120,.1);border-color:rgba(224,168,120,.22);}
	.tt-tier-id{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1;}
	.tt-tier-name{font-size:17px;font-weight:800;letter-spacing:-.01em;}
	.tt-tier-thresh{font-size:12.5px;color:#8a8a93;}
	.tt-status{flex-shrink:0;font-size:11.5px;font-weight:700;border-radius:999px;padding:5px 11px;white-space:nowrap;}
	.tt-status--here{color:#06120c;background:#6ee7a8;}
	.tt-status--done{color:#7fd6a3;background:rgba(110,231,168,.12);border:1px solid rgba(110,231,168,.22);}
	.tt-status--togo{color:#d7d7de;background:rgba(255,255,255,.05);border:1px solid #2a2a33;}

	.tt-chips{display:flex;flex-wrap:wrap;gap:7px;margin:12px 0 0;}
	.tt-vchip{font-size:11.5px;font-weight:700;color:#cdeede;background:rgba(110,231,168,.08);border:1px solid rgba(110,231,168,.2);border-radius:8px;padding:4px 9px;}
	.tt-gold .tt-vchip{color:#f1d79a;background:rgba(245,196,81,.08);border-color:rgba(245,196,81,.2);}
	.tt-silver .tt-vchip{color:#dde2ec;background:rgba(207,214,228,.07);border-color:rgba(207,214,228,.2);}
	.tt-bronze .tt-vchip{color:#ecc6a6;background:rgba(224,168,120,.08);border-color:rgba(224,168,120,.2);}

	.tt-perks{list-style:none;margin:13px 0 0;padding:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:7px 16px;}
	.tt-perk{display:flex;gap:8px;align-items:flex-start;font-size:13px;line-height:1.45;color:#c7c7d0;}
	.tt-perk-text{flex:1;min-width:0;}
	.tt-perk-tick{flex-shrink:0;color:#6ee7a8;font-size:11px;line-height:1.5;}
	.tt-gold .tt-perk-tick{color:#f5c451;}
	.tt-silver .tt-perk-tick{color:#cfd6e4;}
	.tt-bronze .tt-perk-tick{color:#e0a878;}

	.tt-feats{list-style:none;margin:13px 0 0;padding:11px 0 0;border-top:1px solid #1d1d24;display:flex;flex-direction:column;gap:7px;}
	.tt-feat{display:flex;align-items:center;gap:8px;font-size:12.5px;color:#9a9aa4;}
	.tt-feat-tick{color:#6ee7a8;font-size:11px;font-weight:800;}
	.tt-feat-label{flex:1;min-width:0;}
	.tt-flag{flex-shrink:0;font-size:10px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;border-radius:6px;padding:3px 7px;}
	.tt-flag--live{color:#6ee7a8;background:rgba(110,231,168,.1);border:1px solid rgba(110,231,168,.24);}
	.tt-flag--soon{color:#8a8a93;background:rgba(255,255,255,.04);border:1px solid #2a2a33;}

	.tt-page-foot{margin:26px 2px 0;font-size:12px;line-height:1.6;color:#75757f;}
	.tt-page-foot p{margin:0 0 6px;}
	.tt-mint a{color:#9a9aa4;font-family:ui-monospace,Menlo,monospace;font-size:11px;word-break:break-all;text-decoration:none;border-bottom:1px solid #2a2a33;}
	.tt-mint a:hover{color:#cdeede;}

	/* skeleton */
	.tt-sk{display:block;border-radius:8px;background:linear-gradient(90deg,#15151b,#20202a,#15151b);background-size:200% 100%;animation:tt-sh 1.3s infinite;}
	.tt-sk--mark{width:34px;height:34px;flex-shrink:0;border-radius:10px;}
	.tt-sk--name{height:15px;width:120px;margin-bottom:6px;}
	.tt-sk--thresh{height:11px;width:90px;}
	.tt-sk--line{height:12px;width:80%;margin-top:13px;}
	.tt-sk--short{width:50%;margin-top:8px;}
	.tt-sk--lede{height:16px;width:min(420px,80%);}
	.tt-skel .tt-tier-head{display:flex;align-items:center;gap:12px;}

	@keyframes tt-sh{0%{background-position:200% 0}100%{background-position:-200% 0}}

	@media (max-width:560px){
		.tt-h1{font-size:26px;}
		.tt-tier-head{flex-wrap:wrap;}
		.tt-status{order:3;}
		.tt-btn{flex:1;}
	}
	@media (prefers-reduced-motion: reduce){
		.tt-tier,.tt-btn{transition:none;}
		.tt-tier:hover{transform:none;}
		.tt-sk{animation:none;}
	}`;
	const el = document.createElement('style');
	el.id = 'tt-styles';
	el.textContent = css;
	document.head.appendChild(el);
}

// ── bootstrap (must run last) ─────────────────────────────────────────────────
// Kept at the very end of the module: mount() → boot() → injectStyles() reads the
// `_styled` guard, so the bootstrap can only run after `let _styled` is initialized.
// When the DOM is already parsed (readyState !== 'loading') mount() runs during
// module evaluation, so invoking it before `let _styled` was declared hit that
// binding in its temporal dead zone — the intermittent "Cannot access '_styled'
// before initialization" / "Cannot access uninitialized variable" crash on /three.
if (typeof document !== 'undefined') {
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', mount, { once: true });
	} else {
		mount();
	}
}
