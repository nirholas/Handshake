/**
 * Avatar Studio — /create/studio
 *
 * Build a custom 3D avatar from a base template without needing a selfie.
 * Loads the base GLB, lets the user sculpt face/body morphs, pick outfits
 * and accessories, then saves the result to their account (upload base GLB +
 * create avatar record + PATCH appearance for server-side bake).
 *
 * Reuses the same building blocks as avatar-edit.js:
 *   - TalkScene for the 3D viewport
 *   - AccessoryManager for outfit/accessory application
 *   - renderSculptPanel from avatar-sculpt.js for face/body morphs
 *   - IdleAnimation for ambient breathing/blinking
 *
 * The save flow mirrors create.js → create-review.js: upload the base GLB
 * via presign + direct R2 PUT, create the avatar record, then PATCH it with
 * the appearance JSON so the server bakes a canonical GLB.
 */

import { TalkScene } from './voice/talk-scene.js';
import { AccessoryManager } from './agent-accessories.js';
import { IdleAnimation } from './idle-animation.js';
import { renderSculptPanel, applyMorphsToRoot } from './avatar-sculpt.js';
import { saveRemoteGlbToAccount, apiFetch } from './account.js';
import { uploadAvatarSnapshot } from './voice/avatar-snapshot.js';

const BASE_GLB_URL = '/avatars/default.glb';

const $ = (id) => document.getElementById(id);
const esc = (s) =>
	String(s ?? '').replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
	);

// ── State ────────────────────────────────────────────────────────────

let scene = null;
let accessoryManager = null;
let idle = null;
let presets = [];
let presetsById = new Map();

let workingAppearance = { accessories: [], morphs: {}, colors: {}, hidden: [] };
let previewedId = null;
let previewToken = 0;
let opQueue = Promise.resolve();
let searchQuery = '';

function queueOp(fn) {
	const next = opQueue.then(fn).catch((err) => {
		console.warn('[avatar-studio] queued op failed:', err);
	});
	opQueue = next;
	return next;
}

const TABS = [
	{ id: 'color', label: 'Color', kinds: [], color: true },
	{ id: 'hat', label: 'Hats', kinds: ['hat'], emoji: '🎩', single: true },
	{ id: 'glasses', label: 'Glasses', kinds: ['glasses'], emoji: '🕶️', single: true },
	{ id: 'earrings', label: 'Earrings', kinds: ['earrings'], emoji: '💎', single: false },
	{ id: 'sculpt', label: 'Face', kinds: [], emoji: '✨', single: true, sculpt: true },
];
const KIND_EMOJI = { hat: '🎩', glasses: '🕶️', earrings: '💎' };
const KIND_LABEL = { hat: 'Hat', glasses: 'Glasses', earrings: 'Earrings' };
let activeTab = 'color';

// ── Color customization ──────────────────────────────────────────────
// The base avatar is a ReadyPlayerMe (Wolf3D) mesh with named, texture-backed
// materials. We tint a slot by multiplying every material in that slot by a
// chosen color (white = original texture, untinted). The same slot→material
// map and tint semantics are mirrored server-side in api/_lib/bake.js so the
// saved/baked GLB looks identical to the live preview.
const COLOR_SLOTS = [
	{
		id: 'skin',
		label: 'Skin tone',
		materials: ['Wolf3D_Skin', 'Wolf3D_Body'],
		swatches: ['#ffe9d6', '#f3c1a3', '#e0a878', '#c08552', '#9c6b44', '#6f4a32', '#4a2f20'],
	},
	{
		id: 'hair',
		label: 'Hair',
		materials: ['Wolf3D_Hair'],
		swatches: ['#0e0e0e', '#3b2417', '#6b4423', '#9a6a3a', '#c89b5a', '#d8b34a', '#b8b8b8', '#e2604a', '#9b5cc0', '#4a86d6'],
	},
	{
		id: 'outfit',
		label: 'Outfit',
		materials: ['Wolf3D_Outfit_Top', 'Wolf3D_Outfit_Bottom', 'Wolf3D_Outfit_Footwear'],
		swatches: ['#222831', '#f2f2f2', '#1e3a5f', '#7a1f2b', '#1f6b3a', '#c08a1e', '#6b3fa0', '#d4577e', '#3b6ea5', '#101010'],
	},
];
const COLOR_SLOT_BY_ID = new Map(COLOR_SLOTS.map((s) => [s.id, s]));
const HEX_RE = /^#[0-9a-f]{6}$/i;
const BODY_TYPE = 'feminine'; // the single shipped base mesh is feminine-presenting

// ── Garment layers (show/hide) ───────────────────────────────────────
// The base avatar ships its garments as separate skinned meshes, so we can
// strip it back toward the base body and build the look up again. Hiding a
// layer toggles its meshes' `visible`; the hidden slot ids persist in
// appearance.hidden, bake out server-side (api/_lib/bake.js applyHidden), and
// re-apply on the editor via AccessoryManager.applyLayers. `strip` marks the
// layers the "Start minimal" shortcut removes — hair is kept.
const LAYER_SLOTS = [
	{ id: 'outfit', label: 'Outfit', materials: ['Wolf3D_Outfit_Top', 'Wolf3D_Outfit_Bottom', 'Wolf3D_Outfit_Footwear'], strip: true },
	{ id: 'glasses', label: 'Glasses', materials: ['Wolf3D_Glasses'], strip: true },
	{ id: 'hair', label: 'Hair', materials: ['Wolf3D_Hair'], strip: false },
];
const EYE_ON =
	'<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF =
	'<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

// ── Init ─────────────────────────────────────────────────────────────

init().catch((err) => {
	console.error('[avatar-studio] init', err);
	$('as-shell').innerHTML = `<div class="as-error">${esc(err.message || 'Failed to load')}</div>`;
});

async function init() {
	const scenePromise = bootScene();

	presets = await fetchPresets();
	presetsById = new Map(presets.map((p) => [p.id, p]));

	renderTabs();
	renderChips();
	renderActivePanel();
	bindHeader();

	await scenePromise;
	// Re-render once the mesh is live so the active panel (sculpt morphs, color
	// preview) reflects the loaded avatar instead of the "waiting" placeholder,
	// and replay any colours/hidden layers chosen before the GLB finished loading.
	if (scene?.root) {
		applyAllColors();
		applyAllLayers();
	}
	renderActivePanel();
}

async function bootScene() {
	scene = new TalkScene();
	try {
		await scene.mount({
			container: $('as-stage'),
			glbUrl: BASE_GLB_URL,
		});
		$('as-loading')?.remove();
		accessoryManager = new AccessoryManager({
			content: scene.root,
			invalidate: () => {},
		});

		idle = new IdleAnimation({
			getRoot: () => scene.root,
			seed: 'avatar-studio',
		});
		scene.addOnTick((dt) => idle.update(dt));

		setStatus('', 'Choose a style below to get started.');
	} catch (err) {
		const loadingEl = $('as-loading');
		if (loadingEl) loadingEl.textContent = `Could not load base avatar: ${err.message}`;
	}
}

// ── API ──────────────────────────────────────────────────────────────

async function fetchPresets() {
	const r = await fetch('/accessories/presets.json');
	if (!r.ok) throw new Error(`Could not load presets (${r.status})`);
	return r.json();
}

// ── Rendering ────────────────────────────────────────────────────────

function renderTabs() {
	const el = $('as-tabs');
	el.innerHTML = TABS.map((t) => {
		const active = t.id === activeTab;
		return `
			<button class="as-tab${active ? ' active' : ''}" data-tab="${t.id}" role="tab"
			        id="as-tab-${t.id}" aria-selected="${active ? 'true' : 'false'}"
			        aria-controls="as-panel" tabindex="${active ? '0' : '-1'}">
				${t.label}
			</button>`;
	}).join('');

	const tabs = [...el.querySelectorAll('.as-tab')];
	const selectTab = (btn, { focus = false } = {}) => {
		if (!btn || btn.dataset.tab === activeTab) {
			if (focus) btn?.focus();
			return;
		}
		activeTab = btn.dataset.tab;
		searchQuery = '';
		tabs.forEach((b) => {
			const on = b === btn;
			b.classList.toggle('active', on);
			b.setAttribute('aria-selected', on ? 'true' : 'false');
			b.tabIndex = on ? 0 : -1;
		});
		if (focus) btn.focus();
		renderActivePanel();
	};

	tabs.forEach((btn, i) => {
		btn.addEventListener('click', () => selectTab(btn));
		// Roving-tabindex keyboard nav per WAI-ARIA tablist pattern.
		btn.addEventListener('keydown', (e) => {
			let target = null;
			if (e.key === 'ArrowRight' || e.key === 'ArrowDown') target = tabs[(i + 1) % tabs.length];
			else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') target = tabs[(i - 1 + tabs.length) % tabs.length];
			else if (e.key === 'Home') target = tabs[0];
			else if (e.key === 'End') target = tabs[tabs.length - 1];
			else return;
			e.preventDefault();
			selectTab(target, { focus: true });
		});
	});
}

function renderActivePanel() {
	const tab = TABS.find((t) => t.id === activeTab);
	const panel = $('as-panel');
	panel.setAttribute('aria-labelledby', `as-tab-${activeTab}`);

	if (tab.color) {
		renderColorPanel(panel);
		return;
	}

	if (tab.sculpt) {
		if (!scene?.root) {
			panel.innerHTML = `<div class="as-empty">Waiting for avatar to load...</div>`;
			return;
		}
		renderSculptPanel({
			container: panel,
			root: scene.root,
			working: workingAppearance,
			onDirty: () => {
				renderChips();
			},
		});
		return;
	}

	const q = searchQuery.trim().toLowerCase();
	const items = presets.filter(
		(p) => tab.kinds.includes(p.kind) && (!q || p.name.toLowerCase().includes(q)),
	);

	const searchHtml = `
		<div class="as-search-wrap">
			<input class="as-search" id="as-search" type="search"
			       placeholder="Search ${esc(tab.label.toLowerCase())}..."
			       value="${esc(searchQuery)}" autocomplete="off" />
		</div>`;

	if (items.length === 0 && q) {
		panel.innerHTML = searchHtml + `<div class="as-empty">No matches for "${esc(searchQuery)}".</div>`;
		bindSearch();
		return;
	}

	const tiles = [];
	if (!q) {
		tiles.push(`
			<button class="as-tile as-tile-none${tileSelected(tab, null) ? ' selected' : ''}"
			        type="button" data-id="" data-kind="${tab.id}">
				<div class="as-tile-preview" aria-hidden="true">∅</div>
				<div class="as-tile-name">None</div>
				<div class="as-tile-kind">remove</div>
			</button>
		`);
	}
	for (const p of items) {
		const previewing = previewedId === p.id;
		const selected = tileSelected(tab, p.id);
		tiles.push(`
			<button class="as-tile${selected ? ' selected' : ''}${previewing ? ' previewing' : ''}"
			        type="button" data-id="${esc(p.id)}" data-kind="${tab.id}">
				<div class="as-tile-preview" aria-hidden="true">
					${tilePreviewMarkup(p)}
				</div>
				<div class="as-tile-name">${esc(p.name)}</div>
				<div class="as-tile-kind">${esc(KIND_LABEL[p.kind] || p.kind)}</div>
			</button>
		`);
	}

	panel.innerHTML = searchHtml + `<div class="as-grid">${tiles.join('')}</div>`;
	bindSearch();
	bindTiles(panel, tab);
}

function tilePreviewMarkup(preset) {
	const emoji = KIND_EMOJI[preset.kind] || '◇';
	if (!preset.thumbnail) return emoji;
	return `
		<span style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;">${emoji}</span>
		<img src="${esc(preset.thumbnail)}" alt="" loading="lazy"
		     style="position:absolute;inset:0;"
		     onerror="this.remove()" />
	`;
}

// ── Color panel ──────────────────────────────────────────────────────

function renderColorPanel(panel) {
	const ready = !!scene?.root;
	const groups = COLOR_SLOTS.map((slot) => {
		const current = workingAppearance.colors[slot.id] || null;
		const presetMatch = current && slot.swatches.some((h) => h.toLowerCase() === current);
		const swatches = slot.swatches
			.map((hex) => {
				const pressed = current === hex.toLowerCase();
				return `<button class="as-swatch" type="button" role="radio"
					aria-checked="${pressed ? 'true' : 'false'}" aria-pressed="${pressed ? 'true' : 'false'}"
					aria-label="${esc(slot.label)} ${esc(hex)}" data-slot="${slot.id}" data-hex="${esc(hex)}"
					style="background:${esc(hex)}"></button>`;
			})
			.join('');
		const noneSel = !current;
		// A custom (non-palette) color counts as the custom swatch being active.
		const customSel = current && !presetMatch;
		return `
			<div class="as-color-group" data-group="${slot.id}">
				<div class="as-color-head">
					<span class="as-color-title">${esc(slot.label)}</span>
					<span class="as-color-current">
						<span class="dot" data-current-dot style="background:${esc(current || '#ffffff')}"></span>
						<span data-current-label>${current ? esc(current.toUpperCase()) : 'Default'}</span>
					</span>
				</div>
				<div class="as-swatches" role="radiogroup" aria-label="${esc(slot.label)} color">
					<button class="as-swatch as-swatch-default" type="button" role="radio"
						aria-checked="${noneSel ? 'true' : 'false'}" aria-pressed="${noneSel ? 'true' : 'false'}"
						aria-label="${esc(slot.label)} default" data-slot="${slot.id}" data-hex=""
						title="Default"></button>
					${swatches}
					<label class="as-swatch as-swatch-custom${customSel ? '' : ''}"
						aria-label="${esc(slot.label)} custom color" title="Custom color"
						${customSel ? 'style="border-color:var(--accent);box-shadow:0 0 0 2px var(--accent),0 0 0 4px rgba(0,0,0,0.6)"' : ''}>
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><path d="M2 2l7.586 7.586"/><circle cx="11" cy="11" r="2"/></svg>
						<input type="color" data-slot="${slot.id}" value="${esc(current || '#ffffff')}" />
					</label>
				</div>
			</div>`;
	}).join('');

	ensureLayerCss();
	panel.innerHTML = `
		${layersBlockHtml()}
		<p class="ae-sculpt-note" style="margin-top:16px;">Tint skin, hair and outfit. Colors bake into your saved avatar.</p>
		${groups}
		${ready ? '' : '<div class="as-empty" style="padding-top:8px;">Waiting for avatar to load…</div>'}`;

	bindColorPanel(panel);
	bindLayersBlock(panel);
}

// ── Layers (show/hide) ───────────────────────────────────────────────

function layersBlockHtml() {
	const anyStripVisible = LAYER_SLOTS.some((s) => s.strip && !workingAppearance.hidden.includes(s.id));
	const anyHidden = LAYER_SLOTS.some((s) => workingAppearance.hidden.includes(s.id));
	const toggles = LAYER_SLOTS.map((slot) => {
		const hidden = workingAppearance.hidden.includes(slot.id);
		return `<button class="as-layer${hidden ? ' off' : ''}" type="button" role="switch"
			aria-checked="${hidden ? 'false' : 'true'}" data-layer="${slot.id}"
			aria-label="${esc(slot.label)} ${hidden ? 'hidden — click to show' : 'visible — click to hide'}">
			<span class="as-layer-eye" aria-hidden="true">${hidden ? EYE_OFF : EYE_ON}</span>${esc(slot.label)}</button>`;
	}).join('');
	return `
		<div class="as-layers">
			<div class="as-layers-head">
				<span class="as-color-title">Layers</span>
				<div class="as-layers-bulk">
					<button class="as-layers-btn" type="button" id="as-strip" ${anyStripVisible ? '' : 'disabled'}>Start minimal</button>
					<button class="as-layers-btn" type="button" id="as-dress" ${anyHidden ? '' : 'disabled'}>Dress fully</button>
				</div>
			</div>
			<p class="as-layers-note">Hide a layer to strip back to the base body, then build the look up.</p>
			<div class="as-layer-row">${toggles}</div>
		</div>`;
}

function bindLayersBlock(panel) {
	panel.querySelectorAll('.as-layer[data-layer]').forEach((btn) => {
		btn.addEventListener('click', () => {
			const nowHidden = btn.getAttribute('aria-checked') === 'true'; // visible → hide
			setLayerHidden(btn.dataset.layer, nowHidden);
		});
	});
	panel.querySelector('#as-strip')?.addEventListener('click', stripToBase);
	panel.querySelector('#as-dress')?.addEventListener('click', dressFully);
}

function setLayerHidden(slotId, hidden) {
	const slot = LAYER_SLOTS.find((s) => s.id === slotId);
	if (!slot) return;
	const i = workingAppearance.hidden.indexOf(slotId);
	if (hidden && i < 0) workingAppearance.hidden.push(slotId);
	else if (!hidden && i >= 0) workingAppearance.hidden.splice(i, 1);
	applyLayerVisibility(slot, hidden);
	if (activeTab === 'color') renderActivePanel();
	renderChips();
	setStatus('', `${slot.label} ${hidden ? 'hidden' : 'shown'}.`);
}

function stripToBase() {
	for (const slot of LAYER_SLOTS) {
		if (!slot.strip) continue;
		if (!workingAppearance.hidden.includes(slot.id)) workingAppearance.hidden.push(slot.id);
		applyLayerVisibility(slot, true);
	}
	if (activeTab === 'color') renderActivePanel();
	renderChips();
	setStatus('', 'Stripped to the base body. Add layers back to dress it up.');
}

function dressFully() {
	for (const slot of LAYER_SLOTS) applyLayerVisibility(slot, false);
	workingAppearance.hidden = [];
	if (activeTab === 'color') renderActivePanel();
	renderChips();
	setStatus('', 'All layers shown.');
}

// Toggle visibility of every mesh whose material belongs to the slot.
function applyLayerVisibility(slot, hidden) {
	if (!scene?.root) return;
	const names = new Set(slot.materials);
	scene.root.traverse((obj) => {
		if (!obj.isMesh) return;
		const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
		if (mats.some((m) => m && names.has(m.name))) obj.visible = !hidden;
	});
}

function applyAllLayers() {
	for (const slot of LAYER_SLOTS) {
		applyLayerVisibility(slot, workingAppearance.hidden.includes(slot.id));
	}
}

let _layerCssInjected = false;
function ensureLayerCss() {
	if (_layerCssInjected) return;
	_layerCssInjected = true;
	const style = document.createElement('style');
	style.textContent = `
		.as-layers { border: 1px solid var(--border, #1f1f1f); border-radius: 12px; background: var(--panel, #111); padding: 12px 14px; }
		.as-layers-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
		.as-layers-bulk { display: flex; gap: 6px; }
		.as-layers-btn { background: var(--panel-2, #161616); border: 1px solid var(--border-2, #2a2a2a); color: var(--text-2, #a1a1aa); font: 600 11px/1 inherit; padding: 6px 10px; border-radius: 7px; cursor: pointer; transition: color .15s, border-color .15s, background .15s; }
		.as-layers-btn:hover:not([disabled]) { color: var(--text, #fafafa); border-color: var(--text-3, #71717a); background: rgba(255,255,255,.03); }
		.as-layers-btn[disabled] { opacity: .4; cursor: default; pointer-events: none; }
		.as-layers-note { font-size: 11px; color: var(--text-3, #71717a); line-height: 1.5; margin: 8px 0 12px; }
		.as-layer-row { display: flex; flex-wrap: wrap; gap: 8px; }
		.as-layer { display: inline-flex; align-items: center; gap: 7px; background: var(--panel-2, #161616); border: 1px solid var(--border-2, #2a2a2a); color: var(--text, #fafafa); font: 500 12px/1 inherit; padding: 8px 12px; border-radius: 999px; cursor: pointer; transition: color .15s, border-color .15s, opacity .15s; }
		.as-layer:hover { border-color: var(--text-3, #71717a); }
		.as-layer .as-layer-eye { display: inline-flex; color: var(--text-2, #a1a1aa); }
		.as-layer.off { color: var(--text-3, #71717a); border-style: dashed; }
		.as-layer.off .as-layer-eye { color: var(--text-3, #555); }
	`;
	document.head.appendChild(style);
}

function bindColorPanel(panel) {
	panel.querySelectorAll('.as-swatch[data-slot]').forEach((btn) => {
		btn.addEventListener('click', () => setSlotColor(btn.dataset.slot, btn.dataset.hex || null));
	});
	panel.querySelectorAll('input[type="color"][data-slot]').forEach((input) => {
		const slot = input.dataset.slot;
		input.addEventListener('input', () => liveSlotColor(slot, input.value));
		input.addEventListener('change', () => setSlotColor(slot, input.value));
	});
}

function setSlotColor(slotId, hex) {
	const slot = COLOR_SLOT_BY_ID.get(slotId);
	if (!slot) return;
	if (hex && HEX_RE.test(hex)) {
		workingAppearance.colors[slotId] = hex.toLowerCase();
	} else {
		delete workingAppearance.colors[slotId];
	}
	applySlotColor(slot, workingAppearance.colors[slotId] || null);
	if (activeTab === 'color') renderActivePanel();
	renderChips();
	const c = workingAppearance.colors[slotId];
	setStatus('', c ? `${slot.label} → ${c.toUpperCase()}` : `${slot.label} reset to default.`);
}

// Live (uncommitted) preview while dragging the native color picker — applies
// to the mesh and updates the slot's readout without a full re-render so the
// picker stays open.
function liveSlotColor(slotId, hex) {
	const slot = COLOR_SLOT_BY_ID.get(slotId);
	if (!slot || !HEX_RE.test(hex)) return;
	applySlotColor(slot, hex);
	const group = document.querySelector(`.as-color-group[data-group="${cssEscape(slotId)}"]`);
	if (!group) return;
	const dot = group.querySelector('[data-current-dot]');
	const label = group.querySelector('[data-current-label]');
	if (dot) dot.style.background = hex;
	if (label) label.textContent = hex.toUpperCase();
}

// Multiply every material in the slot by `hex` (null → white = original texture).
function applySlotColor(slot, hex) {
	if (!scene?.root) return;
	const color = hex || '#ffffff';
	const names = new Set(slot.materials);
	scene.root.traverse((obj) => {
		if (!obj.isMesh) return;
		const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
		for (const m of mats) {
			if (m && m.color && names.has(m.name)) m.color.set(color);
		}
	});
}

function applyAllColors() {
	for (const slot of COLOR_SLOTS) {
		applySlotColor(slot, workingAppearance.colors[slot.id] || null);
	}
}

function bindSearch() {
	const input = $('as-search');
	if (!input) return;
	input.addEventListener('input', (e) => {
		searchQuery = e.target.value;
		renderActivePanel();
		const next = $('as-search');
		if (next) {
			next.focus();
			next.setSelectionRange(searchQuery.length, searchQuery.length);
		}
	});
}

function bindTiles(panel, tab) {
	panel.querySelectorAll('.as-tile').forEach((btn) => {
		const presetId = btn.dataset.id;
		btn.addEventListener('click', () => onTileClick(tab, presetId));
		if (!presetId) return;
		btn.addEventListener('mouseenter', () => onTileHover(tab, presetId));
		btn.addEventListener('mouseleave', () => onTileLeave());
		btn.addEventListener('focus', () => onTileHover(tab, presetId));
		btn.addEventListener('blur', () => onTileLeave());
	});
}

function renderChips() {
	const el = $('as-chips');
	const parts = [];

	for (const id of workingAppearance.accessories) {
		const p = presetsById.get(id);
		if (!p) continue;
		parts.push(`
			<span class="as-chip" data-id="${esc(id)}">
				<span class="as-chip-kind">${esc(KIND_LABEL[p.kind] || p.kind)}</span>
				<span>${esc(p.name)}</span>
				<button type="button" aria-label="Remove ${esc(p.name)}" data-remove="${esc(id)}">×</button>
			</span>`);
	}

	for (const slot of COLOR_SLOTS) {
		const hex = workingAppearance.colors[slot.id];
		if (!hex) continue;
		parts.push(`
			<span class="as-chip" data-color="${slot.id}">
				<span class="as-chip-dot" style="background:${esc(hex)}"></span>
				<span class="as-chip-kind">${esc(slot.label)}</span>
				<button type="button" aria-label="Reset ${esc(slot.label)}" data-reset-color="${slot.id}">×</button>
			</span>`);
	}

	for (const slot of LAYER_SLOTS) {
		if (!workingAppearance.hidden.includes(slot.id)) continue;
		parts.push(`
			<span class="as-chip" data-hidden="${slot.id}">
				<span class="as-chip-kind">${esc(slot.label)}</span>
				<span>hidden</span>
				<button type="button" aria-label="Show ${esc(slot.label)}" data-show-layer="${slot.id}">×</button>
			</span>`);
	}

	el.innerHTML = parts.join('');

	el.querySelectorAll('button[data-remove]').forEach((btn) => {
		btn.addEventListener('click', () => removeCommitted(btn.dataset.remove));
	});
	el.querySelectorAll('button[data-reset-color]').forEach((btn) => {
		btn.addEventListener('click', () => setSlotColor(btn.dataset.resetColor, null));
	});
	el.querySelectorAll('button[data-show-layer]').forEach((btn) => {
		btn.addEventListener('click', () => setLayerHidden(btn.dataset.showLayer, false));
	});
}

function tileSelected(tab, presetId) {
	const matching = workingAppearance.accessories.filter((id) => {
		const preset = presetsById.get(id);
		return preset && tab.kinds.includes(preset.kind);
	});
	if (!presetId) return matching.length === 0;
	return matching.includes(presetId);
}

// ── Hover preview ────────────────────────────────────────────────────

function onTileHover(tab, presetId) {
	if (isCommitted(presetId)) {
		previewedId = null;
		return;
	}
	if (previewedId === presetId) return;
	previewedId = presetId;
	highlightPreviewingTile(presetId);

	const myToken = ++previewToken;
	const preset = presetsById.get(presetId);
	if (!preset) return;

	if (!accessoryManager) {
		setStatus('', `${preset.name} · waiting for avatar to load...`);
		return;
	}

	queueOp(async () => {
		if (myToken !== previewToken) return;
		await accessoryManager.applyPreset(preset);
		if (myToken === previewToken) {
			setStatus('', `Previewing ${preset.name} · click to keep`);
		}
	});
}

function onTileLeave() {
	if (!previewedId) return;
	const leavingId = previewedId;
	previewedId = null;
	const myToken = ++previewToken;
	highlightPreviewingTile(null);

	if (isCommitted(leavingId)) {
		setStatusDefault();
		return;
	}

	const preset = presetsById.get(leavingId);
	if (!preset) {
		setStatusDefault();
		return;
	}

	queueOp(async () => {
		if (myToken !== previewToken) return;
		if (!accessoryManager) {
			setStatusDefault();
			return;
		}
		accessoryManager.removePreset(leavingId);
		if (preset.kind !== 'earrings') {
			const committedInSlot = committedIdForKind(preset.kind);
			if (committedInSlot && committedInSlot !== leavingId) {
				const restore = presetsById.get(committedInSlot);
				if (restore) await accessoryManager.applyPreset(restore);
			}
		}
		if (myToken === previewToken) setStatusDefault();
	});
}

function highlightPreviewingTile(id) {
	document.querySelectorAll('.as-tile.previewing').forEach((el) => el.classList.remove('previewing'));
	if (!id) return;
	const el = document.querySelector(`.as-tile[data-id="${cssEscape(id)}"]`);
	el?.classList.add('previewing');
}

function cssEscape(s) {
	return String(s).replace(/["\\]/g, '\\$&');
}

function isCommitted(presetId) {
	if (!presetId) return false;
	return workingAppearance.accessories.includes(presetId);
}

function committedIdForKind(kind) {
	for (const id of workingAppearance.accessories) {
		const p = presetsById.get(id);
		if (p && p.kind === kind) return id;
	}
	return null;
}

// ── Commit / remove ──────────────────────────────────────────────────

async function onTileClick(tab, presetId) {
	previewedId = null;
	previewToken++;

	await queueOp(async () => {
		await applyAccessory(tab, presetId || null);
	});
	renderActivePanel();
	renderChips();
}

async function removeCommitted(id) {
	const preset = presetsById.get(id);
	if (!preset) return;
	previewedId = null;
	previewToken++;
	await queueOp(async () => {
		accessoryManager?.removePreset(id);
	});
	workingAppearance.accessories = workingAppearance.accessories.filter((a) => a !== id);
	renderActivePanel();
	renderChips();
}

async function applyAccessory(tab, presetId) {
	const inSlot = workingAppearance.accessories.filter((id) => {
		const p = presetsById.get(id);
		return p && tab.kinds.includes(p.kind);
	});

	if (!presetId) {
		for (const id of inSlot) {
			accessoryManager?.removePreset(id);
			workingAppearance.accessories = workingAppearance.accessories.filter((a) => a !== id);
		}
		return;
	}

	if (tab.single) {
		for (const id of inSlot) {
			if (id === presetId) continue;
			accessoryManager?.removePreset(id);
			workingAppearance.accessories = workingAppearance.accessories.filter((a) => a !== id);
		}
		const preset = presetsById.get(presetId);
		if (preset && accessoryManager) await accessoryManager.applyPreset(preset);
		if (!workingAppearance.accessories.includes(presetId)) {
			workingAppearance.accessories.push(presetId);
		}
		return;
	}

	if (inSlot.includes(presetId)) {
		accessoryManager?.removePreset(presetId);
		workingAppearance.accessories = workingAppearance.accessories.filter((a) => a !== presetId);
		return;
	}
	const preset = presetsById.get(presetId);
	if (preset && accessoryManager) await accessoryManager.applyPreset(preset);
	if (!workingAppearance.accessories.includes(presetId)) {
		workingAppearance.accessories.push(presetId);
	}
}

// ── Header / body type / status ──────────────────────────────────────

function bindHeader() {
	$('as-save').addEventListener('click', () => saveAvatar());
	$('as-reset').addEventListener('click', () => resetAll());
}

async function resetAll() {
	previewedId = null;
	previewToken++;
	await queueOp(async () => {
		const wasIds = [...workingAppearance.accessories].filter(Boolean);
		if (accessoryManager) {
			for (const id of wasIds) accessoryManager.removePreset(id);
		}
		workingAppearance = { accessories: [], morphs: {}, colors: {}, hidden: [] };
		if (scene?.root) {
			applyMorphsToRoot(scene.root, {});
			applyAllColors();
			applyAllLayers();
		}
		if (accessoryManager) await accessoryManager.hydrateFromAppearance(workingAppearance);
	});
	renderChips();
	renderActivePanel();
	setStatus('', 'Reset to default.');
}

function setStatusDefault() {
	setStatus('', 'Hover any item to try it on. Click to keep.');
}

function setStatus(kind, text) {
	const el = $('as-status');
	el.className = `as-status${kind ? ' ' + kind : ''}`;
	el.innerHTML = kind === 'spin' ? `<span class="spin"></span>${esc(text)}` : esc(text);
}

// ── Save flow ────────────────────────────────────────────────────────

function collapseAppearance(a) {
	const out = {};
	if (a.accessories?.length) out.accessories = [...a.accessories];
	if (a.morphs && Object.keys(a.morphs).length) out.morphs = { ...a.morphs };
	if (a.colors && Object.keys(a.colors).length) out.colors = { ...a.colors };
	if (a.hidden?.length) out.hidden = [...a.hidden];
	return Object.keys(out).length ? out : null;
}

function showSaveOverlay(label, sublabel) {
	let el = document.getElementById('as-save-overlay');
	if (!el) {
		el = document.createElement('div');
		el.id = 'as-save-overlay';
		el.className = 'as-save-overlay';
		el.innerHTML = `
			<div class="spin-lg"></div>
			<div class="as-save-label"></div>
			<div class="as-save-sublabel"></div>
			<div class="as-progress-bar"><div class="as-progress-fill" id="as-progress-fill"></div></div>
		`;
		document.body.appendChild(el);
	}
	el.querySelector('.as-save-label').textContent = label;
	el.querySelector('.as-save-sublabel').textContent = sublabel || '';
}

function updateSaveOverlay(label, sublabel) {
	const el = document.getElementById('as-save-overlay');
	if (!el) return;
	if (label) el.querySelector('.as-save-label').textContent = label;
	if (sublabel !== undefined) el.querySelector('.as-save-sublabel').textContent = sublabel;
}

function updateProgress(pct) {
	const fill = document.getElementById('as-progress-fill');
	if (fill) fill.style.width = `${Math.round(pct)}%`;
}

function hideSaveOverlay() {
	const el = document.getElementById('as-save-overlay');
	if (el) el.remove();
}

async function saveAvatar() {
	const name = ($('as-name')?.value || '').trim() || 'My Avatar';
	const saveBtn = $('as-save');
	const resetBtn = $('as-reset');
	saveBtn.disabled = true;
	resetBtn.disabled = true;
	showSaveOverlay('Uploading avatar...', 'This may take a moment');

	try {
		const glbRes = await fetch(BASE_GLB_URL);
		if (!glbRes.ok) throw new Error(`Failed to fetch base GLB: ${glbRes.status}`);
		const glbBlob = await glbRes.blob();

		updateSaveOverlay('Uploading base model...');

		const avatar = await saveRemoteGlbToAccount(
			glbBlob,
			{
				name,
				source: 'studio',
				source_meta: { generator: 'avatar-studio', body_type: BODY_TYPE },
				visibility: 'public',
			},
			{
				onProgress: (pct) => updateProgress(pct * 0.7),
			},
		);

		const appearance = collapseAppearance(workingAppearance);
		if (appearance) {
			updateSaveOverlay('Applying customizations...', 'Baking appearance into GLB');
			updateProgress(75);

			const patchRes = await apiFetch(`/api/avatars/${encodeURIComponent(avatar.id)}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ appearance }),
			});
			if (!patchRes.ok) {
				const err = await patchRes.json().catch(() => ({}));
				console.warn('[avatar-studio] appearance PATCH failed:', err);
			}
		}

		updateProgress(90);
		updateSaveOverlay('Capturing thumbnail...');

		try {
			await uploadAvatarSnapshot({ avatarId: avatar.id, scene });
		} catch (err) {
			console.warn('[avatar-studio] snapshot upload failed:', err?.message);
		}

		updateProgress(100);
		updateSaveOverlay('Done! Redirecting...');

		await new Promise((r) => setTimeout(r, 600));

		window.location.href = `/avatars/${encodeURIComponent(avatar.id)}`;
	} catch (err) {
		hideSaveOverlay();
		console.error('[avatar-studio] save failed:', err);

		if (err.code === 'not_signed_in' || err.stage === 'auth') {
			const next = encodeURIComponent('/create/studio');
			window.location.replace(`/login?next=${next}`);
			return;
		}

		setStatus('err', `Save failed: ${err.message || 'Unknown error'}`);
		saveBtn.disabled = false;
		resetBtn.disabled = false;
	}
}
