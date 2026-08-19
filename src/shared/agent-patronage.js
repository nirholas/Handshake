// Patronage — the Support surface (visitor + patron + owner)
// ===========================================================
// Tipping an agent on three.ws builds a real relationship. This panel renders the
// living ladder of that relationship on an agent's profile: the perk ladder
// ("Tip 0.5 SOL to unlock X"), the visitor's own level + progress, the public
// patron wall, season standings, and — for the owner — a perk editor and a patron
// CRM. Every figure is real, served by GET /api/agents/:id/solana/patronage, which
// derives levels from the on-chain custody ledger. Gated perk content is released
// only after the visitor signs a wallet-ownership challenge (op:'unlock').
//
// Single source of truth — import and mount it; never copy per page.
//   import { mountPatronagePanel } from './shared/agent-patronage.js';
//   const handle = mountPatronagePanel({ mount, agent, isOwner });
//   handle.destroy();

import { apiFetch } from '../api.js';
import { openTipModal } from './agent-tip-modal.js';
import { detectSolanaWallet } from '../erc8004/solana-deploy.js';

const STYLE_ID = 'tws-patronage-styles';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const shortAddr = (a, h = 4, t = 4) => (a && a.length > h + t + 1 ? `${a.slice(0, h)}…${a.slice(-t)}` : a || '');
const fmtUsd = (n) => {
	const v = Number(n) || 0;
	if (v === 0) return '$0';
	if (v < 0.01) return `$${v.toFixed(4)}`;
	if (v < 1000) return `$${v.toFixed(2)}`;
	return `$${Math.round(v).toLocaleString('en-US')}`;
};
const relTime = (iso) => {
	if (!iso) return '';
	const d = Date.now() - new Date(iso).getTime();
	if (!Number.isFinite(d)) return '';
	const s = Math.max(0, Math.round(d / 1000));
	if (s < 60) return 'just now';
	const m = Math.round(s / 60);
	if (m < 60) return `${m}m ago`;
	const h = Math.round(m / 60);
	if (h < 24) return `${h}h ago`;
	const day = Math.round(h / 24);
	if (day < 30) return `${day}d ago`;
	return `${Math.round(day / 30)}mo ago`;
};
const PERK_GLYPH = { greeting: '✦', lore: '◈', skill: '⚡', launch_access: '🚀', badge: '✸' };
const PERK_LABEL = { greeting: 'Exclusive greeting', lore: 'Hidden lore', skill: 'Free skill', launch_access: 'Early launch access', badge: 'Patron badge' };
const explorerAddr = (w, network) => network === 'devnet'
	? `https://explorer.solana.com/address/${w}?cluster=devnet`
	: `https://solscan.io/account/${w}`;

function ensureStyles() {
	if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
	const style = document.createElement('style');
	style.id = STYLE_ID;
	style.textContent = `
.pat { --pa: var(--wallet-accent, #c4b5fd); display: flex; flex-direction: column; gap: var(--space-md, 1rem); font-family: var(--font-body, Inter, sans-serif); color: var(--ink, #e8e8e8); }
.pat-sk { height: 64px; border-radius: var(--radius-lg, 14px); background: linear-gradient(100deg, var(--surface-1, rgba(255,255,255,.03)) 30%, var(--surface-3, rgba(255,255,255,.08)) 50%, var(--surface-1, rgba(255,255,255,.03)) 70%); background-size: 200% 100%; animation: pat-shimmer 1.4s linear infinite; }
@keyframes pat-shimmer { to { background-position: -200% 0; } }
.pat-head { display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-sm, .6rem); flex-wrap: wrap; }
.pat-head h3 { margin: 0; font-family: var(--font-display, 'Space Grotesk', sans-serif); font-size: var(--text-lg, 1.236rem); font-weight: 600; }
.pat-season { font-size: var(--text-2xs, .6875rem); font-family: var(--font-mono, 'JetBrains Mono', monospace); color: var(--pa); border: 1px solid var(--wallet-stroke, rgba(139,92,246,.3)); background: var(--wallet-accent-soft, rgba(139,92,246,.1)); border-radius: var(--radius-pill, 999px); padding: 2px 10px; }
.pat-sub { font-size: var(--text-sm, .764rem); color: var(--ink-dim, #888); margin: -4px 0 0; }
.pat-you { border: 1px solid var(--wallet-stroke, rgba(139,92,246,.3)); background: var(--wallet-accent-soft, rgba(139,92,246,.1)); border-radius: var(--radius-lg, 14px); padding: var(--space-sm, .6rem) var(--space-md, 1rem); display: flex; flex-direction: column; gap: 6px; }
.pat-you-row { display: flex; align-items: center; justify-content: space-between; gap: var(--space-sm, .6rem); }
.pat-lvl { display: inline-flex; align-items: center; gap: 6px; font-weight: 600; font-size: var(--text-md, .8125rem); }
.pat-lvl b { font-size: 1.1em; }
.pat-amt { font-family: var(--font-mono, monospace); font-size: var(--text-sm, .764rem); color: var(--ink-dim, #888); }
.pat-bar { height: 7px; border-radius: 999px; background: var(--surface-2, rgba(255,255,255,.05)); overflow: hidden; }
.pat-bar > i { display: block; height: 100%; border-radius: 999px; background: linear-gradient(90deg, var(--pa), var(--wallet-accent-strong, #a78bfa)); transition: width var(--duration-slow, .42s) var(--ease-emphasized, cubic-bezier(.22,1,.36,1)); }
.pat-next { font-size: var(--text-2xs, .6875rem); color: var(--ink-dim, #888); }
.pat-ladder { display: flex; flex-direction: column; gap: 8px; }
.pat-perk { display: flex; gap: var(--space-sm, .6rem); align-items: flex-start; padding: var(--space-sm, .6rem); border: 1px solid var(--stroke, rgba(255,255,255,.08)); border-radius: var(--radius-md, 10px); background: var(--surface-1, rgba(255,255,255,.03)); transition: border-color var(--duration-fast, .14s) var(--ease-standard, ease); }
.pat-perk.unlocked { border-color: var(--wallet-stroke-strong, rgba(139,92,246,.5)); background: var(--wallet-accent-soft, rgba(139,92,246,.1)); }
.pat-perk-ico { width: 30px; height: 30px; flex: none; display: grid; place-items: center; border-radius: var(--radius-sm, 6px); background: var(--surface-2, rgba(255,255,255,.05)); font-size: 15px; }
.pat-perk.unlocked .pat-perk-ico { background: var(--pa); color: #14091f; }
.pat-perk-main { flex: 1; min-width: 0; }
.pat-perk-t { font-weight: 600; font-size: var(--text-md, .8125rem); display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.pat-perk-kind { font-size: var(--text-2xs, .6875rem); color: var(--ink-dim, #888); font-weight: 400; }
.pat-perk-d { font-size: var(--text-sm, .764rem); color: var(--ink-dim, #888); margin: 2px 0 0; line-height: 1.4; }
.pat-perk-meta { display: flex; align-items: center; gap: 10px; margin-top: 6px; flex-wrap: wrap; }
.pat-thr { font-family: var(--font-mono, monospace); font-size: var(--text-2xs, .6875rem); color: var(--pa); white-space: nowrap; }
.pat-reveal { margin-top: 8px; padding: var(--space-sm, .6rem); border-radius: var(--radius-sm, 6px); background: var(--surface-2, rgba(255,255,255,.05)); border: 1px dashed var(--wallet-stroke, rgba(139,92,246,.3)); font-size: var(--text-sm, .764rem); line-height: 1.5; white-space: pre-wrap; }
.pat-wall { display: flex; flex-direction: column; gap: 4px; }
.pat-wall-h { font-size: var(--text-xs, .618rem); letter-spacing: .08em; text-transform: uppercase; color: var(--ink-dim, #888); margin-bottom: 4px; }
.pat-row { display: flex; align-items: center; gap: var(--space-sm, .6rem); padding: 7px 8px; border-radius: var(--radius-sm, 6px); transition: background var(--duration-fast, .14s) var(--ease-standard, ease); }
.pat-row:hover { background: var(--surface-1, rgba(255,255,255,.03)); }
.pat-rank { width: 18px; text-align: center; font-family: var(--font-mono, monospace); font-size: var(--text-2xs, .6875rem); color: var(--ink-dim, #888); flex: none; }
.pat-face { width: 26px; height: 26px; flex: none; border-radius: 50%; display: grid; place-items: center; font-size: 13px; background: var(--surface-3, rgba(255,255,255,.08)); border: 1px solid var(--stroke, rgba(255,255,255,.08)); }
.pat-who { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.pat-who a, .pat-who span.nm { font-size: var(--text-md, .8125rem); font-weight: 600; color: var(--ink, #e8e8e8); text-decoration: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pat-who a:hover { color: var(--pa); }
.pat-when { font-size: var(--text-2xs, .6875rem); color: var(--ink-faint, rgba(255,255,255,.45)); }
.pat-pill { font-size: var(--text-2xs, .6875rem); padding: 1px 7px; border-radius: 999px; border: 1px solid currentColor; opacity: .9; white-space: nowrap; flex: none; }
.pat-rowamt { font-family: var(--font-mono, monospace); font-size: var(--text-sm, .764rem); flex: none; min-width: 56px; text-align: right; }
.pat-empty { text-align: center; padding: var(--space-lg, 1.6rem) var(--space-md, 1rem); color: var(--ink-dim, #888); font-size: var(--text-sm, .764rem); line-height: 1.5; border: 1px dashed var(--stroke, rgba(255,255,255,.08)); border-radius: var(--radius-md, 10px); }
.pat-actions { display: flex; gap: var(--space-sm, .6rem); flex-wrap: wrap; }
.pat-btn { font: inherit; font-size: var(--text-md, .8125rem); font-weight: 600; cursor: pointer; border-radius: var(--radius-md, 10px); padding: 9px 16px; border: 1px solid var(--wallet-stroke-strong, rgba(139,92,246,.5)); background: var(--wallet-accent-fill, rgba(139,92,246,.15)); color: var(--ink-bright, #fff); transition: transform var(--duration-fast, .14s) var(--ease-standard, ease), background var(--duration-fast, .14s) var(--ease-standard, ease); }
.pat-btn:hover { background: var(--wallet-accent-strong, #a78bfa); color: #14091f; }
.pat-btn:active { transform: translateY(1px); }
.pat-btn:focus-visible { outline: 2px solid var(--pa); outline-offset: 2px; }
.pat-btn.ghost { background: transparent; border-color: var(--stroke-strong, rgba(255,255,255,.14)); color: var(--ink, #e8e8e8); }
.pat-btn.ghost:hover { border-color: var(--pa); color: var(--pa); background: transparent; }
.pat-btn.sm { padding: 5px 11px; font-size: var(--text-2xs, .6875rem); }
.pat-btn[disabled] { opacity: .5; cursor: progress; }
.pat-more { align-self: center; }
.pat-err { color: var(--danger, #f87171); font-size: var(--text-sm, .764rem); display: flex; gap: 10px; align-items: center; justify-content: space-between; }
.pat-edit { display: flex; flex-direction: column; gap: 10px; border: 1px solid var(--stroke, rgba(255,255,255,.08)); border-radius: var(--radius-md, 10px); padding: var(--space-md, 1rem); background: var(--surface-1, rgba(255,255,255,.03)); }
.pat-edit-row { display: grid; grid-template-columns: 120px 90px 1fr auto; gap: 8px; align-items: start; }
.pat-edit input, .pat-edit select, .pat-edit textarea { font: inherit; font-size: var(--text-sm, .764rem); color: var(--ink, #e8e8e8); background: var(--surface-2, rgba(255,255,255,.05)); border: 1px solid var(--stroke, rgba(255,255,255,.08)); border-radius: var(--radius-sm, 6px); padding: 7px 9px; width: 100%; }
.pat-edit textarea { grid-column: 1 / -1; min-height: 54px; resize: vertical; font-family: var(--font-body, Inter); }
.pat-edit input:focus, .pat-edit select:focus, .pat-edit textarea:focus { outline: none; border-color: var(--pa); }
.pat-edit-x { background: transparent; border: 1px solid var(--stroke, rgba(255,255,255,.08)); color: var(--ink-dim, #888); border-radius: var(--radius-sm, 6px); cursor: pointer; padding: 7px 10px; }
.pat-edit-x:hover { color: var(--danger, #f87171); border-color: var(--danger, #f87171); }
.pat-edit-foot { display: flex; gap: 8px; justify-content: space-between; flex-wrap: wrap; }
.pat-note { font-size: var(--text-2xs, .6875rem); color: var(--success, #4ade80); }
@media (max-width: 560px) { .pat-edit-row { grid-template-columns: 1fr 1fr; } }
@media (prefers-reduced-motion: reduce) { .pat-sk { animation: none; } .pat-bar > i, .pat-btn, .pat-perk, .pat-row { transition: none; } }
`;
	(document.head || document.documentElement).appendChild(style);
}

// Base64 of an ed25519 signature — verifySiwsSignature (server) accepts base64.
function bytesToB64(bytes) {
	const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	let bin = '';
	for (const b of arr) bin += String.fromCharCode(b);
	return btoa(bin);
}

async function getConnectedWallet({ prompt = false } = {}) {
	const p = detectSolanaWallet();
	if (!p) return { provider: null, wallet: null };
	let wallet = p.publicKey?.toString?.() || null;
	if (!wallet) {
		try {
			const r = await p.connect(prompt ? undefined : { onlyIfTrusted: true });
			wallet = (r?.publicKey || p.publicKey)?.toString?.() || null;
		} catch { /* not connected / user declined silent connect */ }
	}
	return { provider: p, wallet };
}

function challengeMessage(agentId, wallet, action, extra = '') {
	return `three.ws patron action\nAgent: ${agentId}\nWallet: ${wallet}\nAction: ${action}${extra}\nIssued At: ${new Date().toISOString()}`;
}

async function signChallenge(provider, message) {
	const enc = new TextEncoder().encode(message);
	const res = await provider.signMessage(enc, 'utf8');
	return bytesToB64(res?.signature ?? res);
}

// A ready-to-edit starter ladder for a brand-new owner — example perk content they
// can keep or rewrite, so the editor opens full instead of empty.
function starterLadder() {
	return [
		{ perk_type: 'greeting', threshold_usd: 5, title: 'A warm welcome', description: 'A personal greeting your agent gives supporters in chat.', payload: { body: 'Always greet this supporter warmly by name and thank them for backing me — they helped make me possible.' }, is_active: true },
		{ perk_type: 'lore', threshold_usd: 25, title: 'Origin story', description: 'Hidden backstory only patrons can read.', payload: { body: 'The secret behind how I came to be — write the lore your patrons get to unlock here.' }, is_active: true },
		{ perk_type: 'badge', threshold_usd: 100, title: 'Inner circle', description: 'A badge that marks my closest supporters on the wall.', payload: { label: 'Inner Circle' }, is_active: true },
	];
}

export function mountPatronagePanel({ mount, agent, isOwner = false }) {
	if (!mount) return { destroy() {} };
	ensureStyles();
	const card = mount.closest('#ad-patronage-card') || mount.parentElement;
	const agentId = agent.id;
	const tipAddr = agent.solana_address || agent.rawMetadata?.meta?.solana_address || null;
	let alive = true;
	let data = null;
	let connected = { provider: null, wallet: null };
	let editing = false;
	let editPerks = [];
	const revealed = new Map(); // perkId → payload string

	const root = document.createElement('div');
	root.className = 'pat';
	root.setAttribute('aria-busy', 'true');
	mount.replaceChildren(root);
	root.innerHTML = '<div class="pat-sk"></div><div class="pat-sk" style="height:120px"></div>';

	const show = () => { if (card) card.hidden = false; };
	const hide = () => { if (card) card.hidden = true; };

	async function load() {
		const network = data?.network || 'mainnet';
		const qs = new URLSearchParams({ network });
		if (connected.wallet) qs.set('viewer', connected.wallet);
		try {
			const res = await apiFetch(`/api/agents/${encodeURIComponent(agentId)}/solana/patronage?${qs}`, { allowAnonymous: true });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			data = (await res.json()).data;
		} catch (e) {
			if (!alive) return;
			renderError(e);
			return;
		}
		if (!alive) return;
		render();
	}

	function renderError(e) {
		root.setAttribute('aria-busy', 'false');
		// Nothing to anchor to yet — keep the card present only if it was already shown.
		if (!data) { hide(); return; }
		show();
		root.innerHTML = `<div class="pat-err"><span>Couldn't load supporters — ${esc(e?.message || 'network error')}.</span><button class="pat-btn ghost sm" data-retry>Retry</button></div>`;
		root.querySelector('[data-retry]')?.addEventListener('click', load);
	}

	function render() {
		root.setAttribute('aria-busy', 'false');
		const perks = data.perks || [];
		const wall = data.wall || [];
		const hasContent = perks.length || wall.length || isOwner;
		if (!hasContent) { hide(); return; }
		show();

		if (editing) { renderEditor(); return; }

		const viewer = data.viewer;
		const totals = data.totals?.lifetime || { patrons: 0, usd: 0 };
		const season = data.season || {};
		const seasonUsd = data.totals?.season?.usd || 0;

		const parts = [];
		parts.push(`<div class="pat-head"><h3>Support ${esc(data.agent_name || 'this agent')}</h3>${season.label ? `<span class="pat-season" title="This season's support">${esc(season.label)} · ${esc(fmtUsd(seasonUsd))}</span>` : ''}</div>`);
		parts.push(`<p class="pat-sub">${totals.patrons} ${totals.patrons === 1 ? 'patron has' : 'patrons have'} given ${esc(fmtUsd(totals.usd))} — support unlocks real perks and a place on the wall.</p>`);

		parts.push(renderViewer(viewer));
		if (perks.length) parts.push(renderLadder(perks, viewer));
		parts.push(renderActions(viewer));
		if (perks.length === 0 && isOwner) parts.push(renderOwnerEmpty());
		parts.push(renderWall(wall, viewer, season));

		root.innerHTML = parts.join('');
		wire();
	}

	function renderViewer(viewer) {
		if (!connected.wallet) {
			return `<div class="pat-you"><div class="pat-you-row"><span class="pat-lvl">Connect your wallet to see your level</span><button class="pat-btn ghost sm" data-connect>Connect</button></div></div>`;
		}
		if (!viewer || !viewer.level) {
			return `<div class="pat-you"><div class="pat-you-row"><span class="pat-lvl">You haven't supported yet</span><span class="pat-amt">${esc(shortAddr(connected.wallet))}</span></div><div class="pat-next">Send any tip to become a Supporter and start unlocking perks.</div></div>`;
		}
		const lvl = viewer.level;
		const prog = viewer.progress || {};
		const pct = Math.round((prog.pct ?? 1) * 100);
		const nextLine = prog.next
			? `${esc(fmtUsd(prog.remainingUsd))} more to <b style="color:${esc(prog.next.accent || 'var(--pa)')}">${esc(prog.next.label)}</b>`
			: `You're at the top tier — thank you.`;
		return `<div class="pat-you">
			<div class="pat-you-row">
				<span class="pat-lvl" style="color:${esc(lvl.accent || 'var(--pa)')}">${esc(lvl.glyph || '◆')} <b>${esc(lvl.label)}</b></span>
				<span class="pat-amt">${esc(fmtUsd(viewer.usd))} · ${viewer.supportCount} ${viewer.supportCount === 1 ? 'gift' : 'gifts'}</span>
			</div>
			<div class="pat-bar"><i style="width:${pct}%"></i></div>
			<div class="pat-next">${nextLine}</div>
		</div>`;
	}

	function renderLadder(perks, viewer) {
		const earned = new Set(viewer?.earnedPerkIds || []);
		const viewerUsd = viewer?.usd || 0;
		const rows = perks.map((p) => {
			const unlocked = earned.has(p.id);
			const remaining = Math.max(0, p.threshold_usd - viewerUsd);
			const kind = PERK_LABEL[p.perk_type] || p.perk_type;
			const glyph = PERK_GLYPH[p.perk_type] || '◆';
			const revealBtn = unlocked && (p.perk_type === 'greeting' || p.perk_type === 'lore')
				? `<button class="pat-btn ghost sm" data-reveal="${esc(p.id)}">${revealed.has(p.id) ? 'Hide' : 'Reveal'}</button>`
				: '';
			const status = unlocked
				? `<span class="pat-note">✓ Unlocked${p.perk_type === 'skill' ? ' — free in chat' : p.perk_type === 'badge' ? ' — on your wall' : p.perk_type === 'launch_access' ? ' — early access on' : ''}</span>`
				: `<span class="pat-thr">${connected.wallet ? `${esc(fmtUsd(remaining))} to go` : `${esc(fmtUsd(p.threshold_usd))} to unlock`}</span>`;
			const revealBox = revealed.has(p.id) ? `<div class="pat-reveal">${esc(revealed.get(p.id))}</div>` : '';
			return `<div class="pat-perk ${unlocked ? 'unlocked' : ''}">
				<div class="pat-perk-ico">${glyph}</div>
				<div class="pat-perk-main">
					<div class="pat-perk-t">${esc(p.title)} <span class="pat-perk-kind">${esc(kind)}</span></div>
					${p.description ? `<p class="pat-perk-d">${esc(p.description)}</p>` : ''}
					<div class="pat-perk-meta">${status}${revealBtn}</div>
					${revealBox}
				</div>
			</div>`;
		}).join('');
		return `<div class="pat-ladder">${rows}</div>`;
	}

	function renderActions(viewer) {
		if (!tipAddr) return '';
		const label = viewer?.level ? '◎ Support more' : '◎ Support';
		const hideMe = (viewer && viewer.level && connected.wallet)
			? `<button class="pat-btn ghost sm" data-optout="${viewer.hidden ? 'show' : 'hide'}">${viewer.hidden ? 'Show me on the wall' : 'Hide me from the wall'}</button>`
			: '';
		const edit = isOwner ? `<button class="pat-btn ghost" data-edit>Edit perks</button>` : '';
		return `<div class="pat-actions"><button class="pat-btn" data-tip>${label}</button>${edit}${hideMe}</div>`;
	}

	function renderOwnerEmpty() {
		return `<div class="pat-empty">You haven't set up any patron perks yet. Add a rung to the ladder — an exclusive greeting, hidden lore, a free skill, early launch access, or a badge — and supporters will have something real to unlock.<br><br><button class="pat-btn" data-edit>Add your first perk</button></div>`;
	}

	function renderWall(wall, viewer, season) {
		if (!wall.length) {
			const msg = isOwner
				? 'No supporters yet. Share your profile — when someone tips you, they appear here and the relationship begins.'
				: 'No patrons yet. Be the first to support and claim the top of the wall.';
			return `<div class="pat-wall"><div class="pat-wall-h">Patron wall</div><div class="pat-empty">${esc(msg)}</div></div>`;
		}
		const top = (data.season_top || []);
		const topSet = new Set(top.map((t) => t.wallet));
		const rows = wall.map((p, i) => {
			const lvl = p.level || {};
			const name = p.name || shortAddr(p.wallet);
			const isYou = connected.wallet && p.wallet === connected.wallet;
			const seasonMark = topSet.has(p.wallet) ? ' <span title="Top patron this season">★</span>' : '';
			const thankBtn = isOwner ? `<button class="pat-btn ghost sm" data-thank="${esc(p.wallet)}" data-name="${esc(name)}" title="Thank ${esc(name)}">Thank</button>` : '';
			return `<div class="pat-row">
				<span class="pat-rank">${i + 1 + (data.wall_offset || 0)}</span>
				<span class="pat-face" style="color:${esc(lvl.accent || 'var(--pa)')}">${esc(lvl.glyph || '◆')}</span>
				<span class="pat-who">
					<a href="${esc(explorerAddr(p.wallet, data.network))}" target="_blank" rel="noopener">${esc(name)}${isYou ? ' <span style="color:var(--pa)">(you)</span>' : ''}${seasonMark}</a>
					<span class="pat-when">${p.supportCount} ${p.supportCount === 1 ? 'gift' : 'gifts'}${p.lastAt ? ` · ${esc(relTime(p.lastAt))}` : ''}</span>
				</span>
				<span class="pat-pill" style="color:${esc(lvl.accent || 'var(--pa)')}">${esc(lvl.label || 'Supporter')}</span>
				<span class="pat-rowamt">${esc(fmtUsd(p.usd))}</span>
				${thankBtn}
			</div>`;
		}).join('');
		const more = data.wall_has_more ? `<button class="pat-btn ghost sm pat-more" data-more>Show more</button>` : '';
		return `<div class="pat-wall"><div class="pat-wall-h">Patron wall · ${data.totals?.lifetime?.patrons || wall.length} supporters</div>${rows}${more}</div>`;
	}

	// ── Owner perk editor ──────────────────────────────────────────────────────────
	function renderEditor() {
		const typeOpts = (sel) => ['greeting', 'lore', 'skill', 'launch_access', 'badge']
			.map((t) => `<option value="${t}" ${t === sel ? 'selected' : ''}>${PERK_LABEL[t]}</option>`).join('');
		const rows = editPerks.map((p, i) => {
			const needsBody = p.perk_type === 'greeting' || p.perk_type === 'lore';
			const payloadField = needsBody
				? `<textarea data-i="${i}" data-f="body" placeholder="${p.perk_type === 'greeting' ? 'The exclusive greeting your agent uses for this patron…' : 'The hidden lore revealed to this patron…'}">${esc(p.payload?.body || '')}</textarea>`
				: p.perk_type === 'skill'
					? `<input data-i="${i}" data-f="skill" placeholder="skill name (e.g. deep_research)" value="${esc(p.payload?.skill || '')}" style="grid-column:1/-1">`
					: p.perk_type === 'badge'
						? `<input data-i="${i}" data-f="label" placeholder="badge label" value="${esc(p.payload?.label || '')}" style="grid-column:1/-1">`
						: '';
			return `<div class="pat-edit-row">
				<select data-i="${i}" data-f="perk_type" aria-label="Perk type">${typeOpts(p.perk_type)}</select>
				<input data-i="${i}" data-f="threshold_usd" type="number" min="0" step="1" placeholder="USD" value="${esc(p.threshold_usd ?? '')}" aria-label="Threshold USD">
				<input data-i="${i}" data-f="title" placeholder="Perk title" value="${esc(p.title || '')}" aria-label="Title">
				<button class="pat-edit-x" data-del="${i}" title="Remove" aria-label="Remove perk">✕</button>
				<input data-i="${i}" data-f="description" placeholder="Short description (optional)" value="${esc(p.description || '')}" style="grid-column:1/-1" aria-label="Description">
				${payloadField}
			</div>`;
		}).join('');
		root.innerHTML = `<div class="pat-head"><h3>Patron perks</h3></div>
			<p class="pat-sub">Define what supporters unlock at each USD threshold. Access is enforced server-side against real on-chain support — no one can unlock a perk they haven't earned.</p>
			<div class="pat-edit">${rows || '<div class="pat-empty">No perks yet — add one.</div>'}
				<div class="pat-edit-foot">
					<button class="pat-btn ghost sm" data-add>+ Add perk</button>
					<span style="display:flex;gap:8px"><button class="pat-btn ghost" data-cancel>Cancel</button><button class="pat-btn" data-save>Save ladder</button></span>
				</div>
				<div class="pat-err" data-edit-err hidden></div>
			</div>`;
		wireEditor();
	}

	function wireEditor() {
		root.querySelectorAll('.pat-edit [data-i]').forEach((el) => {
			el.addEventListener('input', () => {
				const i = Number(el.dataset.i);
				const f = el.dataset.f;
				if (!editPerks[i]) return;
				if (f === 'perk_type') {
					editPerks[i].perk_type = el.value;
					renderEditor(); // payload field shape depends on type
					return;
				}
				if (f === 'threshold_usd') editPerks[i].threshold_usd = el.value === '' ? '' : Number(el.value);
				else if (f === 'title' || f === 'description') editPerks[i][f] = el.value;
				else { editPerks[i].payload = { ...(editPerks[i].payload || {}), [f]: el.value }; }
			});
		});
		root.querySelector('[data-add]')?.addEventListener('click', () => {
			editPerks.push({ perk_type: 'greeting', threshold_usd: 10, title: '', description: '', payload: {}, is_active: true });
			renderEditor();
		});
		root.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => {
			editPerks.splice(Number(b.dataset.del), 1);
			renderEditor();
		}));
		root.querySelector('[data-cancel]')?.addEventListener('click', () => { editing = false; render(); });
		root.querySelector('[data-save]')?.addEventListener('click', savePerks);
	}

	async function savePerks() {
		const errBox = root.querySelector('[data-edit-err]');
		const saveBtn = root.querySelector('[data-save]');
		const fail = (m) => { if (errBox) { errBox.hidden = false; errBox.textContent = m; } };
		for (const p of editPerks) {
			if (!String(p.title || '').trim()) return fail('Every perk needs a title.');
			if (!(Number(p.threshold_usd) >= 0)) return fail('Every threshold must be $0 or more.');
			if ((p.perk_type === 'greeting' || p.perk_type === 'lore') && !String(p.payload?.body || '').trim()) return fail(`"${p.title}" needs its ${p.perk_type} text.`);
			if (p.perk_type === 'skill' && !String(p.payload?.skill || '').trim()) return fail(`"${p.title}" needs a skill name.`);
		}
		if (saveBtn) saveBtn.disabled = true;
		try {
			const res = await apiFetch(`/api/agents/${encodeURIComponent(agentId)}/solana/patronage`, {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ perks: editPerks }),
			});
			if (!res.ok) {
				const j = await res.json().catch(() => ({}));
				throw new Error(j.error?.message || j.message || `HTTP ${res.status}`);
			}
			editing = false;
			await load();
		} catch (e) {
			if (saveBtn) saveBtn.disabled = false;
			fail(`Could not save: ${e.message}`);
		}
	}

	// ── Wiring (view mode) ──────────────────────────────────────────────────────────
	function wire() {
		root.querySelector('[data-connect]')?.addEventListener('click', async (ev) => {
			ev.currentTarget.disabled = true;
			connected = await getConnectedWallet({ prompt: true });
			await load();
		});
		root.querySelector('[data-tip]')?.addEventListener('click', () => {
			openTipModal({ id: agentId, name: data.agent_name, solana_address: tipAddr }, { network: data.network });
		});
		root.querySelector('[data-edit]')?.addEventListener('click', () => {
			editPerks = (data.perks || []).map((p) => ({
				perk_type: p.perk_type, threshold_usd: p.threshold_usd, title: p.title,
				description: p.description, payload: p.payload || {}, is_active: p.is_active !== false,
			}));
			// First-time owners get a sensible starter ladder to edit, not a blank row —
			// real, editable config they can ship in one tap (greeting → lore → badge).
			if (!editPerks.length) editPerks = starterLadder();
			editing = true;
			render();
		});
		root.querySelector('[data-more]')?.addEventListener('click', async (ev) => {
			ev.currentTarget.disabled = true;
			// Page forward: refetch at the next offset and append client-side.
			const next = (data.wall_offset || 0) + (data.wall?.length || 0);
			try {
				const qs = new URLSearchParams({ network: data.network, offset: String(next) });
				if (connected.wallet) qs.set('viewer', connected.wallet);
				const res = await apiFetch(`/api/agents/${encodeURIComponent(agentId)}/solana/patronage?${qs}`, { allowAnonymous: true });
				const more = (await res.json()).data;
				data.wall = [...data.wall, ...(more.wall || [])];
				data.wall_has_more = more.wall_has_more;
				data.wall_offset = 0; // ranks already absolute via accumulated array
				render();
			} catch { ev.currentTarget.disabled = false; }
		});
		root.querySelectorAll('[data-reveal]').forEach((b) => b.addEventListener('click', () => revealPerk(b.dataset.reveal, b)));
		root.querySelector('[data-optout]')?.addEventListener('click', (ev) => toggleOptOut(ev.currentTarget.dataset.optout === 'hide', ev.currentTarget));
		root.querySelectorAll('[data-thank]').forEach((b) => b.addEventListener('click', () => thankPatron(b.dataset.thank, b.dataset.name)));
	}

	async function revealPerk(perkId, btn) {
		if (revealed.has(perkId)) { revealed.delete(perkId); render(); return; }
		if (!connected.wallet) { connected = await getConnectedWallet({ prompt: true }); if (!connected.wallet) return; }
		if (!connected.provider) return;
		btn.disabled = true;
		try {
			const msg = challengeMessage(agentId, connected.wallet, 'unlock');
			const signature = await signChallenge(connected.provider, msg);
			const res = await apiFetch(`/api/agents/${encodeURIComponent(agentId)}/solana/patronage`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ op: 'unlock', wallet: connected.wallet, message: msg, signature, network: data.network }),
			});
			const j = await res.json();
			if (!res.ok) throw new Error(j.error?.message || `HTTP ${res.status}`);
			const perk = (j.data.unlocked || []).find((p) => p.id === perkId);
			if (perk?.payload?.body) revealed.set(perkId, perk.payload.body);
			else revealed.set(perkId, '(This perk has no readable content.)');
			render();
		} catch (e) {
			btn.disabled = false;
			btn.textContent = e?.message?.includes('User rejected') ? 'Reveal' : 'Retry';
		}
	}

	async function toggleOptOut(hide, btn) {
		if (!connected.wallet) { connected = await getConnectedWallet({ prompt: true }); if (!connected.wallet) return; }
		if (!connected.provider) return;
		btn.disabled = true;
		try {
			const msg = challengeMessage(agentId, connected.wallet, 'optout', `\nHidden: ${hide}`);
			const signature = await signChallenge(connected.provider, msg);
			const res = await apiFetch(`/api/agents/${encodeURIComponent(agentId)}/solana/patronage`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ op: 'optout', wallet: connected.wallet, message: msg, signature, hidden: hide }),
			});
			if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error?.message || `HTTP ${res.status}`); }
			await load();
		} catch { btn.disabled = false; }
	}

	// Owner reciprocity: a real, shareable shout-out thanking a patron by name.
	function thankPatron(wallet, name) {
		const text = `Huge thanks to ${name || shortAddr(wallet)} for being a patron of ${data.agent_name} on @three_ws. Support that builds a real relationship. ${location.origin}/agents/${agentId}`;
		const url = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`;
		window.open(url, '_blank', 'noopener');
	}

	// Live refresh: when anyone tips/streams this agent from this tab, refetch so the
	// level + wall update right after on-chain confirm + server record.
	const onSupport = (ev) => {
		if (!alive) return;
		const d = ev.detail || {};
		if (d.agentId && d.agentId !== agentId) return;
		// Give the server a beat to record + verify, then refresh derived state.
		setTimeout(() => { if (alive) load(); }, 1200);
	};
	window.addEventListener('three:patron-support', onSupport);

	// Boot: detect an already-trusted wallet silently, then load.
	(async () => {
		connected = await getConnectedWallet({ prompt: false });
		if (alive) await load();
	})();

	return {
		destroy() {
			alive = false;
			window.removeEventListener('three:patron-support', onSupport);
			try { mount.replaceChildren(); } catch { /* idempotent */ }
		},
	};
}
