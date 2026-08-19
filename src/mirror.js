// /mirror — Copy Trading discovery + management.
//
// Two real surfaces:
//   • Discover leaders — performance-weighted ranking of followable agents from
//     /api/mirror/leaderboard (real on-chain stats). "Mirror" picks one of your
//     agents and opens the leash setup modal.
//   • Your copy-trading — the owner mirror panel for each of your wallet-bearing
//     agents (kill switch, follows, "mirrored from @leader" feed), reusing the
//     exact shared component the agent detail page mounts.

import { apiFetch } from './api.js';
import { mountMirrorPanel, openFollowModal } from './shared/agent-mirror-panel.js';
import { walletChipHTML, wireWalletChips } from './shared/agent-wallet-chip.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const short = (a) => (a && a.length > 10 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a || '');
const fmtSol = (n) => (n == null || !Number.isFinite(Number(n)) ? '—' : Number(n).toFixed(Math.abs(n) < 1 ? 3 : 2).replace(/\.?0+$/, ''));

const board = document.getElementById('mp-board');
const sortSeg = document.getElementById('mp-sort');
let sort = new URL(location.href).searchParams.get('sort') || 'score';
let myAgents = [];

function leaderRow(l) {
	const roi = l.roi_pct != null ? `<span class="${l.roi_pct >= 0 ? 'pos' : 'neg'}">${l.roi_pct >= 0 ? '+' : ''}${l.roi_pct}% ROI</span>` : '';
	const pnl = l.pnl_sol != null && l.pnl_sol !== 0 ? `<span class="${l.pnl_sol >= 0 ? 'pos' : 'neg'}">${l.pnl_sol >= 0 ? '+' : ''}◎${fmtSol(l.pnl_sol)}</span>` : '';
	const win = l.win_rate != null ? `<span>${l.win_rate}% win</span>` : '';
	const vol = l.volume_sol ? `<span>◎${fmtSol(l.volume_sol)} vol</span>` : '';
	const fol = `<span>${l.followers} ${l.followers === 1 ? 'follower' : 'followers'}</span>`;
	const stats = [roi, pnl, win, vol, fol].filter(Boolean).join('') || '<span>No settled trades yet</span>';
	return `<div class="mp-lrow">
		<div class="mp-rank ${l.rank <= 3 ? 'top' : ''}">#${l.rank}</div>
		${l.avatar ? `<img class="mp-av" src="${esc(l.avatar)}" alt="" loading="lazy">` : '<div class="mp-av"></div>'}
		<div class="mp-lbody">
			<div class="mp-lname"><a href="/agents/${esc(l.agent_id)}">${esc(l.name || short(l.agent_id))}</a></div>
			<div class="mp-lstats">${stats}</div>
		</div>
		<button class="mp-mirror-btn" data-id="${esc(l.agent_id)}" data-name="${esc(l.name || '')}">Mirror</button>
	</div>`;
}

async function loadBoard() {
	board.innerHTML = '<div class="mp-sk"></div><div class="mp-sk"></div><div class="mp-sk"></div>';
	try {
		const res = await apiFetch(`/api/mirror/leaderboard?sort=${encodeURIComponent(sort)}&limit=30`, { allowAnonymous: true });
		if (!res.ok) throw new Error('load failed');
		const leaders = (await res.json()).data?.leaders || [];
		if (!leaders.length) {
			board.innerHTML = `<div class="mp-empty"><strong>No leaders yet</strong>Once agents start trading, the best ones rank here by their real track record. <a href="/create-agent" style="color:rgba(255,255,255,.6);text-decoration:underline">Launch a trader →</a></div>`;
			return;
		}
		board.innerHTML = leaders.map(leaderRow).join('');
		board.querySelectorAll('.mp-mirror-btn').forEach((b) => {
			b.addEventListener('click', () => mirrorLeader(b.dataset.id, b.dataset.name));
		});
	} catch {
		board.innerHTML = `<div class="mp-empty"><strong>Couldn't load leaders</strong><button class="mp-mirror-btn" id="mp-retry">Retry</button></div>`;
		document.getElementById('mp-retry')?.addEventListener('click', loadBoard);
	}
}

// "Mirror" a leader → pick which of my agents follows it, then open the leash modal.
async function mirrorLeader(leaderId, leaderName) {
	if (!myAgents.length) {
		// Re-check in case auth resolved after first paint.
		await loadMine();
	}
	const candidates = myAgents.filter((a) => a.id !== leaderId);
	if (!candidates.length) {
		alert('You need your own agent first. Create or fork one, then mirror a leader.');
		location.href = '/create-agent';
		return;
	}
	const leader = { agent_id: leaderId, name: leaderName };
	if (candidates.length === 1) {
		const saved = await openFollowModal({ followerId: candidates[0].id, followerName: candidates[0].name, leader });
		if (saved) loadMine();
		return;
	}
	// Multi-agent picker.
	const back = document.createElement('div');
	back.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.66);backdrop-filter:blur(4px);z-index:9998;display:flex;align-items:center;justify-content:center;padding:16px';
	back.innerHTML = `<div style="width:min(400px,96vw);background:#111;border:1px solid rgba(255,255,255,.1);border-radius:4px;padding:22px">
		<h3 style="margin:0 0 4px;font-family:var(--font-display,inherit);font-size:1rem;color:#fff;font-weight:600;letter-spacing:-.01em">Which agent should mirror?</h3>
		<p style="font-size:.75rem;color:rgba(255,255,255,.35);margin:0 0 16px;line-height:1.5">Pick the agent whose wallet copies ${esc(leaderName || 'this leader')}.</p>
		<div style="display:flex;flex-direction:column;gap:1px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.06);border-radius:3px;overflow:hidden">${candidates.map((a) => `<button type="button" data-id="${esc(a.id)}" data-name="${esc(a.name || '')}" style="display:flex;align-items:center;gap:10px;text-align:left;padding:11px 12px;border:none;background:#111;color:#fff;cursor:pointer;transition:background .12s">${a.avatar_url || a.profile_image_url ? `<img loading="lazy" decoding="async" src="${esc(a.avatar_url || a.profile_image_url)}" style="width:30px;height:30px;border-radius:3px;object-fit:cover;flex:0 0 auto">` : '<span style="width:30px;height:30px;border-radius:3px;background:rgba(255,255,255,.06);display:inline-block;flex:0 0 auto"></span>'}<span style="font-weight:500;color:#fff;font-size:.85rem">${esc(a.name || short(a.id))}</span></button>`).join('')}</div>
		<div style="text-align:right;margin-top:14px"><button id="mp-pf-cancel" style="font:inherit;font-size:.78rem;padding:7px 16px;border-radius:3px;border:1px solid rgba(255,255,255,.12);background:transparent;color:rgba(255,255,255,.5);cursor:pointer;transition:color .12s,border-color .12s">Cancel</button></div>
	</div>`;
	const close = () => back.remove();
	back.addEventListener('click', (e) => { if (e.target === back) close(); });
	back.querySelector('#mp-pf-cancel').addEventListener('click', close);
	back.querySelectorAll('[data-id]').forEach((b) => b.addEventListener('click', async () => {
		close();
		const saved = await openFollowModal({ followerId: b.dataset.id, followerName: b.dataset.name, leader });
		if (saved) loadMine();
	}));
	document.body.appendChild(back);
}

const mineSection = document.getElementById('mp-mine-section');
const mineEl = document.getElementById('mp-mine');
let _panelHandles = [];

async function loadMine() {
	_panelHandles.forEach((h) => { try { h.destroy(); } catch { /* idempotent */ } });
	_panelHandles = [];
	try {
		const res = await apiFetch('/api/agents', { allowAnonymous: true });
		if (!res.ok) { mineSection.hidden = true; return; }
		const j = await res.json();
		myAgents = (j.agents || j.data?.agents || j.data || []).filter((a) => a && a.id);
	} catch { myAgents = []; }

	const withWallets = myAgents.filter((a) => a.meta?.solana_address || a.solana_address || a.agent_solana_address);
	if (!myAgents.length) {
		// Logged out or no agents — keep the section hidden; the board CTA covers it.
		mineSection.hidden = true;
		return;
	}
	mineSection.hidden = false;
	if (!withWallets.length) {
		mineEl.innerHTML = `<div class="mp-empty"><strong>Your agents are getting their wallets ready</strong>Once an agent has a wallet, you can have it mirror a leader.</div>`;
		return;
	}
	mineEl.innerHTML = '';
	for (const a of withWallets) {
		const card = document.createElement('div');
		card.className = 'mp-agent-card';
		const head = document.createElement('div');
		head.className = 'mp-agent-head';
		// Owner's own wallet-bearing agent → its identity chip (same shared component
		// every other surface uses) so the wallet reads identically here and links to
		// the HUD; these cards are already filtered to agents that have a wallet.
		const chip = walletChipHTML(a, { isOwner: true, showPending: false, link: true, tip: false });
		head.innerHTML = `${a.avatar_url || a.profile_image_url ? `<img loading="lazy" decoding="async" class="mp-av" src="${esc(a.avatar_url || a.profile_image_url)}" alt="">` : '<div class="mp-av"></div>'}<div class="mp-lname"><a href="/agents/${esc(a.id)}">${esc(a.name || short(a.id))}</a>${chip ? `<div class="mp-agent-chip">${chip}</div>` : ''}</div>`;
		const panelMount = document.createElement('div');
		card.appendChild(head);
		card.appendChild(panelMount);
		mineEl.appendChild(card);
		if (chip) wireWalletChips(head);
		// The owner panel reveals its own content; on this page the card is always shown.
		const agentRec = { id: a.id, name: a.name, isOwner: true, rawMetadata: { meta: a.meta || { solana_address: a.solana_address || a.agent_solana_address } } };
		const handle = mountMirrorPanel({ mount: panelMount, agent: agentRec, isOwner: true });
		_panelHandles.push(handle);
	}
}

sortSeg.addEventListener('click', (e) => {
	const b = e.target.closest('button[data-sort]');
	if (!b) return;
	sort = b.dataset.sort;
	sortSeg.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
	const u = new URL(location.href); u.searchParams.set('sort', sort); history.replaceState(null, '', u);
	loadBoard();
});
sortSeg.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.sort === sort)));

loadBoard();
loadMine();
window.addEventListener('auth:resolved', loadMine, { once: true });
