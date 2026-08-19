/**
 * The wallet identity layer — single source of truth for an agent's custodial
 * wallet wherever an avatar or agent appears (profile, marketplace card,
 * directory row, avatar page, dashboards, trending, characters, galaxy, launches).
 *
 * A wallet is an identity, not a label. At a glance this component shows the
 * vanity-aware address, the live portfolio value in USD, ownership ("Yours" vs
 * "by @creator"), a micro 24h P&L, and that the agent is multi-chain (Solana +
 * EVM). On hover / focus / tap it expands into a rich preview popover: the
 * balance broken out (SOL / USDC / $THREE / other), top holdings, both chain
 * addresses, and the role-appropriate actions (Deposit/Vanity/Open-wallet for the
 * owner; Tip/Fork-to-own for a visitor). The full Wallet HUD opens from the
 * popover's "Open wallet" affordance.
 *
 * One component, one truth: the SAME agent's wallet looks identical in the
 * galaxy, the marketplace, and its profile because every surface renders from
 * here. There is no shared agent-card in this codebase (each surface rolls its
 * own markup), so the consistency lives in this module.
 *
 * Ownership model: a wallet is owned per (user, agent) — the creator of an
 * avatar/agent controls its wallet, and a fork mints a brand-new wallet owned by
 * the forker (api/agents/fork.js). The chip never exposes secret material — only
 * public addresses, public balances, the vanity prefix/suffix, copy + explorer.
 *
 * Real data only: balances and P&L hydrate from POST /api/agents/balances, which
 * reads live chain state (Helius DAS → public RPC) and derives 24h change from
 * real persisted value snapshots. A wallet with no value history yet renders the
 * empty sparkline, never a fake curve. Hydration is lazy (IntersectionObserver),
 * batched (one request per visible batch), and pauses when the tab is hidden or
 * the chip scrolls offscreen — no request storms, no runaway intervals.
 *
 * Reads the address from any agent OR avatar record shape:
 *   agent.solana_address | agent.meta.solana_address | agent.agent_solana_address
 *   agent.wallet (base58)         | avatar.agent_solana_address
 * the EVM address from:
 *   agent.wallet_address | agent.meta.wallet_address | agent.evm_address
 * the vanity pattern from:
 *   agent.solana_vanity_prefix/suffix | agent.meta.solana_vanity_prefix/suffix
 *   avatar.agent_solana_vanity_prefix/suffix
 * so a surface can pass whichever record it already holds without reshaping it.
 */

import { computeRarity } from '../solana/vanity/rarity.js';
import { formatWalletUsd, shortAddress } from './wallet-format.js';
import { tierForUsd, computeWalletVisual } from './wallet-networth.js';

const STYLE_ID = 'tws-agent-wallet-chip-styles';
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_RE = /^0x[0-9a-fA-F]{40}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function esc(s) {
	return String(s == null ? '' : s).replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
	);
}

/**
 * Normalize any agent/avatar record into the canonical wallet descriptor, or
 * null when there is no custodial Solana wallet yet. This is THE normalizer the
 * chip, the popover, and the Wallet HUD all consume — every surface passes its
 * existing agent object and the field aliasing is handled here.
 *
 * @returns {null | {
 *   address: string, prefix: string|null, suffix: string|null, isVanity: boolean,
 *   rarity: {tier,label,accent,score}|null, evmAddress: string|null,
 *   ownerId: string|null, ownerName: string|null, forkedFrom: object|null,
 *   explorerUrl: string, evmExplorerUrl: string|null, hubUrl: string|null,
 *   galleryUrl: string, agentId: string|null, name: string|null, avatarUrl: string|null
 * }}
 */
export function getWalletStatus(agent) {
	if (!agent || typeof agent !== 'object') return null;
	const meta = agent.meta || {};
	const address =
		agent.solana_address || meta.solana_address || agent.agent_solana_address ||
		(typeof agent.wallet === 'string' && BASE58_RE.test(agent.wallet) ? agent.wallet : null) ||
		null;
	if (!address || !BASE58_RE.test(String(address))) return null;

	const prefix =
		agent.solana_vanity_prefix || meta.solana_vanity_prefix || agent.agent_solana_vanity_prefix || null;
	const suffix =
		agent.solana_vanity_suffix || meta.solana_vanity_suffix || agent.agent_solana_vanity_suffix || null;
	// Prefer the linked-agent id on avatar rows (agent_id) so the hub deep-link
	// targets the agent that owns the wallet, not the avatar row id. Agent records
	// have no agent_id field, so this falls through to their own id.
	const agentId = agent.agent_id || agent.agentId || agent.id || null;

	// EVM side of the multi-chain identity. Never treat a Solana base58 as EVM.
	const evmRaw =
		agent.wallet_address || meta.wallet_address || agent.evm_address || meta.evm_address ||
		(typeof agent.wallet === 'string' && EVM_RE.test(agent.wallet) ? agent.wallet : null) || null;
	const evmAddress = evmRaw && EVM_RE.test(String(evmRaw)) ? String(evmRaw) : null;

	// Ownership attribution: the owner's id (for an isOwner cross-check) and a
	// human handle to render "by @creator" on a visitor's view. Fork lineage
	// carries the original creator when this is a forked agent.
	const forkedFrom = meta.forked_from || agent.forked_from || null;
	const ownerId = agent.user_id || agent.owner_id || meta.user_id || null;
	const ownerName =
		agent.owner_name || agent.owner_handle || meta.owner_name ||
		agent.owner?.display_name || agent.owner?.handle || null;

	const pre = prefix ? String(prefix) : null;
	const suf = suffix ? String(suffix) : null;
	const isVanity = !!(pre || suf);
	// Honest rarity tier from the SAME model the proof-of-grind gallery uses, so a
	// rare agent address advertises its tier everywhere the chip appears. Only an
	// actual vanity pattern that the address really satisfies earns a tier — a
	// claimed prefix that doesn't match the address is ignored.
	let rarity = null;
	if (isVanity) {
		const addr = String(address);
		const realPrefix = pre && addr.startsWith(pre) ? pre : '';
		const realSuffix = suf && addr.endsWith(suf) ? suf : '';
		if (realPrefix || realSuffix) {
			const r = computeRarity({ prefix: realPrefix, suffix: realSuffix });
			if (r.tier !== 'common') rarity = { tier: r.tier, label: r.tierLabel, accent: r.accent, score: r.rarityScore };
		}
	}

	const name = agent.name || agent.display_name || agent.agent_name || null;
	const avatarUrl =
		agent.avatar_thumbnail_url || agent.avatar_url || agent.profile_image_url || agent.image_url || null;

	return {
		address: String(address),
		prefix: pre,
		suffix: suf,
		isVanity,
		rarity,
		evmAddress,
		ownerId,
		ownerName: ownerName ? String(ownerName) : null,
		forkedFrom,
		explorerUrl: `https://solscan.io/account/${address}`,
		evmExplorerUrl: evmAddress ? `https://basescan.org/address/${evmAddress}` : null,
		hubUrl: agentId ? `/agents/${agentId}/wallet` : null,
		galleryUrl: `/vanity/gallery?address=${encodeURIComponent(String(address))}`,
		agentId,
		name: name ? String(name) : null,
		avatarUrl: avatarUrl ? String(avatarUrl) : null,
	};
}

/** Alias under the wallet-identity name for HUD / future consumers. */
export const getWalletIdentity = getWalletStatus;

/** True when the agent has a custodial Solana wallet. */
export function hasWallet(agent) {
	return getWalletStatus(agent) != null;
}

// ── value formatting ──────────────────────────────────────────────────────────
// Compact USD + address shortening live in ./wallet-format.js (the single source
// of truth for the whole wallet program). Re-exported here so the many surfaces
// that already import { formatWalletUsd } from the chip keep working unchanged.
export { formatWalletUsd };

function formatPct(p) {
	if (p == null || !Number.isFinite(p)) return null;
	const sign = p > 0 ? '+' : '';
	return `${sign}${p.toFixed(p > -10 && p < 10 ? 1 : 0)}%`;
}

function formatTokenAmount(n) {
	if (n == null || !Number.isFinite(n)) return '0';
	if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
	if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
	if (n >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
	if (n >= 1) return n.toFixed(2);
	return n.toPrecision(2);
}

/**
 * The single vanity-aware address highlighter for the whole wallet program. When
 * the address really begins with `prefix` / ends with `suffix`, that segment is
 * shown verbatim and emphasized (`twc-hi`); otherwise the head/tail fall back to a
 * plain `head`/`tail`-length slice. Returns the inner spans only (no wrapper), so
 * the chip, the popover, and the living-avatar nameplate all render the same
 * "license plate" — reuse this, never reimplement the head/tail/highlight logic.
 *
 * @param {string} address  base58 Solana address
 * @param {string|null} prefix  claimed vanity prefix (highlighted only if it matches)
 * @param {string|null} suffix  claimed vanity suffix (highlighted only if it matches)
 * @param {{head?:number, tail?:number}} [opts]
 * @returns {string} HTML: `<span[ class="twc-hi"]>head</span><span class="twc-dots">…</span><span[…]>tail</span>`
 */
export function highlightAddress(address, prefix, suffix, { head = 4, tail = 4 } = {}) {
	const a = String(address || '');
	const headHi = !!(prefix && a.startsWith(prefix));
	const tailHi = !!(suffix && a.endsWith(suffix));
	const headTxt = headHi ? prefix : a.slice(0, head);
	const tailTxt = tailHi ? suffix : a.slice(-tail);
	return (
		`<span class="${headHi ? 'twc-hi' : ''}">${esc(headTxt)}</span>` +
		`<span class="twc-dots">…</span>` +
		`<span class="${tailHi ? 'twc-hi' : ''}">${esc(tailTxt)}</span>`
	);
}

/** Render the short, vanity-aware address label (prefix/suffix highlighted). */
function addressLabelHTML(status) {
	return `<span class="twc-addr">${highlightAddress(status.address, status.prefix, status.suffix, { head: 4, tail: 4 })}</span>`;
}

/** Build a tiny sparkline SVG from a real value series (empty state when sparse). */
function sparklineSVG(points, { up = true, w = 56, h = 16, cls = '' } = {}) {
	const stroke = up ? 'var(--success,#4ade80)' : 'var(--danger,#f87171)';
	if (!Array.isArray(points) || points.length < 2) {
		return (
			`<svg class="twc-spark ${cls}" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true" data-empty="1">` +
			`<line x1="1" y1="${h - 2}" x2="${w - 1}" y2="${h - 2}" stroke="var(--stroke-strong,rgba(255,255,255,.18))" stroke-width="1" stroke-dasharray="2 3"/>` +
			`</svg>`
		);
	}
	const min = Math.min(...points);
	const max = Math.max(...points);
	const span = max - min || 1;
	const stepX = (w - 2) / (points.length - 1);
	const coords = points.map((v, i) => {
		const x = 1 + i * stepX;
		const y = h - 1 - ((v - min) / span) * (h - 2);
		return `${x.toFixed(1)},${y.toFixed(1)}`;
	});
	const last = coords[coords.length - 1].split(',');
	return (
		`<svg class="twc-spark ${cls}" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true">` +
		`<polyline points="${coords.join(' ')}" fill="none" stroke="${stroke}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>` +
		`<circle cx="${last[0]}" cy="${last[1]}" r="1.6" fill="${stroke}"/>` +
		`</svg>`
	);
}

/** Inject the shared chip stylesheet once. Idempotent and SSR-safe. */
export function ensureWalletChipStyles() {
	if (typeof document === 'undefined') return;
	if (document.getElementById(STYLE_ID)) return;
	const style = document.createElement('style');
	style.id = STYLE_ID;
	style.textContent = `
.twc{display:inline-flex;align-items:center;gap:7px;padding:3px 9px;border-radius:999px;
	font:600 11px/1 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
	color:var(--wallet-accent,#c4b5fd);background:var(--wallet-accent-soft,rgba(139,92,246,.1));
	border:1px solid var(--wallet-stroke,rgba(139,92,246,.3));
	white-space:nowrap;vertical-align:middle;max-width:100%;cursor:default;
	transition:border-color .18s ease,background .18s ease,box-shadow .25s ease;}
.twc[data-twc-trigger]{cursor:pointer;}
.twc[data-twc-trigger]:hover,.twc[data-twc-trigger]:focus-visible{border-color:var(--wallet-stroke-strong,rgba(139,92,246,.5));background:var(--wallet-accent-fill,rgba(139,92,246,.15));}
.twc:focus-visible{outline:none;box-shadow:0 0 0 2px var(--wallet-glow,rgba(139,92,246,.45));}
.twc[data-vanity="true"]{color:var(--wallet-accent-strong,#a78bfa);background:var(--wallet-accent-fill,rgba(139,92,246,.15));border-color:var(--wallet-stroke-strong,rgba(139,92,246,.5));}
.twc[data-owner="1"]{border-color:var(--wallet-stroke-strong,rgba(139,92,246,.5));}
/* Dense mode: fill a narrow card footer and wrap badges onto a second line inside
   the same rounded container instead of overflowing the card into its neighbours. */
.twc[data-dense="1"]{display:flex;flex-wrap:wrap;width:100%;max-width:100%;box-sizing:border-box;white-space:normal;
	border-radius:12px;column-gap:7px;row-gap:5px;padding:6px 10px;align-items:center;}
.twc[data-dense="1"] .twc-addr{min-width:0;overflow:hidden;text-overflow:ellipsis;}
.twc[data-dense="1"] .twc-bal,
.twc[data-dense="1"] .twc-make,
.twc[data-dense="1"] button.twc-make{border-left:0;padding-left:0;margin-left:0;}
.twc-ico{width:11px;height:11px;flex:none;opacity:.8;}
.twc-addr{font-family:var(--font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);letter-spacing:.01em;display:inline-flex;gap:1px;}
.twc-hi{color:var(--ink-bright,#fff);font-weight:700;}
.twc-dots{opacity:.5;}
.twc-own{font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:.05em;color:var(--bg-0,#0a0a0a);
	background:linear-gradient(135deg,var(--wallet-accent,#c4b5fd),var(--wallet-accent-strong,#a78bfa));
	padding:1px 5px;border-radius:999px;line-height:1.4;}
.twc-bal{display:inline-flex;align-items:center;gap:4px;font-family:var(--font-mono,ui-monospace,Menlo,monospace);
	font-weight:700;font-size:11px;color:var(--ink-bright,#fff);border-left:1px solid var(--wallet-stroke,rgba(139,92,246,.3));padding-left:7px;}
.twc-tierdot{width:6px;height:6px;border-radius:50%;flex:none;background:var(--twc-tier,var(--wallet-accent,#c4b5fd));
	box-shadow:0 0 5px var(--twc-tier,var(--wallet-glow,rgba(139,92,246,.45)));}
@media (prefers-reduced-motion: reduce){.twc-tierdot{box-shadow:none;}}
.twc-bal-sk{display:inline-block;width:30px;height:9px;border-radius:3px;
	background:linear-gradient(90deg,rgba(255,255,255,.06),rgba(255,255,255,.16),rgba(255,255,255,.06));
	background-size:200% 100%;animation:twc-sk 1.1s ease-in-out infinite;}
@keyframes twc-sk{0%{background-position:200% 0}100%{background-position:-200% 0}}
.twc-chg{font-size:10px;font-weight:700;}
.twc-chg[data-dir="up"]{color:var(--success,#4ade80);}
.twc-chg[data-dir="down"]{color:var(--danger,#f87171);}
.twc-chg[data-dir="flat"]{color:var(--ink-faint,rgba(255,255,255,.45));}
.twc-bal-na{color:var(--ink-faint,rgba(255,255,255,.45));font-weight:600;}
.twc.twc-pulse{box-shadow:0 0 0 0 var(--wallet-glow,rgba(139,92,246,.45));animation:twc-pulse 1.1s ease-out;}
@keyframes twc-pulse{0%{box-shadow:0 0 0 0 var(--wallet-glow,rgba(139,92,246,.5))}70%{box-shadow:0 0 0 7px rgba(139,92,246,0)}100%{box-shadow:0 0 0 0 rgba(139,92,246,0)}}
.twc-float{position:absolute;font:700 10px/1 var(--font-mono,ui-monospace,Menlo,monospace);color:var(--success,#4ade80);
	pointer-events:none;animation:twc-float 1.4s ease-out forwards;z-index:60;}
@keyframes twc-float{0%{opacity:0;transform:translateY(4px)}20%{opacity:1}100%{opacity:0;transform:translateY(-14px)}}
.twc-act{appearance:none;background:none;border:none;padding:0 2px;margin:0;cursor:pointer;color:inherit;
	opacity:.65;display:inline-flex;align-items:center;transition:opacity .15s ease,transform .12s ease;}
.twc-act:hover{opacity:1;}
.twc-act:active{transform:scale(.9);}
.twc-act:focus-visible{outline:2px solid var(--wallet-glow,rgba(139,92,246,.7));outline-offset:2px;border-radius:4px;}
.twc-act svg{width:12px;height:12px;}
a.twc-link{color:inherit;text-decoration:none;display:inline-flex;align-items:center;}
.twc-make{font-weight:600;font-size:10px;color:var(--wallet-accent-strong,#a78bfa);text-decoration:none;
	border-left:1px solid var(--wallet-stroke,rgba(139,92,246,.3));padding-left:7px;margin-left:1px;white-space:nowrap;transition:color .15s ease;}
.twc-make:hover{color:var(--ink-bright,#fff);}
button.twc-make{appearance:none;background:none;border:none;border-left:1px solid var(--wallet-stroke,rgba(139,92,246,.3));cursor:pointer;
	font-family:inherit;line-height:1;padding:0 0 0 7px;}
button.twc-make:active{transform:scale(.95);}
button.twc-make:focus-visible{outline:2px solid var(--wallet-glow,rgba(139,92,246,.7));outline-offset:2px;border-radius:4px;}
.twc-vanity-tag{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;opacity:.8;}
a.twc-rarity{font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:.05em;text-decoration:none;
	padding:1px 6px;border-radius:999px;color:#06060b;line-height:1.4;white-space:nowrap;transition:transform .12s ease,filter .15s ease;}
a.twc-rarity:hover{transform:translateY(-1px);filter:brightness(1.08);}
a.twc-rarity:focus-visible{outline:2px solid rgba(255,255,255,.7);outline-offset:2px;}
.twc-pending{color:var(--ink-dim,#888);background:rgba(255,255,255,.04);border-color:var(--stroke,rgba(255,255,255,.1));}
.twc-copied{color:var(--success,#4ade80)!important;}
@media (prefers-reduced-motion: reduce){.twc-act,.twc{transition:none;}.twc-bal-sk,.twc.twc-pulse,.twc-float{animation:none;}}

/* ── rich preview popover (portaled to <body>) ───────────────────────────── */
.twc-pop{position:fixed;z-index:2147483600;width:300px;max-width:calc(100vw - 16px);
	background:var(--surface-2,rgba(20,20,24,.96));border:1px solid var(--wallet-stroke-strong,rgba(139,92,246,.5));
	border-radius:var(--radius-lg,14px);padding:14px;color:var(--ink,#e8e8e8);
	box-shadow:var(--shadow-3,0 24px 60px rgba(0,0,0,.6));backdrop-filter:blur(var(--blur-md,14px));
	font:400 12px/1.45 var(--font-body,Inter,system-ui,sans-serif);
	opacity:0;transform:translateY(4px) scale(.98);transition:opacity .16s ease,transform .16s ease;}
.twc-pop[data-open="1"]{opacity:1;transform:none;}
.twc-pop-head{display:flex;align-items:center;gap:9px;margin-bottom:10px;}
.twc-pop-av{width:30px;height:30px;border-radius:8px;object-fit:cover;background:var(--surface-3,rgba(255,255,255,.08));flex:none;}
.twc-pop-id{min-width:0;flex:1;}
.twc-pop-name{font-weight:700;color:var(--ink-bright,#fff);font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.twc-pop-own{font-size:10px;color:var(--ink-dim,#888);display:flex;align-items:center;gap:4px;margin-top:1px;}
.twc-pop-own b{color:var(--wallet-accent,#c4b5fd);font-weight:700;}
.twc-pop-total{display:flex;align-items:flex-end;justify-content:space-between;gap:8px;margin-bottom:10px;}
.twc-pop-usd{font:800 24px/1 var(--font-display,"Space Grotesk",system-ui);color:var(--ink-bright,#fff);font-feature-settings:"tnum";}
.twc-pop-pnl{display:flex;flex-direction:column;align-items:flex-end;gap:3px;}
.twc-pop-chg{font:700 12px/1 var(--font-mono,ui-monospace,Menlo);}
.twc-pop-chg[data-dir="up"]{color:var(--success,#4ade80);}
.twc-pop-chg[data-dir="down"]{color:var(--danger,#f87171);}
.twc-pop-chg[data-dir="flat"]{color:var(--ink-faint,rgba(255,255,255,.45));}
.twc-pop-rows{display:flex;flex-direction:column;gap:1px;margin-bottom:10px;border-radius:8px;overflow:hidden;}
.twc-row{display:flex;align-items:center;gap:8px;padding:6px 8px;background:var(--surface-1,rgba(255,255,255,.03));}
.twc-row-sym{font-weight:700;color:var(--ink-bright,#fff);font-size:11px;display:flex;align-items:center;gap:6px;min-width:0;}
.twc-row-sym img{width:15px;height:15px;border-radius:50%;flex:none;background:var(--surface-3,rgba(255,255,255,.08));}
.twc-row-three{color:var(--wallet-accent,#c4b5fd);}
.twc-row-amt{margin-left:auto;font-family:var(--font-mono,ui-monospace,Menlo);font-size:10.5px;color:var(--ink-dim,#aaa);white-space:nowrap;}
.twc-row-usd{font-family:var(--font-mono,ui-monospace,Menlo);font-size:11px;color:var(--ink-bright,#fff);min-width:48px;text-align:right;font-feature-settings:"tnum";}
.twc-pop-addrs{display:flex;flex-direction:column;gap:5px;margin-bottom:11px;}
.twc-pop-addr{display:flex;align-items:center;gap:7px;font-family:var(--font-mono,ui-monospace,Menlo);font-size:10.5px;}
.twc-pop-addr .twc-chain{font-size:8.5px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;padding:1px 5px;border-radius:5px;flex:none;
	background:var(--wallet-accent-soft,rgba(139,92,246,.12));color:var(--wallet-accent,#c4b5fd);}
.twc-pop-addr .twc-chain[data-chain="evm"]{background:rgba(99,102,241,.14);color:#a5b4fc;}
.twc-pop-addr .twc-amono{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ink-dim,#bbb);}
.twc-pop-addr .twc-hi{color:var(--ink-bright,#fff);}
.twc-pop-acts{display:flex;flex-wrap:wrap;gap:6px;}
.twc-btn{appearance:none;cursor:pointer;font:700 11px/1 var(--font-body,Inter,system-ui);border-radius:999px;
	padding:7px 11px;border:1px solid var(--wallet-stroke-strong,rgba(139,92,246,.5));
	background:var(--wallet-accent-soft,rgba(139,92,246,.1));color:var(--wallet-accent,#c4b5fd);
	display:inline-flex;align-items:center;gap:5px;transition:background .15s ease,transform .12s ease,color .15s ease;}
.twc-btn:hover{background:var(--wallet-accent-fill,rgba(139,92,246,.18));color:var(--ink-bright,#fff);}
.twc-btn:active{transform:scale(.96);}
.twc-btn:focus-visible{outline:2px solid var(--wallet-glow,rgba(139,92,246,.7));outline-offset:2px;}
.twc-btn-primary{background:linear-gradient(135deg,var(--wallet-accent,#c4b5fd),var(--wallet-accent-strong,#a78bfa));color:var(--bg-0,#0a0a0a);border-color:transparent;}
.twc-btn-primary:hover{filter:brightness(1.06);color:var(--bg-0,#0a0a0a);}
.twc-pop-empty{font-size:10.5px;color:var(--ink-faint,rgba(255,255,255,.45));text-align:center;padding:2px 0 8px;}
.twc-pop-mini{display:inline-flex;align-items:center;gap:6px;}
`;
	(document.head || document.documentElement).appendChild(style);
}

const COPY_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const LINK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>';
const WALLET_SVG = '<svg class="twc-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/><path d="M18 12a2 2 0 0 0 0 4h4v-4Z"/></svg>';

/** Compact descriptor the tip modal needs, encoded onto the Tip button. */
function tipAttrs(agent, status) {
	const name = agent?.name || agent?.display_name || status.name || '';
	const avatar = status.avatarUrl || '';
	const accepted = (agent?.meta?.payments?.accepted_tokens || agent?.payments?.accepted_tokens || []).join(',');
	const agentId = status.agentId || agent?.id || agent?.agent_id || '';
	return (
		`data-twc-tip="${esc(status.address)}"` +
		(agentId ? ` data-twc-id="${esc(agentId)}"` : '') +
		(name ? ` data-twc-name="${esc(name)}"` : '') +
		(avatar ? ` data-twc-av="${esc(avatar)}"` : '') +
		(accepted ? ` data-twc-pay="${esc(accepted)}"` : '')
	);
}

/**
 * Render the wallet chip as an HTML string for template-string render sites
 * (card grids). Returns a "wallet pending" chip when no address is present yet so
 * the surface still communicates that every agent has a wallet.
 *
 * @param {object} agent  Any supported agent record shape.
 * @param {object} [opts]
 * @param {boolean} [opts.isOwner=false]  Owner sees the vanity entry point + the
 *   "Yours" marker; a non-owner sees creator attribution + a Tip action.
 * @param {boolean} [opts.showPending=true]  Render a pending chip when no wallet.
 * @param {boolean} [opts.link=true]  Make the address a copy/explorer affordance.
 *   When false (chip lives inside a card <a>) NO nested <a> is emitted.
 * @param {boolean} [opts.tip=true]  Show the Tip action to non-owners.
 * @param {boolean} [opts.balance=true]  Render + lazily hydrate the live balance.
 * @param {boolean} [opts.popover=true]  Enable the rich preview popover.
 * @param {string}  [opts.network='mainnet']  Cluster for the balance read.
 * @param {boolean} [opts.dense=false]  Render a full-width chip whose badges wrap
 *   onto a second line inside the same rounded container — for narrow card footers
 *   (avatar/agent grids) where the single-line pill would otherwise overflow.
 */
export function walletChipHTML(agent, opts = {}) {
	ensureWalletChipStyles();
	const {
		isOwner = false, showPending = true, link = true, tip = true,
		balance = true, popover = true, network = 'mainnet', reputation = true,
		dense = false,
	} = opts;
	const status = getWalletStatus(agent);

	if (!status) {
		if (!showPending) return '';
		return `<span class="twc twc-pending"${dense ? ' data-dense="1"' : ''} title="Wallet provisioning">${WALLET_SVG}<span>Wallet pending</span></span>`;
	}

	// Live balance + rich popover only make sense when the chip is backed by a real
	// agent_identities row. Some surfaces (KOL/trader leaderboards) pass non-agent
	// rows that still carry an address+vanity — those render the static chip but
	// skip hydration so they never show a stuck skeleton or a dead popover action.
	const isRealAgent = !!(status.agentId && UUID_RE.test(String(status.agentId)));
	const wantBalance = balance && isRealAgent;
	const wantPopover = popover && isRealAgent;

	// A matched vanity address advertises its honest rarity tier (tinted); when the
	// chip is interactive it links to the address's appraisal in the proof-of-grind
	// gallery, otherwise (link:false, used inside card anchors) it stays a plain
	// span so we never nest an <a> in an <a>. An unmatched/plain-vanity pattern
	// falls back to the neutral "vanity" tag.
	const vanityTag = status.rarity
		? link
			? `<a class="twc-rarity" href="${esc(status.galleryUrl)}" style="background:${esc(status.rarity.accent)}" title="Rarity ${esc(status.rarity.label)} · score ${esc(status.rarity.score)} — appraise on three.ws" data-twc-stop>${esc(status.rarity.label)}</a>`
			: `<span class="twc-rarity" style="background:${esc(status.rarity.accent)}" title="Rarity ${esc(status.rarity.label)} · score ${esc(status.rarity.score)}">${esc(status.rarity.label)}</span>`
		: status.isVanity
			? '<span class="twc-vanity-tag">vanity</span>'
			: '';

	// Ownership marker — the user's core ask: make ownership legible everywhere.
	// Owner gets a compact "Yours" badge; a visitor's attribution ("by @creator")
	// lives in the popover to keep dense list rows tidy.
	const ownerBadge = isOwner ? '<span class="twc-own" title="You own this wallet">Yours</span>' : '';

	// Wallet-trust badge — the wallet as a credibility signal. A self-hydrating
	// placeholder that fills (or honestly removes itself for a brand-new agent)
	// from the real reputation score. Only meaningful for a real agent row.
	const repSlot =
		reputation && isRealAgent
			? `<span class="rep-badge-slot" data-rep-aid="${esc(status.agentId)}"${link ? '' : ' data-rep-embedded="1"'} data-twc-rep aria-label="Wallet trust score loading"></span>`
			: '';

	// Live balance slot — renders a skeleton, then hydrates to "$1.2K +2.3%" on
	// viewport-enter via POST /api/agents/balances. Read-only display, safe inside
	// card anchors (it's a <span>, no nested <a>).
	const balanceSlot = wantBalance
		? `<span class="twc-bal" data-twc-bal aria-label="Wallet value loading"><span class="twc-bal-sk"></span></span>`
		: '';

	const copyBtn = link
		? `<button type="button" class="twc-act" data-twc-copy="${esc(status.address)}" title="Copy address" aria-label="Copy wallet address">${COPY_SVG}</button>`
		: '';
	const explorerLink = link
		? `<a class="twc-act twc-link" href="${esc(status.explorerUrl)}" target="_blank" rel="noopener noreferrer" title="View on Solscan" aria-label="View wallet on Solscan" data-twc-stop>${LINK_SVG}</a>`
		: '';
	// Owner → grind a vanity address (routes to the hub's money-safe swap).
	// Non-owner → tip the agent directly from their own wallet. A non-owner can
	// never grind/assign a vanity to an agent they don't own.
	const ownerAction =
		isOwner && !status.isVanity && status.hubUrl
			? `<a class="twc-make" href="${esc(status.hubUrl)}#vanity" title="Grind a custom vanity address" data-twc-stop>✦ Vanity</a>`
			: '';
	const tipBtn =
		!isOwner && tip
			? `<button type="button" class="twc-make twc-tip" ${tipAttrs(agent, status)} title="Tip ${esc(status.name || 'this agent')}" data-twc-stop>◎ Tip</button>`
			: '';

	// Stash everything the popover needs as JSON so wiring can build it without
	// re-normalizing. Kept off the visible chip; only public data.
	const popData = wantPopover
		? esc(JSON.stringify({
				agentId: status.agentId, address: status.address, evm: status.evmAddress,
				name: status.name, avatar: status.avatarUrl, isVanity: status.isVanity,
				prefix: status.prefix, suffix: status.suffix, hubUrl: status.hubUrl,
				explorerUrl: status.explorerUrl, evmExplorerUrl: status.evmExplorerUrl,
				galleryUrl: status.galleryUrl, isOwner, ownerName: status.ownerName,
				forkedFrom: status.forkedFrom ? { owner_name: status.forkedFrom.owner_name, agent_id: status.forkedFrom.agent_id } : null,
				rarity: status.rarity, network,
				accepted: (agent?.meta?.payments?.accepted_tokens || agent?.payments?.accepted_tokens || []),
			}))
		: '';

	// `link:false` means the chip lives inside a clickable card; mark it embedded
	// so the popover stays a hover/focus enhancement there and never hijacks the
	// card's own tap/navigation.
	const triggerAttrs = wantPopover
		? ` data-twc-trigger tabindex="0" role="button" aria-haspopup="dialog" aria-expanded="false"${link ? '' : ' data-twc-embedded="1"'} data-twc-pop="${popData}"`
		: '';
	const hydrateAttrs = wantBalance
		? ` data-twc-aid="${esc(status.agentId)}" data-twc-net="${esc(network)}"${isOwner ? ' data-twc-isowner="1"' : ''}`
		: '';

	const title = `Agent wallet ${status.address}${status.isVanity ? ' (vanity)' : ''}`;
	return (
		`<span class="twc" data-vanity="${status.isVanity}" data-owner="${isOwner ? '1' : '0'}"${dense ? ' data-dense="1"' : ''}${triggerAttrs}${hydrateAttrs} title="${esc(title)}">` +
		WALLET_SVG +
		addressLabelHTML(status) +
		ownerBadge +
		repSlot +
		vanityTag +
		balanceSlot +
		copyBtn +
		explorerLink +
		ownerAction +
		tipBtn +
		`</span>`
	);
}

/**
 * Render the wallet chip as a wired DOM node (copy button works, links don't
 * bubble to a parent card handler, balance hydrates, popover wired). Returns null
 * only when there's no wallet and showPending is false.
 */
export function walletChipEl(agent, opts = {}) {
	const html = walletChipHTML(agent, opts);
	if (!html) return null;
	const tpl = document.createElement('template');
	tpl.innerHTML = html.trim();
	const node = tpl.content.firstElementChild;
	if (node) wireWalletChip(node);
	return node;
}

/**
 * Wire copy buttons, stop-propagation links, balance hydration, and the popover
 * inside a container that holds one or more chips rendered as HTML strings. Call
 * this once after injecting card markup that used walletChipHTML(). Idempotent
 * per element.
 */
export function wireWalletChips(root) {
	if (!root || typeof root.querySelectorAll !== 'function') return;
	const chips = new Set();
	for (const el of root.querySelectorAll('.twc[data-twc-aid],.twc[data-twc-trigger],[data-twc-rep],[data-twc-copy],[data-twc-stop],[data-twc-tip]')) {
		chips.add(el.classList?.contains('twc') ? el : el.closest('.twc'));
	}
	for (const chip of chips) if (chip) wireWalletChip(chip);
}

function wireWalletChip(node) {
	if (!node || node.__twcWired) return;
	node.__twcWired = true;
	for (const stop of node.querySelectorAll?.('[data-twc-stop]') || []) {
		stop.addEventListener('click', (e) => e.stopPropagation());
	}
	const tipBtn = node.querySelector?.('[data-twc-tip]');
	if (tipBtn) {
		tipBtn.addEventListener('click', async (e) => {
			e.preventDefault();
			e.stopPropagation();
			const agent = {
				id: tipBtn.getAttribute('data-twc-id') || undefined,
				solana_address: tipBtn.getAttribute('data-twc-tip'),
				name: tipBtn.getAttribute('data-twc-name') || 'this agent',
				avatar_thumbnail_url: tipBtn.getAttribute('data-twc-av') || '',
				meta: { payments: { accepted_tokens: (tipBtn.getAttribute('data-twc-pay') || '').split(',').filter(Boolean) } },
			};
			try {
				const { openTipModal } = await import('./agent-tip-modal.js');
				openTipModal(agent);
			} catch {
				/* modal failed to load — the address is still copyable from the chip */
			}
		});
	}
	const btn = node.matches?.('[data-twc-copy]') ? node : node.querySelector?.('[data-twc-copy]');
	if (btn) btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); copyToClipboard(btn.getAttribute('data-twc-copy'), btn); });

	// Live balance hydration: register with the shared observer/poller.
	if (node.hasAttribute?.('data-twc-aid')) registerForHydration(node);
	// Rich preview popover.
	if (node.hasAttribute?.('data-twc-trigger')) wirePopoverTrigger(node);
	// Wallet-trust badge: lazily hydrate the placeholder from the real score.
	const repSlot = node.querySelector?.('[data-twc-rep]');
	if (repSlot && !repSlot.__repObserved) {
		repSlot.__repObserved = true;
		import('./agent-reputation.js')
			.then((m) => m.observeReputationBadge(repSlot))
			.catch(() => {});
	}
}

async function copyToClipboard(addr, btn) {
	if (!addr) return;
	try {
		await navigator.clipboard.writeText(addr);
		if (!btn) return;
		const prev = btn.innerHTML;
		btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';
		btn.classList.add('twc-copied');
		setTimeout(() => { btn.innerHTML = prev; btn.classList.remove('twc-copied'); }, 1400);
	} catch {
		/* clipboard denied — no-op, the address is visible in the chip */
	}
}

// ── live balance hydration manager ──────────────────────────────────────────
// One IntersectionObserver + one poll loop for every chip on the page. Chips
// register on wire; we batch the agent ids of whatever is currently on-screen
// into a single POST /api/agents/balances, patch their balance slots, and pulse
// on a real increase. Polling pauses when the tab is hidden and stops entirely
// when nothing is on-screen — no request storms, no runaway intervals.

const _nodesByAgent = new Map(); // agentId -> Set<chipNode>
const _liveAgents = new Set();   // currently intersecting agent ids
const _lastUsd = new Map();      // agentId -> last seen usd (for pulse detection)
let _io = null;
let _pendingFlush = null;
let _pollTimer = null;
const POLL_MS = 30_000;

function isBrowser() {
	return typeof window !== 'undefined' && typeof document !== 'undefined';
}

function ensureObserver() {
	if (_io || !isBrowser() || typeof IntersectionObserver === 'undefined') return _io;
	_io = new IntersectionObserver((entries) => {
		let changed = false;
		for (const entry of entries) {
			const aid = entry.target.getAttribute('data-twc-aid');
			if (!aid) continue;
			if (entry.isIntersecting) {
				if (!_liveAgents.has(aid)) { _liveAgents.add(aid); changed = true; }
			} else {
				_liveAgents.delete(aid);
			}
		}
		if (changed) scheduleFlush();
		syncPolling();
	}, { rootMargin: '120px' });
	document.addEventListener('visibilitychange', syncPolling);
	return _io;
}

function registerForHydration(node) {
	if (!isBrowser() || node.__twcHydrated) return;
	node.__twcHydrated = true;
	const aid = node.getAttribute('data-twc-aid');
	if (!aid) return;
	let set = _nodesByAgent.get(aid);
	if (!set) { set = new Set(); _nodesByAgent.set(aid, set); }
	set.add(node);
	const io = ensureObserver();
	if (io) io.observe(node);
	else { _liveAgents.add(aid); scheduleFlush(); } // no IO support → hydrate once
}

function scheduleFlush() {
	if (_pendingFlush) return;
	_pendingFlush = setTimeout(() => { _pendingFlush = null; flushHydration(); }, 90);
}

function pruneDisconnected() {
	for (const [aid, set] of _nodesByAgent) {
		for (const n of set) if (!n.isConnected) set.delete(n);
		if (set.size === 0) { _nodesByAgent.delete(aid); _liveAgents.delete(aid); _lastUsd.delete(aid); }
	}
}

async function flushHydration() {
	if (!isBrowser()) return;
	pruneDisconnected();
	const ids = [..._liveAgents].filter((id) => _nodesByAgent.has(id));
	if (ids.length === 0) return;
	// Group by network so a devnet chip never reads mainnet balances.
	const byNet = new Map();
	for (const id of ids) {
		const node = [..._nodesByAgent.get(id)][0];
		const net = node?.getAttribute('data-twc-net') || 'mainnet';
		if (!byNet.has(net)) byNet.set(net, []);
		byNet.get(net).push(id);
	}
	let apiFetch;
	try { ({ apiFetch } = await import('../api.js')); }
	catch { apiFetch = (p, o) => fetch(p, { credentials: 'include', ...o }); }

	for (const [net, netIds] of byNet) {
		for (let i = 0; i < netIds.length; i += 60) {
			const chunk = netIds.slice(i, i + 60);
			try {
				const res = await apiFetch('/api/agents/balances', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ ids: chunk, network: net }),
					allowAnonymous: true,
				});
				if (!res.ok) continue;
				const { data } = await res.json();
				for (const id of chunk) applyHydration(id, data?.[id]);
			} catch {
				for (const id of chunk) markBalanceUnavailable(id);
			}
		}
	}
	syncPolling();
}

function applyHydration(agentId, entry) {
	const set = _nodesByAgent.get(agentId);
	if (!set) return;
	if (!entry || entry.usd == null) { markBalanceUnavailable(agentId); return; }

	const prev = _lastUsd.get(agentId);
	const increased = prev != null && entry.usd > prev + 1e-6;
	_lastUsd.set(agentId, entry.usd);

	for (const node of set) {
		if (!node.isConnected) continue;
		node.__twcWallet = entry; // popover reads this
		const slot = node.querySelector('.twc-bal');
		if (slot) {
			const usdLabel = formatWalletUsd(entry.usd) || '$0';
			const pct = entry.pnl?.changePct;
			const dir = pct == null ? null : pct > 0.05 ? 'up' : pct < -0.05 ? 'down' : 'flat';
			const chg = dir ? `<span class="twc-chg" data-dir="${dir}">${esc(formatPct(pct))}</span>` : '';
			// Embodied finance in 2D: a tier dot so the chip reads at the SAME wealth
			// tier as the agent's 3D aura everywhere. Derived for free from the USD the
			// chip already fetched (pure tierForUsd) — no extra request. Dormant ($0)
			// shows no dot, so an empty wallet stays clean, never a fake mark.
			const tier = tierForUsd(entry.usd);
			const dot = tier.level > 0
				? `<span class="twc-tierdot" style="--twc-tier:${esc(computeWalletVisual({ usdTotal: entry.usd, mix: { sol: 1 }, hasThree: false }).accent)}" title="${esc(tier.label)} tier"></span>`
				: '';
			node.dataset.tier = tier.key;
			slot.innerHTML = `${dot}<span class="twc-usd">${esc(usdLabel)}</span>${chg}`;
			slot.setAttribute('aria-label', `Wallet value ${usdLabel}${pct != null ? `, ${formatPct(pct)} over ${entry.pnl?.windowHours || 24} hours` : ''}`);
		}
		if (increased) pulseChip(node, entry.usd - prev);
	}
	// A popover currently open for this agent refreshes live.
	if (_openPopover && _openPopover.agentId === agentId) renderPopoverBody(_openPopover.el, entry, _openPopover.meta);
}

function markBalanceUnavailable(agentId) {
	const set = _nodesByAgent.get(agentId);
	if (!set) return;
	for (const node of set) {
		const slot = node.querySelector?.('.twc-bal');
		if (slot && slot.querySelector('.twc-bal-sk')) {
			slot.innerHTML = '<span class="twc-bal-na" title="Balance temporarily unavailable">—</span>';
			slot.setAttribute('aria-label', 'Wallet value unavailable');
		}
	}
}

function pulseChip(node, deltaUsd) {
	if (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
	node.classList.remove('twc-pulse');
	void node.offsetWidth; // restart animation
	node.classList.add('twc-pulse');
	setTimeout(() => node.classList.remove('twc-pulse'), 1200);
	const label = formatWalletUsd(deltaUsd);
	if (label && node.isConnected) {
		const float = document.createElement('span');
		float.className = 'twc-float';
		float.textContent = `+${label}`;
		const r = node.getBoundingClientRect();
		float.style.left = `${r.right - 8}px`;
		float.style.top = `${r.top - 2}px`;
		document.body.appendChild(float);
		setTimeout(() => float.remove(), 1500);
	}
}

function syncPolling() {
	if (!isBrowser()) return;
	const shouldPoll = _liveAgents.size > 0 && document.visibilityState === 'visible';
	if (shouldPoll && !_pollTimer) {
		_pollTimer = setInterval(() => { if (document.visibilityState === 'visible') flushHydration(); }, POLL_MS);
	} else if (!shouldPoll && _pollTimer) {
		clearInterval(_pollTimer);
		_pollTimer = null;
	}
}

// ── rich preview popover ────────────────────────────────────────────────────

let _openPopover = null; // { el, agentId, meta, trigger }
let _hoverTimer = null;
let _meCache; // cached /api/auth/me probe (logged-in detection for visitor CTAs)

async function probeLoggedIn() {
	if (_meCache !== undefined) return _meCache;
	try {
		const res = await fetch('/api/auth/me', { credentials: 'include' });
		_meCache = res.ok;
	} catch { _meCache = false; }
	return _meCache;
}

function wirePopoverTrigger(node) {
	let meta = null;
	try { meta = JSON.parse(node.getAttribute('data-twc-pop') || 'null'); } catch { meta = null; }
	if (!meta) return;

	const open = () => openPopover(node, meta);
	const closeSoon = () => { clearTimeout(_hoverTimer); _hoverTimer = setTimeout(() => closePopover(node), 180); };
	const openSoon = () => { clearTimeout(_hoverTimer); _hoverTimer = setTimeout(open, 280); };

	node.addEventListener('pointerenter', (e) => { if (e.pointerType !== 'touch') openSoon(); });
	node.addEventListener('pointerleave', (e) => { if (e.pointerType !== 'touch') closeSoon(); });
	node.addEventListener('focus', open);
	node.addEventListener('blur', () => { if (!_openPopover || !_openPopover.el.matches(':hover')) closeSoon(); });
	node.addEventListener('keydown', (e) => {
		if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); _openPopover?.trigger === node ? closePopover(node) : open(); }
		else if (e.key === 'Escape') closePopover(node);
	});
	// Touch: a standalone chip (not embedded in a clickable card, not inside an
	// anchor) toggles the popover. Embedded/card chips leave the tap to the card's
	// own navigation — the popover stays a hover/focus enhancement there.
	if (!node.closest('a') && !node.hasAttribute('data-twc-embedded')) {
		node.addEventListener('click', (e) => {
			if (e.target.closest('[data-twc-stop],[data-twc-copy],[data-twc-tip]')) return;
			e.preventDefault();
			e.stopPropagation();
			_openPopover?.trigger === node ? closePopover(node) : open();
		});
	}
}

function openPopover(trigger, meta) {
	if (_openPopover && _openPopover.trigger === trigger) return;
	if (_openPopover) closePopover(_openPopover.trigger);
	ensureWalletChipStyles();
	const el = document.createElement('div');
	el.className = 'twc-pop';
	el.setAttribute('role', 'dialog');
	el.setAttribute('aria-label', `Wallet of ${meta.name || 'agent'}`);
	el.addEventListener('pointerenter', () => clearTimeout(_hoverTimer));
	el.addEventListener('pointerleave', () => { clearTimeout(_hoverTimer); _hoverTimer = setTimeout(() => closePopover(trigger), 180); });
	document.body.appendChild(el);
	_openPopover = { el, agentId: meta.agentId, meta, trigger };
	trigger.setAttribute('aria-expanded', 'true');

	renderPopoverBody(el, trigger.__twcWallet || null, meta);
	positionPopover(el, trigger);
	requestAnimationFrame(() => el.setAttribute('data-open', '1'));

	// If balances haven't hydrated for this chip yet, nudge a flush.
	if (!trigger.__twcWallet) { _liveAgents.add(meta.agentId); scheduleFlush(); }

	if (!_outsideBound) {
		document.addEventListener('keydown', onGlobalKey, true);
		window.addEventListener('scroll', onGlobalScroll, true);
		window.addEventListener('resize', onGlobalScroll);
		_outsideBound = true;
	}
}

let _outsideBound = false;
function onGlobalKey(e) { if (e.key === 'Escape' && _openPopover) closePopover(_openPopover.trigger); }
function onGlobalScroll() { if (_openPopover) positionPopover(_openPopover.el, _openPopover.trigger); }

function closePopover(trigger) {
	if (!_openPopover || (trigger && _openPopover.trigger !== trigger)) return;
	const { el, trigger: t } = _openPopover;
	t?.setAttribute('aria-expanded', 'false');
	el.removeAttribute('data-open');
	_openPopover = null;
	setTimeout(() => el.remove(), 180);
}

function positionPopover(el, trigger) {
	const r = trigger.getBoundingClientRect();
	const pw = el.offsetWidth || 300;
	const ph = el.offsetHeight || 220;
	let left = r.left;
	if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
	if (left < 8) left = 8;
	let top = r.bottom + 8;
	if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 8);
	el.style.left = `${Math.round(left)}px`;
	el.style.top = `${Math.round(top)}px`;
}

function vanityAddrHTML(meta) {
	return highlightAddress(meta.address, meta.prefix, meta.suffix, { head: 6, tail: 6 });
}

function renderPopoverBody(el, entry, meta) {
	const owned = meta.isOwner;
	const creator = meta.ownerName || meta.forkedFrom?.owner_name || null;
	const ownLine = owned
		? '<span class="twc-pop-own"><b>Yours</b> · you control this wallet</span>'
		: creator
			? `<span class="twc-pop-own">by <b>@${esc(creator)}</b></span>`
			: '<span class="twc-pop-own">Public agent wallet</span>';

	const avatar = meta.avatar
		? `<img class="twc-pop-av" src="${esc(meta.avatar)}" alt="" loading="lazy"/>`
		: `<span class="twc-pop-av"></span>`;

	// Total + P&L.
	let totalBlock;
	if (entry && entry.usd != null) {
		const pct = entry.pnl?.changePct;
		const dir = pct == null ? 'flat' : pct > 0.05 ? 'up' : pct < -0.05 ? 'down' : 'flat';
		const spark = sparklineSVG(entry.pnl?.sparkline, { up: dir !== 'down', w: 64, h: 20 });
		const chgLabel = pct == null
			? '<span class="twc-pop-chg" data-dir="flat" title="No value history yet">— tracking</span>'
			: `<span class="twc-pop-chg" data-dir="${dir}" title="${esc(formatPct(pct))} over ${entry.pnl?.windowHours || 24}h">${esc(formatPct(pct))}${entry.pnl?.changeUsd != null ? ` (${entry.pnl.changeUsd >= 0 ? '+' : ''}${esc(formatWalletUsd(Math.abs(entry.pnl.changeUsd)) || '$0')})` : ''}</span>`;
		totalBlock =
			`<div class="twc-pop-total"><div class="twc-pop-usd">${esc(formatWalletUsd(entry.usd) || '$0')}</div>` +
			`<div class="twc-pop-pnl">${spark}${chgLabel}</div></div>`;
	} else {
		totalBlock = `<div class="twc-pop-total"><div class="twc-pop-usd"><span class="twc-bal-sk" style="width:56px;height:18px"></span></div></div>`;
	}

	// Breakdown rows: SOL / USDC / $THREE / +N other.
	let rows = '';
	if (entry && entry.usd != null) {
		const r = [];
		if (entry.sol) r.push(rowHTML('SOL', entry.sol.amount, entry.sol.usd, null, false));
		if (entry.usdc && (entry.usdc.amount > 0 || entry.usdc.usd > 0)) r.push(rowHTML('USDC', entry.usdc.amount, entry.usdc.usd, null, false));
		if (entry.three) r.push(rowHTML('$THREE', entry.three.amount, entry.three.usd, null, true));
		const shown = new Set(['SOL', 'USDC', '$THREE']);
		for (const h of entry.topHoldings || []) {
			if (r.length >= 4) break;
			const sym = h.symbol || h.mint?.slice(0, 4) || '?';
			if (shown.has(sym)) continue;
			if (entry.three && h.mint && entry.three.mint === h.mint) continue;
			r.push(rowHTML(sym, h.amount, h.usd, h.logo, false));
			shown.add(sym);
		}
		if (r.length) rows = `<div class="twc-pop-rows">${r.join('')}</div>`;
		else rows = '<div class="twc-pop-empty">This wallet is empty — fund it to get started.</div>';
	}

	// Addresses (multi-chain).
	const addrs =
		`<div class="twc-pop-addrs">` +
		`<div class="twc-pop-addr"><span class="twc-chain" data-chain="sol">SOL</span>` +
		`<span class="twc-amono">${vanityAddrHTML(meta)}</span>` +
		`<button type="button" class="twc-act" data-twc-copy="${esc(meta.address)}" title="Copy Solana address" aria-label="Copy Solana address">${COPY_SVG}</button>` +
		`<a class="twc-act twc-link" href="${esc(meta.explorerUrl)}" target="_blank" rel="noopener noreferrer" title="Solscan" aria-label="View on Solscan">${LINK_SVG}</a></div>` +
		(meta.evm
			? `<div class="twc-pop-addr"><span class="twc-chain" data-chain="evm">EVM</span>` +
				`<span class="twc-amono">${esc(shortAddress(meta.evm, 6, 4))}</span>` +
				`<button type="button" class="twc-act" data-twc-copy="${esc(meta.evm)}" title="Copy EVM address" aria-label="Copy EVM address">${COPY_SVG}</button>` +
				(meta.evmExplorerUrl ? `<a class="twc-act twc-link" href="${esc(meta.evmExplorerUrl)}" target="_blank" rel="noopener noreferrer" title="Basescan" aria-label="View on Basescan">${LINK_SVG}</a>` : '') +
				`</div>`
			: '') +
		`</div>`;

	// Role-appropriate actions.
	const acts = [];
	acts.push(`<button type="button" class="twc-btn twc-btn-primary" data-twc-open-hud title="Open the full wallet">${WALLET_SVG}<span>Open wallet</span></button>`);
	if (owned) {
		if (!meta.isVanity && meta.hubUrl) acts.push(`<a class="twc-btn" href="${esc(meta.hubUrl)}#vanity">✦ Vanity</a>`);
		acts.push(`<button type="button" class="twc-btn" data-twc-stream-earn title="See ${esc(meta.name || 'this agent')}'s streaming income">◎ Earnings</button>`);
		acts.push(`<button type="button" class="twc-btn" data-twc-share>↗ Share</button>`);
	} else {
		acts.push(`<button type="button" class="twc-btn twc-stream" data-twc-stream title="Stream ${esc(meta.name || 'this agent')} by the second">◎ Stream</button>`);
		acts.push(`<button type="button" class="twc-btn twc-tip" ${tipAttrs({ meta: { payments: { accepted_tokens: meta.accepted || [] } } }, { address: meta.address, name: meta.name, avatarUrl: meta.avatar })} title="Tip ${esc(meta.name || 'this agent')}">◎ Tip</button>`);
		acts.push(`<button type="button" class="twc-btn" data-twc-fork>⑂ Fork to own</button>`);
	}
	const actions = `<div class="twc-pop-acts">${acts.join('')}</div>`;

	el.innerHTML =
		`<div class="twc-pop-head">${avatar}<div class="twc-pop-id">` +
		`<div class="twc-pop-name">${esc(meta.name || 'Agent wallet')}</div>${ownLine}</div></div>` +
		totalBlock + rows + addrs + actions;

	wirePopoverActions(el, meta);
}

function rowHTML(symbol, amount, usd, logo, isThree) {
	const img = logo ? `<img src="${esc(logo)}" alt="" loading="lazy"/>` : '';
	return (
		`<div class="twc-row"><span class="twc-row-sym ${isThree ? 'twc-row-three' : ''}">${img}${esc(symbol)}</span>` +
		`<span class="twc-row-amt">${esc(formatTokenAmount(amount))}</span>` +
		`<span class="twc-row-usd">${esc(formatWalletUsd(usd) || '$0')}</span></div>`
	);
}

function wirePopoverActions(el, meta) {
	for (const c of el.querySelectorAll('[data-twc-copy]')) {
		c.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); copyToClipboard(c.getAttribute('data-twc-copy'), c); });
	}
	const hud = el.querySelector('[data-twc-open-hud]');
	if (hud) hud.addEventListener('click', () => {
		// Handoff to the Wallet HUD (task 02). If no HUD is mounted, fall back to
		// the wallet hub page so the affordance is never a dead end.
		const detail = { agentId: meta.agentId, address: meta.address, isOwner: meta.isOwner };
		let handled = false;
		const ev = new CustomEvent('tws:open-wallet-hud', { detail, cancelable: true });
		window.dispatchEvent(ev);
		handled = ev.defaultPrevented;
		if (!handled && meta.hubUrl) window.location.href = meta.hubUrl;
	});
	const tip = el.querySelector('.twc-tip');
	if (tip) tip.addEventListener('click', async () => {
		try {
			const { openTipModal } = await import('./agent-tip-modal.js');
			openTipModal({ solana_address: meta.address, name: meta.name, avatar_thumbnail_url: meta.avatar || '', meta: { payments: { accepted_tokens: meta.accepted || [] } } });
		} catch { /* address still copyable */ }
	});
	// Money Stream — pay-per-second (visitor) or live earnings (owner). Both open
	// the shared panel; the panel renders the role-appropriate view.
	const streamAgent = () => ({
		id: meta.agentId, solana_address: meta.address, name: meta.name,
		avatar_thumbnail_url: meta.avatar || '', isOwner: meta.isOwner,
		meta: { payments: { accepted_tokens: meta.accepted || [] } },
	});
	const stream = el.querySelector('[data-twc-stream]');
	if (stream) stream.addEventListener('click', async () => {
		try {
			const { openStreamPanel } = await import('./agent-money-stream.js');
			openStreamPanel(streamAgent(), { network: meta.network || 'mainnet', mode: 'stream' });
		} catch { /* address still copyable */ }
	});
	const streamEarn = el.querySelector('[data-twc-stream-earn]');
	if (streamEarn) streamEarn.addEventListener('click', async () => {
		try {
			const { openStreamPanel } = await import('./agent-money-stream.js');
			openStreamPanel(streamAgent(), { network: meta.network || 'mainnet', mode: 'earnings' });
		} catch { /* noop */ }
	});
	const fork = el.querySelector('[data-twc-fork]');
	if (fork) fork.addEventListener('click', async () => {
		const dest = `/agents/${meta.agentId}`;
		const loggedIn = await probeLoggedIn();
		// Forking mints the caller their own wallet (POST /api/avatars/fork). The
		// fork-to-own CTA + its auth/CSRF handling already live on the agent's own
		// page — route there rather than re-implementing the fork here. Anonymous
		// visitors go through sign-in first and land back on that page.
		window.location.href = loggedIn ? dest : `/login?next=${encodeURIComponent(dest)}`;
	});
	const share = el.querySelector('[data-twc-share]');
	if (share) share.addEventListener('click', async () => {
		const shareUrl = `${location.origin}/agents/${meta.agentId}`;
		try {
			const mod = await import('./share.js');
			if (mod.showSharePanel) {
				// share.js entity contract: { kind, id, title, description, shareUrl }.
				mod.showSharePanel({
					kind: 'agent',
					id: meta.agentId,
					title: meta.name || 'Agent wallet',
					description: `${meta.name || 'This agent'}'s wallet on three.ws`,
					shareUrl,
				}, share);
				return;
			}
		} catch { /* fall through to clipboard */ }
		copyToClipboard(shareUrl, share);
	});
}

if (typeof window !== 'undefined') {
	window.twsAgentWalletChip = {
		getWalletStatus, getWalletIdentity, hasWallet, walletChipHTML, walletChipEl,
		wireWalletChips, ensureWalletChipStyles, formatWalletUsd, highlightAddress,
	};
}
