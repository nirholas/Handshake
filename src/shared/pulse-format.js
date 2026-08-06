/**
 * Money-pulse formatting — the single source of truth for how the Money Pulse and
 * Viability surfaces render numbers, agents and timestamps. Both /pulse and
 * /viability route through these so the SAME value reads identically on either
 * page: a compact $THREE figure in a counter matches the figure in a KPI, an
 * agent row looks the same in a rail card and a leaderboard.
 *
 * These are deliberately distinct from the wallet-layer formatters in
 * shared/wallet-format.js: the pulse tier uses lowercase magnitude suffixes
 * (1.2k, 3.4M) and SOL/$THREE-native shapes the wallet chrome never needs.
 */

import { walletChipHTML } from './agent-wallet-chip.js';

export const esc = (s) =>
	String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function fmtUsd(n) {
	if (!(Number(n) > 0)) return '$0';
	const v = Number(n);
	if (v >= 1000) return `$${(v / 1000).toFixed(1)}k`;
	return `$${v.toFixed(v < 10 ? 2 : 0)}`;
}

export function fmtSol(n) {
	const v = Number(n) || 0;
	return `◎${v >= 1 ? v.toFixed(2) : v.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}`;
}

export function fmtNum(n) {
	const v = Number(n) || 0;
	if (v >= 10000) return `${(v / 1000).toFixed(1)}k`;
	return String(v);
}

// Whole-token $THREE amount → compact label (e.g. 12.4k, 1.2M, 340).
export function fmtThree(n) {
	const v = Number(n) || 0;
	if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
	if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
	if (v >= 100) return String(Math.round(v));
	return v.toFixed(v < 1 ? 3 : 1).replace(/\.0$/, '');
}

export const fmtPct = (frac) => `${Math.round((Number(frac) || 0) * 100)}%`;

// Signed SOL → compact ledger label with an explicit sign and direction glyph.
// Monochrome by design: the arrow carries the sign, never colour.
export function fmtSignedSol(n) {
	const v = Number(n) || 0;
	if (v === 0) return '◎0';
	const mag = Math.abs(v);
	const body = mag >= 1 ? mag.toFixed(2) : mag.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
	return `${v > 0 ? '▲ +' : '▼ −'}◎${body}`;
}

export function timeAgo(iso) {
	const t = new Date(iso).getTime();
	if (!Number.isFinite(t)) return '';
	const s = Math.max(0, Math.round((Date.now() - t) / 1000));
	if (s < 60) return 'just now';
	const m = Math.round(s / 60);
	if (m < 60) return `${m}m ago`;
	const h = Math.round(m / 60);
	if (h < 24) return `${h}h ago`;
	return `${Math.round(h / 24)}d ago`;
}

// A single agent leaderboard / rail row: avatar (or mono initial), name with an
// optional wallet chip, and a caller-supplied metric on the right.
export function agentCardHTML(a, metricHTML) {
	const av = a.avatar_thumbnail_url
		? `<img class="px-lb-av" src="${esc(a.avatar_thumbnail_url)}" alt="" loading="lazy" data-fallback="invisible" />`
		: `<span class="px-lb-av px-lb-av--mono" aria-hidden="true">${esc((a.name || '?').charAt(0).toUpperCase())}</span>`;
	const chip = a.solana_address
		? walletChipHTML({ name: a.name, meta: { solana_address: a.solana_address } }, { link: false, tip: false, showPending: false, balance: false, popover: false })
		: '';
	return (
		`<a class="px-lb-row" href="${esc(a.url)}">` +
		av +
		`<span class="px-lb-name">${esc(a.name)}${chip ? `<span class="px-lb-chip">${chip}</span>` : ''}</span>` +
		`<span class="px-lb-metric">${metricHTML}</span>` +
		`</a>`
	);
}
