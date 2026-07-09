// IRL Money Drops & Bounties — client (Wave II task 06).
//
// Self-contained: src/irl.js calls initIrlDrops(ctx) once with accessors into the
// live AR scene (scene, camera, the geo→world projection, the presence-token
// headers). This module then owns everything else — world-anchored coin markers,
// the accessible nearby/my-drops/my-claims panel, the "drop money here" create
// flow (visitor-signed funding via src/shared/agent-tip.js), and the presence-
// gated claim flow with a real Solscan receipt. No fakes: every number comes from
// /api/irl/drops hitting the real escrow + on-chain release.

import {
	Group, Mesh, CylinderGeometry, TorusGeometry, MeshStandardMaterial,
	MeshBasicMaterial, Vector3,
} from 'three';
import { tipAgent, TipError } from './agent-tip.js';
import { detectSolanaWallet, solanaTxExplorerUrl } from '../erc8004/solana-deploy.js';

const VIOLET = 0xc4b5fd;
const VIOLET_DEEP = 0x8b5cf6;
// Visitor-funded create signs through agent-tip.js, which moves SOL or USDC. A
// $THREE drop is funded server-side from an agent's wallet (an agent bounty), so
// the user-facing "drop money here" picker offers the two the visitor can sign.
const CREATE_ASSETS = ['SOL', 'USDC'];
const EXPIRY_PRESETS = [
	{ label: '1 hour', ms: 3600_000 },
	{ label: '24 hours', ms: 24 * 3600_000 },
	{ label: '7 days', ms: 7 * 24 * 3600_000 },
];

let ctx = null;
let panelEl = null;
let listEl = null;
let tabsEl = null;
let badgeEl = null;
let activeTab = 'nearby';
let nearby = [];          // live nearby drops (from the presence-gated read)
let mine = { drops: [], claims: [] };
let pollTimer = null;
let rafId = null;
const markers = new Map();   // dropId → { group, label, drop }
let _styled = false;
let _lastFetchKey = '';

// ── public entry ──────────────────────────────────────────────────────────────
export function initIrlDrops(context) {
	if (ctx) return;            // once
	ctx = context;
	ensureStyles();
	buildFab();
	buildPanel();
	startPolling();
	startRaf();
	window.addEventListener('pagehide', teardown, { once: true });
}

function teardown() {
	if (pollTimer) clearInterval(pollTimer);
	if (rafId) cancelAnimationFrame(rafId);
	pollTimer = rafId = null;
}

// ── tiny DOM helpers ────────────────────────────────────────────────────────
function el(tag, cls, html) {
	const n = document.createElement(tag);
	if (cls) n.className = cls;
	if (html != null) n.innerHTML = html;
	return n;
}
function fmtAmount(d) {
	const a = String(d.amount);
	const sym = d.asset === 'THREE' ? '$THREE' : d.asset;
	return `${a} ${sym}`;
}
function fmtDistance(m) {
	if (m == null) return '';
	return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
}
function timeLeft(iso) {
	const ms = new Date(iso).getTime() - Date.now();
	if (ms <= 0) return 'expired';
	const h = ms / 3600_000;
	if (h < 1) return `${Math.max(1, Math.round(ms / 60000))} min left`;
	if (h < 48) return `${Math.round(h)} h left`;
	return `${Math.round(h / 24)} d left`;
}
function gpsReady() {
	const g = ctx.getGpsState();
	return !!(g && g.ready && Number.isFinite(g.lat) && Number.isFinite(g.lng));
}

// ── data ─────────────────────────────────────────────────────────────────────
async function presenceHeaders(extra) {
	try { return await ctx.presenceHeaders(extra || {}); }
	catch { return ctx.deviceHeaders ? ctx.deviceHeaders(extra || {}) : (extra || {}); }
}

async function fetchNearby() {
	if (!gpsReady()) { nearby = []; return; }
	const g = ctx.getGpsState();
	const radius = ctx.NEARBY_READ_RADIUS || 60;
	try {
		const headers = await presenceHeaders();
		const r = await fetch(`/api/irl/drops?lat=${g.lat}&lng=${g.lng}&radius=${radius}`, { headers, credentials: 'include' });
		if (r.status === 401) { nearby = []; return; }  // fix required — re-mint next cycle
		if (!r.ok) return;
		const data = await r.json();
		nearby = Array.isArray(data.drops) ? data.drops : [];
		reconcileMarkers();
		if (activeTab === 'nearby' && panelOpen()) renderList();
		updateBadge();
	} catch { /* transient — keep last good set */ }
}

async function fetchMine() {
	try {
		const headers = ctx.deviceHeaders ? ctx.deviceHeaders() : {};
		const r = await fetch('/api/irl/drops?mine=1', { headers, credentials: 'include' });
		if (!r.ok) return;
		mine = await r.json();
		if ((activeTab === 'mine' || activeTab === 'claims') && panelOpen()) renderList();
	} catch { /* ignore */ }
}

function startPolling() {
	fetchNearby();
	pollTimer = setInterval(() => {
		const key = panelOpen() ? 'open' : 'bg';
		// Poll nearby every cycle; refresh "mine" only when its tab is up.
		fetchNearby();
		if (panelOpen() && (activeTab === 'mine' || activeTab === 'claims')) fetchMine();
		_lastFetchKey = key;
	}, 12_000);
}

// ── 3D markers ────────────────────────────────────────────────────────────────
function makeMarker(drop) {
	const group = new Group();
	// A glowing coin disc in the wallet-violet family.
	const coin = new Mesh(
		new CylinderGeometry(0.34, 0.34, 0.08, 28),
		new MeshStandardMaterial({ color: VIOLET, emissive: VIOLET_DEEP, emissiveIntensity: 0.55, metalness: 0.7, roughness: 0.25 }),
	);
	coin.rotation.x = Math.PI / 2;
	coin.position.y = 1.25;
	group.add(coin);
	// Claim-radius ring on the ground.
	const ring = new Mesh(
		new TorusGeometry(1, 0.03, 8, 48),
		new MeshBasicMaterial({ color: VIOLET, transparent: true, opacity: 0.45 }),
	);
	ring.rotation.x = Math.PI / 2;
	ring.position.y = 0.02;
	ring.scale.set(Math.max(1, drop.radius_m * 0.25), Math.max(1, drop.radius_m * 0.25), 1);
	group.add(ring);
	group.userData = { drop, coin };

	const label = el('button', 'irl-drop-label');
	label.type = 'button';
	label.setAttribute('aria-label', `${fmtAmount(drop)} drop — open to claim`);
	label.addEventListener('click', () => openClaim(drop));
	document.body.appendChild(label);

	ctx.scene.add(group);
	return { group, label, drop };
}

function reconcileMarkers() {
	const seen = new Set();
	for (const d of nearby) {
		seen.add(d.id);
		let m = markers.get(d.id);
		if (!m) { m = makeMarker(d); markers.set(d.id, m); }
		else m.drop = d;
	}
	for (const [id, m] of markers) {
		if (seen.has(id)) continue;
		ctx.scene.remove(m.group);
		m.label?.remove();
		markers.delete(id);
	}
}

const _v = new Vector3();
function startRaf() {
	const tick = () => {
		rafId = requestAnimationFrame(tick);
		if (!markers.size || !gpsReady()) { hideAllLabels(); return; }
		const camera = ctx.getCamera?.();
		for (const m of markers.values()) {
			const wp = ctx.gpsToWorld(m.drop.lat, m.drop.lng);
			m.group.position.set(wp.x, 0, wp.z);
			// Spin the coin for life; respect reduced-motion via CSS-free math gate.
			if (!_reduceMotion()) m.group.userData.coin.rotation.z += 0.02;
			positionLabel(m, camera);
		}
	};
	rafId = requestAnimationFrame(tick);
}

function _reduceMotion() {
	return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

function positionLabel(m, camera) {
	if (!camera) { m.label.style.display = 'none'; return; }
	_v.copy(m.group.position); _v.y += 1.7;
	_v.project(camera);
	const behind = _v.z > 1;
	if (behind || _v.x < -1.2 || _v.x > 1.2 || _v.y < -1.2 || _v.y > 1.2) {
		m.label.style.display = 'none';
		return;
	}
	const x = (_v.x * 0.5 + 0.5) * window.innerWidth;
	const y = (-_v.y * 0.5 + 0.5) * window.innerHeight;
	const dist = markerDistance(m.drop);
	const inRange = dist != null && dist <= m.drop.radius_m;
	m.label.style.display = '';
	m.label.classList.toggle('is-claimable', inRange);
	m.label.style.transform = `translate(-50%,-50%) translate(${Math.round(x)}px, ${Math.round(y)}px)`;
	m.label.innerHTML = `<span class="irl-drop-label-amt">${fmtAmount(m.drop)}</span>`
		+ `<span class="irl-drop-label-sub">${inRange ? 'Tap to claim' : fmtDistance(dist) + ' away'}</span>`;
}

function hideAllLabels() {
	for (const m of markers.values()) m.label.style.display = 'none';
}

function markerDistance(drop) {
	if (!gpsReady()) return null;
	const g = ctx.getGpsState();
	return haversine(g.lat, g.lng, drop.lat, drop.lng);
}
function haversine(lat1, lng1, lat2, lng2) {
	const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
	const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
	const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
	return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

// ── FAB + panel ────────────────────────────────────────────────────────────
function buildFab() {
	const fab = el('button', 'irl-drops-fab');
	fab.type = 'button';
	fab.setAttribute('aria-label', 'Money drops near me');
	fab.innerHTML = `
		<svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
			<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.6"/>
			<path d="M12 7v10M9.2 9.4c0-1.2 1.2-1.9 2.8-1.9s2.8.7 2.8 1.7c0 2.5-5.6 1.3-5.6 3.9 0 1.1 1.2 1.8 2.8 1.8s2.8-.7 2.8-1.9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
		</svg>
		<span class="irl-drops-fab-badge" hidden>0</span>`;
	badgeEl = fab.querySelector('.irl-drops-fab-badge');
	fab.addEventListener('click', togglePanel);
	document.body.appendChild(fab);
}

function buildPanel() {
	const backdrop = el('div', 'irl-drops-backdrop');
	backdrop.addEventListener('click', closePanel);
	panelEl = el('section', 'irl-drops-panel');
	panelEl.setAttribute('role', 'dialog');
	panelEl.setAttribute('aria-modal', 'false');
	panelEl.setAttribute('aria-label', 'Money drops near you');
	panelEl.innerHTML = `
		<div class="irl-drops-handle" aria-hidden="true"></div>
		<header class="irl-drops-head">
			<h2>Money drops</h2>
			<button class="irl-drops-close" type="button" aria-label="Close">✕</button>
		</header>
		<div class="irl-drops-tabs" role="tablist"></div>
		<div class="irl-drops-list" role="region" aria-live="polite"></div>
		<button class="irl-drops-create" type="button">＋ Drop money here</button>`;
	tabsEl = panelEl.querySelector('.irl-drops-tabs');
	listEl = panelEl.querySelector('.irl-drops-list');
	panelEl.querySelector('.irl-drops-close').addEventListener('click', closePanel);
	panelEl.querySelector('.irl-drops-create').addEventListener('click', () => openCreate());
	for (const [key, label] of [['nearby', 'Nearby'], ['mine', 'My drops'], ['claims', 'My claims']]) {
		const t = el('button', 'irl-drops-tab', label);
		t.type = 'button'; t.setAttribute('role', 'tab'); t.dataset.tab = key;
		t.addEventListener('click', () => setTab(key));
		tabsEl.appendChild(t);
	}
	panelEl._backdrop = backdrop;
	document.body.appendChild(backdrop);
	document.body.appendChild(panelEl);
	document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && panelOpen()) closePanel(); });
	setTab('nearby');
}

function panelOpen() { return panelEl?.classList.contains('is-open'); }
function togglePanel() { panelOpen() ? closePanel() : openPanel(); }
function openPanel() {
	panelEl.classList.add('is-open');
	panelEl._backdrop.classList.add('is-open');
	if (activeTab === 'nearby') fetchNearby(); else fetchMine();
	renderList();
	try { panelEl.querySelector('.irl-drops-close').focus({ preventScroll: true }); } catch { /* */ }
}
function closePanel() {
	panelEl.classList.remove('is-open');
	panelEl._backdrop.classList.remove('is-open');
}

function setTab(key) {
	activeTab = key;
	for (const t of tabsEl.children) t.setAttribute('aria-selected', String(t.dataset.tab === key));
	if (key === 'nearby') fetchNearby(); else fetchMine();
	renderList();
}

function updateBadge() {
	if (!badgeEl) return;
	const claimable = nearby.filter((d) => { const dist = markerDistance(d); return dist != null && dist <= d.radius_m; }).length;
	const count = claimable || nearby.length;
	badgeEl.hidden = count === 0;
	badgeEl.textContent = String(count);
	badgeEl.classList.toggle('is-hot', claimable > 0);
}

// ── list rendering (every state designed) ──────────────────────────────────
function renderList() {
	if (!listEl) return;
	listEl.innerHTML = '';
	if (activeTab === 'nearby') return renderNearby();
	if (activeTab === 'mine') return renderMine();
	return renderClaims();
}

function emptyState(title, body, action) {
	const wrap = el('div', 'irl-drops-empty');
	wrap.appendChild(el('div', 'irl-drops-empty-pulse'));
	wrap.appendChild(el('p', 'irl-drops-empty-t', title));
	wrap.appendChild(el('p', 'irl-drops-empty-b', body));
	if (action) {
		const b = el('button', 'irl-drops-empty-act', action.label);
		b.type = 'button';
		b.addEventListener('click', action.fn);
		wrap.appendChild(b);
	}
	return wrap;
}

function renderNearby() {
	if (!gpsReady()) {
		listEl.appendChild(emptyState('Turn on location', 'We anchor drops to real places. Enable location to discover money around you.', null));
		return;
	}
	if (!nearby.length) {
		listEl.appendChild(emptyState('No drops nearby', 'Be the first — drop SOL, USDC or $THREE right here for whoever walks up.', { label: '＋ Drop money here', fn: () => openCreate() }));
		return;
	}
	for (const d of nearby) listEl.appendChild(nearbyRow(d));
}

function nearbyRow(d) {
	const dist = markerDistance(d);
	const inRange = dist != null && dist <= d.radius_m;
	const row = el('div', 'irl-drop-row' + (inRange ? ' is-claimable' : ''));
	row.appendChild(coinBadge(d));
	const mid = el('div', 'irl-drop-mid');
	mid.appendChild(el('div', 'irl-drop-amt', `${fmtAmount(d)}${d.kind === 'bounty' ? ' <span class="irl-drop-tag">bounty</span>' : ''}`));
	mid.appendChild(el('div', 'irl-drop-meta', `${d.is_mine ? 'Your drop · ' : ''}${fmtDistance(dist)} · ${timeLeft(d.expires_at)}${d.claims_left < d.max_claims ? ` · ${d.claims_left}/${d.max_claims} left` : ''}`));
	if (d.title) mid.appendChild(el('div', 'irl-drop-note', escapeHtml(d.title)));
	row.appendChild(mid);
	const btn = el('button', 'irl-drop-go', inRange ? 'Claim' : fmtDistance(dist));
	btn.type = 'button';
	btn.disabled = !inRange && !d.is_mine;
	btn.addEventListener('click', () => (d.is_mine && !inRange) ? openClaim(d) : openClaim(d));
	row.appendChild(btn);
	return row;
}

function coinBadge(d) {
	const b = el('div', 'irl-drop-coin');
	b.textContent = d.asset === 'THREE' ? '3' : (d.asset === 'USDC' ? '$' : '◎');
	return b;
}

function renderMine() {
	const drops = mine.drops || [];
	if (!drops.length) {
		listEl.appendChild(emptyState('No drops yet', 'Leave money at a real place — a tip jar for a street-performing agent, or a treasure hunt.', { label: '＋ Drop money here', fn: () => openCreate() }));
		return;
	}
	for (const d of drops) listEl.appendChild(mineRow(d));
}

function mineRow(d) {
	const row = el('div', 'irl-drop-row');
	row.appendChild(coinBadge(d));
	const mid = el('div', 'irl-drop-mid');
	const statusLabel = {
		pending_funding: 'Awaiting funding', active: 'Active', exhausted: 'Fully claimed',
		expired: 'Expired', refunded: 'Refunded', cancelled: 'Cancelled',
	}[d.status] || d.status;
	mid.appendChild(el('div', 'irl-drop-amt', fmtAmount(d)));
	mid.appendChild(el('div', 'irl-drop-meta', `<span class="irl-drop-status s-${d.status}">${statusLabel}</span> · ${d.claims_count}/${d.max_claims} claimed · ${timeLeft(d.expires_at)}`));
	if (d.refund_tx && d.refund_tx !== 'empty') mid.appendChild(receiptLink('Refund', d.network, d.refund_tx));
	if (d.funding_tx) mid.appendChild(receiptLink('Funding', d.network, d.funding_tx));
	row.appendChild(mid);
	if (['active', 'exhausted', 'pending_funding'].includes(d.status)) {
		const cancel = el('button', 'irl-drop-cancel', d.status === 'pending_funding' ? 'Void' : 'Cancel & refund');
		cancel.type = 'button';
		cancel.addEventListener('click', () => cancelDrop(d, cancel));
		row.appendChild(cancel);
	}
	return row;
}

function renderClaims() {
	const claims = mine.claims || [];
	if (!claims.length) {
		listEl.appendChild(emptyState('No claims yet', 'Walk up to a glowing coin and claim it. Your receipts land here.', null));
		return;
	}
	for (const c of claims) {
		const row = el('div', 'irl-drop-row');
		const badge = el('div', 'irl-drop-coin');
		badge.textContent = c.asset === 'THREE' ? '3' : (c.asset === 'USDC' ? '$' : '◎');
		row.appendChild(badge);
		const mid = el('div', 'irl-drop-mid');
		mid.appendChild(el('div', 'irl-drop-amt', `+${c.amount} ${c.asset === 'THREE' ? '$THREE' : c.asset}`));
		mid.appendChild(el('div', 'irl-drop-meta', `<span class="irl-drop-status s-${c.status === 'confirmed' ? 'active' : c.status}">${c.status}</span> · ${new Date(c.created_at).toLocaleDateString()}`));
		if (c.signature) mid.appendChild(receiptLink('Receipt', c.network, c.signature));
		row.appendChild(mid);
		listEl.appendChild(row);
	}
}

function receiptLink(label, network, sig) {
	const a = el('a', 'irl-drop-receipt', `${label} ↗`);
	a.href = solanaTxExplorerUrl(network === 'devnet' ? 'devnet' : 'mainnet', sig);
	a.target = '_blank'; a.rel = 'noopener noreferrer';
	return a;
}

function escapeHtml(s) {
	return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ── create flow ───────────────────────────────────────────────────────────
function openCreate() {
	if (!gpsReady()) { toast('Enable location to drop money at this spot.'); return; }
	closePanel();
	const g = ctx.getGpsState();
	const state = { asset: 'SOL', amount: '', radius: 30, expiry: EXPIRY_PRESETS[1].ms, kind: 'drop', maxClaims: 1, busy: false };
	const { modal, body, close } = makeModal('Drop money here');

	function render() {
		body.innerHTML = '';
		body.appendChild(fieldLabel('Asset'));
		const assetRow = el('div', 'irl-dm-seg');
		for (const a of CREATE_ASSETS) {
			const b = el('button', 'irl-dm-seg-b' + (state.asset === a ? ' is-on' : ''), a === 'THREE' ? '$THREE' : a);
			b.type = 'button';
			b.addEventListener('click', () => { state.asset = a; render(); });
			assetRow.appendChild(b);
		}
		body.appendChild(assetRow);

		body.appendChild(fieldLabel('Amount per claim'));
		const amt = el('input', 'irl-dm-input');
		amt.type = 'text'; amt.inputMode = 'decimal'; amt.value = state.amount;
		amt.placeholder = state.asset === 'SOL' ? '0.05' : '5';
		amt.addEventListener('input', () => { state.amount = amt.value.trim(); });
		body.appendChild(amt);

		body.appendChild(fieldLabel('How many can claim'));
		const claimsRow = el('div', 'irl-dm-seg');
		for (const [n, lbl] of [[1, 'First only'], [5, '5 people'], [25, '25 people']]) {
			const b = el('button', 'irl-dm-seg-b' + (state.maxClaims === n ? ' is-on' : ''), lbl);
			b.type = 'button';
			b.addEventListener('click', () => { state.maxClaims = n; render(); });
			claimsRow.appendChild(b);
		}
		body.appendChild(claimsRow);

		body.appendChild(fieldLabel(`Claim radius — ${state.radius} m`));
		const slider = el('input', 'irl-dm-range');
		slider.type = 'range'; slider.min = '10'; slider.max = '100'; slider.step = '5'; slider.value = String(state.radius);
		slider.addEventListener('input', () => { state.radius = Number(slider.value); slider.previousSibling.textContent = `Claim radius — ${state.radius} m`; });
		body.appendChild(slider);

		body.appendChild(fieldLabel('Expires in'));
		const expRow = el('div', 'irl-dm-seg');
		for (const p of EXPIRY_PRESETS) {
			const b = el('button', 'irl-dm-seg-b' + (state.expiry === p.ms ? ' is-on' : ''), p.label);
			b.type = 'button';
			b.addEventListener('click', () => { state.expiry = p.ms; render(); });
			expRow.appendChild(b);
		}
		body.appendChild(expRow);

		const totalAtoms = Number(state.amount || 0) * state.maxClaims;
		const summary = el('p', 'irl-dm-summary', state.amount
			? `You'll fund <b>${totalAtoms} ${state.asset === 'THREE' ? '$THREE' : state.asset}</b> total (${state.amount} × ${state.maxClaims}). Whoever physically walks within ${state.radius} m and proves they're here claims their share to their own wallet. Unclaimed funds auto-refund to you on expiry.`
			: 'Set an amount to fund a real, on-chain drop anchored to this exact spot.');
		body.appendChild(summary);

		const go = el('button', 'irl-dm-go', 'Fund & drop');
		go.type = 'button';
		go.addEventListener('click', () => submit());
		body.appendChild(go);
		state._go = go;
	}

	async function submit() {
		const amt = Number(state.amount);
		if (!Number.isFinite(amt) || amt <= 0) { toast('Enter an amount greater than zero.'); return; }
		if (state.busy) return;
		state.busy = true;
		const go = state._go;
		const setStage = (t) => { go.textContent = t; go.disabled = true; };
		setStage('Creating drop…');
		try {
			// 1. Reserve the drop + escrow address.
			const createRes = await fetch('/api/irl/drops', {
				method: 'POST', credentials: 'include',
				headers: ctx.deviceHeaders ? ctx.deviceHeaders({ 'Content-Type': 'application/json' }) : { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					asset: state.asset, amount: state.amount, maxClaims: state.maxClaims,
					radiusM: state.radius, expiresInMs: state.expiry, lat: g.lat, lng: g.lng,
					claimRule: state.maxClaims === 1 ? 'first' : 'each-once', kind: state.kind,
				}),
			});
			const created = await createRes.json();
			if (!createRes.ok) throw new Error(created.error_description || created.error || 'Could not create the drop.');
			const dropId = created.drop.id;
			const escrow = created.escrow_address;

			// 2. Fund the escrow with the creator's own signed transfer.
			setStage('Approve in your wallet…');
			let funding;
			try {
				funding = await tipAgent({
					toAddress: escrow, token: state.asset,
					amount: Number(state.amount) * state.maxClaims,
					onStage: (s) => setStage(stageLabel(s)),
				});
			} catch (e) {
				// Roll the unfunded drop back so it isn't orphaned.
				cancelSilently(dropId);
				if (e instanceof TipError && e.code === 'cancelled') { setStage('Fund & drop'); go.disabled = false; state.busy = false; return; }
				throw new Error(e?.message || 'Funding was not completed.');
			}

			// 3. Confirm funding on-chain server-side → drop goes active.
			setStage('Confirming on-chain…');
			let confirmed = null;
			for (let i = 0; i < 8 && !confirmed; i++) {
				const fr = await fetch(`/api/irl/drops/${dropId}/fund`, {
					method: 'POST', credentials: 'include',
					headers: ctx.deviceHeaders ? ctx.deviceHeaders({ 'Content-Type': 'application/json' }) : { 'Content-Type': 'application/json' },
					body: JSON.stringify({ signature: funding.signature, refundAddress: funding.from }),
				});
				const fd = await fr.json();
				if (fr.ok && fd.drop) { confirmed = fd; break; }
				if (fr.status === 202) { await sleep(2500); continue; }   // awaiting confirmation
				throw new Error(fd.error_description || fd.error || 'Funding confirmation failed.');
			}
			if (!confirmed) throw new Error('Funding is taking longer than expected — it will appear once confirmed.');

			close();
			toast(`Dropped ${state.amount} ${state.asset === 'THREE' ? '$THREE' : state.asset} here. Watch for who claims it.`);
			fetchNearby();
			fetchMine();
		} catch (e) {
			setStage('Fund & drop'); go.disabled = false;
			toast(e?.message || 'Something went wrong creating the drop.', true);
		} finally {
			state.busy = false;
		}
	}

	render();
}

function stageLabel(s) {
	return ({ connecting: 'Connecting wallet…', building: 'Building transfer…', signing: 'Approve in your wallet…', sending: 'Sending…', confirming: 'Confirming…' })[s] || 'Working…';
}

async function cancelSilently(dropId) {
	try {
		await fetch(`/api/irl/drops/${dropId}/cancel`, {
			method: 'POST', credentials: 'include',
			headers: ctx.deviceHeaders ? ctx.deviceHeaders() : {},
		});
	} catch { /* best effort */ }
}

// ── claim flow ────────────────────────────────────────────────────────────
async function openClaim(drop) {
	const fresh = nearby.find((d) => d.id === drop.id) || drop;
	const dist = markerDistance(fresh);
	const inRange = dist != null && dist <= fresh.radius_m;
	const { modal, body, close } = makeModal(fresh.kind === 'bounty' ? 'Bounty' : 'Money drop');

	const head = el('div', 'irl-claim-head');
	head.appendChild(coinBadge(fresh));
	const ht = el('div', '');
	ht.appendChild(el('div', 'irl-claim-amt', fmtAmount(fresh)));
	ht.appendChild(el('div', 'irl-claim-sub', `${fmtDistance(dist)} away · ${timeLeft(fresh.expires_at)}`));
	head.appendChild(ht);
	body.appendChild(head);
	if (fresh.note) body.appendChild(el('p', 'irl-claim-note', escapeHtml(fresh.note)));

	let answerInput = null;
	if (fresh.kind === 'bounty' && fresh.quiz_question) {
		body.appendChild(el('p', 'irl-claim-q', escapeHtml(fresh.quiz_question)));
		answerInput = el('input', 'irl-dm-input');
		answerInput.type = 'text'; answerInput.placeholder = 'Your answer';
		body.appendChild(answerInput);
	}

	if (!inRange) {
		const oor = el('div', 'irl-claim-oor', `Get within ${Math.round(fresh.radius_m)} m to claim — you're ${fmtDistance(dist)} away. Walk closer with your camera up.`);
		body.appendChild(oor);
		const ok = el('button', 'irl-dm-go is-ghost', 'Got it');
		ok.type = 'button'; ok.addEventListener('click', close);
		body.appendChild(ok);
		return;
	}

	const go = el('button', 'irl-dm-go', 'Claim to my wallet');
	go.type = 'button';
	body.appendChild(go);
	go.addEventListener('click', async () => {
		go.disabled = true; go.textContent = 'Connecting wallet…';
		try {
			const wallet = detectSolanaWallet();
			if (!wallet) throw new Error('Install Phantom, Backpack, or Solflare to claim.');
			const conn = await wallet.connect();
			const pubkey = (conn?.publicKey || wallet.publicKey)?.toString();
			if (!pubkey) throw new Error('Could not read your wallet address.');

			go.textContent = 'Proving you are here…';
			const g = ctx.getGpsState();
			const headers = await presenceHeaders({ 'Content-Type': 'application/json' });
			const r = await fetch(`/api/irl/drops/${fresh.id}/claim`, {
				method: 'POST', credentials: 'include', headers,
				body: JSON.stringify({ wallet: pubkey, lat: g.lat, lng: g.lng, answer: answerInput?.value }),
			});
			const data = await r.json();
			if (!r.ok) throw new Error(data.error_description || data.error || 'Claim failed.');
			renderReceipt(body, fresh, data);
		} catch (e) {
			go.disabled = false; go.textContent = 'Claim to my wallet';
			toast(e?.message || 'Claim failed.', true);
		}
	});
}

function renderReceipt(body, drop, data) {
	body.innerHTML = '';
	const ok = el('div', 'irl-claim-ok');
	ok.innerHTML = `<div class="irl-claim-ok-burst" aria-hidden="true"></div>
		<div class="irl-claim-ok-amt">+${data.amount} ${data.asset === 'THREE' ? '$THREE' : data.asset}</div>
		<div class="irl-claim-ok-sub">Sent to your wallet. Real, on-chain, yours.</div>`;
	body.appendChild(ok);
	const link = el('a', 'irl-dm-go', 'View receipt on Solscan ↗');
	link.href = data.explorer_url; link.target = '_blank'; link.rel = 'noopener noreferrer';
	body.appendChild(link);
	fetchNearby(); fetchMine();
}

async function cancelDrop(drop, btn) {
	btn.disabled = true; btn.textContent = 'Refunding…';
	try {
		const r = await fetch(`/api/irl/drops/${drop.id}/cancel`, {
			method: 'POST', credentials: 'include',
			headers: ctx.deviceHeaders ? ctx.deviceHeaders() : {},
		});
		const data = await r.json();
		if (!r.ok) throw new Error(data.error_description || data.error || 'Refund failed.');
		toast(data.refunded ? 'Refunded to your wallet.' : 'Drop cancelled.');
		fetchMine(); fetchNearby();
	} catch (e) {
		btn.disabled = false; btn.textContent = 'Cancel & refund';
		toast(e?.message || 'Could not cancel the drop.', true);
	}
}

// ── modal + toast primitives ──────────────────────────────────────────────
function makeModal(title) {
	const backdrop = el('div', 'irl-dm-backdrop');
	const modal = el('div', 'irl-dm-modal');
	modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true'); modal.setAttribute('aria-label', title);
	const head = el('div', 'irl-dm-head');
	head.appendChild(el('h3', '', title));
	const x = el('button', 'irl-dm-x', '✕'); x.type = 'button'; x.setAttribute('aria-label', 'Close');
	head.appendChild(x);
	const body = el('div', 'irl-dm-body');
	modal.appendChild(head); modal.appendChild(body);
	backdrop.appendChild(modal);
	document.body.appendChild(backdrop);
	requestAnimationFrame(() => backdrop.classList.add('is-open'));
	const close = () => { backdrop.classList.remove('is-open'); setTimeout(() => backdrop.remove(), 200); };
	x.addEventListener('click', close);
	backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
	document.addEventListener('keydown', function esc(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); } });
	try { x.focus({ preventScroll: true }); } catch { /* */ }
	return { modal, body, close };
}

function fieldLabel(t) { return el('label', 'irl-dm-lbl', t); }

let toastTimer = null;
function toast(msg, isErr) {
	let t = document.querySelector('.irl-drops-toast');
	if (!t) { t = el('div', 'irl-drops-toast'); document.body.appendChild(t); }
	t.textContent = msg;
	t.classList.toggle('is-err', !!isErr);
	t.classList.add('is-on');
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => t.classList.remove('is-on'), 4200);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ── styles (wallet-violet family, design tokens) ───────────────────────────
function ensureStyles() {
	if (_styled) return; _styled = true;
	const css = `
.irl-drops-fab{position:fixed;right:16px;bottom:calc(var(--irl-dock-h, calc(96px + env(safe-area-inset-bottom,0px))) + 12px);z-index:60;width:52px;height:52px;border-radius:999px;border:1px solid var(--wallet-stroke,rgba(139,92,246,.3));background:linear-gradient(160deg,rgba(20,18,30,.95),rgba(12,10,18,.95));color:var(--wallet-accent,#c4b5fd);display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 6px 24px rgba(0,0,0,.5),0 0 0 0 var(--wallet-glow,rgba(139,92,246,.45));transition:transform .15s,box-shadow .2s,border-color .2s}
body.irl-immersive .irl-drops-fab{bottom:calc(env(safe-area-inset-bottom,0px) + 16px)}
/* Any open bottom sheet outranks the FAB — it must never paint over a sheet's
   controls (it sits at z 60 so it clears the page HUD, not the dialogs). */
body:has([id$="-sheet"].is-open) .irl-drops-fab,body:has(#irl-caption-panel.is-open) .irl-drops-fab,body:has(#irl-calibrate-panel.is-open) .irl-drops-fab{opacity:0;pointer-events:none}
.irl-drops-fab:hover{transform:translateY(-2px);border-color:var(--wallet-stroke-strong,rgba(139,92,246,.5));box-shadow:0 10px 30px rgba(0,0,0,.55),0 0 24px var(--wallet-glow,rgba(139,92,246,.45))}
.irl-drops-fab:active{transform:translateY(0)}
.irl-drops-fab:focus-visible{outline:2px solid var(--wallet-focus,rgba(139,92,246,.7));outline-offset:2px}
.irl-drops-fab-badge{position:absolute;top:-4px;right:-4px;min-width:20px;height:20px;padding:0 5px;border-radius:999px;background:var(--wallet-accent-strong,#a78bfa);color:#0a0a0a;font:700 11px/20px var(--font-mono,ui-monospace,monospace);text-align:center;box-shadow:0 0 0 2px rgba(10,10,10,.9)}
.irl-drops-fab-badge.is-hot{background:var(--success,#4ade80);animation:irl-drops-pulse 1.6s ease-in-out infinite}
@keyframes irl-drops-pulse{0%,100%{box-shadow:0 0 0 2px rgba(10,10,10,.9),0 0 0 0 rgba(74,222,128,.6)}50%{box-shadow:0 0 0 2px rgba(10,10,10,.9),0 0 0 7px rgba(74,222,128,0)}}
@media (prefers-reduced-motion:reduce){.irl-drops-fab-badge.is-hot{animation:none}}
.irl-drops-backdrop{position:fixed;inset:0;z-index:64;background:rgba(0,0,0,.5);opacity:0;pointer-events:none;transition:opacity .2s}
.irl-drops-backdrop.is-open{opacity:1;pointer-events:auto}
.irl-drops-panel{position:fixed;left:0;right:0;bottom:0;z-index:65;max-height:80vh;display:flex;flex-direction:column;background:linear-gradient(180deg,rgba(16,14,22,.98),rgba(10,9,14,.99));border-top:1px solid var(--wallet-stroke,rgba(139,92,246,.3));border-radius:20px 20px 0 0;box-shadow:0 -12px 40px rgba(0,0,0,.6);transform:translateY(102%);transition:transform .28s cubic-bezier(.2,.8,.2,1);padding:10px 16px calc(16px + env(safe-area-inset-bottom,0px));color:var(--ink,#e5e7eb)}
.irl-drops-panel.is-open{transform:translateY(0)}
.irl-drops-handle{width:38px;height:4px;border-radius:99px;background:rgba(255,255,255,.18);margin:2px auto 10px}
.irl-drops-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
.irl-drops-head h2{margin:0;font:700 17px var(--font-display,Inter,sans-serif);color:var(--ink-bright,#fff)}
.irl-drops-close{background:none;border:none;color:var(--ink-dim,#9ca3af);font-size:16px;cursor:pointer;padding:6px;border-radius:8px;min-width:36px;min-height:36px}
@media (hover:none){.irl-drops-close{min-width:44px;min-height:44px;font-size:18px}}
.irl-drops-close:hover{color:#fff;background:rgba(255,255,255,.06)}
.irl-drops-close:focus-visible{outline:2px solid var(--wallet-focus,rgba(139,92,246,.7));outline-offset:1px}
.irl-drops-tabs{display:flex;gap:6px;margin-bottom:10px}
.irl-drops-tab{flex:1;padding:8px 6px;border-radius:10px;border:1px solid transparent;background:rgba(255,255,255,.04);color:var(--ink-dim,#9ca3af);font:600 12.5px var(--font-body,Inter);cursor:pointer;transition:background .15s,color .15s,border-color .15s}
@media (hover:none){.irl-drops-tab{min-height:44px}}
.irl-drops-tab:hover{background:rgba(255,255,255,.07);color:#e5e7eb}
.irl-drops-tab[aria-selected=true]{background:var(--wallet-accent-fill,rgba(139,92,246,.15));border-color:var(--wallet-stroke,rgba(139,92,246,.3));color:var(--wallet-accent,#c4b5fd)}
.irl-drops-tab:focus-visible{outline:2px solid var(--wallet-focus,rgba(139,92,246,.7));outline-offset:1px}
.irl-drops-list{overflow-y:auto;flex:1;min-height:120px;display:flex;flex-direction:column;gap:8px;padding:2px 0 8px}
.irl-drop-row{display:flex;align-items:center;gap:11px;padding:11px;border-radius:13px;border:1px solid rgba(255,255,255,.07);background:rgba(255,255,255,.03);transition:border-color .15s,background .15s}
.irl-drop-row.is-claimable{border-color:var(--wallet-stroke-strong,rgba(139,92,246,.5));background:var(--wallet-accent-soft,rgba(139,92,246,.1));box-shadow:0 0 18px rgba(139,92,246,.18)}
.irl-drop-coin{width:38px;height:38px;flex-shrink:0;border-radius:50%;display:flex;align-items:center;justify-content:center;font:700 16px var(--font-mono,monospace);color:#0a0a0a;background:radial-gradient(circle at 35% 30%,#e9e1ff,var(--wallet-accent,#c4b5fd) 60%,var(--wallet-accent-strong,#a78bfa));box-shadow:0 2px 10px rgba(139,92,246,.4)}
.irl-drop-mid{flex:1;min-width:0}
.irl-drop-amt{font:700 15px var(--font-body,Inter);color:var(--ink-bright,#fff)}
.irl-drop-tag{font:600 10px var(--font-mono,monospace);text-transform:uppercase;letter-spacing:.04em;color:var(--wallet-accent,#c4b5fd);border:1px solid var(--wallet-stroke,rgba(139,92,246,.3));border-radius:5px;padding:1px 5px;margin-left:6px;vertical-align:middle}
.irl-drop-meta{font:500 12px var(--font-body,Inter);color:var(--ink-dim,#9ca3af);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.irl-drop-note{font:500 12px var(--font-body,Inter);color:#b9b3c7;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.irl-drop-status{font-weight:700}.irl-drop-status.s-active{color:var(--success,#4ade80)}.irl-drop-status.s-refunded,.irl-drop-status.s-expired,.irl-drop-status.s-cancelled{color:var(--ink-dim,#9ca3af)}.irl-drop-status.s-pending_funding{color:var(--warn,#fbbf24)}.irl-drop-status.s-exhausted{color:var(--wallet-accent,#c4b5fd)}
.irl-drop-receipt{display:inline-block;margin-top:3px;margin-right:10px;font:600 11.5px var(--font-mono,monospace);color:var(--wallet-accent,#c4b5fd);text-decoration:none}
.irl-drop-receipt:hover{text-decoration:underline}
.irl-drop-go,.irl-drop-cancel{flex-shrink:0;padding:9px 14px;border-radius:10px;font:700 13px var(--font-body,Inter);cursor:pointer;border:1px solid var(--wallet-stroke,rgba(139,92,246,.3));background:var(--wallet-accent,#c4b5fd);color:#0a0a0a;transition:transform .12s,filter .15s,opacity .15s}
.irl-drop-go:hover{filter:brightness(1.08)}.irl-drop-go:active{transform:scale(.97)}
.irl-drop-go:disabled{opacity:.4;cursor:not-allowed;background:rgba(255,255,255,.08);color:var(--ink-dim,#9ca3af);border-color:rgba(255,255,255,.1)}
.irl-drop-go:focus-visible,.irl-drop-cancel:focus-visible{outline:2px solid var(--wallet-focus,rgba(139,92,246,.7));outline-offset:2px}
.irl-drop-cancel{background:rgba(248,113,113,.1);color:var(--danger,#f87171);border-color:rgba(248,113,113,.3)}
.irl-drop-cancel:hover{background:rgba(248,113,113,.18)}
.irl-drops-create{margin-top:8px;padding:13px;border-radius:13px;border:1px solid var(--wallet-stroke,rgba(139,92,246,.3));background:var(--wallet-accent-fill,rgba(139,92,246,.15));color:var(--wallet-accent,#c4b5fd);font:700 14px var(--font-body,Inter);cursor:pointer;transition:background .15s}
.irl-drops-create:hover{background:var(--wallet-accent-soft,rgba(139,92,246,.22))}
.irl-drops-create:focus-visible{outline:2px solid var(--wallet-focus,rgba(139,92,246,.7));outline-offset:2px}
.irl-drops-empty{text-align:center;padding:26px 16px;display:flex;flex-direction:column;align-items:center;gap:8px}
.irl-drops-empty-pulse{width:46px;height:46px;border-radius:50%;background:radial-gradient(circle,var(--wallet-accent,#c4b5fd),transparent 70%);opacity:.5;animation:irl-drops-glow 2.4s ease-in-out infinite}
@keyframes irl-drops-glow{0%,100%{transform:scale(.85);opacity:.35}50%{transform:scale(1.1);opacity:.6}}
@media (prefers-reduced-motion:reduce){.irl-drops-empty-pulse{animation:none}}
.irl-drops-empty-t{margin:4px 0 0;font:700 15px var(--font-body,Inter);color:#fff}
.irl-drops-empty-b{margin:0;font:500 13px var(--font-body,Inter);color:var(--ink-dim,#9ca3af);max-width:260px;line-height:1.5}
.irl-drops-empty-act{margin-top:6px;padding:10px 16px;border-radius:10px;border:1px solid var(--wallet-stroke,rgba(139,92,246,.3));background:var(--wallet-accent-fill,rgba(139,92,246,.15));color:var(--wallet-accent,#c4b5fd);font:700 13px var(--font-body,Inter);cursor:pointer}
.irl-drops-empty-act:hover{background:var(--wallet-accent-soft,rgba(139,92,246,.22))}
.irl-drop-label{position:fixed;left:0;top:0;z-index:55;transform:translate(-50%,-50%);pointer-events:auto;display:flex;flex-direction:column;align-items:center;gap:1px;padding:5px 10px;border-radius:11px;border:1px solid var(--wallet-stroke,rgba(139,92,246,.3));background:rgba(12,10,18,.86);backdrop-filter:blur(6px);cursor:pointer;white-space:nowrap;font-family:var(--font-body,Inter)}
.irl-drop-label.is-claimable{border-color:var(--wallet-accent,#c4b5fd);box-shadow:0 0 22px var(--wallet-glow,rgba(139,92,246,.45))}
.irl-drop-label-amt{font-weight:700;font-size:13px;color:#fff}
.irl-drop-label-sub{font-size:10.5px;color:var(--wallet-accent,#c4b5fd)}
.irl-dm-backdrop{position:fixed;inset:0;z-index:80;display:flex;align-items:flex-end;justify-content:center;background:rgba(0,0,0,.6);opacity:0;pointer-events:none;transition:opacity .2s}
.irl-dm-backdrop.is-open{opacity:1;pointer-events:auto}
.irl-dm-modal{width:100%;max-width:460px;max-height:88vh;overflow-y:auto;background:linear-gradient(180deg,rgba(18,16,24,.99),rgba(11,10,15,1));border:1px solid var(--wallet-stroke,rgba(139,92,246,.3));border-radius:20px 20px 0 0;padding:16px 18px calc(20px + env(safe-area-inset-bottom,0px));transform:translateY(20px);transition:transform .24s cubic-bezier(.2,.8,.2,1);color:var(--ink,#e5e7eb)}
.irl-dm-backdrop.is-open .irl-dm-modal{transform:translateY(0)}
@media (min-width:560px){.irl-dm-backdrop{align-items:center}.irl-dm-modal{border-radius:20px}}
.irl-dm-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}
.irl-dm-head h3{margin:0;font:700 17px var(--font-display,Inter)}
.irl-dm-x{background:none;border:none;color:var(--ink-dim,#9ca3af);font-size:16px;cursor:pointer;padding:6px;border-radius:8px}
.irl-dm-x:hover{color:#fff;background:rgba(255,255,255,.06)}
.irl-dm-x:focus-visible{outline:2px solid var(--wallet-focus,rgba(139,92,246,.7));outline-offset:1px}
.irl-dm-lbl{display:block;font:600 12px var(--font-body,Inter);color:var(--ink-dim,#9ca3af);margin:12px 0 6px}
.irl-dm-seg{display:flex;gap:6px}
.irl-dm-seg-b{flex:1;padding:9px 6px;border-radius:9px;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.04);color:var(--ink-dim,#9ca3af);font:600 12.5px var(--font-body,Inter);cursor:pointer;transition:background .14s,border-color .14s,color .14s}
.irl-dm-seg-b:hover{background:rgba(255,255,255,.07);color:#e5e7eb}
.irl-dm-seg-b.is-on{background:var(--wallet-accent-fill,rgba(139,92,246,.15));border-color:var(--wallet-stroke,rgba(139,92,246,.3));color:var(--wallet-accent,#c4b5fd)}
.irl-dm-seg-b:focus-visible{outline:2px solid var(--wallet-focus,rgba(139,92,246,.7));outline-offset:1px}
.irl-dm-input{width:100%;padding:11px 13px;border-radius:10px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.04);color:#fff;font:600 15px var(--font-mono,monospace)}
.irl-dm-input:focus{outline:none;border-color:var(--wallet-stroke-strong,rgba(139,92,246,.5));box-shadow:0 0 0 3px var(--wallet-accent-soft,rgba(139,92,246,.1))}
.irl-dm-range{width:100%;accent-color:var(--wallet-accent,#c4b5fd)}
.irl-dm-summary{font:500 12.5px var(--font-body,Inter);color:var(--ink-dim,#9ca3af);line-height:1.55;margin:14px 0 4px;padding:10px 12px;border-radius:10px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06)}
.irl-dm-summary b{color:var(--wallet-accent,#c4b5fd)}
.irl-dm-go{display:block;width:100%;margin-top:14px;padding:13px;border-radius:12px;border:none;background:var(--wallet-accent,#c4b5fd);color:#0a0a0a;font:700 14.5px var(--font-body,Inter);cursor:pointer;text-align:center;text-decoration:none;transition:filter .15s,transform .12s,opacity .15s}
.irl-dm-go:hover{filter:brightness(1.08)}.irl-dm-go:active{transform:scale(.99)}
.irl-dm-go:disabled{opacity:.6;cursor:default}
.irl-dm-go.is-ghost{background:rgba(255,255,255,.06);color:#e5e7eb}
.irl-dm-go:focus-visible{outline:2px solid var(--wallet-focus,rgba(139,92,246,.7));outline-offset:2px}
.irl-claim-head{display:flex;align-items:center;gap:12px;margin-bottom:8px}
.irl-claim-amt{font:700 22px var(--font-body,Inter);color:#fff}
.irl-claim-sub{font:500 12.5px var(--font-body,Inter);color:var(--ink-dim,#9ca3af)}
.irl-claim-note{font:500 13px var(--font-body,Inter);color:#c9c3d7;line-height:1.5;margin:6px 0}
.irl-claim-q{font:600 14px var(--font-body,Inter);color:#fff;margin:12px 0 8px}
.irl-claim-oor{margin-top:12px;padding:12px;border-radius:11px;background:rgba(251,191,36,.08);border:1px solid rgba(251,191,36,.25);color:#fcd34d;font:500 13px var(--font-body,Inter);line-height:1.5}
.irl-claim-ok{text-align:center;padding:18px 8px 8px;position:relative}
.irl-claim-ok-burst{position:absolute;left:50%;top:30%;width:120px;height:120px;transform:translate(-50%,-50%);background:radial-gradient(circle,var(--success,#4ade80),transparent 65%);opacity:.45;animation:irl-drops-glow 1.8s ease-in-out 2}
.irl-claim-ok-amt{font:800 30px var(--font-body,Inter);color:var(--success,#4ade80);position:relative}
.irl-claim-ok-sub{font:500 13px var(--font-body,Inter);color:var(--ink-dim,#9ca3af);margin-top:4px;position:relative}
.irl-drops-toast{position:fixed;left:50%;bottom:calc(150px + env(safe-area-inset-bottom,0px));transform:translateX(-50%) translateY(12px);z-index:90;max-width:88vw;padding:11px 16px;border-radius:12px;background:rgba(16,14,22,.97);border:1px solid var(--wallet-stroke,rgba(139,92,246,.3));color:#fff;font:600 13px var(--font-body,Inter);box-shadow:0 8px 30px rgba(0,0,0,.6);opacity:0;pointer-events:none;transition:opacity .2s,transform .2s;text-align:center}
.irl-drops-toast.is-on{opacity:1;transform:translateX(-50%) translateY(0)}
.irl-drops-toast.is-err{border-color:rgba(248,113,113,.4)}
`;
	const style = document.createElement('style');
	style.id = 'irl-drops-styles';
	style.textContent = css;
	document.head.appendChild(style);
}
