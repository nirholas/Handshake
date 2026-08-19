// Shared wallet-reputation UI — the single source of truth for the trust badge
// and the breakdown view, used everywhere an agent appears.
//
// In a world of infinite forkable avatars, trust is the scarce asset. This module
// renders an agent's REAL, server-computed credibility score (see
// api/_lib/trust/wallet-reputation.js) as:
//   • a compact badge that hangs off the wallet identity on every surface, and
//   • a full breakdown panel (HUD tab) that explains exactly why the score is
//     what it is, with links to the real evidence.
//
// All numbers come from GET /api/agents/:id/reputation (single) and
// /api/agents/reputation-batch (lists). Nothing is computed or faked client-side;
// a brand-new agent honestly renders as "New", never a fabricated number.

import { apiFetch } from '../api.js';

// ── tiny utils ──────────────────────────────────────────────────────────────
const isBrowser = () => typeof window !== 'undefined' && typeof document !== 'undefined';
const esc = (s) =>
	String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SHIELD_SVG =
	'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>';

// ── data layer (real APIs, in-memory coalescing) ─────────────────────────────

const _cache = new Map(); // agentId -> compact rep (lite)
const _full = new Map(); // agentId -> full rep promise

/**
 * Full reputation for a single agent (score, pillars, evidence, guidance).
 * Cached per page load; pass force to bypass.
 */
export async function fetchReputation(agentId, { force = false } = {}) {
	if (!agentId) return null;
	if (!force && _full.has(agentId)) return _full.get(agentId);
	const p = (async () => {
		const res = await apiFetch(`/api/agents/${encodeURIComponent(agentId)}/reputation`, { allowAnonymous: true });
		if (!res.ok) throw new Error(`reputation ${res.status}`);
		return res.json();
	})();
	_full.set(agentId, p);
	p.catch(() => _full.delete(agentId)); // don't cache failures
	return p;
}

/**
 * Compact reputation for many agents in one round-trip. Returns a map
 * { agentId: { score, tier, tierLabel, accent, isNew, totals } }.
 */
export async function fetchReputationBatch(ids) {
	const want = [...new Set((ids || []).filter((id) => id && UUID_RE.test(String(id))))].filter((id) => !_cache.has(id));
	if (want.length) {
		try {
			const res = await apiFetch('/api/agents/reputation-batch', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ ids: want }),
				allowAnonymous: true,
			});
			if (res.ok) {
				const { data } = await res.json();
				for (const id of want) if (data?.[id]) _cache.set(id, data[id]);
			}
		} catch {
			/* leave uncached; badges stay in their resting (unloaded) state */
		}
	}
	const out = {};
	for (const id of ids || []) if (_cache.get(id)) out[id] = _cache.get(id);
	return out;
}

// ── badge rendering ──────────────────────────────────────────────────────────

/**
 * Inner markup for a hydrated badge given compact rep data. A brand-new agent
 * renders an honest neutral "New" chip; everyone else gets a tier + score pill
 * tinted by the server-provided tier accent.
 */
function badgeInner(rep) {
	if (!rep) return '';
	if (rep.isNew) {
		return `<span class="rep-badge rep-badge--new" title="New agent — no track record yet">✦ New</span>`;
	}
	const score = Math.round(rep.score);
	const tip = `Wallet trust ${score}/100 · ${rep.tierLabel}. Click for the breakdown.`;
	return (
		`<span class="rep-badge" style="--rep-accent:${esc(rep.accent || '#c4b5fd')}" title="${esc(tip)}">` +
		SHIELD_SVG +
		`<span class="rep-badge-tier">${esc(rep.tierLabel)}</span>` +
		`<span class="rep-badge-score">${score}</span>` +
		`</span>`
	);
}

/**
 * A placeholder badge that hydrates itself from the batch endpoint when it
 * scrolls into view. `agentId` must be a real agent UUID. Returns an HTML string;
 * call hydrateReputationBadges(root) after injecting, or use reputationBadgeEl()
 * for a ready-wired node.
 */
export function reputationBadgeHTML(agentId, opts = {}) {
	if (!agentId || !UUID_RE.test(String(agentId))) return '';
	const embedded = opts.embedded ? ' data-rep-embedded="1"' : '';
	return `<span class="rep-badge-slot" data-rep-aid="${esc(agentId)}"${embedded} aria-label="Wallet trust score loading"></span>`;
}

export function reputationBadgeEl(agentId, opts = {}) {
	if (!isBrowser()) return null;
	const html = reputationBadgeHTML(agentId, opts);
	if (!html) return null;
	const tpl = document.createElement('template');
	tpl.innerHTML = html.trim();
	const node = tpl.content.firstElementChild;
	if (node) observeReputationBadge(node);
	return node;
}

// shared observer + batch queue for placeholder badges
let _io = null;
const _queued = new Set(); // aids waiting to fetch
let _flushT = null;

function ensureIO() {
	if (_io || !isBrowser() || typeof IntersectionObserver === 'undefined') return _io;
	_io = new IntersectionObserver(
		(entries) => {
			let changed = false;
			for (const e of entries) {
				if (!e.isIntersecting) continue;
				const aid = e.target.getAttribute('data-rep-aid');
				if (aid && !_cache.has(aid)) {
					_queued.add(aid);
					changed = true;
				} else if (aid && _cache.has(aid)) {
					fillBadge(e.target, _cache.get(aid));
				}
				_io.unobserve(e.target);
			}
			if (changed) scheduleFlush();
		},
		{ rootMargin: '150px' },
	);
	return _io;
}

function scheduleFlush() {
	if (_flushT) return;
	_flushT = setTimeout(async () => {
		_flushT = null;
		const ids = [..._queued];
		_queued.clear();
		if (!ids.length) return;
		await fetchReputationBatch(ids);
		// Fill every connected placeholder whose data just arrived.
		if (!isBrowser()) return;
		for (const el of document.querySelectorAll('.rep-badge-slot[data-rep-aid]')) {
			const aid = el.getAttribute('data-rep-aid');
			if (_cache.has(aid) && !el.__repFilled) fillBadge(el, _cache.get(aid));
		}
	}, 80);
}

function fillBadge(el, rep) {
	if (!el || el.__repFilled) return;
	el.__repFilled = true;
	const inner = badgeInner(rep);
	if (!inner) {
		el.remove();
		return;
	}
	el.innerHTML = inner;
	el.removeAttribute('aria-label');
	const aid = el.getAttribute('data-rep-aid');
	const badge = el.firstElementChild;
	if (badge && aid) {
		badge.setAttribute('role', 'button');
		badge.setAttribute('tabindex', '0');
		const go = (ev) => {
			ev.preventDefault();
			ev.stopPropagation();
			openReputation(aid);
		};
		badge.addEventListener('click', go);
		badge.addEventListener('keydown', (ev) => {
			if (ev.key === 'Enter' || ev.key === ' ') go(ev);
		});
	}
	ensureStyles();
}

/** Register a single placeholder element for lazy hydration. */
export function observeReputationBadge(el) {
	if (!el || !isBrowser()) return;
	ensureStyles();
	const aid = el.getAttribute?.('data-rep-aid');
	if (!aid) return;
	if (_cache.has(aid)) {
		fillBadge(el, _cache.get(aid));
		return;
	}
	const io = ensureIO();
	if (io) io.observe(el);
	else {
		_queued.add(aid);
		scheduleFlush();
	}
}

/** Scan a container and lazily hydrate every reputation badge placeholder in it. */
export function hydrateReputationBadges(root) {
	if (!root || typeof root.querySelectorAll !== 'function') return;
	for (const el of root.querySelectorAll('.rep-badge-slot[data-rep-aid]')) {
		if (!el.__repObserved) {
			el.__repObserved = true;
			observeReputationBadge(el);
		}
	}
}

/** Navigate to the agent's wallet hub, reputation tab. */
export function openReputation(agentId) {
	if (!agentId || !isBrowser()) return;
	window.location.assign(`/agents/${encodeURIComponent(agentId)}/wallet#reputation`);
}

// ── full breakdown panel (HUD tab) ───────────────────────────────────────────

const FALLBACK_PILLAR_MAX = 25;

function scoreRing(rep) {
	const pct = Math.max(0, Math.min(100, rep.score));
	const accent = rep.isNew ? 'var(--ink-faint,#6b7280)' : rep.accent || 'var(--wallet-accent,#c4b5fd)';
	return (
		`<div class="rep-ring" style="--rep-accent:${esc(accent)};--rep-pct:${pct}">` +
		`<div class="rep-ring-num">${rep.isNew ? '—' : Math.round(rep.score)}</div>` +
		`<div class="rep-ring-of">${rep.isNew ? 'new' : `/ ${rep.max}`}</div>` +
		`</div>`
	);
}

function pillarRow(p) {
	const pct = Math.max(0, Math.min(100, (p.points / (p.max || FALLBACK_PILLAR_MAX)) * 100));
	return (
		`<li class="rep-pillar">` +
		`<div class="rep-pillar-head"><span class="rep-pillar-label">${esc(p.label)}</span>` +
		`<span class="rep-pillar-pts">${p.points}<span class="rep-pillar-max">/${p.max}</span></span></div>` +
		`<div class="rep-pillar-bar"><div class="rep-pillar-fill" style="width:${pct}%"></div></div>` +
		(p.detail ? `<div class="rep-pillar-detail">${esc(p.detail)}</div>` : '') +
		`</li>`
	);
}

function evidenceRow(evidence) {
	const entries = Object.values(evidence || {}).filter((e) => e && e.href && e.label);
	if (!entries.length) return '';
	return (
		`<div class="rep-evidence"><div class="rep-section-label">Verifiable evidence</div><div class="rep-evidence-links">` +
		entries
			.map(
				(e) =>
					`<a class="rep-evi-link" href="${esc(e.href)}"${
						/^https?:/.test(e.href) ? ' target="_blank" rel="noopener noreferrer"' : ''
					}>${esc(e.label)} ↗</a>`,
			)
			.join('') +
		`</div></div>`
	);
}

function discountedRow(discounted) {
	if (!discounted?.length) return '';
	return (
		`<div class="rep-discounted"><div class="rep-section-label">What doesn't count</div><ul class="rep-discount-list">` +
		discounted
			.map((d) => `<li><strong>${esc(d.label)}</strong><span>${esc(d.detail)}</span></li>`)
			.join('') +
		`</ul></div>`
	);
}

function guidanceRow(guidance) {
	if (!guidance?.length) return '';
	return (
		`<div class="rep-guidance"><div class="rep-section-label">Raise your trust</div><ul class="rep-guide-list">` +
		guidance
			.map(
				(g) =>
					`<li><a href="${esc(g.href)}"><strong>${esc(g.label)}</strong><span>${esc(g.detail)}</span></a></li>`,
			)
			.join('') +
		`</ul></div>`
	);
}

function panelInner(rep) {
	const tierClass = rep.isNew ? 'rep-head--new' : '';
	const head =
		`<div class="rep-head ${tierClass}">` +
		scoreRing(rep) +
		`<div class="rep-head-meta">` +
		`<div class="rep-head-tier" style="--rep-accent:${esc(rep.isNew ? '#9ca3af' : rep.accent || '#c4b5fd')}">${SHIELD_SVG}${esc(rep.tierLabel)}</div>` +
		`<div class="rep-head-sub">${
			rep.isNew
				? 'No track record yet — trust is earned through real activity over time.'
				: 'A real, auditable trust score backed by money and time.'
		}</div>` +
		(rep.totals
			? `<div class="rep-head-stats">` +
			  statChip('$' + fmtUsd(rep.totals.settled_usd), 'volume') +
			  statChip(rep.totals.distinct_tippers, 'tippers') +
			  statChip(rep.totals.confirmed_payments, 'payments') +
			  statChip(rep.totals.fork_count, 'forks') +
			  (rep.totals.verified ? '<span class="rep-stat rep-stat--ok">✓ verified</span>' : '') +
			  `</div>`
			: '') +
		`</div></div>`;

	const partial = rep.partial
		? `<div class="rep-partial" role="status">Some signals were momentarily unavailable — this score may be incomplete and will refresh.</div>`
		: '';

	const pillars = `<ul class="rep-pillars">${(rep.pillars || []).map(pillarRow).join('')}</ul>`;

	return (
		head +
		partial +
		pillars +
		discountedRow(rep.discounted) +
		evidenceRow(rep.evidence) +
		(rep.is_owner ? guidanceRow(rep.guidance) : '') +
		`<div class="rep-foot">Score v${rep.version} · updated ${esc(fmtTime(rep.computed_at))}. Every input is a real, settled on-chain or ledger fact.</div>`
	);
}

function statChip(value, label) {
	return `<span class="rep-stat"><b>${esc(value)}</b> ${esc(label)}</span>`;
}

/**
 * Build the full reputation breakdown as a DOM node that loads its own data.
 * Designed for the wallet HUD reputation tab. Renders loading → populated, with
 * a real, actionable error state and a retry.
 *
 * @param {string} agentId
 * @param {object} [opts]
 * @returns {HTMLElement}
 */
export function reputationPanelEl(agentId, opts = {}) {
	ensureStyles();
	const root = document.createElement('div');
	root.className = 'rep-panel';
	root.innerHTML = skeletonHTML();

	const load = async () => {
		root.innerHTML = skeletonHTML();
		try {
			const rep = await fetchReputation(agentId, { force: opts.force });
			if (!rep) throw new Error('no data');
			root.innerHTML = panelInner(rep);
			// Wire guidance/evidence stop-propagation if embedded.
			root.querySelectorAll('a[href^="/"]').forEach((a) => a.addEventListener('click', (e) => e.stopPropagation()));
			// Access & unlocks — what this reputation opens, and what unlocks next.
			// Lazy-loaded so the badge path stays light; failure here never breaks the
			// breakdown above.
			if (opts.unlocks !== false) {
				import('./wallet-access.js')
					.then(({ renderUnlocksSection }) => {
						root.appendChild(renderUnlocksSection(agentId, { isOwner: rep.is_owner }));
					})
					.catch(() => {});
			}
		} catch {
			root.innerHTML =
				`<div class="rep-error" role="alert"><div class="rep-error-title">Trust score unavailable</div>` +
				`<p>We couldn't compute this agent's reputation just now. Its real on-chain history is unchanged.</p>` +
				`<button type="button" class="rep-retry">Try again</button></div>`;
			root.querySelector('.rep-retry')?.addEventListener('click', load);
		}
	};
	load();
	return root;
}

function skeletonHTML() {
	return (
		`<div class="rep-head"><div class="rep-ring rep-sk"></div>` +
		`<div class="rep-head-meta"><div class="rep-sk rep-sk-line" style="width:120px"></div>` +
		`<div class="rep-sk rep-sk-line" style="width:200px;margin-top:8px"></div></div></div>` +
		`<ul class="rep-pillars">${Array.from({ length: 4 })
			.map(() => `<li class="rep-pillar"><div class="rep-sk rep-sk-line" style="width:100%;height:34px"></div></li>`)
			.join('')}</ul>`
	);
}

// ── format helpers ────────────────────────────────────────────────────────────
function fmtUsd(n) {
	n = Number(n) || 0;
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return n.toFixed(n < 10 ? 2 : 0);
}
function fmtTime(iso) {
	if (!iso) return 'just now';
	try {
		const d = new Date(iso);
		const diff = (Date.now() - d.getTime()) / 1000;
		if (diff < 90) return 'just now';
		if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
		if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
		return d.toLocaleDateString();
	} catch {
		return 'recently';
	}
}

// ── styles (injected once, token-driven) ─────────────────────────────────────
let _stylesInjected = false;
export function ensureReputationStyles() {
	ensureStyles();
}
function ensureStyles() {
	if (_stylesInjected || !isBrowser()) return;
	_stylesInjected = true;
	const css = `
.rep-badge-slot{display:inline-flex;vertical-align:middle}
.rep-badge{display:inline-flex;align-items:center;gap:4px;font-family:var(--font-mono,ui-monospace,monospace);
 font-size:var(--text-2xs,11px);font-weight:600;line-height:1;padding:3px 7px 3px 6px;border-radius:var(--radius-pill,999px);
 color:var(--rep-accent,#c4b5fd);background:color-mix(in srgb,var(--rep-accent,#c4b5fd) 12%,transparent);
 border:1px solid color-mix(in srgb,var(--rep-accent,#c4b5fd) 34%,transparent);cursor:pointer;
 transition:transform var(--duration-fast,120ms) var(--ease-standard,ease),box-shadow var(--duration-fast,120ms) ease,background var(--duration-fast,120ms) ease;white-space:nowrap}
.rep-badge svg{width:11px;height:11px;opacity:.9}
.rep-badge-tier{letter-spacing:.02em}
.rep-badge-score{padding-left:5px;margin-left:1px;border-left:1px solid color-mix(in srgb,var(--rep-accent,#c4b5fd) 34%,transparent);color:var(--ink-bright,#fff)}
.rep-badge:hover{background:color-mix(in srgb,var(--rep-accent,#c4b5fd) 20%,transparent);transform:translateY(-1px)}
.rep-badge:focus-visible{outline:none;box-shadow:0 0 0 2px color-mix(in srgb,var(--rep-accent,#c4b5fd) 55%,transparent)}
.rep-badge--new{color:var(--ink-dim,#9ca3af);background:var(--surface-2,rgba(255,255,255,.05));border:1px solid var(--stroke,rgba(255,255,255,.1));cursor:default}
.rep-badge--new:hover{transform:none}

.rep-panel{font-family:var(--font-body,Inter,system-ui,sans-serif);color:var(--ink,#e5e7eb);display:flex;flex-direction:column;gap:var(--space-md,16px)}
.rep-head{display:flex;gap:var(--space-md,16px);align-items:center}
.rep-ring{--rep-pct:0;position:relative;width:84px;height:84px;flex:0 0 auto;border-radius:50%;display:flex;flex-direction:column;align-items:center;justify-content:center;
 background:radial-gradient(closest-side,var(--bg-0,#0a0a0a) 78%,transparent 79% 100%),conic-gradient(var(--rep-accent,#c4b5fd) calc(var(--rep-pct)*1%),var(--surface-2,rgba(255,255,255,.06)) 0)}
.rep-ring-num{font-family:var(--font-display,Space Grotesk,sans-serif);font-size:var(--text-2xl,28px);font-weight:700;color:var(--ink-bright,#fff);line-height:1}
.rep-ring-of{font-size:var(--text-2xs,11px);color:var(--ink-dim,#9ca3af);margin-top:2px}
.rep-head-meta{min-width:0;flex:1}
.rep-head-tier{display:inline-flex;align-items:center;gap:6px;font-family:var(--font-display,sans-serif);font-weight:700;font-size:var(--text-lg,18px);color:var(--rep-accent,#c4b5fd)}
.rep-head-tier svg{width:16px;height:16px}
.rep-head-sub{font-size:var(--text-sm,13px);color:var(--ink-dim,#9ca3af);margin-top:4px;line-height:1.4}
.rep-head-stats{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
.rep-stat{font-size:var(--text-2xs,11px);color:var(--ink-dim,#9ca3af);background:var(--surface-1,rgba(255,255,255,.03));border:1px solid var(--stroke,rgba(255,255,255,.08));border-radius:var(--radius-sm,6px);padding:3px 7px;white-space:nowrap}
.rep-stat b{color:var(--ink-bright,#fff);font-weight:700}
.rep-stat--ok{color:var(--success,#4ade80);border-color:color-mix(in srgb,var(--success,#4ade80) 30%,transparent)}
.rep-partial{font-size:var(--text-xs,12px);color:var(--warn,#fbbf24);background:color-mix(in srgb,var(--warn,#fbbf24) 10%,transparent);border:1px solid color-mix(in srgb,var(--warn,#fbbf24) 28%,transparent);border-radius:var(--radius-sm,6px);padding:8px 10px}
.rep-pillars{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:var(--space-sm,10px)}
.rep-pillar{background:var(--surface-1,rgba(255,255,255,.03));border:1px solid var(--stroke,rgba(255,255,255,.08));border-radius:var(--radius-md,10px);padding:10px 12px}
.rep-pillar-head{display:flex;justify-content:space-between;align-items:baseline;gap:8px}
.rep-pillar-label{font-size:var(--text-sm,13px);font-weight:600;color:var(--ink-bright,#fff)}
.rep-pillar-pts{font-family:var(--font-mono,monospace);font-size:var(--text-sm,13px);font-weight:700;color:var(--wallet-accent,#c4b5fd)}
.rep-pillar-max{color:var(--ink-faint,#6b7280);font-weight:400}
.rep-pillar-bar{height:4px;border-radius:2px;background:var(--surface-3,rgba(255,255,255,.08));margin:7px 0 6px;overflow:hidden}
.rep-pillar-fill{height:100%;border-radius:2px;background:linear-gradient(90deg,var(--wallet-accent,#c4b5fd),var(--wallet-accent-strong,#a78bfa));transition:width var(--duration-base,300ms) var(--ease-standard,ease)}
.rep-pillar-detail{font-size:var(--text-xs,12px);color:var(--ink-dim,#9ca3af);line-height:1.4}
.rep-section-label{font-size:var(--text-2xs,11px);text-transform:uppercase;letter-spacing:.06em;color:var(--ink-faint,#6b7280);font-weight:600;margin-bottom:8px}
.rep-discounted,.rep-evidence,.rep-guidance{padding-top:var(--space-sm,10px);border-top:1px solid var(--stroke,rgba(255,255,255,.08))}
.rep-discount-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
.rep-discount-list li{display:flex;flex-direction:column;gap:2px;font-size:var(--text-xs,12px)}
.rep-discount-list strong{color:var(--ink,#e5e7eb)}.rep-discount-list span{color:var(--ink-dim,#9ca3af);line-height:1.4}
.rep-evidence-links{display:flex;flex-wrap:wrap;gap:8px}
.rep-evi-link{font-size:var(--text-xs,12px);color:var(--wallet-accent,#c4b5fd);text-decoration:none;background:var(--wallet-accent-soft,rgba(139,92,246,.1));border:1px solid var(--wallet-stroke,rgba(139,92,246,.3));border-radius:var(--radius-pill,999px);padding:4px 10px;transition:background var(--duration-fast,120ms) ease}
.rep-evi-link:hover{background:var(--wallet-accent-fill,rgba(139,92,246,.15))}
.rep-guide-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
.rep-guide-list a{display:flex;flex-direction:column;gap:2px;text-decoration:none;padding:9px 11px;border-radius:var(--radius-md,10px);background:var(--wallet-accent-soft,rgba(139,92,246,.08));border:1px solid var(--wallet-stroke,rgba(139,92,246,.25));transition:background var(--duration-fast,120ms) ease,transform var(--duration-fast,120ms) ease}
.rep-guide-list a:hover{background:var(--wallet-accent-fill,rgba(139,92,246,.15));transform:translateX(2px)}
.rep-guide-list strong{font-size:var(--text-sm,13px);color:var(--ink-bright,#fff)}
.rep-guide-list span{font-size:var(--text-xs,12px);color:var(--ink-dim,#9ca3af);line-height:1.4}
.rep-foot{font-size:var(--text-2xs,11px);color:var(--ink-faint,#6b7280);line-height:1.4;padding-top:var(--space-xs,6px)}
.rep-error{text-align:center;padding:var(--space-lg,24px) var(--space-md,16px)}
.rep-error-title{font-weight:700;color:var(--ink-bright,#fff);margin-bottom:6px}
.rep-error p{font-size:var(--text-sm,13px);color:var(--ink-dim,#9ca3af);margin:0 0 14px}
.rep-retry{font:inherit;font-size:var(--text-sm,13px);font-weight:600;color:var(--ink-bright,#fff);background:var(--wallet-accent-fill,rgba(139,92,246,.15));border:1px solid var(--wallet-stroke-strong,rgba(139,92,246,.5));border-radius:var(--radius-md,10px);padding:8px 18px;cursor:pointer;transition:background var(--duration-fast,120ms) ease}
.rep-retry:hover{background:var(--wallet-accent-soft,rgba(139,92,246,.25))}
.rep-sk{background:linear-gradient(90deg,var(--surface-1,rgba(255,255,255,.03)) 25%,var(--surface-2,rgba(255,255,255,.06)) 37%,var(--surface-1,rgba(255,255,255,.03)) 63%);background-size:400% 100%;animation:rep-shimmer 1.4s ease infinite;border-radius:var(--radius-sm,6px)}
.rep-sk.rep-ring{border-radius:50%}
.rep-sk-line{height:12px}
@keyframes rep-shimmer{0%{background-position:100% 50%}100%{background-position:0 50%}}
@media (prefers-reduced-motion:reduce){.rep-badge,.rep-pillar-fill,.rep-guide-list a,.rep-sk{transition:none;animation:none}}
@media (max-width:480px){.rep-head{flex-direction:column;align-items:flex-start;text-align:left}}
`;
	const style = document.createElement('style');
	style.id = 'rep-styles';
	style.textContent = css;
	document.head.appendChild(style);
}
