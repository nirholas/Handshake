// dashboard-next — IRL Agents.
//
// Monitor and manage the 3D AI agents you've placed at real-world GPS
// locations — from any device, not just from the spot where you pinned them.
//
// Per placement the owner can see and control:
//   • Balance        — the agent's Solana wallet balance (GET /api/agents/:id/solana)
//   • Reputation     — public reputation score (GET /api/irl/agent-card?id=…)
//   • Services       — the paid services the agent offers IRL
//   • Interactions   — live feed of people who tapped the agent in real life
//                      (GET /api/irl/interactions?mine=1), incl. their messages
//   • Outfit         — jump to the avatar wardrobe to re-skin it
//   • Location       — re-position / re-aim the pin remotely (PATCH /api/irl/pins)
//   • Caption, View in IRL, Remove
//
// Endpoints:
//   GET    /api/irl/pins?mine=1                  → { pins }
//   GET    /api/irl/interactions?mine=1          → { interactions, unread }
//   PATCH  /api/irl/interactions { }             → mark all seen
//   GET    /api/irl/agent-card?id=<agentId>      → { card }
//   GET    /api/agents/:id/solana                → { data: { balance } }
//   PATCH  /api/irl/pins { id, caption|lat|lng|heading } → { pin }
//   DELETE /api/irl/pins?id=<id>                 → { ok: true }

import { mountShell } from '../shell.js';
import { requireUser, get, post, patch, esc, relTime } from '../api.js';
import { skeletonHTML, emptyStateHTML, errorStateHTML, ensureStateKitStyles } from '../../shared/state-kit.js';
import { loadInto } from '../../shared/async-state.js';
import { loadLeaflet, reverseGeocode } from '../../shared/leaflet-loader.js';
import { mountReputationPanel } from './irl-reputation.js';
import { openMyDataPanel } from '../../irl/privacy-center.js';
import { renderQRToSVG } from '../../erc8004/qr.js';
import { buildVisitUrl, buildSignUrl } from '../../irl/visit-link.js';

// ── Services / x402 skill pricing ───────────────────────────────────────────
// Canonical prices live in agent_skill_prices and feed the x402 manifest +
// priceFor() (api/agents/x402/[action].js). The owner attaches a skill the
// agent exposes and sets a per-call price; a passer-by then pays for it IRL.

// Solana mint validity — matches api/agent-skill-price.js:14. Base-chain USDC is
// a 0x EVM address that fails this, so IRL skill pricing is Solana-mint only.
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// The only currencies offered — the platform coin and Solana USDC. Both are
// 6-decimal SPL mints, so the displayed price (e.g. 0.05) converts to atomic
// units with 10**6. Never a third token.
const CURRENCIES = [
	{ key: 'three', label: '$THREE', mint: 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump', decimals: 6, chain: 'solana' },
	{ key: 'usdc',  label: 'USDC',   mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6, chain: 'solana' },
];
function currencyForMint(mint) {
	return CURRENCIES.find((c) => c.mint === mint)
		|| { label: `${String(mint).slice(0, 4)}…${String(mint).slice(-4)}`, mint, decimals: 6, chain: 'solana' };
}
// Displayed decimal → integer atomic units (what the API stores).
function toAtomic(display, decimals) {
	return Math.round(Number(display) * 10 ** decimals);
}
// Integer atomic units → human price string (maximumFractionDigits drops any
// trailing zeros, so 50000 @ 6dp → "0.05", 1000000 @ 6dp → "1"). Grouped with
// thousands separators for display — $THREE is cheap, so per-call prices can run
// to thousands of units and "1,500 $THREE" reads better than "1500 $THREE".
function fromAtomic(amount, decimals) {
	const n = Number(amount) / 10 ** decimals;
	if (!Number.isFinite(n)) return '0';
	return n.toLocaleString('en-US', { maximumFractionDigits: decimals });
}
// Same conversion WITHOUT grouping separators — for prefilling a <input
// type="number">, which silently blanks on a value containing commas. So a
// 1,500-unit price stays editable instead of vanishing when the owner taps Edit.
function fromAtomicInput(amount, decimals) {
	const n = Number(amount) / 10 ** decimals;
	if (!Number.isFinite(n)) return '0';
	return n.toLocaleString('en-US', { maximumFractionDigits: decimals, useGrouping: false });
}

function haversineDist(lat1, lng1, lat2, lng2) {
	const R = 6371000;
	const dLat = (lat2 - lat1) * Math.PI / 180;
	const dLng = (lng2 - lng1) * Math.PI / 180;
	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
		Math.sin(dLng / 2) ** 2;
	return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
function compassLabel(deg) {
	return COMPASS[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
}

function expiryLabel(expiresAt) {
	if (!expiresAt) return '<span class="irl-badge perm">Permanent</span>';
	const ms = new Date(expiresAt) - Date.now();
	if (ms < 0) return '<span class="irl-badge expired">Expired</span>';
	const days = Math.floor(ms / 86400000);
	const hrs  = Math.floor((ms % 86400000) / 3600000);
	return `<span class="irl-badge expiring">Expires in ${days}d ${hrs}h</span>`;
}

// Placement-exposure badge (H4) — how this pin's coordinate is stored. An
// approximate pin was deliberately blurred to a radius and its true spot was
// never saved; a precise (or legacy, NULL placement_kind) pin sits exactly where
// placed. Lets the owner see how exposed each placement is at a glance.
function placementBadge(pin) {
	if (pin.placement_kind === 'approximate') {
		const r = Math.round(Number(pin.fuzz_radius_m) || 0);
		return `<span class="irl-badge approx" title="Stored at a deliberately blurred spot — your exact location was never saved">≈ Approximate${r ? ` ~${r}m` : ''}</span>`;
	}
	return '<span class="irl-badge exact" title="Stored at the exact spot you placed it">📍 Exact</span>';
}

// Live status pill from the agent-summary-derived status. Self-contained
// (inline token colours) so it has no external CSS dependency.
const STATUS_META = {
	online:  { c: 'var(--nxt-success, #4ade80)', label: 'Online' },
	visible: { c: 'var(--nxt-warn, #fbbf24)',    label: 'Visible' },
	expired: { c: 'var(--nxt-ink-faint, #555)',  label: 'Expired' },
};
function statusBadge(status) {
	const s = STATUS_META[status] || STATUS_META.visible;
	return `<span class="irl-status-pill" title="${s.label}" style="display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:600;color:${s.c};flex-shrink:0">`
		+ `<span style="width:7px;height:7px;border-radius:50%;background:${s.c}"></span>${s.label}</span>`;
}

// Reverse-geocode via the shared multi-provider geocoder (leaflet-loader.js):
// Nominatim → Photon → BigDataCloud, memoized per ~11 m cell over there — so
// the cards and the inbox modal share one cache and one politeness policy.
function placeFor(lat, lng) {
	if (lat == null || lng == null) return Promise.resolve(null);
	return reverseGeocode(lat, lng);
}

const INTERACTION_ICON = { view: '👁', tap: '👆', message: '💬', pay: '💸', talk: '🗣' };

// Mints we can name in a pay row. $THREE + Solana USDC come from CURRENCIES;
// Base USDC (an EVM 0x mint) is matched case-insensitively. Anything else renders
// as a truncated mint — we never invent or substitute a coin name.
const PAY_MINTS = {
	'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump': { label: '$THREE', decimals: 6 },
	'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': { label: 'USDC',   decimals: 6 },
	'0x833589fcd6edb6e08f4c7c32d4f71b54bda02913':   { label: 'USDC',   decimals: 6 },
};
function payMint(mint) {
	if (!mint) return { label: '', decimals: 6 };
	return PAY_MINTS[mint] || PAY_MINTS[String(mint).toLowerCase()]
		|| { label: `${String(mint).slice(0, 4)}…${String(mint).slice(-4)}`, decimals: 6 };
}
// "0.05 USDC" from atomic units + the row's mint. Empty when the amount is absent.
function payAmountLabel(ix) {
	const m = payMint(ix.currency_mint);
	if (ix.amount == null) return m.label;
	const human = (Number(ix.amount) / 10 ** m.decimals).toLocaleString('en-US', { maximumFractionDigits: m.decimals });
	return m.label ? `${human} ${m.label}` : human;
}

// Block-explorer deep link, chain inferred from signature shape / network hint
// (mirrors api/irl/interactions.js explorerTxUrl). Solscan is the default.
const EVM_TX_RE = /^0x[0-9a-fA-F]{64}$/;
function explorerTxUrl(sig, network) {
	if (!sig || typeof sig !== 'string') return null;
	const net = String(network || '').toLowerCase();
	if (EVM_TX_RE.test(sig) || net.includes('base') || net.includes('eip155')) return `https://basescan.org/tx/${sig}`;
	return `https://solscan.io/tx/${sig}`;
}

// Whether a row is the owner's own reply (server-stamped, never client-trusted).
const isOwnerReply = (ix) => ix.payload?.from === 'owner';
// One-line "who did what", with the paid amount inlined for pays.
function ixHeadline(ix) {
	if (ix.type === 'pay') {
		const amt = payAmountLabel(ix);
		return amt ? `Someone paid ${esc(amt)}` : 'Someone paid your agent';
	}
	if (ix.type === 'tap')     return 'Tapped your agent';
	if (ix.type === 'talk')    return 'Talked with your agent in person';
	if (ix.type === 'message') return isOwnerReply(ix) ? 'You replied' : 'Someone left a message';
	return 'Someone viewed your agent';
}

const EMPTY_IX_HTML = `<div class="irl-ix-empty">No one has interacted with this agent in person yet. Share its location to get discovered.</div>`;

// Compact feed row shown inside each placement card.
function interactionLine(ix) {
	const owner   = isOwnerReply(ix);
	const unread  = !ix.seen_at && !owner;
	const icon    = INTERACTION_ICON[ix.type] || '•';
	const msg     = ix.message ? `<span class="irl-ix-msg">“${esc(ix.message)}”</span>` : '';
	const tx      = ix.type === 'pay' ? explorerTxUrl(ix.payload?.signature, ix.payload?.network) : null;
	const txLink  = tx ? ` · <a class="irl-ix-link" href="${esc(tx)}" target="_blank" rel="noopener">View tx ↗</a>` : '';
	// Replies are composed in the inbox surface — the card row just opens it.
	const reply   = (ix.type === 'message' && !owner)
		? ` · <button class="irl-ix-link" data-reply-open type="button">Reply</button>` : '';
	return `<div class="irl-ix${owner ? ' owner' : ''}${unread ? ' unread' : ''}">
		<span class="irl-ix-icon" aria-hidden="true">${icon}</span>
		<div class="irl-ix-body"><span class="irl-ix-who">${ixHeadline(ix)}</span>${msg}
		<span class="irl-ix-time">${esc(relTime(ix.created_at))}${txLink}${reply}</span></div></div>`;
}

const STYLE = `
<style>
.irl-wrap { display: grid; gap: var(--space-4, 16px); }
.irl-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.irl-header h2 { font-size: 18px; font-weight: 700; margin: 0; display: flex; align-items: center; gap: 10px; }

/* Multiplayer AR info banner */
.irl-mp-banner { display: flex; align-items: flex-start; gap: 12px; padding: 14px 16px; border-radius: var(--nxt-radius); border: 1px solid color-mix(in srgb, var(--nxt-accent) 22%, transparent); background: color-mix(in srgb, var(--nxt-accent) 5%, transparent); }
.irl-mp-banner .mp-icon { font-size: 20px; flex-shrink: 0; line-height: 1.3; }
.irl-mp-banner .mp-body { flex: 1; font-size: 13px; color: var(--nxt-ink-dim); line-height: 1.5; }
.irl-mp-banner .mp-body strong { color: var(--nxt-ink); display: block; margin-bottom: 2px; font-size: 13px; }

/* Skills chips */
.irl-skills { display: flex; flex-wrap: wrap; gap: 6px; }
.irl-skill { font-size: 11px; padding: 3px 9px; border-radius: 999px; background: color-mix(in srgb, #7c3aed 12%, transparent); color: #a78bfa; border: 1px solid color-mix(in srgb, #7c3aed 30%, transparent); white-space: nowrap; }
.irl-btn { display: inline-flex; align-items: center; gap: 6px; padding: 8px 16px; border-radius: var(--nxt-radius-sm); border: 1px solid var(--nxt-stroke); background: var(--nxt-bg-2); color: var(--nxt-ink); cursor: pointer; font-size: 13px; font-weight: 600; text-decoration: none; transition: border-color .14s, transform .12s; }
.irl-btn:hover { border-color: var(--nxt-stroke-strong); transform: translateY(-1px); }
.irl-btn:active { transform: translateY(0); }
.irl-btn:focus-visible { outline: 2px solid var(--nxt-accent); outline-offset: 2px; }
.irl-btn.primary { background: var(--nxt-accent); color: #061018; border-color: transparent; }
.irl-btn.primary:hover { filter: brightness(1.06); }

/* New-interactions banner */
.irl-feed-banner { display: flex; align-items: center; gap: 12px; padding: 12px 16px; border-radius: var(--nxt-radius); border: 1px solid color-mix(in srgb, var(--nxt-accent) 28%, transparent); background: color-mix(in srgb, var(--nxt-accent) 7%, transparent); }
.irl-feed-banner .txt { flex: 1; font-size: 13px; color: var(--nxt-ink); }
.irl-feed-banner b { color: var(--nxt-accent); }

.irl-card { background: var(--nxt-panel, var(--nxt-bg-1)); border: 1px solid var(--nxt-stroke); border-radius: var(--nxt-radius); overflow: hidden; }
.irl-card-head { display: flex; align-items: center; gap: 12px; padding: 14px 16px; }
.irl-av { width: 48px; height: 48px; border-radius: 11px; object-fit: cover; background: var(--nxt-bg-2); border: 1px solid var(--nxt-stroke); flex-shrink: 0; }
.irl-av-fallback { width: 48px; height: 48px; border-radius: 11px; background: linear-gradient(135deg, #1a2035, #0d1018); border: 1px solid var(--nxt-stroke); display: flex; align-items: center; justify-content: center; font-size: 18px; flex-shrink: 0; }
.irl-info { flex: 1; min-width: 0; }
.irl-name { font-weight: 600; font-size: 15px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.irl-meta { font-size: 12px; color: var(--nxt-ink-faint); margin-top: 3px; display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.irl-badge { font-size: 11px; padding: 2px 7px; border-radius: 999px; border: 1px solid transparent; white-space: nowrap; }
.irl-badge.perm { color: var(--nxt-success); background: color-mix(in srgb, var(--nxt-success) 10%, transparent); border-color: color-mix(in srgb, var(--nxt-success) 30%, transparent); }
.irl-badge.expired { color: var(--nxt-ink-faint); background: var(--nxt-bg-2); border-color: var(--nxt-stroke); }
.irl-badge.expiring { color: var(--nxt-warn); background: color-mix(in srgb, var(--nxt-warn) 10%, transparent); border-color: color-mix(in srgb, var(--nxt-warn) 30%, transparent); }
.irl-badge.exact { color: var(--nxt-success); background: color-mix(in srgb, var(--nxt-success) 9%, transparent); border-color: color-mix(in srgb, var(--nxt-success) 26%, transparent); }
.irl-badge.approx { color: var(--nxt-accent); background: color-mix(in srgb, var(--nxt-accent) 10%, transparent); border-color: color-mix(in srgb, var(--nxt-accent) 30%, transparent); cursor: help; }

/* Stat chips: balance / reputation / services / visitors */
.irl-stats { display: flex; flex-wrap: wrap; gap: 8px; padding: 0 16px 12px; }
.irl-stat { display: flex; flex-direction: column; gap: 1px; padding: 7px 12px; border-radius: 10px; background: var(--nxt-bg-2); border: 1px solid var(--nxt-stroke); min-width: 76px; }
.irl-stat .k { font-size: 10px; text-transform: uppercase; letter-spacing: .05em; color: var(--nxt-ink-faint); }
.irl-stat .v { font-size: 14px; font-weight: 700; color: var(--nxt-ink); font-variant-numeric: tabular-nums; }
.irl-stat.skel .v { color: transparent; background: var(--nxt-stroke); border-radius: 4px; width: 40px; animation: irl-pulse 1.4s ease infinite; }
.irl-stat a.v { text-decoration: none; color: var(--nxt-accent); }

.irl-section { border-top: 1px solid var(--nxt-line, var(--nxt-stroke)); padding: 12px 16px; }
.irl-section-label { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--nxt-ink-faint); margin-bottom: 8px; display: flex; align-items: center; justify-content: space-between; }
.irl-section-label a { color: var(--nxt-accent); text-decoration: none; font-size: 11px; text-transform: none; letter-spacing: 0; }

/* Services */
.irl-svc-list { display: flex; flex-direction: column; gap: 6px; }
.irl-svc { display: flex; align-items: center; gap: 10px; font-size: 13px; }
.irl-svc-name { color: var(--nxt-ink); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.irl-svc-price { color: var(--nxt-success); font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }
.irl-svc-empty { font-size: 12px; color: var(--nxt-ink-faint); }

/* Inline link-style button (matches section-label affordances) */
.irl-link-btn { background: none; border: none; padding: 0; cursor: pointer; color: var(--nxt-accent); font: inherit; font-size: 12px; font-weight: 600; }
.irl-link-btn:hover { text-decoration: underline; }
.irl-link-btn:focus-visible { outline: 2px solid var(--nxt-accent); outline-offset: 2px; border-radius: 4px; }
.irl-link-btn:disabled { opacity: .6; cursor: default; text-decoration: none; }
.irl-link-btn.danger { color: var(--nxt-danger, #f87171); }

/* ── Services management modal ─────────────────────────────────────────────── */
.irl-modal-root { position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center; padding: 16px; }
.irl-modal-back { position: absolute; inset: 0; background: rgba(0,0,0,.62); backdrop-filter: blur(2px); animation: irl-fade .16s ease; }
.irl-modal { position: relative; width: min(560px, 100%); max-height: min(86vh, 760px); display: flex; flex-direction: column; background: var(--nxt-panel, var(--nxt-bg-1)); border: 1px solid var(--nxt-stroke); border-radius: var(--nxt-radius); box-shadow: 0 24px 64px rgba(0,0,0,.5); animation: irl-rise .2s cubic-bezier(.2,.7,.3,1); overflow: hidden; }
.irl-modal-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 16px 18px; border-bottom: 1px solid var(--nxt-stroke); }
.irl-modal-title { font-size: 16px; font-weight: 700; color: var(--nxt-ink); }
.irl-modal-sub { font-size: 12px; color: var(--nxt-ink-faint); margin-top: 2px; }
.irl-modal-x { background: none; border: none; color: var(--nxt-ink-faint); font-size: 22px; line-height: 1; cursor: pointer; padding: 0 4px; border-radius: 8px; transition: color .14s; }
.irl-modal-x:hover, .irl-modal-x:focus-visible { color: var(--nxt-ink); }
.irl-modal-x:focus-visible { outline: 2px solid var(--nxt-accent); outline-offset: 2px; }
.irl-modal-body { padding: 6px 18px 18px; overflow-y: auto; }
/* Visit link modal: QR + link + what a visitor sees */
.irl-visit-grid { display: grid; grid-template-columns: 168px minmax(0, 1fr); gap: 18px; align-items: start; padding-top: 12px; }
.irl-visit-qr { width: 168px; aspect-ratio: 1; border-radius: 12px; background: #fff; padding: 8px; border: 1px solid var(--nxt-stroke); }
.irl-visit-qr svg { width: 100%; height: 100%; display: block; }
.irl-visit-url { display: flex; gap: 8px; align-items: center; margin: 0 0 12px; }
.irl-visit-url input { flex: 1 1 auto; min-width: 0; font: 12.5px/1.2 var(--font-mono, ui-monospace, monospace); padding: 8px 10px; border-radius: 8px; border: 1px solid var(--nxt-stroke); background: var(--nxt-bg-0, transparent); color: var(--nxt-ink); }
.irl-visit-steps { margin: 0 0 14px; padding-left: 18px; color: var(--nxt-ink-dim); font-size: 13px; line-height: 1.5; }
.irl-visit-steps li + li { margin-top: 4px; }
.irl-visit-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.irl-visit-note { margin: 12px 0 0; font-size: 12px; color: var(--nxt-ink-faint); line-height: 1.5; }
@media (max-width: 520px) { .irl-visit-grid { grid-template-columns: 1fr; justify-items: center; } }
.irl-svc-sec { padding-top: 14px; }
.irl-svc-sec-h { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--nxt-ink-faint); margin-bottom: 10px; }
.irl-svc-count { color: var(--nxt-ink-dim); }

/* Priced-service rows */
.irl-pr-row { display: grid; grid-template-columns: 1fr auto; gap: 4px 12px; align-items: center; padding: 11px 13px; border-radius: 10px; border: 1px solid var(--nxt-stroke); background: var(--nxt-bg-2); margin-bottom: 8px; transition: border-color .2s, background .2s; }
.irl-pr-row.paused { opacity: .72; }
.irl-pr-row.saved { border-color: color-mix(in srgb, var(--nxt-success) 60%, transparent); background: color-mix(in srgb, var(--nxt-success) 9%, var(--nxt-bg-2)); }
.irl-pr-name { font-size: 14px; font-weight: 600; color: var(--nxt-ink); display: flex; align-items: center; gap: 8px; }
.irl-pr-tag { font-size: 10px; text-transform: uppercase; letter-spacing: .04em; padding: 1px 6px; border-radius: 999px; background: var(--nxt-bg-1); border: 1px solid var(--nxt-stroke); color: var(--nxt-ink-faint); font-weight: 600; }
.irl-pr-meta { font-size: 12px; color: var(--nxt-ink-faint); margin-top: 2px; }
.irl-pr-price { color: var(--nxt-success); font-weight: 700; font-variant-numeric: tabular-nums; }
.irl-pr-actions { grid-column: 2; grid-row: 1 / span 2; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; justify-content: flex-end; }
.irl-pr-input { width: 84px; padding: 5px 8px; border-radius: 8px; border: 1px solid var(--nxt-stroke); background: var(--nxt-bg-1); color: var(--nxt-ink); font: inherit; font-size: 13px; }
.irl-pr-input:focus-visible { outline: none; border-color: var(--nxt-accent); }
.irl-pr-cur { font-size: 12px; color: var(--nxt-ink-faint); }
.irl-pr-confirm { font-size: 12px; color: var(--nxt-ink-dim); }
.irl-pr-err { grid-column: 1 / -1; font-size: 12px; color: var(--nxt-danger, #f87171); }

/* Add-service form */
.irl-add-form { display: flex; flex-direction: column; gap: 12px; }
.irl-add-grid { display: grid; grid-template-columns: 1.3fr .9fr .9fr; gap: 10px; }
.irl-add-field { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.irl-add-field > span { font-size: 11px; color: var(--nxt-ink-faint); text-transform: uppercase; letter-spacing: .04em; }
.irl-add-field select, .irl-add-field input { padding: 9px 10px; border-radius: 9px; border: 1px solid var(--nxt-stroke); background: var(--nxt-bg-2); color: var(--nxt-ink); font: inherit; font-size: 13px; width: 100%; }
.irl-add-field select:focus-visible, .irl-add-field input:focus-visible { outline: none; border-color: var(--nxt-accent); }
.irl-add-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.irl-add-hint { font-size: 11px; color: var(--nxt-ink-faint); }
.irl-add-err { font-size: 12px; color: var(--nxt-danger, #f87171); }
@media (max-width: 520px) { .irl-add-grid { grid-template-columns: 1fr 1fr; } .irl-add-field:first-child { grid-column: 1 / -1; } }

@keyframes irl-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes irl-rise { from { opacity: 0; transform: translateY(10px) scale(.99); } to { opacity: 1; transform: none; } }

/* Interactions feed */
.irl-ix { display: flex; gap: 9px; padding: 6px 0; position: relative; }
.irl-ix.unread { padding-left: 12px; }
.irl-ix.unread::before { content: ''; position: absolute; left: 0; top: 12px; width: 6px; height: 6px; border-radius: 50%; background: var(--nxt-accent); }
.irl-ix.owner .irl-ix-who { color: var(--nxt-accent); }
.irl-ix-icon { font-size: 14px; line-height: 1.4; flex-shrink: 0; }
.irl-ix-body { display: flex; flex-direction: column; gap: 1px; font-size: 13px; min-width: 0; }
.irl-ix-who { color: var(--nxt-ink-dim); }
.irl-ix-msg { color: var(--nxt-ink); }
.irl-ix-time { font-size: 11px; color: var(--nxt-ink-faint); display: flex; flex-wrap: wrap; gap: 2px 4px; align-items: center; }
.irl-ix-link { background: none; border: none; padding: 0; font: inherit; font-size: 11px; color: var(--nxt-accent); cursor: pointer; text-decoration: none; }
.irl-ix-link:hover { text-decoration: underline; }
.irl-ix-empty { font-size: 12px; color: var(--nxt-ink-faint); }

/* Caption + management */
.irl-card-body { border-top: 1px solid var(--nxt-line, var(--nxt-stroke)); padding: 12px 16px; display: flex; gap: 10px; align-items: flex-start; flex-wrap: wrap; }
.irl-caption { font-size: 13px; color: var(--nxt-ink-dim); flex: 1; min-width: 120px; cursor: pointer; padding: 4px 6px; border-radius: 6px; border: 1px solid transparent; transition: border-color .12s; }
.irl-caption:hover { border-color: var(--nxt-stroke); }
.irl-caption:focus-visible { outline: 2px solid var(--nxt-accent); outline-offset: 1px; border-color: var(--nxt-stroke); }
.irl-caption-edit { display: flex; gap: 8px; flex: 1; min-width: 180px; }
.irl-caption-input { flex: 1; background: var(--nxt-bg-2); border: 1px solid var(--nxt-accent); border-radius: 6px; color: var(--nxt-ink); padding: 5px 10px; font-size: 13px; font-family: inherit; outline: none; }
.irl-actions { display: flex; gap: 8px; align-items: center; flex-shrink: 0; flex-wrap: wrap; }
.irl-action { font-size: 12px; padding: 5px 12px; border-radius: var(--nxt-radius-sm); border: 1px solid var(--nxt-stroke); background: var(--nxt-bg-2); color: var(--nxt-ink); cursor: pointer; text-decoration: none; white-space: nowrap; transition: border-color .12s; }
.irl-action:hover { border-color: var(--nxt-stroke-strong); }
.irl-action:active { transform: translateY(1px); }
.irl-action:focus-visible { outline: 2px solid var(--nxt-accent); outline-offset: 2px; }
.irl-action.remove { color: var(--nxt-danger, #f87171); border-color: color-mix(in srgb, var(--nxt-danger, #f87171) 30%, transparent); }
.irl-action.remove:hover { background: color-mix(in srgb, var(--nxt-danger, #f87171) 8%, transparent); }

/* ── Location map modal ──────────────────────────────────────────────────── */
.irlmap-modal .irl-modal-body { padding: 0; }
.irlmap { position: relative; width: 100%; height: 340px; background: var(--nxt-bg-2); z-index: 0; }
.irlmap-canvas { position: absolute; inset: 0; }
.irlmap-skel { position: absolute; inset: 0; z-index: 600; display: flex; align-items: center; justify-content: center; gap: 10px; background: var(--nxt-bg-2); color: var(--nxt-ink-faint); font-size: 13px; transition: opacity .3s; }
.irlmap-skel.gone { opacity: 0; pointer-events: none; }
.irlmap-spin { width: 18px; height: 18px; border-radius: 50%; border: 2px solid var(--nxt-stroke); border-top-color: var(--nxt-accent); animation: irl-spin .8s linear infinite; }
@keyframes irl-spin { to { transform: rotate(360deg); } }
@media (max-width: 520px) { .irlmap { height: 280px; } }

/* Leaflet dark-theme touch-ups (zoom + attribution) */
.irlmap .leaflet-control-zoom a { background: var(--nxt-bg-1); color: var(--nxt-ink); border-color: var(--nxt-stroke); }
.irlmap .leaflet-control-zoom a:hover { background: var(--nxt-bg-2); }
.irlmap .leaflet-bar { border-color: var(--nxt-stroke); box-shadow: 0 1px 5px rgba(0,0,0,.5); }
.irlmap .leaflet-control-attribution { background: rgba(8,10,16,.7); color: #99a; font-size: 10px; }
.irlmap .leaflet-control-attribution a { color: #9cf; }
.irlmap .leaflet-marker-icon.irlmap-pin { background: none; border: none; }

/* Custom GPS markers */
.irlmap-marker { position: relative; width: 40px; height: 40px; }
.irlmap-dot { position: absolute; inset: 7px; border-radius: 50%; background: linear-gradient(135deg, #1a2035, #0d1018); border: 2px solid var(--nxt-ink-faint); display: flex; align-items: center; justify-content: center; overflow: hidden; font-size: 13px; box-shadow: 0 2px 6px rgba(0,0,0,.55); transition: border-color .15s, box-shadow .15s; }
.irlmap-dot img { width: 100%; height: 100%; object-fit: cover; }
.irlmap-marker.is-focused .irlmap-dot { border-color: var(--nxt-accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--nxt-accent) 28%, transparent), 0 3px 10px rgba(0,0,0,.6); }
.irlmap-marker:not(.is-focused) { cursor: pointer; opacity: .82; transition: opacity .15s; }
.irlmap-marker:not(.is-focused):hover { opacity: 1; }
.irlmap-heading { position: absolute; inset: 0; pointer-events: none; transform-origin: 50% 50%; transition: transform .1s linear; }
.irlmap-heading i { position: absolute; top: -4px; left: 50%; margin-left: -5px; width: 0; height: 0; border-left: 5px solid transparent; border-right: 5px solid transparent; border-bottom: 9px solid var(--nxt-ink-faint); filter: drop-shadow(0 1px 1px rgba(0,0,0,.5)); }
.irlmap-marker.is-focused .irlmap-heading i { border-bottom-color: var(--nxt-accent); }

/* Heading dial + locate controls */
.irlmap-controls { display: flex; align-items: center; gap: 14px; padding: 12px 16px; border-top: 1px solid var(--nxt-stroke); flex-wrap: wrap; }
.irlmap-compass { width: 58px; height: 58px; flex-shrink: 0; cursor: grab; touch-action: none; border-radius: 50%; }
.irlmap-compass:active { cursor: grabbing; }
.irlmap-compass:focus-visible { outline: 2px solid var(--nxt-accent); outline-offset: 2px; }
.irlmap-compass svg { width: 100%; height: 100%; display: block; }
.irlmap-compass .ring { fill: var(--nxt-bg-2); stroke: var(--nxt-stroke); stroke-width: 3; }
.irlmap-compass .tick { stroke: var(--nxt-ink-faint); stroke-width: 2; }
.irlmap-compass .lbl { fill: var(--nxt-ink-faint); font: 700 15px/1 system-ui, sans-serif; text-anchor: middle; dominant-baseline: central; }
.irlmap-compass .lbl.n { fill: var(--nxt-accent); }
.irlmap-compass .needle { fill: var(--nxt-accent); }
.irlmap-headbox { display: flex; flex-direction: column; gap: 4px; }
.irlmap-headbox > span { font-size: 10px; text-transform: uppercase; letter-spacing: .05em; color: var(--nxt-ink-faint); }
.irlmap-headrow { display: flex; align-items: center; gap: 8px; }
.irlmap-headrow input { width: 72px; background: var(--nxt-bg-2); border: 1px solid var(--nxt-stroke); border-radius: 7px; color: var(--nxt-ink); padding: 6px 9px; font-size: 13px; font-family: inherit; outline: none; font-variant-numeric: tabular-nums; }
.irlmap-headrow input:focus { border-color: var(--nxt-accent); }
.irlmap-headrow .cmp { font-size: 14px; font-weight: 700; color: var(--nxt-ink); min-width: 30px; }
.irlmap-controls .grow { flex: 1; }

/* Save bar — appears on drag / heading change */
.irlmap-savebar { display: none; align-items: center; gap: 10px 12px; padding: 12px 16px; border-top: 1px solid var(--nxt-stroke); background: color-mix(in srgb, var(--nxt-accent) 7%, transparent); flex-wrap: wrap; animation: irl-fade .16s ease; }
.irlmap-savebar.open { display: flex; }
.irlmap-savebar .lbl { flex: 1; min-width: 170px; font-size: 13px; color: var(--nxt-ink-dim); line-height: 1.45; }
.irlmap-savebar .lbl b { color: var(--nxt-ink); }
.irlmap-savebar .locating { opacity: .6; }
.irlmap-savebar .err { flex-basis: 100%; font-size: 12px; color: var(--nxt-danger, #f87171); }

/* Modal footer: hint + remove */
.irlmap-foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 16px; border-top: 1px solid var(--nxt-stroke); flex-wrap: wrap; }
.irlmap-hint { font-size: 12px; color: var(--nxt-ink-faint); flex: 1; min-width: 150px; }

/* CDN-failure fallback — manual coordinate entry */
.irlmap-fallback { padding: 4px 18px 18px; }
.irlmap-fallback .row { display: flex; gap: 10px; flex-wrap: wrap; align-items: flex-end; margin-top: 14px; }
.irlmap-fallback .fb-err { font-size: 12px; color: var(--nxt-danger, #f87171); margin-top: 10px; }
.irl-loc-field { display: flex; flex-direction: column; gap: 4px; }
.irl-loc-field label { font-size: 10px; text-transform: uppercase; letter-spacing: .05em; color: var(--nxt-ink-faint); }
.irl-loc-field input { width: 120px; background: var(--nxt-bg-2); border: 1px solid var(--nxt-stroke); border-radius: 7px; color: var(--nxt-ink); padding: 7px 9px; font-size: 13px; font-family: inherit; outline: none; font-variant-numeric: tabular-nums; }
.irl-loc-field input:focus { border-color: var(--nxt-accent); }
.irl-loc-field.heading input { width: 86px; }

@keyframes irl-pulse { 0%,100%{opacity:.55} 50%{opacity:1} }

/* Header actions + inbox button */
.irl-header-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
#irl-inbox-btn { position: relative; }
.irl-inbox-badge { display: inline-flex; align-items: center; justify-content: center; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 999px; background: var(--nxt-accent); color: #061018; font-size: 11px; font-weight: 800; line-height: 1; font-variant-numeric: tabular-nums; }

/* Per-card unread chip */
.irl-card-unread { font-size: 10.5px; font-weight: 700; padding: 2px 7px; border-radius: 999px; background: color-mix(in srgb, var(--nxt-accent) 18%, transparent); color: var(--nxt-accent); border: 1px solid color-mix(in srgb, var(--nxt-accent) 34%, transparent); white-space: nowrap; flex-shrink: 0; }

/* ── Inbox modal feed ─────────────────────────────────────────────────────── */
.irl-inbox-list { display: flex; flex-direction: column; }
.irl-inbox-row { display: flex; gap: 11px; padding: 12px 2px; border-bottom: 1px solid var(--nxt-line, var(--nxt-stroke)); position: relative; }
.irl-inbox-row:last-child { border-bottom: none; }
.irl-inbox-row.unread { padding-left: 14px; }
.irl-inbox-row.unread::before { content: ''; position: absolute; left: 0; top: 17px; width: 7px; height: 7px; border-radius: 50%; background: var(--nxt-accent); }
.irl-inbox-row.owner { padding-left: 14px; border-left: 2px solid color-mix(in srgb, var(--nxt-accent) 45%, transparent); margin-left: 2px; }
.irl-inbox-icon { font-size: 18px; line-height: 1.3; flex-shrink: 0; }
.irl-inbox-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.irl-inbox-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.irl-inbox-who { font-size: 14px; font-weight: 600; color: var(--nxt-ink); }
.irl-inbox-row.owner .irl-inbox-who { color: var(--nxt-accent); }
.irl-inbox-time { font-size: 11.5px; color: var(--nxt-ink-faint); white-space: nowrap; flex-shrink: 0; }
.irl-inbox-msg { font-size: 13px; color: var(--nxt-ink); line-height: 1.45; }
.irl-inbox-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; font-size: 12px; color: var(--nxt-ink-faint); }
.irl-inbox-agent { color: var(--nxt-ink-dim); }
.irl-inbox-place { color: var(--nxt-ink-faint); }
.irl-inbox-action { background: none; border: none; padding: 0; font: inherit; font-size: 12px; font-weight: 600; color: var(--nxt-accent); cursor: pointer; text-decoration: none; }
.irl-inbox-action:hover { text-decoration: underline; }

/* Reply composer (inline in an inbox row) */
.irl-reply-box { margin-top: 8px; display: flex; flex-direction: column; gap: 8px; animation: irl-fade .14s ease; }
.irl-reply-input { width: 100%; resize: vertical; min-height: 38px; background: var(--nxt-bg-2); border: 1px solid var(--nxt-accent); border-radius: 9px; color: var(--nxt-ink); padding: 8px 10px; font: inherit; font-size: 13px; outline: none; }
.irl-reply-actions { display: flex; align-items: center; gap: 10px; justify-content: flex-end; }
.irl-reply-hint { flex: 1; font-size: 12px; color: var(--nxt-ink-dim); }
.irl-reply-hint.ok { color: var(--nxt-success); }
.irl-reply-hint.err { color: var(--nxt-danger, #f87171); }
.irl-inbox-flash { margin: 4px 0 10px; padding: 9px 12px; border-radius: 9px; font-size: 12.5px; font-weight: 600; color: var(--nxt-success); background: color-mix(in srgb, var(--nxt-success) 10%, transparent); border: 1px solid color-mix(in srgb, var(--nxt-success) 28%, transparent); }

@media (prefers-reduced-motion: reduce) {
	.irl-modal-back, .irl-modal, .irlmap-savebar, .irl-reply-box { animation: none; }
	.irl-btn:hover, .irl-action:active, .irl-btn:active { transform: none; }
	.irl-btn, .irl-action { transition: border-color .14s; }
}
</style>`;

let userPos = null;

// The "N km away" line on a placement card is a passive nicety, so reading the
// browser's location must never be the thing that pops a permission prompt the
// moment the page opens: the explicit "use my location" buttons further down are
// where a visitor asks for that. So read silently only when permission is
// already granted. Where the Permissions API is unavailable there is no way to
// ask without prompting, so stay quiet and let the buttons do it.
async function readAlreadyGrantedPosition() {
	if (!navigator.geolocation || !navigator.permissions?.query) return;
	try {
		const status = await navigator.permissions.query({ name: 'geolocation' });
		if (status.state !== 'granted') return;
	} catch {
		return; // engine does not expose geolocation permission state
	}
	navigator.geolocation.getCurrentPosition(
		(p) => { userPos = { lat: p.coords.latitude, lng: p.coords.longitude }; },
		() => {},
		{ timeout: 5000 },
	);
}
readAlreadyGrantedPosition();

function metaLine(pin, geo) {
	const loc  = geo || `${Number(pin.lat).toFixed(5)}°, ${Number(pin.lng).toFixed(5)}°`;
	const dist = userPos ? ` · ${(haversineDist(userPos.lat, userPos.lng, pin.lat, pin.lng) / 1000).toFixed(1)} km away` : '';
	const dir  = pin.heading != null ? ` · Facing ${compassLabel(pin.heading)}` : '';
	return `📍 ${loc}${dist}${dir}`;
}

// ── Live inbox state (shared by the cards, the header badge, the poll loop, and
// the inbox modal) ──────────────────────────────────────────────────────────
const inbox = { interactions: [], unread: 0 };
let rootEl = null;        // the page root, for header/banner queries
let listEl = null;        // the placement-cards container
let pollTimer = null;
let inboxModal = null;    // { refresh(rows), isComposing() } while the modal is open

// Unread = a visitor row not yet seen. The owner's own replies are excluded —
// they're authored, never "unread", so they must not light a badge.
function unreadForPin(pinId, list = inbox.interactions) {
	return list.filter((x) => x.pin_id === pinId && !x.seen_at && !isOwnerReply(x)).length;
}

function cardHtml(pin, ixList) {
	const caption = pin.caption || '';
	const img = pin.avatar_url
		? `<img class="irl-av" src="${esc(pin.avatar_url)}" alt="" loading="lazy" data-fallback="sibling" /><div class="irl-av-fallback" style="display:none">📍</div>`
		: `<div class="irl-av-fallback">📍</div>`;

	const visitors = Number(pin.view_count) || 0;
	const pinIx = ixList.filter((x) => x.pin_id === pin.id).slice(0, 4);
	const ixHtml = pinIx.length ? pinIx.map(interactionLine).join('') : EMPTY_IX_HTML;
	const unread = unreadForPin(pin.id, ixList);

	// Stat chips — balance & reputation fill in async (skeleton until then).
	const agentStats = pin.agent_id ? `
			<div class="irl-stat skel" data-stat="balance"><span class="k">Balance</span><span class="v">—</span></div>
			<div class="irl-stat skel" data-stat="reputation"><span class="k">Reputation</span><span class="v">—</span></div>
			<div class="irl-stat skel" data-stat="services"><span class="k">Services</span><span class="v">—</span></div>` : '';

	return `<div class="irl-card" data-id="${esc(pin.id)}" data-agent="${esc(pin.agent_id || '')}"
		data-lat="${esc(pin.lat)}" data-lng="${esc(pin.lng)}" data-heading="${esc(pin.heading ?? 0)}">
		<div class="irl-card-head">
			${img}
			<div class="irl-info">
				<div class="irl-name-row" style="display:flex;align-items:center;gap:8px;min-width:0">
					<span class="irl-name">${esc(pin.avatar_name || 'Placed agent')}</span>
					${statusBadge(pin.status)}
					<span class="irl-card-unread" data-card-unread title="Unread interactions"${unread ? '' : ' hidden'}>${unread} new</span>
				</div>
				<div class="irl-meta">
					<span class="irl-meta-loc">${esc(metaLine(pin, null))}</span>
					${expiryLabel(pin.expires_at)}
					${placementBadge(pin)}
				</div>
			</div>
		</div>

		<div class="irl-stats">
			${agentStats}
			<div class="irl-stat" data-stat="interactions"><span class="k">Interactions</span><span class="v">${Number(pin.interaction_count) || visitors}</span></div>
			<div class="irl-stat" data-stat="lastseen"><span class="k">Last seen</span><span class="v" style="font-size:12.5px">${esc(pin.last_interaction_at ? relTime(pin.last_interaction_at) : 'No visits')}</span></div>
		</div>

		<div class="irl-section" data-skills-section hidden>
			<div class="irl-section-label">Skills
				<button class="irl-link-btn" data-manage-services type="button">Manage prices →</button>
			</div>
			<div class="irl-skills" data-skills-list></div>
		</div>

		<div class="irl-section" data-services hidden>
			<div class="irl-section-label">Services <a href="/dashboard/monetize">Manage ↗</a></div>
			<div class="irl-svc-list" data-svc-list></div>
		</div>

		<div class="irl-section">
			<div class="irl-section-label">IRL interactions</div>
			<div data-ix-list>${ixHtml}</div>
		</div>

		<div class="irl-card-body">
			<div class="irl-caption" data-caption="${esc(caption)}" role="button" tabindex="0" aria-label="Edit caption" title="Click or press Enter to edit caption">${caption ? esc(caption) : '<span style="color:var(--nxt-ink-faint);font-style:italic">Add a caption…</span>'}</div>
			<div class="irl-actions">
				<button class="irl-action" data-outfit="${esc(pin.id)}">Change outfit</button>
				<button class="irl-action" data-loc-toggle>Move on map</button>
				<button class="irl-action" data-visit="${esc(pin.id)}" type="button">Visit link</button>
				<a class="irl-action" href="/irl?pin=${esc(pin.id)}" target="_blank" rel="noopener">View in IRL ↗</a>
				<button class="irl-action remove" data-remove="${esc(pin.id)}">Remove</button>
			</div>
		</div>
	</div>`;
}

async function mount(el) {
	rootEl = el;
	el.innerHTML = STYLE + `<div class="irl-wrap">
		<div class="irl-header">
			<h2>My IRL Agents</h2>
			<div class="irl-header-actions">
				<button class="irl-btn" id="irl-inbox-btn" type="button" aria-haspopup="dialog">
					<span aria-hidden="true">📥</span> Inbox
					<span class="irl-inbox-badge" id="irl-inbox-badge" hidden></span>
				</button>
				<button class="irl-btn" id="irl-privacy-btn" type="button" aria-haspopup="dialog">
					<span aria-hidden="true">🔒</span> Privacy &amp; my data
				</button>
				<a class="irl-btn primary" href="/irl" id="irl-place-btn">+ Place new ↗</a>
			</div>
		</div>
		<div id="irl-mp-banner"></div>
		<div id="irl-banner"></div>
		<div id="irl-list"></div>
	</div>`;
	el.querySelector('#irl-inbox-btn')?.addEventListener('click', openInboxModal);
	// Privacy & my data — the full H5 right-to-be-forgotten surface (summary,
	// per-pin unpublish/delete, export, remove-all). A delete here must also drop
	// out of the placements list, so refresh it on change.
	el.querySelector('#irl-privacy-btn')?.addEventListener('click', () => {
		openMyDataPanel({ onChanged: () => { runLoad().catch(() => {}); } });
	});

	// Multiplayer AR explainer — shown once at the top so owners understand
	// that their placed agents are visible to ALL users who visit that location.
	el.querySelector('#irl-mp-banner').innerHTML = `<div class="irl-mp-banner">
		<span class="mp-icon" aria-hidden="true">🌐</span>
		<div class="mp-body"><strong>Multiplayer AR — your agents are public</strong>
			Anyone who opens three.ws/irl near your pin location will see your 3D agent in their camera view. You can update the agent's caption, outfit, and location remotely at any time.</div>
	</div>`;

	const list = el.querySelector('#irl-list');
	listEl = list;

	// One network boundary for the four designed states: loading skeleton → list /
	// empty / error+retry. The retry button re-runs this same load. Signed-out is
	// handled earlier by requireUser()'s redirect to /login, so it never reaches here.
	await runLoad();

	async function runLoad() {
	await loadInto(list, {
		load: async () => {
			// Pins + interactions in parallel — interactions power both the banner and
			// each card's IRL feed.
			const [sumData, ixData] = await Promise.all([
				get('/api/irl/agent-summary?mine=1'),
				get('/api/irl/interactions?mine=1').catch(() => ({ interactions: [], unread: 0 })),
			]);
			inbox.interactions = ixData.interactions || [];
			inbox.unread = ixData.unread || 0;
			// agent-summary keys each row by pin_id and adds derived monitoring signals
			// (status, interaction_count, last_interaction_at). Normalize pin_id→id so
			// the existing card code is unchanged.
			return (sumData.agents || []).map((a) => ({ ...a, id: a.pin_id }));
		},
		render: (pins, listC) => renderPlacements(pins, listC, el),
		skeleton: { count: 3, variant: 'row' },
		error: { title: "Couldn't load your IRL agents", body: 'Check your connection and try again.' },
		errorScope: 'irl',
		context: 'dashboard:irl-placements',
	});
	}
}

// Paint the populated placements — or the designed empty state — then wire the
// live layers. Routed through loadInto's render hook (no `empty` config), so the
// zero-pins CTA rides the same path as the populated list.
function renderPlacements(pins, list, el) {
	if (!pins.length) {
		list.innerHTML = emptyStateHTML({
			icon: '📍',
			title: 'No agents placed yet',
			body: 'Open IRL, enable your camera, and pin an agent to a real-world spot — it becomes visible to everyone who visits that location.',
			actions: [{ label: 'Open IRL', href: '/irl', primary: true }],
		});
		el.querySelector('#irl-place-btn').textContent = '+ Place agent ↗';
		return;
	}

	renderBanner();
	list.innerHTML = pins.map((p) => cardHtml(p, inbox.interactions)).join('');
	applyBadges();
	enrichCards(pins, list);
	wireCardEvents(list, pins);
	startPolling();
	startLiveStream(); // D3 — upgrade the poll to instant realtime delivery
}

// ── Async enrichment per card: balance, reputation, services, skills, geocode ──
// Each call is best-effort and fills its skeleton chip on resolve (or an honest
// "—" / "Unavailable" on failure) so a slow upstream never leaves a card blank.
function enrichCards(pins, list) {
	for (const pin of pins) {
		const card = list.querySelector(`[data-id="${pin.id}"]`);
		if (!card) continue;

		// Reverse-geocode the location label (cached + polite to Nominatim).
		placeFor(pin.lat, pin.lng).then((geo) => {
			if (geo) {
				const locEl = card.querySelector('.irl-meta-loc');
				if (locEl) locEl.textContent = metaLine(pin, geo);
			}
		});

		if (!pin.agent_id) continue;

		// Reputation + services from the IRL agent-card (public, cached).
		fetch(`/api/irl/agent-card?id=${encodeURIComponent(pin.agent_id)}`)
			.then((r) => (r.ok ? r.json() : null))
			.then((data) => {
				const card2 = data?.card;
				if (!card2) { fillStatError(card, 'reputation'); fillStatError(card, 'services'); return; }
				fillStat(card, 'reputation', String(card2.reputation?.score ?? 0));
				// C3 — turn the Reputation chip into the open/close affordance for an
				// on-chain reputation panel: the same score/tier the public B2 tap
				// card shows, plus a verified/credentialed/disputed breakdown lazily
				// loaded from /api/agents/solana-reputation when the owner opens it.
				mountReputationPanel(card, { reputation: card2.reputation, agentId: pin.agent_id, pinId: pin.id });
				const svc = card2.services || [];
				fillStat(card, 'services', String(svc.length));
				renderServices(card, svc);
			})
			.catch(() => { fillStatError(card, 'reputation'); fillStatError(card, 'services'); });

		// Agent skills from the agent profile endpoint.
		fetch(`/api/agents/${encodeURIComponent(pin.agent_id)}`, { credentials: 'include' })
			.then((r) => (r.ok ? r.json() : null))
			.then((data) => {
				const skills = data?.agent?.skills || [];
				renderSkills(card, skills);
			})
			.catch(() => {});

		// Live wallet balance. The authenticated owner path returns { data: { sol,
		// lamports, balance_error } } (no `balance` field — that only exists on the
		// public-read shape), so read `sol` and surface RPC throttling explicitly
		// instead of silently rendering "—" for every owned agent.
		fetch(`/api/agents/${encodeURIComponent(pin.agent_id)}/solana`, { credentials: 'include' })
			.then((r) => (r.ok ? r.json() : null))
			.then((data) => {
				const d = data?.data || data || {};
				if (d.balance_error) { fillStat(card, 'balance', 'Unavailable'); return; }
				const bal = d.balance ?? d.sol;
				fillStat(card, 'balance', bal == null ? '—' : `◎${Number(bal).toFixed(2)}`);
			})
			.catch(() => fillStatError(card, 'balance'));
	}
}

// ── Live header badge, per-card chips, and the "new interactions" banner ─────
function applyBadges() {
	const badge = rootEl?.querySelector('#irl-inbox-badge');
	if (badge) {
		if (inbox.unread > 0) { badge.textContent = String(inbox.unread); badge.hidden = false; }
		else { badge.hidden = true; }
	}
	listEl?.querySelectorAll('.irl-card').forEach((card) => {
		const chip = card.querySelector('[data-card-unread]');
		if (!chip) return;
		const n = unreadForPin(card.dataset.id);
		if (n > 0) { chip.textContent = `${n} new`; chip.hidden = false; }
		else { chip.hidden = true; }
	});
}

function renderBanner() {
	const host = rootEl?.querySelector('#irl-banner');
	if (!host) return;
	if (inbox.unread > 0) {
		host.innerHTML = `<div class="irl-feed-banner">
			<span class="txt"><b>${inbox.unread}</b> ${inbox.unread === 1 ? 'person' : 'people'} interacted with your agents in real life.</span>
			<button class="irl-btn" data-inbox-open type="button">Open inbox →</button>
		</div>`;
		host.querySelector('[data-inbox-open]')?.addEventListener('click', openInboxModal);
	} else {
		host.innerHTML = '';
	}
}

// Re-render one card's compact feed + its "Last seen" chip from current state.
function refreshCardFeed(pinId) {
	const card = listEl?.querySelector(`[data-id="${CSS.escape(pinId)}"]`);
	if (!card) return;
	const host = card.querySelector('[data-ix-list]');
	if (host) {
		const pinIx = inbox.interactions.filter((x) => x.pin_id === pinId).slice(0, 4);
		host.innerHTML = pinIx.length ? pinIx.map(interactionLine).join('') : EMPTY_IX_HTML;
	}
	const last = inbox.interactions
		.filter((x) => x.pin_id === pinId)
		.reduce((acc, x) => Math.max(acc, new Date(x.created_at).getTime() || 0), 0);
	const seenEl = card.querySelector('[data-stat="lastseen"] .v');
	if (seenEl && last > 0) seenEl.textContent = relTime(new Date(last).toISOString());
}

// ── Poll loop ────────────────────────────────────────────────────────────────
// D1/D3 will replace this with realtime push; until then a 20 s pull keeps the
// dashboard alive. We pause in background tabs (no point burning Nominatim/Neon
// when no one's looking) and tear down on navigation away.
const POLL_MS = 20_000;
function startPolling() {
	stopPolling();
	pollTimer = setInterval(() => {
		if (document.visibilityState === 'visible') pollOnce();
	}, POLL_MS);
	window.addEventListener('pagehide', stopPolling, { once: true });
}
function stopPolling() {
	if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}
async function pollOnce() {
	let data;
	try { data = await get('/api/irl/interactions?mine=1'); }
	catch { return; } // transient — the next tick retries
	inbox.interactions = data.interactions || [];
	inbox.unread = data.unread || 0;
	listEl?.querySelectorAll('.irl-card').forEach((card) => refreshCardFeed(card.dataset.id));
	applyBadges();
	renderBanner();
	// Keep an open inbox current — but never yank a half-typed reply out from
	// under the owner.
	if (inboxModal && !inboxModal.isComposing()) inboxModal.refresh(inbox.interactions);
}

// ── D3 · realtime owner delivery ─────────────────────────────────────────────
// The 20 s poll above is the floor that keeps the inbox alive everywhere; this
// SSE stream (GET /api/irl/interactions-stream) makes a tap / message / pay on a
// placed agent land in the open dashboard within ~1 s — the owner gets the
// dopamine of "someone engaged my agent right now" even from the other side of
// the world. Each live event triggers one authoritative pollOnce() (so unread
// counts and the open modal stay exactly server-correct) plus an instant flash +
// toast on the agent that was touched. EventSource auto-reconnects; if the stream
// is unavailable (blocked, offline, no infra) the poll alone keeps the inbox
// live, just slower — degrade the flourish, never the record.
let liveStream = null;
let liveNudge = null;

function startLiveStream() {
	stopLiveStream();
	ensureLiveStyles();
	let es;
	try { es = new EventSource('/api/irl/interactions-stream', { withCredentials: true }); }
	catch { return; } // EventSource unsupported → the 20 s poll still covers us
	liveStream = es;
	es.addEventListener('interaction', (e) => {
		let ix; try { ix = JSON.parse(e.data); } catch { return; }
		flashInteraction(ix);
		// Coalesce a burst of events into a single authoritative refresh.
		clearTimeout(liveNudge);
		liveNudge = setTimeout(() => { if (document.visibilityState === 'visible') pollOnce(); }, 350);
	});
	es.addEventListener('open',  () => setLivePill('live'));
	es.addEventListener('error', () => setLivePill('polling')); // EventSource retries on its own
	window.addEventListener('pagehide', stopLiveStream, { once: true });
}

function stopLiveStream() {
	if (liveStream) { try { liveStream.close(); } catch { /* already torn down */ } liveStream = null; }
	if (liveNudge) { clearTimeout(liveNudge); liveNudge = null; }
}

// Instant per-card feedback the moment an interaction streams in: a soft accent
// flash on the touched agent, and a toast for the high-signal events (pay /
// message — never the chatty view/tap). Pure box-shadow/opacity, auto-cleaned.
const IX_TOAST = {
	pay: '💸 Someone just paid your agent',
	message: '💬 New message from a visitor',
	tap: '👆 Someone tapped your agent',
	talk: '🗣 Someone is talking with your agent',
	view: '👁 Someone is viewing your agent',
};
function flashInteraction(ix) {
	const card = ix.pin_id && listEl?.querySelector(`[data-id="${CSS.escape(ix.pin_id)}"]`);
	if (card) {
		card.classList.remove('irl-flash');
		void card.offsetWidth; // restart the animation even if one is mid-flight
		card.classList.add('irl-flash');
		card.addEventListener('animationend', () => card.classList.remove('irl-flash'), { once: true });
	}
	if (ix.type === 'pay' || ix.type === 'message' || ix.type === 'talk') {
		const who = ix.avatar_name ? ` · ${ix.avatar_name}` : '';
		irlToast((IX_TOAST[ix.type] || 'New IRL interaction') + who);
	}
}

// A "Live" / "Polling" pill in the header — green when the realtime stream is
// connected, muted when we've fallen back to the poll. Created lazily so it never
// depends on render order; a no-op if the header isn't present.
function setLivePill(state) {
	const actions = rootEl?.querySelector('.irl-header-actions');
	if (!actions) return;
	let pill = actions.querySelector('#irl-live-pill');
	if (!pill) {
		pill = document.createElement('span');
		pill.id = 'irl-live-pill';
		pill.className = 'irl-live-pill';
		actions.prepend(pill);
	}
	const live = state === 'live';
	pill.classList.toggle('on', live);
	pill.innerHTML = `<i aria-hidden="true"></i>${live ? 'Live' : 'Polling'}`;
	pill.title = live
		? 'Connected — interactions appear the instant they happen.'
		: 'Reconnecting — interactions still arrive, just on a short delay.';
}

// Lightweight toast scoped to this page (bottom-center, auto-dismiss, stacking).
function irlToast(msg) {
	let host = document.getElementById('irl-toast-host');
	if (!host) {
		host = document.createElement('div');
		host.id = 'irl-toast-host';
		host.className = 'irl-toast-host';
		host.setAttribute('role', 'status');
		host.setAttribute('aria-live', 'polite');
		document.body.appendChild(host);
	}
	const t = document.createElement('div');
	t.className = 'irl-toast';
	t.textContent = msg;
	host.appendChild(t);
	requestAnimationFrame(() => t.classList.add('show'));
	setTimeout(() => {
		t.classList.remove('show');
		t.addEventListener('transitionend', () => t.remove(), { once: true });
	}, 4200);
}

// D3 styles injected once into <head> so we never have to edit the page's big
// STYLE template (shared, and edited by sibling surfaces) — keeps this layer
// self-contained. Honors prefers-reduced-motion: no animation, just the colour.
let _liveStylesInjected = false;
function ensureLiveStyles() {
	if (_liveStylesInjected || document.getElementById('irl-live-styles')) return;
	_liveStylesInjected = true;
	const s = document.createElement('style');
	s.id = 'irl-live-styles';
	s.textContent = `
		.irl-card.irl-flash { animation: irl-flash 1.25s cubic-bezier(.2,.7,.3,1); }
		@keyframes irl-flash {
			0%   { box-shadow: 0 0 0 0 color-mix(in srgb, var(--nxt-accent) 55%, transparent); }
			30%  { box-shadow: 0 0 0 3px color-mix(in srgb, var(--nxt-accent) 40%, transparent); }
			100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--nxt-accent) 0%, transparent); }
		}
		.irl-live-pill { display: inline-flex; align-items: center; gap: 6px; padding: 3px 9px; border-radius: 999px; font-size: 11px; font-weight: 700; letter-spacing: .02em; border: 1px solid var(--nxt-stroke); color: var(--nxt-ink-faint); background: var(--nxt-bg-2); user-select: none; }
		.irl-live-pill i { width: 6px; height: 6px; border-radius: 50%; background: var(--nxt-ink-faint); flex-shrink: 0; }
		.irl-live-pill.on { color: var(--nxt-success); border-color: color-mix(in srgb, var(--nxt-success) 34%, transparent); background: color-mix(in srgb, var(--nxt-success) 9%, transparent); }
		.irl-live-pill.on i { background: var(--nxt-success); animation: irl-live-ping 2s ease-out infinite; }
		@keyframes irl-live-ping { 0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--nxt-success) 60%, transparent); } 70%,100% { box-shadow: 0 0 0 5px color-mix(in srgb, var(--nxt-success) 0%, transparent); } }
		.irl-toast-host { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); z-index: 1200; display: flex; flex-direction: column; gap: 8px; align-items: center; pointer-events: none; }
		.irl-toast { pointer-events: auto; max-width: min(92vw, 420px); padding: 11px 16px; border-radius: 12px; background: var(--nxt-panel, #11151f); color: var(--nxt-ink); border: 1px solid var(--nxt-stroke); box-shadow: 0 14px 40px rgba(0,0,0,.45); font-size: 13px; font-weight: 600; opacity: 0; transform: translateY(10px) scale(.98); transition: opacity .22s ease, transform .22s cubic-bezier(.2,.7,.3,1); }
		.irl-toast.show { opacity: 1; transform: none; }
		@media (prefers-reduced-motion: reduce) {
			.irl-card.irl-flash { animation: none; }
			.irl-live-pill.on i { animation: none; }
			.irl-toast { transition: opacity .2s ease; transform: none; }
		}
	`;
	document.head.appendChild(s);
}

function fillStat(card, key, value) {
	const el = card.querySelector(`[data-stat="${key}"]`);
	if (!el) return;
	el.classList.remove('skel');
	el.querySelector('.v').textContent = value;
}
function fillStatError(card, key) {
	const el = card.querySelector(`[data-stat="${key}"]`);
	if (!el) return;
	el.classList.remove('skel');
	el.querySelector('.v').textContent = '—';
}

function renderSkills(card, skills) {
	const section = card.querySelector('[data-skills-section]');
	const listEl  = card.querySelector('[data-skills-list]');
	if (!section || !listEl || !skills.length) return;
	section.hidden = false;
	listEl.innerHTML = skills.slice(0, 12).map((s) => `<span class="irl-skill">${esc(s)}</span>`).join('');
}

function renderServices(card, services) {
	const section = card.querySelector('[data-services]');
	const listEl  = card.querySelector('[data-svc-list]');
	if (!section || !listEl) return;
	section.hidden = false;
	if (!services.length) {
		listEl.innerHTML = `<div class="irl-svc-empty">No paid services yet. <a href="/dashboard/monetize">Add one →</a></div>`;
		return;
	}
	listEl.innerHTML = services.map((s) => {
		// agent-card v2 shape: services carry price_usd + chain + skill (was price_usdc/network/slug).
		const priceVal = s.price_usd ?? s.price_usdc;
		const chain = s.chain || s.network || 'base';
		const price = priceVal != null ? `$${Number(priceVal).toFixed(2)} ${String(chain).toUpperCase()}` : 'Free';
		return `<div class="irl-svc"><span class="irl-svc-name">${esc(s.name || s.skill || s.slug)}</span><span class="irl-svc-price">${esc(price)}</span></div>`;
	}).join('');
}

function wireCardEvents(list, pins) {
	// Remove a card from the DOM (after its pin is deleted server-side) and drop
	// it from the in-memory list; fall back to the empty state when none remain.
	function dropCard(id) {
		list.querySelector(`[data-id="${CSS.escape(id)}"]`)?.remove();
		const idx = pins.findIndex((p) => p.id === id);
		if (idx >= 0) pins.splice(idx, 1);
		if (!list.querySelector('.irl-card')) {
			// Same designed empty state as the first-load path — one consistent zero-state.
			list.innerHTML = emptyStateHTML({
				icon: '📍',
				title: 'No agents placed',
				body: 'You removed your last placement. Open IRL and pin an agent to a real-world spot to make it visible to everyone who visits.',
				actions: [{ label: 'Open IRL', href: '/irl', primary: true }],
			});
			const placeBtn = rootEl?.querySelector('#irl-place-btn');
			if (placeBtn) placeBtn.textContent = '+ Place agent ↗';
		}
	}

	// Reflect a persisted relocation back into the C1 card: update the stored pin,
	// the data-* attributes, and the visible location/heading label in place.
	function onSaved(saved, label) {
		const pin = pins.find((p) => p.id === saved.id);
		if (pin) { pin.lat = saved.lat; pin.lng = saved.lng; pin.heading = saved.heading; }
		const card = list.querySelector(`[data-id="${CSS.escape(saved.id)}"]`);
		if (!card) return;
		card.dataset.lat = saved.lat;
		card.dataset.lng = saved.lng;
		card.dataset.heading = saved.heading ?? 0;
		const locEl = card.querySelector('.irl-meta-loc');
		if (!locEl) return;
		locEl.textContent = metaLine(pin || saved, label || null);
		if (!label) placeFor(saved.lat, saved.lng).then((geo) => { if (geo) locEl.textContent = metaLine(pin || saved, geo); });
	}

	list.addEventListener('click', async (e) => {
		const card = e.target.closest('.irl-card');
		if (!card) return;
		const id = card.dataset.id;

		// Reply to a visitor message — composed in the dedicated inbox surface.
		if (e.target.closest('[data-reply-open]')) {
			openInboxModal();
			return;
		}

		// Manage paid services (x402 skill pricing) for this agent
		if (e.target.closest('[data-manage-services]')) {
			const agentId = card.dataset.agent;
			if (agentId) {
				const name = card.querySelector('.irl-name')?.textContent?.trim() || 'agent';
				openServicesModal(agentId, name);
			}
			return;
		}

		// Change outfit (C6) — open the in-dashboard remote outfit editor. The 3D
		// editor (Three.js) is lazy-loaded so the dashboard's initial bundle stays
		// light; on save it re-skins the pin for every nearby viewer.
		const outfitBtn = e.target.closest('[data-outfit]');
		if (outfitBtn) {
			const pin = pins.find((p) => p.id === id);
			if (!pin) return;
			outfitBtn.disabled = true;
			const prev = outfitBtn.textContent;
			outfitBtn.textContent = 'Opening…';
			try {
				const { openOutfitEditor } = await import('./irl-outfit-editor.js');
				await openOutfitEditor({
					pin,
					onSaved: () => {
						// The editor mutates the shared `pin` object in place, so a re-edit
						// re-bakes from the right base. Confirm the change on the card.
						card.classList.remove('irl-flash'); void card.offsetWidth; card.classList.add('irl-flash');
						card.addEventListener('animationend', () => card.classList.remove('irl-flash'), { once: true });
						irlToast('Outfit updated — nearby viewers will see it shortly');
					},
				});
			} catch {
				irlToast("Couldn't open the outfit editor. Try again.");
			} finally {
				outfitBtn.disabled = false;
				outfitBtn.textContent = prev;
			}
			return;
		}

		// Visit link: the scannable handoff for a street demo: QR + copy + print sign.
		if (e.target.closest('[data-visit]')) {
			const pin = pins.find((p) => p.id === id);
			if (pin) openVisitLinkModal(pin);
			return;
		}

		// Remove
		const removeBtn = e.target.closest('[data-remove]');
		if (removeBtn) {
			removeBtn.disabled = true;
			removeBtn.textContent = 'Removing…';
			try {
				const r = await fetch(`/api/irl/pins?id=${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'include' });
				if (r.ok) { dropCard(id); }
				else { removeBtn.disabled = false; removeBtn.textContent = 'Remove'; }
			} catch { removeBtn.disabled = false; removeBtn.textContent = 'Remove'; }
			return;
		}

		// Open the relocation map — drag the pin, re-aim, or remove from anywhere.
		if (e.target.closest('[data-loc-toggle]')) {
			openLocationMap({ pins, focusId: id, onSaved, onRemoved: dropCard });
			return;
		}

		// Caption — click to edit
		const captionEl = e.target.closest('.irl-caption');
		if (captionEl) {
			const current = captionEl.dataset.caption || '';
			captionEl.replaceWith(makeNode(`<div class="irl-caption-edit">
				<input class="irl-caption-input" type="text" value="${esc(current)}" placeholder="Caption…" maxlength="140" aria-label="Placement caption" />
				<button class="irl-action" data-save="${esc(id)}">Save</button>
				<button class="irl-action" data-cancel>Cancel</button>
			</div>`));
			card.querySelector('.irl-caption-input')?.focus();
			return;
		}

		// Caption — cancel
		if (e.target.closest('[data-cancel]')) {
			const pin = pins.find((p) => p.id === id);
			restoreCaption(card, pin?.caption || '');
			return;
		}

		// Caption — save
		const saveBtn = e.target.closest('[data-save]');
		if (saveBtn) {
			const input = saveBtn.closest('.irl-caption-edit')?.querySelector('.irl-caption-input');
			const val = input?.value?.trim() ?? '';
			saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
			try {
				const r = await patch('/api/irl/pins', { id, caption: val || null });
				if (r.pin !== undefined) {
					const pin = pins.find((p) => p.id === id);
					if (pin) pin.caption = val || null;
					restoreCaption(card, val);
				} else { saveBtn.disabled = false; saveBtn.textContent = 'Save'; }
			} catch { saveBtn.disabled = false; saveBtn.textContent = 'Save'; }
		}
	});

	// Keyboard parity for the click-to-edit caption (role="button"): Enter / Space
	// opens the inline editor exactly as a pointer click does.
	list.addEventListener('keydown', (e) => {
		const captionEl = e.target.closest?.('.irl-caption');
		if (captionEl && (e.key === 'Enter' || e.key === ' ')) {
			e.preventDefault();
			captionEl.click();
		}
	});
}

// ── Visit link modal ───────────────────────────────────────────────────────
// The scannable handoff for a real-world demo: a passer-by scans the QR, lands on
// /irl?pin=<id>, and the page names this agent until it appears in range. Neither
// link carries a coordinate; the agent still shows only through the presence-
// gated nearby read, so the link is safe to print and post anywhere.
function openVisitLinkModal(pin) {
	const name = pin.avatar_name || 'Placed agent';
	const visitUrl = buildVisitUrl(pin.id, location.origin);
	const signUrl = buildSignUrl(pin.id, location.origin);
	const root = makeNode(`<div class="irl-modal-root">
		<div class="irl-modal-back"></div>
		<div class="irl-modal" role="dialog" aria-modal="true" aria-label="Visit link for ${esc(name)}">
			<div class="irl-modal-head">
				<div class="irl-modal-titles">
					<div class="irl-modal-title">Visit link</div>
					<div class="irl-modal-sub">${esc(name)} · scan to meet it at the spot</div>
				</div>
				<button class="irl-modal-x" data-close type="button" aria-label="Close">×</button>
			</div>
			<div class="irl-modal-body">
				<div class="irl-visit-grid">
					<div class="irl-visit-qr" role="img" aria-label="QR code for the visit link" data-qr></div>
					<div>
						<div class="irl-visit-url">
							<input type="text" readonly value="${esc(visitUrl)}" aria-label="Visit link" data-url />
							<button class="irl-action" data-copy type="button">Copy</button>
						</div>
						<ol class="irl-visit-steps">
							<li>A visitor scans it and allows camera and location.</li>
							<li>Within 60 m of the spot, <b>${esc(name)}</b> appears in their camera and its card opens.</li>
							<li>They tap it for the profile, wallet, tip QR and services; iPhone gets "See it in AR".</li>
						</ol>
						<div class="irl-visit-actions">
							<a class="irl-btn primary" href="${esc(signUrl)}" target="_blank" rel="noopener">Print a sign ↗</a>
							<a class="irl-action" href="${esc(visitUrl)}" target="_blank" rel="noopener">Open on this device ↗</a>
						</div>
						<p class="irl-visit-note">No coordinate in the link. Anyone who is not standing there sees only the agent's name and a prompt to walk up.</p>
					</div>
				</div>
			</div>
		</div>
	</div>`);
	root.querySelector('[data-qr]').innerHTML = renderQRToSVG(visitUrl, { scale: 4, margin: 1 });
	document.body.appendChild(root);
	document.body.style.overflow = 'hidden';
	const close = () => {
		root.remove();
		document.body.style.overflow = '';
		document.removeEventListener('keydown', onKey, true);
	};
	const onKey = (ev) => { if (ev.key === 'Escape') close(); };
	document.addEventListener('keydown', onKey, true);
	root.querySelector('[data-close]').addEventListener('click', close);
	root.querySelector('.irl-modal-back').addEventListener('click', close);
	const copyBtn = root.querySelector('[data-copy]');
	copyBtn.addEventListener('click', async () => {
		try {
			await navigator.clipboard.writeText(visitUrl);
			copyBtn.textContent = 'Copied';
		} catch {
			root.querySelector('[data-url]').select();
			copyBtn.textContent = 'Select + copy';
		}
		setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1800);
	});
	setTimeout(() => copyBtn.focus(), 0);
}

function makeNode(html) {
	const t = document.createElement('template');
	t.innerHTML = html.trim();
	return t.content.firstElementChild;
}
function restoreCaption(card, caption) {
	const editEl = card.querySelector('.irl-caption-edit');
	const node = makeNode(`<div class="irl-caption" data-caption="${esc(caption)}" role="button" tabindex="0" aria-label="Edit caption" title="Click or press Enter to edit caption">${caption ? esc(caption) : '<span style="color:var(--nxt-ink-faint);font-style:italic">Add a caption…</span>'}</div>`);
	editEl?.replaceWith(node);
}

// ── Location map (Leaflet, lazy-loaded) ─────────────────────────────────────
// A real OSM map with a draggable marker per placed agent, so the owner can
// relocate / re-aim / remove a pin from anywhere — not just standing at the
// spot. The lazy CDN loader is shared with the /irl My-pins overview (one
// source, one promise cache, one graceful-failure contract).

// North-up compass dial; the needle <g> is rotated by the heading at runtime.
const COMPASS_SVG = `<svg viewBox="-50 -50 100 100" aria-hidden="true">
	<circle class="ring" cx="0" cy="0" r="45"/>
	<line class="tick" x1="0" y1="-45" x2="0" y2="-39"/><line class="tick" x1="0" y1="45" x2="0" y2="39"/>
	<line class="tick" x1="-45" y1="0" x2="-39" y2="0"/><line class="tick" x1="45" y1="0" x2="39" y2="0"/>
	<text class="lbl n" x="0" y="-27">N</text><text class="lbl" x="27" y="0">E</text>
	<text class="lbl" x="0" y="27">S</text><text class="lbl" x="-27" y="0">W</text>
	<g class="needle" data-needle transform="rotate(0)"><polygon points="0,-30 6,6 0,1 -6,6"/></g>
</svg>`;

const norm360 = (h) => ((Math.round(Number(h) || 0) % 360) + 360) % 360;

// Relocation map modal. `pins` is the live page list (shared ref); `focusId` is
// the pin opened from its C1 card; `onSaved(pin,label)` reflects a persisted move
// back into the card; `onRemoved(id)` drops the card after a delete.
function openLocationMap({ pins, focusId, onSaved, onRemoved }) {
	let L = null;
	let map = null;
	const markers = new Map();   // id -> Leaflet marker
	let saved   = null;          // last-persisted { lat, lng, heading } of the focus
	let pending = null;          // current marker/dial { lat, lng, heading }
	let pendingLabel = null;     // reverse-geocoded label for the pending position
	let geocoding = false;
	let geoSeq = 0;
	let dirty = false;
	let dragCompass = false;
	let ui = {};

	const pinById = (id) => pins.find((p) => p.id === id);

	const root = makeNode(`<div class="irl-modal-root irlmap-modal">
		<div class="irl-modal-back"></div>
		<div class="irl-modal" role="dialog" aria-modal="true" aria-label="Move agent on the map">
			<div class="irl-modal-head">
				<div class="irl-modal-titles">
					<div class="irl-modal-title">Move on map</div>
					<div class="irl-modal-sub" data-sub>Loading map…</div>
				</div>
				<button class="irl-modal-x" data-close type="button" aria-label="Close">×</button>
			</div>
			<div class="irl-modal-body" data-body></div>
		</div>
	</div>`);
	ensureStateKitStyles();
	document.body.appendChild(root);
	document.body.style.overflow = 'hidden';

	const modalEl = root.querySelector('.irl-modal');
	const subEl   = root.querySelector('[data-sub]');
	const body    = root.querySelector('[data-body]');

	const close = () => {
		try { map?.remove(); } catch { /* leaflet teardown best-effort */ }
		map = null;
		root.remove();
		document.body.style.overflow = '';
		document.removeEventListener('keydown', onKey, true);
	};
	const onKey = (ev) => { if (ev.key === 'Escape') close(); };
	document.addEventListener('keydown', onKey, true);
	root.querySelector('[data-close]').addEventListener('click', close);
	root.querySelector('.irl-modal-back').addEventListener('click', close);
	setTimeout(() => root.querySelector('[data-close]')?.focus(), 0);

	// ── Markers ────────────────────────────────────────────────────────────
	function makeIcon(p, focused) {
		const av = p.avatar_url
			? `<img loading="lazy" decoding="async" src="${esc(p.avatar_url)}" alt="" data-fallback="remove" />`
			: '📍';
		return L.divIcon({
			className: 'irlmap-pin',
			html: `<div class="irlmap-marker${focused ? ' is-focused' : ''}"><div class="irlmap-dot">${av}</div><div class="irlmap-heading" style="transform:rotate(${norm360(p.heading)}deg)"><i></i></div></div>`,
			iconSize: [40, 40],
			iconAnchor: [20, 20],
		});
	}

	function hideSkel() { ui.skel?.classList.add('gone'); }
	function updateSub(p) { if (subEl) subEl.textContent = `${p.avatar_name || 'Placed agent'} · drag the pin to relocate`; }

	// ── Heading (dial + input + focused marker) ──────────────────────────────
	function setHeading(h, { user = false, fromInput = false } = {}) {
		h = norm360(h);
		pending.heading = h;
		ui.needle?.setAttribute('transform', `rotate(${h})`);
		if (ui.headCmp) ui.headCmp.textContent = compassLabel(h);
		if (!fromInput && ui.headInput) ui.headInput.value = String(h);
		ui.compass?.setAttribute('aria-valuenow', String(h));
		const hd = markers.get(focusId)?.getElement()?.querySelector('.irlmap-heading');
		if (hd) hd.style.transform = `rotate(${h}deg)`;
		if (user) { dirty = true; refreshSaveBar(); }
	}

	// ── Save bar ─────────────────────────────────────────────────────────────
	function refreshSaveBar() {
		if (!ui.savebar) return;
		const moved  = pending.lat !== saved.lat || pending.lng !== saved.lng;
		const turned = pending.heading !== saved.heading;
		if (!moved && !turned) { hideSaveBar(); return; }
		const parts = [];
		if (moved) {
			const loc = pendingLabel || `${pending.lat.toFixed(5)}°, ${pending.lng.toFixed(5)}°`;
			parts.push(`Move to <b>${esc(loc)}</b>${geocoding ? ' <span class="locating">(locating…)</span>' : ''}`);
		}
		if (turned) parts.push(`${moved ? 'facing' : 'Re-aim to'} <b>${compassLabel(pending.heading)} (${pending.heading}°)</b>`);
		ui.saveLbl.innerHTML = parts.join(', ');
		ui.saveErr.hidden = true; ui.saveErr.textContent = '';
		ui.saveBtn.disabled = false; ui.saveBtn.textContent = 'Save';
		ui.cancelBtn.textContent = 'Cancel';
		ui.savebar.classList.add('open');
	}
	function hideSaveBar() { ui.savebar?.classList.remove('open'); }

	// Snap the focused marker + dial back to the last persisted values.
	function revertToSaved() {
		markers.get(focusId)?.setLatLng([saved.lat, saved.lng]);
		pending = { ...saved };
		pendingLabel = null; geocoding = false; geoSeq++;   // void any in-flight geocode
		setHeading(saved.heading, {});
		dirty = false;
	}

	// Move the focused pin (drag end, "pin to my location"); reverse-geocode async.
	function applyMove(lat, lng) {
		markers.get(focusId)?.setLatLng([lat, lng]);
		pending.lat = lat; pending.lng = lng;
		dirty = true;
		pendingLabel = null; geocoding = true;
		refreshSaveBar();
		const seq = ++geoSeq;
		placeFor(lat, lng).then((label) => { if (seq === geoSeq) { pendingLabel = label; geocoding = false; refreshSaveBar(); } });
	}

	async function persist(lat, lng, heading, label) {
		const r = await patch('/api/irl/pins', { id: focusId, lat, lng, ...(Number.isFinite(heading) ? { heading } : {}) });
		if (!r?.pin) throw new Error('save failed');
		onSaved(r.pin, label || null);
		return r.pin;
	}

	async function doSave() {
		ui.saveBtn.disabled = true; ui.saveBtn.textContent = 'Saving…';
		try {
			const pin = await persist(pending.lat, pending.lng, pending.heading, pendingLabel);
			saved = { lat: pin.lat, lng: pin.lng, heading: norm360(pin.heading ?? pending.heading) };
			pending = { ...saved };
			dirty = false;
			markers.get(focusId)?.setLatLng([saved.lat, saved.lng]);
			setHeading(saved.heading, {});
			ui.saveBtn.textContent = 'Saved ✓';
			setTimeout(() => { hideSaveBar(); if (ui.saveBtn) { ui.saveBtn.disabled = false; ui.saveBtn.textContent = 'Save'; } }, 1100);
		} catch {
			// Snap back to the last saved position and surface the failure inline.
			revertToSaved();
			ui.savebar.classList.add('open');
			ui.saveLbl.innerHTML = 'Last saved position restored.';
			ui.saveErr.textContent = 'Couldn’t save the move. Re-drag the pin and try again.';
			ui.saveErr.hidden = false;
			ui.saveBtn.disabled = true; ui.saveBtn.textContent = 'Save';
			ui.cancelBtn.textContent = 'Dismiss';
		}
	}

	function onCancel() { revertToSaved(); hideSaveBar(); }

	// ── Focus handling ───────────────────────────────────────────────────────
	function focusInit(p) {
		saved   = { lat: +p.lat, lng: +p.lng, heading: norm360(p.heading) };
		pending = { ...saved };
		dirty = false;
		setHeading(saved.heading, {});
		updateSub(p);
	}
	function focusPin(id) {
		if (dirty) revertToSaved();
		markers.get(focusId)?.dragging?.disable();
		focusId = id;
		const p = pinById(id);
		saved   = { lat: +p.lat, lng: +p.lng, heading: norm360(p.heading) };
		pending = { ...saved };
		dirty = false;
		for (const [pid, mk] of markers) mk.setIcon(makeIcon(pinById(pid), pid === focusId));
		markers.get(id)?.dragging?.enable();
		setHeading(saved.heading, {});
		updateSub(p);
		hideSaveBar();
		map?.panTo([saved.lat, saved.lng]);
	}

	// ── Remove ───────────────────────────────────────────────────────────────
	function restoreFoot() {
		const foot = root.querySelector('.irlmap-foot');
		if (!foot) return;
		foot.innerHTML = `<span class="irlmap-hint">Drag the highlighted pin to relocate. Tap another pin to switch.</span>
			<button class="irl-action remove" data-remove-pin type="button">Remove from map</button>`;
		ui.removeBtn = foot.querySelector('[data-remove-pin]');
		ui.removeBtn.addEventListener('click', onRemoveClick);
	}
	function onRemoveClick() {
		const foot = root.querySelector('.irlmap-foot');
		if (!foot) return;
		const p = pinById(focusId) || {};
		foot.innerHTML = `<span class="irlmap-hint">Remove <b>${esc(p.avatar_name || 'this agent')}</b> from the map? This deletes the pin.</span>
			<span style="display:flex;gap:8px;flex-shrink:0">
				<button class="irl-action" data-remove-keep type="button">Keep</button>
				<button class="irl-action remove" data-remove-yes type="button">Remove</button>
			</span>`;
		foot.querySelector('[data-remove-keep]').addEventListener('click', restoreFoot);
		foot.querySelector('[data-remove-yes]').addEventListener('click', doRemove);
	}
	async function doRemove() {
		const yes = root.querySelector('[data-remove-yes]');
		if (yes) { yes.disabled = true; yes.textContent = 'Removing…'; }
		try {
			const removedId = focusId;
			const r = await fetch(`/api/irl/pins?id=${encodeURIComponent(removedId)}`, { method: 'DELETE', credentials: 'include' });
			if (!r.ok) throw new Error('delete failed');
			markers.get(removedId)?.remove();
			markers.delete(removedId);
			onRemoved(removedId);
			hideSaveBar();
			const next = markers.size ? [...markers.keys()][0] : null;
			if (next) { restoreFoot(); focusPin(next); }
			else { close(); }
		} catch {
			if (yes) { yes.disabled = false; yes.textContent = 'Remove'; }
		}
	}

	// ── Compass dial interaction (pointer drag + keyboard) ───────────────────
	function wireCompass() {
		const el = ui.compass;
		if (!el) return;
		const applyPointer = (clientX, clientY) => {
			const r = el.getBoundingClientRect();
			const dx = clientX - (r.left + r.width / 2);
			const dy = clientY - (r.top + r.height / 2);
			if (dx === 0 && dy === 0) return;
			setHeading((Math.atan2(dx, -dy) * 180 / Math.PI), { user: true });
		};
		el.addEventListener('pointerdown', (ev) => {
			ev.preventDefault();
			dragCompass = true;
			try { el.setPointerCapture(ev.pointerId); } catch { /* capture optional */ }
			applyPointer(ev.clientX, ev.clientY);
		});
		el.addEventListener('pointermove', (ev) => { if (dragCompass) applyPointer(ev.clientX, ev.clientY); });
		const end = (ev) => { dragCompass = false; try { el.releasePointerCapture(ev.pointerId); } catch { /* noop */ } };
		el.addEventListener('pointerup', end);
		el.addEventListener('pointercancel', end);
		el.addEventListener('keydown', (ev) => {
			const step = ev.shiftKey ? 10 : 1;
			let h = pending.heading;
			if (ev.key === 'ArrowRight' || ev.key === 'ArrowUp') h += step;
			else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowDown') h -= step;
			else if (ev.key === 'Home') h = 0;
			else if (ev.key === 'PageUp') h += 45;
			else if (ev.key === 'PageDown') h -= 45;
			else return;
			ev.preventDefault();
			setHeading(h, { user: true });
		});
	}

	function onLocate() {
		const btn = ui.locateBtn;
		if (!navigator.geolocation) { btn.textContent = 'Location unavailable'; return; }
		btn.disabled = true; btn.textContent = 'Locating…';
		navigator.geolocation.getCurrentPosition(
			(pos) => {
				btn.disabled = false; btn.textContent = 'Pin to my location';
				map?.panTo([pos.coords.latitude, pos.coords.longitude]);
				applyMove(pos.coords.latitude, pos.coords.longitude);
			},
			() => { btn.disabled = false; btn.textContent = 'Location unavailable'; },
			{ enableHighAccuracy: true, timeout: 8000 },
		);
	}

	// ── Map shell + build ────────────────────────────────────────────────────
	function renderMapShell() {
		body.innerHTML = `
			<div class="irlmap">
				<div class="irlmap-canvas" data-canvas></div>
				<div class="irlmap-skel" data-skel><span class="irlmap-spin"></span> Loading map…</div>
			</div>
			<div class="irlmap-controls">
				<div class="irlmap-compass" data-compass role="slider" tabindex="0" aria-label="Agent heading in degrees" aria-valuemin="0" aria-valuemax="359" aria-valuenow="0">${COMPASS_SVG}</div>
				<div class="irlmap-headbox">
					<span>Heading</span>
					<div class="irlmap-headrow">
						<input type="number" min="0" max="359" step="1" data-head-input aria-label="Heading in degrees" />
						<span class="cmp" data-head-cmp>N</span>
					</div>
				</div>
				<span class="grow"></span>
				<button class="irl-action" data-locate type="button">Pin to my location</button>
			</div>
			<div class="irlmap-savebar" data-savebar>
				<span class="lbl" data-save-lbl></span>
				<button class="irl-action" data-save-cancel type="button">Cancel</button>
				<button class="irl-btn primary" data-save type="button">Save</button>
				<span class="err" data-save-err hidden></span>
			</div>
			<div class="irlmap-foot">
				<span class="irlmap-hint">Drag the highlighted pin to relocate. Tap another pin to switch.</span>
				<button class="irl-action remove" data-remove-pin type="button">Remove from map</button>
			</div>`;
		ui = {
			canvas:    body.querySelector('[data-canvas]'),
			skel:      body.querySelector('[data-skel]'),
			compass:   body.querySelector('[data-compass]'),
			needle:    body.querySelector('[data-needle]'),
			headInput: body.querySelector('[data-head-input]'),
			headCmp:   body.querySelector('[data-head-cmp]'),
			savebar:   body.querySelector('[data-savebar]'),
			saveLbl:   body.querySelector('[data-save-lbl]'),
			saveErr:   body.querySelector('[data-save-err]'),
			saveBtn:   body.querySelector('[data-save]'),
			cancelBtn: body.querySelector('[data-save-cancel]'),
			locateBtn: body.querySelector('[data-locate]'),
			removeBtn: body.querySelector('[data-remove-pin]'),
		};
	}

	function buildMap() {
		markers.clear();
		const p0 = pinById(focusId);
		if (!p0) { close(); return; }
		map = L.map(ui.canvas, { zoomControl: true, attributionControl: true }).setView([+p0.lat, +p0.lng], 16);
		L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap contributors', maxZoom: 19 })
			.addTo(map)
			.on('load', hideSkel);

		for (const p of pins) {
			const mk = L.marker([+p.lat, +p.lng], { draggable: true, autoPan: true, keyboard: false, icon: makeIcon(p, p.id === focusId) }).addTo(map);
			markers.set(p.id, mk);
			if (p.id !== focusId) mk.dragging?.disable();
			mk.on('dragend', () => { if (p.id === focusId) { const ll = mk.getLatLng(); applyMove(ll.lat, ll.lng); } });
			mk.on('click', () => { if (p.id !== focusId) focusPin(p.id); });
		}

		focusInit(p0);
		ui.saveBtn.addEventListener('click', doSave);
		ui.cancelBtn.addEventListener('click', onCancel);
		ui.locateBtn.addEventListener('click', onLocate);
		ui.removeBtn.addEventListener('click', onRemoveClick);
		ui.headInput.addEventListener('input', () => {
			const v = parseInt(ui.headInput.value, 10);
			if (Number.isFinite(v)) setHeading(v, { user: true, fromInput: true });
		});
		wireCompass();

		// Leaflet measures its container; the modal animates in, so re-measure
		// after layout (rAF) and again once the entrance animation ends. A final
		// timer hides the skeleton in case the tile 'load' event was missed.
		requestAnimationFrame(() => map?.invalidateSize());
		modalEl.addEventListener('animationend', () => map?.invalidateSize(), { once: true });
		setTimeout(() => { map?.invalidateSize(); hideSkel(); }, 1800);
	}

	// ── CDN-failure fallback: manual coordinate entry ────────────────────────
	function renderFallback() {
		try { map?.remove(); } catch { /* noop */ }
		map = null;
		const p = pinById(focusId) || {};
		if (subEl) subEl.textContent = `${p.avatar_name || 'Placed agent'} · manual coordinates`;
		body.innerHTML = errorStateHTML({
			title: 'Map unavailable',
			body: 'The map library couldn’t load (offline or blocked). You can still relocate this agent by entering coordinates below.',
			actions: [{ label: 'Retry map', id: 'retry', primary: true }],
		}) + `<div class="irlmap-fallback">
			<div class="row">
				<div class="irl-loc-field"><label>Latitude</label><input type="number" step="0.00001" data-fb="lat" value="${esc(Number(p.lat ?? 0).toFixed(5))}" /></div>
				<div class="irl-loc-field"><label>Longitude</label><input type="number" step="0.00001" data-fb="lng" value="${esc(Number(p.lng ?? 0).toFixed(5))}" /></div>
				<div class="irl-loc-field heading"><label>Heading°</label><input type="number" min="0" max="359" step="1" data-fb="heading" value="${esc(norm360(p.heading))}" /></div>
				<button class="irl-action" data-fb-here type="button">Use my location</button>
				<button class="irl-btn primary" data-fb-save type="button">Save</button>
			</div>
			<div class="fb-err" data-fb-err hidden></div>
		</div>`;

		body.querySelector('[data-sk-action="retry"]')?.addEventListener('click', () => { initMap(); });
		body.querySelector('[data-fb-here]')?.addEventListener('click', (ev) => {
			const btn = ev.currentTarget;
			if (!navigator.geolocation) { btn.textContent = 'Location unavailable'; return; }
			btn.disabled = true; btn.textContent = 'Locating…';
			navigator.geolocation.getCurrentPosition(
				(pos) => {
					body.querySelector('[data-fb="lat"]').value = pos.coords.latitude.toFixed(5);
					body.querySelector('[data-fb="lng"]').value = pos.coords.longitude.toFixed(5);
					btn.disabled = false; btn.textContent = 'Use my location';
				},
				() => { btn.disabled = false; btn.textContent = 'Location unavailable'; },
				{ enableHighAccuracy: true, timeout: 8000 },
			);
		});
		body.querySelector('[data-fb-save]')?.addEventListener('click', async (ev) => {
			const btn = ev.currentTarget;
			const err = body.querySelector('[data-fb-err]');
			const lat = parseFloat(body.querySelector('[data-fb="lat"]').value);
			const lng = parseFloat(body.querySelector('[data-fb="lng"]').value);
			const heading = parseInt(body.querySelector('[data-fb="heading"]').value, 10);
			err.hidden = true;
			if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) {
				err.textContent = 'Enter a valid latitude (−90…90) and longitude (−180…180).'; err.hidden = false; return;
			}
			btn.disabled = true; btn.textContent = 'Saving…';
			try {
				await persist(lat, lng, Number.isFinite(heading) ? heading : undefined, null);
				btn.textContent = 'Saved ✓';
				setTimeout(close, 800);
			} catch {
				btn.disabled = false; btn.textContent = 'Retry save';
				err.textContent = 'Couldn’t save. Check your connection and try again.'; err.hidden = false;
			}
		});
	}

	async function initMap() {
		try { map?.remove(); } catch { /* noop */ }
		map = null;
		renderMapShell();
		try { L = await loadLeaflet(); }
		catch { renderFallback(); return; }
		try { buildMap(); }
		catch { renderFallback(); }
	}

	initMap();
}

// ── Inbox modal: the chronological feed of every IRL encounter ──────────────
// One rich row per interaction across all of the owner's pins. Pays deep-link to
// the block explorer; visitor messages can be replied to inline (the reply
// notifies the visitor when they were signed in). Opening the inbox marks
// everything read.
function inboxRow(ix) {
	const owner  = isOwnerReply(ix);
	const unread = !ix.seen_at && !owner;
	const icon   = INTERACTION_ICON[ix.type] || '•';
	const place  = ix.avatar_name ? `“${esc(ix.avatar_name)}”` : 'Your agent';
	const tx     = ix.type === 'pay' ? explorerTxUrl(ix.payload?.signature, ix.payload?.network) : null;
	const txLink = tx ? `<a class="irl-inbox-action" href="${esc(tx)}" target="_blank" rel="noopener">View tx ↗</a>` : '';
	const reply  = (ix.type === 'message' && !owner)
		? `<button class="irl-inbox-action" data-reply="${esc(ix.id)}" type="button">Reply</button>` : '';
	const msg    = ix.message ? `<div class="irl-inbox-msg">“${esc(ix.message)}”</div>` : '';
	const coords = (ix.lat != null && ix.lng != null)
		? `<span class="irl-inbox-place">@ ${esc(Number(ix.lat).toFixed(4))}, ${esc(Number(ix.lng).toFixed(4))}</span>` : '';
	return `<div class="irl-inbox-row${owner ? ' owner' : ''}${unread ? ' unread' : ''}" data-row="${esc(ix.id)}" data-row-pin="${esc(ix.pin_id)}">
		<span class="irl-inbox-icon" aria-hidden="true">${icon}</span>
		<div class="irl-inbox-main">
			<div class="irl-inbox-head"><span class="irl-inbox-who">${ixHeadline(ix)}</span><span class="irl-inbox-time">${esc(relTime(ix.created_at))}</span></div>
			${msg}
			<div class="irl-inbox-meta"><span class="irl-inbox-agent">${place}</span>${coords}${txLink}${reply}</div>
		</div>
	</div>`;
}

function openInboxModal() {
	if (document.querySelector('.irl-modal-root[data-inbox]')) return; // single instance
	const root = makeNode(`<div class="irl-modal-root" data-inbox>
		<div class="irl-modal-back"></div>
		<div class="irl-modal" role="dialog" aria-modal="true" aria-label="IRL interactions inbox">
			<div class="irl-modal-head">
				<div class="irl-modal-titles">
					<div class="irl-modal-title">Inbox</div>
					<div class="irl-modal-sub">Everyone who met your agents in real life</div>
				</div>
				<button class="irl-modal-x" data-close type="button" aria-label="Close">×</button>
			</div>
			<div class="irl-modal-body" data-body>${skeletonHTML(5, 'row')}</div>
		</div>
	</div>`);
	ensureStateKitStyles();
	document.body.appendChild(root);
	document.body.style.overflow = 'hidden';

	const body = root.querySelector('[data-body]');
	let composingCount = 0; // open reply composers — guards close + poll refresh
	let flash = null;       // one-shot confirmation strip shown on the next render

	const close = () => {
		root.remove();
		document.body.style.overflow = '';
		document.removeEventListener('keydown', onKey, true);
		inboxModal = null;
	};
	const onKey = (ev) => { if (ev.key === 'Escape' && composingCount === 0) close(); };
	document.addEventListener('keydown', onKey, true);
	root.querySelector('[data-close]').addEventListener('click', close);
	root.querySelector('.irl-modal-back').addEventListener('click', () => { if (composingCount === 0) close(); });
	setTimeout(() => root.querySelector('[data-close]')?.focus(), 0);

	// Exposed so the poll loop can keep an open inbox fresh (unless mid-reply).
	inboxModal = { isComposing: () => composingCount > 0, refresh: (rows) => render(rows) };

	function render(rows) {
		composingCount = 0; // a full rebuild drops any open composer
		const flashHtml = flash ? `<div class="irl-inbox-flash">${esc(flash)}</div>` : '';
		flash = null;
		if (!rows.length) {
			body.innerHTML = flashHtml + emptyStateHTML({
				icon: '📍',
				title: 'No interactions yet',
				body: 'When someone taps or pays your agent IRL, it shows up here.',
				actions: [{ label: 'View in IRL', href: '/irl', primary: true }],
			});
			return;
		}
		body.innerHTML = flashHtml + `<div class="irl-inbox-list">${rows.map(inboxRow).join('')}</div>`;
		// Lazy-label each unique pin's location (cached, shared with the cards).
		const seen = new Set();
		for (const ix of rows) {
			if (ix.lat == null || seen.has(ix.pin_id)) continue;
			seen.add(ix.pin_id);
			placeFor(ix.lat, ix.lng).then((place) => {
				if (!place) return;
				body.querySelectorAll(`[data-row-pin="${CSS.escape(ix.pin_id)}"] .irl-inbox-place`)
					.forEach((elp) => { elp.textContent = `@ ${place}`; });
			});
		}
	}

	async function load() {
		try {
			const data = await get('/api/irl/interactions?mine=1');
			inbox.interactions = data.interactions || [];
			const hadUnread = (data.unread || 0) > 0;
			inbox.unread = data.unread || 0;
			render(inbox.interactions); // shows unread highlights for this view
			if (hadUnread) {
				// Opening the inbox IS the read action. Persist it, then clear the badge,
				// the per-card chips and the banner — but leave the modal's highlights so
				// the owner can see what was new this visit.
				patch('/api/irl/interactions', {}).catch(() => {});
				inbox.interactions = inbox.interactions.map((x) => x.seen_at ? x : { ...x, seen_at: new Date().toISOString() });
				inbox.unread = 0;
				applyBadges();
				renderBanner();
			}
		} catch {
			body.innerHTML = errorStateHTML({
				title: "Couldn't load your inbox",
				body: 'Check your connection and try again.',
				scope: 'inbox',
			});
			body.querySelector('[data-sk-retry]')?.addEventListener('click', () => {
				body.innerHTML = skeletonHTML(5, 'row');
				load();
			});
		}
	}

	// ── Reply composer ─────────────────────────────────────────────────────────
	body.addEventListener('click', async (e) => {
		const replyBtn = e.target.closest('[data-reply]');
		if (replyBtn) return openComposer(replyBtn.dataset.reply);
		if (e.target.closest('[data-reply-cancel]')) return closeComposer(e.target.closest('.irl-inbox-row'));
		const sendBtn = e.target.closest('[data-reply-send]');
		if (sendBtn) return sendReply(sendBtn);
	});

	function openComposer(ixId) {
		const row = body.querySelector(`[data-row="${CSS.escape(ixId)}"]`);
		if (!row || row.querySelector('.irl-reply-box')) return;
		composingCount++;
		const boxEl = makeNode(`<div class="irl-reply-box">
			<textarea class="irl-reply-input" rows="2" maxlength="280" placeholder="Reply to this visitor…" aria-label="Reply to visitor"></textarea>
			<div class="irl-reply-actions">
				<span class="irl-reply-hint" data-reply-hint></span>
				<button class="irl-action" data-reply-cancel type="button">Cancel</button>
				<button class="irl-btn primary" data-reply-send="${esc(ixId)}" type="button">Send reply</button>
			</div>
		</div>`);
		row.querySelector('.irl-inbox-main').appendChild(boxEl);
		boxEl.querySelector('.irl-reply-input')?.focus();
	}

	function closeComposer(row) {
		const boxEl = row?.querySelector('.irl-reply-box');
		if (boxEl) { boxEl.remove(); composingCount = Math.max(0, composingCount - 1); }
	}

	async function sendReply(sendBtn) {
		const ixId  = sendBtn.dataset.replySend;
		const row   = body.querySelector(`[data-row="${CSS.escape(ixId)}"]`);
		const input = row?.querySelector('.irl-reply-input');
		const hint  = row?.querySelector('[data-reply-hint]');
		const text  = input?.value?.trim() ?? '';
		const ix    = inbox.interactions.find((x) => x.id === ixId);
		if (!text || !ix) { input?.focus(); return; }
		sendBtn.disabled = true; sendBtn.textContent = 'Sending…';
		if (hint) { hint.className = 'irl-reply-hint'; hint.textContent = ''; }
		try {
			const r = await post('/api/irl/interactions', {
				pinId: ix.pin_id, type: 'message', message: text, replyTo: ixId,
			});
			// Optimistically thread the reply into state; the next poll reconciles it
			// with the server row. The flash strip carries the "did it reach them" note.
			inbox.interactions.unshift({
				id: r?.interaction?.id || `tmp-${ixId}-${text.length}`,
				pin_id: ix.pin_id,
				agent_id: ix.agent_id ?? null,
				type: 'message',
				message: text,
				created_at: r?.interaction?.created_at || new Date().toISOString(),
				seen_at: r?.interaction?.created_at || new Date().toISOString(),
				payload: { from: 'owner' },
				avatar_name: ix.avatar_name,
				lat: ix.lat, lng: ix.lng,
			});
			flash = r?.notified ? 'Reply sent — visitor notified ✓' : 'Reply saved ✓';
			render(inbox.interactions);
			refreshCardFeed(ix.pin_id);
			applyBadges();
		} catch (err) {
			sendBtn.disabled = false; sendBtn.textContent = 'Send reply';
			if (hint) { hint.className = 'irl-reply-hint err'; hint.textContent = err?.message || 'Could not send'; }
		}
	}

	load();
}

// ── Services modal: attach/price the skills this agent offers IRL ───────────
function openServicesModal(agentId, agentName) {
	const root = makeNode(`<div class="irl-modal-root">
		<div class="irl-modal-back"></div>
		<div class="irl-modal" role="dialog" aria-modal="true" aria-label="Manage paid services">
			<div class="irl-modal-head">
				<div class="irl-modal-titles">
					<div class="irl-modal-title">Paid services</div>
					<div class="irl-modal-sub">${esc(agentName)} · pay-per-call via x402</div>
				</div>
				<button class="irl-modal-x" data-close type="button" aria-label="Close">×</button>
			</div>
			<div class="irl-modal-body" data-body>${skeletonHTML(3, 'row')}</div>
		</div>
	</div>`);
	ensureStateKitStyles();
	document.body.appendChild(root);
	document.body.style.overflow = 'hidden';

	const body = root.querySelector('[data-body]');
	const close = () => {
		root.remove();
		document.body.style.overflow = '';
		document.removeEventListener('keydown', onKey, true);
	};
	const onKey = (ev) => { if (ev.key === 'Escape') close(); };
	document.addEventListener('keydown', onKey, true);
	root.querySelector('[data-close]').addEventListener('click', close);
	root.querySelector('.irl-modal-back').addEventListener('click', close);
	setTimeout(() => root.querySelector('[data-close]')?.focus(), 0);

	// state.prices: active (+ in-session paused) agent_skill_prices rows.
	// state.skills: skills the agent actually exposes — the only priceable set.
	// state.catalog: best-effort slug→marketplace-skill metadata (name/suggested).
	const state = { prices: [], skills: [], catalog: {} };

	async function load() {
		try {
			const [pricing, agentResp] = await Promise.all([
				get(`/api/agents/${encodeURIComponent(agentId)}/skills-pricing`),
				get(`/api/agents/${encodeURIComponent(agentId)}`),
			]);
			state.prices = (pricing?.prices || []).map((p) => ({ ...p }));
			state.skills = Array.isArray(agentResp?.agent?.skills) ? agentResp.agent.skills : [];
			try {
				const sk = await get('/api/skills?installed=true');
				const arr = Array.isArray(sk) ? sk : (sk?.skills || sk?.data?.skills || []);
				for (const s of arr) if (s?.slug) state.catalog[s.slug] = s;
			} catch { /* metadata is optional — raw skill names still work */ }
			renderShell();
		} catch {
			body.innerHTML = errorStateHTML({
				title: "Couldn't load services",
				body: 'Check your connection and try again.',
			});
			body.querySelector('[data-sk-retry]')?.addEventListener('click', () => {
				body.innerHTML = skeletonHTML(3, 'row');
				load();
			});
		}
	}

	function renderShell() {
		body.innerHTML = `
			<section class="irl-svc-sec">
				<div class="irl-svc-sec-h">Active services <span class="irl-svc-count" data-count></span></div>
				<div data-active></div>
			</section>
			<section class="irl-svc-sec">
				<div class="irl-svc-sec-h">Add a service</div>
				<div data-add></div>
			</section>`;
		renderActive();
		renderAdd();
	}

	function skillName(slug) { return state.catalog[slug]?.name || slug; }

	function renderActive() {
		const host = body.querySelector('[data-active]');
		const countEl = body.querySelector('[data-count]');
		if (countEl) countEl.textContent = state.prices.length ? `· ${state.prices.length}` : '';
		if (!host) return;
		if (!state.prices.length) {
			host.innerHTML = emptyStateHTML({
				compact: true,
				title: 'No paid services yet',
				body: 'Attach a skill below and set a per-call price so visitors can pay this agent in person.',
			});
			return;
		}
		host.innerHTML = state.prices.map(rowHtml).join('');
	}

	function rowHtml(p) {
		const cur = currencyForMint(p.currency_mint);
		const human = fromAtomic(p.amount, cur.decimals);
		const paused = !!p._paused;
		const free = Number(p.amount) === 0;
		const priceText = free ? 'Free' : `${human} ${esc(cur.label)}`;
		return `<div class="irl-pr-row${paused ? ' paused' : ''}" data-row="${esc(p.skill)}">
			<div class="irl-pr-main">
				<div class="irl-pr-name">${esc(skillName(p.skill))}${paused ? '<span class="irl-pr-tag">paused</span>' : ''}</div>
				<div class="irl-pr-meta"><span class="irl-pr-price">${priceText}</span> · ${esc(cur.label)} on ${esc(p.chain || 'solana')}</div>
			</div>
			<div class="irl-pr-actions" data-actions>
				<button class="irl-link-btn" data-edit="${esc(p.skill)}" type="button">Edit price</button>
				${paused
					? `<button class="irl-link-btn" data-resume="${esc(p.skill)}" type="button">Resume</button>`
					: `<button class="irl-link-btn" data-pause="${esc(p.skill)}" type="button">Pause</button>`}
				<button class="irl-link-btn danger" data-remove-svc="${esc(p.skill)}" type="button">Remove</button>
			</div>
			<div class="irl-pr-err" data-row-err hidden></div>
		</div>`;
	}

	function rowEl(skill) { return body.querySelector(`[data-row="${CSS.escape(skill)}"]`); }
	function rowError(skill, msg) {
		const e = rowEl(skill)?.querySelector('[data-row-err]');
		if (e) { e.textContent = msg; e.hidden = !msg; }
	}
	function pulse(skill) {
		const r = rowEl(skill);
		if (!r) return;
		r.classList.remove('saved'); void r.offsetWidth; r.classList.add('saved');
	}

	// Enter inline edit mode for a row's price.
	function beginEdit(skill) {
		const p = state.prices.find((x) => x.skill === skill);
		const row = rowEl(skill);
		if (!p || !row) return;
		const cur = currencyForMint(p.currency_mint);
		const actions = row.querySelector('[data-actions]');
		actions.innerHTML = `
			<input class="irl-pr-input" type="number" min="0" step="any" value="${esc(fromAtomicInput(p.amount, cur.decimals))}" aria-label="New price in ${esc(cur.label)}" />
			<span class="irl-pr-cur">${esc(cur.label)}</span>
			<button class="irl-link-btn" data-save-edit="${esc(skill)}" type="button">Save</button>
			<button class="irl-link-btn" data-cancel-edit type="button">Cancel</button>`;
		actions.querySelector('.irl-pr-input')?.focus();
	}

	// Write a price (atomic) for a skill via the canonical single-skill upsert.
	async function writePrice(skill, atomic, mint, chain) {
		return post(`/api/agent-skill-price?agentId=${encodeURIComponent(agentId)}`, {
			skill, amount: atomic, currency_mint: mint, chain,
		});
	}

	function renderAdd() {
		const host = body.querySelector('[data-add]');
		if (!host) return;
		const priced = new Set(state.prices.map((p) => p.skill));
		const available = state.skills.filter((s) => !priced.has(s));

		if (!state.skills.length) {
			host.innerHTML = emptyStateHTML({
				compact: true,
				title: 'This agent exposes no skills',
				body: 'Give the agent skills first, then price them here as paid services.',
			});
			return;
		}
		if (!available.length) {
			host.innerHTML = emptyStateHTML({
				compact: true,
				title: 'Every exposed skill is priced',
				body: 'Edit or pause a service above to change it.',
			});
			return;
		}

		const opts = available.map((s) => `<option value="${esc(s)}">${esc(skillName(s))}</option>`).join('');
		const curOpts = CURRENCIES.map((c, i) => `<option value="${i}">${esc(c.label)}</option>`).join('');
		host.innerHTML = `<form class="irl-add-form" data-add-form>
			<div class="irl-add-grid">
				<label class="irl-add-field">
					<span>Skill</span>
					<select data-f="skill">${opts}</select>
				</label>
				<label class="irl-add-field">
					<span>Price / call</span>
					<input data-f="amount" type="number" min="0" step="any" placeholder="0.05" inputmode="decimal" />
				</label>
				<label class="irl-add-field">
					<span>Currency</span>
					<select data-f="currency">${curOpts}</select>
				</label>
			</div>
			<div class="irl-add-row">
				<span class="irl-add-hint">0 = free / deactivated. Stored on-chain as atomic units.</span>
				<button class="irl-btn primary" data-add-submit type="submit">Add service</button>
			</div>
			<div class="irl-add-err" data-add-err hidden></div>
		</form>`;

		// Prefill a suggested price from the marketplace catalog when present.
		const form = host.querySelector('[data-add-form]');
		const skillSel = form.querySelector('[data-f="skill"]');
		const amountInput = form.querySelector('[data-f="amount"]');
		const syncSuggested = () => {
			const meta = state.catalog[skillSel.value];
			const sugg = meta && Number(meta.price_per_call_usd) > 0 ? Number(meta.price_per_call_usd) : null;
			amountInput.placeholder = sugg != null ? String(sugg) : '0.05';
		};
		skillSel.addEventListener('change', syncSuggested);
		syncSuggested();
	}

	function addError(msg) {
		const e = body.querySelector('[data-add-err]');
		if (e) { e.textContent = msg; e.hidden = !msg; }
	}

	// ── Delegated actions ────────────────────────────────────────────────────
	body.addEventListener('submit', async (e) => {
		if (!e.target.closest('[data-add-form]')) return;
		e.preventDefault();
		const form = e.target;
		const skill = form.querySelector('[data-f="skill"]').value;
		const amountRaw = form.querySelector('[data-f="amount"]').value;
		const cur = CURRENCIES[Number(form.querySelector('[data-f="currency"]').value)] || CURRENCIES[0];

		addError('');
		if (!skill) return addError('Pick a skill');
		const amount = Number(amountRaw);
		if (!(amount >= 0)) return addError('Price must be ≥ 0');
		if (!BASE58_RE.test(cur.mint)) return addError('Invalid mint');
		if (!state.skills.includes(skill)) return addError("This agent doesn't expose that skill");

		const atomic = toAtomic(amount, cur.decimals);
		const btn = form.querySelector('[data-add-submit]');
		btn.disabled = true; btn.textContent = 'Adding…';
		try {
			await writePrice(skill, atomic, cur.mint, cur.chain);
			// amount=0 deactivates server-side; only list it when it's a live price.
			const existing = state.prices.find((p) => p.skill === skill);
			if (atomic > 0) {
				if (existing) Object.assign(existing, { amount: atomic, currency_mint: cur.mint, chain: cur.chain, _paused: false });
				else state.prices.push({ skill, amount: atomic, currency_mint: cur.mint, chain: cur.chain });
			}
			renderActive(); renderAdd();
			if (atomic > 0) pulse(skill);
		} catch (err) {
			btn.disabled = false; btn.textContent = 'Add service';
			addError(err?.status === 403 ? 'Not your agent' : (err?.message || 'Could not save'));
		}
	});

	body.addEventListener('click', async (e) => {
		// Edit price
		const editBtn = e.target.closest('[data-edit]');
		if (editBtn) return beginEdit(editBtn.dataset.edit);

		// Cancel edit
		if (e.target.closest('[data-cancel-edit]')) return renderActive();

		// Save edited price
		const saveBtn = e.target.closest('[data-save-edit]');
		if (saveBtn) {
			const skill = saveBtn.dataset.saveEdit;
			const p = state.prices.find((x) => x.skill === skill);
			const input = rowEl(skill)?.querySelector('.irl-pr-input');
			if (!p || !input) return;
			const cur = currencyForMint(p.currency_mint);
			const amount = Number(input.value);
			rowError(skill, '');
			if (!(amount >= 0)) return rowError(skill, 'Price must be ≥ 0');
			const atomic = toAtomic(amount, cur.decimals);
			saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
			try {
				await writePrice(skill, atomic, p.currency_mint, p.chain || cur.chain);
				if (atomic === 0) { state.prices = state.prices.filter((x) => x.skill !== skill); }
				else { p.amount = atomic; p._paused = false; }
				renderActive(); renderAdd();
				if (atomic > 0) pulse(skill);
			} catch (err) {
				saveBtn.disabled = false; saveBtn.textContent = 'Save';
				rowError(skill, err?.message || 'Could not save');
			}
			return;
		}

		// Pause (deactivate, keep amount for in-session resume)
		const pauseBtn = e.target.closest('[data-pause]');
		if (pauseBtn) {
			const skill = pauseBtn.dataset.pause;
			const p = state.prices.find((x) => x.skill === skill);
			if (!p) return;
			pauseBtn.disabled = true; pauseBtn.textContent = 'Pausing…';
			try {
				await writePrice(skill, 0, p.currency_mint, p.chain || 'solana');
				p._paused = true;
				renderActive();
			} catch (err) {
				pauseBtn.disabled = false; pauseBtn.textContent = 'Pause';
				rowError(skill, err?.message || 'Could not pause');
			}
			return;
		}

		// Resume (re-assert the retained price)
		const resumeBtn = e.target.closest('[data-resume]');
		if (resumeBtn) {
			const skill = resumeBtn.dataset.resume;
			const p = state.prices.find((x) => x.skill === skill);
			if (!p) return;
			const cur = currencyForMint(p.currency_mint);
			resumeBtn.disabled = true; resumeBtn.textContent = 'Resuming…';
			try {
				await writePrice(skill, Number(p.amount) || 0, p.currency_mint, p.chain || cur.chain);
				p._paused = false;
				renderActive();
				pulse(skill);
			} catch (err) {
				resumeBtn.disabled = false; resumeBtn.textContent = 'Resume';
				rowError(skill, err?.message || 'Could not resume');
			}
			return;
		}

		// Remove — inline confirm, then deactivate
		const removeBtn = e.target.closest('[data-remove-svc]');
		if (removeBtn) {
			const skill = removeBtn.dataset.removeSvc;
			const actions = rowEl(skill)?.querySelector('[data-actions]');
			if (!actions) return;
			actions.innerHTML = `<span class="irl-pr-confirm">Remove this service?</span>
				<button class="irl-link-btn" data-cancel-edit type="button">Keep</button>
				<button class="irl-link-btn danger" data-remove-yes="${esc(skill)}" type="button">Remove</button>`;
			return;
		}
		const removeYes = e.target.closest('[data-remove-yes]');
		if (removeYes) {
			const skill = removeYes.dataset.removeYes;
			const p = state.prices.find((x) => x.skill === skill);
			if (!p) return;
			removeYes.disabled = true; removeYes.textContent = 'Removing…';
			try {
				await writePrice(skill, 0, p.currency_mint, p.chain || 'solana');
				state.prices = state.prices.filter((x) => x.skill !== skill);
				renderActive(); renderAdd();
			} catch (err) {
				removeYes.disabled = false; removeYes.textContent = 'Remove';
				rowError(skill, err?.message || 'Could not remove');
			}
		}
	});

	load();
}

(async function boot() {
	const el = await mountShell();
	try {
		await requireUser();
		await mount(el);
	} catch (e) {
		ensureStateKitStyles();
		el.innerHTML = STYLE + errorStateHTML({
			title: "Couldn't load your IRL agents",
			body: esc(e?.message || 'Check your connection and try again.'),
		});
		el.querySelector('[data-sk-retry]')?.addEventListener('click', () => location.reload());
	}
})();
