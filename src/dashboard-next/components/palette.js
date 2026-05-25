// dashboard-next — command palette (foundation stub).
//
// Listens for the global 'dn:palette:open' event and shows a minimal
// navigable list of every route in nav.js. Prompt #8 replaces this with
// a full fuzzy-search palette (recent items, action handlers, keyboard
// navigation). This stub guarantees the ⌘K key works from day one.

import { NAV } from '../nav.js';
import { esc } from '../api.js';

let overlayEl = null;

function ensureOverlay() {
	if (overlayEl) return overlayEl;
	overlayEl = document.createElement('div');
	overlayEl.id = 'dn-palette';
	overlayEl.setAttribute('role', 'dialog');
	overlayEl.setAttribute('aria-modal', 'true');
	overlayEl.setAttribute('aria-label', 'Command palette');
	overlayEl.style.cssText = `
		position: fixed; inset: 0; z-index: 100;
		background: rgba(2, 3, 6, 0.6); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
		display: none; align-items: flex-start; justify-content: center;
		padding-top: 12vh;
	`;
	overlayEl.innerHTML = `
		<div style="
			width: min(560px, 92vw);
			background: linear-gradient(180deg, rgba(28,29,39,0.95), rgba(20,21,28,0.95));
			border: 1px solid var(--nxt-stroke-strong);
			border-radius: var(--nxt-radius);
			box-shadow: 0 30px 80px rgba(0,0,0,0.6);
			overflow: hidden;
		">
			<input type="text" autocomplete="off" autocapitalize="off" spellcheck="false"
				placeholder="Jump to a page or run a command…"
				data-role="palette-input"
				style="
					width: 100%;
					background: transparent; border: 0; outline: none;
					padding: 16px 18px;
					font: 15px/1.4 'Inter', system-ui, sans-serif;
					color: var(--nxt-ink);
					border-bottom: 1px solid var(--nxt-stroke);
				" />
			<div data-role="palette-list" style="max-height: 56vh; overflow-y: auto; padding: 6px;"></div>
		</div>`;
	document.body.appendChild(overlayEl);
	overlayEl.addEventListener('click', (e) => {
		if (e.target === overlayEl) close();
	});
	overlayEl.querySelector('[data-role="palette-input"]').addEventListener('input', (e) => {
		render(e.target.value);
	});
	overlayEl.addEventListener('keydown', (e) => {
		if (e.key === 'Escape') { e.preventDefault(); close(); return; }
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			e.preventDefault();
			moveActive(e.key === 'ArrowDown' ? 1 : -1);
			return;
		}
		if (e.key === 'Enter') {
			e.preventDefault();
			const active = overlayEl.querySelector('[data-active="true"]');
			if (active) activate(active);
		}
	});
	return overlayEl;
}

function render(query) {
	const list = overlayEl.querySelector('[data-role="palette-list"]');
	const q = String(query || '').trim().toLowerCase();
	const items = !q
		? NAV
		: NAV.filter((r) => {
			const hay = [r.label, r.group, ...(r.tags || [])].join(' ').toLowerCase();
			return hay.includes(q);
		});
	if (!items.length) {
		list.innerHTML = `<div style="padding:18px;color:var(--nxt-ink-dim);font-size:13px">No matches.</div>`;
		return;
	}
	list.innerHTML = items.map((r, i) => `
		<button type="button" data-path="${esc(r.path)}" data-active="${i === 0 ? 'true' : 'false'}" style="
			display: flex; align-items: center; justify-content: space-between;
			width: 100%; text-align: left; border: 0; cursor: pointer;
			padding: 10px 12px; border-radius: 8px; gap: 12px;
			color: var(--nxt-ink); font-size: 13.5px;
			background: ${i === 0 ? 'rgba(154,124,255,0.12)' : 'transparent'};
		">
			<span>${esc(r.label)}</span>
			<span style="font-size:11.5px;color:var(--nxt-ink-fade)">${esc(r.group)}</span>
		</button>
	`).join('');
	list.querySelectorAll('button[data-path]').forEach((btn) => {
		btn.addEventListener('mouseenter', () => {
			list.querySelectorAll('[data-active="true"]').forEach((el) => {
				el.setAttribute('data-active', 'false');
				el.style.background = 'transparent';
			});
			btn.setAttribute('data-active', 'true');
			btn.style.background = 'rgba(154,124,255,0.12)';
		});
		btn.addEventListener('click', () => activate(btn));
	});
}

function moveActive(delta) {
	const list = overlayEl.querySelector('[data-role="palette-list"]');
	const btns = [...list.querySelectorAll('button[data-path]')];
	if (!btns.length) return;
	let idx = btns.findIndex((b) => b.getAttribute('data-active') === 'true');
	idx = (idx + delta + btns.length) % btns.length;
	btns.forEach((b, i) => {
		b.setAttribute('data-active', i === idx ? 'true' : 'false');
		b.style.background = i === idx ? 'rgba(154,124,255,0.12)' : 'transparent';
		if (i === idx) b.scrollIntoView({ block: 'nearest' });
	});
}

function activate(btn) {
	const path = btn.getAttribute('data-path');
	if (path) location.href = path;
}

function open() {
	const el = ensureOverlay();
	render('');
	el.style.display = 'flex';
	const input = el.querySelector('[data-role="palette-input"]');
	input.value = '';
	setTimeout(() => input.focus(), 0);
}

function close() {
	if (overlayEl) overlayEl.style.display = 'none';
}

export function mountPaletteBehavior() {
	window.addEventListener('dn:palette:open', open);
	window.addEventListener('dn:palette:close', close);
}
